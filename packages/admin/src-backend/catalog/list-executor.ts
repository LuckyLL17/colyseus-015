/**
 * Shared execution engine behind:
 *   GET /admin-api/:resource                 (top-level resource list)
 *   GET /admin-api/:resource/:id/relations/:name   (related-rows list)
 *
 * Both surfaces run the SAME pipeline so permissions, field validation,
 * filters, sorting, soft-delete handling and pagination can never drift:
 *
 *   1. Resolve + validate the (at most one-hop) relation plan
 *   2. Build WHERE: free-text, own-column filters, relation EXISTS /
 *      NOT-EXISTS predicates, and (for the relation endpoint) the fixed
 *      parent-FK predicate
 *   3. Build ORDER BY: own/related sort + PK tiebreakers (stable order)
 *   4. Page either by offset (_start/_end — refine simple-rest) or by
 *      keyset cursor (_cursor/_limit)
 *   5. Expand related rows in ONE batched query, when requested
 *
 * Field validation: only columns declared on the (target) table config are
 * ever referenced — dotted params against unknown columns, and unknown
 * relation names, are 400s before any SQL is built.
 */
import { and, like, or, sql, type SQL } from 'drizzle-orm';
import {
  buildFilterCondition, listColumns, pkColumns,
} from '../internal/helpers.js';
import type { TableConfig } from '../internal/helpers.js';
import type { ResourceDefinition } from './define-resource.js';
import type { EndpointContext } from '../internal/context.js';
import {
  buildKeysetWhere, castCursorValue, encodeCursor, decodeCursor,
  batchExpand, relatedExistsCondition, relatedSortExpression,
  resolveRelationPlan, resolveSortKeys, orderByFragments,
  softDeleteCondition,
  sortKeyValues, type RelationPlan, type SortKeyColumn,
} from './relation-query.js';

const RESERVED_QUERY_KEYS = new Set(['_start', '_end', '_sort', '_order', '_q', '_cursor', '_limit', '_expand']);
const FILTER_KEY_RE = /^(.+?)_(like|in|eq|ne|gt|gte|lt|lte)$/;
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 200;
/** Projection alias carrying the related-sort scalar; stripped from rows. */
const REL_SORT_ALIAS = '__rel_sort__';

export interface ExecuteListOptions {
  ctx: EndpointContext;
  query: Record<string, any>;
  /** Table being listed. */
  table: any;
  cfg: TableConfig;
  def: ResourceDefinition | undefined;
  /**
   * Extra WHERE conditions the caller guarantees (the relation endpoint
   * passes the parent-FK predicate + the target's soft-delete predicate).
   */
  fixedWhere?: SQL[];
  /**
   * When set, the path-pinned relation: bare filter/sort params target ITS
   * columns. The top-level list leaves this undefined and requires dotted
   * `<rel>.<field>` params instead.
   */
  baseRelation?: import('@colyseus/database').RelationDefinition;
  /**
   * Declared relations of the listed resource. The relation endpoint
   * passes the TARGET resource's relations (so the related list itself
   * can traverse one of its own relations); the top-level endpoint passes
   * the source resource's relations.
   */
  relations?: import('@colyseus/database').RelationDefinition[];
}

export interface ExecuteListResult {
  ok: true;
  rows: any[];
  /** Present in offset mode (refine simple-rest contract). */
  total?: number;
  /** Present in cursor mode: opaque cursor for the next page, or null. */
  nextCursor?: string | null;
  limit?: number;
}

export interface ExecuteListError {
  ok: false;
  status: number;
  message: string;
}

export type ExecuteListOutcome = ExecuteListResult | ExecuteListError;

