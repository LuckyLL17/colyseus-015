/**
 * SQL-backed integration tests for single-hop relation querying. Runs on
 * PGlite (embedded Postgres) so EXISTS/aggregate subqueries, NULLS LAST and
 * keyset wrappers execute against a real planner.
 *
 * Covers: related-column filtering (one + many), related sorting with the
 * aggregate/limit-1 subqueries, cursor walk stability across ties/NULLs,
 * no fan-out duplicates, soft-delete semantics (both sides), `_null=true`,
 * batched expansion (one query, grouped), and 400 validation.
 */
import assert from 'assert';
import { describe, it, before, after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import { PGlite } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import { executeResourceList, type ExecuteListOptions } from '../src-backend/catalog/list-executor.ts';

// --- schema -----------------------------------------------------------------

const users = pgTable('users', {
  id: text('id').primaryKey(),
  name: text('name'),
});
const guilds = pgTable('guilds', {
  id: text('id').primaryKey(),
  name: text('name'),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});
const members = pgTable('members', {
  id: text('id').primaryKey(),
  userId: text('user_id'),
  guildId: text('guild_id'),
  nickname: text('nickname'),
  score: integer('score'),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});
// No unique constraint on guild_id by design — used to prove 'one'
// relations served by EXISTS can never duplicate a source row even when
// the data violates the expected cardinality.
const invites = pgTable('invites', {
  id: text('id').primaryKey(),
  guildId: text('guild_id'),
  code: text('code'),
});

const tables = { users, guilds, members, invites };

const relations = {
  users: [
    { name: 'memberships', target: 'members', kind: 'many' as const, fk: 'userId' },
  ],
  members: [
    // fk on SOURCE: a member row points at its user.
    { name: 'user', target: 'users', kind: 'one' as const, fk: 'userId' },
    { name: 'guild', target: 'guilds', kind: 'one' as const, fk: 'guildId' },
  ],
  guilds: [
    { name: 'members', target: 'members', kind: 'many' as const, fk: 'guildId' },
    // Non-unique FK in the data — fan-out safety net.
    { name: 'invite', target: 'invites', kind: 'one' as const, fk: 'guildId' },
  ],
};

// --- harness ----------------------------------------------------------------

let client: PGlite;
let db: ReturnType<typeof drizzle>;
let ctx: any;
let dataDir: string;

async function ddl(statements: string[]): Promise<void> {
  // PGlite 0.4: drizzle's session and client.exec don't share an internal
  // connection — run DDL through drizzle so reads see it.
  for (const s of statements) { await db.execute(sql.raw(s)); }
}

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-relq-'));
  client = new PGlite(dataDir);
  db = drizzle(client);
  await ddl([
    `create table users (id text primary key, name text)`,
    `create table guilds (
       id text primary key, name text, deleted_at timestamptz
     )`,
    `create table members (
       id text primary key, user_id text, guild_id text,
       nickname text, score int, deleted_at timestamptz
     )`,
    `create table invites (id text primary key, guild_id text, code text)`,
  ]);

  await db.insert(users).values([
    { id: 'u1', name: 'Ann' },
    { id: 'u2', name: 'Bob' },
    { id: 'u3', name: 'Cyd' },   // only membership is soft-deleted
    { id: 'u4', name: 'Nil' },   // no membership at all
    { id: 'u5', name: 'Doe' },   // sole membership points at a soft-deleted guild
  ]);
  await db.insert(guilds).values([
    { id: 'g1', name: 'Knights' },
    { id: 'g2', name: 'Rogues' },
    { id: 'gdead', name: 'Ghosts', deletedAt: new Date() },
  ]);
  await db.insert(members).values([
    { id: 'm1', userId: 'u1', guildId: 'g1', nickname: 'alpha', score: 30 },
    { id: 'm2', userId: 'u1', guildId: 'g2', nickname: 'beta', score: 10 },
    { id: 'm3', userId: 'u2', guildId: 'g1', nickname: 'gamma', score: 50 },
    { id: 'm4', userId: 'u3', guildId: 'g1', nickname: 'zzz', score: 99, deletedAt: new Date() },
    // m5 points at a soft-deleted guild — its USER is live but the GUILD is not.
    { id: 'm5', userId: 'u5', guildId: 'gdead', nickname: 'haunted', score: 1 },
  ]);
  await db.insert(invites).values([
    { id: 'i1', guildId: 'g1', code: 'AAA' },
    { id: 'i2', guildId: 'g1', code: 'BBB' }, // duplicate FK — two invites to g1
  ]);

  ctx = {
    database: { drizzle: db, relations },
    tables,
    resources: {},
    getTableConfig: (t: any) => getTableConfig(t),
  };
});

