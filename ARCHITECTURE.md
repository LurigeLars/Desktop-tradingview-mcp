# Architecture

## Dual local/remote MCP transport

The project has one canonical TradingView MCP implementation and two transport entrypoints:

- `src/server/stdio.js` — stdio transport for local clients such as Claude Code and Codex.
- `src/server/http.js` — Streamable HTTP transport for a persistent local endpoint used by a protected remote client path.

`src/server/create-server.js` owns all tool registration. Both transports expose the same tool set and permissions.

`src/server.js` remains a backward-compatible stdio entrypoint so existing MCP client configuration does not break.

### Local security boundary

- TradingView CDP defaults to `127.0.0.1:9333`.
- The Streamable HTTP server defaults to `127.0.0.1:8765/mcp`.
- The HTTP entrypoint refuses non-loopback bind addresses.
- HTTP request bodies are bounded to 2 MiB by default.
- Active HTTP MCP sessions are bounded and idle sessions are expired.
- The CDP port must never be published to a LAN or the internet.

Remote access is expected to terminate through an authenticated tunnel on the same Windows host and forward only to the loopback HTTP MCP endpoint. The tunnel/authentication layer is deployment configuration, not part of the MCP core.
