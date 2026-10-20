import test from 'node:test';
import assert from 'node:assert/strict';
import { attachChart, attachChartTarget, listShellTabs, switchShellTab, closeShellTabById, cleanupOrphanShellTabs, closeTabByTargetId, createDirectChartTarget, isChartPageTarget, isNewTabPageTarget, isReusableWorkerBootstrapTarget, newTab, openChartViaRenderer, rankLandingCandidates, rankReusableWorkerBootstrapCandidates, rankShellCandidates, selectExactChartTarget, switchTab, withDeadline } from '../src/core/tab.js';
import { layoutSwitch, resolveSavedLayout } from '../src/core/ui.js';

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

test('renderer owner metadata does not classify new tabs or tooltips as shells', () => {
  const query = '?rendererInitialData=%7B%22remoteServiceInstanceId%22%3A%22instance-tvd%3Atabbed-window%22%7D';
  const base = 'file:///C:/TradingView/resources/app.asar/app/';
  const landing = { id: 'landing', type: 'page', title: 'New tab', url: base + 'new-tab/index.html' + query };
  const tooltip = { id: 'tooltip', type: 'page', title: 'index.html' + query, url: base + 'tooltip/index.html' + query };
  const shell = { id: 'shell', type: 'page', title: 'TradingView', url: base + 'window/index.html' + query };
  const targets = [landing, tooltip, shell];

  assert.deepEqual(rankShellCandidates(targets).map(t => t.id), ['shell']);
  assert.deepEqual(rankLandingCandidates(targets).map(t => t.id), ['landing', 'tooltip']);
  assert.equal(isReusableWorkerBootstrapTarget(landing), true);
  assert.equal(isReusableWorkerBootstrapTarget(tooltip), false);
  assert.equal(isReusableWorkerBootstrapTarget(shell), false);
  assert.deepEqual(rankReusableWorkerBootstrapCandidates(targets).map(t => t.id), ['landing']);
});

test('switching to a new tab verifies the exact active shell ID without chart attachment', async () => {
  const url = 'file:///app.asar/app/new-tab/index.html?rendererInitialData=' + encodeURIComponent(JSON.stringify({ tabId: 'shell-id' }));
  const deps = {
    listTabs: async () => ({ tab_count: 1, tabs: [{ id: 'landing', url, is_chart: false, chart_id: null }] }),
    withShell: async fn => fn(async expression => {
      assert.ok(expression.includes('shell-id'));
      return true;
    }),
    wait: async () => {},
    attachChart: async () => { throw new Error('must not attach a new tab as a chart'); },
  };
  const result = await switchTab({ index: 0, _deps: deps });
  assert.equal(result.success, true);
  assert.equal(result.visually_switched, true);
  assert.equal(result.chart_id, null);
  await assert.rejects(switchTab({ index: 0, _deps: {
    ...deps, withShell: async fn => fn(async () => false),
  } }), /shell tab not found/);
});

