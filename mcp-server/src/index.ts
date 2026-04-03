#!/usr/bin/env node

/**
 * Stdio entry point for local usage (Claude Desktop, Claude Code).
 * Launched as a child process, communicates over stdin/stdout via JSON-RPC.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createClientFromEnv } from './client.js';
import { createServer } from './server.js';

const log = (...args: unknown[]) => console.error('[rewind-mcp]', ...args);

async function main() {
  const client = createClientFromEnv();
  const server = createServer(client);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log('Server started on stdio transport');
}

main().catch((error) => {
  log('Fatal error:', error);
  process.exit(1);
});
