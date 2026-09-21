/**
 * Shared list-query runner used by both:
 *   - GET /admin-api/:resource                 (generic resource list)
 *   - GET /admin-api/:resource/:id/relations/:name (parent-scoped child list)
 *
 * It owns the parts the two surfaces must never drift on:
 *   - direct-column filters + free-text search
 *   - single-layer relation filters/sort (relation-query.ts)
 *   - deterministic ordering with a PK tiebreaker
 *   - two pagination modes: legacy offset (_start/_end, refine UI) and
 *     stable keyset pagination (_cursor)
 *   - soft-delete exclusion on the base table
 *   - batched _expand embedding (one extra query per relation, RBAC-gated)
 *
 * RBAC is enforced by the callers BEFORE running anything; relation target
 * permissions are checked here via the injected `canAccessRelation`
 * callback so expansions/conditions are pruned or rejected consistently.
 */
import { and, like, or, sql, type SQL } from 'drizzle-orm';
import {
  buildFilterCondition, listColumns, pkColumns,
  sqlKeyedProjection, type TableConfig,
} from '../internal/helpers.js';
import {
  applyOrderBy, buildOrderTerms, decodeCursor, encodeCursor,
  executeExpansions, keysetWhere, liveRowsPredicate, mergeExpansions,
  parseRelationQuery, relationConditionSQL,
  type BuildFailure, type ExpansionPlan, type OrderTerm, type RelationQuery,
  type ResolvedRelation, type RelationRegistry,
} from './relation-query.js';

const RESERVED_QUERY_KEYS = new Set(['_start', '_end', '_sort', '_order', '_q', '_cursor', '_limit', '_expand']);
const MAX_PAGE_SIZE = 500;
const DEFAULT_PAGE_SIZE = 100;

export interface ListRunnerInput {
  db: any;
  table: any;
  cfg: TableConfig;
  registry: RelationRegistry;
  /** Canonical name of the base resource (for relation lookup). */
  resourceName: string;
  /** ResourceDefinition for list projection + default sort. */
  def: { list?: { columns?: string[]; defaultSort?: { field: string; order: 'asc' | 'desc' } } } | undefined;
  query: Record<string, unknown>;
  /**
   * Fixed base-table predicate (e.g. `child.fk = parentId` on the relation
   * endpoint). AND-ed with every request-supplied condition.
   */
  scope?: SQL;
  /** RBAC callback — false skips a relation silently (expansion) or 403s
   *  (filter/sort), per the surface's policy. Receives the target name. */
  canAccessRelation: (targetName: string) => Promise<boolean>;
}

export interface ListRunnerResult {
  ok: true;
  rows: any[];
  /** Present in offset mode (x-total-count semantics); omitted under cursors. */
  total: number | null;
  /** Opaque cursor for the next page; null when the current page is the last. */
  nextCursor: string | null;
  pageSize: number;
  mode: 'offset' | 'cursor';
}

export type ListRunnerOutcome =
  | ListRunnerResult
  | { ok: false; failure: BuildFailure };

