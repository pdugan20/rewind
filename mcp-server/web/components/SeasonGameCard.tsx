import { useState, type CSSProperties } from 'react';
import { thumbhashToDataUrl } from '../lib/thumbhash.js';

export type Photo = {
  cdn_url?: string | null;
  url?: string | null;
  thumbhash?: string | null;
  dominant_color?: string | null;
  accent_color?: string | null;
} | null;

export type GamePlayer = {
  player: {
    id: number;
    full_name: string;
    primary_position: string | null;
    photo_silo: Photo;
  };
  decision: 'W' | 'L' | 'SV' | 'HLD' | 'BS' | null;
  notable: boolean;
};

export type Game = {
  id: number;
  event_date: string;
  title: string;
  subtitle: string | null;
  attended: boolean;
  venue: { name: string } | null;
  event_data: {
    attendance?: number;
    weather?: { condition?: string; temp?: string; wind?: string };
    duration_minutes?: number;
    my_team_won?: boolean;
  } | null;
  // Optional — only present when consumer asked for full event detail.
  // Season list responses don't include this; the card degrades gracefully.
  players?: GamePlayer[];
};

export function SeasonGameCard({
  game,
  notablePlayers,
}: {
  game: Game;
  notablePlayers: GamePlayer[];
}) {
  const [hovered, setHovered] = useState(false);

  const venue = game.venue?.name ?? '';
  const date = formatDate(game.event_date);
  const attendance = game.event_data?.attendance
    ? `${formatAttendance(game.event_data.attendance)} fans`
    : null;
  const weather = formatWeather(game.event_data?.weather);

  // Result badge — green for win, red for loss, grey for unknown / no-show.
  const won = game.event_data?.my_team_won;
  const badgeColor = !game.attended
    ? 'rgba(127,127,127,0.6)'
    : won === true
      ? '#16a34a'
      : won === false
        ? '#dc2626'
        : 'rgba(127,127,127,0.6)';
  const badgeText = !game.attended
    ? 'NS'
    : won === true
      ? 'W'
      : won === false
        ? 'L'
        : '—';

  return (
    <div
      style={{
        ...cardStyle,
        boxShadow: hovered ? hoverShadow : restShadow,
        transform: hovered ? 'translateY(-1px)' : 'translateY(0)',
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div style={headerStyle}>
        <div style={dateStyle}>{date}</div>
        <span style={{ ...badgeStyle, background: badgeColor }}>
          {badgeText}
        </span>
      </div>
      <div style={titleStyle}>{game.title}</div>
      {game.subtitle && <div style={scoreStyle}>{game.subtitle}</div>}
      {(venue || attendance || weather) && (
        <div style={metaStyle}>
          {[venue, attendance, weather].filter(Boolean).join(' · ')}
        </div>
      )}
      {notablePlayers.length > 0 && (
        <div style={playerStripStyle}>
          {notablePlayers.slice(0, 6).map((p) => (
            <PlayerChip key={p.player.id} appearance={p} />
          ))}
        </div>
      )}
    </div>
  );
}

function PlayerChip({ appearance }: { appearance: GamePlayer }) {
  const [loaded, setLoaded] = useState(false);
  const photo = appearance.player.photo_silo;
  const photoUrl = photo?.cdn_url ?? photo?.url ?? null;
  const placeholder = thumbhashToDataUrl(photo?.thumbhash ?? null);
  const dominant = photo?.dominant_color ?? '#222';
  const decision = appearance.decision;

  return (
    <div
      style={chipStyle}
      title={`${appearance.player.full_name}${decision ? ` (${decision})` : ''}`}
    >
      <div
        style={{
          ...avatarStyle,
          background: dominant,
        }}
      >
        {placeholder && (
          <img
            src={placeholder}
            alt=""
            aria-hidden
            style={{
              ...avatarImgStyle,
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
              ...avatarImgStyle,
              opacity: loaded ? 1 : 0,
            }}
          />
        )}
        {decision && (
          <span style={chipBadgeStyle(decision)} aria-hidden>
            {decision}
          </span>
        )}
      </div>
      <div style={chipNameStyle}>{shortName(appearance.player.full_name)}</div>
    </div>
  );
}

function shortName(full: string): string {
  const parts = full.trim().split(/\s+/);
  if (parts.length <= 1) return full;
  const first = parts[0];
  const last = parts.slice(1).join(' ');
  return `${first[0]}. ${last}`;
}

function formatDate(iso: string): string {
  const d = new Date(iso + 'T12:00:00Z');
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
}

function formatAttendance(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}K`;
  return String(n);
}

function formatWeather(w?: {
  condition?: string;
  temp?: string;
  wind?: string;
}): string | null {
  if (!w) return null;
  const parts = [];
  if (w.temp) parts.push(`${w.temp}°`);
  if (w.condition) parts.push(w.condition);
  return parts.length ? parts.join(' ') : null;
}

const cardStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  padding: 12,
  borderRadius: 10,
  border: '1px solid var(--color-border-tertiary, rgba(127,127,127,0.15))',
  background: 'var(--color-background-secondary, transparent)',
  transition: 'transform 150ms ease, box-shadow 150ms ease',
  willChange: 'transform',
};

const restShadow = '0 1px 2px rgba(0,0,0,0.06), 0 2px 6px rgba(0,0,0,0.08)';
const hoverShadow = '0 3px 8px rgba(0,0,0,0.14), 0 6px 18px rgba(0,0,0,0.14)';

const headerStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
};

const dateStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 500,
  letterSpacing: 0.4,
  textTransform: 'uppercase',
  opacity: 0.6,
};

const badgeStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  color: '#fff',
  padding: '2px 8px',
  borderRadius: 6,
  letterSpacing: 0.4,
};

const titleStyle: CSSProperties = {
  fontSize: 14,
  fontWeight: 600,
  lineHeight: 1.25,
};

const scoreStyle: CSSProperties = {
  fontSize: 12,
  opacity: 0.85,
};

const metaStyle: CSSProperties = {
  fontSize: 11,
  opacity: 0.55,
};

const playerStripStyle: CSSProperties = {
  display: 'flex',
  gap: 6,
  marginTop: 6,
  flexWrap: 'wrap',
};

const chipStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 2,
  fontSize: 10,
  width: 44,
};

const avatarStyle: CSSProperties = {
  position: 'relative',
  width: 36,
  height: 36,
  borderRadius: '50%',
  overflow: 'hidden',
};

const avatarImgStyle: CSSProperties = {
  position: 'absolute',
  inset: 0,
  width: '100%',
  height: '100%',
  objectFit: 'cover',
  transition: 'opacity 200ms ease',
};

function chipBadgeStyle(
  decision: 'W' | 'L' | 'SV' | 'HLD' | 'BS'
): CSSProperties {
  const color =
    decision === 'W'
      ? '#16a34a'
      : decision === 'L'
        ? '#dc2626'
        : decision === 'SV'
          ? '#3b82f6'
          : '#737373';
  return {
    position: 'absolute',
    bottom: -2,
    right: -2,
    fontSize: 8,
    fontWeight: 700,
    background: color,
    color: '#fff',
    padding: '1px 4px',
    borderRadius: 4,
    border: '1.5px solid var(--color-background-secondary, #fff)',
  };
}

const chipNameStyle: CSSProperties = {
  width: '100%',
  textAlign: 'center',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  opacity: 0.7,
};
