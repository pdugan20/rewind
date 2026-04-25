// Universal schema.org/EventReservation parser.
//
// Covers Ticketmaster, AXS, StubHub, and SeatGeek confirmation emails
// (Google's "email markup" trusted-sender list — these vendors emit
// valid JSON-LD that Gmail itself parses for inbox event-card display).
//
// Parses the HTML body of a confirmation email, extracts every
// `<script type="application/ld+json">…</script>` block, and walks for
// EventReservation entries. Returns `null` if no EventReservation found —
// caller falls back to a vendor-specific HTML scraper (Phase 3.4 stub
// for Vivid + TicketClub).
//
// Multi-seat handling: Ticketmaster + AXS emit one EventReservation per
// seat. SeatGeek emits one EventReservation with N reservedTicket entries.
// We normalize both to N ParsedReservations, one per seat.

export type Vendor =
  | 'ticketmaster'
  | 'axs'
  | 'stubhub'
  | 'seatgeek'
  | 'ticketclub'
  | 'vividseats'
  | 'unknown';

export interface ParsedReservation {
  vendor: Vendor;
  reservation_number: string | null;
  event_name: string;
  event_start: string | null; // ISO 8601 with offset (or just date)
  venue_name: string | null;
  venue_address: string | null;
  section: string | null;
  row: string | null;
  seat: string | null;
  total_price_cents: number | null;
  currency: string;
}

