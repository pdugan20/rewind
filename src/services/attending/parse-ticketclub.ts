// Ticket Club confirmation-email HTML parser.
//
// Validated against real bodies from the user's inbox spanning 2016–2025.
// Two layouts observed (template was redesigned ~2020):
//
// LEGACY (e.g. 2018 Cal/UW):
//   Order Summary
//   Order #28437690
//   Event
//   California Golden Bears vs. Washington Huskies
//   Saturday, Oct 27 2018 at Time TBD
//   Memorial Stadium - CA, Berkeley, CA
//   Section
//    Reserved UU
//   Row
//    24
//   Qty
//    7
//   Order Total: $252.00
//
// MODERN (e.g. 2025 Mariners):
//   Order #50755797 — Sep 12 2025 4:06PM
//   Seattle Mariners vs. Los Angeles Angels
//   T-Mobile Park
//   Sunday, Sep 14 2025 @ 1:10PM in Seattle, Washington
//   Section: Main 107 • Row: 30 • Qty: 5
//
// Strategy: strip CSS+tags, then probe for both layouts. The "Order #X"
// line and a line containing " vs. " (event name) appear in both. Date
// parsing tolerates both "at" and "@" separators. Section/Row/Qty
// extraction tries the inline `Section: X • Row: Y` pattern first, then
// falls back to label-on-its-own-line.

import type { ParsedReservation, Vendor } from './parse-jsonld.js';

