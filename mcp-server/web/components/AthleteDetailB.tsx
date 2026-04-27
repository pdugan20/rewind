import { useState, type CSSProperties } from 'react';
import { thumbhashToDataUrl } from '../lib/thumbhash.js';
import { TeamLogo } from './TeamLogo.js';
import type {
  AthletePayload,
  CareerHittingSeason,
  CareerPitchingSeason,
  PlayerAward,
  PlayerMeta,
  SeasonSplits,
} from './AthleteDetail.js';

/**
 * Variant B — "Story flow": Rewind-personality view that leads with
 * the attended angle ("here's what you saw") and treats baseline /
 * career as supporting context. Hero + slim bio inline-row → "you've
 * seen him N times" two-column compare → trend sparkline → résumé →
 * splits accordion → recent appearances.
 *
 * Designed to be ~40% shorter on first paint than the deluxe variant
 * but still expose every panel via a small disclosure.
 */

const HEAD_PX = 110;
const HEAD_TX = `width=${HEAD_PX * 2},height=${HEAD_PX * 2},fit=cover,format=auto,quality=85`;

type Image = {
  cdn_url?: string | null;
  url?: string | null;
  thumbhash?: string | null;
  dominant_color?: string | null;
  accent_color?: string | null;
} | null;

function buildSrc(
  image: Image,
  transform: string
): { src: string; placeholder: string | null } | null {
  if (!image) return null;
  const base = image.cdn_url ?? image.url ?? null;
  if (!base) return null;
  const transformed = base.includes('?')
    ? `${base.split('?')[0]}?${transform}`
    : `${base}?${transform}`;
  return {
    src: transformed,
    placeholder: thumbhashToDataUrl(image.thumbhash ?? null),
  };
}

function fmt(n: number | null | undefined): string {
  if (n === null || n === undefined) return '0';
  return n.toLocaleString();
}

function ageFrom(iso: string | null): number | null {
  if (!iso) return null;
  const dob = new Date(iso);
  const now = new Date();
  let age = now.getUTCFullYear() - dob.getUTCFullYear();
  const m = now.getUTCMonth() - dob.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < dob.getUTCDate())) age -= 1;
  return age;
}

function bioInline(p: PlayerMeta): string {
  const parts: string[] = [];
  if (p.height) parts.push(p.height);
  if (p.weight) parts.push(`${p.weight} lbs`);
  if (p.bats || p.throws) {
    parts.push(`${batShort(p.bats)}/${batShort(p.throws)}`);
  }
  const age = ageFrom(p.birth_date);
  if (age != null) parts.push(`age ${age}`);
  if (p.birth_state_province || p.birth_country) {
    parts.push(`from ${p.birth_state_province ?? p.birth_country}`);
  }
  if (p.debut_date)
    parts.push(`debut ${new Date(p.debut_date).getUTCFullYear()}`);
  if (p.college_name) parts.push(p.college_name);
  return parts.join(' · ');
}

function batShort(code: string | null): string {
  if (!code) return '?';
  if (code === 'S' || code === 'B') return 'S';
  return code;
}

export function AthleteDetailB({
  payload,
  onOpen: _onOpen,
}: {
  payload: AthletePayload;
  onOpen?: (url: string) => void;
}) {
  const {
    player,
    season_stats,
    career,
    splits,
    attended_summary,
    attended_appearances,
    attended_appearance_count,
  } = payload;
  const tint =
    player.primary_team?.ui_tint_color ??
    player.primary_team?.primary_color ??
    'var(--color-accent, #4c6ef5)';

  const seenCount = attended_summary?.games_attended ?? 0;
  const livePerformances = (attended_appearances ?? [])
    .flatMap((a) => a.notable_reasons ?? [])
    .reduce<Record<string, number>>((acc, r) => {
      acc[r] = (acc[r] ?? 0) + 1;
      return acc;
    }, {});
  const liveBadges = Object.entries(livePerformances)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([k, v]) => (v > 1 ? `${v}× ${k}` : k));

  return (
    <article style={cardStyle}>
      <Hero player={player} />
      <BioInline player={player} />

      {seenCount > 0 && attended_summary?.hitter && season_stats?.hitter && (
        <YouVsBaseline
          attended={attended_summary.hitter}
          season={season_stats.hitter}
          tint={tint}
          gamesAttended={seenCount}
        />
      )}
      {liveBadges.length > 0 && (
        <div style={liveRowStyle}>
          <span style={liveLabelStyle}>You've witnessed</span>
          {liveBadges.map((b) => (
            <span
              key={b}
              style={{ ...liveBadgeStyle, color: tint, borderColor: tint }}
            >
              {b}
            </span>
          ))}
        </div>
      )}

      {career && career.seasons.length > 1 && (
        <TrendBlock career={career} tint={tint} />
      )}

      {player.awards && player.awards.length > 0 && (
        <Resume awards={player.awards} tint={tint} />
      )}

      {splits && hasAnySplit(splits) && (
        <CompactSplitsRow splits={splits} tint={tint} season={splits.season} />
      )}

      {attended_appearances.length > 0 && (
        <RecentAppearancesList
          appearances={attended_appearances}
          tint={tint}
          totalCount={attended_appearance_count}
        />
      )}
    </article>
  );
}

