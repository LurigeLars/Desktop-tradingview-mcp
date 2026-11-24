import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/ui.js';
import * as tabCore from '../core/tab.js';
import { isWorkerOwnedTab, status as workerStatus } from '../core/worker.js';
import { withTopologyMutationLock } from '../core/topology-lock.js';

const workerSlot = z.number().int().min(0).max(49).optional().describe(
  'Run on this resident worker tab (slot from worker_status) instead of the attached personal chart. Changes are not saved to the worker layout or registry; use worker_chart_control for supported changes, worker_provision to restore.');

export function registerUiTools(server) {
  server.tool('ui_click', 'Click a UI element by aria-label, data-name, text content, or class substring', {
    by: z.enum(['aria-label', 'data-name', 'text', 'class-contains']).describe('Selector strategy'),
    value: z.string().describe('Value to match against the chosen selector strategy'),
    worker_slot: workerSlot,
  }, async ({ by, value, worker_slot }) => {
    try { return jsonResult(await withTopologyMutationLock('ui_click', () => core.click({ by, value, worker_slot }))); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('ui_open_panel', 'Open, close, or toggle TradingView panels (pine-editor, strategy-tester, watchlist, alerts, trading)', {
    panel: z.enum(['pine-editor', 'strategy-tester', 'watchlist', 'alerts', 'trading']).describe('Panel name'),
    action: z.enum(['open', 'close', 'toggle']).describe('Action to perform'),
    worker_slot: workerSlot,
  }, async ({ panel, action, worker_slot }) => {
    try { return jsonResult(await withTopologyMutationLock('ui_open_panel', () => core.openPanel({ panel, action, worker_slot }))); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('ui_fullscreen', 'Toggle TradingView fullscreen mode', { worker_slot: workerSlot }, async ({ worker_slot }) => {
    try { return jsonResult(await withTopologyMutationLock('ui_fullscreen', () => core.fullscreen({ worker_slot }))); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('layout_list', 'List saved chart layouts', {}, async () => {
    try { return jsonResult(await core.layoutList()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('layout_switch', 'Attach controls to an OPEN saved personal layout by name, numeric ID, or chart URL token. Never discards unsaved changes or alters the visible Desktop tab.', {
    name: z.string().describe('Name, numeric saved-layout ID, or chart URL token'),
  }, async ({ name }) => {
    try {
      return jsonResult(await withTopologyMutationLock('layout_switch', async () => {
        const layouts = await core.layoutList();
        if (layouts.error) throw new Error(layouts.error);
        const selected = core.resolveSavedLayout(layouts.layouts, name);
        const tabs = await tabCore.list();
        const live = tabs.tabs.filter(t => t.is_chart && t.chart_id === selected.chart_id);
        if (live.length !== 1) throw new Error('Layout must have exactly one open chart: ' + selected.name);
        if (isWorkerOwnedTab(live[0], workerStatus())) {
          throw new Error('Refusing to attach interactive controls to a worker-owned layout.');
        }
        return core.layoutSwitch({ name, _deps: { listLayouts: async () => layouts } });
      }));
    } catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('ui_keyboard', 'Press keyboard keys or shortcuts (e.g., Enter, Escape, Alt+S, Ctrl+Z)', {
    key: z.string().describe('Key to press (e.g., "Enter", "Escape", "Tab", "a", "ArrowUp")'),
    modifiers: z.array(z.enum(['ctrl', 'alt', 'shift', 'meta'])).optional().describe('Modifier keys to hold (e.g., ["ctrl", "shift"])'),
    worker_slot: workerSlot,
  }, async ({ key, modifiers, worker_slot }) => {
    try { return jsonResult(await withTopologyMutationLock('ui_keyboard', () => core.keyboard({ key, modifiers, worker_slot }))); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('ui_type_text', 'Type text into the currently focused input/textarea element', {
    text: z.string().describe('Text to type into the focused element'),
    worker_slot: workerSlot,
  }, async ({ text, worker_slot }) => {
    try { return jsonResult(await withTopologyMutationLock('ui_type_text', () => core.typeText({ text, worker_slot }))); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('ui_hover', 'Hover over a UI element by aria-label, data-name, or text content', {
    by: z.enum(['aria-label', 'data-name', 'text', 'class-contains']).describe('Selector strategy'),
    value: z.string().describe('Value to match'),
    worker_slot: workerSlot,
  }, async ({ by, value, worker_slot }) => {
    try { return jsonResult(await core.hover({ by, value, worker_slot })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('ui_scroll', 'Scroll the chart or page up/down/left/right', {
    direction: z.enum(['up', 'down', 'left', 'right']).describe('Scroll direction'),
    amount: z.coerce.number().optional().describe('Scroll amount in pixels (default 300)'),
    worker_slot: workerSlot,
  }, async ({ direction, amount, worker_slot }) => {
    try { return jsonResult(await withTopologyMutationLock('ui_scroll', () => core.scroll({ direction, amount, worker_slot }))); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('ui_mouse_click', 'Click at specific x,y coordinates on the TradingView window', {
    x: z.coerce.number().describe('X coordinate (pixels from left)'),
    y: z.coerce.number().describe('Y coordinate (pixels from top)'),
    button: z.enum(['left', 'right', 'middle']).optional().describe('Mouse button (default left)'),
    double_click: z.coerce.boolean().optional().describe('Double click (default false)'),
    worker_slot: workerSlot,
  }, async ({ x, y, button, double_click, worker_slot }) => {
    try { return jsonResult(await withTopologyMutationLock('ui_mouse_click', () => core.mouseClick({ x, y, button, double_click, worker_slot }))); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('ui_find_element', 'Find UI elements by text, aria-label, or CSS selector and return their positions', {
    query: z.string().describe('Text content, aria-label value, or CSS selector to search for'),
    strategy: z.enum(['text', 'aria-label', 'css']).optional().describe('Search strategy (default: text)'),
    worker_slot: workerSlot,
  }, async ({ query, strategy, worker_slot }) => {
    try { return jsonResult(await core.findElement({ query, strategy, worker_slot })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('ui_evaluate', 'Execute JavaScript code in the TradingView page context for advanced automation', {
    expression: z.string().describe('JavaScript expression to evaluate in the page context. Wrap in IIFE for complex logic.'),
    worker_slot: workerSlot,
  }, async ({ expression, worker_slot }) => {
    try { return jsonResult(await withTopologyMutationLock('ui_evaluate', () => core.uiEvaluate({ expression, worker_slot }))); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
