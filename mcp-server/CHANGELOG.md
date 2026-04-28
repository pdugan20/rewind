# Changelog

## [0.8.0](https://github.com/pdugan20/rewind/compare/mcp-server-v0.7.0...mcp-server-v0.8.0) (2026-04-28)


### Features

* **article-card:** drop blue bar + italic for serif highlight treatment ([d85fa3a](https://github.com/pdugan20/rewind/commit/d85fa3a64c9219996ab7e7d3ff4a753074946c4f))
* **article-card:** tighten lockup to instapaper chrome; align CTAs ([feca860](https://github.com/pdugan20/rewind/commit/feca8604980fa0f8cd8808cedc61d096826993ff))
* **artist-card:** add tab nav (all/stats/music/similar) ([0c1d6a5](https://github.com/pdugan20/rewind/commit/0c1d6a5959aa8636e5b437aa23750e5ba7ec8185))
* **artist-card:** align with athlete-card chrome — drop dividers, box stat strip ([7f64896](https://github.com/pdugan20/rewind/commit/7f648968196cc4c3226a730a292fbafa614e0a92))
* **artist-card:** genre subline on similar-artists rows ([62d749a](https://github.com/pdugan20/rewind/commit/62d749a80e9fbedb859f6049e5dc5d89a211b4c6))
* **athlete-card:** tab nav + soft career table + game-log polish ([714c08d](https://github.com/pdugan20/rewind/commit/714c08d3178179174c2d18ffd9e96213774726c1))
* **attending:** align attended hitter to season; curate hero to AVG/HR/RBI/OPS ([cf3f32c](https://github.com/pdugan20/rewind/commit/cf3f32c75da40cd182426c2e469c8e200e240156))
* **attending:** hydrate player bio + awards from MLB Stats /people ([e62cd3e](https://github.com/pdugan20/rewind/commit/e62cd3ede20e9c2ecc088b7adb57e6ed91000551))
* **attending:** teams reference table + Team shape on responses ([823cadb](https://github.com/pdugan20/rewind/commit/823cadb36420b915bb276d48bc071e5a1b843674))
* **attending:** year-by-year career + current-season splits ([5608880](https://github.com/pdugan20/rewind/commit/56088801e2d3ec6aa42b4e0d3418bf509d96bf00))
* **attending:** year-in-review endpoint + MCP tool ([#75](https://github.com/pdugan20/rewind/issues/75)) ([ca4f9b1](https://github.com/pdugan20/rewind/commit/ca4f9b1644bcc883bbc505274cd4bdb5bed97132))
* **game-card:** align attended-event with the athlete card ([d9114f1](https://github.com/pdugan20/rewind/commit/d9114f10063ae5c05697dc245f4186940da3741d))
* **mcp-server:** add web-workbench design viewer ([dd4aef4](https://github.com/pdugan20/rewind/commit/dd4aef4487389f65caf4d9c61dd3c232cf2a3a4a))
* **mcp:** attending tools + season-grid card UI ([#55](https://github.com/pdugan20/rewind/issues/55)) ([1900805](https://github.com/pdugan20/rewind/commit/19008053ee469502b27c19b8817aa512d8933b29))
* **top-albums:** card chrome + list/grid toggle + canonical thumb borders ([0155e47](https://github.com/pdugan20/rewind/commit/0155e4743fa7d1ca207ead307d2c0d284d2f8c59))
* **top-artists:** card chrome + row layout + smoothed sparkline ([83ec86d](https://github.com/pdugan20/rewind/commit/83ec86d42c80d78969ee9515510661d3c2b41b3c))
* **top-tracks:** album-grouped view + Apple Music catalog enrichment ([7af69d1](https://github.com/pdugan20/rewind/commit/7af69d19e03f6e3da5c6a3ff05cc931c38d9249f))
* **web:** refactor existing card fixtures to load seeded JSON ([a22caa0](https://github.com/pdugan20/rewind/commit/a22caa0ecfe9cf3c9bf04c47507bc73b854c397e))
* **web:** TeamLogo primitive + GameCard scoreboard logos and color tint ([126ab3f](https://github.com/pdugan20/rewind/commit/126ab3fb1df1a483b220c73240527efd077e71ea))
* **workbench:** align cards across watching, listening, reading, attending ([cd94ae1](https://github.com/pdugan20/rewind/commit/cd94ae15e9d3ab66611d61b38ad1f1c233ac46d5))
* **workbench:** centralize card chrome + workbench surface palette ([675877b](https://github.com/pdugan20/rewind/commit/675877b598dd77b1d416b9987abe91bd2b38d2fa))
* **workbench:** two attended-player variants for side-by-side review ([42ccead](https://github.com/pdugan20/rewind/commit/42ccead358199e2ca186b68be9072a39c0b99c3e))


### Bug Fixes

* **artist-card:** album playcount from scrobbles + tighter grid + 1-line title ([5e8f4c1](https://github.com/pdugan20/rewind/commit/5e8f4c1e2a31af464cd74a0fde7b0f7808be7406))
* **artist-card:** drop guest-tracks, fluid albums, similar as rows ([f8a6dd1](https://github.com/pdugan20/rewind/commit/f8a6dd1d360fa83f4365adb64089d1ac45f77471))
* **artist-card:** top albums — first-party only, 3-col grid, tighter lockup ([9efbbc8](https://github.com/pdugan20/rewind/commit/9efbbc8cd9cdec41faf1f33e052f4afb8eb415aa))
* **attended-player:** nudge Claude to follow up with get_attended_player(id) ([1ee0aae](https://github.com/pdugan20/rewind/commit/1ee0aaee708e867ef4721f4b55ea75733d9be643))
* **attended-player:** production entry uses AthleteDetailA, matching workbench ([0b8ee0c](https://github.com/pdugan20/rewind/commit/0b8ee0c6be74e6bf0926fca21d71b263fb9371c1))
* **attending:** nudge Claude to follow up with get_attended_event for single-game queries ([05e9b75](https://github.com/pdugan20/rewind/commit/05e9b75cbedc8511bcc6df2c4418bd2d8eb5b5a8))
* **mcp-ui:** wire TeamLogo on athlete card + allow mlbstatic in CSP ([eaf0ab0](https://github.com/pdugan20/rewind/commit/eaf0ab0a527369aa0ac0dfdef797b33f38ed7e19))
* **mcp:** allowlist ui://rewind/attended-event.html in check-docs ([b189f62](https://github.com/pdugan20/rewind/commit/b189f62222a65651e281a1b58c5a38fb37194399))
* **reading:** nudge Claude to follow up with get_article(id) after search ([777efa8](https://github.com/pdugan20/rewind/commit/777efa864f57672f12b02c54012f2a20484ee5bf))
* **team-logo:** default to plain logo_url, drop &lt;picture&gt; color-scheme swap ([ee08bb8](https://github.com/pdugan20/rewind/commit/ee08bb804835fe268460f0cd716ea2623f8f68ec))


### Performance Improvements

* **build:web:** use Vite programmatic API; ~90s -&gt; ~0.3s ([70db5f6](https://github.com/pdugan20/rewind/commit/70db5f6f313087f10f505346020d732b31d5a07f))

## [0.7.0](https://github.com/pdugan20/rewind/compare/mcp-server-v0.6.0...mcp-server-v0.7.0) (2026-04-25)


### Features

* **mcp:** render artist sparklines inline in ui://rewind/top-artists.html ([6049a45](https://github.com/pdugan20/rewind/commit/6049a45bd2735732ee50a45988f077d13b136f66))

## [0.6.0](https://github.com/pdugan20/rewind/compare/mcp-server-v0.5.0...mcp-server-v0.6.0) (2026-04-25)


### Features

* **mcp:** forward include_sparklines flag through get_top_artists ([9930d5a](https://github.com/pdugan20/rewind/commit/9930d5a05e4b8caac8cf7a5a8cb47a20a7fa3969))


### Bug Fixes

* **ci:** unblock release-please PR + sync drifted snapshots ([a4e4704](https://github.com/pdugan20/rewind/commit/a4e470409afe607d81ba1b89a72383ada6f1ba57))
