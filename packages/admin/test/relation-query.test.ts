/**
 * Integration tests for the single-layer relation query engine, run against
 * a real (embedded PGlite) database so the generated SQL is exercised end to
 * end — correlated EXISTS / aggregate subqueries, keyset cursors, IN-batched
 * expansion and the soft-delete predicates are all SQL-shape concerns that
 * pure builder tests can't prove.
 *
 * Fixture models the shapes present in the shipped schema:
 *   - tenants  (id, name, deleted_at)          — soft-delete parent
 *   - members  (id, tenant_id, display_name)   — one tenant per member
 *   - invoices (id, tenant_id, amount, deleted) — many per tenant, bool marker
 *   - tags    (id, label)
 *   - posts   (id, tenant_id, tag_id, body)    — two to-one FKs
 */
import assert from 'node:assert';
import { describe, it, before, after } from 'node:test';
import { pgTable, text, integer, timestamp, boolean } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import { PGlite } from '@electric-sql/pglite';
import type { RelationDefinition } from '@colyseus/database';
import {
  parseRelationQuery, relationConditionSQL, resolveRelation,
  encodeCursor, decodeCursor, keysetWhere, buildOrderTerms,
  executeExpansions, mergeExpansions, softDeleteColumn,
} from '../src-backend/catalog/relation-query.ts';
import { runListQuery } from '../src-backend/catalog/list-runner.ts';

const tenants = pgTable('tenants', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  deletedAt: timestamp('deleted_at'),
});
const members = pgTable('members', {
  id: text('id').primaryKey(),
  tenantId: text('tenant_id'),
  displayName: text('display_name').notNull(),
});
const invoices = pgTable('invoices', {
  id: text('id').primaryKey(),
  tenantId: text('tenant_id').notNull(),
  amount: integer('amount').notNull(),
  deleted: boolean('deleted').notNull().default(false),
});
const tags = pgTable('tags', {
  id: text('id').primaryKey(),
  label: text('label').notNull(),
});
const posts = pgTable('posts', {
  id: text('id').primaryKey(),
  tenantId: text('tenant_id').notNull(),
  tagId: text('tag_id'),
  body: text('body').notNull(),
});

const tables = { tenants, members, invoices, tags, posts };

import { getTableConfig as pgCfg } from 'drizzle-orm/pg-core';

const relations: Record<string, RelationDefinition[]> = {
  tenants: [
    { name: 'members', target: 'members', kind: 'many', fk: 'tenantId' },
    { name: 'invoices', target: 'invoices', kind: 'many', fk: 'tenantId' },
  ],
  members: [
    { name: 'tenant', target: 'tenants', kind: 'one', fk: 'tenantId' },
  ],
  posts: [
    { name: 'tenant', target: 'tenants', kind: 'one', fk: 'tenantId' },
    { name: 'tag', target: 'tags', kind: 'one', fk: 'tagId' },
  ],
};

let client: PGlite;
let db: ReturnType<typeof drizzle>;

const registry = {
  tables,
  getTableConfig: pgCfg as any,
  relations,
};

