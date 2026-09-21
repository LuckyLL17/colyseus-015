/**
 * Single-layer relation query engine for the admin list endpoint
 * (`GET /admin-api/:resource`) and the parent-scoped relation endpoint
 * (`GET /admin-api/:resource/:id/relations/:name`).
 *
 * Deliberately single-hop: every feature here crosses exactly ONE declared
 * relation from the base resource. There is intentionally no multi-level
 * dot-path grammar, nested expansion, or generic query DSL — this module is
 * the whole abstraction surface.
 *
 * The three capabilities, expressed in URL syntax:
 *
 *   Filter by a related field
 *     ?<relation>.<field>[_op]=value           — to-one: column comparison
 *     ?<relation>.<field>_null=1               — rows with NO live related row
 *     ?<relation>.<field>_notnull=1            — rows having a live related row
 *     ?<relation>._exists=1|0                  — to-many: has any/no child
 *     ?<relation>.<field>[_op]=value           — to-many: EXISTS(correlated)
 *
 *   Sort by a related field
 *     &_sort=<relation>.<field>&_order=asc|desc
 *     to-one sorts via a correlated scalar subquery on the joined column;
 *     to-many sorts on MIN()/MAX() of the child column (aggregated in a
 *     correlated subquery so the result is always scalar — see below).
 *
 *   Embed the related row(s)
 *     &_expand=<relation>[,<relation>...]
 *     Expansion runs as ONE extra batched query per relation (never one per
 *     base row): to-one rows come back in a single IN(...) lookup, to-many
 *     rows in a single grouped fetch that the caller buckets in memory.
 *
 * Stability + correctness rules baked in:
 *   - The base SELECT never JOINs a to-many target (the classic duplicate-row
 *     source). To-many predicates/aggregates are correlated subqueries
 *     (EXISTS / scalar aggregate); the same WHERE feeds count(*) and the
 *     key-set page, so totals can't drift from the page contents.
 *   - Keyset pagination (`_cursor`) orders by (sort…, PK…) and carries the
 *     full ordered tuple in an opaque base64url cursor, so inserts/deletes
 *     between pages never skip or duplicate a row.
 *   - Any table carrying a conventional soft-delete marker
 *     (`deleted_at`/`deletedAt`/`is_deleted`/`soft_deleted`) is filtered on
 *     BOTH sides of a relation — a soft-deleted parent or child is invisible
 *     to relation filters/sorts/expansion.
 *   - Every relation/column/operator is validated against catalog metadata
 *     before touching SQL; relation payloads are gated by the SAME RBAC
 *     guard the target resource's own endpoints use.
 */
