import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanupOrphanShellTabs, closeTabByTargetId, createDirectChartTarget, isChartPageTarget, isNewTabPageTarget, newTab, rankLandingCandidates, rankShellCandidates, withDeadline } from '../src/core/tab.js';

test('chart target detection validates TradingView hostname and /chart path', () => {
  assert.equal(isChartPageTarget({
    type: 'page',
    url: 'https://www.tradingview.com/chart/abc123/',
  }), true);
  assert.equal(isChartPageTarget({
    type: 'page',
    url: 'https://tradingview.com/chart/abc123/',
  }), true);
  assert.equal(isChartPageTarget({
    type: 'page',
    url: 'https://tradingview.com.evil.example/chart/abc123/',
  }), false);
  assert.equal(isChartPageTarget({
    type: 'page',
    url: 'https://www.tradingview.com/markets/stocks-usa/',
  }), false);
});

test('tabbed-window shell target is preferred over generic window targets', () => {
  const targets = [
    {
      id: 'generic-window',
      type: 'page',
      title: 'TradingView',
      url: 'file:///C:/TradingView/resources/app.asar/app/window/index.html?window=1',
    },
    {
      id: 'tabbed-shell',
      type: 'page',
      title: 'tabbed-window',
      url: 'file:///C:/TradingView/resources/app.asar/app/window/index.html?window=2',
    },
  ];

  assert.deepEqual(
    rankShellCandidates(targets).map(target => target.id),
    ['tabbed-shell', 'generic-window'],
  );
});

test('tabbed-window hint in URL outranks generic window/index target', () => {
  const targets = [
    {
      id: 'generic-window',
      type: 'page',
      title: 'TradingView',
      url: 'file:///app/window/index.html?window=1',
    },
    {
      id: 'url-hinted-shell',
      type: 'page',
      title: 'TradingView',
      url: 'file:///app/window/index.html?type=tabbed-window',
    },
  ];

  assert.deepEqual(
    rankShellCandidates(targets).map(target => target.id),
    ['url-hinted-shell', 'generic-window'],
  );
});

test('landing candidates exclude chart and shell targets', () => {
  const targets = [
    { id: 'chart', type: 'page', url: 'https://www.tradingview.com/chart/abc/', title: 'Chart' },
    { id: 'shell', type: 'page', url: 'file:///app/window/index.html', title: 'TradingView' },
    { id: 'landing', type: 'page', url: 'file:///app/new-tab.html', title: 'Workspace' },
    { id: 'worker', type: 'worker', url: '', title: '' },
  ];
  assert.deepEqual(
    rankLandingCandidates(targets).map(target => target.id),
    ['landing'],
  );
});

test('direct CDP chart target bootstrap creates and waits for exact target', async () => {
  const seen = [];
  let polls = 0;
  const result = await createDirectChartTarget('https://www.tradingview.com/chart/abc123/', {
    createTarget: async options => {
      seen.push(options);
      return { id: 'target-1' };
    },
    listTargets: async () => {
      polls += 1;
      if (polls < 2) return [];
      return [{
        id: 'target-1',
        type: 'page',
        url: 'https://www.tradingview.com/chart/abc123/',
      }];
    },
    isReady: async id => id === 'target-1',
    wait: async () => {},
    timeoutMs: 1000,
  });

  assert.equal(result.id, 'target-1');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, 'https://www.tradingview.com/chart/abc123/');
});

test('persistent exact-token newTab bypasses the Electron shell on cold start', async () => {
  const calls = [];
  const result = await newTab({
    as_chart: true,
    chart_id: 'abc123',
    force_new_tab: true,
    _deps: {
      createDirectChartTarget: async (url, options) => {
        calls.push({ url, options });
        return {
          id: 'cold-target',
          type: 'page',
          url: 'https://www.tradingview.com/chart/abc123/',
        };
      },
      reconnectTo: async id => calls.push({ reconnect: id }),
    },
  });

  assert.equal(result.success, true);
  assert.equal(result.direct_target_creation, true);
  assert.equal(result.target_id, 'cold-target');
  assert.equal(result.chart_id, 'abc123');
  assert.deepEqual(calls[0].url, 'https://www.tradingview.com/chart/abc123/');
  assert.deepEqual(calls[1], { reconnect: 'cold-target' });
});

test('new CDP targets are preferred over stale title hints', () => {
  const before = new Set(['old']);
  const targets = [
    { id: 'old', type: 'page', url: 'file:///old.html', title: 'New tab' },
    { id: 'new', type: 'page', url: 'file:///new.html', title: 'Loading' },
  ];
  assert.deepEqual(
    rankLandingCandidates(targets, before).map(target => target.id),
    ['new', 'old'],
  );
});

