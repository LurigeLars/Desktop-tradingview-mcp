import test from 'node:test';
import assert from 'node:assert/strict';
import { saveWorkerLayout } from '../src/core/worker-layout.js';

test('worker persistence refuses old saved intervals, sync flags or incomplete panes', async () => {
  const entries = [{ symbol: 'NYSE:IBM', timeframe: '1' }];
  const valid = { chart_id: 'worker', dirty: false, symbol_sync: false, interval_sync: false,
    panes: [{ symbol: 'NYSE:IBM', timeframe: '1' }] };
  for (const saved of [ { ...valid, interval_sync: true }, { ...valid, dirty: true },
    { ...valid, panes: [{ symbol: 'NYSE:IBM', timeframe: '1D' }] },
    { ...valid, panes: [] }, { ...valid, chart_id: 'personal' } ]) {
    const client = { Runtime: { evaluate: async () => ({ result: { value: saved } }) } };
    await assert.rejects(() => saveWorkerLayout(client, { chartId: 'worker', entries }), /Saved worker layout/);
  }
  const client = { Runtime: { evaluate: async () => ({ result: { value: valid } }) } };
  assert.deepEqual(await saveWorkerLayout(client, { chartId: 'worker', entries }), { persisted: true });
});
