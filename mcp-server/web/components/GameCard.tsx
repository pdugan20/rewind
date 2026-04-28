import { useState, type CSSProperties } from 'react';
import { thumbhashToDataUrl } from '../lib/thumbhash.js';
import { TeamLogo } from './TeamLogo.js';
import type { Photo, Team } from './types.js';

// Reuses the same shape conventions as SeasonGameCard. Kept self-contained
// rather than imported so this card can evolve independently as the
// inline-render needs diverge from the season-grid card.

export type { Photo };

export type LineScoreInning = {
  inning: number;
  // Nullable: a half-inning that wasn't played (typically bottom 9 when
  // the home team is already winning) comes back as null from the MLB
  // feed. The canonical baseball convention for that cell is "X".
  home_runs: number | null;
  away_runs: number | null;
  home_hits: number;
  away_hits: number;
  home_errors: number;
  away_errors: number;
};

export type Appearance = {
  player: {
    id: number;
    full_name: string;
    primary_position: string | null;
    primary_number: string | null;
    photo_silo: Photo;
  };
  team_id: number | null;
  is_home: boolean;
  batting_line: {
    summary?: string;
    pa?: number;
    h?: number;
    hr?: number;
  } | null;
  pitching_line: { summary?: string; ip?: string; k?: number } | null;
  decision: 'W' | 'L' | 'SV' | 'HLD' | 'BS' | null;
  notable: boolean;
};

export type EventDetail = {
  id: number;
  category: 'sports' | 'music' | 'arts';
  event_type: string;
  event_date: string;
  title: string;
  subtitle: string | null;
  attended: boolean;
  venue: { name: string; city: string | null } | null;
  event_data: {
    league?: string;
    home_team?: Team;
    away_team?: Team;
    home_score?: number;
    away_score?: number;
    my_team?: 'home' | 'away';
    my_team_won?: boolean;
    attendance?: number;
    weather?: { condition?: string; temp?: string; wind?: string };
    duration_minutes?: number;
    linescore?: LineScoreInning[];
  } | null;
  tickets: Array<{
    vendor: string;
    section: string | null;
    row: string | null;
    seat: string | null;
    quantity: number;
    total_price_cents: number | null;
    currency: string;
  }>;
  players?: Appearance[];
};

