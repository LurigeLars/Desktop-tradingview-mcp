import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createTradingViewServer, writeStartupNotice } from './create-server.js';

writeStartupNotice();

const server = createTradingViewServer();
const transport = new StdioServerTransport();
await server.connect(transport);
