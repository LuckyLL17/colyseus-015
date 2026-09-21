/**
 * Recoverable error banner for the list page's relation query.
 *
 * refine's `tableQuery` (react-query) surfaces request failures as
 * `tableQuery.isError`. For a relation query that 400s (bad field/op), 403s
 * (target permission) or fails transitively (5xx/network), a plain table
 * empty-state is misleading — it looks like "no rows". This banner instead
 * explains the failure and offers two recoveries:
 *
 *   - Retry:           refetch with the SAME query (transient 5xx/network)
 *   - Reset relation:  drop ONLY the relation-prefixed filters/sorter, keep
 *                      text search, direct-column filters and pagination
 *
 * Both actions keep the operator on the page; the URL state is refined by
 * setFilters/setSorters which syncWithLocation writes back to the address bar.
 */
import { AlertTriangle, RotateCcw, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';

export function RelationQueryError({
  message, onRetry, onResetRelation,
}: {
  message: string;
  onRetry: () => void;
  onResetRelation: () => void;
}) {
  return (
    <div
      role="alert"
      data-testid="relation-query-error"
      className="mb-3 flex flex-wrap items-center gap-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm"
    >
      <AlertTriangle className="size-4 text-destructive shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="font-medium text-destructive">Relation query failed</div>
        <div className="text-muted-foreground truncate">{message}</div>
      </div>
      <Button variant="outline" size="sm" onClick={onRetry} data-testid="relation-query-retry">
        <RotateCcw className="size-4" />
        Retry
      </Button>
      <Button variant="ghost" size="sm" onClick={onResetRelation} data-testid="relation-query-reset">
        <XCircle className="size-4" />
        Reset relation filter
      </Button>
    </div>
  );
}

/**
 * Map an axios/refine error to an operator-readable message. Kept tolerant:
 * the exact envelope varies (better-call JSON body, network TypeError, test
 * stubs), so anything unrecognized becomes a generic retry hint.
 */
export function relationErrorMessage(error: unknown): string {
  const anyErr = error as {
    response?: { status?: number; data?: { message?: string } | string };
    message?: string;
  } | null | undefined;
  const status = anyErr?.response?.status;
  const body = anyErr?.response?.data;
  const serverMessage = typeof body === 'string' ? body : body?.message;
  if (status === 403) {
    return serverMessage ?? 'You do not have permission to query the related resource.';
  }
  if (status === 400) {
    return serverMessage ?? 'The relation filter is malformed — check the field and operator.';
  }
  if (status === 404) {
    return serverMessage ?? 'The relation or related resource no longer exists.';
  }
  if (status && status >= 500) {
    return 'The server failed while running the relation query. You can retry.';
  }
  // Network-layer failures arrive as plain TypeErrors ("Failed to fetch")
  // with no response — frame them as network errors rather than echoing the
  // browser-specific wording.
  if (!status) {
    return 'Network error while running the relation query. You can retry.';
  }
  return anyErr?.message ?? 'The relation query failed. You can retry.';
}
