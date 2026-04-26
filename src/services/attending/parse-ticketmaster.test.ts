import { describe, it, expect } from 'vitest';
import {
  parseTicketmasterHtml,
  parseTicketmasterDate,
} from './parse-ticketmaster.js';

const LEGACY_TM_HTML = `
<html><body>
<p>Ticketmaster</p>
<p>Thanks Patrick, here's your order info.</p>
<p>4 General Admission ticket(s) in Section GENADM</p>
<p>RÜFÜS DU SOL</p>
<p>Bill Graham Civic Auditorium, San Francisco, CA</p>
<p>Tue, Nov 06 2018 - 8:00 PM</p>
<p>Confirmation Number</p>
<p>92-44135/NCA</p>
<p>Order Summary</p>
<p>$228.20</p>
</body></html>
`;

const MODERN_TM_HTML = `
<html><body>
<p>Ticketmaster</p>
<p>You Got the Tickets!</p>
<p>Order # 44-56099/SEA</p>
<p>Seattle Mariners vs. Minnesota Twins</p>
<p>Thu &bull; May 16 2019 &bull; 7:10 PM</p>
<p>T-Mobile Park, Seattle, WA</p>
</body></html>
`;

describe('parseTicketmasterHtml', () => {
  it('returns null without an order anchor', () => {
    expect(parseTicketmasterHtml('<p>Hello</p>')).toBeNull();
    expect(parseTicketmasterHtml(null)).toBeNull();
  });

  it('parses legacy 2018 RÜFÜS DU SOL confirmation', () => {
    const result = parseTicketmasterHtml(LEGACY_TM_HTML);
    expect(result).not.toBeNull();
    expect(result![0]).toMatchObject({
      vendor: 'ticketmaster',
      reservation_number: '92-44135/NCA',
      event_name: 'RÜFÜS DU SOL',
      event_start: '2018-11-06T20:00',
      venue_name: 'Bill Graham Civic Auditorium',
      section: 'GENADM',
      total_price_cents: 22820,
    });
  });

  it('parses modern Mariners 2019 confirmation', () => {
    const result = parseTicketmasterHtml(MODERN_TM_HTML);
    expect(result).not.toBeNull();
    expect(result![0]).toMatchObject({
      vendor: 'ticketmaster',
      reservation_number: '44-56099/SEA',
      event_name: 'Seattle Mariners vs. Minnesota Twins',
      event_start: '2019-05-16T19:10',
      venue_name: 'T-Mobile Park',
    });
  });
});

describe('parseTicketmasterDate', () => {
  it.each([
    ['Tue, Nov 06 2018 - 8:00 PM', '2018-11-06T20:00'],
    ['Thu • May 16 2019 • 7:10 PM', '2019-05-16T19:10'],
    ['Sat, Jan 1 2022 - 12:00 PM', '2022-01-01T12:00'],
    ['Friday, Mar 15 2024 - 6:30 PM', '2024-03-15T18:30'],
  ] as const)('parses "%s" → "%s"', (input, expected) => {
    expect(parseTicketmasterDate(input)).toBe(expected);
  });

  it('returns null on unparseable strings', () => {
    expect(parseTicketmasterDate('Some venue')).toBeNull();
  });
});
