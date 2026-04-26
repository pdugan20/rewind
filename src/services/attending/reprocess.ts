// Reprocess pending source rows. Two use cases:
//
//   1. New parser shipped — re-run parsing over the stored body_text /
//      body_html and load any newly-parseable events.
//   2. Body data missing (early Phase-3 source rows lacked body_html) —
//      re-fetch the Gmail message by source_ref to recover the body,
//      then re-run parsers.
//
// Exposed via POST /v1/admin/attending/reprocess?vendor=<vendor>.

import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import type { Env } from '../../types/env.js';
import { attendedEventSources } from '../../db/schema/attending.js';
import { getGoogleAccessToken } from '../google/auth.js';
import { getGmailMessage, judgeSubject } from '../google/gmail-client.js';
import { enrichCandidate } from './enrich.js';
import { loadCanonicalEvent } from './load.js';
import {
  inferVendorFromSender,
  parseEventReservationFromHtml,
  type ParsedReservation,
} from './parse-jsonld.js';
import { parseSeatGeekText } from './parse-seatgeek.js';
import { parseTicketClubHtml } from './parse-ticketclub.js';
import { parseTicketmasterHtml } from './parse-ticketmaster.js';
import { parseAxsHtml } from './parse-axs.js';
import { parseVividHtml } from './parse-vivid.js';
import { parseStubhubHtml } from './parse-stubhub.js';
import { parseEventbriteHtml } from './parse-eventbrite.js';

export interface ReprocessOptions {
  vendor?: string; // domain match (e.g. 'ticketclub.com')
  refetchMissingBody?: boolean; // re-pull from Gmail when body_text/html absent
  limit?: number;
  dryRun?: boolean;
}

export interface ReprocessResult {
  scanned: number;
  refetched: number;
  newly_parsed: number;
  loaded: number;
  failures: Array<{ source_id: number; reason: string }>;
}

export async function reprocessPendingSources(
  db: Database,
  env: Env,
  opts: ReprocessOptions = {}
): Promise<ReprocessResult> {
  const {
    vendor,
    refetchMissingBody = true,
    limit = 1000,
    dryRun = false,
  } = opts;
  const result: ReprocessResult = {
    scanned: 0,
    refetched: 0,
    newly_parsed: 0,
    loaded: 0,
    failures: [],
  };

  // Push vendor filter to SQL so `limit` actually scopes to rows that
  // match the vendor — otherwise the first N pending rows might not
  // include any of the requested vendor.
  const vendorClause = vendor
    ? sql`lower(json_extract(${attendedEventSources.rawData}, '$.from')) LIKE ${`%${vendor.toLowerCase()}%`}`
    : undefined;

  const pending = await db
    .select()
    .from(attendedEventSources)
    .where(
      and(
        eq(attendedEventSources.userId, 1),
        eq(attendedEventSources.sourceType, 'gmail'),
        isNull(attendedEventSources.eventId),
        vendorClause
      )
    )
    .limit(limit);

  let accessToken: string | null = null;

  for (const row of pending) {
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(row.rawData ?? '{}') as Record<string, unknown>;
    } catch {
      result.failures.push({
        source_id: row.id,
        reason: 'raw_data parse error',
      });
      continue;
    }

    const senderRaw = (raw.from as string) ?? '';
    result.scanned++;

    // Re-fetch from Gmail if body data is missing.
    if (
      refetchMissingBody &&
      (raw.body_text == null || raw.body_text === '') &&
      (raw.body_html == null || raw.body_html === '')
    ) {
      try {
        if (!accessToken) accessToken = await getGoogleAccessToken(db, env);
        const msg = await getGmailMessage(accessToken, row.sourceRef);
        raw.body_text = msg.bodyText ? msg.bodyText.slice(0, 12000) : null;
        raw.body_html = msg.bodyHtml ? msg.bodyHtml.slice(0, 24000) : null;
        // also refresh subject + from in case they were missing
        if (!raw.subject) raw.subject = msg.headers.subject ?? null;
        if (!raw.from) raw.from = msg.headers.from ?? null;
        if (!dryRun) {
          await db
            .update(attendedEventSources)
            .set({ rawData: JSON.stringify(raw) })
            .where(eq(attendedEventSources.id, row.id));
        }
        result.refetched++;
      } catch (err) {
        result.failures.push({
          source_id: row.id,
          reason: `refetch failed: ${err instanceof Error ? err.message : String(err)}`,
        });
        continue;
      }
    }

    // Subject gate (re-apply because we may have refetched).
    const verdict = judgeSubject((raw.subject as string) ?? undefined);
    if (verdict === 'reject') continue;

    // Re-parse with current parsers, vendor-specific dispatch.
    const senderVendor = inferVendorFromSender(senderRaw || undefined);
    const html = (raw.body_html as string) ?? '';
    const text = (raw.body_text as string) ?? '';

    let reservations = parseEventReservationFromHtml(html, senderVendor) ?? [];
    if (reservations.length === 0) {
      if (senderVendor === 'seatgeek') {
        reservations = parseSeatGeekText(text) ?? [];
      } else if (senderVendor === 'ticketclub') {
        reservations = parseTicketClubHtml(html) ?? [];
      } else if (senderVendor === 'ticketmaster') {
        reservations = parseTicketmasterHtml(html, row.sourceRef) ?? [];
      } else if (senderVendor === 'axs') {
        reservations = parseAxsHtml(html) ?? [];
      } else if (senderVendor === 'vividseats') {
        reservations = parseVividHtml(html) ?? [];
      } else if (senderVendor === 'stubhub') {
        reservations = parseStubhubHtml(html) ?? [];
      } else if (senderVendor === 'eventbrite') {
        reservations = parseEventbriteHtml(html) ?? [];
      }
    }

    if (reservations.length === 0) continue;
    result.newly_parsed++;

    if (dryRun) continue;

    // Persist the new reservations on the source row, then enrich+load.
    raw.reservations = reservations;
    await db
      .update(attendedEventSources)
      .set({
        rawData: JSON.stringify(raw),
        matchConfidence: 1.0,
      })
      .where(eq(attendedEventSources.id, row.id));

    const first = reservations[0];
    const dt = first.event_start;
    let eventDate: string | null = null;
    if (dt && /^\d{4}-\d{2}-\d{2}/.test(dt)) {
      eventDate = dt.slice(0, 10);
    } else if (dt && /^\d{2}-\d{2}T/.test(dt)) {
      const fallbackYear = new Date(
        raw.internal_date as string
      ).getUTCFullYear();
      if (Number.isFinite(fallbackYear) && fallbackYear > 2000) {
        eventDate = `${fallbackYear}-${dt.slice(0, 5)}`;
      }
    }
    if (!eventDate) continue;

    try {
      const enriched = await enrichCandidate(
        {
          source_ref: row.sourceRef,
          source_type: 'gmail',
          event_date: eventDate,
          event_datetime: dt,
          title: first.event_name,
          location: first.venue_address ?? first.venue_name,
        },
        db,
        env
      );
      if (!enriched) continue;
      await loadCanonicalEvent(
        enriched,
        reservations as ParsedReservation[],
        [{ source_type: 'gmail', source_ref: row.sourceRef }],
        db
      );
      result.loaded++;
    } catch (err) {
      result.failures.push({
        source_id: row.id,
        reason: `enrich/load failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  return result;
}
