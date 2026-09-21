/**
 * HTTP-level tests for the single-layer relation query surface, mounted
 * exactly the way production mounts it (express + dualModeEndpoints)
 * against an embedded PGlite GameDatabase. The engine's SQL is covered by
 * relation-query.test.ts; this file proves the wiring:
 *
 *   - relation filter / sort / expand through the real GET /:resource route
 *   - x-next-cursor keyset pagination headers
 *   - validation errors (400/404) arriving as HTTP responses
 *   - the parent-scoped /relations/:name route scope + second-hop rejection
 *   - target-resource RBAC: a `list: 'deny'` policy on the target makes
 *     relation filters/sorts/expands 403
 */
import assert from 'node:assert';
import { describe, it, before, after } from 'node:test';
import type { Server } from 'node:http';
import express from 'express';
import { GameDatabase } from '@colyseus/database';
import type { RelationDefinition } from '@colyseus/database';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'relation-http-secret';
const { admin } = await import('../src-backend/index.ts');

let db: GameDatabase;
let server: Server;
let origin: string;
let tables: Record<string, any>;
let orgs: any;
let staff: any;
let payslips: any;

before(async () => {
  db = new GameDatabase({
    dialect: 'pglite',
    connectionString: 'pglite://:memory:',
    // auto so the RBAC roles table (read by moderation.getRole) exists for
    // the policy-deny mount below; custom tables are created manually.
  } as any);
  await db.boot();

  const { pgTable: table, text, integer, timestamp } = await import('drizzle-orm/pg-core');
  orgs = table('relhttp_orgs', {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    deletedAt: timestamp('deleted_at'),
  });
  staff = table('relhttp_staff', {
    id: text('id').primaryKey(),
    orgId: text('org_id'),
    name: text('name').notNull(),
  });
  payslips = table('relhttp_payslips', {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull(),
    amount: integer('amount').notNull(),
    deletedAt: timestamp('deleted_at'),
  });

  await (db as any).rawClient.exec(`
    create table relhttp_orgs (id text primary key, name text not null, deleted_at timestamptz);
    create table relhttp_staff (id text primary key, org_id text, name text not null);
    create table relhttp_payslips (id text primary key, org_id text not null, amount integer not null, deleted_at timestamptz);
  `);

  tables = {
    ...(db as any).tables,
    relOrgs: orgs,
    relStaff: staff,
    relPayslips: payslips,
  };
  const relations: Record<string, RelationDefinition[]> = {
    relOrgs: [
      { name: 'staff', target: 'relStaff', kind: 'many', fk: 'orgId' },
      { name: 'payslips', target: 'relPayslips', kind: 'many', fk: 'orgId' },
    ],
    relStaff: [
      { name: 'org', target: 'relOrgs', kind: 'one', fk: 'orgId' },
    ],
  };
  (db as any).relations = { ...(db as any).relations, ...relations };

  await db.drizzle.insert(orgs).values([
    { id: 'o1', name: 'Acme' },
    { id: 'o2', name: 'Beta' },
    { id: 'o3', name: 'Ghost', deletedAt: new Date('2026-01-01') },
  ]);
  await db.drizzle.insert(staff).values([
    { id: 's1', orgId: 'o1', name: 'Alice' },
    { id: 's2', orgId: 'o1', name: 'Aaron' },
    { id: 's3', orgId: 'o2', name: 'Bob' },
    { id: 's4', orgId: null, name: 'Nora' },
    { id: 's5', orgId: 'o3', name: 'Gail' },
  ]);
  await db.drizzle.insert(payslips).values([
    { id: 'p1', orgId: 'o1', amount: 100 },
    { id: 'p2', orgId: 'o1', amount: 250 },
    { id: 'p3', orgId: 'o2', amount: 50 },
    { id: 'p4', orgId: 'o3', amount: 999, deletedAt: new Date('2026-02-01') },
  ]);

  const app = express();
  app.use(express.json());
  app.use(admin({
    database: db,
    tables,
    enforceRbac: false,
    logger: null,
  } as any));
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const { port } = server.address() as { port: number };
  origin = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  await db?.shutdown();
});

