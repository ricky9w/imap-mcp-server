import { Command, CommanderError } from 'commander';
import { writeFileSync } from 'fs';
import path from 'path';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { ALIASES } from './commands.js';
import { CliError, callTool, connect, listTools, textOf, toCliError, type ToolResult } from './client.js';

export interface CliIo {
  env: NodeJS.ProcessEnv;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

// A tool's JSON text as a value; anything else (images, resources) as content.
function payloadOf(result: ToolResult): unknown {
  const content = result.content ?? [];
  if (content.length === 1 && content[0].type === 'text') {
    try {
      return JSON.parse(content[0].text);
    } catch {
      return content[0].text;
    }
  }
  return { content };
}

const reportsFailure = (payload: unknown): boolean =>
  typeof payload === 'object' && payload !== null && (payload as { success?: unknown }).success === false;

// Over HTTP an attachment comes back inline: an image part, or an embedded resource.
function saveAttachment(result: ToolResult, out: string): Record<string, unknown> {
  const binary = (result.content ?? []).find(part => part.type === 'image' || (part.type === 'resource' && part.resource?.blob));
  if (!binary) {
    throw new CliError('tool', textOf(result) || 'The server returned no attachment data.');
  }
  const bytes = Buffer.from(binary.type === 'image' ? binary.data : binary.resource.blob, 'base64');
  const target = path.resolve(out);
  writeFileSync(target, bytes);

  let details: Record<string, unknown> = { contentType: binary.mimeType ?? binary.resource?.mimeType };
  try {
    details = { ...details, ...JSON.parse(textOf(result)) };
  } catch {
    // image attachments come with a plain-text caption
  }
  return { ...details, savedTo: target, size: bytes.length };
}

/**
 * imap-mcp-cli: an MCP client for `imap-mcp-server serve` that prints JSON.
 * The agent token is read from IMAP_MCP_TOKEN only — never from an argument,
 * where it would show up in `ps` and shell history. Returns the exit code.
 */
export async function runCli(argv: string[], io: CliIo): Promise<number> {
  let exitCode = 0;
  const program = new Command('imap-mcp-cli')
    .description(
      'Use the IMAP MCP server\'s tools from a shell; prints JSON on stdout and errors as JSON on stderr.\n' +
      'Environment: IMAP_MCP_URL (MCP endpoint, e.g. http://127.0.0.1:8765/mcp) and IMAP_MCP_TOKEN (agent token).\n' +
      'Exit codes: 0 ok, 1 tool error or success:false, 2 usage, 3 unauthorized or not permitted, 4 network.'
    )
    .option('--url <url>', 'MCP endpoint URL (overrides IMAP_MCP_URL)')
    .option('--pretty', 'Pretty-print the JSON output')
    .exitOverride()
    // Commander's own error text is replaced by the JSON error below.
    .configureOutput({ writeOut: io.stdout, writeErr: () => {} });

  const print = (value: unknown) => {
    io.stdout(`${JSON.stringify(value, null, program.opts().pretty ? 2 : undefined)}\n`);
  };

  const withClient = async (work: (client: Client) => Promise<number>) => {
    const endpoint = program.opts().url || io.env.IMAP_MCP_URL?.trim();
    const token = io.env.IMAP_MCP_TOKEN?.trim();
    if (!endpoint) {
      throw new CliError('usage', 'Set IMAP_MCP_URL (or --url) to the MCP endpoint, e.g. http://127.0.0.1:8765/mcp.');
    }
    if (!token) {
      throw new CliError('usage', 'Set IMAP_MCP_TOKEN to an agent token (imcp_…).');
    }
    const client = await connect(endpoint, token);
    try {
      exitCode = await work(client);
    } finally {
      await client.close().catch(() => {});
    }
  };

  const printResult = (result: ToolResult): number => {
    const payload = payloadOf(result);
    print(payload);
    return reportsFailure(payload) ? 1 : 0;
  };

  program
    .command('tools')
    .description('List the tools this token can use, with their input schemas')
    .action(() => withClient(async client => {
      print(await listTools(client));
      return 0;
    }));

  program
    .command('call <tool> [json]')
    .description('Call any tool with a JSON object of arguments')
    .action((tool: string, json: string | undefined) => {
      let args: unknown = {};
      if (json !== undefined) {
        try {
          args = JSON.parse(json);
        } catch {
          throw new CliError('usage', 'Arguments must be a JSON object, e.g. \'{"folder":"INBOX"}\'.');
        }
      }
      if (typeof args !== 'object' || args === null || Array.isArray(args)) {
        throw new CliError('usage', 'Arguments must be a JSON object, e.g. \'{"folder":"INBOX"}\'.');
      }
      return withClient(async client => printResult(await callTool(client, tool, args as Record<string, unknown>)));
    });

  for (const alias of ALIASES) {
    const command = program.command(alias.command).description(`${alias.description} (${alias.tool})`);
    for (const option of alias.options ?? []) {
      if (option.required) command.requiredOption(option.flags, option.description);
      else command.option(option.flags, option.description);
    }
    command.action((...params: any[]) => {
      const options = (params[params.length - 1] as Command).opts();
      const args = alias.args(params.slice(0, -2), options);
      return withClient(async client => {
        const result = await callTool(client, alias.tool, args);
        if (!alias.savesFile) return printResult(result);
        print(saveAttachment(result, options.out));
        return 0;
      });
    });
  }

  try {
    await program.parseAsync(argv, { from: 'user' });
    return exitCode;
  } catch (error) {
    let failure: CliError;
    if (error instanceof CommanderError) {
      if (error.exitCode === 0) return 0; // --help
      const message = error.code === 'commander.help'
        ? 'Missing command. Run imap-mcp-cli --help.'
        : error.message.replace(/^error: /, '');
      failure = new CliError('usage', message);
    } else {
      failure = toCliError(error);
    }
    io.stderr(`${JSON.stringify({ error: { type: failure.type, message: failure.message } })}\n`);
    return failure.exitCode;
  }
}
