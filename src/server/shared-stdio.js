import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { SERVER_INFO, SERVER_INSTRUCTIONS } from './create-server.js';

export function createSharedStdioServer(url, { connect } = {}) {
  const endpoint = new URL(url);
  if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1'
      || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
      || endpoint.pathname !== '/mcp') throw new Error('Shared DTV backend must be loopback HTTP /mcp');
  let pending;
  const attach = connect || (async () => {
    const client = new Client({ name: 'dtv-shared-stdio', version: SERVER_INFO.version });
    try { await client.connect(new StreamableHTTPClientTransport(endpoint)); }
    catch (error) { await client.close().catch(() => {}); throw error; }
    return client;
  });
  const backend = () => pending ||= attach().catch(error => { pending = null; throw error; });
  const server = new Server(SERVER_INFO, { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS });
  async function forward(method, params) {
    const active = backend();
    try { return await (await active)[method](params); }
    catch (error) {
      // Never replay a possibly completed mutation after a transport failure.
      if (pending === active) pending = null;
      const client = await active.catch(() => null);
      await client?.close().catch(() => {});
      throw error;
    }
  }
  server.setRequestHandler(ListToolsRequestSchema, request => forward('listTools', request.params));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    try { return await forward('callTool', request.params); }
    catch { return { isError: true, content: [{ type: 'text',
      text: 'Shared DTV backend unavailable. Request was not retried; verify worker recovery before retrying a mutation.' }] }; }
  });
  server.onclose = () => { const current = pending; pending = null;
    void current?.then(client => client.close()).catch(() => {}); };
  return server;
}
