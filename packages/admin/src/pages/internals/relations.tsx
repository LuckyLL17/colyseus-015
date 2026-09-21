/**
 * Show/Edit page extras around relations:
 *  - Profilerow: dt/dd grid pair
 *  - useRelationCounts: single bulk fetch for all many-relation tab labels
 *  - RelationTabLabel: small wrapper that displays the count
 *  - RelatedTable: cursor-paginated mini-table inside a many-relation tab
 *    (filter/sort by the TARGET's own columns, stable cursor paging,
 *    recoverable error banner — the query state lives in the tab-pinned
 *    URL so filters survive reload/back/forward)
 *  - OneRelationLink: small badge linking to the one-relation target
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { AlertTriangle, ArrowDown, ArrowUp, ChevronLeft, ChevronRight, ChevronsUpDown, Eye, Loader2, Pencil, Plus } from 'lucide-react';
import { DataCell } from './data-cell';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Empty } from '@/components/ui/empty';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { type Column, type Resource, type ResourceRelation, isJsonish, singlePk, rowId } from '../../types';
import { findResource, pickLabelColumn, visibleColumns } from './helpers';
import { formatCell } from './format-cell';
import { ColumnFilter } from './filters';
import { iconFor } from '../../icons';
import { API } from '@/lib/runtime-config';

export function Profilerow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-sm font-medium text-muted-foreground">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </>
  );
}

/**
 * Single fetch for all many-relation counts on a resource detail page.
 * Replaces N per-tab `_start=0&_end=1` calls with one request — server
 * runs the per-relation count(*)s in Promise.all. Returns `null` while
 * the request is in flight so labels can hide the count until it lands.
 */
