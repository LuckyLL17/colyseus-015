/**
 * Single-hop relation query controls for the resource list page.
 *
 * Renders a popover that lets the user constrain/sort/expand by ONE
 * declared relation:
 *   - filter on a related column (`<rel>.<col>[_op]`)
 *   - "rows with no related rows" (`<rel>._null=true`)
 *   - sort by a related column (`_sort=<rel>.<col>`)
 *   - expand the related rows into the response (`_expand=<rel>`)
 *
 * Everything is written through refine's filter/sorter arrays, so it
 * syncs with the URL (syncWithLocation), survives navigation, back/
 * forward and page reloads — the same mechanism the own-column filters
 * already use. The backend accepts exactly one relation per request, so
 * applying a different relation replaces the previous one wholesale.
 */
import { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Filter, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Badge } from '@/components/ui/badge';
import { type Column, type Resource, type ResourceRelation, isBoolean, isDate, isJsonish, isNumeric } from '../../types';
import { findResource } from './helpers';
import { cn } from '@/lib/utils';

// Kept structurally loose on purpose: refine's CrudFilter is a discriminated
// union that also includes conditional/or filters, and simple-rest serializes
// plain {field, operator, value} entries. The relation bar only ever emits
// those plain entries, so we type the wire shape and cast at the list page
// boundary where refine's full types flow in.
export type RefineFilter = { field: string; operator?: any; value: unknown };
export type RefineSorter = { field: string; order: 'asc' | 'desc' };

const OP_SUFFIX: Record<string, string> = {
  like: '_like', eq: '', ne: '_ne', gt: '_gt', gte: '_gte', lt: '_lt', lte: '_lte', in: '_in',
};

/** Every filter field this bar (and its relation) owns, for cleanup/replace. */
function relationPrefix(relationName: string) { return `${relationName}.`; }

export function activeRelationFilter(filters: RefineFilter[] | undefined, relations: ResourceRelation[]): {
  relation: ResourceRelation | null;
  /** Filters addressed at the active relation (incl. `_null`). */
  entries: RefineFilter[];
  expand: boolean;
  sort?: RefineSorter;
} {
  const entries = (filters ?? []).filter((f) => typeof f.field === 'string' && f.field.includes('.'));
  const expandValue = (filters ?? []).find((f) => f.field === '_expand')?.value as string | undefined;
  let relation: ResourceRelation | null = null;
  const nameFromEntry = entries[0]?.field.split('.')[0];
  const name = nameFromEntry ?? expandValue;
  if (name) { relation = relations.find((r) => r.name === name) ?? null; }
  return {
    relation,
    entries: relation
      ? entries.filter((f) => f.field.startsWith(relationPrefix(relation!.name)))
      : [],
    expand: !!expandValue && relation?.name === expandValue,
  };
}