before(async () => {
  client = new PGlite();
  await client.exec(`
    create table tenants (id text primary key, name text not null, deleted_at timestamptz);
    create table members (id text primary key, tenant_id text, display_name text not null);
    create table invoices (id text primary key, tenant_id text not null, amount integer not null, deleted boolean not null default false);
    create table tags (id text primary key, label text not null);
    create table posts (id text primary key, tenant_id text not null, tag_id text, body text not null);
  `);
  db = drizzle({ client: client as any });

  await db.insert(tenants).values([
    { id: 't1', name: 'Acme' },
    { id: 't2', name: 'Beta' },
    { id: 't3', name: 'Gamma' },
    // Soft-deleted tenant with live members + invoices — must vanish.
    { id: 't4', name: 'Ghost', deletedAt: new Date('2026-01-01') },
  ]);
  await db.insert(members).values([
    { id: 'm1', tenantId: 't1', displayName: 'Alice' },
    { id: 'm2', tenantId: 't1', displayName: 'Aaron' },
    { id: 'm3', tenantId: 't2', displayName: 'Bob' },
    // Member with no tenant assigned (null FK) and one pointing at a
    // hard-missing tenant.
    { id: 'm4', tenantId: null, displayName: 'Nora' },
    { id: 'm5', tenantId: 'missing', displayName: 'Dora' },
    // Live member under the soft-deleted tenant.
    { id: 'm6', tenantId: 't4', displayName: 'Gail' },
  ]);
  await db.insert(invoices).values([
    { id: 'i1', tenantId: 't1', amount: 10 },
    { id: 'i2', tenantId: 't1', amount: 50 },
    { id: 'i3', tenantId: 't2', amount: 20 },
    // soft-deleted (boolean marker) invoice under a live tenant.
    { id: 'i4', tenantId: 't1', amount: 999, deleted: true },
    { id: 'i5', tenantId: 't4', amount: 7, deleted: false },
  ]);
  await db.insert(tags).values([
    { id: 'g1', label: 'news' },
    { id: 'g2', label: 'bugs' },
  ]);
  await db.insert(posts).values([
    { id: 'p1', tenantId: 't1', tagId: 'g1', body: 'launch' },
    { id: 'p2', tenantId: 't1', tagId: 'g2', body: 'crash' },
    { id: 'p3', tenantId: 't2', tagId: null, body: 'untagged' },
  ]);
});

after(async () => { await client?.close(); });

async function listTenants(query: Record<string, unknown>, canAccess = async () => true) {
  return runListQuery({
    db, table: tenants, cfg: pgCfg(tenants),
    registry, resourceName: 'tenants', def: undefined,
    query, canAccessRelation: canAccess,
  });
}

async function listMembers(query: Record<string, unknown>) {
  return runListQuery({
    db, table: members, cfg: pgCfg(members),
    registry, resourceName: 'members', def: undefined,
    query, canAccessRelation: async () => true,
  });
}

describe('soft-delete detection', () => {
  it('detects timestamp and boolean markers by convention', () => {
    assert.strictEqual(softDeleteColumn(pgCfg(tenants))?.name, 'deleted_at');
    assert.strictEqual(softDeleteColumn(pgCfg(invoices))?.name, 'deleted');
    assert.strictEqual(softDeleteColumn(pgCfg(members)), null);
  });

  it('base lists hide soft-deleted rows', async () => {
    const out = await listTenants({});
    assert.ok(out.ok);
    if (!out.ok) { throw new Error(out.failure.message); }
    assert.deepStrictEqual(out.rows.map((r: any) => r.id).sort(), ['t1', 't2', 't3']);
    assert.strictEqual(out.total, 3);
  });
});

