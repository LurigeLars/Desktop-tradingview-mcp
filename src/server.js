// Backward-compatible stdio entrypoint.
// Existing Claude/Codex configs can continue to launch src/server.js.
await import('./server/stdio.js');
