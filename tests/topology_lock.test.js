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

test('active-chart read tools wait behind a topology mutation', async () => {
  // Offline: released readers must fail fast instead of reaching a live Desktop.
  process.env.TV_CDP_PORT = '1029';
  const { withTopologyMutationLock, topologyMutationLockStatus } = await import('../src/core/topology-lock.js');
  const { registerDataTools } = await import('../src/tools/data.js');
  const { registerChartTools } = await import('../src/tools/chart.js');
  const tools = new Map();
  const server = { tool(name, description, schema, handler) { tools.set(name, handler); } };
  registerDataTools(server);
  registerChartTools(server);

  let release;
  const held = withTopologyMutationLock('quote_get', () => new Promise(resolve => { release = resolve; }));
  await new Promise(resolve => setTimeout(resolve, 0));
  // Read-only tools only: a quote_get switch must not interleave with them.
  const reads = ['chart_get_state', 'data_get_ohlcv'];
  const pending = reads.map(name => tools.get(name)({}));
  await new Promise(resolve => setTimeout(resolve, 0));
  const status = topologyMutationLockStatus();
  assert.equal(status.active.label, 'quote_get');
  assert.deepEqual(status.queued.map(item => item.label), reads);
  release();
  await held;
  await Promise.allSettled(pending);
});