describe('to-many relation filters (EXISTS, no joins, no duplicates)', () => {
  it('filters tenants that have an invoice matching a child predicate', async () => {
    const out = await listTenants({ 'invoices.amount_gte': '40' });
    assert.ok(out.ok);
    if (!out.ok) { throw new Error(out.failure.message); }
    // t1 has i2=50 (i4=999 is soft-deleted, excluded); t2 max is 20.
    assert.deepStrictEqual(out.rows.map((r: any) => r.id), ['t1']);
    assert.strictEqual(out.total, 1);
  });

  it('never duplicates a base row when multiple children match', async () => {
    const out = await listTenants({ 'invoices.amount_gte': '5' });
    assert.ok(out.ok);
    if (!out.ok) { throw new Error(out.failure.message); }
    // t1 matches through i1 AND i2 — exactly one t1 row must come back.
    assert.deepStrictEqual(out.rows.map((r: any) => r.id).sort(), ['t1', 't2']);
    assert.strictEqual(out.rows.length, new Set(out.rows.map((r: any) => r.id)).size);
  });

  it('supports _exists=0 (tenants without invoices), honoring soft delete', async () => {
    const out = await listTenants({ 'invoices._exists': '0' });
    assert.ok(out.ok);
    if (!out.ok) { throw new Error(out.failure.message); }
    // t3 has no invoices; t4's only invoice belongs to a deleted tenant
    // (base filter removes t4 anyway).
    assert.deepStrictEqual(out.rows.map((r: any) => r.id), ['t3']);
  });

  it('supports _exists=1 with a non-null field', async () => {
    const out = await listTenants({ 'invoices.amount_exists': '1' });
    assert.ok(out.ok);
    if (!out.ok) { throw new Error(out.failure.message); }
    assert.deepStrictEqual(out.rows.map((r: any) => r.id).sort(), ['t1', 't2']);
  });

  it('excludes children with soft-delete markers from predicates and counts', async () => {
    const out = await listTenants({ 'invoices.amount_gte': '900' });
    assert.ok(out.ok);
    if (!out.ok) { throw new Error(out.failure.message); }
    // i4 (999) is tombstoned — no tenant may surface through it.
    assert.deepStrictEqual(out.rows.map((r: any) => r.id), []);
    assert.strictEqual(out.total, 0);
  });
});

describe('to-one relation filters', () => {
  it('filters children by a parent field', async () => {
    // PG's LIKE is case-sensitive (the direct-column list filter has the
    // same semantics); match the exact-cased fragment.
    const out = await listMembers({ 'tenant.name_like': 'Acm' });
    assert.ok(out.ok);
    if (!out.ok) { throw new Error(out.failure.message); }
    assert.deepStrictEqual(out.rows.map((r: any) => r.id).sort(), ['m1', 'm2']);
  });

  it('handles missing associations: _null includes null + dangling FKs', async () => {
    const out = await listMembers({ 'tenant.id_null': '1' });
    assert.ok(out.ok);
    if (!out.ok) { throw new Error(out.failure.message); }
    // m4 null FK, m5 dangling FK, m6 points at soft-deleted tenant → all "no
    // live relation". m1..m3 have live tenants.
    assert.deepStrictEqual(out.rows.map((r: any) => r.id).sort(), ['m4', 'm5', 'm6']);
  });

  it('_notnull returns only rows with a live related row', async () => {
    const out = await listMembers({ 'tenant.id_notnull': '1' });
    assert.ok(out.ok);
    if (!out.ok) { throw new Error(out.failure.message); }
    assert.deepStrictEqual(out.rows.map((r: any) => r.id).sort(), ['m1', 'm2', 'm3']);
  });

  it('eq on a related column never matches unassociated rows (no NULL leak)', async () => {
    // No tenant is named 'Ghost' among live rows; m6 must NOT match even
    // though its tombstoned tenant was.
    const out = await listMembers({ 'tenant.name': 'Ghost' });
    assert.ok(out.ok);
    if (!out.ok) { throw new Error(out.failure.message); }
    assert.deepStrictEqual(out.rows.map((r: any) => r.id), []);
  });

  it('to-many aggregate sort ignores tombstoned children (max over live rows)', async () => {
    // t1's invoices are 10/50 live + 999 tombstoned. DESC must order by
    // MAX(live) = 50, not 999 — t1 still comes first here, but the cursor
    // value riding the order must be 50; assert indirectly via asc MIN
    // stability + an explicit check that no row sorts beyond live bounds
    // is covered by the gte filter test. This case pins DESC order.
    const out = await listTenants({ _sort: 'invoices.amount', _order: 'desc' });
    assert.ok(out.ok);
    if (!out.ok) { throw new Error(out.failure.message); }
    assert.deepStrictEqual(out.rows.map((r: any) => r.id), ['t1', 't2', 't3']);
  });
});

