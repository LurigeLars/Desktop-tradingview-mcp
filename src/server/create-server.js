import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerHealthTools } from '../tools/health.js';
import { registerChartTools } from '../tools/chart.js';
import { registerPineTools } from '../tools/pine.js';
import { registerDataTools } from '../tools/data.js';
import { registerCaptureTools } from '../tools/capture.js';
import { registerDrawingTools } from '../tools/drawing.js';
import { registerAlertTools } from '../tools/alerts.js';
import { registerBatchTools } from '../tools/batch.js';
import { registerReplayTools } from '../tools/replay.js';
import { registerIndicatorTools } from '../tools/indicators.js';
import { registerWatchlistTools } from '../tools/watchlist.js';
import { registerNewsTools } from '../tools/news.js';
import { registerUiTools } from '../tools/ui.js';
import { registerPaneTools } from '../tools/pane.js';
import { registerTabTools } from '../tools/tab.js';
import { registerRealtimeTools } from '../tools/realtime.js';
import { registerWorkerTools } from '../tools/worker.js';
import { registerWorkerProvisionTools } from '../tools/worker-provision.js';
import { registerMorningTools } from '../tools/morning.js';
import { registerWatchManifestTools } from '../tools/watch-manifest.js';
import { installLegacyToolAnnotationAdapter } from './tool-annotations.js';

export const SERVER_INFO = {
  name: 'tradingview',
  version: '2.0.0',
  description: 'AI-assisted TradingView chart analysis and Pine Script development via Chrome DevTools Protocol',
};

export const SERVER_INSTRUCTIONS = `Read and control TradingView Desktop charts. Use the realtime-market-data and desktop-operations skills for workflows.

- Protect DTV Market/Worker layouts used by TradeAlert and other consumers. Leave changes to worker tools. For a duplicate worker layout use worker_target_audit, then worker_retire_nonmatching and worker_cleanup_retired_shell only when the registered instance is verified.
- For research use an attached task-owned non-worker layout. Opening by symbol alone may inherit a worker layout. Check chart_get_state first. Capture and restore the symbol, resolution and visible range after chart mutations, including failures. Close only the intended test tab using its verified shell_tab_id.
- Use realtime_snapshot for existing pane resolutions, morning_brief for compact resident context, and worker_rotate_snapshot for temporary coverage when its contract fits. Check actual resolution, freshness and restoration. A missing resident timeframe calls for a safe DTV candle read.
- Use data_get_ohlcv for actual candles, summary=true for stats, and history for older pages. batch_run changes a research chart sequentially and returns counts/last_bar for OHLCV. Choose it for finite watchlists or multi-timeframe work when that suffices; verify per-item coverage.
- Keep Pine studies visible for their drawing outputs and narrow with study_filter. Use full study names to add indicators, and avoid pine_get_source unless needed. Prefer bounded results and screenshots for visual questions.
- tv_close exits the entire MCP-managed TradingView Desktop app. Use tab_close for one tab. Official TradingView MCP/API is retired; use the Desktop bridge.`;

export function createTradingViewServer() {
  const server = new McpServer(
    SERVER_INFO,
    {
      instructions: SERVER_INSTRUCTIONS,
    }
  );

  // Legacy server.tool registrations must receive explicit safety metadata.
  // This adapter fails closed if a newly added legacy tool is not classified.
  installLegacyToolAnnotationAdapter(server);

  registerHealthTools(server);
  registerChartTools(server);
  registerPineTools(server);
  registerDataTools(server);
  registerCaptureTools(server);
  registerDrawingTools(server);
  registerAlertTools(server);
  registerBatchTools(server);
  registerReplayTools(server);
  registerIndicatorTools(server);
  registerWatchlistTools(server);
  registerNewsTools(server);
  registerUiTools(server);
  registerPaneTools(server);
  registerTabTools(server);
  registerRealtimeTools(server);
  registerWorkerTools(server);
  registerWorkerProvisionTools(server);
  registerMorningTools(server);
  registerWatchManifestTools(server);

  return server;
}

export function writeStartupNotice() {
  process.stderr.write('⚠  tradingview-mcp  |  Unofficial tool. Not affiliated with TradingView Inc. or Anthropic.\n');
  process.stderr.write('   Ensure your usage complies with TradingView\'s Terms of Use.\n\n');
}
