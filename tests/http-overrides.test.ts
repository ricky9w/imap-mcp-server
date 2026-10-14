import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fsp, existsSync } from 'fs';
import path from 'path';
import os from 'os';
import { collectToolDefinitions } from '../src/tools/registry.js';
import { httpToolDefinitions } from '../src/http/overrides.js';
import { ToolDeniedError } from '../src/http/mcp.js';

// Same hand-written single-page PDF as tests/email-tools-pdf-extract.test.ts.
function makePdf(text: string): Buffer {
  const stream = `BT /F1 24 Tf 72 700 Td (${text}) Tj ET`;
  return Buffer.from(`%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>
endobj
4 0 obj
<< /Length ${stream.length} >>
stream
${stream}
endstream
endobj
5 0 obj
<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>
endobj
trailer
<< /Root 1 0 R /Size 6 >>
%%EOF`, 'latin1');
}

const imapService = {
  getAttachmentContent: vi.fn(),
  findDraftsFolder: vi.fn(async () => 'Drafts'),
  appendMessage: vi.fn(async () => true),
};
const accountManager = {
  resolveAccountId: (id?: string) => id ?? 'acc1',
  getAccount: async () => ({ id: 'acc1', name: 'Work', email: 'me@example.com', user: 'me@example.com' }),
};
const smtpService = { composeRaw: vi.fn(async () => Buffer.from('RAW')) };
const services: any = { imapService, accountManager, smtpService, spamService: {} };

const definitions = () => httpToolDefinitions(collectToolDefinitions(services), services);
const tool = (name: string) => definitions().find(definition => definition.name === name)!;
const extraFor = (scopes: string[]) => ({ authInfo: { token: 't', clientId: 't', scopes } });

describe('imap_download_attachment over HTTP', () => {
  let downloadDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    downloadDir = path.join(await fsp.mkdtemp(path.join(os.tmpdir(), 'imap-mcp-inline-')), 'downloads');
    vi.stubEnv('IMAP_DOWNLOAD_DIR', downloadDir);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fsp.rm(path.dirname(downloadDir), { recursive: true, force: true });
  });

  const download = (args: Record<string, unknown> = {}) =>
    tool('imap_download_attachment').handler({ folder: 'INBOX', uid: 7, filename: 'f', extractText: true, ...args }, extraFor([]));

  it('returns a file as an embedded resource blob and writes nothing to disk', async () => {
    imapService.getAttachmentContent.mockResolvedValueOnce({ content: Buffer.from('hello'), contentType: 'application/zip', filename: 'a.zip' });

    const result: any = await download();

    expect(JSON.parse(result.content[0].text)).toEqual({ filename: 'a.zip', contentType: 'application/zip', size: 5 });
    expect(result.content[1]).toEqual({
      type: 'resource',
      resource: { uri: 'attachment://acc1/INBOX/7/a.zip', mimeType: 'application/zip', blob: Buffer.from('hello').toString('base64') },
    });
    expect(existsSync(downloadDir)).toBe(false);
  });

  it('returns images as image content', async () => {
    imapService.getAttachmentContent.mockResolvedValueOnce({ content: Buffer.from('png'), contentType: 'image/png', filename: 'p.png' });
    const result: any = await download();
    expect(result.content[1]).toEqual({ type: 'image', data: Buffer.from('png').toString('base64'), mimeType: 'image/png' });
  });

  it('still extracts PDF text', async () => {
    imapService.getAttachmentContent.mockResolvedValueOnce({ content: makePdf('Invoice 42'), contentType: 'application/pdf', filename: 'i.pdf' });
    const result: any = await download();
    expect(JSON.parse(result.content[0].text).textContent).toContain('Invoice 42');
    expect(result.content[1].resource.mimeType).toBe('application/pdf');
  });

  it('refuses savePath before fetching anything', async () => {
    await expect(download({ savePath: '/tmp/x' })).rejects.toThrow(/savePath is not supported over HTTP/);
    expect(imapService.getAttachmentContent).not.toHaveBeenCalled();
  });

  it('refuses attachments over the upload limit', async () => {
    vi.stubEnv('IMAP_MAX_UPLOAD_SIZE', '4');
    imapService.getAttachmentContent.mockResolvedValueOnce({ content: Buffer.from('hello'), contentType: 'text/plain', filename: 't.txt' });
    await expect(download()).rejects.toThrow(/5 bytes.*up to 4 bytes/);
  });

  it('tells the model the HTTP behaviour', () => {
    const { config } = tool('imap_download_attachment');
    expect(config.description).toContain('Nothing is written to the server');
    expect(config.inputSchema.savePath.description).toMatch(/Not supported over HTTP/);
    expect(config.inputSchema.uid).toBeDefined();
  });
});

describe('imap_save_draft folder over HTTP', () => {
  beforeEach(() => vi.clearAllMocks());

  const saveDraft = (args: Record<string, unknown>, scopes: string[]) =>
    tool('imap_save_draft').handler({ to: 'a@x.com', subject: 's', text: 't', ...args }, extraFor(scopes));

  it('refuses another folder without the organize tools, before composing anything', async () => {
    await expect(saveDraft({ folder: 'INBOX' }, ['imap_save_draft'])).rejects.toBeInstanceOf(ToolDeniedError);
    expect(smtpService.composeRaw).not.toHaveBeenCalled();
    expect(imapService.appendMessage).not.toHaveBeenCalled();
  });

  it('accepts the detected Drafts folder or no folder at all', async () => {
    await saveDraft({ folder: 'Drafts' }, ['imap_save_draft']);
    await saveDraft({}, ['imap_save_draft']);
    expect(imapService.appendMessage).toHaveBeenCalledTimes(2);
    expect(imapService.appendMessage.mock.calls.every(call => call[1] === 'Drafts')).toBe(true);
  });

  it('allows any folder to a token that may organize mail', async () => {
    await saveDraft({ folder: 'INBOX' }, ['imap_save_draft', 'imap_move_email', 'imap_create_folder']);
    expect(imapService.appendMessage).toHaveBeenCalledWith('acc1', 'INBOX', expect.anything(), expect.anything());
  });
});

describe('httpToolDefinitions', () => {
  it('changes only the two overridden tools', () => {
    const stdio = collectToolDefinitions(services);
    const http = httpToolDefinitions(stdio, services);
    expect(http.map(d => d.name)).toEqual(stdio.map(d => d.name));
    const changed = http.filter((d, i) => d !== stdio[i]).map(d => d.name);
    expect(changed).toEqual(['imap_download_attachment', 'imap_save_draft']);
  });
});