export async function runListQuery(input: ListRunnerInput): Promise<ListRunnerOutcome> {
  const { db, table, cfg, registry, resourceName, def, query: q } = input;

  // ---- Pagination mode ---------------------------------------------------
  // Presence of either _cursor or _limit selects keyset mode: the first
  // cursor-page request has no cursor yet but still wants the cursor
  // envelope (no count(*)). The refine UI continues to send _start/_end,
  // which keeps the legacy offset/total behavior untouched.
  const cursorRaw = typeof q._cursor === 'string' && q._cursor.length > 0 ? q._cursor : null;
  const hasLimit = q._limit !== undefined && String(q._limit).length > 0;
  const cursorMode = cursorRaw !== null || hasLimit;
  const explicitLimit = parseInt(String(q._limit ?? ''), 10);
  const start = parseInt(String(q._start ?? '')) || 0;
  const end = parseInt(String(q._end ?? '')) || 0;
  const pageSize = clampPageSize(
    cursorMode
      ? (Number.isFinite(explicitLimit) && explicitLimit > 0 ? explicitLimit : DEFAULT_PAGE_SIZE)
      : (end > 0 ? end - start : DEFAULT_PAGE_SIZE),
  );
  const mode: 'offset' | 'cursor' = cursorMode ? 'cursor' : 'offset';

  // ---- Relation query parse ---------------------------------------------
  const parsed = parseRelationQuery(registry, resourceName, q);
  if (!parsed.ok) { return { ok: false, failure: parsed.failure }; }
  const relationQuery = parsed.query;

  // RBAC: filtering/sorting by a relation reveals data of the TARGET — a
  // 403 is the honest answer. Expansion is a voluntary embed: relations the
  // caller can't see are dropped without failing the base list.
  const gatedConditions = [];
  for (const cond of relationQuery.conditions) {
    if (!(await input.canAccessRelation(cond.relation.targetName))) {
      return { ok: false, failure: { status: 403, message: `forbidden: relation '${cond.relation.def.name}' targets '${cond.relation.targetName}'` } };
    }
    gatedConditions.push(cond);
  }
  if (relationQuery.sort && !(await input.canAccessRelation(relationQuery.sort.relation.targetName))) {
    return {
      ok: false,
      failure: { status: 403, message: `forbidden: relation '${relationQuery.sort.relation.def.name}' targets '${relationQuery.sort.relation.targetName}'` },
    };
  }
  const allowedExpands: ResolvedRelation[] = [];
  for (const rel of relationQuery.expands) {
    if (await input.canAccessRelation(rel.targetName)) { allowedExpands.push(rel); }
  }

  // ---- Projection --------------------------------------------------------
  const visibleCols = listColumns(cfg, def as any);
  const projection: Record<string, any> = {};
  for (const colName of visibleCols) {
    const col = cfg.columns.find((c) => c.name === colName);
    if (col) { projection[colName] = (table as any)[jsKey(table, colName)]; }
  }
  for (const col of cfg.columns) {
    if (col.primary && !(col.name in projection)) {
      projection[col.name] = (table as any)[jsKey(table, col.name)];
    }
  }
  // When sorting by a related value the cursor must carry that value — add
  // the correlated scalar as an extra selected expression with an EXPLICIT
  // alias (drizzle doesn't auto-name a raw-sql projection the way it names
  // columns), read it back via OrderTerm.rowKey, then strip it from the wire
  // payload.
  const orderTerms = buildOrderTerms(table, cfg, {
    relationSort: relationQuery.sort,
    directSort: directSort(q, def),
  });
  const selectProjection: Record<string, any> = { ...projection };
  for (const term of orderTerms) {
    if (term.isRelationTerm && term.rowKey) {
      selectProjection[term.rowKey] = sql`${term.expr}`.as(term.rowKey) as any;
    }
  }

  // ---- WHERE -------------------------------------------------------------
  const conditions: SQL[] = [];
  if (input.scope) { conditions.push(input.scope); }
  const baseLive = liveRowsPredicate(table, cfg);
  if (baseLive) { conditions.push(baseLive); }

  const search = typeof q._q === 'string' ? q._q.trim() : '';
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

  // Direct-column filters — same grammar as before, minus the keys the
  // relation parser claimed.
  for (const [key, raw] of Object.entries(q)) {
    if (RESERVED_QUERY_KEYS.has(key) || parsed.consumedKeys.has(key)) { continue; }
    if (typeof raw !== 'string' || raw.length === 0) { continue; }
    const match = key.match(/^(.+?)_(like|in|eq|ne|gt|gte|lt|lte)$/);
    const fieldName = match ? match[1]! : key;
    const op = match ? match[2]! : 'eq';
    // A dotted key that survived parsing is invalid (unknown relation/etc.
    // already 400'd above; this only catches accidental `a.b` shapes).
    if (fieldName.includes('.')) {
      return { ok: false, failure: { status: 400, message: `invalid filter key '${key}'` } };
    }
    const col = cfg.columns.find((c) => c.name === fieldName);
    if (!col) { continue; }
    // Conditions must use drizzle's table-attached column instance (object
    // identity drives dialect codegen), not the cfg introspection entry.
    const tableCol = (table as any)[jsKey(table, col.name)];
    const cond = buildFilterCondition(tableCol ?? col, op, raw);
    if (cond) { conditions.push(cond); }
  }

  // Relation conditions (correlated EXISTS / aggregates — no joins).
  for (const cond of gatedConditions) {
    conditions.push(relationConditionSQL(cond, table));
  }

  const whereClause: SQL | undefined = conditions.length === 0 ? undefined
    : conditions.length === 1 ? conditions[0]!
    : and(...conditions);

  // ---- Cursor decode -----------------------------------------------------
  let cursorValues: unknown[] | null = null;
  if (cursorRaw !== null) {
    const decoded = decodeCursor(cursorRaw, orderTerms.length);
    if (!decoded.ok) { return { ok: false, failure: decoded.failure }; }
    cursorValues = decoded.values;
  }

  // ---- Page query --------------------------------------------------------
  let pageQuery = db.select(selectProjection).from(table) as any;
  const pageConds: SQL[] = [];
  if (whereClause) { pageConds.push(whereClause); }
  if (cursorValues) { pageConds.push(keysetWhere(orderTerms, cursorValues)); }
  if (pageConds.length > 0) {
    pageQuery = pageQuery.where(pageConds.length === 1 ? pageConds[0]! : and(...pageConds));
  }
  pageQuery = applyOrderBy(pageQuery, orderTerms);
  pageQuery = pageQuery.limit(pageSize + 1);
  if (mode === 'offset' && start > 0) { pageQuery = pageQuery.offset(start); }

  const fetched: any[] = await pageQuery;
  const hasMore = fetched.length > pageSize;
  const pageRows = hasMore ? fetched.slice(0, pageSize) : fetched;

  // Strip internal sort-tiebreaker expressions from the response.
  const cleanRows = pageRows.map((row) => {
    const out: Record<string, any> = {};
    for (const k of Object.keys(projection)) { out[k] = row[k]; }
    // Keep relation sort value only for cursor encoding (done below), not
    // in the wire payload.
    for (const term of orderTerms) {
      if (term.isRelationTerm && term.rowKey) { out[term.rowKey] = row[term.rowKey]; }
    }
    return { wire: stripInternalKeys(row, orderTerms), internal: out };
  });

  // ---- Next cursor -------------------------------------------------------
  // Two distinct endings:
  //   - the fetched window was full (hasMore) → ordinary next page.
  //   - the window ENDED exactly on a non-null sort value but NULLS-LAST
  //     rows may follow (relation sort only) → keep paginating into the
  //     NULL group even though hasMore is false; the client learns it's
  //     truly done when the following request returns zero rows.
  let nextCursor: string | null = null;
  if (mode === 'cursor' && cleanRows.length > 0 && (hasMore || orderTerms.some((t) => t.isRelationTerm))) {
    const last = cleanRows[cleanRows.length - 1]!.internal;
    nextCursor = encodeCursor(orderTerms.map((t) => (t.rowKey ? last[t.rowKey] : null)));
  }

  // ---- Total (offset mode only — count(*) is meaningless with a cursor
  //      window, and skipping it keeps cursor pages to a single round-trip
  //      plus expansions). --------------------------------------------------
  let total: number | null = null;
  if (mode === 'offset') {
    let countQuery = db.select({ c: sql<number>`count(*)` }).from(table) as any;
    if (whereClause) { countQuery = countQuery.where(whereClause); }
    const totalRows = await countQuery;
    total = Number(totalRows[0]?.c ?? 0);
  }

  // ---- Expansion (batched) ----------------------------------------------
  let plans: ExpansionPlan[] = [];
  if (allowedExpands.length > 0) {
    plans = allowedExpands.map((relation) => ({
      relation,
      projection: sqlKeyedProjection(relation.targetCfg),
    }));
    const result = await executeExpansions(
      db, plans, cleanRows.map((r) => r.wire), table, cfg,
    );
    const merged = mergeExpansions(cleanRows.map((r) => r.wire), table, cfg, result, plans);
    return {
      ok: true, rows: merged, total, nextCursor, pageSize, mode,
    };
  }

  return {
    ok: true, rows: cleanRows.map((r) => r.wire), total, nextCursor, pageSize, mode,
  };
}

function stripInternalKeys(row: any, terms: OrderTerm[]): any {
  const out: Record<string, any> = { ...row };
  for (const term of terms) {
    if (term.isRelationTerm && term.rowKey) { delete out[term.rowKey]; }
  }
  return out;
}

function clampPageSize(n: number): number {
  if (!Number.isFinite(n) || n <= 0) { return DEFAULT_PAGE_SIZE; }
  return Math.min(Math.floor(n), MAX_PAGE_SIZE);
}

function directSort(
  q: Record<string, unknown>,
  def: ListRunnerInput['def'],
): { field: string; order: 'asc' | 'desc' } | null {
  const sortField = q._sort;
  if (typeof sortField === 'string' && !sortField.includes('.') && sortField.length > 0) {
    return { field: sortField, order: (typeof q._order === 'string' && q._order.toUpperCase() === 'DESC') ? 'desc' : 'asc' };
  }
  if (!sortField && def?.list?.defaultSort) {
    return def.list.defaultSort;
  }
  return null;
}

function jsKey(table: any, sqlName: string): string {
  for (const [k, v] of Object.entries(table)) {
    if (v && typeof v === 'object' && (v as any)?.name === sqlName) { return k; }
  }
  return sqlName;
}

export type { RelationQuery };
