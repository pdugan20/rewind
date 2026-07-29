# Repository skills

These are Rewind-specific workflows and remain **project-scoped**:

- `media-search` performs read-only TMDb and Discogs lookups.
- `add-media` adds physical media through Rewind's live admin API; the user's add request supplies the mutation intent, and ambiguous or large batches require confirmation as documented in the skill.
- `changelog-writer` applies Rewind's Mintlify changelog format and voice.

`.agents/skills` is the canonical source for Codex and Claude. Claude's `.claude/skills` entries are relative symlinks to these directories. These skills are maintained with Rewind because their endpoints, credentials, domain model, and documentation format are not general-purpose.