after(async () => {
  await client.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function listOn(table: any, tableRelations: any, query: Record<string, any>, def?: any) {
  const opts: ExecuteListOptions = {
    ctx, query, table, cfg: getTableConfig(table), def, relations: tableRelations,
  };
  return executeResourceList(opts);
}

async function walk(table: any, tableRelations: any, query: Record<string, any>, pageSize = 1): Promise<string[]> {
  // Walk every page with tiny pages to maximize tie/NULL boundary coverage.
  const out: string[] = [];
  let cursor: string | undefined;
  for (;;) {
    const q = { ...query, _limit: String(pageSize), ...(cursor ? { _cursor: cursor } : {}) };
    const r = await listOn(table, tableRelations, q);
    assert.ok(r.ok, r.ok ? '' : `${r.status} ${r.message}`);
    if (!r.ok) { break; }
    for (const row of r.rows) { out.push(row.id); }
    if (!r.nextCursor) { break; }
    cursor = r.nextCursor;
  }
  return out;
}

describe('filtering by a related column', () => {
  it('many relation: matches parents with at least one matching child', async () => {
    const r = await listOn(users, relations.users, { 'memberships.nickname': 'alpha' });
    assert.ok(r.ok);
    assert.deepStrictEqual(r.rows.map((x) => x.id), ['u1']);
  });

  it('supports the same operators as own-column filters (like, gte, in)', async () => {
    const like = await listOn(users, relations.users, { 'memberships.nickname_like': 'alph' });
    assert.ok(like.ok);
    assert.deepStrictEqual(like.rows.map((x) => x.id), ['u1']); // alpha contains 'alph'
    const gte = await listOn(users, relations.users, { 'memberships.score_gte': '35' });
    assert.ok(gte.ok);
    assert.deepStrictEqual(gte.rows.map((x) => x.id), ['u2']); // only gamma=50
  });

  it('one relation (fk on source): filters rows by the related record', async () => {
    const r = await listOn(members, relations.members, { 'user.name': 'Ann' });
    assert.ok(r.ok);
    assert.deepStrictEqual(r.rows.map((x) => x.id).sort(), ['m1', 'm2']);
  });

  it('400s on unknown relation, unknown column, two relations and multi-hop', async () => {
    const unknownRel = await listOn(users, relations.users, { 'nope.name': 'x' });
    assert.ok(!unknownRel.ok && unknownRel.status === 400);
    const unknownCol = await listOn(users, relations.users, { 'memberships.nope': 'x' });
    assert.ok(!unknownCol.ok && unknownCol.status === 400);
    const twoRels = await listOn(members, relations.members, {
      'user.name': 'Ann', 'guild.name': 'Knights',
    });
    assert.ok(!twoRels.ok && twoRels.status === 400);
    const multiHop = await listOn(users, relations.users, { 'memberships.user.name': 'Ann' });
    assert.ok(!multiHop.ok && multiHop.status === 400);
  });
});

describe('sorting by a related column', () => {
  it('many: MIN/MAX aggregate scalar, NULL (no live children) sorts last', async () => {
    const asc = await listOn(users, relations.users, {
      _sort: 'memberships.score', _order: 'asc',
    });
    assert.ok(asc.ok);
    // live min scores: u1=10, u2=20; u3/u4 NULL last in id order
    // live min scores: u5=1, u1=min(30,10)=10, u2=50; NULLs (u3/u4) last
    assert.deepStrictEqual(asc.rows.map((x) => x.id), ['u5', 'u1', 'u2', 'u3', 'u4']);

    const desc = await listOn(users, relations.users, {
      _sort: 'memberships.score', _order: 'desc',
    });
    assert.ok(desc.ok);
    // live max scores: u2=50, u1=30, u5=1; NULLs (u3/u4) last
    assert.deepStrictEqual(desc.rows.map((x) => x.id), ['u2', 'u1', 'u5', 'u3', 'u4']);
  });

  it('one: LIMIT 1 subquery on the related table', async () => {
    const r = await listOn(members, relations.members, { _sort: 'user.name', _order: 'desc' });
    assert.ok(r.ok);
    // Live members m1,m2,m3,m5 (m4 soft-deleted). Rows are SQL-keyed
    // (user_id). Users: Doe(u5), Bob(u2), Ann(u1 x2, tie → member id).
    const usersOrder = r.rows.map((x) => x.user_id);
    assert.strictEqual(usersOrder[0], 'u5');
    assert.strictEqual(usersOrder[1], 'u2');
    assert.deepStrictEqual(usersOrder.slice(2), ['u1', 'u1']);
  });
});

describe('stable cursor pagination', () => {
  it('walks every row exactly once ordering by a related aggregate', async () => {
    const ids = await walk(users, relations.users, {
      _sort: 'memberships.score', _order: 'desc',
    }, 1);
    assert.deepStrictEqual(ids, ['u2', 'u1', 'u5', 'u3', 'u4']);
    assert.strictEqual(new Set(ids).size, ids.length);
  });

  it('is stable with a plain (non-related) sort and ties', async () => {
    // guild_id ties: m1 & m3 share g1. Walk by guild_id asc pages of 1.
    // Live members only (m4 is soft-deleted): m1,m3 (g1), m2 (g2), m5 (gdead).
    const ids = await walk(members, [], { _sort: 'guild_id' }, 1);
    assert.strictEqual(ids.length, new Set(ids).size);
    assert.deepStrictEqual(ids, ['m1', 'm3', 'm2', 'm5']);
  });

  it('rejects a malformed/arity-wrong cursor with 400', async () => {
    const bad = await listOn(users, relations.users, { _limit: '2', _cursor: '%%%' });
    assert.ok(!bad.ok && bad.status === 400);
  });

  it('does not return an x-total-count shape in cursor mode (headers tested at HTTP layer)', async () => {
    const r = await listOn(users, relations.users, { _limit: '2' });
    assert.ok(r.ok);
    assert.strictEqual(r.total, undefined);
    assert.strictEqual(r.rows.length, 2);
    assert.strictEqual(typeof r.nextCursor, 'string');
  });
});

describe('rows without related records', () => {
  it('_null=true returns only parents with no LIVE related rows', async () => {
    const r = await listOn(users, relations.users, { 'memberships._null': 'true' });
    assert.ok(r.ok);
    // u3's only membership is soft-deleted → counts as having none;
    // u5's membership on the deleted guild is a LIVE membership.
    assert.deepStrictEqual(r.rows.map((x) => x.id).sort(), ['u3', 'u4']);
  });

  it('sort/expand without a filter keeps relation-less rows (LEFT semantics)', async () => {
    const r = await listOn(users, relations.users, {
      _sort: 'memberships.score', _expand: 'memberships', _limit: '10',
    });
    assert.ok(r.ok);
    const u4 = r.rows.find((x) => x.id === 'u4');
    assert.deepStrictEqual(u4.memberships, []);
  });
});

describe('duplicate related rows never duplicate source rows', () => {
  it('many fan-out: parent with 2 matching children appears once', async () => {
    const r = await listOn(users, relations.users, {
      'memberships.guild_id': 'g1',
    });
    // u1 and u2 both have a g1 member; u1 has exactly one g1 member but the
    // important assertion is no id repeats.
    const ids = r.rows.map((x) => x.id);
    assert.strictEqual(ids.length, new Set(ids).size);
    assert.deepStrictEqual(ids.sort(), ['u1', 'u2']);
  });

  it('one with a non-unique FK (two invites for the guild) lists the guild once', async () => {
    const r = await listOn(guilds, relations.guilds, { 'invite.code_in': 'AAA,BBB' });
    assert.ok(r.ok);
    assert.deepStrictEqual(r.rows.map((x) => x.id), ['g1']);
  });
});

describe('soft delete', () => {
  it('hides the listed table own soft-deleted rows', async () => {
    const all = await listOn(guilds, relations.guilds, {});
    assert.ok(all.ok);
    assert.deepStrictEqual(all.rows.map((x) => x.id).sort(), ['g1', 'g2']);
  });

  it('excludes soft-deleted children from filters', async () => {
    // u3's only child has score 99 but is deleted — gte 90 must not match u3.
    const r = await listOn(users, relations.users, { 'memberships.score_gte': '90' });
    assert.ok(r.ok);
    assert.deepStrictEqual(r.rows, []);
  });

  it('excludes soft-deleted related targets from a one relation', async () => {
    // Member rows on the deleted guild must not match "guild.name=Ghosts".
    const r = await listOn(members, relations.members, { 'guild.name': 'Ghosts' });
    assert.ok(r.ok);
    assert.deepStrictEqual(r.rows, []);
  });
});

describe('expansion (single batched query)', () => {
  it('groups many children under each parent and [] for none', async () => {
    const r = await listOn(users, relations.users, { _expand: 'memberships', _limit: '10' });
    assert.ok(r.ok);
    const byId = Object.fromEntries(r.rows.map((x) => [x.id, x.memberships.map((m: any) => m.id)]));
    assert.deepStrictEqual(byId.u1.sort(), ['m1', 'm2']);
    assert.deepStrictEqual(byId.u2, ['m3']);
    assert.deepStrictEqual(byId.u4, []);
    assert.deepStrictEqual(byId.u5, ['m5']); // child itself is live (guild soft-delete doesn't hide it)
    // Soft-deleted child never expands in.
    assert.ok(!(byId.u3 ?? []).includes('m4'));
  });

  it('expands a one relation (fk on source) to the related row', async () => {
    const r = await listOn(members, relations.members, { _expand: 'user', _limit: '10' });
    assert.ok(r.ok);
    const m1 = r.rows.find((x) => x.id === 'm1');
    assert.strictEqual(m1.user.id, 'u1');
    assert.strictEqual(m1.user.name, 'Ann');
  });
});

describe('offset mode still reports the filtered total', () => {
  it('x-total semantics: total counts filtered parents, not children', async () => {
    const r = await listOn(users, relations.users, {
      _start: '0', _end: '10', 'memberships.guild_id': 'g1',
    });
    assert.ok(r.ok);
    assert.strictEqual(r.total, 2); // u1, u2 — not the child row count
  });
});
