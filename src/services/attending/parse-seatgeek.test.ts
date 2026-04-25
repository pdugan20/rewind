import { describe, it, expect } from 'vitest';
import { parseSeatGeekText } from './parse-seatgeek.js';

// Real SeatGeek confirmation body shape, extracted from the user's
// inbox during the Phase 3 reality-check pass. Trimmed to the
// "Order Details" block + total. The full email is much longer
// (~30k chars) but the structured fields we care about are all here.
const REAL_SEATGEEK_BODY = `You're good to go, view ticket instructions and event details inside.

Hi Patrick,

It's almost time for the big game! Your Texas Rangers at Seattle Mariners
tickets are ready and available in the SeatGeek app.

Order Details

Order number
6P2-8YP454J
Sale date
Sat, Apr 18, 2026 at 1:20pm
Event
Texas Rangers at Seattle Mariners
T-Mobile Park, Seattle, WA
Sun, Apr 19 at 1:10pm
Quantity
3 tickets

Section
183
Row
12
Seats
18,19,20

Tickets $51.00
Fees $21.90
Total US $72.90
`;

describe('parseSeatGeekText', () => {
  it('returns null for non-confirmation text', () => {
    expect(parseSeatGeekText('Just a marketing email about deals')).toBeNull();
    expect(parseSeatGeekText('')).toBeNull();
    expect(parseSeatGeekText(null)).toBeNull();
    expect(parseSeatGeekText(undefined)).toBeNull();
  });

  it('parses the real Mariners confirmation: 3 seats expanded', () => {
    const result = parseSeatGeekText(REAL_SEATGEEK_BODY);
    expect(result).not.toBeNull();
    expect(result).toHaveLength(3);
    expect(result![0]).toMatchObject({
      vendor: 'seatgeek',
      reservation_number: '6P2-8YP454J',
      event_name: 'Texas Rangers at Seattle Mariners',
      venue_name: 'T-Mobile Park',
      section: '183',
      row: '12',
      total_price_cents: 7290,
      currency: 'USD',
    });
    expect(result!.map((r) => r.seat)).toEqual(['18', '19', '20']);
    expect(result![0].venue_address).toContain('Seattle');
    expect(result![0].venue_address).toContain('WA');
    // Event start gets a partial ISO without offset (SeatGeek text
    // doesn't include TZ).
    expect(result![0].event_start).toMatch(/^\d{2}-\d{2}T13:10$/);
  });

  it('parses single-seat without expansion error', () => {
    const single = REAL_SEATGEEK_BODY.replace('18,19,20', '42').replace(
      '3 tickets',
      '1 ticket'
    );
    const result = parseSeatGeekText(single);
    expect(result).toHaveLength(1);
    expect(result![0].seat).toBe('42');
  });

  it('handles dates with year', () => {
    const body = REAL_SEATGEEK_BODY.replace(
      'Sun, Apr 19 at 1:10pm',
      'Sun, Apr 19, 2026 at 1:10pm'
    );
    const result = parseSeatGeekText(body);
    expect(result![0].event_start).toBe('2026-04-19T13:10');
  });

  it('captures total even with comma-separated dollar amounts', () => {
    const body = REAL_SEATGEEK_BODY.replace(
      'Total US $72.90',
      'Total US $1,250.00'
    );
    const result = parseSeatGeekText(body);
    expect(result![0].total_price_cents).toBe(125000);
  });
});
