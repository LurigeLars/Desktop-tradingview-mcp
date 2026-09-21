# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in this project, please report it responsibly.

**Email:** Open a private security advisory via [GitHub Security Advisories](https://github.com/tradesdontlie/tradingview-mcp/security/advisories/new).

**Do not** open a public issue for security vulnerabilities.

## Scope

This project connects to a locally running TradingView Desktop instance via Chrome DevTools Protocol on `localhost:9222`. Security concerns in scope include:

- Code injection via crafted tool inputs
- Unintended data exposure through tool outputs
- Credential or session token leakage
- Vulnerabilities in the MCP server, HTTP transport, remote gateway or CLI that could be exploited locally or remotely

## Out of Scope

- TradingView's own security (report to TradingView directly)
- Chrome DevTools Protocol security (report to Google/Chromium)
- MCP client security

## Best Practices for Users

- Only run TradingView with `--remote-debugging-port=9222` on localhost
- Do not expose port 9222 to your network or the internet
- Keep the MCP HTTP transport bound to loopback
- For remote access, use an authenticated edge and validate identity again at the gateway before forwarding to the MCP server
- Use a dedicated tunnel per application and never commit tunnel tokens, Access audience values tied to a private deployment, or real gateway environment files
- Keep `public/gateway.env` and `public/tunnel.env` outside Git
- Stop the dedicated `cloudflared` container as the remote-access kill switch
- Do not pipe `tv stream` output to external services without reviewing the data
- Keep TradingView Desktop, Node.js, Docker and the tunnel image up to date
