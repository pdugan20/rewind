// AXS confirmation-email HTML parser. Validated against real bodies.
//
// Format observed:
//   Thank you for your order. Your confirmation number is 3801192.
//   Order Date: Jun 18 2025
//   Reference Number: 3180687
//   Order details for The Mina Kimes Show
//   scheduled on 7/31/2025 5:30 PM
//   ...
//   Grand Total: $35.00

import { stripToText } from './parse-ticketclub.js';
import type { ParsedReservation, Vendor } from './parse-jsonld.js';

export function parseAxsHtml(
  html: string | null | undefined
): ParsedReservation[] | null {
  if (!html) return null;
  const text = stripToText(html);

  const orderNumber = matchSimple(text, /confirmation number is\s+(\d+)/i);
  if (!orderNumber) return null;

  const eventName = matchSimple(
    text,
    /Order details for\s+([^\n]+?)(?:\n|scheduled on|$)/i
  );
  const dateRaw = matchSimple(text, /scheduled on\s+([^\n]+)/i);
  const eventStart = dateRaw ? parseAxsDate(dateRaw) : null;

  const total =
    matchSimple(text, /Grand Total[:\s]*\$([0-9.,]+)/i) ??
    matchSimple(text, /Order Total[:\s]*\$([0-9.,]+)/i);
  const totalCents = total
    ? Math.round(parseFloat(total.replace(/,/g, '')) * 100)
    : null;

  return [
    {
      vendor: 'axs' as Vendor,
      reservation_number: orderNumber,
      event_name: eventName ?? '',
      event_start: eventStart,
      venue_name: null, // AXS doesn't surface venue in the structured fields
      venue_address: null,
      section: null,
      row: null,
      seat: null,
      total_price_cents: totalCents,
      currency: 'USD',
    },
  ];
}

/** Parse "7/31/2025 5:30 PM" → "2025-07-31T17:30". */
function parseAxsDate(s: string): string | null {
  const m = s.match(
    /(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})\s*(am|pm)?/i
  );
  if (!m) return null;
  const [, mo, d, y, h, mi, ampm] = m;
  const hh = ampm
    ? ampm.toLowerCase() === 'pm' && parseInt(h, 10) !== 12
      ? parseInt(h, 10) + 12
      : ampm.toLowerCase() === 'am' && parseInt(h, 10) === 12
        ? 0
        : parseInt(h, 10)
    : parseInt(h, 10);
  return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}T${String(hh).padStart(2, '0')}:${mi}`;
}

function matchSimple(text: string, re: RegExp): string | null {
  const m = text.match(re);
  if (!m) return null;
  return m[1].trim() || null;
}
