/**
 * Pure unit tests for the single-hop relation query machinery that does
 * NOT need a database: cursor codec, keyset WHERE, soft-delete detection,
 * and request→plan validation. SQL-backed behavior lives in
 * `relation-query.integration.test.ts`.
 */
import assert from 'assert';
import { describe, it } from 'node:test';
import { integer, pgTable, text } from 'drizzle-orm/pg-core';
import {
  buildKeysetWhere, castCursorValue, decodeCursor, encodeCursor,
  resolveRelationPlan, softDeleteCondition,
} from '../src-backend/catalog/relation-query.ts';

const col = (name: string, extra: Record<string, any> = {}) =>
  ({ name, primary: false, notNull: false, dataType: 'string', ...extra });

const tableLike = (sqlName: string, columns: any[]) => {
  const t: any = { [Symbol.for('drizzle:Name')]: sqlName };
  for (const c of columns) { t[c.name] = c; }
  return t;
};

describe('cursor codec', () => {
  it('round-trips a tuple of primitive values', () => {
    const tuple = ['ann', 42, true, null];
    const cursor = encodeCursor(tuple);
    const decoded = decodeCursor(cursor, tuple.length);
    assert.ok(decoded.ok);
    assert.deepStrictEqual(decoded.ok ? decoded.values : [], tuple);
  });

  it('serializes Dates as ISO strings', () => {
    const d = new Date('2026-01-02T03:04:05.000Z');
    const cursor = encodeCursor([d]);
    const decoded = decodeCursor(cursor, 1);
    assert.ok(decoded.ok);
    assert.strictEqual(decoded.ok ? decoded.values[0] : null, '2026-01-02T03:04:05.000Z');
  });

  it('rejects garbage and arity mismatches', () => {
    assert.strictEqual(decodeCursor('%%%notbase64%%%', 1).ok, false);
    const good = encodeCursor(['a', 'b']);
    const wrong = decodeCursor(good, 3);
    assert.ok(!wrong.ok);
    assert.match(wrong.ok ? '' : wrong.error, /arity/);
  });

  it('casts ISO strings back to Date/timestamp values per column type', () => {
    const iso = '2026-01-02T03:04:05.000Z';
    const dateCol = col('created_at', { dataType: 'date', getSQLType: () => 'timestamp' });
    const v = castCursorValue(iso, dateCol);
    assert.ok(v instanceof Date);

    const intTs = col('ts', { dataType: 'object date', getSQLType: () => 'integer' });
    assert.strictEqual(castCursorValue(iso, intTs), Math.floor(Date.parse(iso) / 1000));
    assert.strictEqual(castCursorValue('7', col('n', { dataType: 'number' })), 7);
  });
});

describe('soft-delete detection', () => {
  it('is undefined without a known soft-delete column', () => {
    assert.strictEqual(softDeleteCondition({ name: 't', columns: [col('id')] }), undefined);
  });
  it('detects deleted_at, deletedAt, is_deleted and isDeleted', () => {
    for (const name of ['deleted_at', 'deletedAt', 'is_deleted', 'isDeleted']) {
      assert.ok(softDeleteCondition({ name: 't', columns: [col(name)] }), name);
    }
  });
});

/**
 * Serialize a drizzle SQL fragment WITHOUT a DB session. drizzle's
 * `toQuery()` with no config inlines column-bound params; we pass
 * `inlineParams: true` + dialect-agnostic escape helpers so the generated
 * text is stable across pg/sqlite and assertions stay simple.
 */
function render(query: ReturnType<typeof buildKeysetWhere>): { sql: string; params: unknown[] } {
  return query.toQuery({
    inlineParams: false,
    escapeName: (n: string) => `"${n}"`,
    escapeParam: (i: number) => `$${i + 1}`,
    paramStartIndex: { value: 0 },
  } as any);
}

