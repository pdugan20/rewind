import { describe, it, expect } from 'vitest';
import { parseCalendarDescriptionTickets } from './parse-calendar-description.js';

describe('parseCalendarDescriptionTickets', () => {
  it('parses the real SeatGeek/Mariners pattern observed in Phase 2', () => {
    // The literal description body from the user's Mariners calendar event.
    const description = `Reservation Number: 6P2-8YP454J

Provider: SeatGeek

Guests: Patrick Dugan

Seats: 18, 19, 20`;
    const result = parseCalendarDescriptionTickets(description);
    expect(result).not.toBeNull();
    expect(result!.vendor).toBe('seatgeek');
    expect(result!.reservation_number).toBe('6P2-8YP454J');
    expect(result!.guests).toEqual(['Patrick Dugan']);
    expect(result!.seats).toEqual(['18', '19', '20']);
  });

  it('returns null for a plain calendar description with no ticket markers', () => {
    expect(parseCalendarDescriptionTickets('Lunch at the new spot')).toBeNull();
    expect(parseCalendarDescriptionTickets('')).toBeNull();
    expect(parseCalendarDescriptionTickets(null)).toBeNull();
    expect(parseCalendarDescriptionTickets(undefined)).toBeNull();
  });

  it('infers vendor for ticketmaster, axs, stubhub, vivid', () => {
    for (const [provider, vendor] of [
      ['Ticketmaster', 'ticketmaster'],
      ['AXS', 'axs'],
      ['StubHub', 'stubhub'],
      ['Vivid Seats', 'vividseats'],
    ] as const) {
      const desc = `Reservation Number: X\n\nProvider: ${provider}\n`;
      expect(parseCalendarDescriptionTickets(desc)?.vendor).toBe(vendor);
    }
  });

  it('falls through to unknown for unrecognized provider', () => {
    const desc = `Reservation Number: X\n\nProvider: SomeOtherCo\n`;
    expect(parseCalendarDescriptionTickets(desc)?.vendor).toBe('unknown');
  });

  it('parses Section + Row when present', () => {
    const desc = `Reservation Number: TM-1\n\nProvider: Ticketmaster\n\nSection: 124\n\nRow: 12\n\nSeats: 5, 6\n`;
    const result = parseCalendarDescriptionTickets(desc);
    expect(result?.section).toBe('124');
    expect(result?.row).toBe('12');
    expect(result?.seats).toEqual(['5', '6']);
  });

  it('parses total price with $ and currency hints', () => {
    expect(
      parseCalendarDescriptionTickets(
        'Reservation Number: X\n\nProvider: AXS\n\nOrder Total: $85.50\n'
      )?.total_price_cents
    ).toBe(8550);
    expect(
      parseCalendarDescriptionTickets(
        'Reservation Number: X\n\nProvider: AXS\n\nTotal: USD 240.00\n'
      )
    ).toMatchObject({ total_price_cents: 24000, currency: 'USD' });
  });

  it('returns null when neither Reservation Number nor Provider is present', () => {
    // Even if Seats field exists, without a vendor/reservation marker
    // we don't claim the description is a ticket payload — too easy to
    // false-positive on ad-hoc calendar entries.
    const desc = `Seats: 18, 19, 20\n\nGuests: Pat\n`;
    expect(parseCalendarDescriptionTickets(desc)).toBeNull();
  });

  it('handles single-seat (no comma)', () => {
    const desc = `Reservation Number: X\n\nProvider: SeatGeek\n\nSeats: 42\n`;
    expect(parseCalendarDescriptionTickets(desc)?.seats).toEqual(['42']);
  });

  it('handles multi-guest list', () => {
    const desc = `Reservation Number: X\n\nProvider: SeatGeek\n\nGuests: Pat Dugan, Friend Name, Other Person\n`;
    expect(parseCalendarDescriptionTickets(desc)?.guests).toEqual([
      'Pat Dugan',
      'Friend Name',
      'Other Person',
    ]);
  });
});