function Hero({ player }: { player: PlayerMeta }) {
  const head = buildSrc(player.photo_full ?? player.photo_silo, HEAD_TX);
  const [headLoaded, setHeadLoaded] = useState(false);
  return (
    <div style={heroStyle}>
      <div style={portraitStyle} aria-hidden>
        {head?.placeholder && (
          <img
            src={head.placeholder}
            alt=""
            aria-hidden
            style={{
              ...portraitImgStyle,
              filter: 'blur(12px)',
              transform: 'scale(1.05)',
              opacity: headLoaded ? 0 : 1,
            }}
          />
        )}
        {head && (
          <img
            src={head.src}
            alt={player.full_name}
            loading="lazy"
            onLoad={() => setHeadLoaded(true)}
            style={{
              ...portraitImgStyle,
              opacity: headLoaded ? 1 : 0,
              transition: 'opacity 240ms ease',
            }}
          />
        )}
      </div>
      <div style={heroRightStyle}>
        <h1 style={titleStyle}>{player.full_name}</h1>
        <div style={badgeRowStyle}>
          {player.primary_team && (
            <span style={teamBadgeStyle}>
              <TeamLogo team={player.primary_team} size={28} variant="auto" />
              <span style={teamAbbrStyle}>
                {player.primary_team.abbreviation}
              </span>
            </span>
          )}
          {player.primary_position && (
            <span style={chipStyle}>{player.primary_position}</span>
          )}
          {player.primary_number && (
            <span style={numberStyle}>#{player.primary_number}</span>
          )}
        </div>
      </div>
    </div>
  );
}

function BioInline({ player }: { player: PlayerMeta }) {
  const text = bioInline(player);
  if (!text) return null;
  return <div style={bioInlineStyle}>{text}</div>;
}

function YouVsBaseline({
  attended,
  season,
  tint,
  gamesAttended,
}: {
  attended: NonNullable<AthletePayload['attended_summary']['hitter']>;
  season: NonNullable<NonNullable<AthletePayload['season_stats']>['hitter']>;
  tint: string;
  gamesAttended: number;
}) {
  return (
    <section style={compareSectionStyle}>
      <div style={compareHeaderStyle}>
        You've seen him{' '}
        <span style={{ ...compareCountStyle, color: tint }}>
          {gamesAttended}
        </span>{' '}
        time{gamesAttended === 1 ? '' : 's'}
      </div>
      <div style={compareGridStyle}>
        <div style={compareColStyle}>
          <div style={compareLabelStyle}>In your games</div>
          <div style={{ ...compareSlashStyle, color: tint }}>
            {attended.avg ?? '—'} / {attended.slg ?? '—'}
          </div>
          <div style={compareLineStyle}>
            <strong>{attended.hr ?? 0}</strong> HR ·{' '}
            <strong>{attended.rbi ?? 0}</strong> RBI ·{' '}
            <strong>{attended.bb ?? 0}</strong> BB ·{' '}
            <strong>{attended.k ?? 0}</strong> K
          </div>
        </div>
        <div style={compareDividerStyle} aria-hidden />
        <div style={compareColStyle}>
          <div style={compareLabelStyle}>
            His {season.games_played != null ? `${'season'}` : 'season'}
          </div>
          <div style={compareSlashStyle}>
            {season.avg ?? '—'} / {season.slg ?? '—'}
          </div>
          <div style={compareLineStyle}>
            <strong>{season.hr ?? 0}</strong> HR ·{' '}
            <strong>{season.rbi ?? 0}</strong> RBI ·{' '}
            <strong>{season.bb ?? 0}</strong> BB ·{' '}
            <strong>{season.k ?? 0}</strong> K
          </div>
        </div>
      </div>
    </section>
  );
}