async function get(path: string) {
  return fetch(`${origin}/admin-api${path}`);
}

describe('GET /:resource relation query (HTTP)', () => {
  it('filters by a to-many field without duplicating base rows', async () => {
    const res = await get('/relOrgs?payslips.amount_gte=150');
    assert.strictEqual(res.status, 200);
    const rows = await res.json() as any[];
    assert.deepStrictEqual(rows.map((r) => r.id), ['o1']); // p2=250; p4 soft-deleted
  });

  it('sorts by a to-one field; unassociated rows sort last', async () => {
    const res = await get('/relStaff?_sort=org.name&_order=asc');
    assert.strictEqual(res.status, 200);
    const rows = await res.json() as any[];
    assert.deepStrictEqual(rows.map((r) => r.id), ['s1', 's2', 's3', 's4', 's5']);
  });

  it('embeds relations under _relations with soft-delete applied', async () => {
    const res = await get('/relOrgs?_expand=payslips,staff');
    assert.strictEqual(res.status, 200);
    const rows = await res.json() as any[];
    const o1 = rows.find((r) => r.id === 'o1')!;
    assert.deepStrictEqual(o1._relations.payslips.map((p: any) => p.id), ['p1', 'p2']);
    assert.deepStrictEqual(o1._relations.staff.map((p: any) => p.id), ['s1', 's2']);
    assert.strictEqual(rows.find((r) => r.id === 'o3'), undefined); // soft-deleted base
  });

  it('walks stable cursors and emits x-next-cursor', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 10; i++) {
      const res = await get(`/relOrgs?_limit=1${cursor ? `&_cursor=${encodeURIComponent(cursor)}` : ''}`);
      assert.strictEqual(res.status, 200);
      const rows = await res.json() as any[];
      seen.push(...rows.map((r) => r.id));
      cursor = res.headers.get('x-next-cursor');
      if (!cursor) { break; }
    }
    assert.deepStrictEqual(seen, ['o1', 'o2']); // o3 is soft-deleted
  });

  it('400s on an unknown relation field and 404 on unknown relation', async () => {
    const badField = await get('/relOrgs?staff.bogus=x');
    assert.strictEqual(badField.status, 400);
    assert.match(await badField.text(), /no column 'bogus'/);
    const badRel = await get('/relOrgs?nope.id=x');
    assert.strictEqual(badRel.status, 404);
  });
});

describe('GET /:resource/:id/relations/:name (HTTP)', () => {
  it('lists children scoped to the parent, honoring soft delete + filters', async () => {
    const res = await get('/relOrgs/o1/relations/payslips?amount_gte=150');
    assert.strictEqual(res.status, 200);
    const rows = await res.json() as any[];
    assert.deepStrictEqual(rows.map((r) => r.id), ['p2']);
    assert.strictEqual(res.headers.get('x-total-count'), '1');
  });

  it('returns 404 for an unknown relation and an unknown source', async () => {
    assert.strictEqual((await get('/relOrgs/o1/relations/ghost')).status, 404);
    assert.strictEqual((await get('/relNope/o1/relations/staff')).status, 404);
  });

  it('refuses second-hop dotted keys on the parent-scoped list', async () => {
    const res = await get('/relOrgs/o1/relations/payslips?org.name=x');
    assert.strictEqual(res.status, 400);
  });

  it('to-one relation returns at most one row with total = rows.length', async () => {
    const res = await get('/relStaff/s1/relations/org');
    assert.strictEqual(res.status, 200);
    const rows = await res.json() as any[];
    assert.deepStrictEqual(rows.map((r) => r.id), ['o1']);
    assert.strictEqual(res.headers.get('x-total-count'), '1');
  });
});

