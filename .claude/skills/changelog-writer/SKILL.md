---
name: changelog-writer
description: This skill should be used when the user asks to "add a changelog entry", "write changelog", "audit changelog", "review changelog", "check changelog entries", or is editing docs-mintlify/changelog.mdx. Enforces a consistent, reader-facing voice and cuts implementation trivia.
argument-hint: 'write | audit | entry for {feature}'
---

# Changelog Writer

Writes and audits entries in `docs-mintlify/changelog.mdx`. Enforces a reader-facing voice modeled on Stripe, Linear, Resend, and Mintlify: short, benefit-led, concrete, no vanity.

## When to use

- Adding a new entry after a release
- Auditing existing entries for consistency
- Reviewing a draft entry someone wrote for voice and length
- Cleaning up accumulated drift across the file

## The core rule

**Every sentence must answer: "what can a reader now do, or rely on?"** If a line describes how the team built something, cut it.

## Writing rules

1. **Length.** One sentence for minor changes. Two short sentences or ≤6 bullets for major releases. Anything longer is two entries pretending to be one.
2. **Voice.** Active, present tense, reader as subject. "You can now filter by date" or "Listening endpoints now include `apple_music_url`" — not "We added date filtering" or "Date filtering has been implemented".
3. **Benefit before mechanism.** Lead with the capability. Put the tool/endpoint name second. "Full article text via new `get_article` tool" — not "New Voyage AI integration enables get_article".
4. **Concrete nouns.** Name the endpoint, field, tool, or parameter explicitly (wrap in backticks). Vague ("improvements to reading") is useless.
5. **Link out.** For anything with its own doc page, link it. Don't re-explain in the changelog.
6. **No emojis. No exclamation marks.** Project-wide rule and matches Stripe/Linear convention.

## Anti-patterns — always cut

- **Version archaeology.** "Rolls up v0.3.0 → v0.4.3 into one entry", "this release combines…". The date label does this work.
- **Vanity metrics.** Coverage percentages, "rescues NYT/Reuters", "3x faster", "now supports 12 providers". Readers don't care about the work; they care about the outcome. If a number matters (a new cap, a new limit), state it flatly — no celebration.
- **Future work.** "Coming soon", "planned for next release", "future: Goodreads support". Changelogs are for shipped things only. File futures in a roadmap doc.
- **Implementation trivia.** Embedding model names, algorithm constants (RRF k=60, cosine, 512 dim), tokenizer details, cache TTLs, internal class names (`verify_credentials` method), framework specifics. Exception: if a reader can _pass_ or _observe_ the thing, it stays.
- **Counting the work.** "12 new tools", "10 entity resources", "3 new prompts" — numbers without named items are filler. Either name the useful ones or omit.
- **Self-reference to prior entries.** "As mentioned last release…", "building on the March update…". Each entry stands alone.
- **Hedged language.** "We've begun rolling out", "some users may see". Either it shipped or it didn't.

## Structure conventions

### Frontmatter — the `<Update>` block

```mdx
<Update label="<Month Day, Year>" tags={["<Tag>", ...]}>
```

**Tags — pick from this closed set:**

- `New releases` — a whole product or service ships (MCP server, docs site, a new domain)
- `New features` — capabilities added to an existing product (new endpoint, new field)
- `Improvements` — changes to existing behavior (raised limits, better matching, perf)
- `Fixes` — bug fixes (rarely used — fold into Improvements unless user-visible)

Combine tags only when the entry genuinely spans them.

### Heading

```mdx
## <Feature or domain name>
```

