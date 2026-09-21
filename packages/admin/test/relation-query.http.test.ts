/**
 * End-to-end HTTP tests for single-hop relation queries, driven through
 * the real `admin()` router (better-call) on an embedded PGlite database.
 *
 * Why HTTP-level on top of the executor integration tests:
 *   - the cursor contract lives in RESPONSE HEADERS (x-next-cursor,
 *     x-page-limit), so it can only be proven over the wire;
 *   - RBAC is enforced on the RELATION TARGET at the endpoint, so a
 *     403/404 for an unauthorized relation has to go through guard();
 *   - custom action payloads must pass the same guard + row lookup
 *     (including soft-delete hiding) as the CRUD endpoints.
 *
 * Uses built-in catalog tables (users / userNotes) + one extra custom
 * table declared through GameDatabase's relations option, so no schema
 * migration plumbing is needed.
 */
import assert from 'node:assert';
import { describe, it, before, after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import express from 'express';
import { GameDatabase } from '@colyseus/database';
import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'relq-http-test-secret';

// Custom table with a soft-delete column — exercises action-row hiding and
// the list endpoint's own soft-delete filter over real HTTP.
const widgets = pgTable('test_widgets', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  ownerId: text('owner_id'),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});

const { admin, defineAdminResource } = await import('../src-backend/index.ts');

let db: GameDatabase;
let server: Server;
let base: string;
let dataDir: string;

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-relq-http-'));
  db = new GameDatabase({
    connectionString: 'pglite://',
    dialect: 'pglite',
  } as any);
  // Register the custom table + its relation on the instance. The custom
  // table isn't part of the framework SchemaSet so the auto-migrator
  // doesn't know about it — create it explicitly after boot.
  (db as any).tables = { ...(db as any).tables, widgets };
  db.relations.users = [
    ...(db.relations.users ?? []),
    { name: 'widgets', target: 'widgets', kind: 'many', fk: 'ownerId' },
  ];
  await db.boot();
  await db.drizzle.execute(
    // DDL mirrors the drizzle `widgets` table above.
    (await import('drizzle-orm')).sql.raw(
      `create table if not exists test_widgets (
         id text primary key, name text not null,
         owner_id text, deleted_at timestamptz
       )`,
    ),
  );

  // Seed directly through drizzle. DDL for the custom table runs via the
  // auto-migrator; built-in tables were created at boot too.
  await db.drizzle.insert((db as any).tables.users).values([
    { id: 'u1', email: 'ann@example.com' },
    { id: 'u2', email: 'bob@example.com' },
    { id: 'u3', email: 'cyd@example.com' },
  ]);
  // X-User-Id is a dev identity header — it authenticates but doesn't grant
  // a role. Give u1 the admin role so guard() (incl. the new action gate)
  // allows the panel operations these tests exercise.
  await db.moderation.setRole('u1', 'admin');
  await db.drizzle.insert(widgets).values([
    { id: 'w1', name: 'Alpha', ownerId: 'u1' },
    { id: 'w2', name: 'Beta', ownerId: 'u1' },
    { id: 'wdead', name: 'Dead', ownerId: 'u2', deletedAt: new Date() },
  ]);

  const app = express();
  app.use(express.json());
  app.use(admin({
    database: db,
    tables: { ...(db as any).tables, widgets },
    logger: null,
    // Tests run with the dev X-User-Id header for auth; RBAC behavior is
    // asserted via resource policies below rather than real sessions.
    resources: {
      widgets: defineAdminResource(widgets, {
        label: 'Widgets',
        actions: [{
          name: 'ping',
          label: 'Ping',
          perRow: true,
          handler: async (row: any) => ({ seen: row?.name ?? null }),
        }],
      }),
    },
  }));
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = (server.address() as { port: number }).port;
  base = `http://127.0.0.1:${port}/admin-api`;
});

