/**
 * Relation filter popover for the list page toolbar. Lets the operator pick
 * one declared (single-hop) relation, one of the target's columns, an
 * operator appropriate to the column type, and a value. The filter lands in
 * refine's filter array keyed `rel.field_op` — syncWithLocation persists it
 * in the URL alongside every other filter/sort/search condition, so paging
 * and reloads preserve the relation query.
 *
 * Deliberately single-layer: the relation picker lists only the base
 * resource's own relations. There is no way to type a second dot segment.
 */
import { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, GitBranch, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import type { Column, Resource } from '../../types';
import { isBoolean, isDate, isNumeric } from '../../types';
import { cn } from '@/lib/utils';
import {
  allRelationFilters, findRelationFilter, findRelationSorter, queryableRelations,
  relationFilterKey, type RelationFilter,
} from '@/lib/relation-query';

export type SetFilters = (filters: any[], behavior?: 'merge' | 'replace') => void;

export function RelationFilterButton({
  resource, allResources, filters, setFilters, sorters, setSorters,
}: {
  resource: Resource;
  allResources: Resource[];
  filters: any[] | undefined;
  setFilters: SetFilters;
  sorters: any[] | undefined;
  setSorters: (s: any[]) => void;
}) {
  const entries = useMemo(() => queryableRelations(resource, allResources), [resource, allResources]);
  const [open, setOpen] = useState(false);
  const [relationName, setRelationName] = useState(entries[0]?.relation.name ?? '');
  const [field, setField] = useState(entries[0]?.fields[0]?.name ?? '');
  const [op, setOp] = useState('like');
  const [value, setValue] = useState('');

  const activeCount = useMemo(() => {
    let n = 0;
    for (const f of filters ?? []) {
      if (typeof f?.field === 'string' && f.field.includes('.') && f.value) { n += 1; }
    }
    return n;
  }, [filters]);

  if (entries.length === 0) { return null; }

  const entry = entries.find((e) => e.relation.name === relationName) ?? entries[0]!;
  const targetColumn: Column | undefined = entry.target.columns.find((c) => c.name === field);

  const pickRelation = (name: string) => {
    const next = entries.find((e) => e.relation.name === name)!;
    setRelationName(name);
    setField(next.fields[0]!.name);
    setOp(defaultOpFor(next.target.columns.find((c) => c.name === next.fields[0]!.name)));
    setValue('');
  };

  const applyExisting = (f: RelationFilter | null) => {
    if (f) { setOp(f.op); setValue(f.value); }
  };

  const apply = () => {
    const trimmed = value.trim();
    if (!trimmed) { return; }
    const key = relationFilterKey(relationName, field, op);
    const others = (filters ?? []).filter((f: any) => {
      if (typeof f.field !== 'string') { return true; }
      // Replace any prior filter on the same relation field (all its ops).
      return !(f.field.startsWith(`${relationName}.${field}_`) || f.field === `${relationName}.${field}`);
    });
    setFilters([...others, { field: key, operator: 'eq', value: trimmed }], 'replace');
    setOpen(false);
  };

  const clearRelation = (name: string) => {
    const others = (filters ?? []).filter((f: any) =>
      typeof f.field !== 'string' || !f.field.startsWith(`${name}.`));
    setFilters(others, 'replace');
  };

  const ops = operatorOptions(targetColumn);

  // When reopening, preselect the first ACTIVE relation filter so the
  // operator sees (and can edit/clear) the existing query instead of a
  // blank form — the conditions persist in the URL regardless.
  const syncToExisting = (entriesArg: typeof entries) => {
    const existing = allRelationFilters(filters)[0];
    const entry = existing
      ? entriesArg.find((e) => e.relation.name === existing.relationName)
      : undefined;
    if (existing && entry) {
      setRelationName(existing.relationName);
      setField(existing.field);
      setOp(existing.op in { like: 1, eq: 1, ne: 1, gt: 1, gte: 1, lt: 1, lte: 1, in: 1 } ? existing.op : 'like');
      setValue(existing.value);
    } else {
      const first = entriesArg[0]!;
      setRelationName(first.relation.name);
      setField(first.fields[0]!.name);
      setOp(defaultOpFor(first.target.columns.find((c) => c.name === first.fields[0]!.name)));
      setValue('');
    }
  };

  return (
    <Popover open={open} onOpenChange={(v) => {
      setOpen(v);
      if (v) { syncToExisting(entries); }
    }}>
      <PopoverTrigger asChild>
        <Button
          variant={activeCount > 0 ? 'default' : 'outline'}
          size="sm"
          data-testid="relation-filter-button"
        >
          <GitBranch className="size-4" />
          Relation
          {activeCount > 0 && <span className="ml-1 rounded bg-primary-foreground/20 px-1 text-xs">{activeCount}</span>}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-3 space-y-3" align="start">
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">Relation (one hop)</label>
          <select
            className="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
            value={relationName}
            onChange={(e) => pickRelation(e.target.value)}
            data-testid="relation-filter-relation"
          >
            {entries.map((e) => (
              <option key={e.relation.name} value={e.relation.name}>
                {e.relation.label} → {e.target.label} ({e.cardinality})
              </option>
            ))}
          </select>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Field</label>
            <select
              className="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
              value={field}
              onChange={(e) => {
                setField(e.target.value);
                setOp(defaultOpFor(entry.target.columns.find((c) => c.name === e.target.value)));
                const existing = findRelationFilter(filters, relationName, e.target.value);
                applyExisting(existing);
              }}
              data-testid="relation-filter-field"
            >
              {entry.fields.map((f) => (
                <option key={f.name} value={f.name}>{f.label}</option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Operator</label>
            <select
              className="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
              value={ops.includes(op) ? op : ops[0]}
              onChange={(e) => setOp(e.target.value)}
              data-testid="relation-filter-op"
            >
              {ops.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          </div>
        </div>
        <Input
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { apply(); } }}
          placeholder={`Filter by ${entry.target.label.toLowerCase()}…`}
          data-testid="relation-filter-value"
        />
        <div className="flex items-center justify-between gap-2">
          <Button size="sm" onClick={apply} disabled={value.trim().length === 0} data-testid="relation-filter-apply">
            Apply
          </Button>
          {findRelationFilter(filters, relationName, field) && (
            <Button
              size="sm" variant="ghost"
              onClick={() => {
                const others = (filters ?? []).filter((f: any) =>
                  typeof f.field !== 'string'
                  || !(f.field.startsWith(`${relationName}.${field}_`) || f.field === `${relationName}.${field}`));
                setFilters(others, 'replace');
                setValue('');
              }}
            >
              Clear this field
            </Button>
          )}
        </div>

        {/* Relation sort — cycles the chosen relation+field through
            asc → desc → none. Rendered as compact buttons so it shares the
            popover without a second toolbar entry point. */}
        <div className="border-t pt-2">
          <div className="mb-1 text-xs font-medium text-muted-foreground">Sort by this field</div>
          <RelationSortToggle
            relationName={relationName}
            field={field}
            sorters={sorters}
            setSorters={setSorters}
          />
        </div>

        {activeCount > 0 && (
          <div className="border-t pt-2 space-y-1">
            <div className="text-xs font-medium text-muted-foreground">Active relation filters</div>
            {activeFilterChips(filters).map((chip) => (
              <button
                key={chip.key}
                type="button"
                onClick={() => clearRelation(chip.relationName)}
                className={cn(
                  'flex w-full items-center justify-between rounded px-2 py-1 text-left text-xs',
                  'bg-accent/50 hover:bg-accent',
                )}
                title="Remove all filters on this relation"
              >
                <span className="truncate">{chip.key}</span>
                <X className="size-3 shrink-0 opacity-60" />
              </button>
            ))}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

function operatorOptions(col: Column | undefined): string[] {
  if (!col) { return ['eq', 'like']; }
  if (isBoolean(col)) { return ['eq', 'ne']; }
  if (isNumeric(col) || isDate(col)) { return ['eq', 'ne', 'gt', 'gte', 'lt', 'lte']; }
  return ['like', 'eq', 'ne'];
}

function defaultOpFor(col: Column | undefined): string {
  if (!col) { return 'eq'; }
  if (isBoolean(col) || isNumeric(col) || isDate(col)) { return 'eq'; }
  return 'like';
}

function activeFilterChips(filters: ReadonlyArray<any> | undefined): Array<{ key: string; relationName: string }> {
  const seen = new Map<string, string>();
  for (const f of filters ?? []) {
    if (typeof f?.field !== 'string' || !f.field.includes('.') || !f.value) { continue; }
    const relationName = f.field.slice(0, f.field.indexOf('.'));
    const label = `${relationName}: ${String(f.value)}`;
    if (!seen.has(relationName)) { seen.set(relationName, label); }
  }
  return [...seen.entries()].map(([relationName, key]) => ({ relationName, key }));
}

function RelationSortToggle({
  relationName, field, sorters, setSorters,
}: {
  relationName: string;
  field: string;
  sorters: any[] | undefined;
  setSorters: (s: any[]) => void;
}) {
  const key = `${relationName}.${field}`;
  const active = findRelationSorter(sorters);
  const state = active && active.relationName === relationName && active.field === field
    ? active.order
    : null;

  const cycle = (next: 'asc' | 'desc' | null) => {
    if (next === null) { setSorters([]); return; }
    setSorters([{ field: key, order: next }]);
  };

  return (
    <div className="flex items-center gap-1">
      <Button
        size="sm"
        variant={state === 'asc' ? 'default' : 'outline'}
        onClick={() => cycle(state === 'asc' ? null : 'asc')}
        data-testid="relation-sort-asc"
      >
        <ArrowUp className="size-3" /> Asc
      </Button>
      <Button
        size="sm"
        variant={state === 'desc' ? 'default' : 'outline'}
        onClick={() => cycle(state === 'desc' ? null : 'desc')}
        data-testid="relation-sort-desc"
      >
        <ArrowDown className="size-3" /> Desc
      </Button>
      {state && (
        <Button size="sm" variant="ghost" onClick={() => cycle(null)}>
          <X className="size-3" /> None
        </Button>
      )}
    </div>
  );
}
