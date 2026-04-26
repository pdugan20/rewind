// Ticketmaster confirmation-email HTML parser. Covers the official
// Ticketmaster sender plus team-branded sub-brands (Mariners Fancare,
// etc.) which all come from customer_support@email.ticketmaster.com.
//
// Validated against real bodies from the user's inbox spanning 2018–2024.
// Two layouts observed:
//
// LEGACY (e.g. 2018 RÜFÜS DU SOL):
//   Thanks Patrick, here's your order info.
//   4 General Admission ticket(s) in Section GENADM
//   RÜFÜS DU SOL
//   Bill Graham Civic Auditorium, San Francisco, CA
//   Tue, Nov 06 2018 - 8:00 PM
//   ...
//   Confirmation Number
//   92-44135/NCA
//   Order Summary
//   $228.20
//
// MODERN (e.g. 2019+ Mariners):
//   You Got the Tickets!
//   Order # 44-56099/SEA
//   Seattle Mariners vs. Minnesota Twins
//   Thu • May 16 2019 • 7:10 PM
//   ...
//
// Strategy: strip CSS+tags, identify by content shape — the
// "Order # X" or "Confirmation Number" anchor is reliable across
// layouts. Section is in either "in Section X" inline, or a labeled
// line. Date parsing handles dash and bullet separators.

import { stripToText } from './parse-ticketclub.js';
import type { ParsedReservation, Vendor } from './parse-jsonld.js';

