import { ImapService } from './services/imap-service.js';
import { AccountManager } from './services/account-manager.js';
import { SmtpService } from './services/smtp-service.js';
import { SpamService } from './services/spam-service.js';

/** The services every entry point shares, independent of the MCP transport. */
export interface Services {
  imapService: ImapService;
  accountManager: AccountManager;
  smtpService: SmtpService;
  spamService: SpamService;
}

/**
 * Construct and wire the services. Call after dotenv has loaded: the
 * AccountManager constructor consumes the IMAP_MCP_ACCOUNT_* overrides.
 */
export function createServices(): Services {
  const imapService = new ImapService();
  const accountManager = new AccountManager();
  const smtpService = new SmtpService();
  const spamService = new SpamService();

  // Allow ImapService to auto-connect using stored credentials
  imapService.setAccountManager(accountManager);

  return { imapService, accountManager, smtpService, spamService };
}