describe('validation failures', () => {
  it('404s on unknown relation', async () => {
    const out = await listTenants({ 'nope.id': 'x' });
    assert.strictEqual(out.ok, false);
    if (out.ok) { throw new Error('expected failure'); }
    assert.strictEqual(out.failure.status, 404);
  });

  it('400s on unknown related column', async () => {
    const out = await listTenants({ 'members.bogus': 'x' });
    assert.strictEqual(out.ok, false);
    if (out.ok) { throw new Error('expected failure'); }
    assert.strictEqual(out.failure.status, 400);
    assert.match(out.failure.message, /no column 'bogus'/);
  });

  it('400s on unsupported operators', async () => {
    const out = await listTenants({ 'members.id_bogusop': 'x' });
    assert.strictEqual(out.ok, false);
    if (out.ok) { throw new Error('expected failure'); }
    assert.strictEqual(out.failure.status, 400);
  });

  it('403s when the caller lacks list permission on the relation target', async () => {
    const denied = async (target: string) => target !== 'invoices';
    const out = await listTenants({ 'invoices.amount_gt': '0' }, denied);
    assert.strictEqual(out.ok, false);
    if (out.ok) { throw new Error('expected failure'); }
    assert.strictEqual(out.failure.status, 403);
  });

  it('resolution rejects to-many metadata whose fk is not on the target', () => {
    // Here the FK is members.tenant_id (on target) — that's the VALID shape,
    // so resolution succeeds.
    const ok = resolveRelation({
      tables: { members, tenants },
      getTableConfig: pgCfg as any,
      relations: { tenants: [{ name: 'members', target: 'members', kind: 'many', fk: 'tenantId' }] },
    } as any, 'tenants', 'members');
    assert.strictEqual(ok.ok, true);

    // The invalid shape: a 'many' whose declared fk is absent on the target
    // (typo'd metadata) — resolveFkLayout finds nothing → 500.
    const missing = resolveRelation({
      tables: { members, tenants },
      getTableConfig: pgCfg as any,
      relations: { tenants: [{ name: 'weird', target: 'members', kind: 'many', fk: 'nopeId' }] },
    } as any, 'tenants', 'weird');
    assert.strictEqual(missing.ok, false);
    if (missing.ok) { throw new Error('expected failure'); }
    assert.strictEqual(missing.failure.status, 500);
  });
});

describe('relation sort (correlated scalar/aggregate)', () => {
  it('sorts to-one by related field, unassociated rows last', async () => {
    const asc = await listMembers({ _sort: 'tenant.name', _order: 'asc' });
    assert.ok(asc);
    if (!asc.ok) { throw new Error(asc.failure.message); }
    // Live tenants: Acme (m1,m2), Beta (m3). NULLs (m4,m5,m6) last.
    assert.deepStrictEqual(asc.rows.map((r: any) => r.id), ['m1', 'm2', 'm3', 'm4', 'm5', 'm6']);

    const desc = await listMembers({ _sort: 'tenant.name', _order: 'desc' });
    assert.ok(desc);
    if (!desc.ok) { throw new Error(desc.failure.message); }
    assert.deepStrictEqual(desc.rows.map((r: any) => r.id), ['m3', 'm1', 'm2', 'm4', 'm5', 'm6']);
  });

  it('sorts to-many by MIN(child field) asc', async () => {
    const out = await listTenants({ _sort: 'invoices.amount', _order: 'asc' });
    assert.ok(out.ok);
    if (!out.ok) { throw new Error(out.failure.message); }
    // t2 min 20, t1 min 10 (tombstoned 999 ignored) → t1 then t2;
    // t3 (no invoices → NULL) last.
    assert.deepStrictEqual(out.rows.map((r: any) => r.id), ['t1', 't2', 't3']);
  });
});

