#!/usr/bin/env node
// Deliberate finite import of already-reviewed masters. No provider calls or paid jobs.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
export async function masterForm(entry, directory) {
  const form = new FormData();
  form.set('input', JSON.stringify(entry.input));
  for (const name of [
    'source',
    'candidate',
    'raw',
    'patch',
    'template',
    'master',
  ]) {
    const file = entry.files?.[name];
    if (!file) {
      if (
        ['source', 'candidate'].includes(name) ||
        entry.input.processing?.evidence_hashes?.[name]
      )
        throw Error('missing_import_evidence');
      continue;
    }
    const baseDirectory = await fs.realpath(directory);
    if (path.isAbsolute(file)) throw Error('import_path_outside_bundle');
    const target = path.resolve(baseDirectory, file);
    const relative = path.relative(baseDirectory, target);
    if (relative === '..' || relative.startsWith('..' + path.sep))
      throw Error('import_path_outside_bundle');
    const actual = await fs.realpath(target);
    const actualRelative = path.relative(baseDirectory, actual);
    if (actualRelative === '..' || actualRelative.startsWith('..' + path.sep))
      throw Error('import_path_outside_bundle');
    const bytes = await fs.readFile(actual);
    const expected =
      name === 'source'
        ? entry.input.source_sha256
        : name === 'candidate'
          ? entry.input.candidate_sha256
          : entry.input.processing.evidence_hashes?.[name];
    if (
      bytes.length > 12 * 1024 * 1024 ||
      !expected ||
      digest(bytes) !== expected
    )
      throw Error('import_hash_mismatch');
    form.set(name, new Blob([bytes]), name);
  }
  return form;
}
export async function runImport({
  manifest,
  baseUrl = 'https://api.rewind.rest',
  apiKey,
  apply = false,
  activate = false,
  reviewer,
  fetcher = fetch,
}) {
  if (!apiKey) throw Error('admin_key_required');
  if (activate && (!apply || !reviewer?.trim()))
    throw Error('activation_requires_apply_and_reviewer');
  const base = new URL(baseUrl);
  if (
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    !(
      (base.protocol === 'https:' && base.host === 'api.rewind.rest') ||
      (base.protocol === 'http:' &&
        ['localhost', '127.0.0.1'].includes(base.hostname))
    )
  )
    throw Error('api_origin_not_allowed');
  const document = JSON.parse(await fs.readFile(manifest, 'utf8'));
  if (
    !Array.isArray(document.entries) ||
    !document.entries.length ||
    document.entries.length > 20
  )
    throw Error('finite_batch_required');
  if (
    new Set(document.entries.map((e) => e.input.album_id)).size !==
    document.entries.length
  )
    throw Error('duplicate_album_in_batch');
  async function request(route, body, json = false) {
    const response = await fetcher(
      new URL('/v1/admin/cd-artwork' + route, base),
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + apiKey,
          ...(json ? { 'Content-Type': 'application/json' } : {}),
        },
        body: json ? JSON.stringify(body) : body,
        redirect: 'error',
        signal: AbortSignal.timeout(30000),
      }
    );
    if (!response.ok) throw Error('import_request_failed_' + response.status);
    return response.json();
  }
  // Preflight every item before the first mutation. All future retries use exact hashes.
  const prepared = [];
  for (const entry of document.entries) {
    const valid = await request(
      '/import-reviewed',
      await masterForm(entry, path.dirname(manifest))
    );
    if (
      valid.validated !== true ||
      valid.candidate_hash !== entry.input.candidate_sha256
    )
      throw Error('invalid_validation_response');
    if (
      activate &&
      valid.active_candidate_hash !== entry.input.candidate_sha256 &&
      !valid.activation_allowed
    )
      throw Error('activation_not_allowed');
    if (
      apply &&
      valid.existing_state &&
      !['pending', 'accepted'].includes(valid.existing_state)
    )
      throw Error('import_state_conflict');
    prepared.push({ entry, valid });
  }
  const report = {
    validated: prepared.length,
    applied: 0,
    activated: 0,
    reused: 0,
    already_active: 0,
  };
  for (const { entry, valid } of prepared)
    if (apply) {
      if (
        activate &&
        valid.active_candidate_hash === entry.input.candidate_sha256
      ) {
        report.already_active++;
        continue;
      }
      const job = await request(
        '/import-reviewed?apply=true',
        await masterForm(entry, path.dirname(manifest))
      );
      if (
        job.id !== valid.id ||
        job.candidate_hash !== entry.input.candidate_sha256 ||
        !['pending', 'accepted'].includes(job.state)
      )
        throw Error('import_state_conflict');
      report.applied++;
      if (job.reused) report.reused++;
      if (activate) {
        await request(
          '/jobs/' + job.id + '/review',
          { decision: 'accepted', activate: true, reviewer },
          true
        );
        report.activated++;
      }
    }
  return report;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const args = process.argv.slice(2),
    value = (flag) => args[args.indexOf(flag) + 1];
  try {
    if (!args.includes('--manifest')) throw Error('manifest_required');
    const report = await runImport({
      manifest: path.resolve(value('--manifest')),
      apiKey: process.env.REWIND_ADMIN_KEY,
      baseUrl: process.env.REWIND_API_URL ?? 'https://api.rewind.rest',
      apply: args.includes('--apply'),
      activate: args.includes('--activate'),
      reviewer: args.includes('--reviewer') ? value('--reviewer') : undefined,
    });
    console.log(JSON.stringify(report));
  } catch (error) {
    console.error('[ERROR] ' + error.message);
    process.exitCode = 1;
  }
}
