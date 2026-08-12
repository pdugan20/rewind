# Rewind threat model

Protected assets are personal listening, running, watching, collecting, and reading data;
API/admin keys; OAuth/provider credentials; webhook secrets; D1/R2 state; and private media
metadata. HTTP/MCP input, webhooks, provider responses, image URLs, feeds, and stored legacy
records are untrusted.

Required controls:

- Authenticate every route and MCP operation, distinguish read/admin authority, and scope
  all queries and mutations to the authenticated `user_id`.
- Verify webhook source and replay controls before mutation; make sync and cron work safe
  under retries, duplicates, overlap, and partial failure.
- Keep credentials, personal activity payloads, private media, and stable identifiers out
  of logs, fixtures, errors, public image metadata, and MCP responses beyond the tool's
  documented result.
- Validate remote URLs and redirects before image/feed fetches and prevent private-network
  access through proxy or ingestion paths.
- Treat migrations as compatibility contracts and preserve rollback/repair paths across
  old and new workers.

Update this model when a provider, data domain, route, MCP tool, webhook, migration,
credential, or public deployment changes.
