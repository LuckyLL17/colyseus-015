/**
 * Two endpoints that traverse declared FK relationships:
 *
 *   GET /admin-api/:resource/:id/_counts
 *     → bulk count(*) across every many-relation on this resource. One
 *       request replaces N parallel `_start=0&_end=1` calls used to
 *       populate detail-page tab counts.
 *
 *   GET /admin-api/:resource/:id/relations/:name
 *     → paginated list of related rows (the relation's `fk` column on the
 *       target table matches this row's primary key). Supports the SAME
 *       query surface as the generic list endpoint — per-column filters,
 *       free-text search, relation-free ordering, stable cursor pagination
 *       — via the shared list runner. (Single-layer only: a child list can
 *       be filtered by its OWN columns, not by a grand-relation; a parent
 *       row is an implicit, fixed `scope` predicate.)
 *
 * Both rely on `database.relations` to know which targets are reachable
 * and which FK column to compare against. Relations whose target isn't
 * registered as a resource are filtered out — they'd 404 from the UI.
 */
import { createEndpoint, type Endpoint } from '@colyseus/core';
import { listUserSessionsLive } from '@colyseus/core/internal';
import { and, eq, sql } from 'drizzle-orm';
import { castPk, pkColumns } from '../internal/helpers.js';
import { errorResponse, json } from '../internal/http.js';
import { guard, tableOrError, type EndpointContext } from '../internal/context.js';
import {
  findColumnBySqlName, liveRowsPredicate, resolveRelation,
} from './relation-query.js';
import { runListQuery } from './list-runner.js';

/**
 * Synthetic count key for the user-show page's "Active sessions" tab.
 * Lives alongside the relation counts in the `/_counts` response so the
 * frontend can drive the tab badge from a single bulk request, instead
 * of mounting a per-render polling hook on the label.
 */
const ACTIVE_SESSIONS_COUNT_KEY = '__active_sessions';

// ---------------------------------------------------------------------------
// GET /admin-api/:resource/:id/_counts — counts run in Promise.all so
// wall-clock stays short.
// ---------------------------------------------------------------------------

export function countsEndpoint(ctx: EndpointContext): Endpoint {
  return createEndpoint(
    `${ctx.apiPath}/:resource/:id/_counts`,
    { method: 'GET' },
    async (reqCtx) => {
      const { resource, id } = reqCtx.params as { resource: string; id: string };
      const denied = await guard(ctx, reqCtx, 'list', resource);
      if (denied) { return denied; }

      const r = tableOrError(ctx, resource);
      if (r instanceof Response) { return r; }
      const sourcePk = r.cfg.columns.find((c) => c.primary);
      if (!sourcePk) { return errorResponse(400, 'no single-column primary key'); }
      const castedId = castPk(id, sourcePk);

      const manyRels = (ctx.database.relations[resource] ?? []).filter(
        (rel) => rel.kind === 'many' && !!ctx.tables[rel.target],
      );

      const counts: Record<string, number> = {};
      await Promise.all(
        manyRels.map(async (rel) => {
          const targetTable = ctx.tables[rel.target]!;
          const targetCfg = ctx.getTableConfig(targetTable);
          // rel.fk is the drizzle JS field name; fall back to SQL-name lookup
          // for relation metadata authored against SQL identifiers.
          const fkCol = (targetTable as any)[rel.fk]
            ?? findColumnBySqlName(targetTable, rel.fk);
          if (!fkCol) { counts[rel.name] = 0; return; }
          // Count only live children (soft-deleted rows don't fill tab badges).
          const conds = [eq(fkCol, castedId)];
          const live = liveRowsPredicate(targetTable, targetCfg);
          if (live) { conds.push(live); }
          const rows = await ctx.database.drizzle
            .select({ c: sql<number>`count(*)` })
            .from(targetTable)
            .where(conds.length === 1 ? conds[0]! : and(...conds));
          counts[rel.name] = Number((rows[0] as { c?: number })?.c ?? 0);
        }),
      );

      // Active sessions for users: bolt the user-rooms hash size onto
      // the response so the show page's tab badge resolves from this
      // same bulk request. Counts the raw hash entries — no reconcile
      // against `matchMaker.query` here, because the badge can tolerate
      // tiny drift from crash-leftover entries (the tab's own fetch
      // does the full reconcile + hdel sweep when opened).
      if (resource === 'users') {
        // No reconcile: tiny drift from crash-leftover entries is fine
        // for the badge — the tab's own fetch does the full reconcile
        // + hdel sweep when opened. `listUserSessionsLive` swallows
        // Presence outages internally and returns [].
        const sessions = await listUserSessionsLive(id);
        counts[ACTIVE_SESSIONS_COUNT_KEY] = sessions.length;
      }

      return json(counts);
    },
  );
}

