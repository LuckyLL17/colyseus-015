/**
 * Single-hop ("one level deep") relational querying for resource lists.
 *
 * Given a resource list request, the caller may reference EXACTLY ONE
 * declared relation and then:
 *   - filter rows by a column of the related resource — `?user.name_like=ann`
 *   - sort rows by a column of the related resource — `?_sort=user.created_at`
 *   - expand the related rows into the response — `?_expand=user`
 *   - page with stable keyset cursors — `?_cursor=<opaque>&_limit=50`
 *
 * Only one hop is supported on purpose — this is NOT a generic graph query
 * engine. Dotted names with more than one segment, or a second relation in
 * the same request, are rejected with a 400 so clients fail loudly instead
 * of silently getting different semantics.
 *
 * Cardinality handling (the important part — see the plan builders):
 *   - 'one' relations are served by a single LEFT JOIN. No fan-out is
 *     possible because the FK column carries a single value.
 *   - 'many' relations are NEVER joined into the list query: filters use
 *     EXISTS subqueries, sorting uses a MIN/MAX aggregate subquery, and
 *     expansion is a second batched SELECT (one extra query total, no N+1).
 *
 * Soft-deleted related rows (`deleted_at` / `deletedAt` / `is_deleted` /
 * `isDeleted` columns) are treated as absent inside the join/exists
 * predicates, so "filter by related field" doesn't resurrect deleted data.
 *
 * The module is deliberately split into pure pieces (cursor codec,
 * keyset predicate, request parsing) and the drizzle-backed execution so
 * the pure bits stay unit-testable without a database.
 */
import {
  and, asc, desc, eq, gt, inArray, isNull, lt, or, sql,
  type SQL,
} from 'drizzle-orm';
import { resolveFkLayout, type RelationDefinition } from '@colyseus/database';
import {
  buildFilterCondition, castFilterValue, pkColumns,
  type TableColumn, type TableConfig,
} from '../internal/helpers.js';

// ---------------------------------------------------------------------------
// Cursor codec — opaque base64url JSON: { v: [...sort key values...] }
// ---------------------------------------------------------------------------

/**
 * Encode the sort-key tuple of the LAST row of a page into an opaque cursor.
 * Values come straight from a drizzle row: Dates become ISO strings so the
 * cursor is JSON-safe; everything else passes through (numbers/strings/bools
 * round-trip as-is).
 */
export function encodeCursor(values: unknown[]): string {
  const json = JSON.stringify({
    v: values.map((v) => (v instanceof Date ? v.toISOString() : v)),
  });
  return Buffer.from(json, 'utf-8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Decode + validate a cursor produced by {@link encodeCursor}. Returns the
 * raw tuple on success, or an error string suitable for a 400 response.
 * Values stay string-typed (Dates arrive as ISO strings, numeric columns as
 * JSON numbers); callers re-cast each entry against its sort column via
 * {@link castCursorValue} before binding.
 */
export function decodeCursor(raw: string, expectedLen: number): { ok: true; values: unknown[] } | { ok: false; error: string } {
  let b64 = raw.replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) { b64 += '='; }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(b64, 'base64').toString('utf-8'));
  } catch (err: any) {
    return { ok: false, error: `malformed cursor: ${err?.message ?? String(err)}` };
  }
  const v = (parsed as { v?: unknown })?.v;
  if (!Array.isArray(v)) { return { ok: false, error: 'malformed cursor: missing key tuple' }; }
  if (v.length !== expectedLen) {
    return { ok: false, error: `cursor arity mismatch: expected ${expectedLen} values, got ${v.length}` };
  }
  return { ok: true, values: v };
}

/**
 * Cast one decoded cursor entry back to the driver value its sort column
 * expects. Mirrors the request-edge cast in helpers.ts but tokenizes
 * drizzle's composite dataType strings (`'object date'` for sqlite's
 * timestamp-mode integer, `'number int53'` for plain int53) the same way
 * `coerceForColumn` does.
 */
