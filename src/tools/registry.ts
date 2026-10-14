import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Services } from '../core.js';
import { accountTools } from './account-tools.js';
import { emailTools } from './email-tools.js';
import { folderTools } from './folder-tools.js';
import { spamTools } from './spam-tools.js';

type ToolHandler = (...args: any[]) => any;

/** One tool exactly as its registrar passed it to `registerTool`. */
export interface ToolDefinition {
  name: string;
  config: any;
  handler: ToolHandler;
}

/**
 * Run the tool registrars once against a recorder and return every tool they
 * define, in registration order. An entry point that builds an McpServer per
 * request registers from this list instead of re-running the registrars (and
 * rebuilding every zod schema) each time. Keep the registrar calls in sync with
 * registerTools() in ./index.ts — tests/tool-policy.test.ts compares the two.
 *
 * The recorder is typed `any` for the same reason as the filtering Proxy in
 * ./index.ts: typing it against McpServer's deep registerTool generic adds
 * avoidable type-instantiation cost (TS2589).
 */
export function collectToolDefinitions(services: Services): ToolDefinition[] {
  const definitions: ToolDefinition[] = [];
  const recorder: any = {
    registerTool: (name: string, config: any, handler: ToolHandler) => {
      definitions.push({ name, config, handler });
    },
  };
  const { imapService, accountManager, smtpService, spamService } = services;

  accountTools(recorder, accountManager, imapService, smtpService);
  emailTools(recorder, imapService, accountManager, smtpService);
  folderTools(recorder, imapService, accountManager);
  spamTools(recorder, imapService, spamService);

  return definitions;
}

/**
 * Register the definitions named in `allowed` on `server`. With `wrap`, each
 * registered handler is replaced by `wrap(definition)`.
 */
export function applyToolDefinitions(
  server: McpServer,
  definitions: readonly ToolDefinition[],
  allowed: ReadonlySet<string>,
  wrap?: (definition: ToolDefinition) => ToolHandler
): void {
  const target: any = server;
  for (const definition of definitions) {
    if (!allowed.has(definition.name)) continue;
    target.registerTool(definition.name, definition.config, wrap ? wrap(definition) : definition.handler);
  }
}