export function useRelationCounts(
  resource: string | undefined,
  id: string | undefined,
): Record<string, number> | null {
  const [counts, setCounts] = useState<Record<string, number> | null>(null);
  useEffect(() => {
    if (!resource || !id) { return; }
    let cancelled = false;
    fetch(`${API}/${resource}/${encodeURIComponent(id)}/_counts`, { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => { if (!cancelled) { setCounts(data); } })
      .catch(() => { if (!cancelled) { setCounts(null); } });
    return () => { cancelled = true; };
  }, [resource, id]);
  return counts;
}

export function RelationTabLabel({
  relation, count, targetIcon,
}: {
  relation: ResourceRelation;
  count: number | undefined;
  /** Lucide icon id from the target resource's catalog entry. When
   *  omitted the label renders without an icon — same surface as
   *  before, so non-relation use sites stay opt-in. */
  targetIcon?: string;
}) {
  return (
    <span className="inline-flex items-center gap-1.5" data-testid={`tab-relation-${relation.name}`}>
      {targetIcon && iconFor(targetIcon)}
      <span>
        {relation.label}{count !== undefined ? ` (${count})` : ''}
      </span>
    </span>
  );
}

/**
 * Build the relation-tab query state from URL params. The tab-pinned URL
 * (`/users/show/:id/<relation>`) keeps each tab's filters/sort/cursor
 * independently: we namespace every key with `rel.<relation>.` so switching
 * tabs restores each tab's own query and back/forward keeps working.
 *
 * State shape (in search params):
 *   rel.<rel>.f       → base64url JSON array of refine-style filters
 *   rel.<rel>.s       → "<field>:asc|desc"
 *   rel.<rel>.page    → page number (for display; cursor drives the query)
 *   rel.<rel>.cursor  → opaque cursor for the CURRENT page (first page: absent)
 */
function relStateKey(relation: string, kind: 'f' | 's' | 'page' | 'cursor') {
  return `rel.${relation}.${kind}`;
}

interface RelFilters { field: string; operator?: string; value: unknown }
interface RelSorter { field: string; order: 'asc' | 'desc' }

function readFilters(raw: string | null): RelFilters[] {
  if (!raw) { return []; }
  try {
    let b64 = raw.replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) { b64 += '='; }
    const parsed = JSON.parse(atob(b64));
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

function writeFilters(filters: RelFilters[]): string {
  const b64 = btoa(JSON.stringify(filters));
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function readSorter(raw: string | null): RelSorter | undefined {
  if (!raw) { return undefined; }
  const [field, order] = raw.split(':');
  if (!field || (order !== 'asc' && order !== 'desc')) { return undefined; }
  return { field, order };
}

/**
 * Convert the tab's filter/sorter state into the backend query string.
 * Bare params are correct here — the relation endpoint is path-scoped to
 * the relation, so its target columns are addressed without a dotted
 * prefix.
 */
function relationQueryString(opts: {
  filters: RelFilters[];
  sorter?: RelSorter;
  cursor?: string | null;
  limit: number;
}): string {
  const params = new URLSearchParams();
  params.set('_limit', String(opts.limit));
  if (opts.cursor) { params.set('_cursor', opts.cursor); }
  if (opts.sorter) {
    params.set('_sort', opts.sorter.field);
    params.set('_order', opts.sorter.order);
  }
  for (const f of opts.filters) {
    if (f.value === undefined || f.value === null || f.value === '') { continue; }
    params.set(f.field, String(f.value));
  }
  return params.toString();
}

const RELATED_PAGE_SIZE = 20;

export function RelatedTable({
  parentResource, parentId, relation, resources,
}: {
  parentResource: string; parentId: string; relation: ResourceRelation; resources: Resource[];
}) {
  const targetDef = findResource(resources, relation.target);
  const [searchParams, setSearchParams] = useSearchParams();

  const fKey = relStateKey(relation.name, 'f');
  const sKey = relStateKey(relation.name, 's');
  const cursorKey = relStateKey(relation.name, 'cursor');
  const pageKey = relStateKey(relation.name, 'page');

  const filters = useMemo(() => readFilters(searchParams.get(fKey)), [searchParams, fKey]);
  const sorter = readSorter(searchParams.get(sKey));
  const cursor = searchParams.get(cursorKey) ?? null;
  const page = Math.max(1, parseInt(searchParams.get(pageKey) ?? '1') || 1);

  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  // Opaque cursor the server returned for the page AFTER the current one.
  const [nextCursorToken, setNextCursorToken] = useState<string | null>(null);
  // Cursor stack — the cursor of page N is the token returned at the end of
  // page N-1. Walking back pops the stack; the URL keeps only the current
  // page's cursor (all that a reload/bookmark needs).
  const [cursorStack, setCursorStack] = useState<string[]>([]);

  const patchParams = useCallback((mutate: (p: URLSearchParams) => void) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      mutate(next);
      return next;
    });
  }, [setSearchParams]);

  const resetPaging = useCallback((p: URLSearchParams) => {
    p.delete(cursorKey);
    p.set(pageKey, '1');
    setCursorStack([]);
  }, [cursorKey, pageKey]);

  const setFilterList = useCallback((next: RelFilters[]) => {
    patchParams((p) => {
      if (next.length === 0) { p.delete(fKey); }
      else { p.set(fKey, writeFilters(next)); }
      resetPaging(p);
    });
  }, [patchParams, fKey, resetPaging]);

  const onSortColumn = useCallback((field: string) => {
    patchParams((p) => {
      const current = readSorter(p.get(sKey));
      // three-state cycle driven from the header: off → asc → desc → off
      if (current?.field === field) {
        if (current.order === 'asc') { p.set(sKey, `${field}:desc`); }
        else { p.delete(sKey); }
      } else {
        p.set(sKey, `${field}:asc`);
      }
      resetPaging(p);
    });
  }, [patchParams, sKey, resetPaging]);

  const onClearSort = useCallback(() => {
    patchParams((p) => { p.delete(sKey); resetPaging(p); });
  }, [patchParams, sKey, resetPaging]);

  const queryString = relationQueryString({ filters, sorter, cursor, limit: RELATED_PAGE_SIZE });
  const url = `${API}/${parentResource}/${parentId}/relations/${relation.name}?${queryString}`;

  const reload = useCallback((signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    fetch(url, { credentials: 'include', signal })
      .then(async (r) => {
        if (!r.ok) {
          let message = `request failed (${r.status})`;
          try {
            const body = await r.json();
            if (body?.error) { message = body.error; }
          } catch { /* keep status message */ }
          throw new Error(message);
        }
        const nextCursor = r.headers.get('x-next-cursor') ?? null;
        const data = await r.json() as any[];
        if (signal?.aborted) { return; }
        setRows(data);
        // Header present but empty string → last page.
        setHasMore(nextCursor !== null && nextCursor !== '');
        setNextCursorToken(nextCursor && nextCursor !== '' ? nextCursor : null);
      })
      .catch((err: any) => {
        if (err?.name === 'AbortError') { return; }
        setError(err?.message ?? 'request failed');
      })
      .finally(() => { if (!signal?.aborted) { setLoading(false); } });
  }, [url]);

  useEffect(() => {
    const ctrl = new AbortController();
    reload(ctrl.signal);
    return () => ctrl.abort();
  }, [reload]);

  if (!targetDef) { return <Empty title={`unknown target resource '${relation.target}'`} />; }

  const onNext = () => {
    if (!nextCursorToken) { return; }
    patchParams((p) => {
      p.set(cursorKey, nextCursorToken);
      p.set(pageKey, String(page + 1));
    });
    if (cursor) { setCursorStack((s) => [...s, cursor]); }
  };
  const onPrev = () => {
    if (page <= 1) { return; }
    const prevCursor = cursorStack[cursorStack.length - 1] ?? null;
    setCursorStack((s) => s.slice(0, -1));
    patchParams((p) => {
      if (prevCursor) { p.set(cursorKey, prevCursor); }
      else { p.delete(cursorKey); }
      p.set(pageKey, String(page - 1));
    });
  };

  return (
    <RelatedTableView
      parentResource={parentResource}
      parentId={parentId}
      relation={relation}
      targetDef={targetDef}
      rows={rows}
      loading={loading}
      error={error}
      onRetry={() => reload()}
      page={page}
      hasMore={hasMore}
      onPrev={onPrev}
      onNext={onNext}
      filters={filters}
      setFilters={setFilterList}
      sorter={sorter}
      onSortColumn={onSortColumn}
      onClearSort={onClearSort}
    />
  );
}

