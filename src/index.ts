import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import dotenv from 'dotenv';
import { createServices } from './core.js';
import { registerTools } from './tools/index.js';
import { startServe } from './http/serve.js';
import { PACKAGE_VERSION } from './utils/version.js';

const fail = (error: unknown) => {
  console.error('Server error:', error);
  process.exit(1);
};

if (process.argv[2] === 'serve') {
  // Long-running HTTP server (see src/http/serve.ts); stdout is a plain log here.
  dotenv.config();
  startServe(process.argv.slice(3)).catch(fail);
} else {
  startStdio().catch(fail);
}

async function startStdio(): Promise<void> {
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

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('IMAP MCP Server started');
}
