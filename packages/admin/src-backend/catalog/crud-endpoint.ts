/**
 * The five standard CRUD endpoints for any registered resource:
 *
 *   GET    /admin-api/:resource           — paginated list (search + filter + sort)
 *   GET    /admin-api/:resource/:id       — single row by PK
 *   POST   /admin-api/:resource           — create
 *   PUT    /admin-api/:resource/:id       — replace via runUpdate
 *   PATCH  /admin-api/:resource/:id       — partial update via runUpdate
 *   DELETE /admin-api/:resource/:id       — delete + audit-log
 *
 * @refinedev/simple-rest sends PATCH for `update` by default; accepting
 * PUT keeps custom clients working. They share the `runUpdate` handler.
 *
 * Every mutation is audit-logged via `tryAudit` so a logger failure can't
 * break the user's request.
 */
import { createEndpoint, type Endpoint } from '@colyseus/core';
import { and } from 'drizzle-orm';
import {
  pkColumns,
  sqlKeyedProjection,
  translateBodyKeys,
  tryAudit,
} from '../internal/helpers.js';
import { errorResponse, json } from '../internal/http.js';
import { guard, pkOrError, tableOrError, type EndpointContext } from '../internal/context.js';
import { runListQuery } from './list-runner.js';
import { liveRowsPredicate } from './relation-query.js';

// ---------------------------------------------------------------------------
// GET /admin-api/:resource — list with refine simple-rest semantics:
//   _start / _end          → offset pagination (refine UI)
//   _cursor / _limit       → stable keyset pagination (opaque base64url
//                            cursor; response carries x-next-cursor)
//   _sort / _order         → sort; _sort=<relation>.<field> traverses one
//                            declared relation via a correlated subquery
//   _expand=rel[,rel]      → embed related rows under row._relations
//                            (one batched query per relation, never per row)
//   _q                     → free-text search across text columns
//   <col>[_op]=value       → per-column filters (eq/ne/like/gt/gte/lt/lte/in)
//   <rel>.<col>[_op]=value → single-layer relation filter (one hop only;
//                            _null/_notnull for to-one, _exists for to-many)
// PK columns are always included so the UI can identify rows for /show / /edit.
// ---------------------------------------------------------------------------

export function listEndpoint(ctx: EndpointContext): Endpoint {
  return createEndpoint(`${ctx.apiPath}/:resource`, { method: 'GET' }, async (reqCtx) => {
    const { resource } = reqCtx.params as { resource: string };
    const denied = await guard(ctx, reqCtx, 'list', resource);
    if (denied) { return denied; }
    const r = tableOrError(ctx, resource);
    if (r instanceof Response) { return r; }
    const { table, cfg } = r;
    const def = ctx.resources[resource];

    const outcome = await runListQuery({
      db: ctx.database.drizzle,
      table, cfg,
      registry: {
        tables: ctx.tables,
        getTableConfig: ctx.getTableConfig,
        relations: ctx.database.relations,
      },
      resourceName: resource,
      def,
      query: (reqCtx.query ?? {}) as Record<string, unknown>,
      canAccessRelation: async (targetName) =>
        (await guard(ctx, reqCtx, 'list', targetName)) === null,
    });
    if (!outcome.ok) { return errorResponse(outcome.failure.status, outcome.failure.message); }

    const headers: Record<string, string> = {
      'access-control-expose-headers': 'x-total-count, x-next-cursor',
    };
    if (outcome.total !== null) { headers['x-total-count'] = String(outcome.total); }
    if (outcome.nextCursor) { headers['x-next-cursor'] = outcome.nextCursor; }
    return json(outcome.rows, { headers });
  });
}

// ---------------------------------------------------------------------------
// GET /admin-api/:resource/:id — fetch a single row by PK.
// ---------------------------------------------------------------------------

export function getEndpoint(ctx: EndpointContext): Endpoint {
  return createEndpoint(`${ctx.apiPath}/:resource/:id`, { method: 'GET' }, async (reqCtx) => {
    const { resource, id } = reqCtx.params as { resource: string; id: string };
    const denied = await guard(ctx, reqCtx, 'read', resource);
    if (denied) { return denied; }
    const r = tableOrError(ctx, resource);
    if (r instanceof Response) { return r; }
    const { table, cfg } = r;
    const built = pkOrError(cfg, id);
    if (built instanceof Response) { return built; }
    // Soft-deleted rows are invisible to reads — the same live-row rule the
    // list/relation queries apply.
    const conds = [built.where];
    const live = liveRowsPredicate(table, cfg);
    if (live) { conds.push(live); }
    const rows = await ctx.database.drizzle
      .select(sqlKeyedProjection(cfg))
      .from(table)
      .where(conds.length === 1 ? conds[0] : and(...conds))
      .limit(1);
    if (!rows[0]) { return errorResponse(404, 'not found'); }
    return json(rows[0]);
  });
}

// ---------------------------------------------------------------------------
// POST /admin-api/:resource — insert a new row. Body keys are SQL column
// names (what the form binds to); we translate to drizzle's JS field names
// + coerce types (date strings → Date, etc.) before insert.
// ---------------------------------------------------------------------------

