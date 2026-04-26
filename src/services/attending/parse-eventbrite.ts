// Eventbrite confirmation-email HTML parser. Discovered during the
// Phase 9.5 deep-sweep — 66 historical confirmations were sitting
// outside our original 6-vendor allowlist.
//
// Format observed:
//   you're good to go
//   Keep your tickets handy
//   GitHub Partner Appreciation Event       ← event name
//   1 x Ticket                              ← quantity
//   Order total: Free                       ← total ("Free" or "$XX.XX")
//   Tuesday, November 12, 2019 from 5:30 PM to 7:30 PM (PST)  ← date+time
//   GitHub                                  ← venue name
//   88 Colin P Kelly Junior Street          ← venue address
//   San Francisco, CA 94107
//   ...
//   Order
//   #1137115653 - November 4, 2019         ← order number

import { stripToText } from './parse-ticketclub.js';
import type { ParsedReservation, Vendor } from './parse-jsonld.js';

export function parseEventbriteHtml(
  html: string | null | undefined
): ParsedReservation[] | null {
  if (!html) return null;
  const text = stripToText(html);
  if (!/Eventbrite/i.test(text)) return null;

  const orderNumber = matchSimple(text, /Order\s*#\s*(\d{6,})/);
  if (!orderNumber) return null;

  const totalRaw = matchSimple(text, /Order\s+total:?\s*(Free|\$?[0-9.,]+)/i);
  const totalCents =
    totalRaw && totalRaw.toLowerCase() === 'free'
      ? 0
      : totalRaw
        ? Math.round(parseFloat(totalRaw.replace(/[$,]/g, '')) * 100)
        : null;

  // Walk lines after the "you're good to go" / "Keep your tickets
  // handy" anchors — event name follows.
  const lines = text
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  const anchorIdx = lines.findIndex((l) =>
    /^(you'?re good to go|Keep your tickets handy|Your tickets are ready)$/i.test(
      l
    )
  );

  let eventName = '';
  let eventStart: string | null = null;
  let venueLine: string | null = null;

  // Search a window after the anchor (or fall back to first 30 lines).
  const start = anchorIdx >= 0 ? anchorIdx + 1 : 0;
  for (let i = start; i < Math.min(start + 25, lines.length); i++) {
    const line = lines[i];
    if (
      /^(Eventbrite|Get the app|Add to|Google|Outlook|iCal|Yahoo|Follow|Questions about|Order Summary|View|Order|Patrick|This order|This email|Copyright|Printable|\d+ x|Order total)/i.test(
        line
      )
    )
      continue;
    if (/^(GA|General Admission|VIP|RSVP|Free)$/i.test(line)) continue;
    if (/^&[a-z]+;$/i.test(line)) continue;

    const parsedDate = parseEventbriteDate(line);
    if (parsedDate && !eventStart) {
      eventStart = parsedDate;
      continue;
    }
    if (!eventName && line.length > 2 && line.length < 200) {
      eventName = line;
      continue;
    }
    if (
      eventName &&
      !venueLine &&
      !parsedDate &&
      line.length > 2 &&
      line.length < 200
    ) {
      venueLine = line;
    }
  }

  return [
    {
      vendor: 'eventbrite' as Vendor,
      reservation_number: orderNumber,
      event_name: eventName,
      event_start: eventStart,
      venue_name: venueLine,
      venue_address: venueLine,
      section: null,
      row: null,
      seat: null,
      total_price_cents: totalCents,
      currency: 'USD',
    },
  ];
}

/**
 * Parse Eventbrite's date format:
 *   "Tuesday, November 12, 2019 from 5:30 PM to 7:30 PM (PST)"
 *   "Saturday, June 1, 2019 at 8:00 PM"
 *   "Friday, March 15, 2024 from 6:00 PM to 9:00 PM"
 *
 * Captures the START time. Returns ISO 8601 (no offset).
 */
function parseEventbriteDate(s: string): string | null {
  const m = s.match(
    /(?:[A-Za-z]+,\s*)?([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})\s+(?:from|at)\s+(\d{1,2}):(\d{2})\s*(am|pm)/i
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

function matchSimple(text: string, re: RegExp): string | null {
  const m = text.match(re);
  return m ? m[1].trim() || null : null;
}