export function RelationQueryBar({
  def, resources, filters, setFilters, sorters, setSorters,
}: {
  def: Resource;
  resources: Resource[];
  filters: RefineFilter[] | undefined;
  setFilters: (f: RefineFilter[], behavior?: 'merge' | 'replace') => void;
  sorters: RefineSorter[] | undefined;
  setSorters: (s: RefineSorter[]) => void;
}) {
  const relations = def.relations ?? [];
  const active = useMemo(
    () => activeRelationFilter(filters, relations),
    [filters, relations],
  );
  const relatedSort = sorters?.find((s) => s.field.includes('.'));
  const [open, setOpen] = useState(false);

  if (relations.length === 0) { return null; }

  const activeCount = active.entries.length + (active.expand ? 1 : 0) + (relatedSort ? 1 : 0);

  const clearRelation = () => {
    const others = (filters ?? []).filter((f) => {
      if (f.field === '_expand') { return false; }
      return !(typeof f.field === 'string' && f.field.includes('.'));
    });
    setFilters(others, 'replace');
    setSorters((sorters ?? []).filter((s) => !s.field.includes('.')));
  };

  return (
    <div className="flex items-center gap-2">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant={activeCount > 0 ? 'default' : 'outline'}
            size="sm"
            data-testid="relation-query-trigger"
          >
            <Filter className="size-3.5" />
            Related
            {activeCount > 0 && (
              <Badge variant="secondary" className="ml-1 h-4 px-1 text-[10px]">{activeCount}</Badge>
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-80 p-3" align="start">
          <RelationForm
            def={def}
            resources={resources}
            relations={relations}
            active={active}
            relatedSort={relatedSort}
            onCancel={() => setOpen(false)}
            onApply={(next) => {
              // Replace everything dotted + _expand, keeping _q and own filters.
              const kept = (filters ?? []).filter((f) =>
                f.field !== '_expand' && !(typeof f.field === 'string' && f.field.includes('.')));
              const nextFilters: RefineFilter[] = [
                ...kept,
                ...next.entries,
                ...(next.expand ? [{ field: '_expand', operator: 'eq', value: next.relationName }] : []),
              ];
              setFilters(nextFilters, 'replace');
              const ownSorters = (sorters ?? []).filter((s) => !s.field.includes('.'));
              setSorters(next.sort ? [...ownSorters, next.sort] : ownSorters);
              setOpen(false);
            }}
          />
        </PopoverContent>
      </Popover>

      {active.relation && activeCount > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          {active.entries.map((f) => (
            <RelationChip key={`${f.field}:${String(f.value)}`} filter={f} onRemove={() => {
              setFilters((filters ?? []).filter((x) => x !== f), 'replace');
            }} />
          ))}
          {relatedSort && (
            <Badge variant="secondary" className="gap-1" data-testid="relation-sort-chip">
              {relatedSort.order === 'desc' ? <ArrowDown className="size-3" /> : <ArrowUp className="size-3" />}
              sort: {relatedSort.field}
              <button
                type="button"
                aria-label="clear related sort"
                onClick={() => setSorters((sorters ?? []).filter((s) => s !== relatedSort))}
              >
                <X className="size-3" />
              </button>
            </Badge>
          )}
          {active.expand && (
            <Badge variant="secondary" className="gap-1" data-testid="relation-expand-chip">
              expand: {active.relation.name}
              <button
                type="button"
                aria-label="clear expansion"
                onClick={() => setFilters((filters ?? []).filter((f) => f.field !== '_expand'), 'replace')}
              >
                <X className="size-3" />
              </button>
            </Badge>
          )}
          <Button variant="ghost" size="sm" onClick={clearRelation} data-testid="relation-query-clear">
            Clear
          </Button>
        </div>
      )}
    </div>
  );
}

function RelationChip({ filter, onRemove }: { filter: RefineFilter; onRemove: () => void }) {
  const [relation, fieldWithOp] = filter.field.split('.');
  return (
    <Badge variant="secondary" className="gap-1" data-testid={`relation-chip-${filter.field}`}>
      <span className="font-medium">{relation}</span>.{fieldWithOp}
      {filter.value !== undefined && filter.value !== '' ? ` = ${String(filter.value)}` : ''}
      <button type="button" aria-label={`remove ${filter.field} filter`} onClick={onRemove}>
        <X className="size-3" />
      </button>
    </Badge>
  );
}

function RelationForm({
  def, resources, relations, active, relatedSort, onApply, onCancel,
}: {
  def: Resource;
  resources: Resource[];
  relations: ResourceRelation[];
  active: ReturnType<typeof activeRelationFilter>;
  relatedSort?: RefineSorter;
  onApply: (next: { relationName: string; entries: RefineFilter[]; expand: boolean; sort?: RefineSorter }) => void;
  onCancel: () => void;
}) {
  const [relationName, setRelationName] = useState(active.relation?.name ?? relations[0]!.name);
  const relation = relations.find((r) => r.name === relationName)!;
  const targetDef = findResource(resources, relation.target);

  // One column filter, the `_null` switch, sort + expand. Enough for the
  // single-hop scope; a second column on the same relation is supported via
  // repeated Apply? No — we replace on apply, so one entry keeps the form
  // honest with the backend's single-relation-per-request rule while still
  // allowing one `_gte`/`_lte` range pair via the range inputs below.
  const columns = (targetDef?.columns ?? []).filter((c) => !isJsonish(c));
  const initialEntry = active.entries.find((f) => !f.field.endsWith('._null'));
  const initialField = initialEntry?.field.split('.').slice(1).join('.') ?? columns[0]?.name;
  const [columnName, setColumnName] = useState<string>(initialField ?? '');
  const [op, setOp] = useState<string>(inferOp(initialEntry?.field, initialEntry));
  const [value, setValue] = useState<string>(
    initialEntry?.value === undefined || initialEntry?.value === null ? '' : String(initialEntry.value));
  const [value2, setValue2] = useState<string>('');
  const [nullOnly, setNullOnly] = useState<boolean>(
    active.entries.some((f) => f.field.endsWith('._null') && f.value === true));
  const [sortDir, setSortDir] = useState<'' | 'asc' | 'desc'>(
    relatedSort?.field === `${relation.name}.${initialField}` ? (relatedSort.order) : '');
  const [expand, setExpand] = useState<boolean>(active.expand && active.relation?.name === relationName);

  const column: Column | undefined = columns.find((c) => c.name === columnName);

  // Reset the operator when the chosen column changes type.
  const changeColumn = (name: string) => {
    setColumnName(name);
    const c = columns.find((x) => x.name === name);
    setOp(!c ? 'like' : isNumeric(c) ? 'gte' : isDate(c) ? 'gte' : isBoolean(c) ? 'eq' : 'like');
    setValue(''); setValue2('');
  };

  const submit = () => {
    const entries: RefineFilter[] = [];
    if (nullOnly) {
      entries.push({ field: `${relation.name}._null`, operator: 'eq', value: true });
    } else if (columnName && value.trim() !== '') {
      const suffix = OP_SUFFIX[op] ?? '';
      entries.push({ field: `${relation.name}.${columnName}${suffix}`, operator: 'eq', value: value.trim() });
      // Range pair for gte + lte on number/date.
      if ((op === 'gte' || op === 'lte') && value2.trim() !== '') {
        const other = op === 'gte' ? 'lte' : 'gte';
        entries.push({ field: `${relation.name}.${columnName}_${other}`, operator: 'eq', value: value2.trim() });
      }
    }
    onApply({
      relationName: relation.name,
      entries,
      expand,
      sort: sortDir && columnName
        ? { field: `${relation.name}.${columnName}`, order: sortDir }
        : undefined,
    });
  };

  return (
    <div className="space-y-3" data-testid="relation-query-form">
      <div className="space-y-1">
        <label className="text-xs font-medium text-muted-foreground">Relation</label>
        <select
          className="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
          value={relationName}
          onChange={(e) => {
            const nextRelation = relations.find((r) => r.name === e.target.value)!;
            setRelationName(e.target.value);
            const nextTarget = findResource(resources, nextRelation.target);
            const firstCol = nextTarget?.columns.find((c) => !isJsonish(c));
            setColumnName(firstCol?.name ?? '');
            setOp(firstCol && isNumeric(firstCol) ? 'gte' : firstCol && isDate(firstCol) ? 'gte' : 'like');
            setValue(''); setValue2('');
          }}
          data-testid="relation-query-relation"
        >
          {relations.map((r) => (
            <option key={r.name} value={r.name}>{r.label} → {findResource(resources, r.target)?.label ?? r.target}</option>
          ))}
        </select>
      </div>

      <div className="space-y-1">
        <label className="text-xs font-medium text-muted-foreground">Related column</label>
        <select
          className="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
          value={columnName}
          onChange={(e) => changeColumn(e.target.value)}
          data-testid="relation-query-column"
        >
          {columns.map((c) => <option key={c.name} value={c.name}>{c.label}</option>)}
        </select>
      </div>

      {!nullOnly && column ? (
        <ColumnValueInput
          column={column}
          op={op}
          setOp={setOp}
          value={value}
          setValue={setValue}
          value2={value2}
          setValue2={setValue2}
        />
      ) : null}

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={nullOnly}
          onChange={(e) => setNullOnly(e.target.checked)}
          data-testid="relation-query-null"
        />
        Only rows with no {relation.label.toLowerCase()}
      </label>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={expand}
          onChange={(e) => setExpand(e.target.checked)}
          data-testid="relation-query-expand"
        />
        Expand {relation.label} in results
      </label>

      <div className="space-y-1">
        <label className="text-xs font-medium text-muted-foreground">Sort by this column</label>
        <div className="flex gap-1">
          {(['', 'asc', 'desc'] as const).map((d) => (
            <Button
              key={d || 'off'}
              type="button"
              size="sm"
              variant={sortDir === d ? 'default' : 'outline'}
              onClick={() => setSortDir(d)}
              data-testid={`relation-query-sort-${d || 'off'}`}
            >
              {d === 'asc' ? 'Asc' : d === 'desc' ? 'Desc' : 'Off'}
            </Button>
          ))}
        </div>
      </div>

      <div className="flex justify-end gap-2 pt-1">
        <Button type="button" size="sm" variant="outline" onClick={onCancel}>Cancel</Button>
        <Button type="button" size="sm" onClick={submit} data-testid="relation-query-apply">Apply</Button>
      </div>
    </div>
  );
}

function inferOp(fieldWithSuffix: string | undefined, entry: RefineFilter | undefined): string {
  if (!fieldWithSuffix || !entry) { return 'like'; }
  const m = fieldWithSuffix.match(/_(like|in|eq|ne|gt|gte|lt|lte)$/);
  return m ? m[1]! : 'eq';
}

function ColumnValueInput({
  column, op, setOp, value, setValue, value2, setValue2,
}: {
  column: Column;
  op: string;
  setOp: (op: string) => void;
  value: string; setValue: (v: string) => void;
  value2: string; setValue2: (v: string) => void;
}) {
  const numeric = isNumeric(column);
  const date = isDate(column);
  const boolean = isBoolean(column);

  if (boolean) {
    return (
      <div className="flex gap-1">
        {['true', 'false'].map((v) => (
          <Button
            key={v} type="button" size="sm"
            variant={value === v ? 'default' : 'outline'}
            onClick={() => { setOp('eq'); setValue(v); }}
            data-testid={`relation-query-bool-${v}`}
          >
            {v === 'true' ? 'Yes' : 'No'}
          </Button>
        ))}
      </div>
    );
  }

  const range = numeric || date;
  const ops = range ? ['gte', 'lte', 'eq'] : ['like', 'eq', 'ne'];
  return (
    <div className="space-y-1">
      <select
        className="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
        value={op}
        onChange={(e) => setOp(e.target.value)}
        data-testid="relation-query-op"
      >
        {ops.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
      <Input
        type={numeric ? 'number' : date ? 'datetime-local' : 'text'}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={range ? (op === 'gte' ? 'from' : op === 'lte' ? 'value' : 'exact') : `match ${column.label}`}
        data-testid="relation-query-value"
      />
      {(op === 'gte' || op === 'lte') && (
        <Input
          type={numeric ? 'number' : date ? 'datetime-local' : 'text'}
          value={value2}
          onChange={(e) => setValue2(e.target.value)}
          placeholder={op === 'gte' ? 'to (optional)' : 'from (optional)'}
          data-testid="relation-query-value2"
        />
      )}
    </div>
  );
}
