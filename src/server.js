// Backward-compatible stdio entrypoint.
// Existing local MCP client configs can continue to launch src/server.js.
await import('./server/stdio.js');
