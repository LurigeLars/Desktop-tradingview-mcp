import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createSharedStdioServer } from '../src/server/shared-stdio.js';
import { startTradingViewHttpServer } from '../src/server/http.js';

async function frontend(server) {
  const [a,b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'proxy-test', version: '1' });
  await client.connect(b);
  return client;
}

test('two stdio clients expose the real shared HTTP tool schema and worker state', async () => {
  const runtime = await startTradingViewHttpServer({ port: 0 });
  const servers = [createSharedStdioServer(runtime.url), createSharedStdioServer(runtime.url)];
  const clients = await Promise.all(servers.map(frontend));
  try {
    const tools = await clients[0].listTools();
    const repair = tools.tools.find(tool => tool.name === 'worker_provision');
    assert.ok(repair.inputSchema.properties.repair_slot);
    const replies = await Promise.all(clients.map(client => client.callTool({ name: 'worker_status', arguments: {} })));
    assert.deepEqual(replies[0], replies[1]);
    assert.equal(JSON.parse(replies[0].content[0].text).success, true);
  } finally {
    await Promise.all(clients.map(client => client.close()));
    await Promise.all(servers.map(server => server.close()));
    await runtime.close();
  }
});

test('failed forwarded mutation is never replayed; next request reconnects', async () => {
  let calls = 0, connects = 0;
  const server = createSharedStdioServer('http://127.0.0.1:8765/mcp', { connect: async () => {
    connects++;
    return { close: async () => {}, callTool: async () => {
      calls++;
      if (calls === 1) throw new Error('transport lost after mutation');
      return { content: [{ type: 'text', text: 'recovered' }] };
    } };
  } });
  const client = await frontend(server);
  try {
    const first = await client.callTool({ name: 'worker_rotate_snapshot', arguments: {} });
    assert.equal(first.isError, true); assert.equal(calls, 1);
    const second = await client.callTool({ name: 'worker_status', arguments: {} });
    assert.equal(second.content[0].text, 'recovered');
    assert.equal(calls, 2); assert.equal(connects, 2);
  } finally { await client.close(); await server.close(); }
});

test('shared backend rejects remote destinations and credentials', () => {
  for (const url of ['https://127.0.0.1/mcp', 'http://example.com/mcp',
    'http://user:password@127.0.0.1/mcp', 'http://127.0.0.1/other'])
    assert.throws(() => createSharedStdioServer(url), /loopback HTTP/);
});