export async function executeResourceList(opts: ExecuteListOptions): Promise<ExecuteListOutcome> {
  const { ctx, query, table, cfg, def, fixedWhere } = opts;
  // The relation endpoint lists a TARGET and passes the target's own
  // relations (plus a baseRelation); the top-level list passes the
  // source's. Default to the catalog relations of the table being listed.
  const ownCanonical = canonicalNameOf(ctx, table);
  const relations = opts.relations ?? ctx.database.relations[ownCanonical] ?? [];

  // 1. Relation plan (dotted params or path-pinned base relation).
  const resolved = resolveRelationPlan({
    query,
    relations,
    sourceTable: table,
    sourceCfg: cfg,
    tables: ctx.tables,
    getTableConfig: ctx.getTableConfig,
    baseRelation: opts.baseRelation,
  });
  if (resolved.error) { return { ok: false, ...resolved.error }; }
  const plan: RelationPlan | null = resolved.plan;

  const q = query;
  const sortField = typeof q._sort === 'string' ? q._sort : undefined;
  const sortOrder = (q._order as string | undefined)?.toUpperCase() === 'DESC' ? 'desc' : 'asc';
  const search = typeof q._q === 'string' ? q._q.trim() : '';

  // The relation plan owns a dotted _sort; a bare _sort is an own-column sort.
  const ownSortField = sortField && !sortField.includes('.') ? sortField : undefined;

  // 2. Projection — own visible columns + PKs, plus the related sort scalar.
  const visibleCols = listColumns(cfg, def);
  const projection: Record<string, any> = {};
  for (const colName of visibleCols) {
    const col = cfg.columns.find((c) => c.name === colName);
    if (col) { projection[colName] = col; }
  }
  for (const col of cfg.columns) {
    if (col.primary && !(col.name in projection)) { projection[col.name] = col; }
  }

  // 3. WHERE conditions.
  const conditions: SQL[] = [];
  if (fixedWhere) { conditions.push(...fixedWhere); }

  // The listed table's OWN soft-delete rows are hidden from every list
  // (conventional deleted_at / is_deleted column — see softDeleteCondition).
  // The relation endpoint relies on this same line for its target rows, so
  // it doesn't have to add the predicate itself.
  const ownSoft = softDeleteCondition(cfg);
  if (ownSoft) { conditions.push(ownSoft); }

  if (search.length > 0) {
    const pattern = `%${search}%`;
    const textCols = cfg.columns.filter((c) => {
      const t = typeof c.getSQLType === 'function' ? c.getSQLType() : '';
      return /^(text|varchar|char)/i.test(t);
    });
    const orConds = textCols.map((c) => like(c as any, pattern));
    if (orConds.length > 0) {
      const ored = or(...orConds);
      if (ored) { conditions.push(ored); }
    }
  }

  // Own-column filters. Dotted keys belong to the relation parser; on the
  // base (relation) endpoint bare keys belong to the target's own columns.
  for (const [key, raw] of Object.entries(q)) {
    if (RESERVED_QUERY_KEYS.has(key)) { continue; }
    if (typeof raw !== 'string' || raw.length === 0) { continue; }
    if (key.includes('.')) { continue; } // relation namespace — handled above
    const m = key.match(FILTER_KEY_RE);
    const fieldName = m ? m[1]! : key;
    const op = m ? m[2]! : 'eq';
    const col = cfg.columns.find((c) => c.name === fieldName);
    if (!col) { continue; }
    const cond = buildFilterCondition(col, op, raw);
    if (cond) { conditions.push(cond); }
  }

  if (plan && (plan.filters.length > 0 || plan.nullOnly)) {
    // Existence predicate only when the request actually CONSTRAINS the
    // relation (a related-column filter or `_null=true`). Sort/expand
    // alone are LEFT-semantics: rows without related records stay in the
    // list, sorting NULL-last and expanding to [] / null.
    conditions.push(
      relatedExistsCondition(
        table, cfg, plan.targetTable, plan.targetCfg, plan.layout,
        plan.filters, plan.nullOnly,
      ),
    );
  }

  const whereClause: SQL | undefined =
    conditions.length === 0 ? undefined :
    conditions.length === 1 ? conditions[0]! :
    and(...conditions);

  // 4. ORDER BY with the PK tiebreaker so paging is stable.
  const relatedSort = plan?.sort
    ? {
        expr: relatedSortExpression(
          table, cfg, plan.targetTable, plan.targetCfg, plan.layout,
          plan.sort.col, plan.sort.order, plan.relation.kind,
        ),
        meta: plan.sort.col,
        order: plan.sort.order,
      }
    : undefined;
  const sortKeys = resolveSortKeys({
    ownSortField,
    ownSortOrder: sortOrder,
    ownCfg: cfg,
    ownDefaultSort: !sortField ? def?.list?.defaultSort : undefined,
    relatedSort,
  });
  const orderExprs = orderByFragments(sortKeys);
  const selectProjection = { ...projection };
  if (relatedSort) {
    selectProjection[REL_SORT_ALIAS] = relatedSort.expr.as(REL_SORT_ALIAS);
  }

  // 5. Pagination — cursor mode when _cursor or _limit is present, offset
  //    otherwise (refine simple-rest sends _start/_end).
  const cursorRaw = typeof q._cursor === 'string' ? q._cursor : undefined;
  const cursorMode = cursorRaw !== undefined || typeof q._limit === 'string';
  let limit: number;
  let cursorValues: unknown[] | null = null;
  if (cursorMode) {
    limit = parseInt(q._limit as string) || DEFAULT_PAGE_SIZE;
    limit = Math.min(Math.max(1, limit), MAX_PAGE_SIZE);
    if (cursorRaw) {
      const decoded = decodeCursor(cursorRaw, sortKeys.length);
      if (!decoded.ok) { return { ok: false, status: 400, message: decoded.error }; }
      cursorValues = decoded.values.map((v, i) => castCursorValue(v, sortKeys[i]!.col));
    }
  } else {
    const start = parseInt(q._start as string) || 0;
    const end = parseInt(q._end as string) || start + DEFAULT_PAGE_SIZE;
    limit = Math.max(1, end - start);
  }

  // Final WHERE = caller/search/own/relation predicates AND, in cursor
  // mode, the strict keyset predicate. Assembled as a single .where() call
  // (drizzle replaces rather than ANDs repeated .where()s).
  //
  // Related sorts are scalar SUBQUERIES projected as `__rel_sort__`.
  // Postgres can't reference a SELECT alias in WHERE, so when such a sort
  // is active we wrap the filtered list in a subquery and apply the
  // keyset predicate + ORDER BY + LIMIT on the OUTER query (where the
  // alias is visible). The inner query carries only the base predicates;
  // its order doesn't affect the outer result.
  const baseSelect: any = ctx.database.drizzle
    .select(selectProjection)
    .from(table);
  if (whereClause) { baseSelect.where(whereClause); }

  let pageQuery: any;
  const PAGE_ALIAS = '__rel_page__';
  if (relatedSort) {
    const page = baseSelect.as(PAGE_ALIAS);
    pageQuery = ctx.database.drizzle.select().from(page);
    if (cursorMode && cursorValues) {
      // Keyset predicate qualified to the wrapper alias for every key.
      pageQuery = pageQuery.where(buildOuterKeysetWhere(sortKeys, cursorValues, REL_SORT_ALIAS, PAGE_ALIAS));
    }
    // Pass ALL order fragments in ONE orderBy call: drizzle's query builder
    // REPLACES the ORDER BY on each repeated .orderBy() rather than appending,
    // so a per-key loop would keep only the final (PK tiebreak) key and
    // silently drop the related-column sort.
    pageQuery = pageQuery.orderBy(...buildOuterOrder(sortKeys, REL_SORT_ALIAS, PAGE_ALIAS));
    pageQuery = pageQuery.limit(cursorMode ? limit + 1 : limit);
    if (!cursorMode) {
      const start = parseInt(q._start as string) || 0;
      pageQuery = pageQuery.offset(start);
    }
  } else {
    pageQuery = baseSelect.limit(cursorMode ? limit + 1 : limit);
    if (!cursorMode) {
      const start = parseInt(q._start as string) || 0;
      pageQuery = pageQuery.offset(start);
    }
    const finalWhere: SQL | undefined =
      cursorMode && cursorValues
        ? (whereClause ? and(whereClause, buildKeysetWhere(sortKeys, cursorValues))!
          : buildKeysetWhere(sortKeys, cursorValues))
        : whereClause;
    if (finalWhere) { pageQuery = pageQuery.where(finalWhere); }
    // Single .orderBy(...) with every key — repeated calls replace, not append.
    pageQuery = pageQuery.orderBy(...orderExprs);
  }

  const fetched: any[] = await pageQuery;
  let rows = fetched;
  let nextCursor: string | null = null;
  if (cursorMode) {
    const hasMore = fetched.length > limit;
    if (hasMore) { rows = fetched.slice(0, limit); }
    if (hasMore && rows.length > 0) {
      const last = rows[rows.length - 1]!;
      nextCursor = encodeCursor(sortKeyValues(last, sortKeys, REL_SORT_ALIAS));
    }
  }

  // Strip the internal sort-scalar projection before serialization.
  for (const row of rows) { delete row[REL_SORT_ALIAS]; }

  // 6. Expand related rows — exactly ONE batched query for the whole page.
  if (plan?.expand && rows.length > 0) {
    await attachExpansion(ctx, plan, table, cfg, rows);
  }

  if (cursorMode) {
    return { ok: true, rows, nextCursor, limit };
  }

  let countQuery = ctx.database.drizzle.select({ c: sql<number>`count(*)` }).from(table) as any;
  if (whereClause) { countQuery = countQuery.where(whereClause); }
  const totalRows = await countQuery;
  return { ok: true, rows, total: Number(totalRows[0]?.c ?? 0) };
}