export function GameCard({ event }: { event: EventDetail }) {
  const ed = event.event_data ?? {};
  const home = ed.home_team;
  const away = ed.away_team;
  const homeScore = ed.home_score;
  const awayScore = ed.away_score;
  const hasScore = homeScore !== undefined && awayScore !== undefined;

  // Tiny dim "no-show" tag stays for the non-attended case so the user
  // can still tell at a glance — but the green W / red L for attended
  // sports games is handled by the score-emphasis (winning side stays
  // full-opacity, loser dims). No badge chip on the attended path.
  const showNoShowTag = !event.attended;

  const notable = (event.players ?? []).filter((p) => p.notable);

  return (
    <div style={cardStyle}>
      <header style={headerStyle}>
        <div style={headerLeftStyle}>
          <div style={dateStyle}>{formatLongDate(event.event_date)}</div>
          {event.venue && (
            <div style={venueStyle}>
              {event.venue.name}
              {event.venue.city ? ` · ${event.venue.city}` : ''}
            </div>
          )}
        </div>
        <div style={headerRightStyle}>
          {showNoShowTag ? (
            <span style={noShowTagStyle}>NO-SHOW</span>
          ) : (
            <>
              {ed.attendance && (
                <div style={metaTopStyle}>
                  {formatAttendance(ed.attendance)} fans
                </div>
              )}
              {(ed.weather || ed.duration_minutes) && (
                <div style={metaBottomStyle}>
                  {[
                    ed.weather ? formatWeather(ed.weather) : null,
                    ed.duration_minutes
                      ? formatDuration(ed.duration_minutes)
                      : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </div>
              )}
            </>
          )}
        </div>
      </header>

      {hasScore && home && away ? (
        <Scoreboard
          home={home}
          away={away}
          homeScore={homeScore}
          awayScore={awayScore}
          myTeam={ed.my_team}
        />
      ) : (
        <div style={titleStyle}>{event.title}</div>
      )}

      {ed.linescore && ed.linescore.length > 0 && (
        <Linescore innings={ed.linescore} home={home} away={away} />
      )}

      {notable.length > 0 && (
        <section style={notableSectionStyle}>
          <div style={sectionLabelStyle}>Notable performances</div>
          {notable.slice(0, 6).map((a) => (
            <PerformerRow key={a.player.id} appearance={a} />
          ))}
        </section>
      )}

      {event.tickets.length > 0 && <TicketBlock tickets={event.tickets} />}
    </div>
  );
}

function Scoreboard({
  home,
  away,
  homeScore,
  awayScore,
  myTeam,
}: {
  home: Team;
  away: Team;
  homeScore: number;
  awayScore: number;
  myTeam?: 'home' | 'away';
}) {
  return (
    <div style={scoreboardStyle}>
      <TeamScore
        team={away}
        score={awayScore}
        emphasized={myTeam === 'away'}
        won={awayScore > homeScore}
      />
      <div style={atSepStyle}>at</div>
      <TeamScore
        team={home}
        score={homeScore}
        emphasized={myTeam === 'home'}
        won={homeScore > awayScore}
      />
    </div>
  );
}

function TeamScore({
  team,
  score,
  emphasized,
  won,
}: {
  team: Team;
  score: number;
  emphasized: boolean;
  won: boolean;
}) {
  // Tint the team-name strip with the team's brand color when this is
  // "your" team or the winning side. Falls back to plain text when no
  // color seeded yet — see seedMlbTeams in the API service.
  const tint = team.ui_tint_color ?? team.primary_color ?? null;
  const useTint = tint && (emphasized || won);

  return (
    <div style={teamSlotStyle}>
      <TeamLogo team={team} size={36} variant="default" />
      <div
        style={{
          ...teamNameStyle,
          fontWeight: emphasized ? 600 : 500,
          opacity: emphasized ? 1 : 0.85,
          color: useTint ? tint : undefined,
        }}
      >
        {team.name}
      </div>
      <div
        style={{
          ...teamScoreStyle,
          color: won ? 'var(--color-text-primary, currentColor)' : undefined,
          opacity: won ? 1 : 0.55,
        }}
      >
        {score}
      </div>
    </div>
  );
}

function Linescore({
  innings,
  home,
  away,
}: {
  innings: LineScoreInning[];
  home?: Team;
  away?: Team;
}) {
  // Each row is one team. Per-inning runs only — full RHE summary lives on
  // the scoreboard above; this keeps the grid compact.
  const homeRuns = innings.map((i) => i.home_runs);
  const awayRuns = innings.map((i) => i.away_runs);

  return (
    <div style={linescoreScrollStyle}>
      <table style={linescoreTableStyle}>
        <thead>
          <tr>
            <th style={lineHeaderStyle}></th>
            {innings.map((i) => (
              <th key={i.inning} style={lineInningStyle}>
                {i.inning}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr>
            <td style={lineTeamCellStyle}>
              {away?.abbreviation ?? away?.name?.split(' ').pop() ?? 'AWAY'}
            </td>
            {awayRuns.map((r, i) => (
              <td key={i} style={lineCellStyle}>
                {r ?? 'X'}
              </td>
            ))}
          </tr>
          <tr>
            <td style={lineTeamCellStyle}>
              {home?.abbreviation ?? home?.name?.split(' ').pop() ?? 'HOME'}
            </td>
            {homeRuns.map((r, i) => (
              <td key={i} style={lineCellStyle}>
                {r ?? 'X'}
              </td>
            ))}
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function PerformerRow({ appearance }: { appearance: Appearance }) {
  const [loaded, setLoaded] = useState(false);
  const photo = appearance.player.photo_silo;
  const photoUrl = photo?.cdn_url ?? photo?.url ?? null;
  const placeholder = photo?.thumbhash
    ? thumbhashToDataUrl(photo.thumbhash)
    : null;
  // Match AthleteDetailA's portrait fill — neutral gray instead of
  // the per-photo dominant_color tint, so all the headshots in the
  // notable-performances strip read as one row.
  const photoBgColor = 'rgba(127,127,127,0.08)';

  // Prefer batting line summary, then pitching line summary, then bare name.
  const stat =
    appearance.batting_line?.summary ?? appearance.pitching_line?.summary ?? '';
  const decision = appearance.decision;
  const number = appearance.player.primary_number;
  const position = appearance.player.primary_position;

  return (
    <div style={performerRowStyle}>
      <div style={{ ...performerAvatarStyle, background: photoBgColor }}>
        {placeholder && (
          <img
            src={placeholder}
            alt=""
            aria-hidden
            style={{
              ...performerAvatarImgStyle,
              filter: 'blur(8px)',
              opacity: loaded ? 0 : 1,
            }}
          />
        )}
        {photoUrl && (
          <img
            src={photoUrl}
            alt=""
            loading="lazy"
            onLoad={() => setLoaded(true)}
            style={{
              ...performerAvatarImgStyle,
              opacity: loaded ? 1 : 0,
            }}
          />
        )}
      </div>
      <div style={performerNameStyle}>
        <div style={performerHeaderStyle}>
          <span style={performerNameLineStyle}>
            {appearance.player.full_name}
          </span>
          {stat && <span style={statLineStyle}>{stat}</span>}
        </div>
        <div style={performerSubStyle}>
          {[
            number ? `#${number}` : null,
            position,
            decision, // W/L/SV is just text now, alongside #/POS
          ]
            .filter(Boolean)
            .join(' · ')}
        </div>
      </div>
    </div>
  );
}

function TicketBlock({ tickets }: { tickets: EventDetail['tickets'] }) {
  // Multi-ticket: just summarize. Single-ticket: spell out section/row/seat.
  if (tickets.length === 1) {
    const t = tickets[0];
    const seatBits = [
      t.section ? `Sec ${t.section}` : null,
      t.row ? `Row ${t.row}` : null,
      t.seat ? `Seat ${t.seat}` : null,
    ].filter(Boolean);
    const price =
      t.total_price_cents != null
        ? formatPrice(t.total_price_cents, t.currency)
        : null;
    return (
      <div style={ticketBlockStyle}>
        <div style={sectionLabelStyle}>Ticket</div>
        <div style={ticketLineStyle}>
          {seatBits.length ? seatBits.join(' · ') : 'Seat unspecified'}
          {price && <span style={ticketPriceStyle}>{price}</span>}
        </div>
        <div style={ticketVendorStyle}>via {t.vendor}</div>
      </div>
    );
  }
  const totalQty = tickets.reduce((s, t) => s + t.quantity, 0);
  const totalCents = tickets.reduce(
    (s, t) => s + (t.total_price_cents ?? 0),
    0
  );
  const currency = tickets[0]?.currency ?? 'USD';
  return (
    <div style={ticketBlockStyle}>
      <div style={sectionLabelStyle}>Tickets</div>
      <div style={ticketLineStyle}>
        {totalQty} ticket{totalQty === 1 ? '' : 's'} across {tickets.length}{' '}
        order{tickets.length === 1 ? '' : 's'}
        {totalCents > 0 && (
          <span style={ticketPriceStyle}>
            {formatPrice(totalCents, currency)}
          </span>
        )}
      </div>
    </div>
  );
}

// ─── Formatters ─────────────────────────────────────────────────────

function formatLongDate(iso: string): string {
  const d = new Date(iso + 'T12:00:00Z');
  return d.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function formatAttendance(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}K`;
  return String(n);
}

function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function formatWeather(w: {
  condition?: string;
  temp?: string;
  wind?: string;
}): string | null {
  const parts = [];
  if (w.temp) parts.push(`${w.temp}°`);
  if (w.condition) parts.push(w.condition);
  return parts.length ? parts.join(' ') : null;
}

function formatPrice(cents: number, currency: string): string {
  const dollars = cents / 100;
  return `${currency === 'USD' ? '$' : currency + ' '}${dollars.toFixed(2)}`;
}

// ─── Styles ─────────────────────────────────────────────────────────

// Match AthleteDetailA's outer chrome — same border/radius/maxWidth/
// padding so the two attended-domain cards feel like one family.
// No drop shadow, no background fill — the iframe surface shows through.
const cardStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 18,
  maxWidth: 720,
  margin: '0 auto',
  padding: '20px 22px 22px',
  borderRadius: 12,
  border: '1px solid var(--color-border-tertiary, rgba(127,127,127,0.12))',
  background: 'var(--color-background-primary, transparent)',
  color: 'var(--color-text-primary, #1a1a1a)',
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
  fontSize: 14,
};

const headerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: 12,
};

const headerLeftStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  minWidth: 0,
};

const headerRightStyle: CSSProperties = {
  textAlign: 'right',
  minWidth: 0,
};

const dateStyle: CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  letterSpacing: '0.01em',
  color: 'var(--color-text-primary, inherit)',
};

const venueStyle: CSSProperties = {
  fontSize: 12,
  opacity: 0.7,
};

const noShowTagStyle: CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: 0.6,
  textTransform: 'uppercase',
  opacity: 0.55,
};

const titleStyle: CSSProperties = {
  fontSize: 17,
  fontWeight: 600,
  lineHeight: 1.25,
};

const scoreboardStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr auto 1fr',
  alignItems: 'center',
  gap: 12,
  padding: '14px 0 8px',
};

const teamSlotStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 6,
};

const teamNameStyle: CSSProperties = {
  fontSize: 13,
  textAlign: 'center',
  lineHeight: 1.2,
};

const teamScoreStyle: CSSProperties = {
  fontSize: 28,
  fontVariantNumeric: 'tabular-nums',
  fontWeight: 700,
  letterSpacing: '-0.02em',
};

const atSepStyle: CSSProperties = {
  fontSize: 11,
  textTransform: 'uppercase',
  opacity: 0.5,
  letterSpacing: '0.08em',
};

const linescoreScrollStyle: CSSProperties = {
  overflowX: 'auto',
  marginTop: -4,
  paddingBottom: 2,
};

const linescoreTableStyle: CSSProperties = {
  borderCollapse: 'collapse',
  fontSize: 12,
  fontVariantNumeric: 'tabular-nums',
  width: '100%',
};

const lineHeaderStyle: CSSProperties = {
  width: 36,
};

const lineInningStyle: CSSProperties = {
  fontSize: 10,
  opacity: 0.55,
  fontWeight: 500,
  textAlign: 'center',
  padding: '2px 4px',
  minWidth: 18,
};

const lineTeamCellStyle: CSSProperties = {
  fontSize: 11,
  opacity: 0.7,
  textAlign: 'left',
  padding: '2px 6px 2px 0',
  fontWeight: 600,
  letterSpacing: '0.04em',
};

const lineCellStyle: CSSProperties = {
  textAlign: 'center',
  padding: '2px 4px',
  borderTop: '1px solid rgba(127,127,127,0.12)',
};

// Right-column meta in the header — both lines render as the same
// dim secondary type so they read as one block of supporting context.
const metaBottomStyle: CSSProperties = {
  fontSize: 12,
  opacity: 0.7,
};

const metaTopStyle = metaBottomStyle;

// Match AthleteDetailA's sectionHeaderStyle so the two attended-domain
// cards land on the same type scale (uppercase 11px / 700 / 0.8 ls).
const sectionLabelStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: 0.8,
  textTransform: 'uppercase',
  opacity: 0.55,
};

const notableSectionStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  marginTop: 10,
};

const performerRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
};

const performerAvatarStyle: CSSProperties = {
  width: 40,
  height: 40,
  borderRadius: 20,
  position: 'relative',
  overflow: 'hidden',
  flexShrink: 0,
};

const performerAvatarImgStyle: CSSProperties = {
  position: 'absolute',
  top: 0,
  left: 0,
  width: '100%',
  height: '100%',
  objectFit: 'cover',
  transition: 'opacity 200ms ease',
};

const performerNameStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
};

const performerHeaderStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  gap: 10,
};

const performerNameLineStyle: CSSProperties = {
  flex: 1,
  fontSize: 14,
  fontWeight: 600,
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const performerSubStyle: CSSProperties = {
  fontSize: 11,
  opacity: 0.6,
  marginTop: 1,
};

const statLineStyle: CSSProperties = {
  fontSize: 12,
  fontVariantNumeric: 'tabular-nums',
  opacity: 0.85,
  textAlign: 'right',
  whiteSpace: 'nowrap',
};

const ticketBlockStyle: CSSProperties = {
  paddingTop: 8,
  borderTop: '1px solid rgba(127,127,127,0.12)',
};

const ticketLineStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  justifyContent: 'space-between',
  gap: 8,
  fontSize: 13,
};

const ticketPriceStyle: CSSProperties = {
  opacity: 0.7,
  fontVariantNumeric: 'tabular-nums',
};

const ticketVendorStyle: CSSProperties = {
  fontSize: 11,
  opacity: 0.55,
  marginTop: 2,
};
