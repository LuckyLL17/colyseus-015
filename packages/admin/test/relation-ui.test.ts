/**
 * Pure-logic tests for the frontend relation-query helper — key parsing,
 * filter/sorter detection, and the eligible-relation catalog. Rendering of
 * the popover/banner themselves is covered by relation-filter.test.tsx.
 */
import assert from 'node:assert';
import { describe, it } from 'node:test';
import {
  allRelationFilters, findRelationFilter, findRelationSorter,
  parseRelationFilterKey, queryableRelations, relationFilterKey,
} from '../src/lib/relation-query.ts';
import type { Resource } from '../src/types';

function resource(over: Partial<Resource> = {}): Resource {
  return {
    name: 'members',
    label: 'Members',
    icon: 'user',
    columns: [
      { name: 'id', label: 'Id', type: 'text', dataType: 'string', notNull: true, primary: true, hasDefault: false },
      { name: 'org_id', label: 'Org', type: 'text', dataType: 'string', notNull: false, primary: false, hasDefault: false,
        linkTo: { resource: 'orgs', pkColumn: 'id', labelColumn: 'name' } },
      { name: 'props', label: 'Props', type: 'json', dataType: 'json', notNull: false, primary: false, hasDefault: false },
    ],
    primaryKey: ['id'],
    actions: [],
    relations: [
      { name: 'org', label: 'Org', target: 'orgs', kind: 'one', fk: 'org_id' },
      { name: 'notes', label: 'Notes', target: 'notes', kind: 'many', fk: 'member_id' },
    ],
    ...over,
  } as Resource;
}

const orgs: Resource = {
  name: 'orgs',
  label: 'Orgs',
  icon: 'team',
  columns: [
    { name: 'id', label: 'Id', type: 'text', dataType: 'string', notNull: true, primary: true, hasDefault: false },
    { name: 'name', label: 'Name', type: 'text', dataType: 'string', notNull: true, primary: false, hasDefault: false },
    { name: 'seats', label: 'Seats', type: 'integer', dataType: 'number', notNull: false, primary: false, hasDefault: false },
  ],
  primaryKey: ['id'],
  actions: [],
  relations: [],
} as Resource;

const notes: Resource = {
  name: 'notes',
  label: 'Notes',
  icon: 'message',
  columns: [
    { name: 'id', label: 'Id', type: 'text', dataType: 'string', notNull: true, primary: true, hasDefault: false },
    { name: 'body', label: 'Body', type: 'text', dataType: 'string', notNull: true, primary: false, hasDefault: false },
  ],
  // Composite-PK targets are ineligible for the single-column relation UI.
  primaryKey: ['member_id', 'id'],
  actions: [],
  relations: [],
} as unknown as Resource;

describe('parseRelationFilterKey', () => {
  it('parses bare keys as eq and suffixed keys with their op', () => {
    assert.deepStrictEqual(parseRelationFilterKey('org.name'), {
      relationName: 'org', field: 'name', op: 'eq',
    });
    assert.deepStrictEqual(parseRelationFilterKey('org.name_like'), {
      relationName: 'org', field: 'name', op: 'like',
    });
    assert.deepStrictEqual(parseRelationFilterKey('org.seats_gte'), {
      relationName: 'org', field: 'seats', op: 'gte',
    });
  });

  it('returns null for non-relation keys (defensive — guards direct columns)', () => {
    assert.strictEqual(parseRelationFilterKey('email'), null);
    assert.strictEqual(parseRelationFilterKey('email_like'), null);
  });
});

describe('relation filters in refine arrays', () => {
  const filters = [
    { field: '_q', operator: 'eq', value: 'bob' },
    { field: 'org.name_like', operator: 'eq', value: 'acm' },
    { field: 'org.seats_gte', operator: 'eq', value: '5' },
    { field: 'id', operator: 'eq', value: 'm1' },
  ];

  it('findRelationFilter locates by relation + field', () => {
    assert.strictEqual(findRelationFilter(filters, 'org', 'name')?.value, 'acm');
    assert.strictEqual(findRelationFilter(filters, 'org', 'name')?.op, 'like');
    assert.strictEqual(findRelationFilter(filters, 'org', 'seats')?.value, '5');
    assert.strictEqual(findRelationFilter(filters, 'org', 'id'), null);
  });

  it('allRelationFilters returns only value-bearing relation conditions', () => {
    const all = allRelationFilters(filters);
    assert.deepStrictEqual(all.map((f) => f.relationName + '.' + f.field), ['org.name', 'org.seats']);
  });

  it('relationFilterKey matches the backend grammar (eq is suffixless)', () => {
    assert.strictEqual(relationFilterKey('org', 'name', 'like'), 'org.name_like');
    assert.strictEqual(relationFilterKey('org', 'name', 'eq'), 'org.name');
  });
});

describe('findRelationSorter', () => {
  it('detects a relation sorter and reports its order', () => {
    assert.deepStrictEqual(
      findRelationSorter([{ field: 'org.name', order: 'desc' }]),
      { relationName: 'org', field: 'name', order: 'desc' },
    );
    assert.strictEqual(findRelationSorter([{ field: 'name', order: 'asc' }]), null);
    assert.strictEqual(findRelationSorter([]), null);
  });
});

describe('queryableRelations', () => {
  it('includes to-one and to-many relations with filterable fields', () => {
    const entries = queryableRelations(resource(), [orgs, notes]);
    const names = entries.map((e) => e.relation.name).sort();
    // org (single PK, text+number fields) and notes (composite PK but still
    // has filterable text columns — existence filters don't need a single PK
    // on the TARGET; the FK is single-column by metadata).
    assert.deepStrictEqual(names, ['notes', 'org']);
    const org = entries.find((e) => e.relation.name === 'org')!;
    assert.strictEqual(org.cardinality, 'one');
    assert.deepStrictEqual(org.fields.map((f) => f.name), ['id', 'name', 'seats']);
  });

  it('excludes JSON columns from the filterable field list', () => {
    // members.props is json — must never be offered.
    const membersAsTarget = resource();
    const fromMembers = queryableRelations(
      { ...membersAsTarget, relations: [{ name: 'self', label: 'Self', target: 'members', kind: 'one', fk: 'org_id' }] },
      [membersAsTarget],
    );
    const self = fromMembers.find((e) => e.relation.name === 'self');
    assert.ok(self);
    assert.strictEqual(self!.fields.some((f) => f.name === 'props'), false);
  });

  it('omits relations whose target resource is not in the catalog', () => {
    const entries = queryableRelations(resource(), [orgs]); // notes missing
    assert.strictEqual(entries.some((e) => e.relation.name === 'notes'), false);
  });
});