export function createEndpoint_(ctx: EndpointContext): Endpoint {
  return createEndpoint(`${ctx.apiPath}/:resource`, { method: 'POST' }, async (reqCtx) => {
    const { resource } = reqCtx.params as { resource: string };
    const denied = await guard(ctx, reqCtx, 'create', resource);
    if (denied) { return denied; }
    const r = tableOrError(ctx, resource);
    if (r instanceof Response) { return r; }

    // Resolve the operator once — used for both `create.defaults(...)` and
    // the audit record. Resolving before the insert means default factories
    // and the audit see the same identity for this request.
    const operatorId = await ctx.resolveUserId({ getHeader: reqCtx.getHeader });

    // Server-side defaults from the resource definition (e.g. autofill
    // `authorId` from the signed-in admin). Merged BEFORE the body so the
    // body wins — defaults only fill keys the request didn't set.
    const definition = ctx.resources[resource];
    const defaults = definition?.create?.defaults
      ? await definition.create.defaults({ operatorId, resource })
      : undefined;
    const body = (reqCtx.body ?? {}) as Record<string, any>;
    const merged = defaults
      ? { ...translateBodyKeys(defaults, r.table), ...translateBodyKeys(body, r.table) }
      : translateBodyKeys(body, r.table);

    const [row] = await ctx.database.drizzle
      .insert(r.table)
      .values(merged)
      .returning(sqlKeyedProjection(r.cfg));

    // Audit: capture the created row + the operator behind the creation.
    const targetId = (() => {
      const pkCols = pkColumns(r.cfg);
      if (pkCols.length === 1) { return String(row[pkCols[0]!.name]); }
      return null;
    })();
    await tryAudit(ctx.logger, () => ctx.database.audit.record({
      operatorId, action: 'create', resource, targetId, payload: { row },
    }));
    return json(row, { status: 201 });
  });
}

// ---------------------------------------------------------------------------
// PUT/PATCH /admin-api/:resource/:id — partial update. Audit entry records
// a column-level diff via AuditService.recordUpdate so non-admin code (cron,
// scripts) gets the same `{ changes: { col: { before, after } } }` shape.
// ---------------------------------------------------------------------------

export function updateEndpoint(ctx: EndpointContext, method: 'PUT' | 'PATCH'): Endpoint {
  return createEndpoint(`${ctx.apiPath}/:resource/:id`, { method }, async (reqCtx) => {
    const { resource, id } = reqCtx.params as { resource: string; id: string };
    const denied = await guard(ctx, reqCtx, 'update', resource);
    if (denied) { return denied; }
    const r = tableOrError(ctx, resource);
    if (r instanceof Response) { return r; }
    const { table, cfg } = r;
    const built = pkOrError(cfg, id);
    if (built instanceof Response) { return built; }
    // Snapshot before-state so the audit entry has a {before, after} diff
    // rather than just the post-update row.
    const live = liveRowsPredicate(table, cfg);
    const readConds = [built.where];
    if (live) { readConds.push(live); }
    const beforeRows = await ctx.database.drizzle
      .select(sqlKeyedProjection(cfg))
      .from(table)
      .where(readConds.length === 1 ? readConds[0] : and(...readConds))
      .limit(1);
    if (!beforeRows[0]) { return errorResponse(404, 'not found'); }
    const set = translateBodyKeys((reqCtx.body ?? {}) as Record<string, any>, table);
    const updateConds = [built.where];
    if (live) { updateConds.push(live); }
    const [row] = await ctx.database.drizzle.update(table).set(set)
      .where(updateConds.length === 1 ? updateConds[0] : and(...updateConds))
      .returning(sqlKeyedProjection(cfg));
    const operatorId = await ctx.resolveUserId({ getHeader: reqCtx.getHeader });
    await tryAudit(ctx.logger, () => ctx.database.audit.recordUpdate({
      operatorId, resource, targetId: id,
      before: beforeRows[0] as any, after: row,
    }));
    return json(row);
  });
}

// ---------------------------------------------------------------------------
// DELETE /admin-api/:resource/:id — drop a row by PK + audit-log it.
// ---------------------------------------------------------------------------

export function deleteEndpoint(ctx: EndpointContext): Endpoint {
  return createEndpoint(`${ctx.apiPath}/:resource/:id`, { method: 'DELETE' }, async (reqCtx) => {
    const { resource, id } = reqCtx.params as { resource: string; id: string };
    const denied = await guard(ctx, reqCtx, 'delete', resource);
    if (denied) { return denied; }
    const r = tableOrError(ctx, resource);
    if (r instanceof Response) { return r; }
    const { table, cfg } = r;
    const built = pkOrError(cfg, id);
    if (built instanceof Response) { return built; }
    const conds = [built.where];
    const live = liveRowsPredicate(table, cfg);
    if (live) { conds.push(live); }
    const [row] = await ctx.database.drizzle.delete(table)
      .where(conds.length === 1 ? conds[0] : and(...conds))
      .returning(sqlKeyedProjection(cfg));
    if (!row) { return errorResponse(404, 'not found'); }
    const operatorId = await ctx.resolveUserId({ getHeader: reqCtx.getHeader });
    await tryAudit(ctx.logger, () => ctx.database.audit.record({
      operatorId, action: 'delete', resource, targetId: id, payload: { row },
    }));
    return json(row);
  });
}
