# Architecture

## Dual local/remote MCP transport

The project has one canonical TradingView MCP implementation and two transport entrypoints:

- `src/server/stdio.js` — stdio transport for local MCP clients.
- `src/server/http.js` — Streamable HTTP transport for a persistent loopback endpoint used by a protected remote client path.

`src/server/create-server.js` owns all tool registration. Both transports expose the same tool set and permissions.

`src/server.js` remains a backward-compatible stdio entrypoint so existing MCP client configuration does not break.

### Local security boundary

- TradingView CDP defaults to `127.0.0.1:9222`.
- The Streamable HTTP server defaults to `127.0.0.1:8765/mcp`.
- The HTTP entrypoint refuses non-loopback bind addresses.
- HTTP request bodies are bounded to 2 MiB by default.
- Active HTTP MCP sessions are bounded and idle sessions are expired.
- The CDP port must never be published to a LAN or the internet.
- TradingView Desktop does not need to remain running: clients may start it on demand with `tv_launch` and stop the instance managed by the same MCP process with `tv_close`.
- `tv_close` never performs a name-wide process kill; it refuses to close instances that were not launched by the current MCP process.

### Remote edge

The reference remote deployment is intentionally separated from the host MCP runtime:

- `compose.public.yaml` runs a dedicated `cloudflared` container and a small Node gateway.
- The gateway is not published on a host port.
- The gateway reaches the host MCP through `host.docker.internal:8765` while setting the upstream `Host` header to `localhost:8765`, preserving the MCP server's loopback host-header guard.
- Cloudflare Access Managed OAuth authenticates the remote MCP client.
- The gateway independently validates the resulting Cloudflare Access JWT, including issuer, audience, expiry and an explicit email allowlist, before forwarding.
- Client credentials and Cloudflare identity headers are stripped before reaching the MCP process.
- The Cloudflare tunnel is dedicated to this application and can be stopped without affecting local stdio use.

See `docs/remote-mcp-cloudflare.md` for deployment details.
