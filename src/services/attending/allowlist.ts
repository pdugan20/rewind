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

// Gmail "from:" allowlist — by DOMAIN, not specific addresses.
//
// Domain-level filters survive vendor address rotation (e.g.
// noreply@ticketmaster.com → orders@ticketmaster.com). The vendor would
// have to change its domain entirely to escape — much rarer than the
// address-level churn we'd otherwise have to chase. Tradeoff: domain
// filter also catches marketing/survey/transfer emails, but the
// subject-line gate (judgeSubject) filters those.
//
// Initial inbox-validation found that the actual confirmation senders
// often differ from what research suggests:
//   - SeatGeek: transactions@seatgeek.com (not orders@)
//   - AXS: axs@axs.com (not customer.service@)
//   - VividSeats: sales@vividseats.com (not orders@)
//   - TicketClub: customersupport@ticketclub.com (not info@)
// The domain filter sidesteps this entire class of misses.
const VENDOR_DOMAINS = [
  'ticketmaster.com',
  'seatgeek.com',
  'ticketclub.com',
  'axs.com',
  'stubhub.com',
  'vividseats.com',
  // Added Phase 9.5 deep-sweep — 66+ confirmations were sitting outside
  // the original 6-vendor allowlist (mostly tech meetups + smaller
  // concerts). Eventbrite covers that long tail in one parser.
  'eventbrite.com',
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
 *
 * Uses domain-level filters (`from:@<domain>`) so we don't have to
 * track specific sender addresses as vendors rotate them.
 */
export function buildGmailVendorQuery(): string {
  const domains = VENDOR_DOMAINS.map((d) => `@${d}`).join(' OR ');
  return `from:(${domains})`;
}
