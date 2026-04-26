// Thin client over Gmail API v1 — direct fetch, no SDK.
// Used by the attending-domain Gmail extractor.
//
// Two-step flow:
//   1. messages.list with a Gmail query → get message IDs (and thread IDs).
//      No body or headers, just IDs. ~5 quota units per call.
//   2. messages.get(id, format=full) for each → headers + body parts.
//      ~5 quota units per call. We walk payload.parts[] for text/plain
//      and text/html; bodies are base64url-encoded inside body.data.
//
// Free-tier quota is 1B units/day, 250 units/sec — trivially sufficient
// for scanning a few hundred ticket emails on a daily cron.

const LIST_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages';
const GET_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages';

export interface GmailMessageRef {
  id: string;
  threadId: string;
}

export interface GmailMessage {
  id: string;
  threadId: string;
  internalDate: string; // epoch ms as string
  headers: Record<string, string>; // lowercased header names
  bodyText: string | null; // first text/plain part, base64url-decoded
  bodyHtml: string | null; // first text/html part, base64url-decoded
  raw: unknown; // the full Gmail payload, for any parser that wants more
}

export async function listGmailMessages(
  accessToken: string,
  query: string,
  opts: { pageToken?: string; maxResults?: number } = {}
): Promise<{ messages: GmailMessageRef[]; nextPageToken?: string }> {
  const params = new URLSearchParams();
  params.set('q', query);
  params.set('maxResults', String(opts.maxResults ?? 100));
  if (opts.pageToken) params.set('pageToken', opts.pageToken);

  const res = await fetch(`${LIST_URL}?${params.toString()}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gmail messages.list ${res.status}: ${text}`);
  }
  const data = (await res.json()) as {
    messages?: GmailMessageRef[];
    nextPageToken?: string;
  };
  return {
    messages: data.messages ?? [],
    nextPageToken: data.nextPageToken,
  };
}

export async function getGmailMessage(
  accessToken: string,
  id: string
): Promise<GmailMessage> {
  const res = await fetch(`${GET_URL}/${encodeURIComponent(id)}?format=full`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gmail messages.get ${res.status}: ${text}`);
  }
  const data = (await res.json()) as RawGmailMessage;

  const headers: Record<string, string> = {};
  for (const h of data.payload?.headers ?? []) {
    if (h.name && typeof h.value === 'string') {
      headers[h.name.toLowerCase()] = h.value;
    }
  }

  const bodyText = data.payload ? walkParts(data.payload, 'text/plain') : null;
  const bodyHtml = data.payload ? walkParts(data.payload, 'text/html') : null;

  return {
    id: data.id,
    threadId: data.threadId,
    internalDate: data.internalDate ?? '0',
    headers,
    bodyText,
    bodyHtml,
    raw: data,
  };
}

interface RawGmailMessage {
  id: string;
  threadId: string;
  internalDate?: string;
  payload?: RawPayload;
}

interface RawPayload {
  mimeType?: string;
  headers?: Array<{ name?: string; value?: string }>;
  body?: { data?: string };
  parts?: RawPayload[];
}

/**
 * Walks a Gmail message payload tree looking for the first part with
 * `mimeType === target`, returns the base64url-decoded body or null.
 *
 * Gmail's payload is recursive: a multipart/alternative payload has
 * `parts: [{ mimeType: 'text/plain', body }, { mimeType: 'text/html', body }]`.
 * A multipart/mixed (e.g. with attachments) nests deeper.
 */
function walkParts(payload: RawPayload, target: string): string | null {
  if (payload.mimeType === target && payload.body?.data) {
    return base64UrlDecode(payload.body.data);
  }
  for (const child of payload.parts ?? []) {
    const found = walkParts(child, target);
    if (found !== null) return found;
  }
  return null;
}

/**
 * base64url → utf-8. Gmail uses base64url (RFC 4648 §5): `+`/`/` swapped
 * for `-`/`_`, and padding `=` is omitted. Workers have global atob, but
 * atob doesn't know about base64url — so we restore the URL chars first
 * and re-pad.
 */
export function base64UrlDecode(s: string): string {
  const standard = s.replace(/-/g, '+').replace(/_/g, '/');
  const padded = standard.padEnd(
    standard.length + ((4 - (standard.length % 4)) % 4),
    '='
  );
  // atob returns a binary-string (each char is one byte). To get utf-8
  // text we re-decode the bytes via TextDecoder.
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}

// Subject-line gate. Cheap pre-filter to skip reminders, transfers,
// refunds, and marketing while still catching every real confirmation.
//
// Two passes: REJECT first (drops obvious non-confirmations), then
// ACCEPT (positive signal). Anything matching neither is treated as
// uncertain — for v1 we accept it (better to over-collect than miss a
// real purchase) and rely on the JSON-LD parser to noop on non-tickets.
const SUBJECT_REJECT = [
  'reminder',
  'tomorrow',
  'transferred',
  'sent to you',
  'has been transferred',
  'refund',
  'refunded',
  'cancellation',
  'has been canceled',
  'has been cancelled',
  'gift card',
  'thank you for joining',
  'newsletter',
  'unsubscribe',
  // Marketing / non-purchase noise that slipped through during the
  // Phase 9 prod run.
  'on sale',
  'special offers',
  'see it live',
  'on tour',
  'vip package',
  'verified fan',
  'sign in activity',
  'password has been updated',
  'request to reset password',
  'chances to win',
  'how likely are you',
  'how was it',
  'rate your experience',
  'tell us about',
  // Outgoing transfers — user is GIVING tickets away, not attending.
  // "Your ticket transfer to Brad is on the way" — Brad goes, not user.
  'transfer to',
  'is on the way',
  // Pre-acceptance offers from Mariners Fancare / friends — the
  // companion "all set to see"/"got tickets" email is the actual
  // confirmation we want. Skip the offer; trust the acceptance.
  'just sent you',
  'sent you ticket',
  'sent you 1 seattle',
  'kids club',
];

const SUBJECT_ACCEPT = [
  'order confirmation',
  'your tickets',
  'your order',
  'order #',
  'is confirmed',
  'order is confirmed',
  'tickets for',
  'ticket purchase',
  'thanks for your order',
  // Ticketmaster transfer-complete confirmations.
  "you're all set to see",
  'you got tickets to',
  'you got the tickets',
  'transfer is complete',
  'transfer went through',
  // Generic Ticketmaster purchase confirmations.
  'thanks for your',
];

export type SubjectVerdict = 'accept' | 'reject' | 'uncertain';

export function judgeSubject(subject: string | undefined): SubjectVerdict {
  const s = (subject ?? '').toLowerCase();
  if (!s) return 'uncertain';
  for (const r of SUBJECT_REJECT) {
    if (s.includes(r)) return 'reject';
  }
  for (const a of SUBJECT_ACCEPT) {
    if (s.includes(a)) return 'accept';
  }
  return 'uncertain';
}
