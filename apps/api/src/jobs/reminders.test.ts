import assert from 'node:assert/strict';
import { test } from 'node:test';

// reminders.js haalt de db binnen; die verbindt pas bij een query.
process.env.DATABASE_URL ??= 'postgres://test@localhost/test';
const { newsPayload } = await import('./reminders.js');

const item = {
  kind: 'artiest',
  note: null,
  event_id: 'e1',
  title: 'Moss',
  venue_name: 'Paradiso',
  starts_at: new Date('2026-10-01T20:00:00Z'),
  artist_name: 'Moss',
  alert_label: null,
};

test('ochtendpush noemt de aanwinsten erbij', () => {
  const plain = newsPayload([item]).body;
  assert.equal(newsPayload([item], 0).body, plain);
  assert.equal(newsPayload([item], 1).body, `${plain} En één aanwinst bij zalen die je volgt.`);
  assert.match(newsPayload([item], 7).body, /En 7 aanwinsten bij zalen die je volgt\.$/);
});
