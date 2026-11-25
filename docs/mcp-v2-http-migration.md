# MCP 2026-07-28 stateless HTTP alongside the legacy transport

`src/server/http.js` serves both protocol eras on the same authenticated endpoint:

- **2026-07-28 (modern)** requests, identified by the SDK's own `isLegacyRequest` classifier, go to `createMcpHandler(..., { legacy: 'reject' })` from `@modelcontextprotocol/server` 2.3.0 through `toNodeHandler` (`@modelcontextprotocol/node` 2.1.1). Each request gets a server instance of its own; no `mcp-session-id` is issued.
- **2025-era (legacy)** requests keep the existing sessionful `StreamableHTTPServerTransport` from `@modelcontextprotocol/sdk` 1.x, with the same session cap and idle reclaim as before.
- **stdio** is unchanged and still uses the legacy SDK server.

Host-header validation, the bearer token, the path check, Content-Type (415) and the body limit (413) run before classification, so both eras share them. Classification never falls back to legacy for a malformed modern request: the modern path answers it with its own error.

Workers, CDP connections, tool handlers, safety annotations and the public gateway are unchanged. The gateway checks the tool name in the JSON-RPC body. The server rejects a request whose `Mcp-Name` header names a different tool than the body (tested), so a header cannot slip past that check.

## Behaviour that differs between eras

| | Legacy (2025) | Modern (2026-07-28) |
|---|---|---|
| Handshake | `initialize` + `notifications/initialized` | none; `server/discover` is optional |
| Server state between requests | one session per client, up to `TV_MCP_HTTP_MAX_SESSIONS` | none |
| Capacity limit | `TV_MCP_HTTP_MAX_SESSIONS` sessions → 503 | the same number of **open exchanges** → 503; a `subscriptions/listen` stream holds one slot until the client disconnects |
| Unknown tool | `isError` tool result (SDK 1.x) | JSON-RPC error `-32602` |
| Invalid arguments | `isError` result | `isError` result |
| Unsupported protocol version | — | HTTP 400, `-32022`, lists `supported` |
| `inputSchema` dialect | `$schema` draft-07 | `$schema` 2020-12 |
| `ping` | supported | HTTP 404 `-32601` (not served by the SDK's modern path) |

Apart from `$schema`, the tool catalog is identical: 109 tools with the same names, descriptions, annotations and input schemas, and no output schemas. A test asserts this.

The v2 entry creates a server per request. To keep that cheap, the tool catalog (its Zod schemas and wrapped handlers) is built once and replayed onto each new instance. Tool handlers never reference the server they were registered on.

## Measured performance

`node scripts/bench-mcp-transport.mjs --runs 3`. Each mode runs in a fresh child process on an ephemeral loopback port, with a synthetic token, a temporary `LOCALAPPDATA` and tool-usage telemetry turned off. Every call is `pine_analyze` on a synthetic script: offline, with no CDP, chart or account access. So the latencies are transport plus server overhead, not chart work. Host: Windows 11, Node 22.23.2, on the same machine as running local services (some noise). Each value is the median of 3 runs, with the range in brackets.

| Metric | Legacy | Modern (final) | Modern (PR before catalog reuse) |
|---|---|---|---|
| Idle RSS after start | 92.2 MiB [92.0–92.3] | 92.5 MiB [92.1–92.7] | 92.3 MiB |
| Warm call, one client, p50 / p95 (n=500) | 8.8 / 16.6 ms | 9.1 / 16.8 ms | 9.1 / 17.5 ms |
| New client + one call, p50 / p95 (n=200) | 43.2 / 63.8 ms | 8.6 / 16.6 ms | 9.3 / 17.7 ms |
| 64 concurrent clients × 20 calls: throughput | 1728 calls/s [1350–1735] | 1347 calls/s [1288–1374] | 331 calls/s [224–358] |
| Same load: errors | 0 | 0 | 0 |
| Same load: sessions held by server | 64 | 0 | 0 |
| Same load: heap after GC, clients still connected | 79.4 MiB | 24.0 MiB | 24.1 MiB |
| Heap after GC, clients gone | 22.9 MiB | 23.5 MiB | 24.1 MiB |
| Peak RSS during load | 181.5 MiB [179–183] | 236.2 MiB [207–256] | 238.1 MiB [218–258] |

What the measurements show:

- **Per-client state:** the legacy transport keeps about 0.9 MiB of heap per connected session (79.4 − 22.9 MiB across 64 sessions) until the session is closed or reclaimed after idling. The modern transport keeps none, so the session cap and idle reclaim no longer limit modern clients.
- **New clients:** a new client's first call is about 5× faster at p50 (43 → 8.6 ms) and 3.8× at p95, because the handshake round trips are gone.
- **Steady single-client latency:** no measurable difference. In both modes p95 sits at about 16–17 ms. That matches the ~15.6 ms Windows timer tick (an inference, not verified), so differences smaller than that cannot be resolved on this host.
- **Concurrent throughput:** the modern transport is about 22% slower (median 1347 vs 1728 calls/s) because it builds a server and web Request/Response objects for every call. Before the catalog was reused, it ran at 331 calls/s, about 4× slower than now.
- **Peak RSS:** the modern transport has a higher peak RSS under a burst of concurrent requests (+55 MiB median, with a wide range), even though its retained heap is smaller. The allocation churn grows the process and V8 does not hand that memory back to the OS right away. RSS after the load stayed at the peak in both modes.

Not measured: real chart tools over CDP, long-running listen streams at scale, and Linux or macOS hosts.

## Deployment

Merging changes nothing that is running: the managed HTTP server keeps its loaded code until it is restarted. Coordinate that restart (see `docs/windows-managed-http-task.md`) with the other work in progress. Legacy clients keep working unchanged after the restart.
