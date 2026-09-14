import type { MessageKey } from './i18n.js';

/**
 * What the manager refused, said in the reader's language.
 *
 * The server answers in English - it has no idea who is asking - and the
 * sign-in screen was showing that answer verbatim. So the one screen a reader
 * has to get past before anything else is translated would tell them "The
 * password is incorrect" in a language the rest of the console had agreed not
 * to use. Every refusal carries a code as well as a message, and the codes
 * this screen can produce are listed here.
 *
 * Anything not listed falls back to the server's own message, which is still
 * better than a blank card: an unexpected refusal should say something.
 */
const AUTH_ERRORS: Readonly<Record<string, MessageKey>> = {
  invalid_credentials: 'setup.authError',
  invalid_password: 'setup.passwordRejected',
  invalid_setup_code: 'setup.invalidSetupCode',
  notice_acceptance_required: 'setup.termsRequired',
  already_configured: 'setup.alreadyConfigured',
  setup_required: 'setup.setupNeeded',
  rate_limited: 'setup.rateLimited',
};

export function authErrorKey(code: unknown): MessageKey | null {
  return typeof code === 'string' ? AUTH_ERRORS[code] ?? null : null;
}
