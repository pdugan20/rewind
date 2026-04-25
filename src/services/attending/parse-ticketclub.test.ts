import { describe, it, expect } from 'vitest';
import {
  parseTicketClubHtml,
  parseTicketClubDate,
  stripToText,
} from './parse-ticketclub.js';

// Real Ticket Club confirmation body shape (anonymized + trimmed),
// extracted from the user's inbox during Phase 3.5 validation.
const REAL_TC_HTML = `
<html>
  <head><style>.foo{color:red}</style></head>
  <body>
    <h1>Ticket Club - Ticket Order Information (#28437690)</h1>
    <p>Your Receipt for California Golden Bears vs. Washington Huskies</p>
    <h2>Order Summary</h2>
    <p>Order #28437690</p>
    <p>Order Date: 10/2/2018</p>
    <table>
      <tr><th>Event</th></tr>
      <tr><td>California Golden Bears vs. Washington Huskies</td></tr>
      <tr><td>Saturday, Oct 27 2018 at Time TBD</td></tr>
      <tr><td>Memorial Stadium - CA, Berkeley, CA</td></tr>
      <tr><th>Section</th></tr>
      <tr><td>Reserved UU</td></tr>
      <tr><th>Row</th></tr>
      <tr><td>24</td></tr>
      <tr><th>Qty</th></tr>
      <tr><td>7</td></tr>
    </table>
    <p>Tickets: 7 x $36</p>
    <p>Order Total: $252.00</p>
  </body>
</html>
`;

describe('parseTicketClubHtml', () => {
  it('returns null for non-confirmation HTML', () => {
    expect(parseTicketClubHtml(null)).toBeNull();
    expect(parseTicketClubHtml('<p>Welcome!</p>')).toBeNull();
    expect(parseTicketClubHtml(undefined)).toBeNull();
  });

  it('parses the real Cal/UW 2018 confirmation', () => {
    const result = parseTicketClubHtml(REAL_TC_HTML);
    expect(result).not.toBeNull();
    expect(result).toHaveLength(1);
    expect(result![0]).toMatchObject({
      vendor: 'ticketclub',
      reservation_number: '28437690',
      event_name: 'California Golden Bears vs. Washington Huskies',
      event_start: '2018-10-27', // date-only because Time TBD
      venue_name: 'Memorial Stadium',
      section: 'Reserved UU',
      row: '24',
      total_price_cents: 25200,
      currency: 'USD',
    });
    expect(result![0].venue_address).toContain('Berkeley');
  });

  it('parses event_start with time when not TBD', () => {
    const html = REAL_TC_HTML.replace(
      'Saturday, Oct 27 2018 at Time TBD',
      'Saturday, Oct 27 2018 at 7:30 PM'
    );
    const result = parseTicketClubHtml(html);
    expect(result![0].event_start).toBe('2018-10-27T19:30');
  });

  it('handles HTML entities in body', () => {
    const html = REAL_TC_HTML.replace('UU', 'A&amp;B');
    const result = parseTicketClubHtml(html);
    expect(result![0].section).toBe('Reserved A&B');
  });
});

// Real modern Ticket Club body (~2025 Mariners format)
const MODERN_TC_HTML = `
<html>
<body>
<p>Order #50755797 — Sep 12 2025 4:06PM</p>
<p>Seattle Mariners vs. Los Angeles Angels</p>
<p>T-Mobile Park</p>
<p>Sunday, Sep 14 2025 @ 1:10PM in Seattle, Washington</p>
<p>Section: Main 107 • Row: 30 • Qty: 5</p>
</body>
</html>
`;

describe('modern Ticket Club layout', () => {
  it('parses inline Section/Row/Qty + @ date separator', () => {
    const result = parseTicketClubHtml(MODERN_TC_HTML);
    expect(result).not.toBeNull();
    expect(result![0]).toMatchObject({
      vendor: 'ticketclub',
      reservation_number: '50755797',
      event_name: 'Seattle Mariners vs. Los Angeles Angels',
      event_start: '2025-09-14T13:10',
      venue_name: 'T-Mobile Park',
      section: 'Main 107',
      row: '30',
    });
  });
});

describe('parseTicketClubDate', () => {
  it.each([
    ['Saturday, Oct 27 2018 at Time TBD', '2018-10-27'],
    ['Saturday, Oct 27 2018 at 7:00 PM', '2018-10-27T19:00'],
    ['Sunday, Apr 19 2026 at 1:10 PM', '2026-04-19T13:10'],
    ['Friday, Jul 4 2025 at 12:00 AM', '2025-07-04T00:00'],
    ['Saturday, Dec 31 2022 at 12:00 PM', '2022-12-31T12:00'],
    // Without weekday prefix
    ['Oct 27 2018 at 7:30 PM', '2018-10-27T19:30'],
    // Modern @ separator
    ['Sunday, Sep 14 2025 @ 1:10PM', '2025-09-14T13:10'],
    // With trailing "in City, State"
    ['Sunday, Sep 14 2025 @ 1:10PM in Seattle, Washington', '2025-09-14T13:10'],
  ] as const)('parses "%s" → "%s"', (input, expected) => {
    expect(parseTicketClubDate(input)).toBe(expected);
  });

  it('returns null for unparseable strings', () => {
    expect(parseTicketClubDate('Just some text')).toBeNull();
    expect(parseTicketClubDate('Memorial Stadium, Berkeley')).toBeNull();
  });
});

describe('stripToText', () => {
  it('removes style + script + tags', () => {
    const html = `<style>.x{color:red}</style><p>Hello</p><script>alert(1)</script><div>World</div>`;
    expect(stripToText(html)).toContain('Hello');
    expect(stripToText(html)).toContain('World');
    expect(stripToText(html)).not.toContain('color');
    expect(stripToText(html)).not.toContain('alert');
  });
});
