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
  home_runs: number;
  away_runs: number;
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
  const won = ed.my_team_won;

  // Derive a result badge — green W, red L, grey for no-show / non-sports.
  const badge = !event.attended
    ? { color: 'rgba(127,127,127,0.6)', label: 'NO-SHOW' }
    : event.category !== 'sports'
      ? null
      : won === true
        ? { color: '#16a34a', label: 'W' }
        : won === false
          ? { color: '#dc2626', label: 'L' }
          : null;

  const notable = (event.players ?? []).filter((p) => p.notable);

  return (
    <div style={cardStyle}>
      <header style={headerStyle}>
        <div>
          <div style={dateStyle}>{formatLongDate(event.event_date)}</div>
          {event.venue && (
            <div style={venueStyle}>
              {event.venue.name}
              {event.venue.city ? ` · ${event.venue.city}` : ''}
            </div>
          )}
        </div>
        {badge && (
          <span style={{ ...badgeStyle, background: badge.color }}>
            {badge.label}
          </span>
        )}
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

      {(ed.attendance || ed.weather || ed.duration_minutes) && (
        <div style={metaStyle}>
          {ed.attendance ? (
            <span>{formatAttendance(ed.attendance)} fans</span>
          ) : null}
          {ed.weather && formatWeather(ed.weather) ? (
            <span>{formatWeather(ed.weather)}</span>
          ) : null}
          {ed.duration_minutes ? (
            <span>{formatDuration(ed.duration_minutes)}</span>
          ) : null}
        </div>
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
      <TeamLogo team={team} size={44} variant="auto" />
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
                {r}
              </td>
            ))}
          </tr>
          <tr>
            <td style={lineTeamCellStyle}>
              {home?.abbreviation ?? home?.name?.split(' ').pop() ?? 'HOME'}
            </td>
            {homeRuns.map((r, i) => (
              <td key={i} style={lineCellStyle}>
                {r}
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
  const dominant = photo?.dominant_color ?? 'rgba(127,127,127,0.18)';

  // Prefer batting line summary, then pitching line summary, then bare name.
  const stat =
    appearance.batting_line?.summary ?? appearance.pitching_line?.summary ?? '';
  const decision = appearance.decision;
  const number = appearance.player.primary_number;
  const position = appearance.player.primary_position;

  return (
    <div style={performerRowStyle}>
      <div style={{ ...performerAvatarStyle, background: dominant }}>
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
        <div style={performerNameLineStyle}>
          {appearance.player.full_name}
          {decision && (
            <span style={decisionBadgeStyle(decision)}>{decision}</span>
          )}
        </div>
        <div style={performerSubStyle}>
          {[number ? `#${number}` : null, position].filter(Boolean).join(' · ')}
        </div>
      </div>
      {stat && <div style={statLineStyle}>{stat}</div>}
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

const cardStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  padding: 16,
  borderRadius: 12,
  border: '1px solid rgba(127,127,127,0.18)',
  background: 'var(--color-bg-secondary, rgba(127,127,127,0.03))',
  fontFamily:
    'var(--font-sans, -apple-system, BlinkMacSystemFont, system-ui, sans-serif)',
  color: 'var(--color-text-primary, inherit)',
  fontSize: 14,
  maxWidth: 520,
  boxShadow: '0 1px 2px rgba(0,0,0,0.04), 0 1px 3px rgba(0,0,0,0.06)',
};

const headerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: 8,
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
  marginTop: 2,
};

const badgeStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  color: 'white',
  padding: '3px 8px',
  borderRadius: 6,
  letterSpacing: '0.04em',
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
  padding: '8px 0',
};

const teamSlotStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 4,
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

const metaStyle: CSSProperties = {
  display: 'flex',
  gap: 12,
  fontSize: 12,
  opacity: 0.7,
  flexWrap: 'wrap',
};

const sectionLabelStyle: CSSProperties = {
  fontSize: 10,
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  opacity: 0.55,
  fontWeight: 600,
  marginBottom: 6,
};

const notableSectionStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  paddingTop: 8,
  borderTop: '1px solid rgba(127,127,127,0.12)',
};

const performerRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
};

const performerAvatarStyle: CSSProperties = {
  width: 36,
  height: 36,
  borderRadius: 18,
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

const performerNameLineStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  fontSize: 13,
  fontWeight: 500,
};

const performerSubStyle: CSSProperties = {
  fontSize: 11,
  opacity: 0.6,
};

const statLineStyle: CSSProperties = {
  fontSize: 11,
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

function decisionBadgeStyle(d: 'W' | 'L' | 'SV' | 'HLD' | 'BS'): CSSProperties {
  const bg =
    d === 'W'
      ? '#16a34a'
      : d === 'L'
        ? '#dc2626'
        : d === 'SV'
          ? '#2563eb'
          : 'rgba(127,127,127,0.6)';
  return {
    display: 'inline-block',
    fontSize: 10,
    fontWeight: 700,
    color: 'white',
    background: bg,
    padding: '1px 5px',
    borderRadius: 4,
    letterSpacing: '0.04em',
  };
}
