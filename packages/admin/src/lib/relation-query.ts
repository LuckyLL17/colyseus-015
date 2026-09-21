/**
 * Helpers for the list page's single-layer relation query UI. Mirrors the
 * backend grammar in src-backend/catalog/relation-query.ts:
 *
 *   filter key: `<relation>.<column>_<op>` (op defaults to eq)
 *   sort:       `_sort=<relation>.<column>&_order=asc|desc`
 *   existence:  `<relation>._exists` (to-many only)
 *
 * Refine's filter/sorter arrays are the only state — syncWithLocation keeps
 * them in the URL, which is what "preserve the filter conditions" rides on:
 * pagination, reloads and back/forward never drop the active relation query.
 */
import type { Resource, ResourceRelation } from '../types';
import { singlePk } from '../types';

/** A parsed relation filter living in refine's filter array. */
export interface RelationFilter {
  relationName: string;
  field: string;
  op: string;
  value: string;
}

const FIELD_OPS = new Set(['like', 'in', 'eq', 'ne', 'gt', 'gte', 'lt', 'lte']);

export function parseRelationFilterKey(key: string): { relationName: string; field: string; op: string } | null {
  const dot = key.indexOf('.');
  if (dot <= 0) { return null; }
  const relationName = key.slice(0, dot);
  const rest = key.slice(dot + 1);
  const match = rest.match(/^(.*?)_(like|in|eq|ne|gt|gte|lt|lte|exists|null|notnull)$/);
  if (!match) {
    // Bare `rel.field` → eq.
    return { relationName, field: rest, op: 'eq' };
  }
  return { relationName, field: match[1]!, op: match[2]! };
}

/** Find the active relation filter for a given relation+field, if any. */
export function findRelationFilter(
  filters: ReadonlyArray<any> | undefined,
  relationName: string,
  field: string,
): RelationFilter | null {
  for (const f of filters ?? []) {
    if (typeof f?.field !== 'string') { continue; }
    const parsed = parseRelationFilterKey(f.field);
    if (parsed && parsed.relationName === relationName && parsed.field === field) {
      return { ...parsed, value: f.value == null ? '' : String(f.value) };
    }
  }
  return null;
}

/** All active relation filters (used to render active-filter chips). */
export function allRelationFilters(filters: ReadonlyArray<any> | undefined): RelationFilter[] {
  const out: RelationFilter[] = [];
  for (const f of filters ?? []) {
    if (typeof f?.field !== 'string') { continue; }
    const parsed = parseRelationFilterKey(f.field);
    if (parsed && FIELD_OPS.has(parsed.op) && f.value) {
      out.push({ ...parsed, value: String(f.value) });
    }
  }
  return out;
}

/** Build the wire query key for a relation filter, e.g. `org.name_like`. */
export function relationFilterKey(relationName: string, field: string, op: string): string {
  return op === 'eq' ? `${relationName}.${field}` : `${relationName}.${field}_${op}`;
}

/** True when refine's sorter is a relation sort (`<rel>.<field>`). */
export function findRelationSorter(
  sorters: ReadonlyArray<any> | undefined,
): { relationName: string; field: string; order: 'asc' | 'desc' } | null {
  const s = (sorters ?? [])[0];
  if (!s || typeof s.field !== 'string' || !s.field.includes('.')) { return null; }
  const dot = s.field.indexOf('.');
  return {
    relationName: s.field.slice(0, dot),
    field: s.field.slice(dot + 1),
    order: s.order === 'desc' ? 'desc' : 'asc',
  };
}

/** Relations eligible for the relation-query UI: declared relations whose
 *  target is in the catalog and exposes at least one filterable (non-JSON)
 *  column. A single-PK target is only required for the cell-link/expand
 *  surface, not for filtering — composite-PK children (e.g. cloudSaves)
 *  still support to-many existence + value filters. */
export function queryableRelations(resource: Resource, all: Resource[]): Array<{
  relation: ResourceRelation;
  target: Resource;
  fields: Array<{ name: string; label: string }>;
  cardinality: 'one' | 'many';
  singlePkTarget: boolean;
}> {
  const out: ReturnType<typeof queryableRelations> = [];
  for (const relation of resource.relations) {
    const target = all.find((r) => r.name === relation.target);
    if (!target) { continue; }
    const fields = target.columns
      .filter((c) => {
        const dt = c.dataType ?? '';
        if (dt === 'json') { return false; }
        return /^(text|varchar|char|integer|bigint|numeric|real|double|timestamp|boolean|date)/i.test(c.type)
          || dt === 'string' || dt === 'number' || dt === 'boolean' || dt === 'date';
      })
      .slice(0, 8)
      .map((c) => ({ name: c.name, label: c.label }));
    if (fields.length === 0) { continue; }
    out.push({
      relation, target, fields, cardinality: relation.kind,
      singlePkTarget: singlePk(target) !== null,
    });
  }
  return out;
}

/** Human label for an active relation filter chip. */
export function relationFilterLabel(
  filter: RelationFilter,
  resource: Resource,
  all: Resource[],
): string {
  const entry = queryableRelations(resource, all)
    .find((e) => e.relation.name === filter.relationName);
  const relLabel = entry?.relation.label ?? filter.relationName;
  const fieldLabel = entry?.fields.find((f) => f.name === filter.field)?.label ?? filter.field;
  const value = filter.op === 'like' ? `~"${filter.value}"` : `"${filter.value}"`;
  return `${relLabel}.${fieldLabel} ${value}`;
}