export function castCursorValue(raw: unknown, col: TableColumn): unknown {
  if (raw === null) { return null; }
  const tokens = new Set((col.dataType ?? '').split(/\s+/));
  if (tokens.has('date')) {
    if (raw instanceof Date) { return raw; }
    const d = new Date(String(raw));
    if (isNaN(d.getTime())) { return raw; }
    // Timestamp-mode integers compare numerically on sqlite — bind the
    // unix(-ms) integer rather than a Date when that's the column shape.
    const sqlType = typeof col.getSQLType === 'function' ? col.getSQLType() : '';
    if (/integer/i.test(sqlType)) {
      return tokens.has('ms') ? d.getTime() : Math.floor(d.getTime() / 1000);
    }
    return d;
  }
  if (tokens.has('number') || tokens.has('int53') || tokens.has('bigint')) {
    if (typeof raw === 'number') { return raw; }
    const n = Number(raw);
    return Number.isFinite(n) ? n : raw;
  }
  if (tokens.has('boolean')) {
    if (typeof raw === 'boolean') { return raw; }
    return raw === 'true' || raw === 1;
  }
  return raw;
}

// ---------------------------------------------------------------------------
// Keyset pagination — lexicographic comparison over
// (sort col 1, ..., tiebreak PK cols) with NULL handling.
// ---------------------------------------------------------------------------

export interface SortKeyColumn {
  col: TableColumn;
  order: 'asc' | 'desc';
  /**
   * Pre-built SQL that PRODUCES this key's value in the list query — set
   * when ordering by a related-column aggregate subquery. The keyset
   * predicate must compare against THIS expression (aliased in the
   * SELECT), not against `col` on a table that isn't joined.
   */
  expr?: SQL;
}

/**
 * Build the strict-keyset WHERE predicate for "rows strictly AFTER the row
 * the cursor was taken from".
 *
 * For a sort key (k1, k2, ..., kn) with directions d and cursor values t,
 * this is the standard lexicographic OR-chain:
 *
 *   (k1 ≻d t1)
 *   OR (k1 <=> t1 AND k2 ≻d t2)
 *   OR (k1 <=> t1 AND k2 <=> t2 AND ... kn ≻d tn)
 *
 * where `≻d` is the strictly-after operator for the key's direction and
 * `<=>` is null-aware equality (IS NOT DISTINCT FROM). SQL NULLs sort LAST
 * in both directions — see {@link strictAfter} — so a NULL sort value can
 * only sit on the final page regardless of direction, and paging can never
 * skip/duplicate a row whose sort value changed between requests.
 *
 * Keys carrying `expr` (related sorts) compare against the same scalar
 * subquery the SELECT projects — reference it by its outer alias via
 * `aliasName` so the engine doesn't re-execute the subquery per branch.
 */
export function buildKeysetWhere(
  keys: SortKeyColumn[],
  cursorValues: unknown[],
  aliasName?: string,
): SQL {
  const ors: SQL[] = [];
  for (let i = 0; i < keys.length; i++) {
    const ands: SQL[] = [];
    // Prefix: earlier sort columns must be null-aware-equal.
    for (let j = 0; j < i; j++) {
      ands.push(nullAwareEq(keys[j]!, cursorValues[j], aliasName));
    }
    ands.push(strictAfter(keys[i]!, cursorValues[i], aliasName));
    ors.push(ands.length === 1 ? ands[0]! : and(...ands)!);
  }
  return or(...ors)!;
}

/**
 * Resolve the comparable SQL for a key: the outer SELECT alias for an
 * expression key (e.g. `__rel_sort__`), or the table column otherwise.
 */
function keyRef(key: SortKeyColumn, aliasName?: string): any {
  if (key.expr && aliasName) { return sql.identifier(aliasName); }
  return key.col as any;
}

/** Null-aware equality: col IS NULL / col = value (or alias = value). */
function nullAwareEq(key: SortKeyColumn, value: unknown, aliasName?: string): SQL {
  const ref = keyRef(key, aliasName);
  if (value === null) { return isNull(ref); }
  return eq(ref, value as any);
}

/**
 * Strict ordering predicate for one key:
 *   ASC  → col > value. A NULL cursor value can only be on the last page
 *          (NULLs sort last), so it yields an always-false predicate.
 *   DESC → col < value, OR col IS NULL: NULL rows come AFTER every
 *          non-NULL row when walking DESC under NULLS LAST.
 */
function strictAfter(key: SortKeyColumn, value: unknown, aliasName?: string): SQL {
  const ref = keyRef(key, aliasName);
  if (value === null) { return sql`false`; }
  // NULLs sort LAST in both directions: after any non-NULL cursor value
  // the NULL-tail rows are still "ahead", so the predicate includes
  // `col IS NULL` for both ASC and DESC. (ASC: > value then the NULLs;
  // DESC: < value then the NULLs.)
  return or(key.order === 'desc' ? lt(ref, value) : gt(ref, value), isNull(ref))!;
}

