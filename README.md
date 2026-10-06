# TradingView Desktop MCP Bridge

[![CI](https://github.com/LurigeLars/Desktop-tradingview-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/LurigeLars/Desktop-tradingview-mcp/actions/workflows/ci.yml)
[![CodeQL](https://github.com/LurigeLars/Desktop-tradingview-mcp/actions/workflows/codeql.yml/badge.svg)](https://github.com/LurigeLars/Desktop-tradingview-mcp/actions/workflows/codeql.yml)
![Node.js](https://img.shields.io/badge/node-18%2B-green)
![License](https://img.shields.io/badge/license-MIT-green)

A Model Context Protocol (MCP) bridge that lets AI clients interact with **your own
locally running TradingView Desktop application**.

Instead of pretending to be a separate TradingView data service, this project drives the
real desktop app through Chrome DevTools Protocol (CDP). An MCP client can inspect chart
state, read locally visible market data and indicators, navigate symbols/timeframes,
develop Pine Script, manage chart objects and automate chart workflows.

> **Unofficial project.** This repository is not affiliated with, endorsed by or
> associated with TradingView Inc.

> **A valid TradingView subscription is still required.** The bridge does not bypass
> subscriptions, paywalls, entitlements or other TradingView access controls.

## Why this project exists

TradingView Desktop already contains the state a human analyst is working with: the
selected symbol, timeframe, layout, indicators, Pine scripts, drawings, alerts and
subscription-entitled market data.

The purpose of this bridge is to make that **existing interactive workspace legible and
controllable through MCP**, rather than building another independent market-data stack.

That makes it useful for workflows such as:

- asking an agent what is currently on a chart;
- changing symbol/timeframe/layout and then restoring the previous state;
- reading indicator tables, lines, labels and strategy output;
- writing, compiling and debugging Pine Script;
- capturing screenshots for visual analysis;
- reading chart-local quote/OHLCV data;
- coordinating multi-pane layouts;
- running local chart-monitoring or research workflows.

It is an interface layer for human-AI collaboration around TradingView, **not a trading
bot and not a broker connection**.

## Why this fork exists

This repository is a maintained fork of
[tradesdontlie/tradingview-mcp](https://github.com/tradesdontlie/tradingview-mcp).

It keeps the upstream Desktop/CDP architecture while hardening it for long-running local
and remote MCP use. Fork-specific work includes:

- fresher quote reads from resident TradingView runtime fields with stricter symbol
  identity checks;
- resilient worker/tab/pane discovery and recovery from stale or hidden views;
- bounded session pressure and request/rate handling;
- safer TradingView launch and process lifecycle behavior;
- a shared resident watch manifest for repeated market context;
- a loopback Streamable HTTP transport in addition to local stdio;
- a reviewed Cloudflare Access gateway for remote MCP clients such as ChatGPT;
- sanitized deployment templates, CI, static analysis and CodeQL hardening.

The fork remains centered on **the user's own TradingView Desktop session**.

## How it works

TradingView Desktop is an Electron/Chromium application. When you explicitly start it
with a Chromium remote-debugging flag, the bridge can connect to the local CDP endpoint
and interact with the app.

```text
Local MCP client
      |
      v
TradingView MCP
      |
      v
127.0.0.1:9222  (Chrome DevTools Protocol)
      |
      v
TradingView Desktop
```

For an optional remote MCP client:

```text
ChatGPT / remote MCP client
      |
      v
Cloudflare Access
      |
      v
reviewed gateway
      |
      v
127.0.0.1:8765/mcp
      |
      v
TradingView MCP -> local CDP -> TradingView Desktop
```

The CDP endpoint and raw MCP HTTP server are intended to remain loopback-only.

## Security and state model

The bridge controls a **stateful desktop application**, so the main risk is not only
network exposure — it is also shared UI state.

- TradingView CDP defaults to `127.0.0.1:9222`.
- Streamable HTTP defaults to `127.0.0.1:8765/mcp` and rejects non-loopback binds.
- Remote access should terminate at the included Cloudflare Access gateway.
- The gateway validates Access identity, strips client credentials and applies bounded
  request/tool policy before forwarding.
- The CDP port should never be exposed directly to a LAN or the Internet.
- Multiple clients control the **same** TradingView windows/tabs/panes.
- A client that mutates chart state should account for the fact that another client or
  the human user can change it concurrently.
- `tv_close` is limited to instances launched by the current MCP process; it does not
  perform a name-wide process kill.
- Machine-specific paths, identities and Cloudflare credentials belong only in ignored
  local configuration.

See [ARCHITECTURE.md](ARCHITECTURE.md) and [SECURITY.md](SECURITY.md) for the detailed
transport and security model.

## What it does not do

- It does **not** provide an independent hosted TradingView data feed.
- It does **not** bypass TradingView subscriptions or market-data entitlements.
- It does **not** connect to a brokerage account or execute real trades.
- It does **not** make undocumented TradingView internals stable; Desktop updates can
  break selectors, workers or runtime structures.
- It does **not** give each MCP client an isolated chart session — the desktop UI is
  shared state.

## Research context

The project also explores a practical question: how well can an LLM agent operate a
professional, stateful financial desktop interface while keeping the human in control?

That includes reliability around mutable UI state, latency, chart interpretation,
Pine Script iteration and coordination between interactive and automated workflows.

See [RESEARCH.md](RESEARCH.md) for the longer research notes.

## Prerequisites

- **TradingView Desktop app** (paid subscription required for real-time data)
- **Node.js 18+**
- **A compatible MCP client** (Claude Code, Codex, ChatGPT through the optional gateway, etc.) or any terminal for CLI use
- **macOS, Windows, or Linux**

## What It Does

Gives your AI assistant eyes and hands on your own chart:

- **Pine Script development** — write, inject, compile, debug, and iterate on scripts with AI assistance
- **Chart navigation** — change symbols, timeframes, zoom to dates, add/remove indicators
- **Visual analysis** — read your chart's indicator values, price levels, and annotations
- **Draw on charts** — trend lines, horizontal lines, rectangles, text annotations
- **Manage alerts** — create, list, and delete price alerts
- **Replay practice** — step through historical bars, practice entries/exits
- **Screenshots** — capture chart state for AI visual analysis
- **Multi-pane layouts** — set up 2x2, 3x1, etc. grids with different symbols per pane
- **Monitor your chart** — stream JSONL from your locally running chart for local monitoring scripts
- **CLI access** — every MCP tool is also a `tv` CLI command, pipe-friendly with JSON output
- **Launch TradingView** — auto-detect and launch with debug mode from any platform

## Install with Claude Code

Paste this into Claude Code and it will handle the rest:

> Install this TradingView MCP fork. Clone https://github.com/LurigeLars/Desktop-tradingview-mcp.git, run npm install, add it to my MCP config at ~/.claude/.mcp.json, and launch TradingView with the debug port. Then verify the connection with tv_health_check.

Or follow the manual steps below.

## Quick Start

### 1. Install

```bash
git clone https://github.com/LurigeLars/Desktop-tradingview-mcp.git
cd Desktop-tradingview-mcp
npm install
```

### 2. Launch TradingView with CDP

TradingView Desktop must be running with Chrome DevTools Protocol enabled on port 9222.

**Mac:**
```bash
./scripts/launch_tv_debug_mac.sh
```

**Windows:**
```bash
scripts\launch_tv_debug.bat
```

**Linux:**
```bash
./scripts/launch_tv_debug_linux.sh
```

**Or launch manually on any platform:**
```bash
/path/to/TradingView --remote-debugging-port=9222
```

**Or use the MCP tool** (auto-detects your install):
> "Use tv_launch to start TradingView in debug mode"

### 3. Add to Claude Code

Add to your Claude Code MCP config (`~/.claude/.mcp.json` or project `.mcp.json`):

```json
{
  "mcpServers": {
    "tradingview": {
      "command": "node",
      "args": ["/path/to/tradingview-mcp/src/server.js"]
    }
  }
}
```

Replace `/path/to/tradingview-mcp` with your actual path.

### 4. Verify

Ask Claude: *"Use tv_health_check to verify TradingView is connected"*

## Claude Desktop, Codex and other clients

The transport is stdio, so every local client uses the same command with a different
configuration file. Replace the path with your own checkout.

| Client | Where the configuration lives |
|---|---|
| Claude Code | `~/.claude/.mcp.json`, or a project `.mcp.json` |
| Claude Desktop | Settings > Developer > Edit Config, then restart Desktop fully |
| Codex | `codex mcp add tradingview -- node /path/to/Desktop-tradingview-mcp/src/server.js` |
| Cursor, VS Code | `.cursor/mcp.json`, `.vscode/mcp.json` |

Claude Desktop takes the same block as Claude Code:

```json
{
  "mcpServers": {
    "tradingview": {
      "command": "node",
      "args": ["/path/to/Desktop-tradingview-mcp/src/server.js"]
    }
  }
}
```

On Windows, give `command` the absolute path to `node.exe` if the client does not resolve it from
`PATH`; Claude Desktop in particular does not.

### One app, one chart, several clients

Every client drives the *same* running TradingView Desktop over the same debug port. There is no
per-client session, so the chart is shared state:

- Changing the symbol, timeframe or layout changes what the person sees, immediately.
- Two clients working at once will fight over the chart, and a read taken after the other one moved
  it returns the wrong instrument's data without any error.
- `tv_launch` with `kill_existing` restarts the application and closes what was open.

So a client that changes the chart should record what it was and put it back, and an automated job
should not share an app with an interactive session. This is the cost of driving the real app
instead of a headless browser -- and the reason the interactive session can never be displaced,
which was the point of the fork.

## Optional HTTP and ChatGPT access

The normal local transport is stdio. This fork also includes a loopback-only Streamable HTTP server for clients that need HTTP:

```bash
node src/server/http.js
```

By default it listens on `http://127.0.0.1:8765/mcp` and refuses non-loopback bind hosts.

For remote clients such as ChatGPT, keep that HTTP server on loopback and place the included gateway behind Cloudflare Access:

```text
Remote MCP client -> Cloudflare Access -> shared Cloudflare Tunnel
                  -> tradingview-gateway:8080
                  -> 127.0.0.1:8765/mcp
                  -> TradingView Desktop via CDP on 127.0.0.1:9222
```

Copy `public/gateway.env.example` to the gitignored `public/gateway.env`, replace the placeholders with your own Cloudflare Access values, then start the gateway:

```bash
docker compose -f compose.public.yaml up -d
```

The gateway requires a valid Cloudflare Access JWT, strips client credentials before proxying, applies request/rate limits, and exposes the full 93-tool surface by default. Set `ALLOWED_TOOLS=core` to select the smaller reviewed profile.

## CLI

Every MCP tool is also accessible as a `tv` CLI command. All output is JSON for piping with `jq`.

```bash
# Install globally (optional)
npm link

# Or run directly
node src/cli/index.js <command>
```

### Quick Examples

```bash
tv status                          # check connection
tv quote                           # current price
tv symbol AAPL                     # change symbol
tv ohlcv --summary                 # price summary
tv screenshot -r chart             # capture chart
tv pine compile                    # compile Pine Script
tv pane layout 2x2                 # 4-chart grid
tv pane symbol 1 ES1!              # set pane symbol
tv stream quote | jq '.close'      # monitor price changes
```

### All Commands

```
tv status / launch / state / symbol / timeframe / type / info / search
tv quote / ohlcv / values
tv data lines/labels/tables/boxes/strategy/trades/equity/depth/indicator
tv pine get/set/compile/analyze/check/save/new/open/list/errors/console
tv draw shape/list/get/remove/clear
tv alert list/create/delete
tv watchlist get/add
tv indicator add/remove/toggle/set/get
tv layout list/switch
tv pane list/layout/focus/symbol
tv tab list/new/close/switch
tv replay start/step/stop/status/autoplay/trade
tv stream quote/bars/values/lines/labels/tables/all
tv ui click/keyboard/hover/scroll/find/eval/type/panel/fullscreen/mouse
tv screenshot / discover / ui-state / range / scroll
```

## Streaming

The `tv stream` commands poll your locally running TradingView Desktop instance at regular intervals via Chrome DevTools Protocol on localhost.

No connection is made to TradingView's servers. All data stays on your machine.

> [!WARNING]
> Programmatic consumption of TradingView data may conflict with their Terms of Use regardless of the data source. You are solely responsible for ensuring your usage complies.

```bash
tv stream quote                          # price tick monitoring
tv stream bars                           # bar-by-bar updates
tv stream values                         # indicator value monitoring
tv stream lines --filter "NY Levels"     # price level monitoring
tv stream tables --filter Profiler       # table data monitoring
tv stream all                            # all panes at once (multi-symbol)
```

## How Claude Knows Which Tool to Use

Claude reads [`CLAUDE.md`](CLAUDE.md) automatically when working in this project. It contains a complete decision tree:

| You say... | Claude uses... |
|------------|---------------|
| "What's on my chart?" | `chart_get_state` → `data_get_study_values` → `quote_get` |
| "What levels are showing?" | `data_get_pine_lines` → `data_get_pine_labels` |
| "Read the session table" | `data_get_pine_tables` with `study_filter` |
| "Give me a full analysis" | `quote_get` → `data_get_study_values` → `data_get_pine_lines` → `data_get_pine_labels` → `data_get_pine_tables` → `data_get_ohlcv` (summary) → `capture_screenshot` |
| "Switch to AAPL daily" | `chart_set_symbol` → `chart_set_timeframe` |
| "Write a Pine Script for..." | `pine_set_source` → `pine_smart_compile` → `pine_get_errors` |
| "Start replay at March 1st" | `replay_start` → `replay_step` → `replay_trade` |
| "Set up a 4-chart grid" | `pane_set_layout` → `pane_set_symbol` for each pane |
| "Draw a level at 24500" | `draw_shape` (horizontal_line) |
| "Take a screenshot" | `capture_screenshot` |
| "Run my morning brief" | `morning_brief` → interpret the returned evidence with configured rules → `session_save` when the brief is complete |
| "What did yesterday's brief say?" | `session_get` |

## Tool Reference (93 MCP tools)

### Market Watch Manifest

`watch-manifest.json` is the canonical resident-market configuration for this fork. It groups broad regime, rates/FX, AI/semis, volatility/credit, energy, refiners, gold and current tactical context without duplicating equivalent symbol/timeframe workers.

Use `watch_manifest_apply` with no theme arguments to load the defaults. Optional `extra_entries` are intended for temporary active trades or WATCH candidates and are tagged as `watch:dynamic`. The manifest reserves connection capacity for ad-hoc/event work instead of filling the worker budget completely.

After applying the manifest, run `worker_provision` until it reports `complete: true`.

### Morning Brief

The morning workflow is deliberately split into collection, interpretation, and storage:

The project `rules.json` supplies a default cross-market regime rubric with `BULLISH / BEARISH / NEUTRAL_MIXED / UNAVAILABLE` labels and a separate evidence scope (`LIVE`, `LAST_COMPLETED_SESSION`, or `UNAVAILABLE`). A local `morning-rules.json` overlays project defaults instead of silently removing the default bias criteria unless it explicitly sets `bias_criteria`.

1. Configure resident worker symbols/indicators and put the relevant entries in a logical group such as `morning`.
2. Copy `rules.example.json` to either the project `rules.json` or the local TradingView MCP state directory as `morning-rules.json`, then define the selection, evidence settings, bias criteria, and risk rules.
3. Call `morning_brief`. It reads already-resident charts through the realtime snapshot path; it does **not** switch symbols or mutate the active chart. Compact evidence is the default; request `evidence_mode=full` only when raw recent bars are needed.
4. Apply the returned rules to the returned evidence. Missing, ambiguous, delayed, or stale evidence should remain explicit rather than being inferred.
5. Once the human-readable brief is complete, call `session_save` to persist it. Use `session_get` later to compare sessions.

| Tool | What it does |
|------|--------------|
| `morning_brief` | Collect resident market evidence and the configured interpretation/risk rules |
| `session_save` | Explicitly save a completed brief (and optional structured evidence) by local session date |
| `session_get` | Retrieve a saved date; without a date, use today or fall back to yesterday |

### Chart Reading

| Tool | When to use | Output size |
|------|------------|-------------|
| `chart_get_state` | First call — get symbol, timeframe, all indicator names + IDs | ~500B |
| `data_get_study_values` | Read current RSI, MACD, BB, EMA values from all indicators | ~500B |
| `quote_get` | Get latest price, OHLC, volume | ~200B |
| `data_get_ohlcv` | Get price bars. **Use `summary: true`** for compact stats | 500B (summary) / 8KB (100 bars) |

### Custom Indicator Data (Pine Drawings)

Read `line.new()`, `label.new()`, `table.new()`, `box.new()` output from any visible Pine indicator.

| Tool | When to use | Output size |
|------|------------|-------------|
| `data_get_pine_lines` | Read horizontal price levels (support/resistance, session levels) | ~1-3KB |
| `data_get_pine_labels` | Read text annotations + prices ("PDH 24550", "Bias Long") | ~2-5KB |
| `data_get_pine_tables` | Read data tables (session stats, analytics dashboards) | ~1-4KB |
| `data_get_pine_boxes` | Read price zones / ranges as {high, low} pairs | ~1-2KB |

**Always use `study_filter`** to target a specific indicator: `study_filter: "Profiler"`.

### Chart Control

| Tool | What it does |
|------|-------------|
| `chart_set_symbol` | Change ticker (BTCUSD, AAPL, ES1!, NYMEX:CL1!) |
| `chart_set_timeframe` | Change resolution (1, 5, 15, 60, D, W, M) |
| `chart_set_type` | Change style (Candles, HeikinAshi, Line, Area, Renko) |
| `chart_manage_indicator` | Add/remove indicators. **Use full names**: "Relative Strength Index" not "RSI" |
| `chart_scroll_to_date` | Jump to a date (ISO: "2025-01-15") |
| `chart_set_visible_range` | Zoom to exact range (unix timestamps) |
| `symbol_info` / `symbol_search` | Symbol metadata and search |
| `indicator_set_inputs` / `indicator_toggle_visibility` | Change indicator settings, show/hide |

### Multi-Pane Layouts

| Tool | What it does |
|------|-------------|
| `pane_list` | List all panes with symbols and active state |
| `pane_set_layout` | Change grid: `s`, `2h`, `2v`, `2x2`, `4`, `6`, `8` |
| `pane_focus` | Focus a specific pane by index |
| `pane_set_symbol` | Set symbol on any pane |

### Tab Management

| Tool | What it does |
|------|-------------|
| `tab_list` | List open chart tabs |
| `tab_new` / `tab_close` | Open/close tabs |
| `tab_switch` | Switch to a tab by index |

### Pine Script Development

| Tool | Step |
|------|------|
| `pine_set_source` | 1. Inject code into editor |
| `pine_smart_compile` | 2. Compile with auto-detection + error check |
| `pine_get_errors` | 3. Read compilation errors if any |
| `pine_get_console` | 4. Read log.info() output |
| `pine_save` | 5. Save to TradingView cloud |
| `pine_get_source` | Read current script (**warning: can be 200KB+ for complex scripts**) |
| `pine_new` | Create blank indicator/strategy/library |
| `pine_open` / `pine_list_scripts` | Open or list saved scripts |
| `pine_analyze` | Offline static analysis (no chart needed) |
| `pine_check` | Server-side compile check (no chart needed) |

### Replay Mode

| Tool | Step |
|------|------|
| `replay_start` | Enter replay at a date |
| `replay_step` | Advance one bar |
| `replay_autoplay` | Auto-advance (set speed in ms) |
| `replay_trade` | Buy/sell/close positions |
| `replay_status` | Check position, P&L, date |
| `replay_stop` | Return to realtime |

### Drawing, Alerts, UI Automation

| Tool | What it does |
|------|-------------|
| `draw_shape` | Draw horizontal_line, trend_line, rectangle, text |
| `draw_list` / `draw_remove_one` / `draw_clear` | Manage drawings |
| `alert_create` / `alert_list` / `alert_delete` | Manage price alerts |
| `capture_screenshot` | Screenshot (regions: full, chart, strategy_tester) |
| `batch_run` | Run action across multiple symbols/timeframes |
| `watchlist_get` / `watchlist_add` | Read/modify watchlist |
| `layout_list` / `layout_switch` | Manage saved layouts |
| `ui_open_panel` / `ui_click` / `ui_evaluate` | UI automation |
| `tv_launch` / `tv_health_check` / `tv_discover` | Connection management |

## Context Management

Tools return compact output by default to minimize context usage. For a typical "analyze my chart" workflow, total context is ~5-10KB instead of ~80KB.

| Feature | How it saves context |
|---------|---------------------|
| Pine lines | Returns deduplicated price levels only, not every line object |
| Pine labels | Capped at 50 per study, text+price only |
| Pine tables | Pre-formatted row strings, no cell metadata |
| Pine boxes | Deduplicated {high, low} zones only |
| OHLCV summary mode | Stats + last 5 bars instead of all bars |
| Indicator inputs | Encrypted/encoded blobs auto-filtered |
| `verbose: true` | Pass on any pine tool to get raw data with IDs/colors when needed |
| `study_filter` | Target one indicator instead of scanning all |

## Finding TradingView on Your System

Launch scripts and `tv_launch` auto-detect TradingView. If auto-detection fails:

| Platform | Common Locations |
|----------|-----------------|
| **Mac** | `/Applications/TradingView.app/Contents/MacOS/TradingView` |
| **Windows** | `%LOCALAPPDATA%\TradingView\TradingView.exe`, `%PROGRAMFILES%\WindowsApps\TradingView*\TradingView.exe` |
| **Linux** | `/opt/TradingView/tradingview`, `~/.local/share/TradingView/TradingView`, `/snap/tradingview/current/tradingview` |

The key flag: `--remote-debugging-port=9222`

## Testing

```bash
# Requires TradingView running with --remote-debugging-port=9222
npm test
```

The test suite covers Pine Script analysis/compilation, CLI routing, HTTP transport and session pressure, public-gateway behavior, realtime reads, tab/worker reconciliation, and related regression cases.

## Architecture

```text
Local MCP client  <-> MCP server (stdio) ---------------------> CDP :9222 <-> TradingView Desktop
Remote MCP client <-> Cloudflare Access <-> gateway <-> HTTP :8765 <-> CDP :9222 <-> TradingView Desktop
```

- **Transport**: MCP over stdio or loopback-only Streamable HTTP (92 tools), plus the `tv` CLI.
- **Connection**: Chrome DevTools Protocol on `127.0.0.1:9222`.
- **Remote gateway**: optional Cloudflare Access path; the host MCP server remains loopback-only.
- **Streaming**: poll-and-diff loop with deduplication and JSONL output to stdout.
- **Runtime dependencies**: `@modelcontextprotocol/sdk` and `chrome-remote-interface`.

## Attributions

This project is not affiliated with, endorsed by, or associated with:
- **TradingView Inc.** — TradingView is a trademark of TradingView Inc.
- **Anthropic** — Claude and Claude Code are trademarks of Anthropic, PBC.

This tool is an independent MCP server that connects to compatible clients through the standard MCP protocol. It does not contain or modify any Anthropic software.

## Disclaimer

This project is provided **for personal, educational, and research purposes only**.

**How this tool works:** This tool uses Chrome DevTools Protocol (CDP), the standard debugging interface built into Chromium-based applications. It does not reverse engineer any proprietary TradingView protocol, connect to TradingView's servers, or bypass any access controls. The debug port must be explicitly enabled by the user via a standard Chromium command-line flag (`--remote-debugging-port=9222`).

By using this software, you acknowledge and agree that:

1. **You are solely responsible** for ensuring your use of this tool complies with [TradingView's Terms of Use](https://www.tradingview.com/policies/) and all applicable laws.
2. TradingView's Terms of Use **restrict automated data collection, scraping, and non-display usage** of their platform and data. This tool uses Chrome DevTools Protocol to programmatically interact with the TradingView Desktop app, which may conflict with those terms.
3. **You assume all risk** associated with using this tool. The authors are not responsible for any account bans, suspensions, legal actions, or other consequences resulting from its use.
4. This tool **must not be used** for, including but not limited to:
   - Redistributing, reselling, or commercially exploiting TradingView's market data
   - Circumventing TradingView's access controls or subscription restrictions
   - Performing automated trading or algorithmic decision-making using extracted data
   - Violating the intellectual property rights of Pine Script indicator authors
   - Connecting to TradingView's servers or infrastructure (all access is via the locally running Desktop app)
5. The streaming functionality monitors your locally running TradingView Desktop instance only. It does not connect to TradingView's servers or extract data from TradingView's infrastructure.
6. Market data accessed through this tool remains subject to exchange and data provider licensing terms. **Do not redistribute, store, or commercially exploit any data obtained through this tool.**
7. This tool accesses internal, undocumented TradingView application interfaces that may change or break at any time without notice.

**Use at your own risk.** If you are unsure whether your intended use complies with TradingView's terms, do not use this tool.

## License

MIT — see [LICENSE](LICENSE) for details.

The MIT license applies to the source code of this project only. It does not grant any rights to TradingView's software, data, trademarks, or intellectual property.
