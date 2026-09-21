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
import { sql } from 'drizzle-orm';
import {
  pkColumns,
  sqlKeyedProjection,
  translateBodyKeys,
  tryAudit,
} from '../internal/helpers.js';
import { errorResponse, json } from '../internal/http.js';
import { guard, pkOrError, tableOrError, type EndpointContext } from '../internal/context.js';
import { executeResourceList } from './list-executor.js';

// ---------------------------------------------------------------------------
// GET /admin-api/:resource — list with refine simple-rest semantics:
//   _start / _end   → offset pagination (refine simple-rest)
//   _cursor / _limit → stable keyset pagination (relation-aware clients)
//   _sort / _order  → sort (own column, or `<relation>.<column>`)
//   _q              → free-text search across text columns
//   _expand=<rel>   → include related rows (batched, never N+1)
//   <col>[_op]=val  → per-column filters (eq/ne/like/gt/gte/lt/lte/in)
//   <rel>.<col>[_op]=val → filter by a related resource's column (one hop)
// PK columns are always included so the UI can identify rows.
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

    const result = await executeResourceList({
      ctx,
      query: (reqCtx.query ?? {}) as Record<string, any>,
      table, cfg, def,
      relations: ctx.database.relations[resource] ?? [],
    });
    if (!result.ok) { return errorResponse(result.status, result.message); }

    // Cursor mode: no total — the client pages purely off `nextCursor`.
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
    const rows = await ctx.database.drizzle
      .select(sqlKeyedProjection(cfg))
      .from(table)
      .where(built.where)
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
    const beforeRows = await ctx.database.drizzle
      .select(sqlKeyedProjection(cfg))
      .from(table)
      .where(built.where)
      .limit(1);
    const set = translateBodyKeys((reqCtx.body ?? {}) as Record<string, any>, table);
    const [row] = await ctx.database.drizzle.update(table).set(set)
      .where(built.where).returning(sqlKeyedProjection(cfg));
    if (!row) { return errorResponse(404, 'not found'); }
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
    const [row] = await ctx.database.drizzle.delete(table).where(built.where)
      .returning(sqlKeyedProjection(cfg));
    if (!row) { return errorResponse(404, 'not found'); }
    const operatorId = await ctx.resolveUserId({ getHeader: reqCtx.getHeader });
    await tryAudit(ctx.logger, () => ctx.database.audit.record({
      operatorId, action: 'delete', resource, targetId: id, payload: { row },
    }));
    return json(row);
  });
}