// ---------------------------------------------------------------------------
// Soft-delete detection — conventional timestamp/flag column names on the
// table being joined. Kept conservative: only well-known spellings count,
// so an unrelated column never hides rows by accident.
// ---------------------------------------------------------------------------

const SOFT_DELETE_TIMESTAMP_COLS = new Set(['deleted_at', 'deletedAt']);
const SOFT_DELETE_FLAG_COLS = new Set(['is_deleted', 'isDeleted']);

/**
 * Resolve the soft-delete predicate for a table config, if it declares one:
 *   - timestamp columns (`deleted_at`, `deletedAt`): row is live when NULL
 *   - flag columns (`is_deleted`, `isDeleted`): row is live when false/NULL
 * Timestamp wins when both shapes exist (the flag is redundant then).
 */
export function softDeleteCondition(cfg: TableConfig): SQL | undefined {
  const ts = cfg.columns.find((c) => SOFT_DELETE_TIMESTAMP_COLS.has(c.name));
  if (ts) { return isNull(ts as any); }
  const flag = cfg.columns.find((c) => SOFT_DELETE_FLAG_COLS.has(c.name));
  if (flag) { return or(eq(flag as any, false), isNull(flag as any))!; }
  return undefined;
}

// ---------------------------------------------------------------------------
// Request resolution — turn dotted query params into a validated plan
// ---------------------------------------------------------------------------

/**
 * How a list request may reference a single relation. At most ONE relation
 * per request (one-hop guarantee). `null` means the request has no
 * relational component and the plain list path runs.
 */
export interface RelationPlan {
  /** The declared relation being traversed. */
  relation: RelationDefinition;
  /** Drizzle config of the target resource. */
  targetCfg: TableConfig;
  /** Dzzle table object of the target resource. */
  targetTable: any;
  /** Resolved FK layout (which side carries the FK column). */
  layout: { fkOn: 'source' | 'target'; fkCol: any };
  /**
   * Filters against TARGET columns: `?<rel>.<col>[_op]=value`.
   * Each carries the already-built drizzle condition.
   */
  filters: SQL[];
  /**
   * True when the client asked for "source rows with NO related rows" —
   * `?<rel>._null=true`. Mutually exclusive with regular target filters:
   * combining "related.col = x" with "no related row" is a contradiction,
   * so a request carrying both is rejected.
   */
  nullOnly: boolean;
  /** Sort by a TARGET column, when `?_sort=<rel>.<col>`. */
  sort?: { field: string; order: 'asc' | 'desc'; col: TableColumn };
  /** Expand related rows into the response (`?_expand=<rel>`). */
  expand: boolean;
}

export interface ResolveError {
  status: 400;
  message: string;
}

/** Reserved query keys the list endpoints consume themselves. */
const RESERVED_QUERY_KEYS = new Set(['_start', '_end', '_sort', '_order', '_q', '_cursor', '_limit', '_expand']);

const FILTER_OP_RE = /^(.+?)_(like|in|eq|ne|gt|gte|lt|lte)$/;

/**
 * Inspect the request query and resolve the (at most one) relation it
 * references, validating every dotted reference against declared metadata.
 *
 * `baseRelation` is set when resolving for the relation endpoint
 * (`/.../relations/:name`): the path relation is the traversed relation,
 * so its target columns are addressed with BARE params (`?name_like=x`,
 * `?_sort=score`) — the only surface where the parent context already pins
 * the relation. For the top-level list endpoint it's undefined and callers
 * must use `<rel>.<field>` dotted names; a second relation name anywhere
 * in the params is a 400.
 */