describe('relation target RBAC (HTTP)', () => {
  let restricted: Server;
  let restrictedOrigin: string;
  before(async () => {
    const app = express();
    app.use(express.json());
    // Dev X-User-Id header auth is on by default (NODE_ENV !== production).
    app.use(admin({
      database: db,
      tables,
      allowDevHeader: true,
      logger: null,
      resources: {
        relPayslips: {
          __tableName: 'relhttp_payslips',
          policies: { list: 'deny', read: 'deny' },
        } as any,
      },
    } as any));
    restricted = await new Promise<Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    const { port } = restricted.address() as { port: number };
    restrictedOrigin = `http://127.0.0.1:${port}`;
  });
  after(async () => {
    await new Promise<void>((resolve) => restricted?.close(() => resolve()));
  });

  it('403s relation filters/sorts that touch a denied target', async () => {
    // Base list still works (relOrgs isn't denied)...
    const base = await fetch(`${restrictedOrigin}/admin-api/relOrgs`, {
      headers: { 'X-User-Id': 'u-admin' },
    });
    assert.strictEqual(base.status, 200);
    // ...but crossing into the denied target does not.
    const filtered = await fetch(`${restrictedOrigin}/admin-api/relOrgs?payslips.amount_gt=0`, {
      headers: { 'X-User-Id': 'u-admin' },
    });
    assert.strictEqual(filtered.status, 403);
    const sorted = await fetch(`${restrictedOrigin}/admin-api/relOrgs?_sort=payslips.amount`, {
      headers: { 'X-User-Id': 'u-admin' },
    });
    assert.strictEqual(sorted.status, 403);
  });

  it('silently drops denied expansions instead of failing the base list', async () => {
    const res = await fetch(`${restrictedOrigin}/admin-api/relOrgs?_expand=payslips,staff`, {
      headers: { 'X-User-Id': 'u-admin' },
    });
    assert.strictEqual(res.status, 200);
    const rows = await res.json() as any[];
    // staff is allowed → present; payslips denied → omitted, base intact.
    assert.ok(Array.isArray(rows[0]._relations.staff));
    assert.strictEqual(rows[0]._relations.payslips, undefined);
  });
});

describe('per-row actions share the live-row rule (HTTP)', () => {
  let actionServer: Server;
  let actionOrigin: string;
  const seen: any[] = [];

  before(async () => {
    const app = express();
    app.use(express.json());
    app.use(admin({
      database: db,
      tables,
      enforceRbac: false,
      logger: null,
      resources: {
        relPayslips: {
          __tableName: 'relhttp_payslips',
          actions: [{
            name: 'echo',
            label: 'Echo',
            perRow: true,
            handler: async (row: any) => { seen.push(row); return row?.id; },
          }],
        } as any,
      },
    } as any));
    actionServer = await new Promise<Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    const { port } = actionServer.address() as { port: number };
    actionOrigin = `http://127.0.0.1:${port}`;
  });
  after(async () => {
    await new Promise<void>((resolve) => actionServer?.close(() => resolve()));
  });

  it('runs against a live row and 404s against a soft-deleted row', async () => {
    const live = await fetch(`${actionOrigin}/admin-api/relPayslips/_action/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'p1' }),
    });
    assert.strictEqual(live.status, 200);
    assert.deepStrictEqual(await live.json(), { ok: true, result: 'p1' });

    // p4 is tombstoned (deleted_at set) — the action lookup applies the SAME
    // live-row predicate list/relation reads use, so it answers 404 instead
    // of handing a deleted row to the handler.
    const tombstoned = await fetch(`${actionOrigin}/admin-api/relPayslips/_action/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'p4' }),
    });
    assert.strictEqual(tombstoned.status, 404);
    assert.strictEqual(seen.some((r) => r.id === 'p4'), false);

    const missing = await fetch(`${actionOrigin}/admin-api/relPayslips/_action/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'nope' }),
    });
    assert.strictEqual(missing.status, 404);
  });

  it('requires an id for a per-row action', async () => {
    const res = await fetch(`${actionOrigin}/admin-api/relPayslips/_action/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.strictEqual(res.status, 400);
  });
});
