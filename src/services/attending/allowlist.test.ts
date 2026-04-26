import { describe, it, expect } from 'vitest';
import {
  matchesAllowlist,
  buildGmailVendorQuery,
  TEAM_KEYWORDS,
  VENUE_KEYWORDS,
} from './allowlist.js';

describe('attending allowlist', () => {
  describe('matchesAllowlist', () => {
    it('matches Mariners game by summary', () => {
      expect(matchesAllowlist('Mariners vs Astros', 'T-Mobile Park')).toBe(
        true
      );
    });

    it('matches by venue alias (Safeco Field → match)', () => {
      expect(matchesAllowlist('Baseball game', 'Safeco Field')).toBe(true);
    });

    it('matches UW football at Husky Stadium', () => {
      expect(
        matchesAllowlist(
          'Huskies vs Oregon',
          'Alaska Airlines Field at Husky Stadium'
        )
      ).toBe(true);
    });

    it('matches UW basketball at Hec Ed shorthand', () => {
      expect(matchesAllowlist('UW basketball game', 'Hec Ed Pavilion')).toBe(
        true
      );
    });

    it('matches concert at Showbox', () => {
      expect(matchesAllowlist('Phoebe Bridgers', 'Showbox SoDo')).toBe(true);
    });

    it('matches when only venue field has a hit', () => {
      expect(matchesAllowlist(null, 'Climate Pledge Arena')).toBe(true);
    });

    it('matches when only summary field has a hit', () => {
      expect(matchesAllowlist('Sounders match', null)).toBe(true);
    });

    it('case-insensitive', () => {
      expect(matchesAllowlist('MARINERS!!', null)).toBe(true);
      expect(matchesAllowlist(null, 'CLIMATE PLEDGE ARENA')).toBe(true);
    });

    it('returns false for unrelated calendar entries', () => {
      expect(matchesAllowlist('Lunch with Jess', 'Cafe X')).toBe(false);
      expect(matchesAllowlist('Dentist appointment', null)).toBe(false);
      expect(matchesAllowlist('Project review meeting', 'WeWork')).toBe(false);
    });

    it('returns false for empty/null inputs', () => {
      expect(matchesAllowlist(null, null)).toBe(false);
      expect(matchesAllowlist('', '')).toBe(false);
    });

    it('does not match generic "park" — too broad to be safe', () => {
      // Sanity check that we don't have a 'park' keyword that would
      // false-positive on every other calendar entry.
      expect(matchesAllowlist('Walk in the park', null)).toBe(false);
    });

    // Coverage check: every keyword should produce a positive match when
    // exactly that string is in the summary.
    it.each(TEAM_KEYWORDS)('TEAM_KEYWORDS: %s matches as summary', (kw) => {
      expect(matchesAllowlist(kw, null)).toBe(true);
    });

    it.each(VENUE_KEYWORDS)('VENUE_KEYWORDS: %s matches as location', (kw) => {
      expect(matchesAllowlist(null, kw)).toBe(true);
    });
  });

  describe('buildGmailVendorQuery', () => {
    it('produces a from:() query covering all vendor domains', () => {
      const q = buildGmailVendorQuery();
      expect(q).toMatch(/^from:\(/);
      expect(q).toContain('@ticketmaster.com');
      expect(q).toContain('@seatgeek.com');
      expect(q).toContain('@axs.com');
      expect(q).toContain('@stubhub.com');
      expect(q).toContain('@vividseats.com');
      expect(q).toContain('@ticketclub.com');
      expect(q).toContain(' OR ');
    });
  });
});
