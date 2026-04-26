// Tier-0 ticket extraction: parse Google Calendar's auto-enriched event
// description, which contains structured fields when Google has parsed
// a vendor confirmation email and attached the ticket data to the
// generated calendar entry.
//
// Discovered in Phase 2 — example body for a SeatGeek-purchased
// Mariners game:
//
//   Reservation Number: 6P2-8YP454J
//
//   Provider: SeatGeek
//
//   Guests: Patrick Dugan
//
//   Seats: 18, 19, 20
//
// When the calendar event has these fields, we get vendor + order_id +
// seat info without ever touching Gmail. For the cron path this means
// most ticketed events in the past few years can be loaded from
// calendar alone.
//
// Strategy: case-insensitive labeled-regex over the description body.
// Returns null if the description doesn't carry the expected markers.

import type { Vendor } from './parse-jsonld.js';

export interface CalendarDescriptionTickets {
  vendor: Vendor;
  reservation_number: string | null;
  guests: string[];
  section: string | null;
  row: string | null;
  seats: string[]; // Multiple seats become one row each in the loader
  total_price_cents: number | null;
  currency: string;
}

const PROVIDER_TO_VENDOR: Record<string, Vendor> = {
  ticketmaster: 'ticketmaster',
  axs: 'axs',
  stubhub: 'stubhub',
  seatgeek: 'seatgeek',
  ticketclub: 'ticketclub',
  'vivid seats': 'vividseats',
  vividseats: 'vividseats',
};

export function parseCalendarDescriptionTickets(
  description: string | null | undefined
): CalendarDescriptionTickets | null {
  if (!description) return null;

  const reservation = matchLabel(description, 'Reservation Number');
  const provider = matchLabel(description, 'Provider');
  const guestsRaw = matchLabel(description, 'Guests');
  const seatsRaw =
    matchLabel(description, 'Seats') ?? matchLabel(description, 'Seat');
  const section = matchLabel(description, 'Section');
  const row = matchLabel(description, 'Row');
  const totalRaw =
    matchLabel(description, 'Order Total') ??
    matchLabel(description, 'Total') ??
    matchLabel(description, 'Total Price');

  // Marker check: if NONE of the canonical fields are present, don't
  // claim the description is a ticket payload. Provider OR
  // Reservation Number is enough to count.
  if (!reservation && !provider) return null;

  const vendor: Vendor = provider
    ? (PROVIDER_TO_VENDOR[provider.toLowerCase().trim()] ?? 'unknown')
    : 'unknown';

  const guests = guestsRaw
    ? guestsRaw
        .split(',')
        .map((g) => g.trim())
        .filter(Boolean)
    : [];

  const seats = seatsRaw
    ? seatsRaw
        .split(/[,;]/)
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

  const { cents, currency } = parsePrice(totalRaw);

  return {
    vendor,
    reservation_number: reservation,
    guests,
    section,
    row,
    seats,
    total_price_cents: cents,
    currency,
  };
}

/**
 * Match `Label: value` where value runs to the end of its line.
 * Case-insensitive. Returns null when no match or value is empty.
 */
function matchLabel(text: string, label: string): string | null {
  const re = new RegExp(`${label}:[ \\t]*([^\\r\\n]*)`, 'i');
  const m = text.match(re);
  if (!m) return null;
  const value = m[1].trim();
  return value.length > 0 ? value : null;
}

function parsePrice(raw: string | null): {
  cents: number | null;
  currency: string;
} {
  if (!raw) return { cents: null, currency: 'USD' };
  // Match $XX.XX or USD XX.XX or just XX.XX
  const m = raw.match(/(?:([A-Z]{3})\s*)?\$?([0-9]+(?:\.[0-9]+)?)/);
  if (!m) return { cents: null, currency: 'USD' };
  const currency = m[1] ?? 'USD';
  const dollars = parseFloat(m[2]);
  if (!Number.isFinite(dollars)) return { cents: null, currency };
  return { cents: Math.round(dollars * 100), currency };
}