/**
 * Pure render of the related-rows table. Extracted from `RelatedTable`
 * so the markup is reachable from `react-dom/server.renderToString`
 * without driving the data-fetch effect (see related-table.test.tsx).
 */
export function RelatedTableView({
  parentResource, parentId, relation, targetDef,
  rows, loading, error, onRetry, page, hasMore, onPrev, onNext,
  filters, setFilters, sorter, onSortColumn, onClearSort,
}: {
  parentResource: string;
  parentId: string;
  relation: ResourceRelation;
  targetDef: Resource;
  rows: any[];
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  page: number;
  hasMore: boolean;
  onPrev: () => void;
  onNext: () => void;
  filters: RelFilters[];
  setFilters: (f: RelFilters[]) => void;
  sorter?: RelSorter;
  onSortColumn: (field: string) => void;
  onClearSort: () => void;
}) {
  const navigate = useNavigate();
  const cols = visibleColumns(targetDef, targetDef.listColumns);
  const newHref = `/${relation.target}/create?_prefill_${relation.fk}=${encodeURIComponent(parentId)}`;

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button asChild size="sm" variant="outline" data-testid={`new-related-${relation.name}`}>
          <Link to={newHref}><Plus />New {targetDef.label}</Link>
        </Button>
      </div>
      <div data-testid={`related-${relation.name}`}>
        {error && (
          <div
            role="alert"
            data-testid="related-error"
            className="mb-3 flex items-center gap-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            <AlertTriangle className="size-4 shrink-0" />
            <span className="flex-1">
              Couldn’t load {targetDef.label.toLowerCase()}: {error}. Filters are preserved.
            </span>
            <Button size="sm" variant="outline" onClick={onRetry} data-testid="related-error-retry">
              Retry
            </Button>
          </div>
        )}
        {loading && rows.length === 0 ? (
          <div className="flex items-center justify-center py-10 text-muted-foreground">
            <Loader2 className="size-4 animate-spin mr-2" />
          </div>
        ) : !error && rows.length === 0 ? (
          <Empty title={`no ${targetDef.label.toLowerCase()} yet`}>
            <Button asChild size="sm" variant="outline">
              <Link to={newHref}><Plus />Create one</Link>
            </Button>
          </Empty>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                {cols.map((c) => (
                  <TableHead key={c.name}>
                    <RelatedColumnHeader
                      column={c}
                      filters={filters}
                      setFilters={setFilters}
                      sorter={sorter}
                      onSort={onSortColumn}
                      onClearSort={onClearSort}
                    />
                  </TableHead>
                ))}
                <TableHead className="w-24" aria-label="" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row, i) => {
                const childId = rowId(targetDef, row);
                const drillIn = childId
                  ? () => navigate(`/${parentResource}/show/${parentId}/${relation.name}/${childId}`)
                  : undefined;
                return (
                <TableRow key={childId ?? i}>
                  {cols.map((c) => (
                    <DataCell key={c.name} column={c} onNavigate={drillIn}>
                      {formatCell(row[c.name], c)}
                    </DataCell>
                  ))}
                  <TableCell className="w-24 text-right">
                    {childId && (
                      <div className="inline-flex items-center gap-1">
                        <Button
                          asChild variant="ghost" size="icon"
                          data-testid={`related-view-${relation.name}-${childId}`}
                        >
                          <Link
                            to={`/${parentResource}/show/${parentId}/${relation.name}/${childId}`}
                            aria-label={`View ${targetDef.label}`}
                          >
                            <Eye className="size-4" />
                          </Link>
                        </Button>
                        <Button
                          asChild variant="ghost" size="icon"
                          data-testid={`related-edit-${relation.name}-${childId}`}
                        >
                          <Link
                            to={`/${relation.target}/edit/${encodeURIComponent(childId)}?returnTo=${encodeURIComponent(`/${parentResource}/show/${parentId}/${relation.name}`)}`}
                            aria-label={`Edit ${targetDef.label}`}
                          >
                            <Pencil className="size-4" />
                          </Link>
                        </Button>
                      </div>
                    )}
                  </TableCell>
                </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
        {/* Cursor pager — prev/next only (no total round-trip). A failed
            fetch keeps prior rows and pager state intact; a retry reruns
            the same cursor+filter request. */}
        {!error && rows.length > 0 && (page > 1 || hasMore) && (
          <div className="mt-4 flex items-center justify-between text-sm text-muted-foreground">
            <div>Page {page}</div>
            <div className="flex items-center gap-1">
              <Button variant="outline" size="icon" disabled={page <= 1 || loading} onClick={onPrev}>
                <ChevronLeft />
              </Button>
              <Button variant="outline" size="icon" disabled={!hasMore || loading} onClick={onNext}>
                <ChevronRight />
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Column header for the relation tab: per-target-column filter (same popover
 * pickers as the main list — bare field names here since the relation
 * endpoint is already path-scoped) + a three-state sort control.
 */
function RelatedColumnHeader({
  column: c, filters, setFilters, sorter, onSort, onClearSort,
}: {
  column: Column;
  filters: RelFilters[];
  setFilters: (f: RelFilters[]) => void;
  sorter?: RelSorter;
  onSort: (field: string) => void;
  onClearSort: () => void;
}) {
  const sort = sorter?.field === c.name ? sorter : undefined;
  const cycle = () => {
    if (!sort) { onSort(c.name); }
    else if (sort.order === 'asc') { onSort(c.name); }
    else { onClearSort(); }
  };
  const filterCount = (filters ?? []).filter((f) =>
    f.field === c.name || f.field.startsWith(`${c.name}_`)).length;
  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        onClick={cycle}
        className="inline-flex items-center gap-1 rounded px-1 py-0.5 hover:bg-accent hover:text-accent-foreground"
        data-testid={`related-sort-${c.name}`}
      >
        <span>{c.label}</span>
        {sort?.order === 'asc' ? <ArrowUp className="size-3" />
          : sort?.order === 'desc' ? <ArrowDown className="size-3" />
          : <ChevronsUpDown className="size-3 opacity-40" />}
      </button>
      {!isJsonish(c) && (
        <ColumnFilter
          c={c}
          filters={filters}
          setFilters={(next: any[]) => {
            // Same replace-one-column semantics the main list filter uses.
            const others = filters.filter((f) =>
              !(f.field === c.name || f.field.startsWith(`${c.name}_`)));
            setFilters([...others, ...next]);
          }}
          active={filterCount > 0}
        />
      )}
    </div>
  );
}

export function OneRelationLink({
  parentResource, parentId, relation, resources,
}: {
  parentResource: string; parentId: string; relation: ResourceRelation; resources: Resource[];
}) {
  const targetDef = findResource(resources, relation.target);
  const [row, setRow] = useState<any | null>(null);
  const [empty, setEmpty] = useState(false);
  useEffect(() => {
    fetch(`${API}/${parentResource}/${parentId}/relations/${relation.name}?_start=0&_end=1`, {
      credentials: 'include',
    })
      .then(async (r) => (r.ok ? (await r.json()) as any[] : []))
      .then((rows) => {
        if (rows.length === 0) { setEmpty(true); }
        else { setRow(rows[0]); }
      })
      .catch(() => setEmpty(true));
  }, [parentResource, parentId, relation.name]);

  if (empty) { return <Badge variant="secondary">{relation.label}: <em className="not-italic ml-1 text-muted-foreground">none</em></Badge>; }
  if (!row || !targetDef) { return <Badge variant="secondary">{relation.label}: …</Badge>; }
  const targetPk = singlePk(targetDef);
  if (!targetPk) { return <Badge variant="info">{relation.label}</Badge>; }
  // Prefer the target's label column for the badge text; fall back to the
  // raw PK so badges always say *something* useful. The fetch above already
  // returned the full row, so this adds zero queries.
  const labelCol = pickLabelColumn(targetDef);
  const display = (labelCol && row[labelCol] != null && row[labelCol] !== '')
    ? String(row[labelCol])
    : String(row[targetPk]);
  return (
    <Link to={`/${relation.target}/show/${row[targetPk]}`} data-testid={`one-relation-${relation.name}`}>
      <Badge variant="info" className="hover:opacity-90">{relation.label}: {display}</Badge>
    </Link>
  );
}
