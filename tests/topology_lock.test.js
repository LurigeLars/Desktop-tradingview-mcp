import test from 'node:test';
import assert from 'node:assert/strict';
import { createMutationLock } from '../src/core/topology-lock.js';

test('topology mutation lock serializes callers in FIFO order', async () => {
  const lock = createMutationLock({ defaultTimeoutMs: 1000 });
  const events = [];
  let releaseFirst;

  const first = lock.run('first', async () => {
    events.push('first:start');
    await new Promise(resolve => { releaseFirst = resolve; });
    events.push('first:end');
  });

  while (!releaseFirst) await new Promise(resolve => setTimeout(resolve, 1));

  const second = lock.run('second', async () => {
    events.push('second:start');
    events.push('second:end');
  });

  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(events, ['first:start']);
  assert.equal(lock.status().locked, true);
  assert.equal(lock.status().active.label, 'first');
  assert.equal(lock.status().queue_length, 1);
  assert.equal(lock.status().queued[0].label, 'second');

  releaseFirst();
  await Promise.all([first, second]);

  assert.deepEqual(events, ['first:start', 'first:end', 'second:start', 'second:end']);
  assert.equal(lock.status().locked, false);
  assert.equal(lock.status().queue_length, 0);
});

test('topology mutation lock releases after mutation failure', async () => {
  const lock = createMutationLock({ defaultTimeoutMs: 1000 });

  await assert.rejects(
    () => lock.run('broken', async () => { throw new Error('boom'); }),
    /boom/,
  );

  const result = await lock.run('next', async () => 'ok');
  assert.equal(result, 'ok');
  assert.equal(lock.status().locked, false);
});

test('timed-out waiter is removed without blocking later callers', async () => {
  const lock = createMutationLock({ defaultTimeoutMs: 1000 });
  let releaseFirst;

  const first = lock.run('first', async () => {
    await new Promise(resolve => { releaseFirst = resolve; });
  });

  while (!releaseFirst) await new Promise(resolve => setTimeout(resolve, 1));

  await assert.rejects(
    () => lock.run('timeout', async () => 'never', { timeoutMs: 20 }),
    /topology mutation lock timed out/i,
  );

  assert.equal(lock.status().queue_length, 0);
  releaseFirst();
  await first;

  assert.equal(await lock.run('third', async () => 'ok'), 'ok');
});