export function parseTicketmasterHtml(
  html: string | null | undefined,
  sourceRef?: string
): ParsedReservation[] | null {
  if (!html) return null;
  const text = stripToText(html);

  // Transfer-complete branch — Ticketmaster sends these when a friend
  // transfers tickets to you and you accept. No Order# in the email
  // body (the original purchase had one), so we synthesize a
  // reservation_number from the source ref. The body is well-shaped:
  // "Patrick, Your Ticket Transfer Is Complete!" anchor, then the
  // game line, date, venue, and seat block.
  if (
    /Your Ticket Transfer (?:is|Is) [Cc]omplete/.test(text) ||
    /Transfer Status:\s*Completed/i.test(text) ||
    /successfully accepted your ticket transfer/i.test(text)
  ) {
    return parseTicketmasterTransfer(text, sourceRef);
  }

  // Order number anchor — present in both layouts.
  const orderNumber =
    matchSimple(text, /Order\s*#\s*([A-Z0-9][A-Z0-9-/]+)/i) ??
    matchLineAfterAnchor(text, 'Confirmation Number');
  if (!orderNumber) return null;

  // Section: try inline "X ticket(s) in Section Y" first (legacy)
  // then labeled "Section\nVALUE" (modern uses a different shape but
  // we cover the legacy case).
  const sectionInline = matchSimple(
    text,
    /\d+\s+(?:[A-Z][A-Za-z\s]*?\s)?ticket\(s\)\s+in\s+Section\s+([^\n]+?)(?:[,.]|$|\n)/i
  );
  const section = sectionInline ?? matchLineAfterAnchor(text, 'Section');
  const row = matchLineAfterAnchor(text, 'Row');

  // Total — Order Summary block typically has $XXX.XX on next line.
  const total =
    matchSimple(text, /Order Summary[\s\S]{0,40}?\$([0-9.,]+)/) ??
    matchSimple(text, /Order Total[:\s]*\$([0-9.,]+)/i) ??
    matchSimple(text, /Total[:\s]*\$([0-9.,]+)/i);
  const totalCents = total
    ? Math.round(parseFloat(total.replace(/,/g, '')) * 100)
    : null;

  // Search the full body for event name + venue + date. Both layouts
  // put these together (modern: after order #; legacy: before it), so
  // a single global scan is the simplest correct approach.
  const lines = text
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  const skipPattern =
    /^(Order|Confirmation|Section|Row|Total|Tickets?|Ticketmaster|My Account|You|Bill to|Patrick|Thanks|View|Sign|Standard|Allow|Protect|We'd|Take|Survey|Add to|Buyer|Special|Notes?|Important|Privacy|Unsubscribe|Forward|Visit|Help|Contact|Customer|Subject|To:|From:|©|Copyright|Powered)/i;

  // Prefer lines matching "X vs. Y" or "X vs Y" — sports games and
  // many concerts use this shape. Walk the whole list looking for
  // the strongest title candidate before falling back to the first
  // non-skipped line. This keeps email intros like "The countdown to
  // your event starts now…" from being mis-titled as the event.
  let eventName = '';
  let eventStart: string | null = null;
  let dateLineIdx = -1;
  let versusCandidate: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (skipPattern.test(line)) continue;
    if (line.startsWith('$')) continue;
    if (/^\d+(?:[,.]\d+)?$/.test(line)) continue;
    if (line === orderNumber) continue;
    if (/\bticket\(?s?\)?\b.*\bSection\b/i.test(line)) continue;
    if (/^\d+\s+\w+\s+ticket/i.test(line)) continue;
    const parsedDate = parseTicketmasterDate(line);
    if (parsedDate && !eventStart) {
      eventStart = parsedDate;
      dateLineIdx = i;
      continue;
    }
    if (
      !versusCandidate &&
      / vs\.? /i.test(line) &&
      line.length > 5 &&
      line.length < 200
    ) {
      versusCandidate = line;
    }
    if (!eventName && line.length > 2 && line.length < 200) {
      eventName = line;
    }
  }
  if (versusCandidate) eventName = versusCandidate;

  // Venue: line right before or after the date line, picking whichever
  // looks like a venue.
  let venueLine: string | null = null;
  if (dateLineIdx >= 0) {
    const candidates: string[] = [];
    if (dateLineIdx + 1 < lines.length) candidates.push(lines[dateLineIdx + 1]);
    if (dateLineIdx - 1 >= 0) candidates.push(lines[dateLineIdx - 1]);
    for (const c of candidates) {
      if (!c) continue;
      if (c === eventName) continue;
      if (skipPattern.test(c)) continue;
      if (parseTicketmasterDate(c)) continue;
      if (c.length < 3 || c.length > 200) continue;
      venueLine = c;
      break;
    }
  }

  return [
    {
      vendor: 'ticketmaster' as Vendor,
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
 * Parse a Ticketmaster transfer-completion email body into a
 * ParsedReservation. These emails don't carry an Order#, so we
 * synthesize a reservation_number from the source_ref (preferred) or a
 * content fingerprint (fallback).
 *
 * Body shape (real example):
 *   Patrick, Your Ticket Transfer Is Complete!
 *   ...
 *   Seattle Mariners vs. Houston Astros
 *   Wed, Apr 9 @ 1:10 PM
 *   T-Mobile Park, Seattle, WA
 *   Section 191, Row 2, Seat 20
 *   ...
 *   (c) 2025 Ticketmaster
 */
function parseTicketmasterTransfer(
  text: string,
  sourceRef: string | undefined
): ParsedReservation[] | null {
  const lines = text
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);

  // Year inference: prefer the copyright line, fall back to current year.
  const copyrightYear = matchSimple(text, /\(c\)\s*(\d{4})\s*Ticketmaster/i);
  const inferredYear = copyrightYear ?? String(new Date().getFullYear());

  // Find "X vs. Y" line (event name).
  let eventName: string | null = null;
  let dateLine: string | null = null;
  let venueLine: string | null = null;
  let seatLine: string | null = null;
  for (const line of lines) {
    if (!eventName && / vs\.? /i.test(line) && line.length < 150) {
      eventName = line;
      continue;
    }
    if (
      !dateLine &&
      /\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)/i.test(line) &&
      /@/.test(line)
    ) {
      dateLine = line;
      continue;
    }
    if (!venueLine && /,\s*[A-Z]{2}\b/.test(line) && line.length < 200) {
      venueLine = line;
      continue;
    }
    if (!seatLine && /Section\s+\S/i.test(line) && /Row\s+\S/i.test(line)) {
      seatLine = line;
    }
  }
  if (!eventName || !dateLine) return null;

  const eventStart = parseTicketmasterTransferDate(dateLine, inferredYear);
  const section = seatLine
    ? matchSimple(seatLine, /Section\s+([^,]+?)(?:,|$)/i)
    : null;
  const row = seatLine ? matchSimple(seatLine, /Row\s+([^,]+?)(?:,|$)/i) : null;
  const seat = seatLine
    ? matchSimple(seatLine, /Seat\s+([^,]+?)(?:,|$)/i)
    : null;

  return [
    {
      vendor: 'ticketmaster' as Vendor,
      reservation_number: sourceRef
        ? `tm-transfer-${sourceRef}`
        : `tm-transfer-${eventName.slice(0, 12)}-${eventStart ?? 'unknown'}`,
      event_name: eventName,
      event_start: eventStart,
      venue_name: venueLine ? cleanVenueName(venueLine) : null,
      venue_address: venueLine,
      section,
      row,
      seat,
      total_price_cents: null,
      currency: 'USD',
    },
  ];
}

/**
 * Parse Ticketmaster's transfer-email date format (no year):
 *   "Wed, Apr 9 @ 1:10 PM"
 *   "Sat • Jul 13 • 6:40 PM"
 */
function parseTicketmasterTransferDate(
  line: string,
  year: string
): string | null {
  const m = line.match(
    /([A-Za-z]+)\s+(\d{1,2})\s*[@•·-]\s*(\d{1,2}):(\d{2})\s*(am|pm)/i
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
  const hour12 = parseInt(m[3], 10);
  const min = parseInt(m[4], 10);
  const ampm = m[5].toLowerCase();
  const hour24 =
    ampm === 'pm' && hour12 !== 12
      ? hour12 + 12
      : ampm === 'am' && hour12 === 12
        ? 0
        : hour12;
  return `${year}-${mm}-${dd}T${String(hour24).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

function cleanVenueName(line: string): string {
  let s = line.trim();
  // Drop trailing ", City, State"
  const commaIdx = s.indexOf(',');
  if (commaIdx > 0) s = s.slice(0, commaIdx).trim();
  return s;
}

function matchSimple(text: string, re: RegExp): string | null {
  const m = text.match(re);
  if (!m) return null;
  return m[1].trim() || null;
}

function matchLineAfterAnchor(text: string, anchor: string): string | null {
  const re = new RegExp(
    `(?:^|\\n)\\s*${anchor}\\s*(?:\\n|:)\\s*([^\\n]+)`,
    'i'
  );
  const m = text.match(re);
  if (!m) return null;
  return m[1].trim() || null;
}

/**
 * Parse Ticketmaster's date formats:
 *   "Tue, Nov 06 2018 - 8:00 PM"        (legacy, dash separator)
 *   "Thu • May 16 2019 • 7:10 PM"       (modern, bullet separator)
 *   "Tuesday, November 6 2018 at 8 PM"  (long form, "at" separator)
 *
 * Returns ISO 8601 (no offset) on success, null otherwise.
 */
export function parseTicketmasterDate(line: string): string | null {
  const m = line.match(
    /(?:[A-Za-z]+[,\s•·]+)?([A-Za-z]+)\s+(\d{1,2})(?:,)?\s+(\d{4})[\s•·-]+(\d{1,2}):(\d{2})\s*(am|pm)/i
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