- **No version numbers** in headings, except when the shipping unit _is_ a versioned package readers install (then: `## MCP server v0.4.3` is OK — but prefer bare `## MCP server` even then, and let the entry's date carry the timeline).
- **Domain: feature** pattern for scoped updates: `## Reading domain: delta sync`, `## Watching: reviews and ratings`.
- Title case for the main noun, sentence case for the rest.

### Body

Two shapes. Pick one.

**Shape A — prose lead + bullets** (for a debut or multi-item release):

```mdx
## <Feature>

<One-sentence summary of what shipped and who it's for.>

- **<Capability>** — <one sentence, names the endpoint/tool/field>.
- **<Capability>** — <one sentence>.
```

**Shape B — pure bullets** (for a tight set of related changes):

```mdx
## <Feature>

- <Capability> (`endpoint` or `tool_name`).
- <Capability> (`endpoint`).
```

**Shape C — bare prose** (for single-item updates, ≤3 sentences):

```mdx
## <Feature>

<What it does. How to use it, if non-obvious. Link out.>
```

### Separator style

- Use em-dash `—` between a noun and its gloss: `` `get_article` — returns the full article body``
- Never `--` (double hyphen) in prose. Never `-` either outside of list markers.
- Markdown list markers are `-` (single hyphen + space). Sub-bullets indent two spaces.

### Bullet shape

- Bold the capability name when using prose + bullets (Shape A): `- **Semantic search** — ...`.
- Skip bolding in Shape B (pure bullet lists of endpoints/tools).
- End every bullet with a period.

## Audit procedure

When asked to audit, run this checklist on every `<Update>` block in `docs-mintlify/changelog.mdx`:

1. **Length.** Longer than ~8 bullets or ~2 paragraphs? Candidate for trimming or splitting.
2. **Preamble.** Any "rolls up", "combines", "this release" framing? Cut.
3. **Future work.** Any "coming soon", "planned", "future"? Cut.
4. **Vanity.** Any percentages, multipliers, coverage stats, or "rescues X / Y"? Cut.
5. **Counts.** Any "N new tools / resources / prompts" without the items named? Replace with named items or cut.
6. **Implementation trivia.** Any model names, algorithm constants, internal methods, infra details the reader can't observe or invoke? Cut.
7. **Heading.** Version number that isn't a shipped package? Strip.
8. **Tags.** Are tags from the closed set (`New releases`, `New features`, `Improvements`, `Fixes`)? Normalize.
9. **Separators.** Any `--` in prose? Replace with `—`.
10. **Voice.** Any passive voice or "we did X" framing? Rewrite to reader-facing.
11. **Links.** Any referenced endpoint or feature that has its own doc page but isn't linked? Add the link.

Report findings as a per-entry punch list before applying fixes. Apply in one pass.

## Examples

### Good (matches rules)

```mdx
<Update label="March 16, 2026" tags={["New features"]}>

## Apple Music enrichment

Listening endpoints now include `apple_music_url` and `preview_url` fields on
tracks, artists, and albums. Links go directly to the matching item on Apple
Music. Preview URLs point to 30-second audio clips when available.

</Update>
```

Why it works: one capability, names the fields, explains the two URLs in one sentence each, no work-talk.

### Bad (rewrite)

```mdx
## Reading sync improvements

We're excited to announce that we've rolled out a major overhaul of the
Instapaper sync pipeline, now using the `have` and `highlights` API parameters
for delta syncing (~95% bandwidth reduction). Also added a `verify_credentials`
method to the Instapaper client for credential health checks. Coming soon:
Goodreads support.
```

Violations: preamble ("We're excited"), vanity metric (95%), internal method name (`verify_credentials`), future work (Goodreads).

Rewrite:

```mdx
## Reading domain: delta sync

Instapaper sync now transfers only new or changed bookmarks and highlights each
cycle, and deletions propagate from Instapaper. `/health/sync` now includes the
Reading domain.
```

## New entries — workflow

1. Read the release's diff or summary. Pull out reader-facing changes only.
2. Pick the tags from the closed set.
3. Pick a shape (A/B/C) based on how many items there are.
4. Draft the heading using domain:feature if the change is scoped, else a noun phrase.
5. Write each bullet / paragraph against the rules.
6. Run the audit checklist on the draft before inserting.
7. Insert at the **top** of `docs-mintlify/changelog.mdx` (entries are reverse chronological, right under the frontmatter and title).

## Scope

This skill operates only on `docs-mintlify/changelog.mdx`. Release-please-generated `CHANGELOG.md` files are out of scope — they serve a different audience (developer release log), are derived from conventional commits, and shouldn't be hand-edited.
