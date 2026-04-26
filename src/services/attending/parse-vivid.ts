// Vivid Seats confirmation-email HTML parser.
//
// Format observed (2016 Texas Rangers @ Oakland A's):
//   Order #
//   8009987
//   Order Total
//   $82.50
//   Quantity
//   3
//   Event
//   Texas Rangers at Oakland Athletics
//   Oakland Coliseum
//   Mon. May 16, 2016 7:05 PM
//   Section: Field Outfield 106 Row: 1

import { stripToText } from './parse-ticketclub.js';
import type { ParsedReservation, Vendor } from './parse-jsonld.js';

export function parseVividHtml(
  html: string | null | undefined
): ParsedReservation[] | null {
  if (!html) return null;
  const text = stripToText(html);

  const orderNumber = matchLineAfter(text, 'Order #');
  if (!orderNumber || !/^\d+$/.test(orderNumber)) return null;

  const total =
    matchLineAfter(text, 'Order Total')?.replace(/[^0-9.,]/g, '') ??
    matchSimple(text, /Order Total[\s\S]{0,30}?\$([0-9.,]+)/i);
  const totalCents = total
    ? Math.round(parseFloat(total.replace(/,/g, '')) * 100)
    : null;

  // Section + Row inline: "Section: X Row: Y"
  const section = matchSimple(text, /Section:\s*([^\n]+?)(?:\s+Row:|\n|$)/i);
  const row = matchSimple(text, /Row:\s*([^\n]+?)(?:\n|$)/i);

  // Lines after "Event" label: name, venue, date.
  const lines = text
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  const eventIdx = lines.findIndex((l) => /^Event$/i.test(l));
  let eventName = '';
  let venue: string | null = null;
  let eventStart: string | null = null;
  if (eventIdx >= 0) {
    const after = lines.slice(eventIdx + 1, eventIdx + 6);
    eventName = after[0] ?? '';
    venue = after[1] ?? null;
    if (after[2]) eventStart = parseVividDate(after[2]);
  }

  return [
    {
      vendor: 'vividseats' as Vendor,
      reservation_number: orderNumber,
      event_name: eventName,
      event_start: eventStart,
      venue_name: venue,
      venue_address: venue,
      section,
      row,
      seat: null,
      total_price_cents: totalCents,
      currency: 'USD',
    },
  ];
}

/** Parse "Mon. May 16, 2016 7:05 PM" → "2016-05-16T19:05". */
function parseVividDate(s: string): string | null {
  const m = s.match(
    /(?:[A-Za-z]+\.?,?\s*)?([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})\s+(\d{1,2}):(\d{2})\s*(am|pm)/i
  );
  if (!m) return null;
  const months: Record<string, string> = {
    jan: '01',
    feb: '02',
    mar: '03',
    apr: '04',
    may: '05',
    jun: '06',
    jul: '07',
    aug: '08',
    sep: '09',
    oct: '10',
    nov: '11',
    dec: '12',
  };
  const mm = months[m[1].slice(0, 3).toLowerCase()];
  if (!mm) return null;
  const dd = m[2].padStart(2, '0');
  const yyyy = m[3];
  const hour12 = parseInt(m[4], 10);
  const min = parseInt(m[5], 10);
  const ampm = m[6].toLowerCase();
  const hour24 =
    ampm === 'pm' && hour12 !== 12
      ? hour12 + 12
      : ampm === 'am' && hour12 === 12
        ? 0
        : hour12;
  return `${yyyy}-${mm}-${dd}T${String(hour24).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

function matchLineAfter(text: string, label: string): string | null {
  const re = new RegExp(`(?:^|\\n)\\s*${label}\\s*\\n+\\s*([^\\n]+)`, 'i');
  const m = text.match(re);
  if (!m) return null;
  return m[1].trim() || null;
}

function matchSimple(text: string, re: RegExp): string | null {
  const m = text.match(re);
  return m ? m[1].trim() || null : null;
}
