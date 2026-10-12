/* global document, fetch, FormData */
/* Private same-origin client. No provider tokens, API keys or upstream URLs. */
const base = '/v1/admin/cd-artwork/gallery/data';
const $ = (id) => document.getElementById(id);
let filter = 'all',
  page = 1,
  selected = null,
  versionPage = 1,
  listSequence = 0,
  detailSequence = 0,
  busy = false;
const date = (value) =>
  new Date(value).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
const title = (item) => `${item.album} — ${item.artist}`;
function node(tag, text, className) {
  const n = document.createElement(tag);
  if (text) n.textContent = text;
  if (className) n.className = className;
  return n;
}
async function api(path = '', data) {
  const response = await fetch(base + path, {
    credentials: 'same-origin',
    cache: 'no-store',
    ...(data !== undefined
      ? {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Artwork-Review': '1',
          },
          body: JSON.stringify(data),
        }
      : {}),
  });
  if (
    response.redirected ||
    response.headers.get('content-type')?.includes('text/html')
  )
    throw Error('Your sign-in expired. Reload this page to sign in again.');
  const value = await response.json();
  if (!response.ok)
    throw Error(
      value.error || 'The review could not be saved. Please try again.'
    );
  return value;
}
function image(item, kind, alt) {
  const img = node('img');
  img.src = `${base}/${item.id}/image/${kind}`;
  img.alt = alt;
  img.loading = 'lazy';
  img.addEventListener('error', () => {
    const unavailable = node('span', 'Image unavailable', 'muted');
    img.replaceWith(unavailable);
  });
  return img;
}
function badges(item) {
  const result = node('div', null, 'badges');
  result.append(
    node(
      'span',
      item.source_kind === 'retail' ? 'Retail CD' : 'Album cover',
      'badge neutral'
    )
  );
  if (item.active) result.append(node('span', 'In the player', 'badge'));
  else if (item.hidden) result.append(node('span', 'Hidden', 'badge warn'));
  else if (item.state === 'accepted')
    result.append(node('span', 'Previous version', 'badge neutral'));
  else if (item.state === 'rejected')
    result.append(node('span', 'Rejected', 'badge neutral'));
  else result.append(node('span', 'Held for review', 'badge warn'));
  if (item.feedback.status === 'needs_revision')
    result.append(node('span', 'Needs revision', 'badge warn'));
  if (item.feedback.status === 'good')
    result.append(node('span', 'Looks good', 'badge'));
  if (item.feedback.status === 'resolved')
    result.append(node('span', 'Revision resolved', 'badge neutral'));
  if (item.pinned) result.append(node('span', 'Pinned', 'badge neutral'));
  return result;
}
async function load() {
  const sequence = ++listSequence;
  $('gallery').setAttribute('aria-busy', 'true');
  $('error').hidden = true;
  try {
    const result = await api(`?filter=${filter}&page=${page}`);
    if (sequence !== listSequence) return;
    $('gallery').replaceChildren();
    for (const item of result.data) {
      const card = node('article', null, 'card'),
        button = node('button', null, 'card-button');
      button.type = 'button';
      button.setAttribute('aria-label', `Review ${title(item)}`);
      const art = node('div', null, 'card-art');
      art.append(
        image(
          item,
          item.has_candidate ? 'candidate' : 'raw',
          `Generated disc for ${item.album}`
        )
      );
      const meta = node('div', null, 'card-meta');
      meta.append(node('h2', item.album), node('p', item.artist), badges(item));
      button.append(art, meta);
      button.addEventListener('click', () => open(item));
      card.append(button);
      $('gallery').append(card);
    }
    if (!result.data.length)
      $('gallery').append(node('p', 'No artwork in this view yet.', 'empty'));
    const p = result.pagination;
    $('summary').textContent =
      `${p.total} ${p.total === 1 ? 'disc' : 'discs'} · Newest first`;
    $('page').textContent = p.total_pages
      ? `Page ${p.page} of ${p.total_pages}`
      : '';
    $('previous').disabled = page <= 1;
    $('next').disabled = page >= p.total_pages;
  } catch (error) {
    if (sequence === listSequence) {
      $('error').textContent = error.message;
      $('error').hidden = false;
      $('summary').textContent = 'Unable to load artwork.';
    }
  } finally {
    if (sequence === listSequence)
      $('gallery').setAttribute('aria-busy', 'false');
  }
}
async function open(item) {
  if (busy) return;
  selected = item;
  const sequence = ++detailSequence;
  versionPage = 1;
  $('detail-title').textContent = item.album;
  $('detail-artist').textContent = item.artist;
  $('detail-status').textContent =
    `${item.source_kind === 'retail' ? 'Retail CD artwork' : 'Design from album cover'} · ${date(item.created_at)}`;
  for (const [id, kind] of [
    ['source-image', 'source'],
    ['render-image', item.has_candidate ? 'candidate' : 'raw'],
  ]) {
    const img = $(id);
    img.src = `${base}/${item.id}/image/${kind}`;
    img.alt =
      kind === 'source'
        ? `Original source for ${item.album}`
        : `Generated disc for ${item.album}`;
  }
  $('render-label').textContent = item.has_candidate
    ? 'Finished disc'
    : 'Generated image · Processing held';
  $('preview').value = 'flat';
  $('render-stage').classList.remove('on-surface');
  $('feedback-form').reset();
  $('reason').value = item.feedback.reason || '';
  $('note').value = item.feedback.note || '';
  const status = item.feedback.status;
  if (status === 'good' || status === 'needs_revision')
    document.querySelector(`input[name=status][value=${status}]`).checked =
      true;
  $('hold-message').hidden = !item.review_hold && !item.pinned;
  $('hold-message').textContent = item.pinned
    ? 'This artwork is pinned. You can leave feedback; unpin it before replacing or hiding it.'
    : item.hidden
      ? 'Hidden from the player. Automatic replacements are paused until you approve artwork to use.'
      : 'Automatic replacements for this album are paused while feedback needs attention.';
  $('hide').hidden = !item.active || item.pinned;
  $('activate').hidden =
    !item.has_candidate ||
    !['pending', 'accepted', 'rejected'].includes(item.state) ||
    item.active ||
    item.pinned;
  $('activate').textContent = item.hidden
    ? 'Restore this artwork'
    : 'Use this artwork';
  $('detail-message').textContent = '';
  $('versions').replaceChildren();
  $('history').replaceChildren();
  $('more-versions').hidden = true;
  if (!$('detail').open) $('detail').showModal();
  await Promise.all([loadVersions(sequence), loadHistory(sequence)]);
}
async function loadVersions(sequence = detailSequence) {
  const item = selected;
  try {
    const result = await api(
      `?album_id=${item.album_id}&page=${versionPage}&limit=12`
    );
    if (sequence !== detailSequence) return;
    for (const version of result.data) {
      const button = node('button', null, 'version');
      button.setAttribute('aria-current', String(version.id === item.id));
      button.setAttribute(
        'aria-label',
        `Review version from ${date(version.created_at)}`
      );
      button.append(
        image(version, version.has_candidate ? 'candidate' : 'raw', ''),
        node('span', date(version.created_at))
      );
      button.addEventListener('click', () => open(version));
      $('versions').append(button);
    }
    $('more-versions').hidden = versionPage >= result.pagination.total_pages;
  } catch (error) {
    if (sequence === detailSequence)
      $('detail-message').textContent = error.message;
  }
}
async function loadHistory(sequence = detailSequence) {
  try {
    const result = await api(`/${selected.id}/history`);
    if (sequence !== detailSequence) return;
    $('history').replaceChildren();
    for (const event of result.data) {
      const names = {
        feedback: 'Review saved',
        'hidden-from-player': 'Hidden from player',
        'accepted-and-activated': 'Approved for the player',
        'automatically-accepted-and-activated': 'Automatically published',
        'revision-resolved': 'Revision resolved',
        accepted: 'Accepted',
        rejected: 'Rejected',
      };
      let text = `${date(event.created_at)} · ${names[event.action] || event.action}`;
      if (event.feedback)
        text += `\n${event.feedback.status === 'good' ? 'Looks good' : 'Needs revision'}${event.feedback.reason ? ' · ' + event.feedback.reason.replaceAll('_', ' ') : ''}${event.feedback.note ? '\n' + event.feedback.note : ''}`;
      $('history').append(node('li', text));
    }
    if (!result.data.length) $('history').append(node('li', 'No reviews yet.'));
  } catch (error) {
    if (sequence === detailSequence)
      $('detail-message').textContent = error.message;
  }
}
function pending(value) {
  busy = value;
  for (const element of $('detail').querySelectorAll(
    'button,input,select,textarea'
  ))
    element.disabled = value;
}
async function mutate(action, data, success) {
  if (busy || !selected) return;
  const item = selected;
  pending(true);
  $('detail-message').textContent = 'Saving…';
  try {
    await api(`/${item.id}/${action}`, data);
    const refreshed = await api(`?job_id=${item.id}`);
    const current = refreshed.data.find((v) => v.id === item.id);
    pending(false);
    if (current) await open(current);
    else {
      $('detail').close();
    }
    $('detail-message').textContent = success;
    if ($('detail').open) $('save').focus();
    await load();
  } catch (error) {
    pending(false);
    $('detail-message').textContent = error.message;
  }
}
function confirmAction(action) {
  if (!selected || busy) return;
  const hide = action === 'hide';
  $('confirm-title').textContent = hide
    ? 'Hide this disc?'
    : 'Use this artwork?';
  $('confirm-text').textContent = hide
    ? 'This removes this disc from the player and pauses automatic replacements. The artwork and your review history stay saved.'
    : 'This publishes the selected version, resolves revision flags for this album, and resumes automatic replacements. Review the source and finished disc first.';
  $('confirm-action').textContent = hide
    ? 'Hide from player'
    : 'Use this artwork';
  $('confirm-action').onclick = () => {
    $('confirm').close();
    mutate(
      action,
      hide ? {} : { expected_active_job: selected.active_job_id },
      hide ? 'Hidden from the player.' : 'Artwork approved for the player.'
    );
  };
  $('confirm').showModal();
}
for (const button of document.querySelectorAll('[data-filter]'))
  button.addEventListener('click', () => {
    filter = button.dataset.filter;
    page = 1;
    for (const b of document.querySelectorAll('[data-filter]'))
      b.setAttribute('aria-pressed', String(b === button));
    load();
  });
$('previous').addEventListener('click', () => {
  page--;
  load();
});
$('next').addEventListener('click', () => {
  page++;
  load();
});
$('refresh').addEventListener('click', load);
$('close').addEventListener('click', () => {
  $('detail').close();
  detailSequence++;
});
$('detail').addEventListener('cancel', (event) => {
  if (busy) event.preventDefault();
  else detailSequence++;
});
$('preview').addEventListener('change', () =>
  $('render-stage').classList.toggle(
    'on-surface',
    $('preview').value === 'disc'
  )
);
$('feedback-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const status = new FormData(event.currentTarget).get('status');
  mutate(
    'feedback',
    { status, reason: $('reason').value || null, note: $('note').value },
    'Review saved.'
  );
});
$('hide').addEventListener('click', () => confirmAction('hide'));
$('activate').addEventListener('click', () => confirmAction('activate'));
$('cancel-action').addEventListener('click', () => $('confirm').close());
$('more-versions').addEventListener('click', () => {
  versionPage++;
  loadVersions();
});
load();