export function resolveRelationPlan(opts: {
  query: Record<string, any>;
  relations: RelationDefinition[];
  sourceTable: any;
  sourceCfg: TableConfig;
  tables: Record<string, any>;
  getTableConfig: (table: any) => TableConfig;
  baseRelation?: RelationDefinition;
}): { plan: RelationPlan | null; error?: ResolveError } {
  const { query, relations, sourceTable, tables, getTableConfig, baseRelation } = opts;

  // 1. Determine the single relation in scope.
  const dottedNames = new Set<string>();
  for (const key of Object.keys(query)) {
    if (!key.includes('.')) { continue; }
    const left = key.slice(0, key.indexOf('.'));
    if (!RESERVED_QUERY_KEYS.has(left)) { dottedNames.add(left); }
  }
  const expandRaw = typeof query._expand === 'string' ? query._expand.trim() : '';
  if (expandRaw) {
    for (const name of expandRaw.split(',')) {
      const n = name.trim();
      if (n) { dottedNames.add(n); }
    }
  }
  const sortRaw = typeof query._sort === 'string' ? query._sort : '';
  if (sortRaw.includes('.')) { dottedNames.add(sortRaw.slice(0, sortRaw.indexOf('.'))); }

  let relation: RelationDefinition | undefined = baseRelation;
  if (!relation && dottedNames.size > 0) {
    if (dottedNames.size > 1) {
      return { plan: null, error: { status: 400,
        message: `only one relation may be queried per request; got: ${[...dottedNames].sort().join(', ')}` } };
    }
    const name = [...dottedNames][0]!;
    relation = relations.find((r) => r.name === name);
    if (!relation) {
      return { plan: null, error: { status: 400, message: `unknown relation '${name}'` } };
    }
  }
  if (baseRelation && dottedNames.size > 0) {
    // On the path-scoped relation endpoint, a dotted reference names a
    // relation OF THE TARGET (`?<targetRel>.<col>=…`). A dotted name equal
    // to the base relation would be a self-referential second hop through
    // the same edge — rejected like every other second hop.
    const candidate = [...dottedNames][0]!;
    if (dottedNames.size > 1 || candidate === baseRelation.name) {
      return { plan: null, error: { status: 400,
        message: candidate === baseRelation.name
          ? `'${candidate}' is already the path relation — address its columns with bare params`
          : `only one relation may be queried per request; got: ${[...dottedNames].sort().join(', ')}` } };
    }
    relation = relations.find((r) => r.name === candidate);
    if (!relation) {
      return { plan: null, error: { status: 400,
        message: `unknown relation '${candidate}' on '${baseRelation.target}'` } };
    }
  }
  if (!relation) { return { plan: null }; }

  const targetTable = tables[relation.target];
  if (!targetTable) {
    return { plan: null, error: { status: 400, message: `relation '${relation.name}' targets unknown resource '${relation.target}'` } };
  }
  const targetCfg = getTableConfig(targetTable);
  const layout = resolveFkLayout(sourceTable, targetTable, relation.fk);
  if (!layout) {
    return { plan: null, error: { status: 400, message: `relation '${relation.name}' fk '${relation.fk}' cannot be resolved` } };
  }

  const relPrefix = `${relation.name}.`;
  const plan: RelationPlan = {
    relation, targetCfg, targetTable, layout,
    filters: [], nullOnly: false, expand: false,
  };

  // 2. Filters. In base (relation-endpoint) context bare keys target the
  //    target; everywhere else keys must be dotted with the relation name.
  const isBareTargetContext = !!baseRelation;
  for (const [key, raw] of Object.entries(query)) {
    if (typeof raw !== 'string' || raw.length === 0) { continue; }
    if (RESERVED_QUERY_KEYS.has(key)) { continue; }

    let fieldRef: string;
    if (key.startsWith(relPrefix)) {
      fieldRef = key.slice(relPrefix.length);
    } else if (isBareTargetContext && !key.includes('.')) {
      fieldRef = key;
    } else {
      continue; // source-side param (the caller parses it) or another namespace
    }

    if (fieldRef === '_null') {
      if (raw !== 'true' && raw !== '1' && raw !== 'false' && raw !== '0') {
        return { plan: null, error: { status: 400, message: `invalid value for '${key}': expected true/false` } };
      }
      plan.nullOnly = raw === 'true' || raw === '1';
      continue;
    }

    const m = fieldRef.match(FILTER_OP_RE);
    const fieldName = m ? m[1]! : fieldRef;
    const op = m ? m[2]! : 'eq';
    // One-hop only — a second dot is a nested relation reference.
    if (fieldName.includes('.')) {
      return { plan: null, error: { status: 400,
        message: `multi-hop relations are not supported: '${key}'` } };
    }
    const col = targetCfg.columns.find((c) => c.name === fieldName);
    if (!col) {
      return { plan: null, error: { status: 400,
        message: `relation '${relation.name}' has no column '${fieldName}'` } };
    }
    const cond = buildFilterCondition(col, op, raw);
    if (cond) { plan.filters.push(cond); }
  }
  if (plan.nullOnly && plan.filters.length > 0) {
    return { plan: null, error: { status: 400,
      message: `'${relation.name}._null=true' cannot be combined with filters on '${relation.name}' columns` } };
  }

  // 3. Sort by related column.
  if (sortRaw) {
    const order = (query._order as string | undefined)?.toUpperCase() === 'DESC' ? 'desc' : 'asc';
    const ref = sortRaw.startsWith(relPrefix)
      ? sortRaw.slice(relPrefix.length)
      : (isBareTargetContext && !sortRaw.includes('.') ? sortRaw : null);
    if (ref !== null) {
      if (ref.includes('.')) {
        return { plan: null, error: { status: 400,
          message: `multi-hop relations are not supported: '_sort=${sortRaw}'` } };
      }
      const col = targetCfg.columns.find((c) => c.name === ref);
      if (!col) {
        return { plan: null, error: { status: 400,
          message: `relation '${relation.name}' has no column '${ref}' to sort by` } };
      }
      plan.sort = { field: ref, order, col };
    }
  }

  // 4. Expansion.
  if (expandRaw) {
    const names = expandRaw.split(',').map((n) => n.trim()).filter(Boolean);
    if (names.some((n) => n !== relation.name)) {
      return { plan: null, error: { status: 400,
        message: `only '${relation.name}' can be expanded in this request` } };
    }
    plan.expand = true;
  }

  return { plan };
}

