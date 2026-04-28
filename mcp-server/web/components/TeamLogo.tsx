import type { CSSProperties } from 'react';
import type { Team } from './types.js';

type Variant = 'auto' | 'light' | 'dark' | 'default';

type Props = {
  team: Team | null | undefined;
  size?: number;
  // 'auto' uses prefers-color-scheme to pick light/dark; 'light' forces
  // the on-light cap (use against light backgrounds); 'dark' forces the
  // on-dark cap; 'default' is the brand mark without theme variants.
  variant?: Variant;
  // Optional alt text override; defaults to team.full_name / team.name.
  alt?: string;
  // Used as background placeholder while the SVG loads. Defaults to
  // team primary color at low alpha so the slot doesn't pop in empty.
  showFallback?: boolean;
};

// Renders a team logo inline. SVG is hot-linked from upstream
// (mlbstatic.com for MLB) — the API attaches the URL directly so the
// component never has to know about source resolution. Falls back to a
// pill with the team abbreviation when no logo URL is available — keeps
// the layout stable for newly-seeded leagues that haven't been resolved
// yet.
export function TeamLogo({
  team,
  size = 32,
  variant = 'default',
  alt,
  showFallback = true,
}: Props) {
  // Default changed from 'auto' to 'default' on 2026-04-27. The 'auto'
  // variant uses <picture> + prefers-color-scheme to swap between
  // cap-on-light and cap-on-dark SVGs, but those variants ship with a
  // 300x300 viewBox where the cap mark is sized for letterhead use,
  // not inline display — observed rendering as effectively empty in a
  // 32-44px box. The plain `logo_url` brand mark (e.g. the Mariners
  // compass-S) renders cleanly on both light and dark host themes.
  if (!team) {
    return showFallback ? <div style={fallbackStyle(size, null)}>?</div> : null;
  }

  const altText = alt ?? team.full_name ?? team.name;
  const logoLight = team.logo_light_url ?? team.logo_url;
  const logoDark = team.logo_dark_url ?? team.logo_url;
  const fallbackUrl = team.logo_url;

  if (!fallbackUrl && !logoLight && !logoDark) {
    // Pre-seed event_data stubs lack abbreviation entirely; derive a
    // 3-letter shorthand from the name so the slot doesn't render empty.
    const label =
      team.abbreviation || team.name?.slice(0, 3).toUpperCase() || '?';
    return showFallback ? (
      <div style={fallbackStyle(size, team)}>{label}</div>
    ) : null;
  }

  const wrapperStyle: CSSProperties = {
    width: size,
    height: size,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  };
  const imgStyle: CSSProperties = {
    maxWidth: '100%',
    maxHeight: '100%',
    objectFit: 'contain',
    display: 'block',
  };

  if (variant === 'auto') {
    // <picture> handles the dark/light pick at the browser level —
    // prefers-color-scheme works in both Claude Desktop and iOS hosts.
    return (
      <span style={wrapperStyle}>
        <picture>
          {logoDark && (
            <source srcSet={logoDark} media="(prefers-color-scheme: dark)" />
          )}
          <img
            src={logoLight ?? fallbackUrl ?? ''}
            alt={altText}
            loading="lazy"
            style={imgStyle}
          />
        </picture>
      </span>
    );
  }

  const src =
    variant === 'light'
      ? (logoLight ?? fallbackUrl ?? '')
      : variant === 'dark'
        ? (logoDark ?? fallbackUrl ?? '')
        : (fallbackUrl ?? logoLight ?? '');
  return (
    <span style={wrapperStyle}>
      <img src={src} alt={altText} loading="lazy" style={imgStyle} />
    </span>
  );
}

function fallbackStyle(size: number, team: Team | null): CSSProperties {
  const tint = team?.ui_tint_color ?? team?.primary_color ?? '#737373';
  return {
    width: size,
    height: size,
    borderRadius: 6,
    background: tint + '22', // ~13% alpha when prefixed to a #RRGGBB
    color: tint,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: Math.max(10, Math.round(size * 0.32)),
    fontWeight: 700,
    letterSpacing: 0.4,
    flexShrink: 0,
  };
}
