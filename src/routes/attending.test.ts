import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/d1';
import {
  attendedEvents,
  attendedEventPlayers,
  attendedEventTickets,
  players,
  venues,
} from '../db/schema/attending.js';
import { setupTestDb, createTestApiKey } from '../test-helpers.js';

describe('attending - Tier 1 filter additions', () => {
  let token: string;

  beforeAll(async () => {
    await setupTestDb();
    token = await createTestApiKey({
      name: 'attending-tier1-test',
      scope: 'read',
    });
  });

  beforeEach(async () => {
    const db = drizzle(env.DB);
    await db.delete(attendedEventTickets);
    await db.delete(attendedEventPlayers);
    await db.delete(attendedEvents);
    await db.delete(players);
    await db.delete(venues);
  });

  describe('GET /v1/attending/events?team=...', () => {
    async function seedThreeGames() {
      const db = drizzle(env.DB);
      const now = new Date().toISOString();
      // Mariners home vs Rangers
      await db.insert(attendedEvents).values({
        userId: 1,
        category: 'sports',
        eventType: 'mlb_game',
        eventDate: '2025-04-19',
        title: 'Texas Rangers at Seattle Mariners',
        eventData: JSON.stringify({
          league: 'mlb',
          season: 2025,
          home_team: { id: 136, name: 'Seattle Mariners' },
          away_team: { id: 140, name: 'Texas Rangers' },
        }),
        attended: 1,
        createdAt: now,
        updatedAt: now,
      });
      // Mariners away at Yankees
      await db.insert(attendedEvents).values({
        userId: 1,
        category: 'sports',
        eventType: 'mlb_game',
        eventDate: '2025-05-10',
        title: 'Seattle Mariners at New York Yankees',
        eventData: JSON.stringify({
          league: 'mlb',
          season: 2025,
          home_team: { id: 147, name: 'New York Yankees' },
          away_team: { id: 136, name: 'Seattle Mariners' },
        }),
        attended: 1,
        createdAt: now,
        updatedAt: now,
      });
      // Huskies game (no Mariners)
      await db.insert(attendedEvents).values({
        userId: 1,
        category: 'sports',
        eventType: 'ncaaf_game',
        eventDate: '2025-09-20',
        title: 'Oregon at Washington',
        eventData: JSON.stringify({
          league: 'ncaaf',
          season: 2025,
          home_team: { id: 264, name: 'Washington Huskies' },
          away_team: { id: 2483, name: 'Oregon Ducks' },
        }),
        attended: 1,
        createdAt: now,
        updatedAt: now,
      });
    }

    it('team substring matches both home and away appearances', async () => {
      await seedThreeGames();
      const res = await SELF.fetch(
        'https://test/v1/attending/events?team=mariners&limit=10',
        { headers: { Authorization: `Bearer ${token}` } }
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: Array<{ title: string }> };
      expect(body.data).toHaveLength(2);
      const titles = body.data.map((e) => e.title).sort();
      expect(titles).toEqual([
        'Seattle Mariners at New York Yankees',
        'Texas Rangers at Seattle Mariners',
      ]);
    });

    it('team substring is case-insensitive', async () => {
      await seedThreeGames();
      const res = await SELF.fetch(
        'https://test/v1/attending/events?team=MARINERS',
        { headers: { Authorization: `Bearer ${token}` } }
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: unknown[] };
      expect(body.data).toHaveLength(2);
    });

    it('team substring matches across leagues', async () => {
      await seedThreeGames();
      const res = await SELF.fetch(
        'https://test/v1/attending/events?team=washington',
        { headers: { Authorization: `Bearer ${token}` } }
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: Array<{ title: string }> };
      expect(body.data).toHaveLength(1);
      expect(body.data[0].title).toBe('Oregon at Washington');
    });

    it('team_id matches the integer id on either side', async () => {
      await seedThreeGames();
      const res = await SELF.fetch(
        'https://test/v1/attending/events?team_id=136',
        { headers: { Authorization: `Bearer ${token}` } }
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: unknown[] };
      expect(body.data).toHaveLength(2);
    });

    it('team filter combines with other filters', async () => {
      await seedThreeGames();
      const res = await SELF.fetch(
        'https://test/v1/attending/events?team=mariners&event_type=mlb_game&season=2025',
        { headers: { Authorization: `Bearer ${token}` } }
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: unknown[] };
      expect(body.data).toHaveLength(2);
    });

    it('team filter returns empty when no match', async () => {
      await seedThreeGames();
      const res = await SELF.fetch(
        'https://test/v1/attending/events?team=dodgers',
        { headers: { Authorization: `Bearer ${token}` } }
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: unknown[] };
      expect(body.data).toHaveLength(0);
    });
  });

  describe('GET /v1/attending/players?name=...', () => {
    async function seedThreePlayers() {
      const db = drizzle(env.DB);
      const now = new Date().toISOString();
      await db.insert(players).values([
        {
          userId: 1,
          league: 'mlb',
          fullName: 'Julio Rodríguez',
          firstName: 'Julio',
          lastName: 'Rodríguez',
          primaryPosition: 'CF',
          primaryTeamId: 136,
          createdAt: now,
          updatedAt: now,
        },
        {
          userId: 1,
          league: 'mlb',
          fullName: 'Will Smith',
          firstName: 'Will',
          lastName: 'Smith',
          primaryPosition: 'C',
          primaryTeamId: 119,
          createdAt: now,
          updatedAt: now,
        },
        {
          userId: 1,
          league: 'mlb',
          fullName: 'Will Smith',
          firstName: 'Will',
          lastName: 'Smith',
          primaryPosition: 'P',
          primaryTeamId: 137,
          createdAt: now,
          updatedAt: now,
        },
      ]);
    }

    it('name substring is case-insensitive', async () => {
      await seedThreePlayers();
      const res = await SELF.fetch(
        'https://test/v1/attending/players?name=JULIO',
        { headers: { Authorization: `Bearer ${token}` } }
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: Array<{ full_name: string; primary_position: string | null }>;
      };
      expect(body.data).toHaveLength(1);
      expect(body.data[0].full_name).toBe('Julio Rodríguez');
    });

    it('name substring returns multiple hits with disambiguating fields', async () => {
      await seedThreePlayers();
      const res = await SELF.fetch(
        'https://test/v1/attending/players?name=will smith',
        { headers: { Authorization: `Bearer ${token}` } }
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: Array<{
          full_name: string;
          primary_position: string | null;
          primary_team: { id: number } | null;
        }>;
      };
      expect(body.data).toHaveLength(2);
      const positions = body.data.map((p) => p.primary_position).sort();
      expect(positions).toEqual(['C', 'P']);
    });

    it('combines with league filter', async () => {
      await seedThreePlayers();
      const res = await SELF.fetch(
        'https://test/v1/attending/players?name=julio&league=mlb',
        { headers: { Authorization: `Bearer ${token}` } }
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: unknown[] };
      expect(body.data).toHaveLength(1);
    });
  });

  describe('GET /v1/attending/players/{id}/stats', () => {
    it('returns 404 for unknown player', async () => {
      const res = await SELF.fetch(
        'https://test/v1/attending/players/999999/stats',
        { headers: { Authorization: `Bearer ${token}` } }
      );
      expect(res.status).toBe(404);
    });

    it('returns hitter stats with career scope by default', async () => {
      const db = drizzle(env.DB);
      const now = new Date().toISOString();
      const [player] = await db
        .insert(players)
        .values({
          userId: 1,
          league: 'mlb',
          fullName: 'Cal Raleigh',
          primaryPosition: 'C',
          primaryTeamId: 136,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      const [game] = await db
        .insert(attendedEvents)
        .values({
          userId: 1,
          category: 'sports',
          eventType: 'mlb_game',
          eventDate: '2025-04-01',
          title: 'g',
          eventData: JSON.stringify({ season: 2025 }),
          attended: 1,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      await db.insert(attendedEventPlayers).values({
        userId: 1,
        eventId: game.id,
        playerId: player.id,
        teamId: 136,
        isHome: 1,
        battingLine: JSON.stringify({
          ab: 4,
          h: 2,
          hr: 1,
          rbi: 2,
          bb: 0,
          k: 0,
          pa: 4,
          total_bases: 5,
          doubles: 0,
          triples: 0,
          sb: 0,
          hbp: 0,
          r: 1,
        }),
        decision: null,
        notable: 1,
      });

      const res = await SELF.fetch(
        `https://test/v1/attending/players/${player.id}/stats`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        supported: boolean;
        scope: string;
        season?: number;
        batting?: { pa: number; avg: string };
      };
      expect(body.supported).toBe(true);
      expect(body.scope).toBe('career');
      expect(body.season).toBeUndefined();
      expect(body.batting?.pa).toBe(4);
      expect(body.batting?.avg).toBe('.500');
    });

    it('respects season query param', async () => {
      const db = drizzle(env.DB);
      const now = new Date().toISOString();
      const [player] = await db
        .insert(players)
        .values({
          userId: 1,
          league: 'mlb',
          fullName: 'JR',
          primaryPosition: 'CF',
          primaryTeamId: 136,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      const events = await db
        .insert(attendedEvents)
        .values([
          {
            userId: 1,
            category: 'sports',
            eventType: 'mlb_game',
            eventDate: '2024-06-01',
            title: '24',
            eventData: JSON.stringify({ season: 2024 }),
            attended: 1,
            createdAt: now,
            updatedAt: now,
          },
          {
            userId: 1,
            category: 'sports',
            eventType: 'mlb_game',
            eventDate: '2025-06-01',
            title: '25',
            eventData: JSON.stringify({ season: 2025 }),
            attended: 1,
            createdAt: now,
            updatedAt: now,
          },
        ])
        .returning();
      for (const e of events) {
        await db.insert(attendedEventPlayers).values({
          userId: 1,
          eventId: e.id,
          playerId: player.id,
          teamId: 136,
          isHome: 1,
          battingLine: JSON.stringify({
            ab: 4,
            h: 1,
            hr: 0,
            rbi: 0,
            bb: 0,
            k: 0,
            pa: 4,
            total_bases: 1,
            doubles: 0,
            triples: 0,
            sb: 0,
            hbp: 0,
            r: 0,
          }),
          decision: null,
          notable: 0,
        });
      }
      const res = await SELF.fetch(
        `https://test/v1/attending/players/${player.id}/stats?season=2025`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        scope: string;
        season: number;
        games: number;
      };
      expect(body.scope).toBe('season');
      expect(body.season).toBe(2025);
      expect(body.games).toBe(1);
    });

    it('returns supported:false for non-MLB players with appearance summaries', async () => {
      const db = drizzle(env.DB);
      const now = new Date().toISOString();
      const [player] = await db
        .insert(players)
        .values({
          userId: 1,
          league: 'ncaaf',
          fullName: 'Husky QB',
          primaryPosition: 'QB',
          primaryTeamId: 264,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      const [event] = await db
        .insert(attendedEvents)
        .values({
          userId: 1,
          category: 'sports',
          eventType: 'ncaaf_game',
          eventDate: '2025-09-20',
          title: 'Oregon at Washington',
          eventData: JSON.stringify({
            season: 2025,
            home_team: { id: 264, name: 'Washington Huskies' },
            away_team: { id: 2483, name: 'Oregon Ducks' },
            home_score: 14,
            away_score: 26,
            my_team_won: false,
          }),
          attended: 1,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      await db.insert(attendedEventPlayers).values({
        userId: 1,
        eventId: event.id,
        playerId: player.id,
        teamId: 264,
        isHome: 1,
        decision: null,
        notable: 0,
      });

      const res = await SELF.fetch(
        `https://test/v1/attending/players/${player.id}/stats`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        supported: boolean;
        league: string;
        appearances: Array<{ final_score: string | null }>;
      };
      expect(body.supported).toBe(false);
      expect(body.league).toBe('ncaaf');
      expect(body.appearances).toHaveLength(1);
      expect(body.appearances[0].final_score).toBe('14-26');
    });
  });

  describe('GET /v1/attending/seasons/{league}/{season}', () => {
    it('returns each game with its tickets', async () => {
      const db = drizzle(env.DB);
      const now = new Date().toISOString();
      const [game] = await db
        .insert(attendedEvents)
        .values({
          userId: 1,
          category: 'sports',
          eventType: 'mlb_game',
          eventDate: '2026-05-16',
          title: 'Seattle Mariners vs San Diego Padres',
          eventData: JSON.stringify({
            league: 'mlb',
            season: 2026,
            home_team: { id: 136, name: 'Seattle Mariners' },
            away_team: { id: 135, name: 'San Diego Padres' },
            my_team_won: false,
          }),
          attended: 1,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: attendedEvents.id });
      await db.insert(attendedEventTickets).values({
        userId: 1,
        eventId: game.id,
        vendor: 'seatgeek',
        orderId: '6P2-TEST',
        section: '111',
        row: '39',
        seat: '3',
        sourceType: 'gmail',
        createdAt: now,
      });

      const res = await SELF.fetch(
        'https://test/v1/attending/seasons/mlb/2026',
        { headers: { Authorization: `Bearer ${token}` } }
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: Array<{
          tickets: Array<{ section: string; row: string; seat: string }>;
        }>;
      };
      expect(body.data).toHaveLength(1);
      expect(body.data[0].tickets).toMatchObject([
        { section: '111', row: '39', seat: '3' },
      ]);
    });
  });
});