function TrendBlock({
  career,
  tint,
}: {
  career: NonNullable<AthletePayload['career']>;
  tint: string;
}) {
  const isHitter = career.group === 'hitting';
  const seasons = (
    isHitter
      ? (career.seasons as CareerHittingSeason[])
      : (career.seasons as CareerPitchingSeason[])
  )
    .slice()
    .sort((a, b) => a.season.localeCompare(b.season));
  if (seasons.length < 2) return null;

  const hrSeries = isHitter
    ? (seasons as CareerHittingSeason[]).map((s) => s.hr)
    : (seasons as CareerPitchingSeason[]).map((s) => s.k);
  const opsSeries = isHitter
    ? (seasons as CareerHittingSeason[]).map((s) =>
        s.ops ? parseFloat(s.ops) * 1000 : 0
      )
    : (seasons as CareerPitchingSeason[]).map((s) =>
        s.era ? Math.max(0, 600 - parseFloat(s.era) * 100) : 0
      );

  const labels = seasons.map((s) => s.season);
  const totalLabel = isHitter ? 'HR' : 'K';
  const trendLabel = isHitter ? 'OPS' : 'ERA';

  return (
    <section style={trendSectionStyle}>
      <div style={sectionMicroLabelStyle}>How he's trended</div>
      <SparklineRow
        label={`${totalLabel} per season`}
        values={hrSeries}
        tint={tint}
        labels={labels}
      />
      <SparklineRow
        label={`${trendLabel} per season`}
        values={opsSeries}
        tint={tint}
        labels={labels}
      />
    </section>
  );
}