// ---------------------------------------------------------------------------
// SQL assembly — joins / exists / aggregate subqueries
// ---------------------------------------------------------------------------

/**
 * Correlation predicate between source and target for a resolved layout:
 *   fk on TARGET → target.fk = source.pk
 *   fk on SOURCE → source.fk = target.pk
 *
 * `sourceAlias`/`targetAlias` are the drizzle table objects to qualify
 * columns with (a drizzle join alias on either side); they default to the
 * base tables. Columns are looked up by SQL name and fall back to the
 * column object carried by the metadata.
 */
export function correlationCondition(
  sourceTable: any,
  sourceCfg: TableConfig,
  targetTable: any,
  targetCfg: TableConfig,
  layout: { fkOn: 'source' | 'target'; fkCol: any },
): SQL {
  if (layout.fkOn === 'target') {
    const sourcePk = pkColumns(sourceCfg)[0]!;
    return eq(columnOn(targetTable, layout.fkCol), columnOn(sourceTable, sourcePk) as any);
  }
  const targetPk = pkColumns(targetCfg)[0]!;
  return eq(columnOn(sourceTable, layout.fkCol), columnOn(targetTable, targetPk) as any);
}

// Resolve a column on a (possibly aliased) drizzle table. The TableConfig
// column objects are the SAME runtime objects drizzle exposes as table
// properties (both come from getTableConfig), so prefer the table property
// when one is present — it carries full Column internals (encoders,
// mappers, table refs) that the stripped TableColumn duck-type omits.
function columnOn(table: any, maybeCol: TableColumn): any {
  const byName = maybeCol?.name != null ? table?.[maybeCol.name] : undefined;
  return byName ?? maybeCol;
}

/**
 * Correlated EXISTS predicate over a relation's target table:
 *
 *   EXISTS (SELECT 1 FROM <target>
 *           WHERE <correlation>
 *             AND <soft-delete predicate>
 *             AND [target filter conditions])
 *
 * Used for BOTH cardinalities:
 *   - 'many' relations can't be JOINed into the list without fan-out, so
 *     filtering always goes through this predicate.
 *   - 'one' relations use it too, so a non-unique FK in the data (two rows
 *     claiming the same parent) can never duplicate a source row in the
 *     response — defensive handling of duplicate related rows.
 *
 * Inverted (NOT EXISTS) when the request wants source rows with NO related
 * rows (`nullOnly`). Every target-column filter is pushed INTO this
 * subquery — that's what makes filtering by a related column fan-out-free
 * (no JOIN duplicates) and N+1-free (evaluated per source row in SQL).
 */
