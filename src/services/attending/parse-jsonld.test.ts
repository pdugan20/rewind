import { describe, it, expect } from 'vitest';
import {
  parseEventReservationFromHtml,
  inferVendorFromSender,
} from './parse-jsonld.js';

function jsonLdScript(payload: unknown): string {
  return `<script type="application/ld+json">${JSON.stringify(payload)}</script>`;
}

describe('parseEventReservationFromHtml', () => {
  it('returns null when there are no JSON-LD blocks at all', () => {
    expect(
      parseEventReservationFromHtml('<html><body>Hello</body></html>')
    ).toBeNull();
  });

  it('returns [] when JSON-LD blocks exist but no EventReservation', () => {
    const html = jsonLdScript({
      '@context': 'https://schema.org',
      '@type': 'WebSite',
      name: 'Example',
    });
    expect(parseEventReservationFromHtml(html)).toEqual([]);
  });

  it('extracts a single-seat Ticketmaster reservation', () => {
    const ld = {
      '@context': 'https://schema.org',
      '@type': 'EventReservation',
      reservationNumber: 'TM-12345',
      reservationFor: {
        '@type': 'Event',
        name: 'Mariners vs Astros',
        startDate: '2024-06-15T19:10:00-07:00',
        location: {
          '@type': 'Place',
          name: 'T-Mobile Park',
          address: {
            '@type': 'PostalAddress',
            streetAddress: '1250 1st Ave S',
            addressLocality: 'Seattle',
            addressRegion: 'WA',
            postalCode: '98134',
          },
        },
      },
      reservedTicket: {
        '@type': 'Ticket',
        ticketedSeat: {
          '@type': 'Seat',
          seatSection: '124',
          seatRow: '12',
          seatNumber: '8',
        },
      },
      totalPrice: '85.50',
      priceCurrency: 'USD',
    };
    const result = parseEventReservationFromHtml(
      `<html><body>${jsonLdScript(ld)}</body></html>`,
      'ticketmaster'
    );
    expect(result).toHaveLength(1);
    expect(result![0]).toMatchObject({
      vendor: 'ticketmaster',
      reservation_number: 'TM-12345',
      event_name: 'Mariners vs Astros',
      event_start: '2024-06-15T19:10:00-07:00',
      venue_name: 'T-Mobile Park',
      section: '124',
      row: '12',
      seat: '8',
      total_price_cents: 8550,
      currency: 'USD',
    });
    expect(result![0].venue_address).toContain('Seattle');
    expect(result![0].venue_address).toContain('WA');
  });

  it('expands SeatGeek-style multi-seat reservedTicket array', () => {
    const ld = {
      '@type': 'EventReservation',
      reservationNumber: '6P2-8YP454J',
      reservationFor: {
        '@type': 'Event',
        name: 'Texas Rangers at Seattle Mariners',
        startDate: '2026-04-19T13:10:00-07:00',
        location: { '@type': 'Place', name: 'T-Mobile Park' },
      },
      reservedTicket: [
        {
          ticketedSeat: { seatSection: '147', seatRow: 'C', seatNumber: '18' },
        },
        {
          ticketedSeat: { seatSection: '147', seatRow: 'C', seatNumber: '19' },
        },
        {
          ticketedSeat: { seatSection: '147', seatRow: 'C', seatNumber: '20' },
        },
      ],
      totalPrice: 240,
      priceCurrency: 'USD',
    };
    const result = parseEventReservationFromHtml(jsonLdScript(ld), 'seatgeek');
    expect(result).toHaveLength(3);
    expect(result!.map((r) => r.seat)).toEqual(['18', '19', '20']);
    // Total price stays per-reservation (not divided per seat).
    expect(result![0].total_price_cents).toBe(24000);
    expect(result![0].reservation_number).toBe('6P2-8YP454J');
  });

  it('AXS Mobile Entry seatNumber maps to null', () => {
    const ld = {
      '@type': 'EventReservation',
      reservationNumber: 'AXS-99',
      reservationFor: {
        name: 'Phoebe Bridgers',
        startDate: '2024-03-12T20:00:00-07:00',
        location: { name: 'Climate Pledge Arena' },
      },
      reservedTicket: {
        ticketedSeat: { seatSection: 'GA', seatNumber: 'Mobile Entry' },
      },
      totalPrice: '120.00',
    };
    const result = parseEventReservationFromHtml(jsonLdScript(ld), 'axs');
    expect(result![0].seat).toBeNull();
    expect(result![0].section).toBe('GA');
    expect(result![0].currency).toBe('USD'); // default
  });

  it('handles @graph-wrapped payload', () => {
    const ld = {
      '@context': 'https://schema.org',
      '@graph': [
        { '@type': 'WebPage', name: 'Confirmation' },
        {
          '@type': 'EventReservation',
          reservationNumber: 'GRAPH-1',
          reservationFor: {
            name: 'Show',
            startDate: '2024-01-01T20:00:00Z',
            location: { name: 'Venue' },
          },
          reservedTicket: { ticketedSeat: { seatSection: 'A' } },
        },
      ],
    };
    const result = parseEventReservationFromHtml(jsonLdScript(ld));
    expect(result).toHaveLength(1);
    expect(result![0].reservation_number).toBe('GRAPH-1');
  });

  it('handles array-rooted payload', () => {
    const ld = [
      { '@type': 'Organization', name: 'Vendor' },
      {
        '@type': 'EventReservation',
        reservationNumber: 'ARR-1',
        reservationFor: { name: 'Game', location: { name: 'Park' } },
        reservedTicket: { ticketedSeat: {} },
      },
    ];
    const result = parseEventReservationFromHtml(jsonLdScript(ld));
    expect(result).toHaveLength(1);
    expect(result![0].reservation_number).toBe('ARR-1');
  });

  it('skips malformed JSON blocks without throwing', () => {
    const valid = jsonLdScript({
      '@type': 'EventReservation',
      reservationNumber: 'VALID',
      reservationFor: { name: 'X', location: { name: 'Y' } },
      reservedTicket: { ticketedSeat: {} },
    });
    const broken =
      '<script type="application/ld+json">{not valid json}</script>';
    const html = `<html><body>${broken}${valid}</body></html>`;
    const result = parseEventReservationFromHtml(html);
    expect(result).toHaveLength(1);
    expect(result![0].reservation_number).toBe('VALID');
  });

  it('extracts multiple separate EventReservations (TM/AXS one-per-seat pattern)', () => {
    const html =
      jsonLdScript({
        '@type': 'EventReservation',
        reservationNumber: 'TM-A',
        reservationFor: {
          name: 'Game',
          startDate: '2024-08-01T19:00:00-07:00',
          location: { name: 'Park' },
        },
        reservedTicket: {
          ticketedSeat: { seatSection: '101', seatNumber: '1' },
        },
      }) +
      jsonLdScript({
        '@type': 'EventReservation',
        reservationNumber: 'TM-B',
        reservationFor: {
          name: 'Game',
          startDate: '2024-08-01T19:00:00-07:00',
          location: { name: 'Park' },
        },
        reservedTicket: {
          ticketedSeat: { seatSection: '101', seatNumber: '2' },
        },
      });
    const result = parseEventReservationFromHtml(html, 'ticketmaster');
    expect(result).toHaveLength(2);
    expect(result!.map((r) => r.seat)).toEqual(['1', '2']);
  });

  it('handles missing fields gracefully (only required = event_name)', () => {
    const ld = {
      '@type': 'EventReservation',
      reservationFor: { name: 'Bare Event' },
    };
    const result = parseEventReservationFromHtml(jsonLdScript(ld));
    expect(result).toHaveLength(1);
    expect(result![0].event_name).toBe('Bare Event');
    expect(result![0].reservation_number).toBeNull();
    expect(result![0].section).toBeNull();
    expect(result![0].total_price_cents).toBeNull();
    expect(result![0].currency).toBe('USD');
  });

  it('handles location.address as a plain string', () => {
    const ld = {
      '@type': 'EventReservation',
      reservationFor: {
        name: 'X',
        location: { name: 'Venue', address: '123 Main St, Seattle, WA' },
      },
    };
    const result = parseEventReservationFromHtml(jsonLdScript(ld));
    expect(result![0].venue_address).toBe('123 Main St, Seattle, WA');
  });

  it('handles numeric totalPrice', () => {
    const ld = {
      '@type': 'EventReservation',
      reservationFor: { name: 'X', location: { name: 'Y' } },
      totalPrice: 99.5,
    };
    const result = parseEventReservationFromHtml(jsonLdScript(ld));
    expect(result![0].total_price_cents).toBe(9950);
  });
});

describe('inferVendorFromSender', () => {
  it.each([
    ['noreply@ticketmaster.com', 'ticketmaster'],
    ['customer.service@axs.com', 'axs'],
    ['customerservice@stubhub.com', 'stubhub'],
    ['orders@seatgeek.com', 'seatgeek'],
    ['"SeatGeek" <hi@seatgeek.com>', 'seatgeek'],
    ['orders@vividseats.com', 'vividseats'],
    ['info@ticketclub.com', 'ticketclub'],
    ['random@example.com', 'unknown'],
    [undefined, 'unknown'],
  ] as const)('infers vendor from %s', (from, expected) => {
    expect(inferVendorFromSender(from)).toBe(expected);
  });
});