function SparklineRow({
  label,
  values,
  tint,
  labels,
}: {
  label: string;
  values: number[];
  tint: string;
  labels: string[];
}) {
  const max = Math.max(...values, 1);
  const widthPct = 100 / Math.max(values.length - 1, 1);
  return (
    <div style={sparkRowStyle}>
      <div style={sparkLabelStyle}>{label}</div>
      <div style={sparkBarsStyle}>
        {values.map((v, i) => {
          const h = Math.max(2, (v / max) * 28);
          const isLast = i === values.length - 1;
          return (
            <div
              key={`${labels[i]}-${i}`}
              style={{
                width: `${widthPct}%`,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 4,
              }}
            >
              <div
                style={{
                  width: '60%',
                  height: h,
                  background: isLast ? tint : 'rgba(127,127,127,0.5)',
                  borderRadius: 2,
                }}
              />
              <span style={sparkYearStyle}>{labels[i].slice(2)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Resume({ awards, tint }: { awards: PlayerAward[]; tint: string }) {
  return (
    <section style={resumeSectionStyle}>
      <div style={sectionMicroLabelStyle}>Résumé</div>
      <ul style={resumeListStyle}>
        {awards.map((a, i) => (
          <li key={`${a.season}-${a.id}-${i}`} style={resumeRowStyle}>
            <span style={resumeYearStyle}>{a.season}</span>
            <span style={{ ...resumeDotStyle, background: tint }} />
            <span style={resumeNameStyle}>{a.name}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function hasAnySplit(s: SeasonSplits): boolean {
  if (!s) return false;
  return !!(s.home || s.away || s.vs_left || s.vs_right);
}

function CompactSplitsRow({
  splits,
  tint,
  season,
}: {
  splits: NonNullable<SeasonSplits>;
  tint: string;
  season: number;
}) {
  const items: Array<[string, typeof splits.home]> = [
    ['Home', splits.home],
    ['Away', splits.away],
    ['vs L', splits.vs_left],
    ['vs R', splits.vs_right],
  ];
  return (
    <section style={compactSplitsStyle}>
      <div style={sectionMicroLabelStyle}>{season}, by split</div>
      <div style={compactSplitsRowStyle}>
        {items.map(([label, s]) =>
          s ? (
            <div key={label} style={compactSplitItemStyle}>
              <span style={compactSplitLabelStyle}>{label}</span>
              <span style={{ ...compactSplitValueStyle, color: tint }}>
                {s.avg ?? '—'}
              </span>
            </div>
          ) : null
        )}
      </div>
    </section>
  );
}

function RecentAppearancesList({
  appearances,
  tint,
  totalCount,
}: {
  appearances: AthletePayload['attended_appearances'];
  tint: string;
  totalCount: number;
}) {
  return (
    <section>
      <div style={sectionMicroLabelStyle}>
        Recent appearances
        {totalCount > appearances.length ? ` · ${totalCount} total` : null}
      </div>
      <ul style={appearancesStyle}>
        {appearances.map((a) => (
          <li key={a.event_id} style={appearanceRowStyle}>
            <div style={appearanceDateStyle}>
              {formatDateShort(a.event_date)}
            </div>
            <div style={appearanceMainStyle}>
              <div style={appearanceTitleStyle}>{a.title}</div>
              <div style={appearanceStatStyle}>{summarizeStatLine(a)}</div>
            </div>
            {a.notable && (
              <span style={{ ...notableDotStyle, background: tint }} />
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function summarizeStatLine(
  a: AthletePayload['attended_appearances'][number]
): string {
  const b = a.batting_line as Record<string, unknown> | null;
  const p = a.pitching_line as Record<string, unknown> | null;
  if (b && b.ab) {
    const parts = [
      `${b.h ?? 0}-${b.ab}`,
      b.hr ? `${b.hr} HR` : null,
      b.rbi ? `${b.rbi} RBI` : null,
      b.bb ? `${b.bb} BB` : null,
    ].filter(Boolean);
    return parts.join(' · ');
  }
  if (p && p.ip) {
    const parts = [
      `${p.ip} IP`,
      p.er != null ? `${p.er} ER` : null,
      p.k ? `${p.k} K` : null,
      p.bb != null ? `${p.bb} BB` : null,
    ].filter(Boolean);
    return parts.join(' · ');
  }
  return '—';
}

function formatDateShort(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

// ─── Styles ─────────────────────────────────────────────────────────

const cardStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 18,
  padding: 20,
  background: 'transparent',
  color: 'var(--color-text-primary, #1a1a1a)',
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
};

const heroStyle: CSSProperties = {
  display: 'flex',
  gap: 16,
  alignItems: 'center',
};

const portraitStyle: CSSProperties = {
  width: HEAD_PX,
  height: HEAD_PX,
  borderRadius: '50%',
  overflow: 'hidden',
  flexShrink: 0,
  background: 'rgba(127,127,127,0.08)',
  position: 'relative',
};

const portraitImgStyle: CSSProperties = {
  position: 'absolute',
  inset: 0,
  width: '100%',
  height: '100%',
  objectFit: 'cover',
};

const heroRightStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  minWidth: 0,
};

const titleStyle: CSSProperties = {
  margin: 0,
  fontSize: 26,
  fontWeight: 700,
  letterSpacing: -0.3,
  lineHeight: 1.1,
};

const badgeRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  flexWrap: 'wrap',
};

const teamBadgeStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
};

const teamAbbrStyle: CSSProperties = {
  fontSize: 14,
  fontWeight: 700,
  letterSpacing: 0.4,
};

const chipStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: 0.5,
  textTransform: 'uppercase',
  padding: '3px 8px',
  borderRadius: 999,
  background: 'rgba(127,127,127,0.18)',
};

const numberStyle: CSSProperties = {
  fontSize: 14,
  fontWeight: 600,
  opacity: 0.7,
  fontVariantNumeric: 'tabular-nums',
};

const bioInlineStyle: CSSProperties = {
  fontSize: 12,
  opacity: 0.7,
  lineHeight: 1.5,
};

const compareSectionStyle: CSSProperties = {
  padding: '14px 16px',
  borderRadius: 12,
  background: 'rgba(127,127,127,0.06)',
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
};

const compareHeaderStyle: CSSProperties = {
  fontSize: 16,
  fontWeight: 600,
  letterSpacing: -0.2,
};

const compareCountStyle: CSSProperties = {
  fontSize: 22,
  fontWeight: 700,
  fontVariantNumeric: 'tabular-nums',
};

const compareGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr 1px 1fr',
  gap: 14,
  alignItems: 'start',
};

const compareColStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  minWidth: 0,
};

const compareDividerStyle: CSSProperties = {
  width: 1,
  alignSelf: 'stretch',
  background: 'rgba(127,127,127,0.18)',
};

const compareLabelStyle: CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: 0.6,
  textTransform: 'uppercase',
  opacity: 0.55,
};

const compareSlashStyle: CSSProperties = {
  fontSize: 24,
  fontWeight: 700,
  fontVariantNumeric: 'tabular-nums',
  letterSpacing: -0.4,
  lineHeight: 1.1,
};

const compareLineStyle: CSSProperties = {
  fontSize: 12,
  opacity: 0.85,
  fontVariantNumeric: 'tabular-nums',
};

const liveRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  flexWrap: 'wrap',
};

const liveLabelStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: 0.6,
  textTransform: 'uppercase',
  opacity: 0.55,
};

const liveBadgeStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  padding: '3px 10px',
  borderRadius: 999,
  border: '1px solid',
  background: 'transparent',
};

const trendSectionStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
};

const sectionMicroLabelStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: 0.8,
  textTransform: 'uppercase',
  opacity: 0.55,
};

const sparkRowStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '120px 1fr',
  gap: 12,
  alignItems: 'flex-end',
};

const sparkLabelStyle: CSSProperties = {
  fontSize: 11,
  opacity: 0.7,
  fontWeight: 500,
};

const sparkBarsStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-end',
  height: 38,
  gap: 4,
};

const sparkYearStyle: CSSProperties = {
  fontSize: 9,
  opacity: 0.55,
  fontVariantNumeric: 'tabular-nums',
};

const resumeSectionStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
};

const resumeListStyle: CSSProperties = {
  listStyle: 'none',
  margin: 0,
  padding: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
};

const resumeRowStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '40px auto 1fr',
  alignItems: 'center',
  gap: 10,
};

const resumeYearStyle: CSSProperties = {
  fontSize: 12,
  opacity: 0.55,
  fontVariantNumeric: 'tabular-nums',
};

const resumeDotStyle: CSSProperties = {
  width: 5,
  height: 5,
  borderRadius: '50%',
};

const resumeNameStyle: CSSProperties = {
  fontSize: 13,
  fontWeight: 500,
};

const compactSplitsStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
};

const compactSplitsRowStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 16,
};

const compactSplitItemStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'baseline',
  gap: 6,
};

const compactSplitLabelStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  opacity: 0.6,
};

const compactSplitValueStyle: CSSProperties = {
  fontSize: 16,
  fontWeight: 700,
  fontVariantNumeric: 'tabular-nums',
};

const appearancesStyle: CSSProperties = {
  listStyle: 'none',
  margin: 0,
  padding: 0,
  display: 'flex',
  flexDirection: 'column',
};

const appearanceRowStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '110px 1fr auto',
  alignItems: 'center',
  gap: 10,
  padding: '10px 0',
  borderTop: '1px solid rgba(127,127,127,0.08)',
};

const appearanceDateStyle: CSSProperties = {
  fontSize: 12,
  opacity: 0.7,
  fontVariantNumeric: 'tabular-nums',
};

const appearanceMainStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  minWidth: 0,
};

const appearanceTitleStyle: CSSProperties = {
  fontSize: 13,
  fontWeight: 500,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const appearanceStatStyle: CSSProperties = {
  fontSize: 11,
  opacity: 0.7,
  fontVariantNumeric: 'tabular-nums',
};

const notableDotStyle: CSSProperties = {
  width: 7,
  height: 7,
  borderRadius: '50%',
  flexShrink: 0,
};