export function parseTicketClubHtml(
  html: string | null | undefined
): ParsedReservation[] | null {
  if (!html) return null;
  const text = stripToText(html);
  if (!/\bOrder\s*#\s*\d+/i.test(text)) {
    return null;
  }

  const orderNumber = matchSimple(text, /Order\s*#\s*(\d+)/);
  const total =
    matchSimple(text, /Order Total[:\s]*\$?([0-9.,]+)/i) ??
    matchSimple(text, /Total[:\s]*\$([0-9.,]+)/i);
  const totalCents = total
    ? Math.round(parseFloat(total.replace(/,/g, '')) * 100)
    : null;

  // Section/Row/Qty: try inline pattern (modern), fall back to labeled
  // lines (legacy).
  let section = matchSimple(
    text,
    /Section:\s*([^\n•·|]+?)(?:\s*[•·|]|\s*Row:|\n|$)/i
  );
  let row = matchSimple(text, /Row:\s*([^\n•·|]+?)(?:\s*[•·|]|\s*Qty:|\n|$)/i);
  if (!section) section = matchLineAfter(text, 'Section');
  if (!row) row = matchLineAfter(text, 'Row');

  // Event name + venue + date. Walk the lines and identify each by
  // its content shape rather than by label position (the layouts
  // disagree on label position).
  const lines = text
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  const orderLineIdx = lines.findIndex((l) => /Order\s*#\s*\d+/i.test(l));
  const sectionLineIdx = lines.findIndex((l) => /^(Section|Section:)/i.test(l));
  const slice =
    orderLineIdx >= 0 && sectionLineIdx > orderLineIdx
      ? lines.slice(orderLineIdx + 1, sectionLineIdx)
      : orderLineIdx >= 0
        ? lines.slice(orderLineIdx + 1, orderLineIdx + 8)
        : [];

  // Walk slice lines, classifying by content shape (which is more
  // reliable than position — the legacy and modern templates differ).
  let eventName = '';
  let eventStart: string | null = null;
  let dateLineIdx = -1;

  // Pass 1: find event name (line with " vs. " or " vs ") and date.
  // Skip known non-content labels.
  for (let i = 0; i < slice.length; i++) {
    const line = slice[i];
    if (/^(Event|Order Date|Order #|Order Summary|Date|Time)/i.test(line))
      continue;
    const parsedDate = parseTicketClubDate(line);
    if (parsedDate && !eventStart) {
      eventStart = parsedDate;
      dateLineIdx = i;
      continue;
    }
    if (!eventName && / vs\.? /i.test(line) && line.length < 200) {
      eventName = line;
    }
  }

  // Pass 2: pick the venue. Prefer the line right after the date (legacy
  // pattern). For the modern pattern, the venue is on its own line BEFORE
  // the date — pick the first content line that's not the event name
  // and not a header label.
  let venueLine: string | null = null;
  if (dateLineIdx >= 0 && dateLineIdx + 1 < slice.length) {
    const candidate = slice[dateLineIdx + 1];
    if (
      candidate &&
      candidate.length > 2 &&
      candidate.length < 200 &&
      !/^(Section|Row|Qty|Order|Total|Tickets|Delivery|Payment)/i.test(
        candidate
      )
    ) {
      venueLine = candidate;
    }
  }
  // If still no venue, scan for the first content line that's not the
  // event name, not the date, and not a label.
  if (!venueLine) {
    for (const line of slice) {
      if (line === eventName) continue;
      if (parseTicketClubDate(line)) continue;
      if (
        /^(Event|Order Date|Order #|Order Summary|Date|Time|Section|Row|Qty|Total|Tickets|Delivery|Payment|Bill to|Hello|Thanks|Thank)/i.test(
          line
        )
      )
        continue;
      if (line.length < 3 || line.length > 200) continue;
      venueLine = line;
      break;
    }
  }
  // Modern format: "in City, State" appended to the date line. Use
  // the in-clause as a fallback venue/address hint.
  if (!venueLine && eventStart) {
    const cityHint = slice.find(
      (l) => /\sin\s/.test(l) && parseTicketClubDate(l)
    );
    if (cityHint) {
      const tail = cityHint.split(/\s+in\s+/i)[1];
      if (tail) venueLine = tail;
    }
  }

  return [
    {
      vendor: 'ticketclub' as Vendor,
      reservation_number: orderNumber,
      event_name: eventName,
      event_start: eventStart,
      venue_name: venueLine ? cleanVenueName(venueLine) : null,
      venue_address: venueLine,
      section,
      row,
      seat: null,
      total_price_cents: totalCents,
      currency: 'USD',
    },
  ];
}

/**
 * Compact an HTML body for D1 storage: strip CSS + script blocks + HTML
 * comments, then truncate. Many vendor templates front-load the body
 * with kilobytes of inline CSS that crowd the actual ticket content
 * past a naive cap. Stripping first keeps the meaningful payload —
 * the team line, date, venue, seat block — within the storage budget.
 */
export function compactHtmlForStorage(html: string, cap = 32000): string {
  let s = html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
  s = s.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  // Collapse runs of whitespace to compact more.
  s = s.replace(/[ \t]+/g, ' ');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.length > cap ? s.slice(0, cap) : s;
}

/**
 * Strip CSS + script + remaining tags, decode common entities, and
 * collapse whitespace into a line-oriented plain-text view.
 */
export function stripToText(html: string): string {
  let s = html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
  s = s.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(p|div|tr|td|h[1-6]|li)>/gi, '\n');
  s = s.replace(/<[^>]+>/g, ' ');
  s = s.replace(/&nbsp;/g, ' ');
  s = s.replace(/&amp;/g, '&');
  s = s.replace(/&#39;|&apos;/g, "'");
  s = s.replace(/&quot;/g, '"');
  s = s.replace(/&bull;/g, '•');
  s = s.replace(/&middot;/g, '·');
  s = s.replace(/&mdash;/g, '—');
  s = s.replace(/&ndash;/g, '–');
  s = s.replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  // Numeric entities (e.g. &#10003; — checkmark)
  s = s.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
  // Collapse whitespace to single spaces but preserve newlines
  s = s.replace(/[ \t]+/g, ' ');
  s = s.replace(/\n[ \t]+/g, '\n');
  s = s.replace(/[ \t]+\n/g, '\n');
  s = s.replace(/\n{2,}/g, '\n');
  return s.trim();
}

/**
 * Strip trailing ", City, State" or " - State" patterns from a venue
 * line while preserving venue names that contain hyphens (T-Mobile
 * Park) or commas inside parentheses. Splits only on ` - ` (with
 * surrounding spaces) and the first comma.
 */
function cleanVenueName(line: string): string {
  let s = line.trim();
  // Drop trailing " - <STATE>" first
  s = s.replace(/\s+-\s+[A-Z]{2}$/, '');
  // Drop trailing ", City, State" segments
  const commaIdx = s.indexOf(',');
  if (commaIdx > 0) s = s.slice(0, commaIdx).trim();
  // Drop a trailing " - <something>" if remaining (e.g. "Memorial Stadium - CA")
  const dashSpaceIdx = s.lastIndexOf(' - ');
  if (dashSpaceIdx > 0) {
    const tail = s.slice(dashSpaceIdx + 3).trim();
    // Only strip when the tail looks like a state code or short region
    if (/^[A-Z]{2}$/.test(tail) || tail.length < 4) {
      s = s.slice(0, dashSpaceIdx).trim();
    }
  }
  return s;
}

function matchSimple(text: string, re: RegExp): string | null {
  const m = text.match(re);
  if (!m) return null;
  return m[1].trim() || null;
}

/**
 * Match `Label\nvalue` — label on a line, value on the next non-blank
 * line. Used for Section/Row/Qty whose values are on the line after
 * the label (legacy format).
 */
function matchLineAfter(text: string, label: string): string | null {
  const re = new RegExp(
    `(?:^|\\n)\\s*${label}\\s*(?::|\\n)\\s*\\n?\\s*([^\\n]+)`,
    'i'
  );
  const m = text.match(re);
  if (!m) return null;
  return m[1].trim() || null;
}

/**
 * Parse Ticket Club's date formats:
 *   "Saturday, Oct 27 2018 at Time TBD"
 *   "Saturday, Oct 27 2018 at 7:00 PM"
 *   "Sunday, Sep 14 2025 @ 1:10PM in Seattle, Washington"
 *   "Sep 12 2025 4:06PM"  (modern Order # timestamp — has time but
 *                          no separator; only return non-null when
 *                          we're confident this is the EVENT date,
 *                          which the caller picks by context)
 */
export function parseTicketClubDate(line: string): string | null {
  // Pattern with explicit "at" or "@" separator:
  //   <weekday>, <Mon> <D> <YYYY> [at|@] <H>:<M>[ ]<AM/PM>
  // Also accepts "at Time TBD".
  const m = line.match(
    /(?:[A-Za-z]+,\s*)?([A-Za-z]+)\s+(\d{1,2})(?:,)?\s+(\d{4})(?:\s+(?:at|@)\s+(?:(\d{1,2}):(\d{2})\s*(am|pm)|Time\s+TBD))?/i
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
  if (!m[4]) {
    // Time TBD or absent — return date-only ISO
    return `${yyyy}-${mm}-${dd}`;
  }
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
