import { CliError } from './client.js';

export interface AliasOption {
  flags: string;
  description: string;
  required?: boolean;
}

/** A shortcut command for one tool. `call <tool> [json]` reaches every other tool. */
export interface Alias {
  /** Commander usage, e.g. `get <uid>`. */
  command: string;
  description: string;
  tool: string;
  options?: AliasOption[];
  /** The tool arguments for the parsed positionals and options. */
  args: (positionals: any[], options: Record<string, any>) => Record<string, unknown>;
  /** Write the returned attachment bytes to --out instead of printing them. */
  savesFile?: boolean;
}

const positiveInt = (value: string, what: string): number => {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new CliError('usage', `Invalid ${what}: ${value}`);
  }
  return number;
};

const accountOption: AliasOption = { flags: '--account <name>', description: 'Account name (needed only when several accounts exist)' };
const folderOption: AliasOption = { flags: '--folder <folder>', description: 'Folder (default: INBOX)' };

const location = (options: Record<string, any>) => ({
  ...(options.account ? { accountName: options.account } : {}),
  ...(options.folder ? { folder: options.folder } : {}),
});

export const ALIASES: Alias[] = [
  {
    command: 'accounts',
    description: 'List the configured accounts',
    tool: 'imap_list_accounts',
    args: () => ({}),
  },
  {
    command: 'folders',
    description: 'List the folders of an account',
    tool: 'imap_list_folders',
    options: [accountOption],
    args: (_positionals, options) => location(options),
  },
  {
    command: 'latest',
    description: 'Show the newest messages in a folder',
    tool: 'imap_get_latest_emails',
    options: [
      accountOption,
      folderOption,
      { flags: '--count <n>', description: 'Number of messages (default: 10)' },
      { flags: '--include-body', description: 'Also return the message bodies' },
    ],
    args: (_positionals, options) => ({
      ...location(options),
      ...(options.count !== undefined ? { count: positiveInt(options.count, 'count') } : {}),
      ...(options.includeBody ? { includeBody: true } : {}),
    }),
  },
  {
    command: 'search',
    description: 'Search messages in a folder',
    tool: 'imap_search_emails',
    options: [
      accountOption,
      folderOption,
      { flags: '--from <text>', description: 'Sender contains' },
      { flags: '--to <text>', description: 'Recipient contains' },
      { flags: '--subject <text>', description: 'Subject contains' },
      { flags: '--body <text>', description: 'Body contains' },
      { flags: '--since <date>', description: 'On or after this date (YYYY-MM-DD)' },
      { flags: '--before <date>', description: 'Before this date (YYYY-MM-DD)' },
      { flags: '--unseen', description: 'Only unread messages' },
      { flags: '--limit <n>', description: 'Maximum number of results (default: 50)' },
    ],
    args: (_positionals, options) => ({
      ...location(options),
      ...Object.fromEntries(['from', 'to', 'subject', 'body', 'since', 'before']
        .filter(field => options[field] !== undefined)
        .map(field => [field, options[field]])),
      ...(options.unseen ? { seen: false } : {}),
      ...(options.limit !== undefined ? { limit: positiveInt(options.limit, 'limit') } : {}),
    }),
  },
  {
    command: 'get <uid>',
    description: 'Read one message',
    tool: 'imap_get_email',
    options: [accountOption, folderOption, { flags: '--format <format>', description: 'Body format: markdown (default), text, html or auto' }],
    args: ([uid], options) => ({
      ...location(options),
      uid: positiveInt(uid, 'uid'),
      ...(options.format ? { bodyFormat: options.format } : {}),
    }),
  },
  {
    command: 'mark-read <uid...>',
    description: 'Mark one or more messages as read',
    tool: 'imap_mark_as_read',
    options: [accountOption, folderOption],
    args: ([uids], options) => ({
      ...location(options),
      uid: uids.length === 1 ? positiveInt(uids[0], 'uid') : uids.map((uid: string) => positiveInt(uid, 'uid')),
    }),
  },
  {
    command: 'attachment <uid> <filename>',
    description: 'Download an attachment (filename or contentId as listed by `get`) to a local file',
    tool: 'imap_download_attachment',
    options: [accountOption, folderOption, { flags: '--out <file>', description: 'File to write the attachment to', required: true }],
    args: ([uid, filename], options) => ({ ...location(options), uid: positiveInt(uid, 'uid'), filename }),
    savesFile: true,
  },
];