// ---------------------------------------------------------------------------
// GET /admin-api/:resource/:id/relations/:name — RBAC enforced on BOTH
// the source resource (you must be able to list its relations) and the
// target resource (you must be able to see its rows). The child list goes
// through the SAME query engine (filters / sort / cursor / soft-delete) as
// GET /:resource, with the parent FK fixed as an immutable scope.
// ---------------------------------------------------------------------------

export function relationEndpoint(ctx: EndpointContext): Endpoint {
  return createEndpoint(
    `${ctx.apiPath}/:resource/:id/relations/:name`,
    { method: 'GET' },
    async (reqCtx) => {
      const { resource, id, name } = reqCtx.params as { resource: string; id: string; name: string };
      const denied = await guard(ctx, reqCtx, 'list', resource);
      if (denied) { return denied; }

      const sourceResolved = tableOrError(ctx, resource);
      if (sourceResolved instanceof Response) { return sourceResolved; }

      const resolved = resolveRelation({
        tables: ctx.tables,
        getTableConfig: ctx.getTableConfig,
        relations: ctx.database.relations,
      }, resource, name);
      if (!resolved.ok) { return errorResponse(resolved.failure.status, resolved.failure.message); }
      const rel = resolved.relation;

      // RBAC on the *target* — viewing a parent's items respects items' policies.
      const targetDenied = await guard(ctx, reqCtx, 'list', rel.targetName);
      if (targetDenied) { return targetDenied; }

      const q = (reqCtx.query ?? {}) as Record<string, unknown>;

      if (rel.cardinality === 'to-one') {
        // FK-on-source to-one: read the source row's FK, then fetch the
        // target by PK. At most one row — total = rows.length, no count(*)
        // needed. The parent's own soft-delete state doesn't change the
        // result shape, but the target row must itself be live.
        if (rel.fkOn === 'source') {
          const sourceTable = ctx.tables[resource]!;
          const sourceCfg = ctx.getTableConfig(sourceTable);
          const sourcePks = pkColumns(sourceCfg);
          if (sourcePks.length !== 1) {
            return errorResponse(400, `cannot resolve relation '${name}': source has no single-column primary key`);
          }
          const sourcePkCol = findColumnBySqlName(sourceTable, sourcePks[0]!.name);
          const conds = [eq(sourcePkCol, castPk(id, sourcePks[0]!))];
          const sourceLive = liveRowsPredicate(sourceTable, sourceCfg);
          if (sourceLive) { conds.push(sourceLive); }
          const [sourceRow] = await ctx.database.drizzle
            .select({ fk: rel.fkCol })
            .from(sourceTable)
            .where(conds.length === 1 ? conds[0]! : and(...conds))
            .limit(1);
          if (!sourceRow) { return errorResponse(404, 'source row not found'); }
          const fkValue = (sourceRow as { fk: unknown }).fk;
          if (fkValue == null) {
            return json([], { headers: relationHeaders(0, null) });
          }
          const targetPk = rel.parentPk[0]!;
          const targetCond = eq(
            findColumnBySqlName(rel.targetTable, targetPk.name),
            castPk(String(fkValue), targetPk),
          );
          const live = liveRowsPredicate(rel.targetTable, rel.targetCfg);
          const rows = await ctx.database.drizzle
            .select(projectionFor(rel.targetCfg))
            .from(rel.targetTable)
            .where(live ? and(targetCond, live) : targetCond)
            .limit(1);
          return json(rows, { headers: relationHeaders(rows.length, null) });
        }

        // FK-on-target to-one (e.g. users → role through roles.user_id):
        // the target carries the FK matching this source's PK.
        const sourceTableForCheck = ctx.tables[resource]!;
        const sourcePks = pkColumns(sourceResolved.cfg);
        if (sourcePks.length !== 1) {
          return errorResponse(400, `cannot resolve relation '${name}': source has no single-column primary key`);
        }
        // Verify the (possibly soft-deleted) source row exists and is live.
        const srcConds = [eq(
          findColumnBySqlName(sourceTableForCheck, sourcePks[0]!.name),
          castPk(id, sourcePks[0]!),
        )];
        const srcLive = liveRowsPredicate(sourceTableForCheck, sourceResolved.cfg);
        if (srcLive) { srcConds.push(srcLive); }
        const srcRows = await ctx.database.drizzle
          .select({ one: sql<number>`1` })
          .from(sourceTableForCheck)
          .where(srcConds.length === 1 ? srcConds[0]! : and(...srcConds))
          .limit(1);
        if (!srcRows[0]) { return errorResponse(404, 'source row not found'); }

        const fkCond = eq(rel.fkCol, castPk(id, sourcePks[0]!));
        const live = liveRowsPredicate(rel.targetTable, rel.targetCfg);
        const rows = await ctx.database.drizzle
          .select(projectionFor(rel.targetCfg))
          .from(rel.targetTable)
          .where(live ? and(fkCond, live) : fkCond)
          .limit(1);
        return json(rows, { headers: relationHeaders(rows.length, null) });
      }

      // to-many: full shared list engine, scoped to parent.fk = id.
      const sourceTable = ctx.tables[resource]!;
      const sourcePks = pkColumns(sourceResolved.cfg);
      if (sourcePks.length !== 1) {
        return errorResponse(400, `cannot resolve relation '${name}': source has no single-column primary key`);
      }
      // A soft-deleted (or missing) parent exposes no relation tab data —
      // verify the parent is live before scoping the child list to it.
      const sourceConds = [eq(
        findColumnBySqlName(sourceTable, sourcePks[0]!.name),
        castPk(id, sourcePks[0]!),
      )];
      const sourceLive = liveRowsPredicate(sourceTable, sourceResolved.cfg);
      if (sourceLive) { sourceConds.push(sourceLive); }
      const sourceRows = await ctx.database.drizzle
        .select({ one: sql<number>`1` })
        .from(sourceTable)
        .where(sourceConds.length === 1 ? sourceConds[0]! : and(...sourceConds))
        .limit(1);
      if (!sourceRows[0]) { return errorResponse(404, 'source row not found'); }

      const scope = eq(rel.fkCol, castPk(id, sourcePks[0]!));

      // The relation endpoint scopes a CHILD list — its filters/sorts
      // address the child's OWN columns. Relation-prefixed keys on a child
      // are a second hop from this URL's context and are rejected outright,
      // keeping the single-layer contract explicit (rather than silently
      // resolving grand-relations).
      for (const key of Object.keys(q)) {
        if (key === '_expand' || key === '_sort' || key === '_order'
          || key === '_start' || key === '_end' || key === '_q'
          || key === '_cursor' || key === '_limit') { continue; }
        if (key.includes('.')) {
          return errorResponse(400, `relation lists do not support nested relation key '${key}'`);
        }
      }

      const outcome = await runListQuery({
        db: ctx.database.drizzle,
        table: rel.targetTable,
        cfg: rel.targetCfg,
        registry: {
          tables: ctx.tables,
          getTableConfig: ctx.getTableConfig,
          relations: ctx.database.relations,
        },
        resourceName: rel.targetName,
        def: ctx.resources[rel.targetName],
        query: q,
        scope,
        // Expansions inside a relation tab would be second-hop data — disabled
        // even with target RBAC, matching the single-layer contract.
        canAccessRelation: async () => false,
      });
      if (!outcome.ok) { return errorResponse(outcome.failure.status, outcome.failure.message); }

      const headers = relationHeaders(outcome.total ?? 0, outcome.nextCursor);
      return json(outcome.rows, { headers });
    },
  );
}

function relationHeaders(total: number, nextCursor: string | null): Record<string, string> {
  return {
    'x-total-count': String(total),
    ...(nextCursor ? { 'x-next-cursor': nextCursor } : {}),
    'access-control-expose-headers': 'x-total-count, x-next-cursor',
  };
}

function projectionFor(cfg: ReturnType<EndpointContext['getTableConfig']>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const c of cfg.columns) { out[c.name] = c; }
  return out;
}