/**
 * Attach expansion results under `row[relation.name]`. Single batched
 * SELECT per page; 'one' → row object (or null), 'many' → array.
 */
async function attachExpansion(
  ctx: EndpointContext,
  plan: RelationPlan,
  table: any,
  cfg: TableConfig,
  rows: any[],
): Promise<void> {
  const targetDef = ctx.resources[plan.relation.target];
  const expandProjection = {} as Record<string, any>;
  // Respect the target resource's list-columns allow-list + always include
  // PKs — the SAME projection rules the target's own list endpoint uses.
  const visible = listColumns(plan.targetCfg, targetDef);
  for (const name of visible) {
    const col = plan.targetCfg.columns.find((c) => c.name === name);
    if (col) { expandProjection[name] = col; }
  }
  for (const col of plan.targetCfg.columns) {
    if (col.primary && !(col.name in expandProjection)) { expandProjection[col.name] = col; }
  }

  // Values the batched IN (...) matches against:
  //  fk on TARGET → source PKs
  //  fk on SOURCE → the source rows' FK values
  const pkName = pkColumns(cfg)[0]?.name;
  const lookupValues = rows.map((row) => {
    if (plan.layout.fkOn === 'target') {
      return pkName != null && row[pkName] != null ? String(row[pkName]) : null;
    }
    const v = row[plan.layout.fkCol.name];
    return v != null ? String(v) : null;
  }).filter((v): v is string => v != null);

  const grouped = await batchExpand({
    db: ctx.database.drizzle,
    plan,
    sourceCfg: cfg,
    lookupValues,
    projection: expandProjection,
  });

  for (const row of rows) {
    let key: string | null;
    if (plan.layout.fkOn === 'target') {
      key = pkName != null && row[pkName] != null ? String(row[pkName]) : null;
    } else {
      const v = row[plan.layout.fkCol.name];
      key = v != null ? String(v) : null;
    }
    const hit = key != null ? grouped.get(key) : undefined;
    row[plan.relation.name] = hit ?? (plan.relation.kind === 'many' ? [] : null);
  }
}