describe('keyset WHERE', () => {
  // Real drizzle columns — the keyset predicate embeds column refs and
  // bound params, which only serialize through drizzle's query builder
  // when the column carries its table metadata.
  const t = pgTable('things', { id: text('id').primaryKey(), score: integer('score') });

  it('emits one OR branch per sort key (n keys → n branches)', () => {
    const built = render(buildKeysetWhere(
      [{ col: t.score as any, order: 'desc' },
       { col: t.id as any, order: 'asc' }],
      [10, 'a'],
    ));
    // The lexicographic chain ORs two branches: score < 10, or score
    // null-aware-equal 10 AND id > 'a'. Parameters bind in that order.
    assert.match(built.sql, /\bor\b/i);
    assert.deepStrictEqual(built.params, [10, 10, 'a']);
  });

  it('inverts the comparison for DESC keys and adds IS NULL tail handling', () => {
    const built = render(buildKeysetWhere([{ col: t.score as any, order: 'desc' }], [10]));
    // DESC strict-after: score < 10 OR score IS NULL (NULLs last).
    assert.match(built.sql, /<|is null/i);
  });
});

describe('resolveRelationPlan', () => {
  const usersTable = tableLike('colyseus_users', [col('id', { primary: true })]);
  const guildsTable = tableLike('guilds', [col('id', { primary: true }), col('name')]);
  const membersTable = tableLike('guild_members', [
    col('id', { primary: true }), col('guild_id'), col('nickname'),
  ]);
  const tables: Record<string, any> = { users: usersTable, guilds: guildsTable, guildMembers: membersTable };
  const cfgOf = (t: any) => ({
    name: t[Symbol.for('drizzle:Name')],
    columns: Object.getOwnPropertyNames(t).map((k) => t[k]).filter((c) => c && typeof c === 'object' && typeof c.name === 'string'),
  });
  const relations = [
    { name: 'memberRows', target: 'guildMembers', kind: 'one' as const, fk: 'guild_id' },
    { name: 'membership', target: 'guildMembers', kind: 'many' as const, fk: 'guild_id' },
  ];
  // guildMembers.guild_id points back at guilds — declare it on the members
  // table for fk-on-target checks.
  (membersTable as any).guild_id = col('guild_id');

  const base = (query: Record<string, any>, rels = relations) =>
    resolveRelationPlan({
      query,
      relations: rels,
      sourceTable: guildsTable,
      sourceCfg: cfgOf(guildsTable),
      tables,
      getTableConfig: cfgOf,
    });

  it('returns null for a relation-free request', () => {
    assert.strictEqual(base({ _sort: 'id', name_like: 'x' }).plan, null);
  });

  it('resolves a dotted filter against the declared target column', () => {
    const { plan, error } = base({ 'membership.nickname_like': 'ann' });
    assert.strictEqual(error, undefined);
    assert.strictEqual(plan!.relation.target, 'guildMembers');
    assert.strictEqual(plan!.filters.length, 1);
  });

  it('400s on an unknown relation name', () => {
    const r = base({ 'nope.name': 'x' });
    assert.ok(r.error && r.error.status === 400);
  });

  it('400s on an unknown target column', () => {
    const r = base({ 'memberRows.no_such_column': 'x' });
    assert.ok(r.error);
    assert.match(r.error!.message, /no column 'no_such_column'/);
  });

  it('400s when two different relations appear in one request', () => {
    const r = base({ 'memberRows.nickname': 'x', 'membership.nickname_like': 'y' });
    assert.ok(r.error);
    assert.match(r.error!.message, /only one relation/);
  });

  it('rejects multi-hop dotted columns', () => {
    const r = base({ 'membership.owner.name': 'x' });
    assert.ok(r.error);
    assert.match(r.error!.message, /unknown relation|multi-hop/);
  });

  it('parses related sort + expand', () => {
    const r = base({ _sort: 'membership.nickname', _order: 'DESC', _expand: 'membership' });
    assert.strictEqual(r.error, undefined);
    assert.strictEqual(r.plan!.sort?.order, 'desc');
    assert.strictEqual(r.plan!.sort?.field, 'nickname');
    assert.strictEqual(r.plan!.expand, true);
  });

  it('parses _null=true and forbids combining it with filters', () => {
    const onlyNull = base({ 'membership._null': 'true' });
    assert.strictEqual(onlyNull.plan!.nullOnly, true);
    const both = base({ 'membership._null': 'true', 'membership.nickname': 'ann' });
    assert.ok(both.error);
  });
});
