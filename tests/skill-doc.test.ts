import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { registerTools } from '../src/tools/index.js';
import { ALIASES } from '../src/cli/commands.js';

const read = (file: string) => readFileSync(join(process.cwd(), file), 'utf-8');
const skill = read('skills/imap-mail/SKILL.md');
const cliReference = read('skills/imap-mail/reference/cli.md');
const readme = read('README.md');

/** Code blocks and inline code: where commands are written out. */
const codeOf = (markdown: string): string =>
  [...markdown.matchAll(/```[\s\S]*?```|`[^`\n]+`/g)].map(match => match[0]).join('\n');

const toolNames = (): Set<string> => {
  const names: string[] = [];
  const stub: any = {};
  registerTools({ registerTool: (name: string) => names.push(name) } as any, stub, stub, stub, stub);
  return new Set(names);
};

// The skill and the CLI docs are what agents act on: keep them in step with
// the real tool names, CLI commands and options.
describe('skills/imap-mail', () => {
  it('has valid Agent Skills frontmatter', () => {
    const match = /^---\n([\s\S]*?)\n---\n/.exec(skill);
    expect(match, 'frontmatter').toBeTruthy();
    const fields = Object.fromEntries(match![1].split('\n').map(line => {
      const idx = line.indexOf(':');
      return [line.slice(0, idx).trim(), line.slice(idx + 1).trim()];
    }));
    expect(fields.name).toBe('imap-mail');
    expect(fields.name).toMatch(/^[a-z0-9-]{1,64}$/);
    expect(fields.description.length).toBeGreaterThan(0);
    expect(fields.description.length).toBeLessThanOrEqual(1024);
    expect(fields.description).not.toMatch(/[<>]/);
  });

  it('names only tools that exist', () => {
    const tools = toolNames();
    for (const [doc, text] of [['SKILL.md', skill], ['reference/cli.md', cliReference]] as const) {
      for (const tool of text.match(/imap_[a-z_]+/g) ?? []) {
        expect(tools.has(tool), `${doc}: ${tool}`).toBe(true);
      }
    }
  });

  it('names only CLI commands and options that exist', () => {
    const commands = new Set(['tools', 'call', ...ALIASES.map(alias => alias.command.split(' ')[0])]);
    for (const [doc, text] of [['SKILL.md', skill], ['reference/cli.md', cliReference], ['README.md', readme]] as const) {
      for (const [, command] of codeOf(text).matchAll(/imap-mcp-cli\s+(?:--[a-z-]+\s+)*([a-z][a-z-]*)/g)) {
        expect(commands.has(command), `${doc}: imap-mcp-cli ${command}`).toBe(true);
      }
    }

    const options = new Set(['--url', '--pretty', '--help', ...ALIASES.flatMap(alias => (alias.options ?? []).map(option => option.flags.split(' ')[0]))]);
    for (const [doc, text] of [['SKILL.md', skill], ['reference/cli.md', cliReference]] as const) {
      for (const option of codeOf(text).match(/(?<![\w-])--[a-z][a-z-]*/g) ?? []) {
        expect(options.has(option), `${doc}: ${option}`).toBe(true);
      }
    }
  });

  it('documents every CLI command and option in reference/cli.md', () => {
    const code = codeOf(cliReference);
    const documented = new Set([...code.matchAll(/imap-mcp-cli\s+(?:--[a-z-]+\s+)*([a-z][a-z-]*)/g)].map(match => match[1]));
    for (const command of ['tools', 'call', ...ALIASES.map(alias => alias.command.split(' ')[0])]) {
      expect(documented.has(command), command).toBe(true);
    }
    for (const option of ALIASES.flatMap(alias => (alias.options ?? []).map(o => o.flags.split(' ')[0]))) {
      expect(code, option).toContain(option);
    }
  });

  it('says the token comes from IMAP_MCP_TOKEN only', () => {
    for (const text of [skill, cliReference]) {
      expect(text).toContain('IMAP_MCP_TOKEN');
      expect(text).not.toContain('IMAP_MCP_TOKEN_FILE');
      expect(text).not.toContain('--token');
    }
  });

  it('ships with the package', () => {
    expect(JSON.parse(read('package.json')).files).toContain('skills');
  });
});
