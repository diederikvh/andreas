import assert from 'node:assert/strict';
import { test } from 'node:test';

import { honestReason } from './reason.js';

test('"die je volgt" gaat eruit als je die artiest niet volgt', () => {
  assert.equal(
    honestReason('Shoegaze en dromerige gitaren, verwant aan Slowdive en Warpaint die je volgt.', ['the afghan whigs']),
    'Shoegaze en dromerige gitaren, verwant aan Slowdive en Warpaint.'
  );
});

test('blijft staan als je die artiest wel volgt', () => {
  const r = 'Verwant aan The Afghan Whigs die je volgt.';
  assert.equal(honestReason(r, ['the afghan whigs']), r);
});

test('redenen zonder "je volgt" blijven ongemoeid', () => {
  const r = 'Punkrock met indie-randje.';
  assert.equal(honestReason(r, []), r);
});
