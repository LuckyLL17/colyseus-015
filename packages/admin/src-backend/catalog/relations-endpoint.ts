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
 *       target table matches this row's primary key value).
 *
 * The relation LIST runs through the exact same execution pipeline as the
 * top-level resource list (`executeResourceList`) — so bare-column filters,
 * free-text search, sorting, soft-delete handling, one-hop nested relation
 * traversal (`?<rel-of-target>.<col>=…`), expansion and stable cursor
 * pagination all behave identically to `/admin-api/:resource`.
 *
 * Both rely on `database.relations` to know which targets are reachable
 * and which FK column to compare against. Relations whose target isn't
 * registered as a resource are filtered out — they'd 404 from the UI.
 */
import { createEndpoint, type Endpoint } from '@colyseus/core';
import { listUserSessionsLive } from '@colyseus/core/internal';
import { and, eq, sql } from 'drizzle-orm';
import { resolveFkLayout } from '@colyseus/database';
import { castPk } from '../internal/helpers.js';
import { errorResponse, json } from '../internal/http.js';
import { guard, pkOrError, tableOrError, type EndpointContext } from '../internal/context.js';
import { executeResourceList } from './list-executor.js';
import { softDeleteCondition } from './relation-query.js';

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
          const targetTable = ctx.tables[rel.target];
          const targetCfg = ctx.getTableConfig(targetTable);
          const fkCol = (targetTable as any)[rel.fk];
          if (!fkCol) { counts[rel.name] = 0; return; }
          // Soft-deleted children don't count: the tab badge must match
          // the rows the relation list itself returns.
          const conds = [eq(fkCol, castedId)];
          const soft = softDeleteCondition(targetCfg);
          if (soft) { conds.push(soft); }
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
// target resource (you must be able to see its rows). The target rows go
// through executeResourceList — the SAME field validation + pipeline the
// standalone resource list uses.
// ---------------------------------------------------------------------------

export function relationEndpoint(ctx: EndpointContext): Endpoint {
  return createEndpoint(
    `${ctx.apiPath}/:resource/:id/relations/:name`,
    { method: 'GET' },
    async (reqCtx) => {
      const { resource, id, name } = reqCtx.params as { resource: string; id: string; name: string };
      const denied = await guard(ctx, reqCtx, 'list', resource);
      if (denied) { return denied; }

      const rel = (ctx.database.relations[resource] ?? []).find((r) => r.name === name);
      if (!rel) { return errorResponse(404, `unknown relation '${name}' on '${resource}'`); }

      const sourceR = tableOrError(ctx, resource);
      if (sourceR instanceof Response) { return sourceR; }
      const targetTable = ctx.tables[rel.target];
      if (!targetTable) { return errorResponse(404, `relation '${name}' targets unknown resource '${rel.target}'`); }

      // RBAC on the *target* — viewing a parent's items respects items' policies.
      const targetDenied = await guard(ctx, reqCtx, 'list', rel.target);
      if (targetDenied) { return targetDenied; }

      // FK column may live on EITHER side (see resolveFkLayout doc).
      const layout = resolveFkLayout(sourceR.table, targetTable, rel.fk);
      if (!layout) {
        return errorResponse(500, `relation '${name}' fk '${rel.fk}' not found on '${resource}' or '${rel.target}'`);
      }
      const targetCfg = ctx.getTableConfig(targetTable);
      const targetDef = ctx.resources[rel.target];

      // Build the fixed parent-correlation predicate. The executor already
      // hides the TARGET's own soft-deleted rows, so only the parent FK
      // condition is needed here. The two FK layouts need different input:
      //   fk on TARGET (parent → children): cast the source id and filter
      //     target.fk = :id directly.
      //   fk on SOURCE (source row points at the target): read the source
      //     row's FK value first; a missing source is 404, a NULL FK means
      //     the relation is empty by definition.
      const fixedWhere = [];

      if (layout.fkOn === 'target') {
        const sourcePkCol = sourceR.cfg.columns.find((c) => c.primary);
        if (!sourcePkCol) {
          return errorResponse(400, `cannot resolve relation '${name}': source has no single-column primary key`);
        }
        fixedWhere.unshift(eq(layout.fkCol, castPk(id, sourcePkCol)));
      } else {
        const sourceWhere = pkOrError(sourceR.cfg, id);
        if (sourceWhere instanceof Response) { return sourceWhere; }
        // A soft-deleted source row behaves as missing for its relations.
        const sourceSoft = softDeleteCondition(sourceR.cfg);
        const where = sourceSoft ? and(sourceWhere.where, sourceSoft) : sourceWhere.where;
        const [sourceRow] = await ctx.database.drizzle
          .select({ fk: layout.fkCol })
          .from(sourceR.table)
          .where(where)
          .limit(1);
        if (!sourceRow) { return errorResponse(404, 'source row not found'); }
        const fkValue = (sourceRow as { fk: unknown }).fk;
        if (fkValue == null) {
          // FK not set — relation is empty. Mirror the paginated shape the
          // UI expects for BOTH paging modes.
          const cursorMode = typeof reqCtx.query?._cursor === 'string' || typeof reqCtx.query?._limit === 'string';
          if (cursorMode) {
            return json([], { headers: {
              'x-next-cursor': '',
              'access-control-expose-headers': 'x-next-cursor',
            }});
          }
          return json([], { headers: {
            'x-total-count': '0',
            'access-control-expose-headers': 'x-total-count',
          }});
        }
        const targetPkCol = targetCfg.columns.find((c) => c.primary);
        if (!targetPkCol) {
          return errorResponse(500, `cannot resolve relation '${name}': target has no single-column primary key`);
        }
        const targetPkDrizzle = (targetTable as any)[targetPkCol.name] ?? targetPkCol;
        fixedWhere.unshift(eq(targetPkDrizzle, castPk(String(fkValue), targetPkCol)));
      }

      // The related list is scoped to the TARGET resource; the path
      // relation is passed as baseRelation so bare params (`?score_gte=10`,
      // `?_sort=created_at`) address the target's own columns, while the
      // target may itself traverse one more single-hop relation via dotted
      // params (that hop still lands here — same one-level rule).
      const result = await executeResourceList({
        ctx,
        query: (reqCtx.query ?? {}) as Record<string, any>,
        table: targetTable,
        cfg: targetCfg,
        def: targetDef,
        fixedWhere,
        baseRelation: rel,
        relations: ctx.database.relations[rel.target] ?? [],
      });
      if (!result.ok) { return errorResponse(result.status, result.message); }

      if (typeof result.nextCursor !== 'undefined') {
        return json(result.rows, { headers: {
          'x-next-cursor': result.nextCursor ?? '',
          'x-page-limit': String(result.limit ?? 0),
          'access-control-expose-headers': 'x-next-cursor, x-page-limit',
        }});
      }
      return json(result.rows, { headers: {
        'x-total-count': String(result.total ?? 0),
        'access-control-expose-headers': 'x-total-count',
      }});
    },
  );
}
