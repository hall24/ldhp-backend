/**
 * Outreach email templates. Staff write plain text with a few {{placeholders}}; we
 * produce text and HTML parts and always add a footer that names the business, its
 * postal address and an unsubscribe link (PRD §4 step 6, §10).
 */

export const PLACEHOLDERS = ['customer_name', 'business_name', 'service_type', 'response_link'] as const;
export type Placeholder = (typeof PLACEHOLDERS)[number];

const TAG = /\{\{\s*([A-Za-z_]+)\s*\}\}/g;

/** Returns field errors, or null if the template is usable. */
export function validateTemplate(subject: string | null, body: string): Record<string, string> | null {
  const errors: Record<string, string> = {};
  const unknown = (s: string) =>
    [...s.matchAll(TAG)].map((m) => m[1]!).filter((n) => !(PLACEHOLDERS as readonly string[]).includes(n));
  const badBody = unknown(body);
  if (badBody.length) errors.body = `unknown placeholder(s): ${[...new Set(badBody)].join(', ')}`;
  if (subject !== null) {
    const badSubject = unknown(subject);
    if (badSubject.length) errors.subject = `unknown placeholder(s): ${[...new Set(badSubject)].join(', ')}`;
    else if (/\{\{\s*response_link\s*\}\}/.test(subject)) errors.subject = 'response_link can only be used in the body';
  }
  return Object.keys(errors).length ? errors : null;
}

export const humanizeServiceType = (s: string | null | undefined) => (s ? s.replace(/_/g, ' ') : 'service');

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export interface RenderInput {
  subject: string;
  body: string;
  vars: { customer_name: string; business_name: string; service_type: string | null };
  responseUrl: string;
  unsubscribeUrl: string;
  mailingAddress: string;
  recipient: string;
}

export function renderEmail(r: RenderInput): { subject: string; text: string; html: string } {
  const values: Record<Placeholder, string> = {
    customer_name: r.vars.customer_name,
    business_name: r.vars.business_name,
    service_type: humanizeServiceType(r.vars.service_type),
    response_link: r.responseUrl,
  };
  // Every message carries a way to answer, even if staff left the placeholder out.
  const body = /\{\{\s*response_link\s*\}\}/.test(r.body)
    ? r.body
    : `${r.body.trimEnd()}\n\nLet us know what you'd like: {{response_link}}`;

  const subject = r.subject.replace(TAG, (_, n: Placeholder) => values[n] ?? '').replace(/[\r\n]+/g, ' ').trim();
  const text = body.replace(TAG, (_, n: Placeholder) => values[n] ?? '');

  let html = '';
  let last = 0;
  for (const m of body.matchAll(TAG)) {
    html += escapeHtml(body.slice(last, m.index));
    const name = m[1] as Placeholder;
    html +=
      name === 'response_link'
        ? `<a href="${escapeHtml(r.responseUrl)}">Reply here</a>`
        : escapeHtml(values[name] ?? '');
    last = m.index! + m[0].length;
  }
  html += escapeHtml(body.slice(last));
  html = html.replace(/\r?\n/g, '<br>\n');

  const biz = r.vars.business_name;
  const footerText =
    `\n\n--\n${biz}\n${r.mailingAddress}\n` +
    `You're receiving this at ${r.recipient} because you're a customer of ${biz}.\n` +
    `Unsubscribe: ${r.unsubscribeUrl}\n`;
  const footerHtml =
    `<hr style="border:none;border-top:1px solid #ddd;margin:24px 0 12px">` +
    `<p style="font-size:12px;color:#666;line-height:1.5">${escapeHtml(biz)}<br>` +
    `${escapeHtml(r.mailingAddress).replace(/\r?\n/g, '<br>')}<br>` +
    `You're receiving this at ${escapeHtml(r.recipient)} because you're a customer of ${escapeHtml(biz)}.<br>` +
    `<a href="${escapeHtml(r.unsubscribeUrl)}">Unsubscribe</a></p>`;

  return {
    subject,
    text: text + footerText,
    html: `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5">${html}${footerHtml}</div>`,
  };
}
