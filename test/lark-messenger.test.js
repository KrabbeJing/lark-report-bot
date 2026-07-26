import test from 'node:test';
import assert from 'node:assert/strict';
import { LarkMessenger, normalizeMessageUuid } from '../src/lark-messenger.js';

test('keeps valid short message uuid unchanged', () => {
  assert.equal(normalizeMessageUuid('weekly-2026-W28'), 'weekly-2026-W28');
});

test('normalizes overlong message uuid deterministically below Feishu limit', () => {
  const input = `weekly-${'oc_'.padEnd(35, 'a')}-2026-07-06`;
  const first = normalizeMessageUuid(input);
  const second = normalizeMessageUuid(input);
  assert.equal(first, second);
  assert.ok(first.length <= 50);
  assert.notEqual(first, normalizeMessageUuid(`${input}-other`));
});

test('sendImage applies uuid normalization before calling Feishu', async () => {
  let payload;
  const client = {
    im: {
      message: {
        create: async input => { payload = input; },
      },
    },
  };
  const messenger = new LarkMessenger(client);
  const input = `weekly-${'oc_'.padEnd(35, 'a')}-2026-07-06`;
  await messenger.sendImage('oc_test', 'img_test', input);
  assert.ok(payload.data.uuid.length <= 50);
  assert.equal(payload.data.uuid, normalizeMessageUuid(input));
});

test('sendTextToOpenId sends a private text message with a normalized uuid', async () => {
  let payload;
  const client = {
    im: {
      message: {
        create: async input => { payload = input; },
      },
    },
  };
  const messenger = new LarkMessenger(client);
  const input = `weekly-owner:${'ou_'.padEnd(45, 'a')}`;

  await messenger.sendTextToOpenId('ou_owner', '请填写周报', input);

  assert.equal(payload.params.receive_id_type, 'open_id');
  assert.equal(payload.data.receive_id, 'ou_owner');
  assert.equal(payload.data.msg_type, 'text');
  assert.deepEqual(JSON.parse(payload.data.content), { text: '请填写周报' });
  assert.equal(payload.data.uuid, normalizeMessageUuid(input));
  assert.ok(payload.data.uuid.length <= 50);
});
