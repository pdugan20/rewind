// Calendar event allowlist for the attending-domain extractor.
// A calendar event matches if either its summary OR its location contains
// any of these keywords (case-insensitive substring). The match is broad
// on purpose — false positives get filtered later (no MLB game on that
// date → candidate dropped); false negatives mean a missed event.
//
// Vendor sender allowlist for the Gmail extractor lives in `VENDOR_SENDERS`.

// Team / event identifiers — match the summary line of a calendar entry.
// Keep entries lowercased for cheap substring comparison; the matcher
// lowercases the input.
export const TEAM_KEYWORDS = [
  // Seattle pro
  'mariners',
  'seahawks',
  'storm',
  'sounders',
  'kraken',
  // UW college
  'huskies',
  'uw football',
  'uw basketball',
  'washington huskies',
  // Concert/show keywords (catches calendar entries like "X at the Showbox")
  // — venue keywords below catch most of these too, but the `at <venue>`
  // shorthand is common enough to call out.
  'concert',
  'show at ',
] as const;

// Venue identifiers — match the location field. Aliases (Safeco Field,
// KeyArena, CenturyLink Field) are first-class because old calendar
// entries use the historical names.
export const VENUE_KEYWORDS = [
  // Mariners
  't-mobile park',
  'safeco field',
  // Storm, Kraken
  'climate pledge arena',
  'keyarena',
  // Seahawks, Sounders
  'lumen field',
  'centurylink field',
  'qwest field',
  // UW football
  'husky stadium',
  'alaska airlines field',
  // UW basketball
  'alaska airlines arena',
  'hec edmundson',
  'hec ed',
  // Music + theater
  'showbox',
  'paramount theatre',
  'moore theatre',
  'neumos',
  'neptune theatre',
  'crocodile',
  'sunset tavern',
  'tractor tavern',
] as const;

// Gmail "from:" allowlist — built into the Gmail query string by the
// extractor. Each entry is the literal email address the vendor uses for
// confirmations. Multiple entries per vendor are common — order doesn't
// matter; Gmail's `from:(a OR b)` handles them.
export const VENDOR_SENDERS = [
  // Ticketmaster
  'noreply@ticketmaster.com',
  'customer_support@email.ticketmaster.com',
  // SeatGeek
  'noreply@seatgeek.com',
  'orders@seatgeek.com',
  'hi@seatgeek.com',
  // TicketClub
  'info@ticketclub.com',
  'orders@ticketclub.com',
  // AXS
  'customer.service@axs.com',
  'tickets@axs.com',
  // StubHub
  'customerservice@stubhub.com',
  'noreply@stubhub.com',
  // VividSeats
  'orders@vividseats.com',
  'customerservice@vividseats.com',
] as const;

/**
 * Returns true if either field contains any allowlisted keyword.
 * Empty/null inputs both return false. Case-insensitive.
 */
export function matchesAllowlist(
  summary: string | null,
  location: string | null
): boolean {
  const s = (summary ?? '').toLowerCase();
  const l = (location ?? '').toLowerCase();
  if (!s && !l) return false;
  for (const kw of TEAM_KEYWORDS) {
    if (s.includes(kw) || l.includes(kw)) return true;
  }
  for (const kw of VENUE_KEYWORDS) {
    if (s.includes(kw) || l.includes(kw)) return true;
  }
  return false;
}

/**
 * Returns the Gmail query string fragment for the vendor allowlist.
 * Combine with `newer_than:` / `older_than:` filters at call sites.
 */
export function buildGmailVendorQuery(): string {
  const senders = VENDOR_SENDERS.map((s) => s).join(' OR ');
  return `from:(${senders})`;
}
