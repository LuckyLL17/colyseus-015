/**
 * Render tests for the relation-query recovery banner. Server-rendered
 * (react-dom/server, like related-table.test.tsx) so no jsdom is needed —
 * we string-search for the testids/wire copy that make the failure state
 * observable AND recoverable: a retry action and a reset action.
 */
import assert from 'node:assert';
import { describe, it } from 'node:test';
import * as React from 'react';
import { renderToString } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom';
import { RelationQueryError, relationErrorMessage } from '../src/pages/internals/relation-error';

function render(opts: { message: string }) {
  return renderToString(
    <StaticRouter location="/members">
      <RelationQueryError
        message={opts.message}
        onRetry={() => {}}
        onResetRelation={() => {}}
      />
    </StaticRouter>,
  );
}

describe('RelationQueryError', () => {
  it('renders an alert role with the message and both recovery actions', () => {
    const html = render({ message: "relation 'org' has no column 'nope'" });
    assert.match(html, /role="alert"/);
    assert.match(html, /data-testid="relation-query-error"/);
    assert.match(html, /Relation query failed/);
    assert.match(html, /has no column/);
    assert.match(html, /nope/);
    assert.match(html, /data-testid="relation-query-retry"/);
    assert.match(html, /data-testid="relation-query-reset"/);
  });

  it('explains that filters are preserved but can be reset', () => {
    const html = render({ message: 'boom' });
    // The reset affordance explicitly says it targets the relation filter —
    // operators keep their other list filters.
    assert.match(html, /Reset relation filter/);
  });
});

describe('relationErrorMessage', () => {
  it('maps status codes to actionable copy', () => {
    assert.match(relationErrorMessage({ response: { status: 403, data: { message: 'forbidden' } } }), /forbidden/);
    assert.match(relationErrorMessage({ response: { status: 400, data: 'malformed json' } } as any), /malformed json/);
    assert.match(relationErrorMessage({ response: { status: 404 } } as any), /no longer exists/i);
    assert.match(relationErrorMessage({ response: { status: 502 } } as any), /retry/i);
    assert.match(relationErrorMessage({ message: 'Failed to fetch' }), /network/i);
    assert.match(relationErrorMessage(undefined), /retry/i);
  });

  it('reads simple-rest string error envelopes too', () => {
    assert.match(relationErrorMessage({ response: { status: 403, data: 'nope' } } as any), /nope/);
  });
});
