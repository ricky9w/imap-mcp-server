import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { PACKAGE_VERSION } from '../utils/version.js';

export type CliErrorType = 'tool' | 'usage' | 'auth' | 'denied' | 'network';

const EXIT_CODES: Record<CliErrorType, number> = { tool: 1, usage: 2, auth: 3, denied: 3, network: 4 };

/** A failure reported as `{"error":{type,message}}` on stderr with its exit code. */
export class CliError extends Error {
  constructor(readonly type: CliErrorType, message: string) {
    super(message);
  }

  get exitCode(): number {
    return EXIT_CODES[this.type];
  }
}

export interface ToolResult {
  content?: Array<Record<string, any>>;
  isError?: boolean;
}

export function toCliError(error: unknown): CliError {
  if (error instanceof CliError) return error;
  if (error instanceof StreamableHTTPError) {
    if (error.code === 401) return new CliError('auth', 'Unauthorized: IMAP_MCP_TOKEN is not a valid agent token (wrong, or revoked).');
    if (error.code === 403) return new CliError('auth', `Forbidden by the server: ${error.message}`);
    return new CliError('network', `HTTP ${error.code ?? 'error'}: ${error.message}`);
  }
  if (error instanceof McpError) return new CliError('tool', error.message);
  const cause = (error as { cause?: { message?: string } } | undefined)?.cause?.message;
  const message = error instanceof Error ? error.message : String(error);
  return new CliError('network', cause ? `${message}: ${cause}` : message);
}

/** An MCP client for the serve endpoint, authenticated with an agent token. */
export async function connect(url: string, token: string): Promise<Client> {
  let endpoint: URL;
  try {
    endpoint = new URL(url);
  } catch {
    throw new CliError('usage', `Invalid MCP endpoint URL: ${url}`);
  }
  const client = new Client({ name: 'imap-mcp-cli', version: PACKAGE_VERSION });
  try {
    await client.connect(new StreamableHTTPClientTransport(endpoint, {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }));
  } catch (error) {
    throw toCliError(error);
  }
  return client;
}

export async function listTools(client: Client) {
  try {
    return (await client.listTools()).tools;
  } catch (error) {
    throw toCliError(error);
  }
}

export const textOf = (result: ToolResult): string =>
  (result.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n');

/**
 * Call a tool. The server only exposes the token's tools, so an error for a
 * tool that tools/list does not offer means it is not permitted (`denied`).
 */
export async function callTool(client: Client, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  let result: ToolResult;
  try {
    result = (await client.callTool({ name, arguments: args })) as ToolResult;
  } catch (error) {
    throw toCliError(error);
  }
  if (result.isError) {
    const offered = (await listTools(client)).some(tool => tool.name === name);
    if (!offered) {
      throw new CliError('denied', `Tool ${name} is not available to this token.`);
    }
    throw new CliError('tool', textOf(result) || `Tool ${name} failed.`);
  }
  return result;
}