export function relatedExistsCondition(
  sourceTable: any,
  sourceCfg: TableConfig,
  targetTable: any,
  targetCfg: TableConfig,
  layout: { fkOn: 'source' | 'target'; fkCol: any },
  targetFilters: SQL[],
  negate: boolean,
): SQL {
  const conds: SQL[] = [correlationCondition(sourceTable, sourceCfg, targetTable, targetCfg, layout)];
  const soft = softDeleteCondition(targetCfg);
  if (soft) { conds.push(soft); }
  conds.push(...targetFilters);
  const where = conds.length === 1 ? conds[0]! : and(...conds)!;
  // The subquery is a raw SQL fragment (not a drizzle subquery builder),
  // so wrap it in parentheses explicitly — drizzle's exists() only
  // parenthesizes builder-produced subqueries.
  const sub = sql`(select 1 from ${targetTable} where ${where})`;
  return negate ? sql`not exists ${sub}` : sql`exists ${sub}`;
}

/**
 * Correlated scalar subquery producing the value the SOURCE list orders by
 * when sorting on a related column:
 *
 *   - 'many' → (SELECT MIN|MAX(col) FROM target WHERE <corr> AND <soft>)
 *     A parent with no live children sorts as NULL.
 *   - 'one'  → (SELECT col FROM target WHERE <corr> AND <soft> LIMIT 1)
 *     LIMIT 1 keeps the subquery scalar even when the FK isn't unique in
 *     the data — again preventing duplicate-row blow-ups.
 *
 * Both shapes emit exactly one SQL value per source row; NULLs sort last
 * (see orderByFragments), so rows without a related record land at the end
 * in either direction.
 */
export function relatedSortExpression(
  sourceTable: any,
  sourceCfg: TableConfig,
  targetTable: any,
  targetCfg: TableConfig,
  layout: { fkOn: 'source' | 'target'; fkCol: any },
  sortCol: TableColumn,
  order: 'asc' | 'desc',
  kind: 'one' | 'many',
): SQL {
  const conds: SQL[] = [correlationCondition(sourceTable, sourceCfg, targetTable, targetCfg, layout)];
  const soft = softDeleteCondition(targetCfg);
  if (soft) { conds.push(soft); }
  // IMPORTANT: don't wrap a single condition in and(). Drizzle renders a
  // lone comparison column as qualified (`"members"."user_id" = "users"."id"`)
  // even inside a SELECT-list scalar subquery, but a one-arg `and()` wrapper
  // can strip the table qualification in that context, which silently turns
  // the correlation into `"user_id" = "id"` → NULL aggregate for every row.
  const where = conds.length === 1 ? conds[0]! : and(...conds)!;
  if (kind === 'one') {
    return sql`(select ${sortCol as any} from ${targetTable} where ${where} limit 1)`;
  }
  return sql`(select ${order === 'desc' ? sql`max` : sql`min`}(${sortCol as any}) from ${targetTable} where ${where})`;
}

// ---------------------------------------------------------------------------
// Expansion batching — the anti-N+1 read path
// ---------------------------------------------------------------------------

/**
 * Load related rows for expansion in ONE batched query and group them by
 * the source-row key they attach to.
 *
 *   - fk on TARGET ('many' parents, or fk-on-target 'one' like users→role):
 *     WHERE target.fk IN (:sourceIds)
 *   - fk on SOURCE ('one' children like cloudSave→user):
 *     WHERE target.pk IN (:sourceFkValues)
 *
 * `lookupValues` supplies the values to match for the current page — the
 * caller reads source rows anyway, so for fk-on-source 'one' relations it
 * passes each row's FK value (NULLs skipped; a NULL FK attaches nothing),
 * avoiding an extra source lookup.
 *
 * Soft-deleted related rows are excluded. The returned map is keyed by the
 * VALUES passed in (as strings), so callers can attach results while
 * iterating the page: fk-on-target keys are source PKs; fk-on-source keys
 * are the source FK values. 'one' expansions map to a single row object,
 * 'many' to an array.
 */
