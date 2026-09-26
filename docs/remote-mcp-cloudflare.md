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

The gateway refuses to start unless the required local Cloudflare Access settings and an explicit identity allowlist are configured.

Every MCP request must carry a valid Cloudflare Access JWT in
`Cf-Access-Jwt-Assertion`. The gateway validates signature, issuer, audience,
expiry/not-before, and the explicit email allowlist before forwarding the request.
Client bearer tokens, cookies, Cloudflare identity headers, browser Origin, and
forwarding headers are stripped before the request reaches the MCP process.

Only `GET`, `POST`, and `DELETE` on `/mcp` are forwarded. Request bodies are
bounded and requests are rate-limited per authenticated email.

## Tool surface and token budget

The authenticated public gateway preserves all 85 TradingView tools by default. This matches
the intended ChatGPT/Claude Code/Codex capability surface; token optimization must not silently
remove previously selected functionality.

The gateway instead reduces repeated context by compacting tool descriptions and input-schema
prose and by removing advertised output schemas. Upstream validation and the underlying MCP
implementation remain unchanged.

For a deliberately restricted session, an operator can configure a reduced tool profile or explicit
allowlist in local deployment configuration, then recreate only the gateway container. Agents cannot
change this profile themselves.

## Deployment

1. Start the host HTTP transport with `npm run start:http` and verify it listens only
   on `127.0.0.1:8765/mcp`.
2. Provide all deployment-local gateway settings out of band and keep them out of Git.
3. Configure the shared tunnel route and Cloudflare Access application outside this repository.
4. Start the edge stack with:
   `docker compose -f compose.public.yaml up -d`.

Do not expose the gateway until Access and the local authorization settings are configured.
