// SeatGeek confirmation-email text/plain parser.
//
// Phase 3 reality check: SeatGeek does NOT include JSON-LD in current
// confirmations. The email body is structured plaintext with this
// pattern (label on one line, value on the next):
//
//   Order Details
//
//   Order number
//   6P2-8YP454J
//   Sale date
//   Sat, Apr 18, 2026 at 1:20pm
//   Event
//   Texas Rangers at Seattle Mariners
//   T-Mobile Park, Seattle, WA
//   Sun, Apr 19 at 1:10pm
//   Quantity
//   3 tickets
//
//   Section
//   183
//   Row
//   12
//   Seats
//   18,19,20
//
//   Tickets $51.00
//   Fees $21.90
//   Total US $72.90
//
// The "label\nvalue" shape repeats throughout. This parser extracts
// the labeled fields and produces ParsedReservations matching the
// JSON-LD shape so the loader doesn't care which path produced them.

import type { ParsedReservation, Vendor } from './parse-jsonld.js';

export function parseSeatGeekText(
  bodyText: string | null | undefined
): ParsedReservation[] | null {
  if (!bodyText) return null;
  if (!/Order Details/i.test(bodyText) && !/Order number/i.test(bodyText)) {
    return null; // Not a confirmation
  }

  // Scope parsing to the order block so we don't accidentally pick up
  // marketing prose earlier in the email (which can repeat the team
  // names verbatim and confuse line-after-eventLine logic).
  const orderBlockStart = bodyText.search(/Order\s+Details/i);
  const orderBlock =
    orderBlockStart >= 0 ? bodyText.slice(orderBlockStart) : bodyText;

  const orderNumber = matchLabelValue(orderBlock, 'Order number');
  const eventLine = matchLabelValue(orderBlock, 'Event');
  const section = matchLabelValue(orderBlock, 'Section');
  const row = matchLabelValue(orderBlock, 'Row');
  const seatsLine = matchLabelValue(orderBlock, 'Seats');
  const totalLine = matchAnyOf(orderBlock, [
    /Total\s+US\s+\$([0-9.,]+)/i,
    /Total\s+\$([0-9.,]+)/i,
  ]);

  // Pull venue + datetime from the lines after "Event\n<event name>".
  // Format inside the order block is:
  //   Event
  //   <event name>
  //   <venue, City, State>
  //   <Day, Mon DD at HH:MMpm>
  let venue: string | null = null;
  let eventStart: string | null = null;
  const eventName = eventLine ?? '';
  if (eventLine) {
    const labelMatch = orderBlock.match(/Event\s*\r?\n+([^\r\n]+)/i);
    if (labelMatch) {
      const after = orderBlock
        .slice(labelMatch.index! + labelMatch[0].length)
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (after[0]) venue = after[0];
      if (after[1]) eventStart = parseSeatGeekDateTime(after[1]);
    }
  }

  const totalCents = totalLine
    ? Math.round(parseFloat(totalLine.replace(/,/g, '')) * 100)
    : null;

  const seats = seatsLine
    ? seatsLine
        .split(/[,;]/)
        .map((s) => s.trim())
        .filter(Boolean)
    : [null];

  const out: ParsedReservation[] = [];
  for (const seat of seats) {
    out.push({
      vendor: 'seatgeek' as Vendor,
      reservation_number: orderNumber,
      event_name: eventName,
      event_start: eventStart,
      venue_name: venue ? venue.split(',')[0].trim() : null,
      venue_address: venue,
      section,
      row,
      seat,
      total_price_cents: totalCents,
      currency: 'USD',
    });
  }
  return out;
}

/**
 * Match "Label" on one line and the value on the next non-blank line.
 * SeatGeek uses this pattern throughout the order details block.
 */
function matchLabelValue(text: string, label: string): string | null {
  const re = new RegExp(
    `(?:^|\\n)\\s*${label}\\s*\\r?\\n+\\s*([^\\r\\n]+)`,
    'i'
  );
  const m = text.match(re);
  if (!m) return null;
  const value = m[1].trim();
  return value.length > 0 ? value : null;
}

function matchAnyOf(text: string, patterns: RegExp[]): string | null {
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return m[1].trim();
  }
  return null;
}

/**
 * Parse SeatGeek's "Sun, Apr 19 at 1:10pm" → ISO 8601.
 * No year in the source (!). Caller can refine using the email's
 * internal_date to disambiguate. For now we set year to undefined and
 * return a partial ISO: "MM-DDTHH:MM".
 */
function parseSeatGeekDateTime(s: string): string | null {
  // Example: "Sun, Apr 19 at 1:10pm" or "Sat, Apr 18, 2026 at 1:20pm"
  // Try with year first.
  const withYear = s.match(
    /(\w+),\s*(\w+)\s+(\d+),?\s+(\d{4})\s+at\s+(\d+):(\d+)\s*(am|pm)/i
  );
  const noYear = s.match(
    /(\w+),\s*(\w+)\s+(\d+)\s+at\s+(\d+):(\d+)\s*(am|pm)/i
  );
  const m = withYear || noYear;
  if (!m) return null;
  const monthName = (withYear ? m[2] : m[2]).toLowerCase();
  const day = withYear ? m[3] : m[3];
  const year = withYear ? m[4] : null;
  const hr = parseInt(withYear ? m[5] : m[4], 10);
  const min = parseInt(withYear ? m[6] : m[5], 10);
  const ampm = (withYear ? m[7] : m[6]).toLowerCase();
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
  const mm = months[monthName.slice(0, 3)];
  if (!mm) return null;
  const hour24 =
    ampm === 'pm' && hr !== 12 ? hr + 12 : ampm === 'am' && hr === 12 ? 0 : hr;
  const yearPart = year ? `${year}-` : '';
  // No timezone — SeatGeek emails don't include one. Caller can tag PT
  // for venues we know are Pacific.
  return `${yearPart}${mm}-${day.padStart(2, '0')}T${String(hour24).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}