function canonicalNameOf(ctx: EndpointContext, table: any): string {
  for (const [name, t] of Object.entries(ctx.tables)) {
    if (t === table) { return name; }
  }
  return '';
}

/**
 * ORDER BY fragments for the OUTER wrapper query used with related sorts:
 * expression keys order by their projected alias (`__rel_sort__`); PK
 * tiebreakers order by the column as exposed by the wrapped subquery.
 */
function buildOuterOrder(keys: SortKeyColumn[], sortAlias: string, pageAlias: string): SQL[] {
  // The outer query selects from the wrapped subquery `pageAlias`; every
  // column reference there must qualify to the WRAPPER alias, not the base
  // table (which only exists inside the subquery). Build the whole
  // direction + NULLS LAST suffix as raw text — drizzle's asc()/desc()
  // column chunks drop a trailing `NULLS LAST` fragment, which silently
  // moved NULL sort values to the front for ASC aggregate sorts.
  return keys.map((k) => {
    const name = k.expr ? sortAlias : k.col.name;
    const suffix = k.order === 'desc' ? 'desc nulls last' : 'asc nulls last';
    return sql`${qualifiedIdent(pageAlias, name)} ${sql.raw(suffix)}`;
  });
}

/**
 * Keyset predicate for the wrapper query used with related sorts: every
 * reference is `<pageAlias>.<column>` (or `<pageAlias>.<sortAlias>` for the
 * aggregate key), since the base table isn't in the outer FROM scope.
 *
 * Same lexicographic semantics as buildKeysetWhere — replicated as raw
 * fragments here because the keyset helper qualifies through drizzle's
 * column objects, which carry the INNER table name.
 */
function buildOuterKeysetWhere(
  keys: SortKeyColumn[],
  values: unknown[],
  sortAlias: string,
  pageAlias: string,
): SQL {
  const ref = (key: SortKeyColumn) =>
    qualifiedIdent(pageAlias, key.expr ? sortAlias : key.col.name);
  const ors: SQL[] = [];
  for (let i = 0; i < keys.length; i++) {
    const chain: SQL[] = [];
    for (let j = 0; j < i; j++) {
      const r = ref(keys[j]!);
      chain.push(values[j] === null
        ? isNullRaw(r)
        : sql`${r} = ${values[j]}`);
    }
    const ri = ref(keys[i]!);
    const v = values[i];
    if (v === null) {
      chain.push(sql`false`); // NULL sorts last — nothing comes after it
    } else {
      // NULLs sort LAST in both directions, so include the NULL tail.
      const cmp = keys[i]!.order === 'desc' ? sql`${ri} < ${v}` : sql`${ri} > ${v}`;
      chain.push(sql`(${cmp} or ${ri} is null)`);
    }
    ors.push(chain.length === 1 ? chain[0]! : and(...chain)!);
  }
  return or(...ors)!;
}

function isNullRaw(ident: SQL): SQL {
  return sql`${ident} is null`;
}

/** Raw `"alias"."column"` identifier fragment. sql.identifier() yields a
 * Name chunk that can't be concatenated with template interpolation (that
 * emits a parameter), so compose with sql.join + a raw dot separator. */
function qualifiedIdent(alias: string, column: string): SQL {
  return sql.join([sql.identifier(alias), sql.identifier(column)], sql.raw('.'));
}