export async function batchExpand(opts: {
  db: any;
  plan: RelationPlan;
  /** Config of the source resource — supplies the PK type for fk-on-target IN casts. */
  sourceCfg: TableConfig;
  lookupValues: string[];
  projection: Record<string, any>;
}): Promise<Map<string, any>> {
  const { db, plan, sourceCfg, lookupValues, projection } = opts;
  const out = new Map<string, any>();
  const values = [...new Set(lookupValues.filter((v) => v != null && v !== ''))];
  if (values.length === 0) { return out; }

  const { targetCfg, targetTable, layout, relation } = plan;
  const matchCol = layout.fkOn === 'target'
    ? columnOn(targetTable, layout.fkCol)
    : columnOn(targetTable, pkColumns(targetCfg)[0]!);
  const castCol = layout.fkOn === 'target'
    ? pkColumns(sourceCfg)[0]!
    : pkColumns(targetCfg)[0]!;
  const casted = values.map((v) => castFilterValue(v, castCol));

  const conds: SQL[] = [inArray(matchCol, casted)];
  const soft = softDeleteCondition(targetCfg);
  if (soft) { conds.push(soft); }

  const relatedRows: any[] = await db
    .select(projection)
    .from(targetTable)
    .where(and(...conds));

  // What value on the RELATED row identifies the source key it attaches to.
  const attachCol = layout.fkOn === 'target'
    ? columnOn(targetTable, layout.fkCol)
    : columnOn(targetTable, pkColumns(targetCfg)[0]!);
  const attachColName = attachCol.name as string;

  for (const related of relatedRows) {
    const key = String((related as any)[attachColName]);
    if (relation.kind === 'many') {
      const bucket = out.get(key);
      if (Array.isArray(bucket)) { bucket.push(related); }
      else { out.set(key, [related]); }
    } else if (!out.has(key)) {
      // Single-valued. A duplicate match means two rows claim the same
      // unique FK (data bug) — keep the first; a 'one' relation must not
      // fan out by contract.
      out.set(key, related);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Sort keys + ORDER BY
// ---------------------------------------------------------------------------

/**
 * The sort keys for a list request, in ORDER BY order:
 *   1. the explicit sort (own column or related column), if any;
 *   2. every PK column appended as a tiebreaker.
 *
 * The PK tiebreaker is what makes keyset pagination STABLE: without it rows
 * that compare equal on the user-chosen sort column (same timestamp, same
 * score, NULLs…) can swap positions between pages, skipping or duplicating
 * rows. Composite PKs contribute all their columns.
 *
 * `targetColumn` is the related sort column qualified to the join alias
 * (one relations) or the aggregate subquery SQL (many relations) — the
 * endpoint computes it and passes it in.
 */
export function resolveSortKeys(opts: {
  ownSortField?: string;
  ownSortOrder?: 'asc' | 'desc';
  ownCfg: TableConfig;
  ownDefaultSort?: { field: string; order: 'asc' | 'desc' };
  /** Pre-built sort expression + column metadata for the related sort. */
  relatedSort?: { expr: SQL; meta: TableColumn; order: 'asc' | 'desc' };
}): SortKeyColumn[] {
  const keys: SortKeyColumn[] = [];
  const { ownSortField, ownSortOrder, ownCfg, ownDefaultSort, relatedSort } = opts;
  if (relatedSort) {
    keys.push({ col: relatedSort.meta, order: relatedSort.order, expr: relatedSort.expr });
  } else if (ownSortField) {
    const col = ownCfg.columns.find((c) => c.name === ownSortField);
    if (col) { keys.push({ col, order: ownSortOrder ?? 'asc' }); }
  } else if (ownDefaultSort) {
    const col = ownCfg.columns.find((c) => c.name === ownDefaultSort.field);
    if (col) { keys.push({ col, order: ownDefaultSort.order }); }
  }
  for (const pk of pkColumns(ownCfg)) {
    if (!keys.some((k) => k.col.name === pk.name)) {
      keys.push({ col: pk, order: 'asc' });
    }
  }
  return keys;
}

/** ORDER BY fragments: each key NULLS LAST, using the pre-built expr when present. */
export function orderByFragments(keys: SortKeyColumn[]): SQL[] {
  return keys.map((k) => {
    const inner = k.expr ?? (k.col as any);
    return k.order === 'desc'
      ? sql`${desc(inner)} NULLS LAST`
      : sql`${asc(inner)} NULLS LAST`;
  });
}

/**
 * Read the sort-key tuple off a result row. Join-derived columns land in
 * the row under their bare SQL name (drizzle nested projection nests them
 * instead — endpoints pass the flat projection for cursor reads). Aggregate
 * sorts alias their scalar as `__rel_sort__` (see the endpoint); own
 * columns use their own name.
 */
export function sortKeyValues(
  row: Record<string, any>,
  keys: Array<{ col: TableColumn; expr?: SQL }>,
  aggregateAlias = '__rel_sort__',
): unknown[] {
  return keys.map((k) => (k.expr ? row[aggregateAlias] : row[k.col.name]));
}
