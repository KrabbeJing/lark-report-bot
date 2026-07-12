import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLarkClientOptions } from '../src/lark-client.js';

test('uses a silent SDK logger so request headers are never printed', () => {
  const options = buildLarkClientOptions({
    appId: 'app_id',
    appSecret: 'app_secret',
    domain: 'feishu',
  });
  let consoleCalls = 0;
  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => { consoleCalls += 1; };
  console.error = () => { consoleCalls += 1; };
  try {
    options.logger.error({
      config: { headers: { Authorization: 'Bearer secret-token' } },
    });
    options.logger.info('client ready');
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }

  assert.equal(consoleCalls, 0);
  assert.equal(options.appId, 'app_id');
  assert.equal(options.appSecret, 'app_secret');
  assert.equal(options.domain, 'feishu');
});
