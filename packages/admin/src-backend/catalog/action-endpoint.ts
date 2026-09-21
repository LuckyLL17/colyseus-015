/**
 * POST /admin-api/:resource/_action/:action — run a custom action declared
 * via `defineAdminResource({ actions: [{ name, label, perRow, handler }] })`.
 * For perRow actions the request body must include `id`; we look the row up
 * + pass it to the handler. Each invocation is audit-logged.
 *
 * Permission/validation parity with the rest of the catalog:
 *   - existence + per-resource `policies.action` gate runs through the SAME
 *     `guard()` every CRUD endpoint uses (previously only the action's own
 *     `roles` list was checked, so a resource policy was bypassable here);
 *   - per-row row lookup applies the table's soft-delete predicate, so an
 *     action can't resurrect a deleted row the list/show endpoints hide;
 *   - the row is projected through the SAME sqlKeyedProjection every other
 *     read uses — the handler only ever sees declared columns.
 */
import { createEndpoint, type Endpoint } from '@colyseus/core';
import { and } from 'drizzle-orm';
import { sqlKeyedProjection, tryAudit } from '../internal/helpers.js';
import { errorResponse, json } from '../internal/http.js';
import { guard, pkOrError, tableOrError, type EndpointContext } from '../internal/context.js';
import { softDeleteCondition } from './relation-query.js';

export function actionEndpoint(ctx: EndpointContext): Endpoint {
  return createEndpoint(
    `${ctx.apiPath}/:resource/_action/:action`,
    { method: 'POST' },
    async (reqCtx) => {
      const { resource, action: actionName } = reqCtx.params as { resource: string; action: string };
      const def = ctx.resources[resource];
      const found = def?.actions?.find((a) => a.name === actionName);
      if (!found) { return errorResponse(404, `unknown action '${actionName}' on '${resource}'`); }

      // Same RBAC gate the CRUD list/update endpoints pass through. A
      // per-resource policy (`policies: { action: [...] } | 'deny' |
      // 'everyone'`) therefore applies to custom actions too.
      const denied = await guard(ctx, reqCtx, 'action', resource);
      if (denied) { return denied; }

      const userId = await ctx.resolveUserId({ getHeader: reqCtx.getHeader });
      if (ctx.enforceRbac) {
        if (!userId) { return errorResponse(401, 'not authenticated — sign in at /admin/login'); }
        // The action's own `roles` allow-list is a NARROWER gate on top of
        // the resource policy (e.g. an action admins run but mods can't).
        if (found.roles && found.roles.length > 0) {
          const role = await ctx.database.moderation.getRole(userId);
          if (!found.roles.includes(role)) {
            return errorResponse(403, `forbidden: action '${actionName}' on '${resource}'`);
          }
        }
      }

      let row: any = null;
      const body = (reqCtx.body ?? {}) as { id?: string };
      if (found.perRow) {
        if (!body.id) { return errorResponse(400, `action '${actionName}' requires an id`); }
        const r = tableOrError(ctx, resource);
        if (r instanceof Response) { return r; }
        const built = pkOrError(r.cfg, body.id);
        if (built instanceof Response) { return built; }
        // Hide soft-deleted rows from action handlers.
        const soft = softDeleteCondition(r.cfg);
        const where = soft ? and(built.where, soft) : built.where;
        const rows = await ctx.database.drizzle
          .select(sqlKeyedProjection(r.cfg))
          .from(r.table)
          .where(where)
          .limit(1);
        if (!rows[0]) { return errorResponse(404, 'row not found'); }
        row = rows[0];
      }

      const result = await found.handler(row, { userId: userId ?? '', resource });
      await tryAudit(ctx.logger, () => ctx.database.audit.record({
        operatorId: userId ?? null,
        action: 'custom',
        resource,
        targetId: body.id ?? null,
        payload: { name: actionName, args: body, result: result ?? null },
      }));
      return json({ ok: true, result: result ?? null });
    },
  );
}