test('title hint breaks ties between equally old landing candidates', () => {
  const before = new Set(['generic', 'hinted']);
  const targets = [
    { id: 'generic', type: 'page', url: 'file:///generic.html', title: 'Workspace' },
    { id: 'hinted', type: 'page', url: 'file:///hinted.html', title: 'New tab' },
  ];
  assert.deepEqual(
    rankLandingCandidates(targets, before).map(target => target.id),
    ['hinted', 'generic'],
  );
});


test('bounded target helper returns fast operations and rejects hung probes', async () => {
  assert.equal(await withDeadline(Promise.resolve('ok'), 50, 'probe'), 'ok');
  await assert.rejects(
    () => withDeadline(new Promise(resolve => setTimeout(resolve, 50)), 5, 'probe'),
    /probe timed out after 5ms/,
  );
});


test('TradingView Desktop new-tab target is recognized by its stable app.asar URL', () => {
  assert.equal(isNewTabPageTarget({
    type: 'page',
    url: 'file:///C:/Program%20Files/WindowsApps/TradingView/app.asar/app/new-tab/index.html',
  }), true);
  assert.equal(isNewTabPageTarget({
    type: 'page',
    url: 'https://www.tradingview.com/chart/abc/',
  }), false);
});

test('known Desktop new-tab target is preferred over generic landing candidates', () => {
  const before = new Set(['generic']);
  const targets = [
    { id: 'generic', type: 'page', url: 'file:///generic.html', title: 'New tab' },
    {
      id: 'desktop-new',
      type: 'page',
      url: 'file:///C:/TradingView/resources/app.asar/app/new-tab/index.html',
      title: 'Workspace',
    },
  ];
  assert.deepEqual(
    rankLandingCandidates(targets, before).map(target => target.id),
    ['desktop-new', 'generic'],
  );
});


test('exact tab close targets one CDP tab without relying on active shell state', async () => {
  const targets = [
    { id: 'a', type: 'page', url: 'https://www.tradingview.com/chart/a/' },
    { id: 'b', type: 'page', url: 'https://www.tradingview.com/chart/b/' },
  ];

  const result = await closeTabByTargetId({
    target_id: 'b',
    _deps: {
      listTabs: async () => ({
        tab_count: targets.length,
        tabs: targets.map((target, index) => ({
          index,
          id: target.id,
          chart_id: target.id,
          is_chart: true,
        })),
      }),
      listTargets: async () => targets.slice(),
      closeTarget: async targetId => {
        const index = targets.findIndex(target => target.id === targetId);
        if (index >= 0) targets.splice(index, 1);
      },
      wait: async () => {},
    },
  });

  assert.equal(result.success, true);
  assert.equal(result.target_id, 'b');
  assert.deepEqual(targets.map(target => target.id), ['a']);
});

test('exact tab close refuses the last Desktop tab', async () => {
  await assert.rejects(
    () => closeTabByTargetId({
      target_id: 'only',
      _deps: {
        listTabs: async () => ({
          tab_count: 1,
          tabs: [{ index: 0, id: 'only', chart_id: 'only', is_chart: true }],
        }),
      },
    }),
    /Cannot close the last tab/,
  );
});


test('orphan shell cleanup preserves mapped worker tabs and closes only stale shell tabs', async () => {
  const shellTabs = [
    { owner: 'worker-a' },
    { owner: null },
    { owner: 'worker-b' },
    { owner: null },
  ];
  let activeIndex = 0;

  const evalIn = async expression => {
    if (expression.includes("document.querySelectorAll('.tabs-container .tab').length")) {
      return shellTabs.length;
    }
    if (expression.includes("tabs.indexOf(active)")) {
      return activeIndex;
    }

    const indexMatch = expression.match(/tab'\)\[(\d+)\]/);
    const index = indexMatch ? Number(indexMatch[1]) : null;
    if (index == null) throw new Error('Unhandled shell expression: ' + expression);

    if (expression.includes('close.click()')) {
      if (!shellTabs[index]) return false;
      shellTabs.splice(index, 1);
      if (activeIndex >= shellTabs.length) activeIndex = Math.max(0, shellTabs.length - 1);
      return true;
    }

    if (expression.includes('tab.click()')) {
      if (!shellTabs[index]) return false;
      activeIndex = index;
      return true;
    }

    throw new Error('Unhandled shell expression: ' + expression);
  };

  const result = await cleanupOrphanShellTabs({
    keep_target_ids: ['worker-a', 'worker-b'],
    _deps: {
      withShell: async fn => fn(evalIn),
      isTargetVisible: async targetId => shellTabs[activeIndex]?.owner === targetId,
      wait: async () => {},
    },
  });

  assert.equal(result.success, true);
  assert.equal(result.tabs_before, 4);
  assert.equal(result.tabs_after, 2);
  assert.deepEqual(result.protected_indexes, [0, 2]);
  assert.deepEqual(result.closed_indexes, [3, 1]);
  assert.deepEqual(shellTabs.map(tab => tab.owner), ['worker-a', 'worker-b']);
});
