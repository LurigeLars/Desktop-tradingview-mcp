import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createTradingViewServer, writeStartupNotice } from './create-server.js';
import { createSharedStdioServer } from './shared-stdio.js';

writeStartupNotice();

const server = process.env.TV_MCP_SHARED_HTTP_URL
  ? createSharedStdioServer(process.env.TV_MCP_SHARED_HTTP_URL)
  : createTradingViewServer();
const transport = new StdioServerTransport();
await server.connect(transport);
