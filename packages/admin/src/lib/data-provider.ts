/**
 * Admin data provider — a thin wrapper around @refinedev/simple-rest that
 * adds the panel's relation-aware bits without forking the provider:
 *
 *   - Relation filters round-trip untouched: refine stores them as
 *     `field: 'org.name_like'`, and simple-rest's filter serializer passes
 *     dotted keys straight into the query string the backend expects.
 *   - `meta.relationExpand: ['org']` on a getList call appends
 *     `&_expand=org,team`, which embeds related rows under `row._relations`
 *     in one batched server-side fetch per relation.
 *
 * Only the expanded variant needs custom URL building; every other method
 * delegates to the stock provider unchanged.
 */
import dataProvider from '@refinedev/simple-rest';
import type { DataProvider, GetListParams, MetaQuery } from '@refinedev/core';
import axios from 'axios';

export type AdminDataProvider = DataProvider;

function toQueryString(query: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) { continue; }
    if (Array.isArray(value)) {
      for (const v of value) { params.append(key, String(v)); }
    } else {
      params.set(key, String(value));
    }
  }
  return params.toString();
}

/** Mirror simple-rest's filter/sort serializers for the expanded request,
 *  so the wire encoding stays identical to the stock getList. */
function serializeFilters(filters: GetListParams['filters']): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of filters ?? []) {
    if (!('field' in f)) { continue; } // conditional filters unsupported here
    const operatorSuffix = (() => {
      switch (f.operator) {
        case 'ne': return '_ne';
        case 'gte': return '_gte';
        case 'lte': return '_lte';
        case 'contains': return '_like';
        default: return '';
      }
    })();
    if (f.field === 'q') { out[f.field] = f.value; continue; }
    out[`${f.field}${operatorSuffix}`] = f.value;
  }
  return out;
}

function serializeSorters(sorters: GetListParams['sorters']): Record<string, string> {
  if (!sorters || sorters.length === 0) { return {}; }
  return {
    _sort: sorters.map((s) => s.field).join(','),
    _order: sorters.map((s) => s.order).join(','),
  };
}

export function createAdminDataProvider(
  apiUrl: string,
  http = axios.create({ withCredentials: true }),
): DataProvider {
  const base = dataProvider(apiUrl, http);

  return {
    ...base,
    getList: async (params: GetListParams) => {
      const expand = (params.meta as (MetaQuery & { relationExpand?: string[] }) | undefined)?.relationExpand;
      if (!expand || expand.length === 0) {
        return base.getList(params);
      }

      const current = params.pagination?.current ?? 1;
      const pageSize = params.pagination?.pageSize ?? 25;
      const query: Record<string, unknown> = {
        _start: (current - 1) * pageSize,
        _end: current * pageSize,
        ...serializeFilters(params.filters),
        ...serializeSorters(params.sorters),
        _expand: expand.join(','),
      };
      const res = await http.get(`${apiUrl}/${params.resource}?${toQueryString(query)}`);
      return {
        data: res.data,
        total: Number(res.headers['x-total-count'] ?? res.data?.length ?? 0),
      };
    },
  };
}
