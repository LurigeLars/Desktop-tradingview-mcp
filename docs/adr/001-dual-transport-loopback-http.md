# ADR-001 — Shared MCP core with local stdio and loopback HTTP

Status: Accepted
Date: 2026-09-21

## Context

The same TradingView Desktop integration must serve two local MCP clients (Claude Code and Codex) and one protected remote MCP client (ChatGPT) without duplicating tools or widening the Chrome DevTools Protocol boundary.

## Decision

Keep one canonical MCP server factory and expose it through two transport entrypoints:

- stdio for local clients;
- stateful Streamable HTTP for the remote path.

Both transports expose the same full tool set and permissions.

TradingView CDP remains loopback-only on `127.0.0.1:9333`. The HTTP MCP endpoint also remains loopback-only, defaulting to `127.0.0.1:8765/mcp`. Any remote access must terminate through a separately authenticated tunnel/proxy on the same Windows host; CDP is never exposed directly.

## Consequences

- Tool behavior is implemented once and cannot drift between local and remote clients.
- Local MCP clients remain independent stdio processes.
- Remote HTTP lifecycle failures do not require exposing CDP or changing local client transport.
- Internet exposure and authentication remain deployment concerns and require separate activation/verification.
