import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  listGmailMessages,
  getGmailMessage,
  base64UrlDecode,
  judgeSubject,
} from './gmail-client.js';

function b64url(text: string): string {
  // Encode utf-8 → base64 → base64url (replace + / with - _, drop padding).
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

describe('Gmail client', () => {
  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch');
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('listGmailMessages', () => {
    it('sends q + maxResults; returns ids + nextPageToken', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            messages: [
              { id: 'm1', threadId: 't1' },
              { id: 'm2', threadId: 't2' },
            ],
            nextPageToken: 'pg2',
          }),
          { status: 200 }
        )
      );
      const result = await listGmailMessages('tk', 'from:noreply@x.com', {
        maxResults: 50,
      });
      expect(result.messages).toHaveLength(2);
      expect(result.nextPageToken).toBe('pg2');
      const url = vi.mocked(globalThis.fetch).mock.calls[0][0] as string;
      expect(url).toContain('q=from%3Anoreply%40x.com');
      expect(url).toContain('maxResults=50');
    });

    it('handles empty result (no messages key)', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValueOnce(
        new Response(JSON.stringify({}), { status: 200 })
      );
      const result = await listGmailMessages('tk', 'q');
      expect(result.messages).toEqual([]);
      expect(result.nextPageToken).toBeUndefined();
    });

    it('throws on non-200', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValueOnce(
        new Response('rate limited', { status: 429 })
      );
      await expect(listGmailMessages('tk', 'q')).rejects.toThrow(/429/);
    });
  });

  describe('getGmailMessage', () => {
    it('extracts headers and walks MIME parts for text/plain + text/html', async () => {
      const payload = {
        mimeType: 'multipart/alternative',
        headers: [
          { name: 'Subject', value: 'Your Tickets' },
          { name: 'From', value: 'noreply@ticketmaster.com' },
        ],
        parts: [
          {
            mimeType: 'text/plain',
            body: { data: b64url('Hello plain.') },
          },
          {
            mimeType: 'text/html',
            body: { data: b64url('<p>Hello html.</p>') },
          },
        ],
      };
      vi.mocked(globalThis.fetch).mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 'm1',
            threadId: 't1',
            internalDate: '1700000000000',
            payload,
          }),
          { status: 200 }
        )
      );
      const msg = await getGmailMessage('tk', 'm1');
      expect(msg.bodyText).toBe('Hello plain.');
      expect(msg.bodyHtml).toBe('<p>Hello html.</p>');
      expect(msg.headers.subject).toBe('Your Tickets');
      expect(msg.headers.from).toBe('noreply@ticketmaster.com');
    });

    it('handles single-part text/html (no parts array)', async () => {
      const payload = {
        mimeType: 'text/html',
        headers: [{ name: 'Subject', value: 'X' }],
        body: { data: b64url('<p>direct</p>') },
      };
      vi.mocked(globalThis.fetch).mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 'm2',
            threadId: 't2',
            payload,
          }),
          { status: 200 }
        )
      );
      const msg = await getGmailMessage('tk', 'm2');
      expect(msg.bodyHtml).toBe('<p>direct</p>');
      expect(msg.bodyText).toBeNull();
    });

    it('walks nested multipart (e.g., multipart/mixed → multipart/alternative → text/html)', async () => {
      const payload = {
        mimeType: 'multipart/mixed',
        headers: [{ name: 'Subject', value: 'Nested' }],
        parts: [
          {
            mimeType: 'multipart/alternative',
            parts: [
              {
                mimeType: 'text/plain',
                body: { data: b64url('plain') },
              },
              {
                mimeType: 'text/html',
                body: { data: b64url('<p>html</p>') },
              },
            ],
          },
          {
            mimeType: 'application/pdf',
            body: { data: b64url('binary-skip') },
          },
        ],
      };
      vi.mocked(globalThis.fetch).mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'm3', threadId: 't3', payload }), {
          status: 200,
        })
      );
      const msg = await getGmailMessage('tk', 'm3');
      expect(msg.bodyText).toBe('plain');
      expect(msg.bodyHtml).toBe('<p>html</p>');
    });

    it('returns null bodies when no matching part exists', async () => {
      const payload = {
        mimeType: 'application/octet-stream',
        body: { data: b64url('some-bytes') },
      };
      vi.mocked(globalThis.fetch).mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'm4', threadId: 't4', payload }), {
          status: 200,
        })
      );
      const msg = await getGmailMessage('tk', 'm4');
      expect(msg.bodyText).toBeNull();
      expect(msg.bodyHtml).toBeNull();
    });
  });

  describe('base64UrlDecode', () => {
    it('decodes ascii', () => {
      expect(base64UrlDecode(b64url('hello'))).toBe('hello');
    });
    it('decodes utf-8 (em-dash)', () => {
      expect(base64UrlDecode(b64url('Mariners — Astros'))).toBe(
        'Mariners — Astros'
      );
    });
    it('handles missing padding', () => {
      // "abc" → base64 "YWJj" (no padding needed). "ab" → "YWI=" (1 padding).
      // base64url drops padding; check that decode still works.
      expect(base64UrlDecode('YWI')).toBe('ab');
      expect(base64UrlDecode('YQ')).toBe('a');
    });
    it('handles base64url-specific chars (- and _)', () => {
      // ?? → base64 "Pz8=" → contains no special chars; pick something
      // that does. The string '<<>' encodes to "PDw+" in standard base64
      // (contains '+'), which becomes "PDw-" in base64url.
      expect(base64UrlDecode('PDw-')).toBe('<<>');
      // Similarly, the bytes that produce '/' in base64. The string
      // "subj?ects" → standard base64 "c3ViaiNlY3Rz" (no slash). Use
      // a known case: the byte 0xFF in a 2-byte sequence produces /.
      // ÿ → utf-8 bytes 0xC3 0xBF → base64 "w78=" → base64url "w78".
      expect(base64UrlDecode('w78')).toBe('ÿ');
    });
  });

  describe('judgeSubject', () => {
    it.each([
      ['Order Confirmation #12345', 'accept'],
      ['Your tickets for Mariners game', 'accept'],
      ['Order is confirmed', 'accept'],
      ['Reminder: your event is tomorrow', 'reject'],
      ['Tickets transferred to John', 'reject'],
      ['Refund processed', 'reject'],
      ['Your order has been canceled', 'reject'],
      ['$25 gift card just for you', 'reject'],
      ['New newsletter from SeatGeek', 'reject'],
      ['Random subject we have not seen', 'uncertain'],
      ['', 'uncertain'],
      [undefined, 'uncertain'],
    ] as const)('judges "%s" → %s', (subject, expected) => {
      expect(judgeSubject(subject)).toBe(expected);
    });
  });
});
