/**
 * Render/unit tests for the single-hop relation query UI:
 *   - activeRelationFilter: pure derivation of the active relation from a
 *     refine filter array (chips/count logic)
 *   - RelatedTableView: the recoverable error banner renders with a Retry
 *     affordance even when there are no rows (server-side string render,
 *     same harness as related-table.test.tsx)
 */
import assert from 'assert';
import { describe, it } from 'node:test';
import * as React from 'react';
import { renderToString } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom';
import { activeRelationFilter } from '../src/pages/internals/relation-query-bar';
import { RelatedTableView } from '../src/pages/internals/relations';
import type { Resource, ResourceRelation } from '../src/types';

const rel: ResourceRelation = { name: 'members', target: 'members', kind: 'many', label: 'Members', fk: 'user_id' };
const otherRel: ResourceRelation = { name: 'notes', target: 'notes', kind: 'many', label: 'Notes', fk: 'user_id' };

describe('activeRelationFilter', () => {
  it('is null when no dotted filter and no expand are present', () => {
    assert.strictEqual(
      activeRelationFilter([{ field: '_q', value: 'x' }], [rel]).relation,
      null,
    );
  });

  it('picks the relation out of a dotted filter field', () => {
    const r = activeRelationFilter([
      { field: '_q', value: 'x' },
      { field: 'members.nickname_like', value: 'ann' },
    ], [rel]);
    assert.strictEqual(r.relation?.name, 'members');
    assert.strictEqual(r.entries.length, 1);
    assert.strictEqual(r.expand, false);
  });

  it('recognizes expand-only state', () => {
    const r = activeRelationFilter([{ field: '_expand', value: 'members' }], [rel, otherRel]);
    assert.strictEqual(r.relation?.name, 'members');
    assert.strictEqual(r.expand, true);
  });

  it('scopes entries to the active relation only', () => {
    const r = activeRelationFilter([
      { field: 'members.nickname', value: 'ann' },
      { field: 'notes.note', value: 'hi' },
    ], [rel, otherRel]);
    // First dotted relation wins; only ITS entries are surfaced (the
    // backend rejects a second relation anyway).
    assert.strictEqual(r.relation?.name, 'members');
    assert.strictEqual(r.entries.length, 1);
  });
});

function cloudSavesDef(): Resource {
  return {
    name: 'cloudSaves', label: 'Cloud Saves', icon: 'cloud',
    columns: [
      { name: 'user_id', label: 'user_id', type: 'text', dataType: 'string', notNull: true, primary: false },
      { name: 'slot', label: 'slot', type: 'integer', dataType: 'number', notNull: true, primary: false },
    ],
    primaryKey: ['user_id', 'slot'],
    actions: [], relations: [],
  } as unknown as Resource;
}

describe('RelatedTableView recoverable error', () => {
  it('renders an error banner with a retry button and keeps prior rows mounted', () => {
    const noop = () => {};
    const html = renderToString(
      <StaticRouter location="/users/show/U1">
        <RelatedTableView
          parentResource="users"
          parentId="U1"
          relation={{ name: 'cloudSaves', target: 'cloudSaves', kind: 'many', label: 'Cloud Saves', fk: 'user_id' }}
          targetDef={cloudSavesDef()}
          rows={[{ user_id: 'U1', slot: 0 }]}
          loading={false}
          error="relation 'members' has no column 'nope'"
          onRetry={noop}
          page={1}
          hasMore={false}
          onPrev={noop}
          onNext={noop}
          filters={[]}
          setFilters={noop}
          sorter={undefined}
          onSortColumn={noop}
          onClearSort={noop}
        />
      </StaticRouter>,
    );
    assert.match(html, /role="alert"/);
    assert.match(html, /data-testid="related-error"/);
    assert.match(html, /data-testid="related-error-retry"/);
    // Server message surfaced (recoverable — the user can fix the filter).
    // Quotes are HTML-escaped in the server render.
    assert.match(html, /relation &#x27;members&#x27; has no column &#x27;nope&#x27;/);
  });
});