after(async () => {
  server?.close();
  await db.shutdown();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const authHeaders = (userId: string) => ({ 'X-User-Id': userId });

describe('GET /:resource — single-hop over HTTP', () => {
  it('filters by a related column and returns the parent rows once each', async () => {
    const res = await fetch(`${base}/users?widgets.name=Alpha`, { headers: authHeaders('u1') });
    assert.strictEqual(res.status, 200);
    const rows = await res.json();
    assert.deepStrictEqual(rows.map((r: any) => r.id), ['u1']);
  });

  it('ignores soft-deleted related rows when filtering', async () => {
    // wdead belongs to u2 but is soft-deleted — filtering by its name
    // must not surface u2.
    const res = await fetch(`${base}/users?widgets.name=Dead`, { headers: authHeaders('u1') });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(await res.json(), []);
  });

  it('400s on a second relation in one request', async () => {
    const res = await fetch(`${base}/users?widgets.name=Alpha&cloudSaves.slot=1`, {
      headers: authHeaders('u1'),
    });
    assert.strictEqual(res.status, 400);
  });

  it('400s on a multi-hop reference', async () => {
    const res = await fetch(`${base}/users?widgets.owner.name=ann`, { headers: authHeaders('u1') });
    assert.strictEqual(res.status, 400);
  });
});

describe('cursor pagination over HTTP', () => {
  it('returns x-next-cursor (empty string on the last page) and x-page-limit', async () => {
    const first = await fetch(`${base}/users?_limit=2`, { headers: authHeaders('u1') });
    assert.strictEqual(first.status, 200);
    const firstRows = await first.json();
    assert.strictEqual(firstRows.length, 2);
    const cursor = first.headers.get('x-next-cursor');
    assert.ok(cursor, 'expected a non-null cursor header');
    assert.notStrictEqual(cursor, '', 'first page should have a next cursor');
    assert.strictEqual(first.headers.get('x-page-limit'), '2');

    const second = await fetch(`${base}/users?_limit=2&_cursor=${encodeURIComponent(cursor!)}`, {
      headers: authHeaders('u1'),
    });
    const secondRows = await second.json();
    assert.strictEqual(secondRows.length, 1);
    // Last page: header present but empty.
    assert.strictEqual(second.headers.get('x-next-cursor'), '');
  });

  it('still speaks the offset (x-total-count) contract without _cursor/_limit', async () => {
    const res = await fetch(`${base}/users?_start=0&_end=10`, { headers: authHeaders('u1') });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('x-total-count'), '3');
  });

  it('walks every row exactly once via cursors with a related sort', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 10; i++) {
      const qs = new URLSearchParams({ _limit: '1', _sort: 'widgets.name', _order: 'asc' });
      if (cursor) { qs.set('_cursor', cursor); }
      const res = await fetch(`${base}/users?${qs.toString()}`, { headers: authHeaders('u1') });
      assert.strictEqual(res.status, 200);
      const rows = await res.json();
      seen.push(...rows.map((r: any) => r.id));
      const next = res.headers.get('x-next-cursor');
      if (next === null || next === '') { break; }
      cursor = next;
    }
    assert.strictEqual(seen.length, new Set(seen).size);
    assert.deepStrictEqual([...seen].sort(), ['u1', 'u2', 'u3']);
  });
});

describe('expansion over HTTP', () => {
  it('attaches batched related rows under the relation name', async () => {
    const res = await fetch(`${base}/users?_expand=widgets&_limit=3`, { headers: authHeaders('u1') });
    assert.strictEqual(res.status, 200);
    const rows = await res.json();
    const u1 = rows.find((r: any) => r.id === 'u1');
    assert.ok(Array.isArray(u1.widgets));
    assert.deepStrictEqual(u1.widgets.map((w: any) => w.id).sort(), ['w1', 'w2']);
    // u2's only widget is soft-deleted → no expanded rows.
    const u2 = rows.find((r: any) => r.id === 'u2');
    assert.deepStrictEqual(u2.widgets, []);
  });
});

describe('relation endpoint target RBAC + parity', () => {
  it('404s an unknown relation', async () => {
    const res = await fetch(`${base}/users/u1/relations/nope`, { headers: authHeaders('u1') });
    assert.strictEqual(res.status, 404);
  });

  it('lists related rows through the shared pipeline with cursor headers', async () => {
    const res = await fetch(`${base}/users/u1/relations/widgets?_limit=10`, {
      headers: authHeaders('u1'),
    });
    assert.strictEqual(res.status, 200);
    const rows = await res.json();
    assert.deepStrictEqual(rows.map((r: any) => r.id).sort(), ['w1', 'w2']);
    assert.ok(res.headers.get('x-next-cursor') !== null);
  });

  it('rejects a malformed cursor with 400', async () => {
    const res = await fetch(`${base}/users?_limit=2&_cursor=%E2%9C%93`, {
      headers: authHeaders('u1'),
    });
    assert.strictEqual(res.status, 400);
  });
});

describe('custom action payload parity', () => {
  it('runs a per-row action on a live row and returns its result', async () => {
    const res = await fetch(`${base}/widgets/_action/ping`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders('u1') },
      body: JSON.stringify({ id: 'w1' }),
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.deepStrictEqual(body, { ok: true, result: { seen: 'Alpha' } });
  });

  it('does not hand a soft-deleted row to the action handler (404)', async () => {
    const res = await fetch(`${base}/widgets/_action/ping`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders('u1') },
      body: JSON.stringify({ id: 'wdead' }),
    });
    assert.strictEqual(res.status, 404);
  });
});