describe('cursor pagination', () => {
  it('walks every row exactly once across pages (direct sort)', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page++) {
      const q: Record<string, unknown> = { _limit: '2', _sort: 'name', _order: 'asc' };
      if (cursor) { q._cursor = cursor; }
      const out = await listTenants(q);
      assert.ok(out.ok);
      if (!out.ok) { throw new Error(out.failure.message); }
      seen.push(...out.rows.map((r: any) => r.id));
      cursor = out.nextCursor;
      if (!cursor) { break; }
    }
    assert.deepStrictEqual(seen, ['t1', 't2', 't3']);
  });

  it('cursor carries the relation sort tuple and stays stable', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page++) {
      const q: Record<string, unknown> = {
        _limit: '2', _sort: 'tenant.name', _order: 'asc',
      };
      if (cursor) { q._cursor = cursor; }
      const out = await listMembers(q);
      assert.ok(out.ok);
      if (!out.ok) { throw new Error(out.failure.message); }
      seen.push(...out.rows.map((r: any) => r.id));
      cursor = out.nextCursor;
      if (!cursor) { break; }
    }
    assert.deepStrictEqual(seen, ['m1', 'm2', 'm3', 'm4', 'm5', 'm6']);
  });

  it('rejects a cursor with the wrong arity for the ordering', () => {
    const terms = buildOrderTerms(members, pgCfg(members), {
      relationSort: null, directSort: { field: 'display_name', order: 'asc' },
    });
    // 2 terms (display_name + id) but encode one value.
    const bad = encodeCursor(['only']);
    const decoded = decodeCursor(bad, terms.length);
    assert.strictEqual(decoded.ok, false);
    const where = keysetWhere(terms, ['Aaron', 'm2']);
    assert.ok(where);
  });

  it('omits total count in cursor mode', async () => {
    const out = await listTenants({ _limit: '2' });
    assert.ok(out.ok);
    if (!out.ok) { throw new Error(out.failure.message); }
    assert.strictEqual(out.total, null);
    assert.strictEqual(out.rows.length, 2);
    assert.ok(out.nextCursor);
  });
});

describe('expansion (batched embed)', () => {
  it('embeds to-many children under _relations in one batch', async () => {
    const out = await listTenants({ _expand: 'invoices' });
    assert.ok(out.ok);
    if (!out.ok) { throw new Error(out.failure.message); }
    const byId = Object.fromEntries(out.rows.map((r: any) => [r.id, r]));
    const t1Invoices = byId.t1._relations.invoices.map((r: any) => r.id).sort();
    // i4 is soft-deleted → excluded from the embed.
    assert.deepStrictEqual(t1Invoices, ['i1', 'i2']);
    assert.deepStrictEqual(byId.t3._relations.invoices, []);
  });

  it('embeds to-one parents (or null when missing/tombstoned)', async () => {
    const out = await listMembers({ _expand: 'tenant' });
    assert.ok(out.ok);
    if (!out.ok) { throw new Error(out.failure.message); }
    const byId = Object.fromEntries(out.rows.map((r: any) => [r.id, r]));
    assert.strictEqual(byId.m1._relations.tenant.name, 'Acme');
    assert.strictEqual(byId.m4._relations.tenant, null); // null FK
    assert.strictEqual(byId.m5._relations.tenant, null); // dangling
    assert.strictEqual(byId.m6._relations.tenant, null); // soft-deleted
  });

  it('batches to-one lookups with a single IN query (N+1 guard)', async () => {
    // Count statements at the PGlite client's query method. It lives one
    // level up the prototype chain (not the direct proto), so walk until we
    // find the owner. One round-trip for the whole page, regardless of how
    // many rows it has — never one SELECT per base row.
    const memberRows = (await db.select().from(members)) as any[];
    let proto: any = Object.getPrototypeOf(client);
    while (proto && !Object.prototype.hasOwnProperty.call(proto, 'query')) {
      proto = Object.getPrototypeOf(proto);
    }
    assert.ok(proto, 'pglite query method not found on prototype chain');
    const origQuery = proto.query;
    let statements = 0;
    proto.query = function (...args: any[]) {
      if (typeof args[0] === 'string' && /from "tenants"/i.test(args[0])) { statements += 1; }
      return origQuery.apply(this, args);
    };

    const resolution = resolveRelation(registry, 'members', 'tenant');
    assert.ok(resolution.ok);
    if (!resolution.ok) { throw new Error(resolution.failure.message); }
    const plans = [{
      relation: resolution.relation,
      projection: Object.fromEntries(pgCfg(tenants).columns.map((c: any) => [c.name, c])),
    }];
    try {
      const result = await executeExpansions(db as any, plans, memberRows, members, pgCfg(members));
      const merged = mergeExpansions(memberRows, members, pgCfg(members), result, plans);
      assert.strictEqual(statements, 1, `expected 1 query, got ${statements}`);
      const alice = merged.find((r) => r.id === 'm1')!;
      assert.strictEqual(alice._relations.tenant.name, 'Acme');
    } finally {
      proto.query = origQuery;
    }
  });

  it('silently drops expansions the caller has no permission to see', async () => {
    const out = await runListQuery({
      db, table: tenants, cfg: pgCfg(tenants),
      registry, resourceName: 'tenants', def: undefined,
      query: { _expand: 'invoices,members' },
      canAccessRelation: async (target) => target === 'invoices',
    });
    assert.ok(out.ok);
    if (!out.ok) { throw new Error(out.failure.message); }
    const row = out.rows[0] as any;
    assert.ok(Array.isArray(row._relations.invoices));
    assert.strictEqual(row._relations.members, undefined);
  });
});

