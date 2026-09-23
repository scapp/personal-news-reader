(function () {
  'use strict';

  const UNLOCK_KEY = 'pnr_unlocked';
  const READ_KEY = 'pnr_read';
  const REMOVED_KEY = 'pnr_removed';
  const HIDE_READ_KEY = 'pnr_hide_read';

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

  let auth = null;
  let stories = [];
  let updatedLabel = '';

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

  function markRead(id) {
    const list = loadList(READ_KEY);
    list.push(id);
    saveList(READ_KEY, list);
    render();
  }

  function removeStory(id) {
    const list = loadList(REMOVED_KEY);
    list.push(id);
    saveList(REMOVED_KEY, list);
    render();
  }

  async function sha256Hex(text) {
    const data = new TextEncoder().encode(text);
    const digest = await crypto.subtle.digest('SHA-256', data);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
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

  function storyActions(id, isRead) {
    return `
      <div class="actions">
        <button type="button" data-action="read" data-id="${escapeHtml(id)}">${isRead ? 'Mark unread' : 'Mark read'}</button>
        <button type="button" class="danger" data-action="remove" data-id="${escapeHtml(id)}">Remove</button>
      </div>`;
  }

  function mediaBlock(story, kind) {
    // Always emit a media column so grid layout never collapses when a photo is missing.
    const cls = kind === 'lead' ? 'lead-media' : 'thumb';
    const loading = kind === 'lead' ? 'eager' : 'lazy';
    const img = imageSrc(story);
    const cat = escapeHtml(story.cat || 'News');
    const url = escapeHtml(story.url || '#');
    if (img) {
      return `<a class="${cls}" href="${url}" target="_blank" rel="noopener noreferrer"><img src="${escapeHtml(img)}" alt="" loading="${loading}" onerror="this.parentElement.classList.add('placeholder'); this.outerHTML='<span class=\'ph-label\'>${cat}</span>';"></a>`;
    }
    return `<a class="${cls} placeholder" href="${url}" target="_blank" rel="noopener noreferrer" aria-label="${cat}"><span class="ph-label">${cat}</span></a>`;
  }

  function leadHtml(story, isRead) {
    return `
      <article class="lead-card${isRead ? ' read' : ''}" data-id="${escapeHtml(story.id)}">
        ${mediaBlock(story, 'lead')}
        <div class="lead-copy">
          <div class="cat">${escapeHtml(story.cat || 'News')}</div>
          <h2><a href="${escapeHtml(story.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(story.headline)}</a></h2>
          <p class="summary">${escapeHtml(story.summary || '')}</p>
          <div class="meta-row"><span class="source">${escapeHtml(story.source || '')}</span></div>
          ${storyActions(story.id, isRead)}
        </div>
      </article>`;
  }

  function cardHtml(story, isRead) {
    return `
      <article class="story${isRead ? ' read' : ''}" data-id="${escapeHtml(story.id)}">
        ${mediaBlock(story, 'card')}
        <div class="copy">
          <div class="cat">${escapeHtml(story.cat || 'News')}</div>
          <h2><a href="${escapeHtml(story.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(story.headline)}</a></h2>
          <p class="summary">${escapeHtml(story.summary || '')}</p>
          <div class="meta-row"><span class="source">${escapeHtml(story.source || '')}</span></div>
          ${storyActions(story.id, isRead)}
        </div>
      </article>`;
  }

  function visibleStories() {
    const removed = removedIds();
    const reads = readIds();
    const hideRead = hideReadToggle.checked;
    return stories.filter((s) => {
      if (!s || !s.id) return false;
      if (removed.has(s.id)) return false;
      if (hideRead && reads.has(s.id)) return false;
      return true;
    });
  }

  function render() {
    const visible = visibleStories();
    const totalKnown = stories.filter((s) => s && s.id && !removedIds().has(s.id)).length;
    const reads = readIds();

    subtitle.textContent = `${updatedLabel || 'Updated recently'} · ${totalKnown} stor${totalKnown === 1 ? 'y' : 'ies'}`;

    leadEl.innerHTML = '';
    feedEl.innerHTML = '';

    if (!visible.length) {
      emptyEl.hidden = false;
      return;
    }
    emptyEl.hidden = true;

    const [featured, ...rest] = visible;
    leadEl.innerHTML = leadHtml(featured, reads.has(featured.id));
    feedEl.innerHTML = rest.map((s) => cardHtml(s, reads.has(s.id))).join('');
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
    if (action === 'read') {
      const reads = loadList(READ_KEY);
      if (reads.includes(id)) {
        saveList(READ_KEY, reads.filter((x) => x !== id));
      } else {
        markRead(id);
        return;
      }
      render();
    }
  }

  async function tryUnlock(pin) {
    if (!auth) throw new Error('Auth not loaded');
    const hex = await sha256Hex(String(auth.salt) + String(pin));
    return hex === String(auth.pinHash).toLowerCase();
  }

  async function loadJson(path) {
    const res = await fetch(path, { cache: 'no-store' });
    if (!res.ok) throw new Error(`Failed to load ${path}: ${res.status}`);
    return res.json();
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

    // Prefer archive order (accumulating), then any new from data.json
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

    // If data.json has a preferred order for latest batch, put those first while keeping archive rest
    const latestIds = (data.stories || []).map((s) => s && s.id).filter(Boolean);
    const rest = order.filter((id) => !latestIds.includes(id));
    const finalOrder = [...latestIds, ...rest];
    return finalOrder.map((id) => byId.get(id)).filter(Boolean);
  }

  async function bootApp() {
    const [data, archive] = await Promise.all([
      loadJson('data.json'),
      loadJson('archive.json').catch(() => null),
    ]);
    updatedLabel = data.updated || (archive && archive.updated) || '';
    stories = mergeStories(data, archive);
    hideReadToggle.checked = localStorage.getItem(HIDE_READ_KEY) === '1';
    hideReadToggle.addEventListener('change', () => {
      localStorage.setItem(HIDE_READ_KEY, hideReadToggle.checked ? '1' : '0');
      render();
    });
    document.addEventListener('click', onClick);
    render();
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
      sessionStorage.setItem(UNLOCK_KEY, '1');
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
    try {
      auth = await loadJson('auth.json');
    } catch (err) {
      gateError.textContent = 'Auth config missing.';
      gateError.hidden = false;
      showGate();
      console.error(err);
      return;
    }

    if (sessionStorage.getItem(UNLOCK_KEY) === '1') {
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