const SCRIPT_TAG_RE =
  /<script[^>]*type=['"]application\/ld\+json['"][^>]*>([\s\S]*?)<\/script>/gi;

/**
 * Extract every EventReservation from an email's HTML body.
 * Returns [] if there were JSON-LD blocks but none were EventReservations,
 * `null` if there were no JSON-LD blocks at all (so the caller knows
 * whether to fall back to a vendor-specific HTML scraper).
 */
export function parseEventReservationFromHtml(
  html: string,
  vendor: Vendor = 'unknown'
): ParsedReservation[] | null {
  const blocks: unknown[] = [];
  let match: RegExpExecArray | null;
  // Reset regex state in case it's re-used (gi flag carries lastIndex).
  SCRIPT_TAG_RE.lastIndex = 0;
  while ((match = SCRIPT_TAG_RE.exec(html)) !== null) {
    const raw = match[1].trim();
    if (!raw) continue;
    try {
      blocks.push(JSON.parse(raw));
    } catch {
      // Some senders embed broken JSON (tracking pixels, malformed
      // attempts at LD+JSON). Skip and keep going.
    }
  }
  if (blocks.length === 0) return null;

  const reservations: ParsedReservation[] = [];
  for (const block of blocks) {
    for (const entry of unwrap(block)) {
      if (isEventReservation(entry)) {
        reservations.push(...normalizeReservation(entry, vendor));
      }
    }
  }
  return reservations;
}

/**
 * JSON-LD payloads can be a single object, an array of objects, or
 * `{ "@graph": [ ... ] }`. Yield every leaf object.
 */
function* unwrap(value: unknown): Iterable<Record<string, unknown>> {
  if (Array.isArray(value)) {
    for (const item of value) yield* unwrap(item);
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  const obj = value as Record<string, unknown>;
  if ('@graph' in obj && Array.isArray(obj['@graph'])) {
    for (const item of obj['@graph'] as unknown[]) yield* unwrap(item);
    return;
  }
  yield obj;
}

function isEventReservation(obj: Record<string, unknown>): boolean {
  return obj['@type'] === 'EventReservation';
}

/**
 * Convert an EventReservation entry into one or more ParsedReservation
 * rows (one per seat). `reservedTicket` may be a single object or an
 * array.
 */
function normalizeReservation(
  entry: Record<string, unknown>,
  vendor: Vendor
): ParsedReservation[] {
  const reservationNumber = stringOrNull(entry.reservationNumber);
  const eventForRaw = entry.reservationFor;
  const eventFor =
    typeof eventForRaw === 'object' && eventForRaw !== null
      ? (eventForRaw as Record<string, unknown>)
      : {};
  const eventName = stringOrEmpty(eventFor.name);
  const eventStart = stringOrNull(eventFor.startDate);

  const locationRaw = eventFor.location;
  const location =
    typeof locationRaw === 'object' && locationRaw !== null
      ? (locationRaw as Record<string, unknown>)
      : {};
  const venueName = stringOrNull(location.name);
  const venueAddress = formatAddress(location.address);

  const totalPriceCents = parsePriceCents(entry.totalPrice);
  const currency = stringOrDefault(entry.priceCurrency, 'USD');

  // reservedTicket may be: undefined, single object, or array.
  const ticketsRaw = entry.reservedTicket;
  const tickets: unknown[] = Array.isArray(ticketsRaw)
    ? ticketsRaw
    : ticketsRaw
      ? [ticketsRaw]
      : [null];

  const out: ParsedReservation[] = [];
  for (const t of tickets) {
    const seat = parseSeat(t);
    out.push({
      vendor,
      reservation_number: reservationNumber,
      event_name: eventName,
      event_start: eventStart,
      venue_name: venueName,
      venue_address: venueAddress,
      section: seat.section,
      row: seat.row,
      seat: seat.seat,
      total_price_cents: totalPriceCents,
      currency,
    });
  }
  return out;
}

function parseSeat(ticket: unknown): {
  section: string | null;
  row: string | null;
  seat: string | null;
} {
  if (typeof ticket !== 'object' || ticket === null) {
    return { section: null, row: null, seat: null };
  }
  const t = ticket as Record<string, unknown>;
  const seatRaw = t.ticketedSeat;
  const seat =
    typeof seatRaw === 'object' && seatRaw !== null
      ? (seatRaw as Record<string, unknown>)
      : {};
  const seatNumber = stringOrNull(seat.seatNumber);
  // AXS quirk: "Mobile Entry" in seatNumber when there's no assigned seat.
  const normalizedSeat =
    seatNumber && /mobile entry/i.test(seatNumber) ? null : seatNumber;
  return {
    section: stringOrNull(seat.seatSection),
    row: stringOrNull(seat.seatRow),
    seat: normalizedSeat,
  };
}

function formatAddress(addr: unknown): string | null {
  if (!addr) return null;
  if (typeof addr === 'string') return addr.trim() || null;
  if (typeof addr !== 'object') return null;
  const a = addr as Record<string, unknown>;
  const parts = [
    a.streetAddress,
    a.addressLocality,
    a.addressRegion,
    a.postalCode,
    a.addressCountry,
  ]
    .filter((p) => typeof p === 'string' && p.trim())
    .map((p) => (p as string).trim());
  return parts.length > 0 ? parts.join(', ') : null;
}

function parsePriceCents(value: unknown): number | null {
  if (typeof value === 'number') return Math.round(value * 100);
  if (typeof value === 'string') {
    const n = parseFloat(value);
    return Number.isFinite(n) ? Math.round(n * 100) : null;
  }
  return null;
}

function stringOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}
function stringOrEmpty(v: unknown): string {
  return typeof v === 'string' ? v : '';
}
function stringOrDefault(v: unknown, dflt: string): string {
  return typeof v === 'string' && v.length > 0 ? v : dflt;
}

/**
 * Best-effort vendor inference from the From header of a Gmail message.
 * Returns 'unknown' for senders we don't recognize.
 */
export function inferVendorFromSender(from: string | undefined): Vendor {
  if (!from) return 'unknown';
  const f = from.toLowerCase();
  if (f.includes('ticketmaster.com')) return 'ticketmaster';
  if (f.includes('axs.com')) return 'axs';
  if (f.includes('stubhub.com')) return 'stubhub';
  if (f.includes('seatgeek.com')) return 'seatgeek';
  if (f.includes('ticketclub.com')) return 'ticketclub';
  if (f.includes('vividseats.com')) return 'vividseats';
  return 'unknown';
}
