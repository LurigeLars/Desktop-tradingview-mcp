# Remote MCP via Docker + Cloudflare Access

The local MCP server remains on the Windows host at `127.0.0.1:8765/mcp`.
Remote access is isolated in Docker:

```text
remote MCP client
  -> Cloudflare Access / Managed OAuth
  -> dedicated Cloudflare Tunnel
  -> cloudflared container
  -> JWT-validating gateway container
  -> host.docker.internal:8765
  -> TradingView MCP HTTP transport
  -> TradingView Desktop CDP on 127.0.0.1:9222
```

No Docker service publishes a host port. The gateway connects to the host MCP through
`host.docker.internal`, but rewrites the upstream `Host` header to `localhost:8765`
so the MCP server's DNS-rebinding/loopback guard remains intact.

## Security requirements

The gateway refuses to start unless all of these are configured:

- `ACCESS_TEAM_DOMAIN`
- `ACCESS_AUD`
- at least one `ACCESS_ALLOWED_EMAILS` entry

Every MCP request must carry a valid Cloudflare Access JWT in
`Cf-Access-Jwt-Assertion`. The gateway validates signature, issuer, audience,
expiry/not-before, and the explicit email allowlist before forwarding the request.
Client bearer tokens, cookies, Cloudflare identity headers, browser Origin, and
forwarding headers are stripped before the request reaches the MCP process.

Only `GET`, `POST`, and `DELETE` on `/mcp` are forwarded. Request bodies are
bounded and requests are rate-limited per authenticated email.

## Tool surface and token budget

The authenticated public gateway exposes a token-optimized 43-tool core profile by default.
The local stdio/HTTP MCP implementation still registers all 85 tools; filtering happens only
at the public gateway, so upstream functionality and local clients are unchanged.

The default profile keeps live chart state, symbol/quote/OHLCV and indicator data, screenshots,
alerts, watchlists, layouts, panes and tabs. Heavy Pine-development, replay, drawing, batch and
generic UI/debug tools are hidden from ChatGPT unless explicitly enabled.

For a temporary full remote surface, set `ALLOWED_TOOLS=full` in `public/gateway.env` and
recreate only the gateway container. Prefer an explicit comma-separated `ALLOWED_TOOLS`
list when only a few advanced tools are needed. The gateway also compacts tool descriptions
and schemas and removes advertised output schemas; upstream validation still occurs in the
unchanged MCP server.

## Deployment

1. Start the host HTTP transport with `npm run start:http` and verify it listens only
   on `127.0.0.1:8765/mcp`.
2. Copy `public/gateway.env.example` to `public/gateway.env` and fill in the
   Cloudflare Access values. Do not commit the real file.
3. Copy `public/tunnel.env.example` to `public/tunnel.env` and add the token for a
   dedicated remotely managed tunnel. Do not commit the real file.
4. In Cloudflare, route the tunnel's public hostname to `http://gateway:8080`.
5. Protect that hostname with a Cloudflare Access application and enable Managed OAuth
   for MCP clients. The Access application audience must match `ACCESS_AUD`.
6. Start the edge stack with:
   `docker compose -f compose.public.yaml up -d`.

Kill switch:

`docker stop tradingview-mcp-cloudflared`

Stopping the tunnel leaves local stdio and local HTTP operation unaffected.

Do not start the tunnel until Access is configured and the gateway has the matching
audience/team/email settings.
