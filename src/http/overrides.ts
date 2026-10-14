import { z } from 'zod';
import type { Services } from '../core.js';
import type { ToolDefinition } from '../tools/registry.js';
import { TOOL_GROUPS } from '../tools/policy.js';
import { ToolDeniedError } from './mcp.js';

/** The stdio upload limit (IMAP_MAX_UPLOAD_SIZE), reused for HTTP bodies and inline attachments. */
export const maxUploadSize = (): number =>
  parseInt(process.env.IMAP_MAX_UPLOAD_SIZE ?? '', 10) || 25 * 1024 * 1024;

/**
 * The tool definitions as served over HTTP. Only the differences live here;
 * every other tool is used exactly as registered for stdio.
 */
export function httpToolDefinitions(definitions: readonly ToolDefinition[], services: Services): ToolDefinition[] {
  return definitions.map(definition => {
    switch (definition.name) {
      case 'imap_download_attachment':
        return downloadInline(definition, services);
      case 'imap_save_draft':
        return draftsFolderOnly(definition, services);
      default:
        return definition;
    }
  });
}

/**
 * A remote agent cannot read files on the server, and writing them there is
 * a needless write primitive: return the attachment in the response instead.
 */
function downloadInline(definition: ToolDefinition, { imapService, accountManager }: Services): ToolDefinition {
  const config = {
    ...definition.config,
    description: 'Download a single attachment from an email (folder + uid + attachment filename/contentId, as listed by imap_get_email) and return it in the response: images as image content, other files as an embedded resource (base64 blob); PDFs also include their extracted text (extractText). Nothing is written to the server. Attachments larger than the server\'s upload limit (IMAP_MAX_UPLOAD_SIZE) are refused. Use when the user wants the actual file contents, not just the message body.',
    inputSchema: {
      ...definition.config.inputSchema,
      savePath: z.string().optional().describe('Not supported over HTTP — passing it is an error. The attachment is returned inline instead.'),
    },
  };

  const handler = async ({ accountId: rawAccountId, accountName, folder, uid, filename, savePath, extractText }: any) => {
    if (savePath !== undefined) {
      throw new Error('savePath is not supported over HTTP: nothing is written to the server; the attachment is returned inline.');
    }
    const accountId = accountManager.resolveAccountId(rawAccountId, accountName);
    const { content, contentType, filename: resolvedFilename } = await imapService.getAttachmentContent(accountId, folder, uid, filename);

    const limit = maxUploadSize();
    if (content.length > limit) {
      throw new Error(`Attachment "${resolvedFilename}" is ${content.length} bytes; over HTTP attachments are returned inline up to ${limit} bytes (IMAP_MAX_UPLOAD_SIZE).`);
    }

    if (contentType.startsWith('image/')) {
      return {
        content: [
          { type: 'text' as const, text: `Attachment: ${resolvedFilename} (${contentType}, ${content.length} bytes)` },
          { type: 'image' as const, data: content.toString('base64'), mimeType: contentType },
        ],
      };
    }

    const details: Record<string, unknown> = { filename: resolvedFilename, contentType, size: content.length };
    const isPdf = contentType === 'application/pdf' || resolvedFilename.toLowerCase().endsWith('.pdf');
    if (isPdf && extractText) {
      try {
        const { PDFParse } = await import('pdf-parse');
        const pdfParser = new PDFParse({ data: content });
        try {
          const pdfData = await pdfParser.getText({ pageJoiner: '' });
          details.pages = pdfData.total;
          details.textContent = pdfData.text;
        } finally {
          await pdfParser.destroy();
        }
      } catch (err) {
        // The file itself is still returned below.
        console.error('PDF text extraction failed:', err);
      }
    }

    return {
      content: [
        { type: 'text' as const, text: JSON.stringify(details, null, 2) },
        {
          type: 'resource' as const,
          resource: {
            uri: `attachment://${encodeURIComponent(accountId)}/${encodeURIComponent(folder)}/${uid}/${encodeURIComponent(resolvedFilename)}`,
            mimeType: contentType,
            blob: content.toString('base64'),
          },
        },
      ],
    };
  };

  return { ...definition, config, handler };
}

/**
 * imap_save_draft's folder override appends a message to any folder — e.g. a
 * forged mail in INBOX. Over HTTP it may only name the detected Drafts folder,
 * unless the token may organize mail anyway.
 */
function draftsFolderOnly(definition: ToolDefinition, { imapService, accountManager }: Services): ToolDefinition {
  const config = {
    ...definition.config,
    inputSchema: {
      ...definition.config.inputSchema,
      folder: z.string().optional().describe('Override the Drafts folder name (defaults to auto-detected Drafts folder). Over HTTP it must be the Drafts folder unless this token may also move mail and create folders.'),
    },
  };

  const handler = async (args: any, extra: any) => {
    const scopes: string[] = extra?.authInfo?.scopes ?? [];
    const mayOrganize = TOOL_GROUPS.organize.every(tool => scopes.includes(tool));
    if (args.folder !== undefined && !mayOrganize) {
      const accountId = accountManager.resolveAccountId(args.accountId, args.accountName);
      const draftsFolder = await imapService.findDraftsFolder(accountId);
      if (args.folder !== draftsFolder) {
        throw new ToolDeniedError(
          `Drafts can only be saved to the Drafts folder (${draftsFolder ? `"${draftsFolder}"` : 'none detected'}) with this token. Omit folder to use it.`
        );
      }
    }
    return definition.handler(args, extra);
  };

  return { ...definition, config, handler };
}
