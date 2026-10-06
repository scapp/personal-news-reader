(function () {
  'use strict';

  const UNLOCK_KEY = 'pnr_unlocked';
  const READ_KEY = 'pnr_read';
  const REMOVED_KEY = 'pnr_removed';
  const SAVED_KEY = 'pnr_saved';
  const HIDE_READ_KEY = 'pnr_hide_read';
  const THEME_KEY = 'pnr_theme';
  const SYNC_TOKEN_KEY = 'pnr_sync_token';
  const SYNC_META_KEY = 'pnr_sync_meta';
  const UNREAD_CAP = 20;

  const gate = document.getElementById('gate');
  const app = document.getElementById('app');
  const form = document.getElementById('unlock-form');
  const pinInput = document.getElementById('pin-input');
  const gateError = document.getElementById('gate-error');
  const subtitle = document.getElementById('subtitle');
  const leadEl = document.getElementById('lead');
  const feedEl = document.getElementById('feed');
  const emptyEl = document.getElementById('empty');
  const hideReadToggle = document.getElementById('hide-read');
  const refreshBtn = document.getElementById('refresh-btn');
  const refreshStatus = document.getElementById('refresh-status');
  const themeToggle = document.getElementById('theme-toggle');
  const savedToggle = document.getElementById('saved-toggle');
  const undoBar = document.getElementById('undo-bar');
  const undoText = document.getElementById('undo-text');
  const undoBtn = document.getElementById('undo-remove');
  const undoDismiss = document.getElementById('undo-dismiss');

  let auth = null;
  let stories = []; // live home feed = data.json only (≤20)
  let catalog = []; // archive+data merge for Saved lookup
  let updatedLabel = '';
  let syncToken = null;
  let gistFileSha = null;
  let pushTimer = null;
  let syncing = false;
  let viewMode = 'feed';
  let undoRemoveId = null;

  function loadList(key) {
    try {
      const raw = localStorage.getItem(key);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr.map(String) : [];
    } catch (_) {
      return [];
    }
  }

  function saveList(key, arr) {
    localStorage.setItem(key, JSON.stringify([...new Set(arr.map(String))]));
  }

  function readIds() { return new Set(loadList(READ_KEY)); }
  function removedIds() { return new Set(loadList(REMOVED_KEY)); }
  function savedIds() { return new Set(loadList(SAVED_KEY)); }

  function unionLists(a, b) {
    return [...new Set([...(a || []), ...(b || [])].map(String))];
  }

  function currentState() {
    return {
      read: loadList(READ_KEY),
      removed: loadList(REMOVED_KEY),
      saved: loadList(SAVED_KEY),
      updated: new Date().toISOString(),
    };
  }

  function applyState(state, { saveLocal = true } = {}) {
    if (!state || typeof state !== 'object') return;
    const read = unionLists(loadList(READ_KEY), state.read || []);
    const removed = unionLists(loadList(REMOVED_KEY), state.removed || []);
    const hasSaved = Array.isArray(state.saved);
    const saved = hasSaved ? unionLists(loadList(SAVED_KEY), state.saved) : loadList(SAVED_KEY);
    if (saveLocal) {
      saveList(READ_KEY, read);
      saveList(REMOVED_KEY, removed);
      if (hasSaved) saveList(SAVED_KEY, saved);
    }
    return { read, removed, saved };
  }

  async function sha256Hex(text) {
    const data = new TextEncoder().encode(text);
    const digest = await crypto.subtle.digest('SHA-256', data);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  function b64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  async function deriveAesKey(pin, salt, iterations) {
    const base = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(String(pin)),
      'PBKDF2',
      false,
      ['deriveKey']
    );
    return crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: new TextEncoder().encode(String(salt)),
        iterations: iterations || 150000,
        hash: 'SHA-256',
      },
      base,
      { name: 'AES-GCM', length: 256 },
      false,
      ['decrypt']
    );
  }

  async function decryptSyncToken(pin) {
    const sync = auth && auth.sync;
    if (!sync || !sync.tokenEnc || !sync.iv || !sync.tag) {
      throw new Error('Sync is not configured');
    }
    const key = await deriveAesKey(pin, auth.salt, sync.iterations);
    const iv = b64ToBytes(sync.iv);
    const tag = b64ToBytes(sync.tag);
    const data = b64ToBytes(sync.tokenEnc);
    const combined = new Uint8Array(data.length + tag.length);
    combined.set(data, 0);
    combined.set(tag, data.length);
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      key,
      combined
    );
    return new TextDecoder().decode(plain);
  }

  function rememberSyncToken(token) {
    syncToken = token || null;
    try {
      if (token) localStorage.setItem(SYNC_TOKEN_KEY, token);
      else localStorage.removeItem(SYNC_TOKEN_KEY);
    } catch (_) {}
  }

  function loadRememberedSyncToken() {
    try {
      syncToken = localStorage.getItem(SYNC_TOKEN_KEY) || null;
    } catch (_) {
      syncToken = null;
    }
    return syncToken;
  }

  function syncConfigured() {
    return !!(auth && auth.sync && auth.sync.gistId && auth.sync.tokenEnc);
  }

  function gistApiUrl() {
    return `https://api.github.com/gists/${auth.sync.gistId}`;
  }

  function setSyncStatus(msg) {
    if (!refreshStatus) return;
    if (!msg) {
      refreshStatus.hidden = true;
      refreshStatus.textContent = '';
      return;
    }
    refreshStatus.hidden = false;
    refreshStatus.textContent = msg;
  }

  async function pullRemoteState() {
    if (!syncConfigured() || !syncToken) return null;
    const res = await fetch(gistApiUrl(), {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${syncToken}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`Sync pull failed (${res.status})`);
    const gist = await res.json();
    const file =
      (gist.files && (gist.files['reader-state.json'] || Object.values(gist.files)[0])) || null;
    if (!file) return null;
    gistFileSha = file.raw_url || null;
    let parsed = { read: [], removed: [] };
    if (file.content) {
      parsed = JSON.parse(file.content);
    } else if (file.raw_url) {
      const raw = await fetch(file.raw_url + (file.raw_url.includes('?') ? '&' : '?') + '_=' + Date.now(), {
        cache: 'no-store',
        headers: { Authorization: `Bearer ${syncToken}` },
      });
      if (raw.ok) parsed = await raw.json();
    }
    applyState(parsed, { saveLocal: true });
    try {
      localStorage.setItem(
        SYNC_META_KEY,
        JSON.stringify({ pulledAt: Date.now(), updated: parsed.updated || null })
      );
    } catch (_) {}
    return parsed;
  }

  async function pushRemoteState() {
    if (!syncConfigured() || !syncToken) return false;
    const body = currentState();
    const content = JSON.stringify(body, null, 2);
    const res = await fetch(gistApiUrl(), {
      method: 'PATCH',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${syncToken}`,
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({
        files: {
          'reader-state.json': { content },
        },
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Sync push failed (${res.status}) ${text.slice(0, 120)}`);
    }
    return true;
  }

  function schedulePush() {
    if (!syncConfigured() || !syncToken) return;
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(async () => {
      pushTimer = null;
      try {
        await pushRemoteState();
        setSyncStatus('Saved across devices');
        window.setTimeout(() => setSyncStatus(''), 2500);
      } catch (err) {
        console.error(err);
        setSyncStatus('Could not sync. Will keep this device.');
        window.setTimeout(() => setSyncStatus(''), 4000);
      }
    }, 400);
  }

  async function syncNow(reason) {
    if (!syncConfigured() || !syncToken || syncing) return;
    syncing = true;
    try {
      if (reason !== 'push-only') {
        await pullRemoteState();
        render();
      }
      await pushRemoteState();
    } catch (err) {
      console.error(err);
      if (reason === 'boot') {
        setSyncStatus('Sync unavailable — using this device only');
        window.setTimeout(() => setSyncStatus(''), 4000);
      }
    } finally {
      syncing = false;
    }
  }

  function markRead(id) {
    const list = loadList(READ_KEY);
    list.push(id);
    saveList(READ_KEY, list);
    render();
    schedulePush();
  }

  function toggleSaved(id) {
    const list = loadList(SAVED_KEY);
    if (list.includes(id)) saveList(SAVED_KEY, list.filter((x) => x !== id));
    else {
      list.push(id);
      saveList(SAVED_KEY, list);
    }
    render();
    schedulePush();
  }

  function showUndo(id) {
    undoRemoveId = id;
    const story = (catalog.length ? catalog : stories).find((s) => s && s.id === id);
    const title = story && story.headline ? String(story.headline) : 'Story';
    const short = title.length > 90 ? title.slice(0, 87) + '…' : title;
    if (undoText) undoText.textContent = 'Removed: ' + short;
    if (undoBar) undoBar.hidden = false;
  }

  function hideUndo() {
    undoRemoveId = null;
    if (undoBar) undoBar.hidden = true;
  }

  function undoRemove() {
    if (!undoRemoveId) return;
    const id = undoRemoveId;
    saveList(REMOVED_KEY, loadList(REMOVED_KEY).filter((x) => x !== id));
    hideUndo();
    render();
    schedulePush();
  }

  function removeStory(id) {
    const list = loadList(REMOVED_KEY);
    list.push(id);
    saveList(REMOVED_KEY, list);
    render();
    schedulePush();
    showUndo(id);
  }

  function showUnlocked() {
    gate.hidden = true;
    app.hidden = false;
  }

  function showGate() {
    gate.hidden = false;
    app.hidden = true;
    pinInput.focus();
  }

  function escapeHtml(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function imageSrc(story) {
    const local = (story.image_local || '').trim();
    if (local) return local;
    return '';
  }

  function storyActions(id, isRead, isSaved) {
    return `
      <div class="actions">
        <button type="button" data-action="save" data-id="${escapeHtml(id)}" aria-pressed="${isSaved ? 'true' : 'false'}">${isSaved ? 'Saved' : 'Save'}</button>
        <button type="button" data-action="read" data-id="${escapeHtml(id)}">${isRead ? 'Mark unread' : 'Mark read'}</button>
        <button type="button" class="danger" data-action="remove" data-id="${escapeHtml(id)}">Remove</button>
      </div>`;
  }

  function mediaBlock(story, kind) {
    const img = imageSrc(story);
    if (!img) return '';
    const cls = kind === 'lead' ? 'lead-media' : 'thumb';
    const loading = kind === 'lead' ? 'eager' : 'lazy';
    const url = escapeHtml(story.url || '#');
    return `<a class="${cls}" href="${url}" target="_blank" rel="noopener noreferrer"><img src="${escapeHtml(img)}" alt="" loading="${loading}"></a>`;
  }

  function leadHtml(story, isRead, isSaved) {
    const photo = imageSrc(story) ? '' : ' no-photo';
    return `
      <article class="lead-card${isRead ? ' read' : ''}${photo}" data-id="${escapeHtml(story.id)}">
        ${mediaBlock(story, 'lead')}
        <div class="lead-copy">
          <div class="cat">${escapeHtml(story.cat || 'News')}</div>
          <h2><a href="${escapeHtml(story.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(story.headline)}</a></h2>
          <p class="summary">${escapeHtml(story.summary || '')}</p>
          <div class="meta-row"><span class="source">${escapeHtml(story.source || '')}</span></div>
          ${storyActions(story.id, isRead, isSaved)}
        </div>
      </article>`;
  }

  function cardHtml(story, isRead, isSaved) {
    return `
      <article class="story${isRead ? ' read' : ''}" data-id="${escapeHtml(story.id)}">
        ${mediaBlock(story, 'card')}
        <div class="copy">
          <div class="cat">${escapeHtml(story.cat || 'News')}</div>
          <h2><a href="${escapeHtml(story.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(story.headline)}</a></h2>
          <p class="summary">${escapeHtml(story.summary || '')}</p>
          <div class="meta-row"><span class="source">${escapeHtml(story.source || '')}</span></div>
          ${storyActions(story.id, isRead, isSaved)}
        </div>
      </article>`;
  }

  function bindImageErrors(root) {
    if (!root) return;
    root.querySelectorAll('img').forEach((img) => {
      img.addEventListener('error', () => {
        const frame = img.closest('a');
        if (frame) frame.remove();
        const card = img.closest('article');
        if (card) card.classList.add('no-photo');
      });
    });
  }

  function notRemoved(pool) {
    const removed = removedIds();
    const src = pool || stories;
    return src.filter((s) => s && s.id && !removed.has(s.id));
  }

  function visibleStories() {
    const reads = readIds();
    const saved = savedIds();
    const hideRead = !!(hideReadToggle && hideReadToggle.checked);

    // Saved view resolves against the full catalog (archive + live batch).
    if (viewMode === 'saved') {
      return notRemoved(catalog.length ? catalog : stories).filter((s) => saved.has(s.id));
    }

    // Home feed is the published data.json batch only (hard-capped ≤20 at publish).
    const pool = notRemoved(stories);
    const unread = pool.filter((s) => !reads.has(s.id));
    const drop = new Set();
    if (unread.length > UNREAD_CAP) {
      const excess = unread.length - UNREAD_CAP;
      const oldestUnsaved = unread.slice().reverse().filter((s) => !saved.has(s.id));
      oldestUnsaved.slice(0, excess).forEach((s) => drop.add(s.id));
    }

    return pool.filter((s) => {
      if (drop.has(s.id)) return false;
      if (hideRead && reads.has(s.id)) return false;
      return true;
    });
  }

  function render() {
    const visible = visibleStories();
    const reads = readIds();
    const saved = savedIds();
    const totalKnown = notRemoved(stories).length;

    if (viewMode === 'saved') {
      subtitle.textContent = `${updatedLabel || 'Updated recently'} · ${visible.length} saved`;
    } else {
      subtitle.textContent = `${updatedLabel || 'Updated recently'} · ${totalKnown} stor${totalKnown === 1 ? 'y' : 'ies'}`;
    }

    leadEl.innerHTML = '';
    feedEl.innerHTML = '';

    if (!visible.length) {
      emptyEl.hidden = false;
      emptyEl.textContent = viewMode === 'saved'
        ? 'No saved stories yet. Use Save on a card to keep it here.'
        : 'No stories to show. Toggle “Hide read” or open Saved.';
      return;
    }
    emptyEl.hidden = true;

    const [featured, ...rest] = visible;
    leadEl.innerHTML = leadHtml(featured, reads.has(featured.id), saved.has(featured.id));
    feedEl.innerHTML = rest.map((s) => cardHtml(s, reads.has(s.id), saved.has(s.id))).join('');
    bindImageErrors(leadEl);
    bindImageErrors(feedEl);
  }

  function onClick(e) {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const id = btn.getAttribute('data-id');
    const action = btn.getAttribute('data-action');
    if (!id) return;
    if (action === 'remove') {
      removeStory(id);
      return;
    }
    if (action === 'save') {
      toggleSaved(id);
      return;
    }
    if (action === 'read') {
      const reads = loadList(READ_KEY);
      if (reads.includes(id)) {
        saveList(READ_KEY, reads.filter((x) => x !== id));
        render();
        schedulePush();
      } else {
        markRead(id);
      }
    }
  }

  function explicitTheme() {
    try {
      const t = localStorage.getItem(THEME_KEY);
      return t === 'dark' || t === 'light' ? t : null;
    } catch (_) {
      return null;
    }
  }

  function systemDark() {
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  function effectiveTheme() {
    return explicitTheme() || (systemDark() ? 'dark' : 'light');
  }

  function applyTheme() {
    const chosen = explicitTheme();
    if (chosen) document.documentElement.setAttribute('data-theme', chosen);
    else document.documentElement.removeAttribute('data-theme');
    const dark = effectiveTheme() === 'dark';
    if (themeToggle) {
      themeToggle.textContent = dark ? 'Light mode' : 'Dark mode';
      themeToggle.setAttribute('aria-pressed', dark ? 'true' : 'false');
    }
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', dark ? '#0b1220' : '#1e3a8a');
  }

  function toggleTheme() {
    const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem(THEME_KEY, next); } catch (_) {}
    document.documentElement.setAttribute('data-theme', next);
    applyTheme();
  }

  async function tryUnlock(pin) {
    if (!auth) throw new Error('Auth not loaded');
    const hex = await sha256Hex(String(auth.salt) + String(pin));
    return hex === String(auth.pinHash).toLowerCase();
  }

  async function loadJson(path, bust) {
    const url = bust ? `${path}${path.includes('?') ? '&' : '?'}_=${Date.now()}` : path;
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`Failed to load ${path}: ${res.status}`);
    return res.json();
  }

  function setRefreshStatus(msg, show) {
    if (!refreshStatus) return;
    if (!show) {
      refreshStatus.hidden = true;
      refreshStatus.textContent = '';
      return;
    }
    refreshStatus.hidden = false;
    refreshStatus.textContent = msg;
  }

  function mergeStories(data, archive) {
    const byId = new Map();
    const order = [];

    function ingest(list) {
      for (const s of list || []) {
        if (!s || !s.id) continue;
        if (!byId.has(s.id)) {
          byId.set(s.id, s);
          order.push(s.id);
        } else {
          byId.set(s.id, { ...byId.get(s.id), ...s });
        }
      }
    }

    if (archive) {
      if (Array.isArray(archive.order)) {
        for (const id of archive.order) {
          const s = archive.stories && archive.stories[id];
          if (s) {
            const story = { ...s, id: s.id || id };
            if (!byId.has(story.id)) {
              byId.set(story.id, story);
              order.push(story.id);
            }
          }
        }
      } else if (archive.stories && typeof archive.stories === 'object' && !Array.isArray(archive.stories)) {
        ingest(Object.values(archive.stories));
      } else if (Array.isArray(archive.stories)) {
        ingest(archive.stories);
      }
    }

    ingest(data.stories || []);

    const latestIds = (data.stories || []).map((s) => s && s.id).filter(Boolean);
    // archive.order is oldest-first. Feed is newest-first so the unread cap drops the oldest.
    const restOldestFirst = order.filter((id) => !latestIds.includes(id));
    const finalOrder = [...latestIds, ...restOldestFirst.slice().reverse()];
    return finalOrder.map((id) => byId.get(id)).filter(Boolean);
  }

  let wired = false;
  let refreshing = false;
  let lastFetchedAt = 0;

  async function loadStories(bust) {
    const [data, archive] = await Promise.all([
      loadJson('data.json', bust),
      loadJson('archive.json', bust).catch(() => null),
    ]);
    updatedLabel = data.updated || (archive && archive.updated) || '';
    // Live home feed = published data.json only, hard-capped at 20 (publish rule).
    const live = (data.stories || []).filter((s) => s && s.id).slice(0, UNREAD_CAP);
    stories = live;
    // Full catalog keeps archive for Saved stories no longer in the live batch.
    catalog = mergeStories(data, archive);
    lastFetchedAt = Date.now();
    render();
  }

  async function refreshStories(reason) {
    if (refreshing || app.hidden) return;
    refreshing = true;
    if (refreshBtn) refreshBtn.disabled = true;
    setRefreshStatus(reason === 'auto' ? 'Checking for updates…' : 'Refreshing…', true);
    try {
      await loadStories(true);
      if (syncConfigured() && syncToken) {
        await syncNow('refresh');
      }
      const when = new Date().toLocaleTimeString('en-US', {
        timeZone: 'America/New_York',
        hour: 'numeric',
        minute: '2-digit',
      });
      setRefreshStatus(`Updated ${when} ET`, true);
      window.setTimeout(() => setRefreshStatus('', false), 4000);
    } catch (err) {
      console.error(err);
      setRefreshStatus('Refresh failed. Try again.', true);
    } finally {
      refreshing = false;
      if (refreshBtn) refreshBtn.disabled = false;
    }
  }

  function wireUiOnce() {
    if (wired) return;
    wired = true;
    hideReadToggle.checked = localStorage.getItem(HIDE_READ_KEY) === '1';
    hideReadToggle.addEventListener('change', () => {
      localStorage.setItem(HIDE_READ_KEY, hideReadToggle.checked ? '1' : '0');
      render();
    });
    document.addEventListener('click', onClick);
    if (refreshBtn) {
      refreshBtn.addEventListener('click', () => refreshStories('manual'));
    }
    if (themeToggle) themeToggle.addEventListener('click', toggleTheme);
    applyTheme();
    const themeMq = window.matchMedia('(prefers-color-scheme: dark)');
    const onThemeMq = () => {
      if (!explicitTheme()) applyTheme();
    };
    if (themeMq.addEventListener) themeMq.addEventListener('change', onThemeMq);
    else if (themeMq.addListener) themeMq.addListener(onThemeMq);
    if (savedToggle) {
      savedToggle.addEventListener('click', () => {
        viewMode = viewMode === 'saved' ? 'feed' : 'saved';
        savedToggle.setAttribute('aria-pressed', viewMode === 'saved' ? 'true' : 'false');
        savedToggle.textContent = viewMode === 'saved' ? 'Back to feed' : 'Saved';
        render();
      });
    }
    if (undoBtn) undoBtn.addEventListener('click', undoRemove);
    if (undoDismiss) undoDismiss.addEventListener('click', hideUndo);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && !app.hidden) {
        if (Date.now() - lastFetchedAt > 30 * 1000) refreshStories('auto');
      }
    });
    window.addEventListener('pageshow', (e) => {
      if (e.persisted && !app.hidden) refreshStories('auto');
    });
  }

  async function bootApp() {
    wireUiOnce();
    loadRememberedSyncToken();
    await loadStories(true);
    if (syncConfigured() && syncToken) {
      await syncNow('boot');
      render();
    }
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    gateError.hidden = true;
    const pin = pinInput.value;
    try {
      const ok = await tryUnlock(pin);
      if (!ok) {
        gateError.hidden = false;
        pinInput.select();
        return;
      }
      if (syncConfigured()) {
        try {
          const token = await decryptSyncToken(pin);
          rememberSyncToken(token);
        } catch (syncErr) {
          console.error(syncErr);
          gateError.textContent = 'Unlocked, but device sync could not start. Reload and try again.';
          gateError.hidden = false;
        }
      }
      sessionStorage.setItem(UNLOCK_KEY, '1');
      try { localStorage.setItem(UNLOCK_KEY, '1'); } catch (_) {}
      pinInput.value = '';
      showUnlocked();
      await bootApp();
    } catch (err) {
      gateError.textContent = 'Could not unlock. Reload and try again.';
      gateError.hidden = false;
      console.error(err);
    }
  });

  async function init() {
    applyTheme();
    try {
      auth = await loadJson('auth.json');
    } catch (err) {
      gateError.textContent = 'Auth config missing.';
      gateError.hidden = false;
      showGate();
      console.error(err);
      return;
    }

    loadRememberedSyncToken();
    const unlocked = sessionStorage.getItem(UNLOCK_KEY) === '1'
      || (function () { try { return localStorage.getItem(UNLOCK_KEY) === '1'; } catch (_) { return false; } })();

    if (unlocked && syncConfigured() && !syncToken) {
      showGate();
      gateError.textContent = 'Enter your PIN once to turn on sync across devices.';
      gateError.hidden = false;
      return;
    }

    if (unlocked) {
      try { sessionStorage.setItem(UNLOCK_KEY, '1'); } catch (_) {}
      showUnlocked();
      try {
        await bootApp();
      } catch (err) {
        subtitle.textContent = 'Failed to load stories.';
        console.error(err);
      }
    } else {
      showGate();
    }
  }

  init();
})();
