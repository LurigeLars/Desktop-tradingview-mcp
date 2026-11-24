import test from 'node:test';
import assert from 'node:assert/strict';
import { saveWorkerLayout } from '../src/core/worker-layout.js';

test('worker persistence refuses old saved intervals, sync flags or incomplete panes', async () => {
  const entries = [{ symbol: 'NYSE:IBM', timeframe: '1' }];
  const valid = { chart_id: 'worker', layout: 's', dirty: false, symbol_sync: false, interval_sync: false,
    panes: [{ symbol: 'NYSE:IBM', timeframe: '1' }] };
  for (const saved of [ { ...valid, interval_sync: true }, { ...valid, dirty: true },
    { ...valid, panes: [{ symbol: 'NYSE:IBM', timeframe: '1D' }] },
    { ...valid, panes: [] }, { ...valid, chart_id: 'personal' }, { ...valid, layout: '2h' } ]) {
    const client = { Runtime: { evaluate: async () => ({ result: { value: saved } }) } };
    await assert.rejects(() => saveWorkerLayout(client, { chartId: 'worker', entries }), /Saved worker layout/);
  }
  const client = { Runtime: { evaluate: async () => ({ result: { value: valid } }) } };
  assert.deepEqual(await saveWorkerLayout(client, { chartId: 'worker', entries }), { persisted: true });
  // A shrunk layout keeps hidden charts in the saved state; the layout code decides what is shown.
  const shrunk = { ...valid, panes: [...valid.panes, { symbol: 'NYSE:MPC', timeframe: '60' }] };
  const shrunkClient = { Runtime: { evaluate: async () => ({ result: { value: shrunk } }) } };
  assert.deepEqual(await saveWorkerLayout(shrunkClient, { chartId: 'worker', entries }), { persisted: true });
});


test('worker persistence verifies the saved extended session', async () => {
  const entries = [{ symbol: 'NYSE:IBM', timeframe: '1', groups: ['session:extended'] }];
  for (const session of [undefined, 'regular', 'extended']) {
    const saved = { chart_id: 'worker', layout: 's', dirty: false, symbol_sync: false, interval_sync: false,
      panes: [{ symbol: 'NYSE:IBM', timeframe: '1', chart_session: session }] };
    const client = { Runtime: { evaluate: async () => ({ result: { value: saved } }) } };
    if (session === 'extended') assert.deepEqual(await saveWorkerLayout(client, {chartId:'worker', entries}), {persisted:true});
    else await assert.rejects(() => saveWorkerLayout(client, {chartId:'worker', entries}), /Saved worker layout/);
  }
});