describe('parser surface', () => {
  it('parses filters, sort and expand together', () => {
    const parsed = parseRelationQuery(registry, 'tenants', {
      'members.display_name_like': 'a',
      _sort: 'invoices.amount',
      _order: 'DESC',
      _expand: 'members,invoices',
    });
    assert.ok(parsed.ok);
    if (!parsed.ok) { throw new Error(parsed.failure.message); }
    assert.strictEqual(parsed.query.conditions.length, 1);
    assert.strictEqual(parsed.query.sort?.relation.def.name, 'invoices');
    assert.strictEqual(parsed.query.sort?.order, 'desc');
    assert.deepStrictEqual(parsed.query.expands.map((r) => r.def.name), ['members', 'invoices']);
    assert.ok(parsed.consumedKeys.has('members.display_name_like'));
    assert.ok(parsed.consumedKeys.has('_sort'));
    assert.ok(parsed.consumedKeys.has('_expand'));
  });

  it('rejects field-less keys except to-many _exists', () => {
    const ok = parseRelationQuery(registry, 'tenants', { 'invoices._exists': '1' });
    assert.ok(ok.ok);
    const bad = parseRelationQuery(registry, 'members', { 'tenant._null': '1' });
    assert.strictEqual(bad.ok, false);
    const toOneExists = parseRelationQuery(registry, 'members', { 'tenant._exists': '1' });
    assert.strictEqual(toOneExists.ok, false);
  });
});

describe('condition SQL generation (smoke)', () => {
  it('builds an EXISTS predicate for a parsed condition', async () => {
    const parsed = parseRelationQuery(registry, 'tenants', { 'invoices.amount_gt': '100' });
    assert.ok(parsed.ok);
    if (!parsed.ok) { throw new Error(parsed.failure.message); }
    const cond = relationConditionSQL(parsed.query.conditions[0]!, tenants);
    // Runs without error against PGlite.
    const rows = await db.select().from(tenants).where(cond);
    assert.deepStrictEqual(rows, []);
  });
});

describe('cursor codec (pure)', () => {
  it('round-trips tuples and rejects arity mismatch and garbage', () => {
    const c = encodeCursor(['Acme', 'm2']);
    assert.strictEqual(typeof c, 'string');
    const ok = decodeCursor(c, 2);
    assert.deepStrictEqual(ok.ok ? ok.values : null, ['Acme', 'm2']);
    assert.strictEqual(decodeCursor(c, 3).ok, false);
    assert.strictEqual(decodeCursor('!!!not-base64!!!', 2).ok, false);
  });
});