import {
  and, asc, desc, eq, gt, inArray, isNotNull, isNull, lt, or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { resolveFkLayout, type RelationDefinition } from '@colyseus/database';
import {
  buildFilterCondition, castFilterValue,
  pkColumns, type TableColumn, type TableConfig,
} from '../internal/helpers.js';

// ---------------------------------------------------------------------------
// Resolved-relation shape
// ---------------------------------------------------------------------------

export type RelationCardinality = 'to-one' | 'to-many';

export interface ResolvedRelation {
  def: RelationDefinition;
  cardinality: RelationCardinality;
  targetName: string;
  targetTable: any;
  targetCfg: TableConfig;
  /** drizzle column object + SQL name of the FK, on whichever side carries it. */
  fkCol: any;
  fkSqlName: string;
  fkOn: 'source' | 'target';
  /**
   * PK columns of the parent side of the join (the side the FK points AT).
   * Single-column FK metadata means this always has exactly one entry.
   */
  parentPk: TableColumn[];
  /** Child table for to-many; null for to-one. */
  childTable: any | null;
  childCfg: TableConfig | null;
  /** Soft-delete markers detected on the tables the relation touches. */
  softDelete: {
    /** Marker on the related (target) table. */
    target: TableColumn | null;
    /** Marker on the child table for to-many (same table in the common shape). */
    child: TableColumn | null;
  };
}

export interface RelationCondition {
  relation: ResolvedRelation;
  /** SQL column on the related table; null for field-less `rel._exists`. */
  field: TableColumn | null;
  op: string;
  /** Raw query-string value; null for the valeless _null/_notnull ops. */
  raw: string | null;
}

export interface RelationSort {
  relation: ResolvedRelation;
  field: TableColumn;
  order: 'asc' | 'desc';
}

export interface RelationQuery {
  conditions: RelationCondition[];
  sort: RelationSort | null;
  expands: ResolvedRelation[];
}

export interface BuildFailure {
  status: number;
  message: string;
}

export type ParseResult = { ok: true; query: RelationQuery } | { ok: false; failure: BuildFailure };

// ---------------------------------------------------------------------------
// Soft-delete detection. Convention-based (there is no drizzle soft-delete
// API to interrogate): a column named deleted_at/deletedAt or
// is_deleted/isDeleted/soft_deleted/softDeleted marks a tombstone. Timestamp
// markers count when non-null; boolean markers when true. Both shapes occur
// in real game schemas, so both are honored.
// ---------------------------------------------------------------------------

const SOFT_DELETE_TIMESTAMP_NAMES = new Set(['deleted_at', 'deletedat']);
// `deleted`/`is_deleted` are the two common boolean tombstone names.
const SOFT_DELETE_BOOLEAN_NAMES = new Set(['deleted', 'is_deleted', 'isdeleted', 'soft_deleted', 'softdeleted']);

/**
 * EXISTS with explicit parentheses. Drizzle's `exists()` helper emits
 * `exists <subquery>` relying on its own select-builder wrapping; our
 * subqueries are hand-built `sql` fragments, so we parenthesize ourselves
 * (Postgres rejects a bare `exists select …`).
 */
function sqlExists(inner: SQL): SQL {
  return sql`exists (${inner})`;
}

export function isSoftDeleteColumn(c: TableColumn): boolean {
  const lower = c.name.toLowerCase();
  return SOFT_DELETE_TIMESTAMP_NAMES.has(lower) || SOFT_DELETE_BOOLEAN_NAMES.has(lower);
}

export function softDeleteColumn(cfg: TableConfig): TableColumn | null {
  return cfg.columns.find(isSoftDeleteColumn) ?? null;
}

/** Find a drizzle column object on a table by its SQL column name. */
export function findColumnBySqlName(table: any, sqlName: string): any {
  for (const v of Object.values(table)) {
    if (v && typeof v === 'object' && (v as any)?.name === sqlName) { return v; }
  }
  return undefined;
}

/** Reverse lookup: SQL column name → drizzle JS field key on the table. */
export function jsFieldForColumn(table: any, sqlName: string): string {
  for (const [k, v] of Object.entries(table)) {
    if (v && typeof v === 'object' && (v as any)?.name === sqlName) { return k; }
  }
  return sqlName;
}

/**
 * Predicate restricting `table` to live (non-tombstoned) rows:
 * timestamp markers must be NULL; boolean markers must be false/NULL.
 * Returns null when the table has no soft-delete marker.
 */
export function liveRowsPredicate(table: any, cfg: TableConfig): SQL | null {
  const marker = softDeleteColumn(cfg);
  if (!marker) { return null; }
  const col = findColumnBySqlName(table, marker.name);
  if (!col) { return null; }
  if (SOFT_DELETE_TIMESTAMP_NAMES.has(marker.name.toLowerCase())) { return isNull(col); }
  return or(eq(col, false), isNull(col)) ?? sql`(${col} is null or ${col} = false)`;
}

// ---------------------------------------------------------------------------
// Relation resolution. One hop only — the relation name must be declared in
// `relations[sourceName]`, its target must be a registered table, and the FK
// column declared in metadata must resolve on one of the two sides.
// ---------------------------------------------------------------------------

export interface RelationRegistry {
  tables: Record<string, any>;
  getTableConfig: (table: any) => TableConfig;
  relations: Record<string, RelationDefinition[]>;
}

export function resolveRelation(
  registry: RelationRegistry,
  sourceName: string,
  relationName: string,
): { ok: true; relation: ResolvedRelation } | { ok: false; failure: BuildFailure } {
  const def = (registry.relations[sourceName] ?? []).find((r) => r.name === relationName);
  if (!def) {
    return { ok: false, failure: { status: 404, message: `unknown relation '${relationName}' on '${sourceName}'` } };
  }
  const sourceTable = registry.tables[sourceName];
  const targetTable = registry.tables[def.target];
  if (!sourceTable) {
    return { ok: false, failure: { status: 404, message: `unknown resource '${sourceName}'` } };
  }
  if (!targetTable) {
    return { ok: false, failure: { status: 404, message: `relation '${relationName}' targets unknown resource '${def.target}'` } };
  }
  const layout = resolveFkLayout(sourceTable, targetTable, def.fk);
  if (!layout) {
    return {
      ok: false,
      failure: {
        status: 500,
        message: `relation '${relationName}' fk '${def.fk}' not found on '${sourceName}' or '${def.target}'`,
      },
    };
  }
  const sourceCfg = registry.getTableConfig(sourceTable);
  const targetCfg = registry.getTableConfig(targetTable);
  const fkSqlName: string = layout.fkCol?.name ?? def.fk;

  if (def.kind === 'one') {
    // to-one with FK on source: source.fk → target.PK (ordinary lookup).
    // to-one with FK on target (users → role via roles.user_id): target row
    // is found by matching target.fk to the source's PK. Either way the
    // result is at most one related row.
    const fkOn = layout.fkOn;
    const parentPk = fkOn === 'source' ? pkColumns(targetCfg) : pkColumns(sourceCfg);
    if (parentPk.length === 0) {
      return { ok: false, failure: { status: 400, message: `relation '${relationName}': referenced side has no primary key` } };
    }
    return {
      ok: true,
      relation: {
        def, cardinality: 'to-one', targetName: def.target, targetTable, targetCfg,
        fkCol: layout.fkCol, fkSqlName, fkOn, parentPk,
        childTable: null, childCfg: null,
        softDelete: { target: softDeleteColumn(targetCfg), child: null },
      },
    };
  }

  // kind === 'many'. Our metadata contract is "children point at the parent"
  // — the FK lives on the target. An FK-on-source 'many' cannot be traversed
  // with the single-column metadata we carry (it describes no join), so
  // reject it at resolution time rather than emitting a wrong query.
  if (layout.fkOn !== 'target') {
    return {
      ok: false,
      failure: {
        status: 400,
        message: `relation '${relationName}': to-many relation must declare the FK on its target ('${def.target}')`,
      },
    };
  }
  const parentPk = pkColumns(sourceCfg);
  if (parentPk.length === 0) {
    return { ok: false, failure: { status: 400, message: `relation '${relationName}': source has no primary key` } };
  }
  return {
    ok: true,
    relation: {
      def, cardinality: 'to-many', targetName: def.target, targetTable, targetCfg,
      fkCol: layout.fkCol, fkSqlName, fkOn: 'target', parentPk,
      childTable: targetTable, childCfg: targetCfg,
      softDelete: { target: softDeleteColumn(targetCfg), child: softDeleteColumn(targetCfg) },
    },
  };
}

// ---------------------------------------------------------------------------
// Query-string parsing. Keys use the SAME grammar the plain list endpoint
// accepts — `<field>[_op]=value` — with an optional single `<relation>.`
// prefix. Plain columns stay the caller's concern; this parser only owns
// dotted keys, `_sort` when it contains a dot, and `_expand`.
// ---------------------------------------------------------------------------

const FILTER_OPS = new Set(['like', 'in', 'eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'null', 'notnull', 'exists']);
/** Operators that carry no comparison value (the key itself is the predicate). */
const VALUELESS_OPS = new Set(['null', 'notnull']);

function splitRelationKey(key: string): { relation: string; rest: string } | null {
  const dot = key.indexOf('.');
  if (dot <= 0) { return null; }
  return { relation: key.slice(0, dot), rest: key.slice(dot + 1) };
}

export function parseRelationQuery(
  registry: RelationRegistry,
  sourceName: string,
  q: Record<string, unknown>,
): ParseResult & { consumedKeys: Set<string> } {
  const conditions: RelationCondition[] = [];
  const resolvedByName = new Map<string, ResolvedRelation>();
  const consumedKeys = new Set<string>();

  const ensureRelation = (name: string): ResolvedRelation | BuildFailure => {
    const cached = resolvedByName.get(name);
    if (cached) { return cached; }
    const r = resolveRelation(registry, sourceName, name);
    if (!r.ok) { return r.failure; }
    resolvedByName.set(name, r.relation);
    return r.relation;
  };

  const fieldFailure = (relationName: string, fieldName: string): BuildFailure => ({
    status: 400,
    message: `relation '${relationName}' has no column '${fieldName}'`,
  });

  // 1) Relation-prefixed filters.
  for (const [key, rawValue] of Object.entries(q)) {
    const parts = splitRelationKey(key);
    if (!parts) { continue; }
    consumedKeys.add(key);
    if (typeof rawValue !== 'string') { continue; }

    const relation = ensureRelation(parts.relation);
    if ('status' in relation) { return { ok: false, failure: relation, consumedKeys }; }

    // Match `<field>_<op>` where field may be empty for the bare
    // `rel._exists` form. Bare `rel.` without an op falls through to eq
    // validation below (and fails as an unknown empty field).
    const match = parts.rest.match(/^(.*?)_(like|in|eq|ne|gt|gte|lt|lte|null|notnull|exists)$/);
    const fieldName = match ? match[1]! : parts.rest;
    const op = match ? match[2]! : 'eq';
    if (!FILTER_OPS.has(op)) {
      return {
        ok: false,
        failure: { status: 400, message: `unsupported operator '${op}' on relation '${parts.relation}'` },
        consumedKeys,
      };
    }

    // Field-less existence: `rel._exists=1`. Only valid for to-many.
    if (fieldName.length === 0) {
      if (op !== 'exists') {
        return {
          ok: false,
          failure: { status: 400, message: `relation '${parts.relation}': missing field name` },
          consumedKeys,
        };
      }
      if (relation.cardinality !== 'to-many') {
        return {
          ok: false,
          failure: { status: 400, message: `relation '${parts.relation}': '_exists' applies to to-many relations` },
          consumedKeys,
        };
      }
      conditions.push({ relation, field: null, op, raw: rawValue });
      continue;
    }

    const col = relation.targetCfg.columns.find((c) => c.name === fieldName);
    if (!col) {
      return { ok: false, failure: fieldFailure(parts.relation, fieldName), consumedKeys };
    }

    if (VALUELESS_OPS.has(op)) {
      // The field names the join column the user thinks of ("users with no
      // role.role value"); it's validated above but the predicate is purely
      // about the existence of a live related row.
      conditions.push({ relation, field: col, op, raw: null });
      continue;
    }

    if (op === 'exists') {
      // `rel.field_exists=1` — EXISTS over a child with that column NOT NULL.
      if (relation.cardinality !== 'to-many') {
        return {
          ok: false,
          failure: { status: 400, message: `relation '${parts.relation}': '_exists' applies to to-many relations` },
          consumedKeys,
        };
      }
      conditions.push({ relation, field: col, op, raw: rawValue });
      continue;
    }

    if (rawValue.length === 0) { continue; }
    conditions.push({ relation, field: col, op, raw: rawValue });
  }

  // 2) Sort — at most one, mirroring the direct-column list endpoint.
  let sort: RelationSort | null = null;
  const sortField = typeof q._sort === 'string' ? q._sort : '';
  if (sortField.includes('.')) {
    consumedKeys.add('_sort');
    const dot = sortField.indexOf('.');
    const relationName = sortField.slice(0, dot);
    const fieldName = sortField.slice(dot + 1);
    const relation = ensureRelation(relationName);
    if ('status' in relation) { return { ok: false, failure: relation, consumedKeys }; }
    const col = relation.targetCfg.columns.find((c) => c.name === fieldName);
    if (!col) {
      return { ok: false, failure: fieldFailure(relationName, fieldName), consumedKeys };
    }
    const order = (typeof q._order === 'string' && q._order.toUpperCase() === 'DESC') ? 'desc' : 'asc';
    sort = { relation, field: col, order };
  }

  // 3) Expansions — comma-separated relation names. RBAC on each target is
  //    enforced by the caller (it needs request context); an expansion the
  //    caller may not see is dropped there rather than failing the whole list.
  const expands: ResolvedRelation[] = [];
  if (typeof q._expand === 'string' && q._expand.trim().length > 0) {
    consumedKeys.add('_expand');
    for (const rawName of q._expand.split(',').map((s) => s.trim()).filter((s) => s.length > 0)) {
      const relation = ensureRelation(rawName);
      if ('status' in relation) { return { ok: false, failure: relation, consumedKeys }; }
      if (!expands.some((e) => e.def.name === rawName)) { expands.push(relation); }
    }
  }

  return { ok: true, query: { conditions, sort, expands }, consumedKeys };
}

// ---------------------------------------------------------------------------
// WHERE construction. All relation predicates are correlated subqueries —
// the base table is never joined to a relation, so base rows never multiply.
// ---------------------------------------------------------------------------

function targetColumn(relation: ResolvedRelation, field: TableColumn): any {
  return findColumnBySqlName(relation.targetTable, field.name);
}

/** `ON` predicate joining a to-one target row to a base row (no alias tricks
 *  — every subquery references the physical tables directly). */
function oneJoinOn(relation: ResolvedRelation, baseTable: any): SQL[] {
  const on: SQL[] = [];
  if (relation.fkOn === 'source') {
    const pk = relation.parentPk[0]!;
    on.push(eq(
      findColumnBySqlName(relation.targetTable, pk.name),
      findColumnBySqlName(baseTable, relation.fkSqlName),
    ));
  } else {
    const pk = relation.parentPk[0]!;
    on.push(eq(
      findColumnBySqlName(relation.targetTable, relation.fkSqlName),
      findColumnBySqlName(baseTable, pk.name),
    ));
  }
  return on;
}

function existsOne(relation: ResolvedRelation, baseTable: any, extra: SQL[]): SQL {
  const on = oneJoinOn(relation, baseTable);
  const live = liveRowsPredicate(relation.targetTable, relation.targetCfg);
  if (live) { on.push(live); }
  on.push(...extra);
  return sqlExists(sql`select 1 from ${relation.targetTable} where ${and(...on)}`);
}

function toOneConditionSQL(cond: RelationCondition, baseTable: any): SQL {
  const { relation, field, op, raw } = cond;

  if (op === 'notnull') {
    // A live related row exists. The field itself was validated at parse.
    return existsOne(relation, baseTable, []);
  }

  if (op === 'null') {
    // No LIVE related row: NULL FK on the source side, OR an FK that dangles
    // (points at a hard- or soft-deleted target). fk-on-target shape is
    // simply "no target row matches".
    if (relation.fkOn === 'source') {
      const fkCol = findColumnBySqlName(baseTable, relation.fkSqlName);
      const live = existsOne(relation, baseTable, []);
      return or(isNull(fkCol), and(isNotNull(fkCol), sql`not ${live}`))!;
    }
    return sql`not ${existsOne(relation, baseTable, [])}`;
  }

  // Value comparisons live INSIDE the EXISTS, so NULL-padded outer rows can't
  // leak through and missing/tombstoned relations behave as "no match".
  const pred = buildFilterCondition(field!, op, raw!)!;
  return existsOne(relation, baseTable, [pred]);
}

/** Correlated EXISTS over the child table, optionally with an extra predicate. */
function existsMany(relation: ResolvedRelation, baseTable: any, extra: SQL[], want: boolean): SQL {
  const child = relation.childTable!;
  const pk = relation.parentPk[0]!;
  const on: SQL[] = [
    eq(
      findColumnBySqlName(child, relation.fkSqlName),
      findColumnBySqlName(baseTable, pk.name),
    ),
  ];
  const childLive = liveRowsPredicate(child, relation.childCfg!);
  if (childLive) { on.push(childLive); }
  on.push(...extra);
  const e = sqlExists(sql`select 1 from ${child} where ${and(...on)}`);
  return want ? e : sql`not ${e}`;
}

function toManyConditionSQL(cond: RelationCondition, baseTable: any): SQL {
  const { relation, field, op, raw } = cond;

  const want = (() => {
    switch (op) {
      case 'exists': return raw === '1' || raw === 'true';
      default: return true;
    }
  })();

  if (op === 'exists' && field === null) {
    return existsMany(relation, baseTable, [], want);
  }
  if (op === 'exists' && field) {
    return existsMany(relation, baseTable, [isNotNull(targetColumn(relation, field))], want);
  }
  if (op === 'notnull') {
    return existsMany(relation, baseTable, [isNotNull(targetColumn(relation, field!))], true);
  }
  if (op === 'null') {
    // No child whose named column is populated.
    return existsMany(relation, baseTable, [isNotNull(targetColumn(relation, field!))], false);
  }
  // Value predicates are existential: "has at least one child matching".
  // The complement form is available explicitly via `_exists=0`.
  const pred = buildFilterCondition(field!, op, raw!)!;
  return existsMany(relation, baseTable, [pred], true);
}

export function relationConditionSQL(cond: RelationCondition, baseTable: any): SQL {
  return cond.relation.cardinality === 'to-one'
    ? toOneConditionSQL(cond, baseTable)
    : toManyConditionSQL(cond, baseTable);
}

// ---------------------------------------------------------------------------
// Scalar correlated subqueries for ORDER BY. Never a JOIN — the sort feed is
// a single scalar per base row, so ordering is impossible to fan out.
// ---------------------------------------------------------------------------

/**
 * To-many aggregate: `(SELECT MIN/MAX(child.field) FROM child
 * WHERE child.fk = base.pk [AND child live])`. asc→MIN (the least child
 * drives the group), desc→MAX. Bases without children get NULL, which sorts
 * last in both directions by the NULLS convention used in keysetWhere.
 */
export function toManyAggregateSQL(sort: RelationSort, baseTable: any): SQL {
  const { relation, field, order } = sort;
  const child = relation.childTable!;
  const col = findColumnBySqlName(child, field.name);
  const agg = order === 'asc' ? sql`min(${col})` : sql`max(${col})`;
  const pk = relation.parentPk[0]!;
  const on: SQL[] = [
    eq(
      findColumnBySqlName(child, relation.fkSqlName),
      findColumnBySqlName(baseTable, pk.name),
    ),
  ];
  const childLive = liveRowsPredicate(child, relation.childCfg!);
  if (childLive) { on.push(childLive); }
  return sql`(${sql`select ${agg} from ${child} where ${and(...on)}`})`;
}

/**
 * To-one scalar: `(SELECT t.field FROM t WHERE <join> [AND t live] LIMIT 1)`.
 * Missing/tombstoned relations yield NULL → sort last.
 */
export function toOneScalarSQL(sort: { relation: ResolvedRelation; field: TableColumn }, baseTable: any): SQL {
  const { relation, field } = sort;
  const col = findColumnBySqlName(relation.targetTable, field.name);
  const on = oneJoinOn(relation, baseTable);
  const live = liveRowsPredicate(relation.targetTable, relation.targetCfg);
  if (live) { on.push(live); }
  return sql`(${sql`select ${col} from ${relation.targetTable} where ${and(...on)} limit 1`})`;
}

// ---------------------------------------------------------------------------
// ORDER BY assembly. Effective order: (relation sort | direct sort) followed
// by the FULL primary key as a deterministic tiebreaker. Keyset pagination
// requires this ordering to be total — PK inclusion is what makes it so.
// ---------------------------------------------------------------------------

export interface OrderTerm {
  expr: SQL;
  order: 'asc' | 'desc';
  /** Where the term's value lands in a selected row (null = not selected). */
  rowKey: string | null;
  /** Coercion target for cursor-decoded values; null passes through as-is. */
  column: TableColumn | null;
  isRelationTerm: boolean;
}

export function buildOrderTerms(
  baseTable: any,
  baseCfg: TableConfig,
  opts: {
    relationSort: RelationSort | null;
    directSort: { field: string; order: 'asc' | 'desc' } | null;
  },
): OrderTerm[] {
  const terms: OrderTerm[] = [];
  if (opts.relationSort) {
    const rs = opts.relationSort;
    terms.push({
      expr: rs.relation.cardinality === 'to-many'
        ? toManyAggregateSQL(rs, baseTable)
        : toOneScalarSQL(rs, baseTable),
      order: rs.order,
      rowKey: `__rel_${rs.relation.def.name}_${rs.field.name}`,
      column: rs.field,
      isRelationTerm: true,
    });
  } else if (opts.directSort) {
    const col = baseCfg.columns.find((c) => c.name === opts.directSort!.field);
    if (col) {
      terms.push({
        expr: findColumnBySqlName(baseTable, col.name),
        order: opts.directSort.order,
        rowKey: col.name,
        column: col,
        isRelationTerm: false,
      });
    }
  }
  for (const pkCol of pkColumns(baseCfg)) {
    terms.push({
      expr: findColumnBySqlName(baseTable, pkCol.name),
      order: 'asc',
      rowKey: pkCol.name,
      column: pkCol,
      isRelationTerm: false,
    });
  }
  return terms;
}

export function applyOrderBy(query: any, terms: OrderTerm[]): any {
  // Unrelated rows (relation scalar NULL) sort LAST in both directions —
  // the UI's invariant is "a list ordered by a related field leads with
  // rows that actually have the relation". NULLS LAST is explicit because
  // the dialects disagree on the default: SQLite treats NULL as smallest
  // (first both ways) while Postgres defaults to NULLS FIRST on DESC only.
  return query.orderBy(...terms.map((t) => {
    const dir = t.order === 'desc' ? desc(t.expr) : asc(t.expr);
    return sql`${dir} nulls last`;
  }));
}

// ---------------------------------------------------------------------------
// Cursor codec + keyset predicate.
// ---------------------------------------------------------------------------

export function encodeCursor(values: ReadonlyArray<unknown>): string {
  return Buffer.from(JSON.stringify(values), 'utf-8').toString('base64url');
}

export function decodeCursor(
  encoded: string,
  termCount: number,
): { ok: true; values: unknown[] } | { ok: false; failure: BuildFailure } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf-8'));
  } catch {
    return { ok: false, failure: { status: 400, message: 'invalid cursor: not decodable' } };
  }
  if (!Array.isArray(parsed) || parsed.length !== termCount) {
    return { ok: false, failure: { status: 400, message: `invalid cursor: expected ${termCount} values` } };
  }
  return { ok: true, values: parsed };
}

/**
 * Lexicographic "follows the cursor" predicate over the ORDER BY terms.
 * Every term is ordered NULLS LAST (see applyOrderBy), and each term knows
 * whether it can even be NULL (relation scalars and nullable direct columns
 * can; PK tiebreakers can't).
 *
 * Two disjoint follower regions, emitted as an OR:
 *
 *   A. Strict non-null ordering — pick a position k (0..n-1) whose cursor
 *      value is non-null: terms before k that carry non-null cursor values
 *      must be equal; the term at k must strictly follow its cursor value
 *      (and be non-null). Positions whose cursor value is NULL impose
 *      nothing: NULLS LAST means a row non-null-at-k already sorts after
 *      every row NULL-at-an-earlier-position.
 *
 *   B. The trailing NULL group — eligible whenever some term t* can be NULL:
 *      every nullable term up to and including the first nullable one must
 *      be NULL, and the remaining non-nullable PK tail walks
 *      lexicographically past the cursor (equal prefix + strict inequality).
 *      This disjunct is what lets a cursor sitting on the LAST non-null row
 *      continue into the unassociated rows; when the cursor itself is
 *      already on NULL, only the PK-tail walk remains reachable.
 *
 * Cursor values are coerced to each term's column type before binding.
 */
export function keysetWhere(terms: OrderTerm[], cursorValues: ReadonlyArray<unknown>): SQL {
  const coerced = terms.map((t, i) =>
    t.column && cursorValues[i] != null ? castFilterValue(String(cursorValues[i]), t.column) : cursorValues[i]);
  const isNullable = (t: OrderTerm) =>
    t.isRelationTerm || (t.column != null && !t.column.notNull);
  const disjuncts: SQL[] = [];

  // Region A: non-null lexicographic chain.
  for (let k = 0; k < terms.length; k++) {
    if (coerced[k] == null) { continue; }
    const parts: SQL[] = [];
    for (let i = 0; i < k; i++) {
      if (coerced[i] == null) { continue; } // NULLS LAST, see doc
      parts.push(eq(terms[i]!.expr, coerced[i]));
    }
    const strict: SQL = terms[k]!.order === 'asc'
      ? gt(terms[k]!.expr, coerced[k])
      : lt(terms[k]!.expr, coerced[k]);
    disjuncts.push(parts.length === 0 ? strict : and(...parts, strict)!);
  }

  // Region B: trailing NULL group. Boundary = first nullable term index;
  // every nullable term up to and including it must be IS NULL. (When there
  // are several nullable terms in a row the boundary is simply the earliest
  // — after it, ordering resumes with the non-nullable PK tail.)
  const firstNullable = terms.findIndex(isNullable);
  if (firstNullable >= 0) {
    const locks: SQL[] = [];
    for (let i = 0; i <= firstNullable; i++) {
      if (isNullable(terms[i]!)) { locks.push(isNull(terms[i]!.expr)); }
    }
    // If the cursor's value at the boundary was non-null we are ENTERING the
    // group (no PK prefix constraint yet); the PK-tail chain covers every
    // follower in the group. If it was null, equal-prefix semantics over the
    // non-nullable tail are unchanged.
    for (let k = firstNullable + 1; k < terms.length; k++) {
      const parts: SQL[] = [...locks];
      for (let i = firstNullable + 1; i < k; i++) {
        parts.push(eq(terms[i]!.expr, coerced[i]));
      }
      const strict: SQL = terms[k]!.order === 'asc'
        ? gt(terms[k]!.expr, coerced[k])
        : lt(terms[k]!.expr, coerced[k]);
      disjuncts.push(and(...parts, strict)!);
    }
    // No PK tail at all (e.g. composite-less relation sort without a PK —
    // PK is always appended, so this is defensive): the NULL locks alone
    // describe the whole group.
    if (firstNullable + 1 >= terms.length) {
      disjuncts.push(locks.length === 1 ? locks[0]! : and(...locks)!);
    }
  }

  if (disjuncts.length === 0) {
    return sql`1 = 0`;
  }
  return disjuncts.length === 1 ? disjuncts[0]! : (or(...disjuncts) ?? disjuncts[0]!);
}

// ---------------------------------------------------------------------------
// Expansion — one batched query per relation, no matter the page size.
// ---------------------------------------------------------------------------

export interface ExpansionPlan {
  relation: ResolvedRelation;
  projection: Record<string, any>;
}

const MAX_EXPAND_BATCH = 5000;

export interface ExpansionResult {
  /** to-one: relation name → (fk/pk value → related row). */
  toOne: Map<string, Map<unknown, any>>;
  /** to-many: relation name → (parent PK value → child rows). */
  toMany: Map<string, Map<unknown, any[]>>;
}

export async function executeExpansions(
  db: any,
  plans: ExpansionPlan[],
  baseRows: any[],
  baseTable: any,
  baseCfg: TableConfig,
): Promise<ExpansionResult> {
  const toOne = new Map<string, Map<unknown, any>>();
  const toMany = new Map<string, Map<unknown, any[]>>();
  const basePk = pkColumns(baseCfg);

  for (const plan of plans) {
    const { relation } = plan;
    const name = relation.def.name;
    // Projections MUST reference drizzle's own column objects (table[jsKey]),
    // not the cfg introspection entries — the latter are the same columns by
    // SQL name but drizzle's select builder resolves table ownership from
    // object identity, which breaks on cfg-sourced refs.
    const resolvedProjection = resolveProjection(plan.projection, relation.targetTable);

    if (relation.cardinality === 'to-one') {
      const map = new Map<unknown, any>();
      toOne.set(name, map);
      if (relation.fkOn === 'source') {
        const fkVals = uniqueNonNull(baseRows.map((r) => readBySqlOrJs(r, relation.fkSqlName, [baseTable, relation.targetTable])));
        if (fkVals.length === 0) { continue; }
        const targetPk = relation.parentPk[0]!;
        const rows = await fetchIn(
          db, relation.targetTable, resolvedProjection, targetPk.name, fkVals, relation.targetCfg,
        );
        for (const row of rows) { map.set(readBySqlOrJs(row, targetPk.name, [relation.targetTable]), row); }
      } else {
        const pkVals = uniqueNonNull(baseRows.map((r) => readBySqlOrJs(r, basePk[0]!.name, [baseTable])));
        if (pkVals.length === 0) { continue; }
        const rows = await fetchIn(
          db, relation.targetTable, resolvedProjection, relation.fkSqlName, pkVals, relation.targetCfg,
        );
        for (const row of rows) { map.set(readBySqlOrJs(row, relation.fkSqlName, [relation.targetTable]), row); }
      }
      continue;
    }

    const buckets = new Map<unknown, any[]>();
    toMany.set(name, buckets);
    for (const row of baseRows) { buckets.set(readBySqlOrJs(row, basePk[0]!.name, [baseTable]), []); }
    const pkVals = uniqueNonNull(baseRows.map((r) => readBySqlOrJs(r, basePk[0]!.name, [baseTable])));
    if (pkVals.length === 0) { continue; }

    const child = relation.childTable!;
    const conds: SQL[] = [inArray(findColumnBySqlName(child, relation.fkSqlName), pkVals)];
    const childLive = liveRowsPredicate(child, relation.childCfg!);
    if (childLive) { conds.push(childLive); }
    let query = db.select(resolvedProjection).from(child).where(and(...conds)).limit(MAX_EXPAND_BATCH) as any;
    const childPk = pkColumns(relation.childCfg!)[0];
    if (childPk) { query = query.orderBy(asc(findColumnBySqlName(child, childPk.name))); }
    const rows: any[] = await query;
    for (const row of rows) {
      buckets.get(readBySqlOrJs(row, relation.fkSqlName, [child]))?.push(row);
    }
  }

  return { toOne, toMany };
}

/**
 * Re-key a projection of cfg column objects to the drizzle column instances
 * actually attached to `table`. Callers build projections from
 * `getTableConfig()` output (handy metadata) but drizzle's builder binds
 * table ownership by object identity — cfg-sourced refs can render NULL
 * selections. The replacement is keyed on the SQL column name.
 */
function resolveProjection(
  projection: Record<string, any>,
  table: any,
): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [key, val] of Object.entries(projection)) {
    const sqlName: string | undefined = val?.name;
    const liveCol = sqlName ? findColumnBySqlName(table, sqlName) : undefined;
    out[key] = liveCol ?? val;
  }
  return out;
}

