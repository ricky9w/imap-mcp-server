import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// Pins the SDK behaviour src/http/mcp.ts relies on, so an SDK upgrade that
// changes it fails here first: stateless transport with a fresh McpServer per
// request, JSON responses, req.auth reaching tool handlers as extra.authInfo,
// requestInit headers sent by the client, and how the client reports a 401.
let httpServer: Server;
let url: URL;
const sessionHeaders: Array<string | null> = [];
const contentTypes: Array<string | null> = [];

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.post('/mcp', async (req, res) => {
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
    if (bearer !== 'good') {
      res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null });
      return;
    }
    (req as any).auth = { token: 'tok-id', clientId: 'tok-id', scopes: ['echo_auth'], extra: { tokenName: 'laptop' } };

    const server = new McpServer({ name: 'contract', version: '0.0.0' });
    (server as any).registerTool('echo_auth', { description: 'echo authInfo', inputSchema: {} }, async (_args: unknown, extra: any) => ({
      content: [{ type: 'text', text: JSON.stringify(extra.authInfo) }],
    }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      transport.close();
      server.close();
    });
    res.on('finish', () => {
      sessionHeaders.push(res.getHeader('mcp-session-id') as string | null ?? null);
      contentTypes.push(res.getHeader('content-type') as string | null ?? null);
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  await new Promise<void>((resolve) => {
    httpServer = app.listen(0, '127.0.0.1', () => resolve());
  });
  url = new URL(`http://127.0.0.1:${(httpServer.address() as AddressInfo).port}/mcp`);
});

afterAll(() => httpServer?.close());

const connect = async (token: string) => {
  const client = new Client({ name: 'contract-client', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }));
  return client;
};

describe('MCP SDK Streamable HTTP contract', () => {
  it('serves a stateless client with a fresh server per request and passes req.auth to handlers', async () => {
    const client = await connect('good');
    expect((await client.listTools()).tools.map(t => t.name)).toEqual(['echo_auth']);

    const result: any = await client.callTool({ name: 'echo_auth', arguments: {} });
    expect(JSON.parse(result.content[0].text)).toEqual({
      token: 'tok-id',
      clientId: 'tok-id',
      scopes: ['echo_auth'],
      extra: { tokenName: 'laptop' },
    });
    await client.close();

    // Stateless: no session id is ever issued; JSON responses, not SSE.
    expect(sessionHeaders.every(h => h === null)).toBe(true);
    expect(contentTypes.filter(Boolean).every(t => t!.startsWith('application/json'))).toBe(true);
  });

  it('reports a 401 as StreamableHTTPError with code 401', async () => {
    const error = await connect('bad').catch(e => e);
    expect(error).toBeInstanceOf(StreamableHTTPError);
    expect(error.code).toBe(401);
  });
});
