import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import dotenv from 'dotenv';
import { createServices } from './core.js';
import { registerTools } from './tools/index.js';
import { PACKAGE_VERSION } from './utils/version.js';

// Silence any package version output to stdout
const originalWrite = process.stdout.write.bind(process.stdout);
(process.stdout.write as any) = function(chunk: any, encoding?: any, callback?: any): boolean {
  // Only allow JSON-RPC messages through
  if (typeof chunk === 'string' && (chunk.startsWith('{') || chunk === '\n')) {
    return originalWrite(chunk, encoding, callback);
  }
  return true;
};

dotenv.config();

const server = new McpServer({
  name: 'imap-mcp-server',
  version: PACKAGE_VERSION,
});

const { imapService, accountManager, smtpService, spamService } = createServices();

// Register all tools
registerTools(server, imapService, accountManager, smtpService, spamService);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('IMAP MCP Server started');
}

main().catch((error) => {
  console.error('Server error:', error);
  process.exit(1);
});