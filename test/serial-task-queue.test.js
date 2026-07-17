import test from 'node:test';
import assert from 'node:assert/strict';
import { SerialTaskQueue } from '../src/serial-task-queue.js';

test('runs tasks serially in enqueue order', async () => {
  const queue = new SerialTaskQueue();
  const events = [];

  const first = queue.enqueue(async () => {
    events.push('first:start');
    await new Promise(resolve => setTimeout(resolve, 10));
    events.push('first:end');
  });
  const second = queue.enqueue(async () => {
    events.push('second:start');
    events.push('second:end');
  });

  await Promise.all([first, second]);
  assert.deepEqual(events, ['first:start', 'first:end', 'second:start', 'second:end']);
  await queue.tail;
  assert.equal(queue.pending, 0);
});

test('continues after a failed task', async () => {
  const queue = new SerialTaskQueue();
  const failed = queue.enqueue(async () => {
    throw new Error('expected failure');
  });
  const next = queue.enqueue(async () => 'completed');

  await assert.rejects(failed, /expected failure/);
  assert.equal(await next, 'completed');
});
