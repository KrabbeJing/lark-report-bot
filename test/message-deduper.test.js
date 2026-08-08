import test from 'node:test';
import assert from 'node:assert/strict';
import { createMessageDeduper } from '../src/message-deduper.js';

test('reprocesses the same message id when its content changes', () => {
  const deduper = createMessageDeduper();

  assert.equal(deduper.begin('om_1', 'fingerprint-a'), true);
  deduper.complete('om_1', 'fingerprint-a');
  assert.equal(deduper.begin('om_1', 'fingerprint-a'), false);
  assert.equal(deduper.begin('om_1', 'fingerprint-b'), true);
});

test('does not process the same message concurrently', () => {
  const deduper = createMessageDeduper();

  assert.equal(deduper.begin('om_1', 'fingerprint-a'), true);
  assert.equal(deduper.begin('om_1', 'fingerprint-b'), false);
  deduper.fail('om_1');
  assert.equal(deduper.begin('om_1', 'fingerprint-b'), true);
});