test('chart switching maps unique layout identities and reports ambiguous mapping as attachment only', async () => {
  const target = { id: 'chart', type: 'page', url: 'https://www.tradingview.com/chart/abc/', is_chart: true, chart_id: 'abc' };
  for (const mode of ['unique', 'duplicate-renderer', 'duplicate-shell', 'missing-name']) {
    const deps = {
      listTabs: async () => ({ tab_count: 1, tabs: [target] }),
      listTargets: async () => mode === 'duplicate-renderer' ? [target, { ...target, id: 'other' }] : [target],
      readLayoutName: async () => mode === 'missing-name' ? null : 'Personal',
      withShell: async fn => fn(async expression => expression.includes('.filter(tab =>')
        ? mode === 'duplicate-shell' ? ['a', 'b'] : ['a'] : true),
      wait: async () => {},
      attachChart: async args => { assert.equal(args.chart_id, 'abc'); return { success: true, verified: true }; },
    };
    const result = await switchTab({ index: 0, _deps: deps });
    assert.equal(result.success, true);
    assert.equal(result.visually_switched, mode === 'unique');
  }
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

test('worker bootstrap reuses an asynchronously restored exact chart before creating anything', async () => {
  const calls = [];
  let polls = 0;
  const result = await newTab({
    as_chart: true,
    chart_id: 'abc123',
    force_new_tab: true,
    _deps: {
      listTargets: async () => {
        polls += 1;
        if (polls < 2) {
          return [{ id: 'home', type: 'page', url: 'https://www.tradingview.com/' }];
        }
        return [{
          id: 'restored',
          type: 'page',
          url: 'https://www.tradingview.com/chart/abc123/',
        }];
      },
      wait: async () => {},
      createDirectChartTarget: async () => {
        throw new Error('must not create when TradingView restores the worker');
      },
      reconnectTo: async id => calls.push({ reconnect: id }),
    },
  });

  assert.equal(result.success, true);
  assert.equal(result.reused_existing_target, true);
  assert.equal(result.target_id, 'restored');
  assert.deepEqual(calls, [{ reconnect: 'restored' }]);
});

test('worker bootstrap reuses a TradingView startup tab before creating a new target', async () => {
  const calls = [];
  const homepage = {
    id: 'home',
    type: 'page',
    title: 'TradingView — Track All Markets',
    url: 'https://www.tradingview.com/',
  };
  const chart = {
    id: 'home',
    type: 'page',
    title: 'Chart',
    url: 'https://www.tradingview.com/chart/abc123/',
  };

  const result = await newTab({
    as_chart: true,
    chart_id: 'abc123',
    force_new_tab: true,
    _deps: {
      listTargets: async () => [homepage],
      wait: async () => {},
      navigateTarget: async (id, url) => calls.push({ navigate: id, url }),
      waitForChartTarget: async args => {
        calls.push({ waitForChartTarget: args.landingId });
        return chart;
      },
      createDirectChartTarget: async () => {
        throw new Error('must reuse the startup tab before CDP.New');
      },
      reconnectTo: async id => calls.push({ reconnect: id }),
    },
  });

  assert.equal(result.success, true);
  assert.equal(result.reused_existing_tab, true);
  assert.equal(result.direct_target_creation, undefined);
  assert.equal(result.target_id, 'home');
  assert.equal(calls[0].navigate, 'home');
  assert.equal(calls[0].url, 'https://www.tradingview.com/chart/abc123/');
});

test('renderer fallback opens an exact chart target when CDP.New is unavailable', async () => {
  const target = {
    id: 'renderer-target',
    type: 'page',
    url: 'https://www.tradingview.com/chart/abc123/',
  };
  let polls = 0;
  const evaluations = [];
  const calls = [];
  const fakeClient = {
    Runtime: {
      enable: async () => {},
      evaluate: async args => {
        evaluations.push(args.expression);
        return { result: { objectId: 'window-1' } };
      },
      callFunctionOn: async args => {
        calls.push(args);
        return { result: { value: true } };
      },
    },
  };

  const result = await openChartViaRenderer('https://www.tradingview.com/chart/abc123/', {
    getActiveClient: async () => fakeClient,
    listTargets: async () => {
      polls += 1;
      return polls === 1 ? [] : [target];
    },
    isReady: async id => id === 'renderer-target',
    wait: async () => {},
    timeoutMs: 1000,
  });

  assert.equal(result.id, 'renderer-target');
  assert.deepEqual(evaluations, ['window']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].objectId, 'window-1');
  assert.deepEqual(calls[0].arguments, [{ value: 'https://www.tradingview.com/chart/abc123/' }]);
  assert.match(calls[0].functionDeclaration, /this\.open\(targetUrl/);
  assert.doesNotMatch(calls[0].functionDeclaration, /abc123/);
});

test('persistent worker falls back to renderer window.open when CDP.New fails', async () => {
  const calls = [];
  const nonReusable = [{
    id: 'internal',
    type: 'page',
    title: 'Other',
    url: 'file:///app/other.html',
  }];

  const result = await newTab({
    as_chart: true,
    chart_id: 'abc123',
    force_new_tab: true,
    _deps: {
      listTargets: async () => nonReusable,
      wait: async () => {},
      createDirectChartTarget: async () => {
        calls.push('cdp_new');
        throw new Error('Could not create new page');
      },
      openChartViaRenderer: async url => {
        calls.push({ renderer: url });
        return {
          id: 'renderer-target',
          type: 'page',
          url: 'https://www.tradingview.com/chart/abc123/',
        };
      },
      reconnectTo: async id => calls.push({ reconnect: id }),
    },
  });

  assert.equal(result.success, true);
  assert.equal(result.creation_via, 'renderer_window_open');
  assert.equal(result.target_id, 'renderer-target');
  assert.deepEqual(calls, [
    'cdp_new',
    { renderer: 'https://www.tradingview.com/chart/abc123/' },
    { reconnect: 'renderer-target' },
  ]);
});

test('persistent exact-token newTab falls back to direct CDP creation when no startup tab is reusable', async () => {
  const calls = [];
  const nonReusable = [{
    id: 'internal',
    type: 'page',
    title: 'Other',
    url: 'file:///app/other.html',
  }];
  const result = await newTab({
    as_chart: true,
    chart_id: 'abc123',
    force_new_tab: true,
    _deps: {
      listTargets: async () => nonReusable,
      wait: async () => {},
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

test('only safe TradingView startup pages are eligible for worker bootstrap reuse', () => {
  const targets = [
    { id: 'home', type: 'page', url: 'https://www.tradingview.com/' },
    { id: 'chart', type: 'page', url: 'https://www.tradingview.com/chart/abc/' },
    { id: 'markets', type: 'page', url: 'https://www.tradingview.com/markets/stocks-usa/' },
    { id: 'external', type: 'page', url: 'https://example.com/' },
    { id: 'newtab', type: 'page', url: 'file:///C:/TradingView/resources/app.asar/app/new-tab/index.html' },
  ];

  assert.equal(isReusableWorkerBootstrapTarget(targets[0]), true);
  assert.equal(isReusableWorkerBootstrapTarget(targets[1]), false);
  assert.equal(isReusableWorkerBootstrapTarget(targets[2]), false);
  assert.equal(isReusableWorkerBootstrapTarget(targets[3]), false);
  assert.equal(isReusableWorkerBootstrapTarget(targets[4]), true);
  assert.deepEqual(
    rankReusableWorkerBootstrapCandidates(targets).map(target => target.id),
    ['newtab', 'home'],
  );
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

test('new-tab close uses its exact Desktop ID even when every renderer appears visible', async () => {
  for (const mode of ['close', 'missing', 'unsaved', 'chart']) {
    let closed = false;
    const selected = [];
    const url = mode === 'chart' ? 'https://www.tradingview.com/chart/example/'
      : 'file:///app.asar/app/new-tab/index.html?rendererInitialData=' + encodeURIComponent(JSON.stringify({ tabId: 'wanted' }));
    const deps = {
      listTabs: async () => ({ tab_count: 2, tabs: [{ id: 'target', type: 'page', url }] }),
      listTargets: async () => closed ? [] : [{ id: 'target', type: 'page', url }],
      isTargetVisible: async () => true,
      readLayoutName: async () => null,
      wait: async () => {},
      withShell: async fn => fn(async expression => {
        if (expression.includes('.tab.active')) return true;
        const id = JSON.parse(expression.match(/getElementById\(("[^"]+")\)/)[1]);
        assert.equal(id, 'wanted');
        if (expression.includes('tab.click()')) { selected.push(id); return mode !== 'missing'; }
        if (expression.includes('close.click()')) { closed = mode === 'close'; return true; }
        if (expression.startsWith('!!')) return !closed;
        throw new Error('Unexpected shell expression');
      }),
    };
    if (mode === 'close') {
      const result = await closeTabByTargetId({ target_id: 'target', _deps: deps });
      assert.equal(result.success, true);
      assert.deepEqual(selected, ['wanted']);
    } else {
      await assert.rejects(closeTabByTargetId({ target_id: 'target', _deps: deps }),
        mode === 'missing' ? /shell tab not found/ : mode === 'chart' ? /refusing renderer-only close/ : /unsaved changes/);
      assert.equal(closed, false);
    }
  }
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

test('chart selection uses stable URL tokens and fails closed on duplicate targets', async () => {
  const targets = [
    { type: 'page', id: 'worker-new-id', url: 'https://www.tradingview.com/chart/worker-01/' },
    { type: 'page', id: 'personal-new-id', url: 'https://www.tradingview.com/chart/default123/' },
    { type: 'page', id: 'evil', url: 'https://tradingview.com.evil.invalid/chart/default123/' },
  ];
  assert.equal(selectExactChartTarget(targets, 'default123').id, 'personal-new-id');
  assert.throws(() => selectExactChartTarget(targets, 'absent'), /No live CDP target/);
  assert.throws(() => selectExactChartTarget(targets, '../bad'), /exact TradingView/);
  assert.throws(() => selectExactChartTarget([...targets, {
    type: 'page', id: 'duplicate', url: 'https://www.tradingview.com/chart/default123/',
  }], 'default123'), /Multiple CDP targets/);

  const calls = [];
  const result = await attachChart({
    chart_id: 'default123',
    _deps: {
      listTargets: async () => targets,
      reconnect: async id => { calls.push(id); },
      current: async () => ({ id: 'personal-new-id' }),
    },
  });
  assert.equal(result.verified, true);
  assert.equal(result.visually_switched, false);
  assert.deepEqual(calls, ['personal-new-id']);
  await assert.rejects(() => attachChart({
    chart_id: 'default123',
    _deps: {
      listTargets: async () => targets,
      reconnect: async () => {},
      current: async () => ({ id: 'worker-new-id' }),
    },
  }), /verification failed/);
});

test('saved-layout attachment uses URL token and never silently discards unsaved changes', async () => {
  const layouts = [
    { id: 206255929, name: 'Default', chart_id: 'eh2ouJQ6' },
    { id: 205961832, name: 'DTV Market 04', chart_id: 'H3pDwClg' },
    { id: 51, name: 'Default copy', chart_id: 'other' },
  ];
  assert.equal(resolveSavedLayout(layouts, 'Default').chart_id, 'eh2ouJQ6');
  assert.equal(resolveSavedLayout(layouts, '206255929').chart_id, 'eh2ouJQ6');
  assert.throws(() => resolveSavedLayout(layouts, 'def'), /Ambiguous/);
  const calls = [];
  const result = await layoutSwitch({
    name: 'Default',
    _deps: {
      listLayouts: async () => ({ layouts }),
      attach: async ({chart_id}) => {
        calls.push(chart_id);
        return { target_id: 'new-CDP-id', verified: true };
      },
    },
  });
  assert.equal(result.verified, true);
  assert.equal(result.visually_switched, false);
  assert.deepEqual(calls, ['eh2ouJQ6']);
});



test('physical shell tab listing distinguishes duplicate layout instances', async () => {
  const tabs = [
    {index:0,shell_tab_id:'desktop-a',layout_name:'Stocks',active:false},
    {index:1,shell_tab_id:'desktop-b',layout_name:'Stocks',active:true},
    {index:2,shell_tab_id:'desktop-c',layout_name:'Stocks',active:false},
  ];
  const shell = async fn => fn(async () => tabs.map(row => ({...row})));
  const result = await listShellTabs({_deps:{withShell:shell}});
  assert.equal(result.length, 3);
  assert.deepEqual(result.map(row => row.shell_tab_id), ['desktop-a','desktop-b','desktop-c']);
  assert.deepEqual(result.map(row => row.layout_name), ['Stocks','Stocks','Stocks']);
  await assert.rejects(
    listShellTabs({_deps:{withShell:async fn=>fn(async()=>[tabs[0],tabs[0]])}}),
    /missing or duplicated/
  );
});

test('physical shell identity refreshes after a Desktop restart without cached CDP IDs', async () => {
  const snapshot = shellId => ({
    shell_tab_id:shellId,layout_name:'Stocks',index:0,active:false,
  });
  let current = snapshot('previous-session');
  let selected = false;
  const shell = async fn => fn(async expression => {
    if (expression.includes('Array.from(document.querySelectorAll')) return [current];
    if (expression.includes('.tab.active')) return true;
    if (expression.includes('tab.click()')) {selected=true;return true;}
    throw new Error('Unexpected shell expression: '+expression);
  });
  current = snapshot('new-session');
  const switched = await switchShellTab({
    shell_tab_id:'new-session',expected_layout_name:'Stocks',
    _deps:{withShell:shell,wait:async()=>{}},
  });
  assert.equal(switched.success,true);
  assert.equal(selected,true);
  await assert.rejects(switchShellTab({
    shell_tab_id:'previous-session',_deps:{withShell:shell},
  }),/Stale shell_tab_id/);
});

test('shell close selects one duplicate layout by physical ID and preserves its peers', async () => {
  const tabs=[
    {shell_tab_id:'keep',layout_name:'Stocks'},
    {shell_tab_id:'close-this',layout_name:'Stocks'},
    {shell_tab_id:'other',layout_name:'Futures'},
  ];
  let active=null;
  const shell=async fn=>fn(async expression=>{
    if(expression.includes('Array.from(document.querySelectorAll'))return tabs.map((x,i)=>({...x,index:i}));
    if(expression.includes('const k=Object.keys(tab).find'))return tabs.find(x=>expression.includes(JSON.stringify(x.shell_tab_id)))?.layout_name || null;
    if(expression.includes("const close=tab.querySelector")) {
      const id=JSON.parse(expression.match(/getElementById\(("[^"]+")\)/)[1]);
      assert.equal(id,'close-this');const index=tabs.findIndex(x=>x.shell_tab_id===id);
      if(index<0)return false; tabs.splice(index,1);return true;
    }
    if(expression.includes('.tab.active'))return true;
    if(expression.includes('tab.click()')){active='close-this';return true;}
    if(expression.startsWith('!!document.getElementById'))return tabs.some(x=>expression.includes(JSON.stringify(x.shell_tab_id)));
    throw new Error('Unexpected shell expression: '+expression);
  });
  const result=await closeShellTabById({
    shell_tab_id:'close-this', expected_layout_name:'Stocks',
    protected_layout_names:['DTV Market 01'],
    _deps:{withShell:shell,wait:async()=>{}},
  });
  assert.equal(result.success,true);
  assert.equal(active,'close-this');
  assert.deepEqual(tabs.map(x=>x.shell_tab_id),['keep','other']);
});

test('shell close fails closed for workers, unknown layouts and mismatched stale identities', async () => {
  for (const row of [
    {shell_tab_id:'a',layout_name:'DTV Market 01'},
    {shell_tab_id:'a',layout_name:'Private Worker'},
    {shell_tab_id:'a',layout_name:null},
    {shell_tab_id:'a',layout_name:'Stocks'},
  ]) {
    const shell=async fn=>fn(async()=>[row,{shell_tab_id:'b',layout_name:'Stocks'}]);
    await assert.rejects(closeShellTabById({
      shell_tab_id:'a',expected_layout_name:row.layout_name==='Stocks'?'Something Else':undefined,
      protected_layout_names:['Private Worker'],
      _deps:{withShell:shell},
    }),/worker-owned|missing|changed/);
  }
});

test('exact chart target attachment disambiguates identical chart URLs', async () => {
  const charts=[
    {id:'first',type:'page',url:'https://www.tradingview.com/chart/same/'},
    {id:'second',type:'page',url:'https://www.tradingview.com/chart/same/'},
  ];
  let attached=null;
  const result=await attachChartTarget({
    target_id:'second',
    _deps:{
      listTargets:async()=>charts,
      reconnect:async id=>{attached=id},
      current:async()=>({id:attached}),
    },
  });
  assert.equal(result.target_id,'second');
  assert.equal(result.chart_id,'same');
  await assert.rejects(attachChartTarget({
    target_id:'old-session',_deps:{listTargets:async()=>charts},
  }),/Stale\/non-chart/);
});


test('duplicate tabs without React layout name require exact visible suffix and explicit name', async () => {
  const rows=[
    {shell_tab_id:'keep',layout_name:null,label:'CRWV 62.20 ▲ +1.77% Stocks'},
    {shell_tab_id:'remove',layout_name:null,label:'MMM 171.08 ▲ +5.6% Stocks'},
    {shell_tab_id:'worker',layout_name:null,label:'BRN1! 108.40 DTV Worker 06'},
  ];
  let selected=false;
  const shell=async fn=>fn(async expression=>{
    if(expression.includes('Array.from(document.querySelectorAll'))return rows.map((x,index)=>({...x,index}));
    if(expression.includes('return {name:'))return {name:null,label:rows.find(x=>x.shell_tab_id==='remove')?.label||''};
    if(expression.includes('const close=tab.querySelector')){
      const target=JSON.parse(expression.match(/getElementById\(("[^"]+")\)/)[1]);
      if(target!=='remove')throw new Error('Wrong physical tab targeted');
      rows.splice(rows.findIndex(x=>x.shell_tab_id==='remove'),1);return true;
    }
    if(expression.includes('.tab.active'))return true;
    if(expression.includes('tab.click()')){selected=true;return true}
    if(expression.startsWith('!!document.getElementById'))return rows.some(x=>expression.includes(JSON.stringify(x.shell_tab_id)));
    throw new Error('Unexpected shell eval '+expression);
  });
  await assert.rejects(closeShellTabById({
    shell_tab_id:'remove',_deps:{withShell:shell},
  }),/Layout identity missing/);
  await assert.rejects(closeShellTabById({
    shell_tab_id:'worker',expected_layout_name:'Stocks',_deps:{withShell:shell},
  }),/Layout name changed/);
  const result=await closeShellTabById({
    shell_tab_id:'remove',expected_layout_name:'Stocks',
    protected_layout_names:['DTV Worker 06'],
    _deps:{withShell:shell,wait:async()=>{}},
  });
  assert.equal(result.success,true);
  assert.equal(selected,true);
  assert.deepEqual(rows.map(x=>x.shell_tab_id),['keep','worker']);
});
