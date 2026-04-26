// StubHub confirmation-email HTML parser.
//
// Format observed (2016 Starfucker concert):
//   Order #: 204219936    |     Order date: 10/19/2016
//   Starfucker - STRFKR  at Fillmore San Francisco, San Francisco, CA
//   Mon, 11/14/2016, 8:00 p.m. PDT
//   General admission | 3  tickets
//   Order total:
//   $167.00 USD
//
// Distinctive: event name + venue jammed onto one line, separated by " at ".

import { stripToText } from './parse-ticketclub.js';
import type { ParsedReservation, Vendor } from './parse-jsonld.js';

export function parseStubhubHtml(
  html: string | null | undefined
): ParsedReservation[] | null {
  if (!html) return null;
  const text = stripToText(html);

  const orderNumber = matchSimple(text, /Order\s*#:?\s*(\d+)/i);
  if (!orderNumber) return null;

  // The "EVENT at VENUE, City, State" line is the next non-skip
  // content line that contains " at ". The date follows on the next
  // content line.
  const lines = text
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  const orderLineIdx = lines.findIndex((l) => /Order\s*#:?\s*\d+/i.test(l));
  let eventLine = '';
  let dateLine = '';
  if (orderLineIdx >= 0) {
    for (
      let i = orderLineIdx + 1;
      i < Math.min(orderLineIdx + 8, lines.length);
      i++
    ) {
      const l = lines[i];
      if (/^(Hi|Ready on|Sports|Concerts|Theater|StubHub)/i.test(l)) continue;
      if (!eventLine && / at /i.test(l)) {
        eventLine = l;
        continue;
      }
      if (eventLine && !dateLine && parseStubhubDate(l)) {
        dateLine = l;
        break;
      }
    }
  }

  let eventName = '';
  let venueLine: string | null = null;
  if (eventLine) {
    const idx = eventLine.lastIndexOf(' at ');
    if (idx > 0) {
      eventName = eventLine.slice(0, idx).trim();
      venueLine = eventLine.slice(idx + 4).trim();
    } else {
      eventName = eventLine;
    }
  }

  const eventStart = dateLine ? parseStubhubDate(dateLine) : null;
  const total = matchSimple(text, /Order total:?\s*\$?([0-9.,]+)/i);
  const totalCents = total
    ? Math.round(parseFloat(total.replace(/,/g, '')) * 100)
    : null;

  // Try inline section/row from "general admission | N tickets" or
  // "Section X | Row Y" patterns.
  const section = matchSimple(
    text,
    /(?:Section|Sec)[:\s]+([A-Za-z0-9 ]+?)(?:\s*\||\s*Row|\n|$)/i
  );
  const row = matchSimple(text, /\bRow[:\s]+([A-Za-z0-9]+)/i);

  return [
    {
      vendor: 'stubhub' as Vendor,
      reservation_number: orderNumber,
      event_name: eventName,
      event_start: eventStart,
      venue_name: venueLine ? venueLine.split(',')[0].trim() : null,
      venue_address: venueLine,
      section,
      row,
      seat: null,
      total_price_cents: totalCents,
      currency: 'USD',
    },
  ];
}

/** Parse "Mon, 11/14/2016, 8:00 p.m. PDT" → "2016-11-14T20:00". */
function parseStubhubDate(s: string): string | null {
  const m = s.match(
    /(?:[A-Za-z]+,?\s*)?(\d{1,2})\/(\d{1,2})\/(\d{4})(?:,?\s+(\d{1,2}):(\d{2})\s*(a\.?m\.?|p\.?m\.?))?/i
  );
  if (!m) return null;
  const mm = m[1].padStart(2, '0');
  const dd = m[2].padStart(2, '0');
  const yyyy = m[3];
  if (!m[4]) return `${yyyy}-${mm}-${dd}`;
  const h12 = parseInt(m[4], 10);
  const min = parseInt(m[5], 10);
  const ampm = m[6].replace(/\./g, '').toLowerCase();
  const hh =
    ampm === 'pm' && h12 !== 12
      ? h12 + 12
      : ampm === 'am' && h12 === 12
        ? 0
        : h12;
  return `${yyyy}-${mm}-${dd}T${String(hh).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

function matchSimple(text: string, re: RegExp): string | null {
  const m = text.match(re);
  return m ? m[1].trim() || null : null;
}
