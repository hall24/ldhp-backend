/**
 * Email delivery behind a small adapter (PRD §10), so the provider can change and
 * tests never send real mail. Only SendGrid is implemented for R1.
 */

export interface OutgoingEmail {
  to: string;
  fromEmail: string;
  fromName: string;
  replyTo?: string | null;
  subject: string;
  text: string;
  html: string;
  /** Extra headers, e.g. List-Unsubscribe. */
  headers?: Record<string, string>;
  /** Echoed back by provider webhooks so events can be matched to our records. Never personal data. */
  tags?: Record<string, string>;
}

export interface SendResult {
  providerMessageId: string | null;
}

/** A send the provider refused or that failed in transit. `detail` must not contain secrets. */
export class MailerError extends Error {
  constructor(
    public readonly code: string,
    public readonly detail: string,
    public readonly status?: number,
  ) {
    super(`${code}: ${detail}`);
  }
}

export interface Mailer {
  readonly provider: string;
  send(email: OutgoingEmail): Promise<SendResult>;
}

/** SendGrid v3 Mail Send. https://www.twilio.com/docs/sendgrid/api-reference/mail-send/mail-send */
export class SendGridMailer implements Mailer {
  readonly provider = 'sendgrid';

  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 15_000,
  ) {}

  async send(e: OutgoingEmail): Promise<SendResult> {
    const body = {
      personalizations: [{ to: [{ email: e.to }] }],
      from: { email: e.fromEmail, name: e.fromName },
      ...(e.replyTo ? { reply_to: { email: e.replyTo } } : {}),
      subject: e.subject,
      content: [
        { type: 'text/plain', value: e.text },
        { type: 'text/html', value: e.html },
      ],
      ...(e.headers && Object.keys(e.headers).length ? { headers: e.headers } : {}),
      ...(e.tags ? { custom_args: e.tags } : {}),
      // Our links carry tokens in the URL fragment; click tracking would rewrite them
      // through SendGrid's redirector. Unsubscribe is handled by our own link.
      tracking_settings: {
        click_tracking: { enable: false, enable_text: false },
        open_tracking: { enable: false },
        subscription_tracking: { enable: false },
      },
    };
    let res: Response;
    try {
      res = await this.fetchImpl('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new MailerError('network_error', (err as Error).name || 'fetch failed');
    }
    if (res.status === 202 || res.status === 200) {
      return { providerMessageId: res.headers.get('x-message-id') };
    }
    // SendGrid error bodies list field problems; they don't echo the API key.
    let detail = `HTTP ${res.status}`;
    try {
      const j = (await res.json()) as { errors?: { message?: string; field?: string }[] };
      if (j.errors?.length) {
        detail += ': ' + j.errors.map((x) => [x.field, x.message].filter(Boolean).join(' ')).join('; ');
      }
    } catch {
      /* non-JSON body */
    }
    throw new MailerError(res.status === 401 || res.status === 403 ? 'provider_auth' : 'provider_rejected', detail.slice(0, 500), res.status);
  }
}

/** In-memory mailer for tests and local dev. Records every message; can be told to fail. */
export class MemoryMailer implements Mailer {
  readonly provider = 'memory';
  readonly sent: OutgoingEmail[] = [];
  /** Recipients whose sends should fail. */
  readonly failFor = new Set<string>();
  private n = 0;

  async send(e: OutgoingEmail): Promise<SendResult> {
    if (this.failFor.has(e.to)) throw new MailerError('provider_rejected', 'HTTP 400: simulated failure', 400);
    this.sent.push(e);
    return { providerMessageId: `mem-${++this.n}` };
  }
}