async function fetchIn(
  db: any,
  table: any,
  projection: Record<string, any>,
  keySqlName: string,
  values: unknown[],
  cfg: TableConfig,
): Promise<any[]> {
  const conds: SQL[] = [inArray(findColumnBySqlName(table, keySqlName), values)];
  const live = liveRowsPredicate(table, cfg);
  if (live) { conds.push(live); }
  return db.select(projection).from(table).where(and(...conds)).limit(MAX_EXPAND_BATCH);
}

function uniqueNonNull(values: ReadonlyArray<unknown>): unknown[] {
  const seen = new Set<unknown>();
  const out: unknown[] = [];
  for (const v of values) {
    if (v == null || seen.has(v)) { continue; }
    seen.add(v);
    out.push(v);
  }
  return out;
}

/**
 * Read a SQL-named field from a response row, accepting both wire shapes:
 * rows built with sqlKeyedProjection are keyed by SQL name (`user_id`),
 * while drizzle's default select keys rows by the JS field (`userId`).
 * When `tables` is supplied, JS-key lookups are resolved through each one;
 * otherwise only the SQL key is tried.
 */
function readBySqlOrJs(row: any, sqlName: string, tables: ReadonlyArray<any>): unknown {
  if (row != null && sqlName in row) { return row[sqlName]; }
  for (const table of tables) {
    const js = jsFieldForColumn(table, sqlName);
    if (js !== sqlName && js in row) { return row[js]; }
  }
  return row?.[sqlName];
}

/** Attach `_relations: { [name]: row | row[] | null }` to each base row. */
export function mergeExpansions(
  baseRows: any[],
  baseTable: any,
  baseCfg: TableConfig,
  result: ExpansionResult,
  plans: ExpansionPlan[],
): any[] {
  const basePk = pkColumns(baseCfg);
  return baseRows.map((row) => {
    const embedded: Record<string, any> = {};
    for (const plan of plans) {
      const name = plan.relation.def.name;
      if (plan.relation.cardinality === 'to-one') {
        const map = result.toOne.get(name);
        const key = plan.relation.fkOn === 'source'
          ? readBySqlOrJs(row, plan.relation.fkSqlName, [baseTable, plan.relation.targetTable])
          : readBySqlOrJs(row, basePk[0]!.name, [baseTable]);
        embedded[name] = map && key != null && map.has(key) ? map.get(key) : null;
      } else {
        embedded[name] =
          result.toMany.get(name)?.get(readBySqlOrJs(row, basePk[0]!.name, [baseTable])) ?? [];
      }
    }
    return { ...row, _relations: embedded };
  });
}

