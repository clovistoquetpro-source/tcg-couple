import { SUPABASE_URL, SUPABASE_KEY, LOGIN_DOMAIN, COOLDOWN_HOURS } from './config.js';

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true },
});

const COOLDOWN_MS = COOLDOWN_HOURS * 3600 * 1000;
const BUCKET = 'cards';

const RARITIES = [
  { id: 'commune', label: 'Common', stars: 1 },
  { id: 'peu_commune', label: 'Uncommon', stars: 2 },
  { id: 'rare', label: 'Rare', stars: 3 },
  { id: 'epique', label: 'Epic', stars: 4 },
  { id: 'legendaire', label: 'Legendary', stars: 5 },
];
const RARITY = Object.fromEntries(RARITIES.map((r, i) => [r.id, { ...r, rank: i }]));

// Versions spéciales : Holo pour les épiques, Gold pour les légendaires
const VARIANTS = { normal: 'Normal', holo: 'Holo', gold: 'Gold' };
const SPECIAL = { epique: 'holo', legendaire: 'gold' };
const variantsFor = (rarity) => (SPECIAL[rarity] ? ['normal', SPECIAL[rarity]] : ['normal']);
const bestVariant = (entry) => (entry.variants.gold ? 'gold' : entry.variants.holo ? 'holo' : 'normal');

const state = {
  session: null,
  me: null,          // profil de l'utilisateur connecté
  profiles: [],      // les deux profils
  cards: [],         // toutes les cartes
  owned: new Map(),  // userId -> Map(cardId -> {count, first_pulled_at})
  viewUser: null,    // collection affichée
  filter: 'all',
  timer: null,
};

const $app = document.getElementById('app');
const $nav = document.getElementById('nav');

/* ---------- utilitaires ---------- */

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function toast(msg, kind = '') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = `show ${kind}`;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.className = ''), 3200);
}

function fmtDuration(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return [h, m, sec].map((n) => String(n).padStart(2, '0')).join(':');
}

function nextPackAt(profile) {
  if (!profile?.last_pack_at) return 0;
  return new Date(profile.last_pack_at).getTime() + COOLDOWN_MS;
}

function firstEmoji(s) {
  const m = String(s || '').match(/\p{Extended_Pictographic}/u);
  return m ? m[0] : '♡';
}

/* ---------- images (URLs signées mises en cache pour profiter du cache navigateur) ---------- */

const URL_TTL = 7 * 24 * 3600; // 7 jours
const urlCache = (() => {
  try { return JSON.parse(localStorage.getItem('urlCache') || '{}'); } catch { return {}; }
})();

async function signedUrls(paths) {
  const now = Date.now();
  const missing = [...new Set(paths.filter(Boolean))].filter((p) => !(urlCache[p] && urlCache[p].exp - now > 24 * 3600 * 1000));
  if (missing.length) {
    const { data, error } = await sb.storage.from(BUCKET).createSignedUrls(missing, URL_TTL);
    if (!error) {
      for (const d of data) if (d.signedUrl) urlCache[d.path] = { url: d.signedUrl, exp: now + URL_TTL * 1000 };
      try { localStorage.setItem('urlCache', JSON.stringify(urlCache)); } catch { /* stockage indisponible */ }
    }
  }
  return (p) => urlCache[p]?.url || '';
}

/* ---------- rendu d'une carte ---------- */

function cardNumber(card) {
  const i = state.cards.findIndex((c) => c.id === card.id);
  return `#${String(i + 1).padStart(3, '0')}`;
}

function cardHTML(card, url, opts = {}) {
  const r = RARITY[card.rarity];
  const v = opts.variant && opts.variant !== 'normal' ? opts.variant : '';
  const art = card.image_path && url(card.image_path)
    ? `<img src="${esc(url(card.image_path))}" alt="" loading="lazy" draggable="false">`
    : `<div class="placeholder">${esc(firstEmoji(card.description))}</div>`;
  return `
    <div class="card r-${r.id}${v ? ` v-${v}` : ''}${opts.big ? ' big' : ''}" data-id="${card.id}">
      <div class="card-face">
        <div class="card-head"><span class="card-title">${esc(card.title)}</span>${opts.count > 1 ? `<span class="count">×${opts.count}</span>` : ''}</div>
        <div class="card-art">${art}${v ? `<span class="vbadge">${VARIANTS[v]}</span>` : ''}${opts.isNew ? '<span class="new">New</span>' : ''}</div>
        ${card.description ? `<div class="card-desc">${esc(card.description)}</div>` : ''}
        <div class="card-foot"><span class="stars">${'★'.repeat(r.stars)}</span><span>${r.label}</span><span class="num">${cardNumber(card)}</span></div>
      </div>
      <div class="holo"></div>
    </div>`;
}

function lockedCardHTML(card) {
  return `<div class="card locked r-${card.rarity}" aria-label="Card not collected yet"><div class="card-face"><div class="q">?</div><div class="card-foot"><span class="stars">${'★'.repeat(RARITY[card.rarity].stars)}</span></div></div></div>`;
}

function attachTilt(el) {
  const move = (x, y) => {
    const b = el.getBoundingClientRect();
    const px = (x - b.left) / b.width, py = (y - b.top) / b.height;
    el.style.setProperty('--rx', `${(0.5 - py) * 18}deg`);
    el.style.setProperty('--ry', `${(px - 0.5) * 22}deg`);
    el.style.setProperty('--mx', `${px * 100}%`);
    el.style.setProperty('--my', `${py * 100}%`);
  };
  el.addEventListener('pointermove', (e) => move(e.clientX, e.clientY));
  el.addEventListener('touchmove', (e) => { const t = e.touches[0]; move(t.clientX, t.clientY); }, { passive: true });
  el.addEventListener('pointerleave', () => { el.style.setProperty('--rx', '0deg'); el.style.setProperty('--ry', '0deg'); });
}

// owned : { count, variants: {normal, holo, gold}, first_pulled_at } pour afficher les versions possédées
async function showCardModal(card, { variant = 'normal', extra = '', owned = null } = {}) {
  const url = await signedUrls([card.image_path]);
  const m = document.createElement('div');
  m.className = 'modal';
  const versions = owned && variantsFor(card.rarity).length > 1
    ? `<div class="seg versions">${variantsFor(card.rarity).map((v) => `<button data-variant="${v}" aria-selected="${v === variant}" ${owned.variants[v] ? '' : 'disabled'}>${VARIANTS[v]} ${owned.variants[v] ? `×${owned.variants[v]}` : '🔒'}</button>`).join('')}</div>`
    : '';
  m.innerHTML = `<div class="modal-inner"><div class="modal-card">${cardHTML(card, url, { big: true, variant })}</div>${versions}<div class="modal-extra">${extra}</div><button class="btn ghost" data-close>Close</button></div>`;
  document.body.appendChild(m);
  attachTilt(m.querySelector('.card'));
  m.querySelectorAll('[data-variant]').forEach((b) => b.addEventListener('click', () => {
    m.querySelectorAll('[data-variant]').forEach((x) => x.setAttribute('aria-selected', x === b));
    m.querySelector('.modal-card').innerHTML = cardHTML(card, url, { big: true, variant: b.dataset.variant });
    attachTilt(m.querySelector('.card'));
  }));
  requestAnimationFrame(() => m.classList.add('open'));
  m.addEventListener('click', (e) => {
    if (e.target === m || e.target.closest('[data-close]')) { m.classList.remove('open'); setTimeout(() => m.remove(), 250); }
  });
}

/* ---------- données ---------- */

async function loadAll() {
  const [p, c, o] = await Promise.all([
    sb.from('profiles').select('*').order('created_at'),
    sb.from('cards').select('*').order('id'),
    sb.from('user_cards').select('*'),
  ]);
  if (p.error || c.error || o.error) throw p.error || c.error || o.error;
  state.profiles = p.data;
  state.me = p.data.find((x) => x.id === state.session.user.id) || { id: state.session.user.id, display_name: '', last_pack_at: null };
  state.cards = c.data.sort((a, b) => RARITY[a.rarity].rank - RARITY[b.rarity].rank || a.id - b.id);
  state.owned = new Map();
  for (const row of o.data) {
    if (!state.owned.has(row.user_id)) state.owned.set(row.user_id, new Map());
    const mine = state.owned.get(row.user_id);
    const e = mine.get(row.card_id) || { count: 0, variants: {}, first_pulled_at: row.first_pulled_at };
    e.count += row.count;
    e.variants[row.variant || 'normal'] = row.count;
    if (row.first_pulled_at < e.first_pulled_at) e.first_pulled_at = row.first_pulled_at;
    mine.set(row.card_id, e);
  }
  if (!state.viewUser) state.viewUser = state.me.id;
}

const partner = () => state.profiles.find((p) => p.id !== state.me.id);

/* ---------- pages ---------- */

function renderLogin() {
  $nav.hidden = true;
  $app.innerHTML = `
    <section class="login">
      <div class="logo">${backHTML()}</div>
      <h1>Our Cards</h1>
      <p class="muted">Our collection, just for the two of us.</p>
      <form id="login-form" class="stack">
        <label>Username<input name="pseudo" autocomplete="username" autocapitalize="none" required></label>
        <label>Password<input name="password" type="password" autocomplete="current-password" required></label>
        <button class="btn primary" type="submit">Sign in</button>
      </form>
    </section>`;
  document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const btn = e.target.querySelector('button');
    btn.disabled = true;
    const email = `${String(f.get('pseudo')).trim().toLowerCase()}@${LOGIN_DOMAIN}`;
    const { error } = await sb.auth.signInWithPassword({ email, password: f.get('password') });
    btn.disabled = false;
    if (error) toast('Wrong username or password', 'err');
  });
}

function backHTML() {
  return `<div class="card-back"><div class="emblem">♥</div></div>`;
}

async function renderBooster() {
  const next = nextPackAt(state.me);
  const ready = Date.now() >= next;
  const other = partner();
  const otherReady = other && Date.now() >= nextPackAt(other);

  $app.innerHTML = `
    <section class="booster-page">
      <header class="page-head">
        <h1>Pack</h1>
        <p class="muted">${state.cards.length} cards to collect</p>
      </header>
      <div class="pack-zone">
        <button class="pack${ready ? ' ready' : ''}" id="pack" ${ready ? '' : 'disabled'} aria-label="Open the pack">
          <span class="pack-top"></span>
          <span class="pack-body">
            <span class="pack-emblem">♥</span>
            <span class="pack-name">Our Cards</span>
            <span class="pack-sub">5 cards</span>
          </span>
        </button>
        <div class="pack-cta">
          ${ready
            ? `<p class="big">Your pack is ready</p><p class="muted">Tap it to open</p>`
            : `<p class="muted">Next pack in</p><p class="countdown" id="countdown">${fmtDuration(next - Date.now())}</p>`}
        </div>
      </div>
      ${other ? `<p class="partner muted">${esc(other.display_name || 'Your partner')} ${otherReady ? 'has a pack waiting ✦' : `can open their next pack in ${fmtDuration(nextPackAt(other) - Date.now()).slice(0, 5).replace(':', 'h ')}m`}</p>` : ''}
      <div id="reveal"></div>
    </section>`;

  clearInterval(state.timer);
  if (!ready) {
    state.timer = setInterval(() => {
      const left = nextPackAt(state.me) - Date.now();
      const el = document.getElementById('countdown');
      if (!el) return clearInterval(state.timer);
      if (left <= 0) { clearInterval(state.timer); renderBooster(); return; }
      el.textContent = fmtDuration(left);
    }, 1000);
  }

  const packBtn = document.getElementById('pack');
  if (ready) packBtn.addEventListener('click', () => openPack(packBtn), { once: true });
}

async function openPack(packBtn) {
  packBtn.classList.add('shake');
  const { data, error } = await sb.rpc('open_pack');
  if (error) {
    packBtn.classList.remove('shake');
    const m = /COOLDOWN:(\S+)/.exec(error.message);
    if (m) { state.me.last_pack_at = new Date(new Date(m[1]).getTime() - COOLDOWN_MS).toISOString(); renderBooster(); return; }
    toast(/Aucune carte/.test(error.message) ? 'No cards yet: add some photos first' : error.message || 'Could not open the pack', 'err');
    renderBooster();
    return;
  }
  state.me.last_pack_at = new Date().toISOString();
  loadAll().catch(() => {});

  const url = await signedUrls(data.map((c) => c.image_path));
  // on révèle de la moins rare à la plus rare
  const score = (c) => RARITY[c.rarity].rank + (c.variant && c.variant !== 'normal' ? 0.5 : 0);
  const pulled = data.map((c, i) => ({ ...c, i })).sort((a, b) => score(a) - score(b) || a.i - b.i);

  packBtn.classList.remove('shake');
  packBtn.classList.add('torn');
  await new Promise((r) => setTimeout(r, 650));

  const page = document.querySelector('.booster-page');
  page.classList.add('revealing');
  const reveal = document.getElementById('reveal');
  reveal.innerHTML = `
    <div class="reveal-grid">
      ${pulled.map((c, i) => `
        <div class="flip" style="--d:${i * 90}ms" data-rarity="${c.rarity}" data-variant="${c.variant || 'normal'}" tabindex="0" role="button" aria-label="Flip the card">
          <div class="flip-inner">
            <div class="flip-back">${backHTML()}</div>
            <div class="flip-front">${cardHTML(c, url, { isNew: c.is_new, variant: c.variant })}</div>
          </div>
        </div>`).join('')}
    </div>
    <div class="reveal-actions">
      <button class="btn ghost" id="flip-all">Flip all</button>
      <a class="btn primary" href="#/collection" id="to-collection" hidden>See my collection</a>
    </div>`;

  const flips = [...reveal.querySelectorAll('.flip')];
  const done = () => {
    if (flips.every((f) => f.classList.contains('flipped'))) {
      document.getElementById('flip-all').hidden = true;
      document.getElementById('to-collection').hidden = false;
      const news = pulled.filter((c) => c.is_new).length;
      const special = pulled.find((c) => c.variant === 'gold') || pulled.find((c) => c.variant === 'holo');
      toast(special ? `A ${VARIANTS[special.variant]} card!` : news ? `${news} new card${news > 1 ? 's' : ''}!` : 'Only duplicates this time');
    }
  };
  const flip = (f) => {
    if (f.classList.contains('flipped')) {
      const card = pulled[flips.indexOf(f)];
      showCardModal(card, { variant: card.variant });
      return;
    }
    f.classList.add('flipped');
    if (RARITY[f.dataset.rarity].rank >= 2 || f.dataset.variant !== 'normal') f.classList.add('burst');
    done();
  };
  flips.forEach((f) => {
    f.addEventListener('click', () => flip(f));
    f.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); flip(f); } });
  });
  document.getElementById('flip-all').addEventListener('click', () => {
    flips.filter((f) => !f.classList.contains('flipped')).forEach((f, i) => setTimeout(() => flip(f), i * 220));
  });
}

async function renderCollection() {
  const viewing = state.profiles.find((p) => p.id === state.viewUser) || state.me;
  const owned = state.owned.get(viewing.id) || new Map();
  const total = state.cards.length;
  const have = state.cards.filter((c) => owned.has(c.id)).length;
  const specials = Object.entries(SPECIAL).map(([rarity, v]) => {
    const pool = state.cards.filter((c) => c.rarity === rarity);
    return pool.length ? `<span class="pill v-${v}">${VARIANTS[v]} ${pool.filter((c) => owned.get(c.id)?.variants[v]).length}/${pool.length}</span>` : '';
  }).join('');
  const list = state.cards.filter((c) => state.filter === 'all' || c.rarity === state.filter);
  const url = await signedUrls(list.filter((c) => owned.has(c.id)).map((c) => c.image_path));

  $app.innerHTML = `
    <section>
      <header class="page-head">
        <h1>Collection</h1>
        <div class="seg" role="tablist">
          ${state.profiles.map((p) => `<button role="tab" aria-selected="${p.id === viewing.id}" data-user="${p.id}">${p.id === state.me.id ? 'Me' : esc(p.display_name || 'Partner')}</button>`).join('')}
        </div>
      </header>
      <div class="progress"><div class="bar"><span style="width:${total ? (have / total) * 100 : 0}%"></span></div><span>${have} / ${total}</span></div>
      ${specials ? `<div class="pills">${specials}</div>` : ''}
      <div class="chips">
        <button class="chip" aria-pressed="${state.filter === 'all'}" data-filter="all">All</button>
        ${RARITIES.map((r) => {
          const n = state.cards.filter((c) => c.rarity === r.id);
          const h = n.filter((c) => owned.has(c.id)).length;
          return `<button class="chip r-${r.id}" aria-pressed="${state.filter === r.id}" data-filter="${r.id}">${r.label} <small>${h}/${n.length}</small></button>`;
        }).join('')}
      </div>
      ${list.length ? `<div class="grid">${list.map((c) => owned.has(c.id) ? cardHTML(c, url, { count: owned.get(c.id).count, variant: bestVariant(owned.get(c.id)) }) : lockedCardHTML(c)).join('')}</div>`
        : `<p class="empty muted">No cards here yet.</p>`}
    </section>`;

  $app.querySelectorAll('[data-user]').forEach((b) => b.addEventListener('click', () => { state.viewUser = b.dataset.user; renderCollection(); }));
  $app.querySelectorAll('[data-filter]').forEach((b) => b.addEventListener('click', () => { state.filter = b.dataset.filter; renderCollection(); }));
  $app.querySelectorAll('.grid .card:not(.locked)').forEach((el) => el.addEventListener('click', () => {
    const card = state.cards.find((c) => c.id === Number(el.dataset.id));
    const o = owned.get(card.id);
    showCardModal(card, {
      variant: bestVariant(o),
      owned: o,
      extra: `<p class="muted">Collected on ${new Date(o.first_pulled_at).toLocaleDateString('en-US', { day: 'numeric', month: 'long', year: 'numeric' })}${o.count > 1 ? ` · ${o.count} copies` : ''}</p>`,
    });
  }));
}

/* ---------- ajout de photos ---------- */

async function compressImage(file, maxSide = 1200) {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => null);
  const src = bmp || await new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = rej;
    img.src = URL.createObjectURL(file);
  });
  const w = src.width, h = src.height;
  const k = Math.min(1, maxSide / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * k);
  canvas.height = Math.round(h * k);
  canvas.getContext('2d').drawImage(src, 0, 0, canvas.width, canvas.height);
  let blob = await new Promise((r) => canvas.toBlob(r, 'image/webp', 0.82));
  if (!blob || blob.type !== 'image/webp') blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.85));
  return blob;
}

function rarityOptions(selected) {
  return RARITIES.map((r) => `<option value="${r.id}"${r.id === selected ? ' selected' : ''}>${r.label}</option>`).join('');
}

async function renderAjouter() {
  const url = await signedUrls(state.cards.map((c) => c.image_path));
  const counts = RARITIES.map((r) => `<span class="pill r-${r.id}">${r.label} ${state.cards.filter((c) => c.rarity === r.id).length}</span>`).join('');

  $app.innerHTML = `
    <section>
      <header class="page-head"><h1>Add cards</h1></header>
      <form id="add-form" class="panel stack">
        <label class="drop">
          <input type="file" id="files" accept="image/*" multiple hidden>
          <span class="drop-ico">＋</span>
          <span>Choose photos</span>
          <small class="muted">They are compressed automatically</small>
        </label>
        <div id="pending" class="stack"></div>
        <button class="btn primary" id="upload" type="submit" hidden>Add</button>
      </form>

      <h2>All cards <small class="muted">(${state.cards.length})</small></h2>
      <div class="pills">${counts}</div>
      <div class="manage">
        ${state.cards.map((c) => `
          <div class="row" data-id="${c.id}">
            <div class="thumb r-${c.rarity}">${c.image_path && url(c.image_path) ? `<img src="${esc(url(c.image_path))}" alt="" loading="lazy">` : `<span>${esc(firstEmoji(c.description))}</span>`}</div>
            <div class="row-main">
              <input class="row-title" value="${esc(c.title)}" aria-label="Title">
              <select class="row-rarity" aria-label="Rarity">${rarityOptions(c.rarity)}</select>
            </div>
            <button class="icon-btn danger" data-del aria-label="Delete">✕</button>
          </div>`).join('')}
      </div>
    </section>`;

  const files = document.getElementById('files');
  const pending = document.getElementById('pending');
  const uploadBtn = document.getElementById('upload');
  let items = [];

  files.addEventListener('change', () => {
    items = [...files.files].map((f) => ({ file: f, preview: URL.createObjectURL(f) }));
    pending.innerHTML = items.map((it, i) => `
      <div class="pending-row" data-i="${i}">
        <img src="${it.preview}" alt="">
        <div class="stack tight">
          <input name="title" placeholder="Card title" value="${esc(it.file.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').slice(0, 40))}" required>
          <input name="desc" placeholder="Short description (optional)" maxlength="90">
          <select name="rarity">${rarityOptions('commune')}</select>
        </div>
      </div>`).join('');
    uploadBtn.hidden = !items.length;
    uploadBtn.textContent = `Add ${items.length} card${items.length > 1 ? 's' : ''}`;
  });

  document.getElementById('add-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    uploadBtn.disabled = true;
    let ok = 0;
    for (const [i, it] of items.entries()) {
      const row = pending.querySelector(`[data-i="${i}"]`);
      uploadBtn.textContent = `Uploading ${i + 1} / ${items.length}…`;
      try {
        const blob = await compressImage(it.file);
        const ext = blob.type === 'image/webp' ? 'webp' : 'jpg';
        const path = `${crypto.randomUUID()}.${ext}`;
        const up = await sb.storage.from(BUCKET).upload(path, blob, { contentType: blob.type, cacheControl: '31536000' });
        if (up.error) throw up.error;
        const ins = await sb.from('cards').insert({
          title: row.querySelector('[name=title]').value.trim() || 'Untitled',
          description: row.querySelector('[name=desc]').value.trim(),
          rarity: row.querySelector('[name=rarity]').value,
          image_path: path,
        });
        if (ins.error) throw ins.error;
        ok++;
      } catch (err) {
        toast(`Error with "${it.file.name}": ${err.message}`, 'err');
      }
    }
    toast(`${ok} card${ok > 1 ? 's' : ''} added`);
    await loadAll();
    renderAjouter();
  });

  $app.querySelectorAll('.manage .row').forEach((row) => {
    const id = Number(row.dataset.id);
    const card = state.cards.find((c) => c.id === id);
    const save = async (patch) => {
      const { error } = await sb.from('cards').update(patch).eq('id', id);
      if (error) return toast(error.message, 'err');
      Object.assign(card, patch);
      row.querySelector('.thumb').className = `thumb r-${card.rarity}`;
      toast('Saved');
    };
    row.querySelector('.row-title').addEventListener('change', (e) => save({ title: e.target.value.trim() || card.title }));
    row.querySelector('.row-rarity').addEventListener('change', (e) => save({ rarity: e.target.value }));
    row.querySelector('[data-del]').addEventListener('click', async () => {
      if (!confirm(`Delete "${card.title}"? It will also disappear from both collections.`)) return;
      const { error } = await sb.from('cards').delete().eq('id', id);
      if (error) return toast(error.message, 'err');
      if (card.image_path) await sb.storage.from(BUCKET).remove([card.image_path]);
      await loadAll();
      renderAjouter();
    });
  });
}

/* ---------- profil ---------- */

function renderProfil() {
  $app.innerHTML = `
    <section>
      <header class="page-head"><h1>Profile</h1></header>
      <form id="name-form" class="panel stack">
        <label>My display name<input name="name" value="${esc(state.me.display_name)}" maxlength="30"></label>
        <button class="btn" type="submit">Save</button>
      </form>
      <form id="pw-form" class="panel stack">
        <label>New password<input name="pw" type="password" minlength="8" autocomplete="new-password" required></label>
        <button class="btn" type="submit">Change password</button>
      </form>
      <div class="panel stack">
        <h2>Install the app</h2>
        <p class="muted"><b>iPhone:</b> in Safari, tap Share then “Add to Home Screen”.<br><b>Android:</b> in Chrome, open the ⋮ menu then “Install app”.</p>
      </div>
      <button class="btn ghost" id="logout">Sign out</button>
    </section>`;
  document.getElementById('name-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = new FormData(e.target).get('name').trim();
    const { error } = await sb.from('profiles').update({ display_name: name }).eq('id', state.me.id);
    if (error) return toast(error.message, 'err');
    state.me.display_name = name;
    toast('Name saved');
  });
  document.getElementById('pw-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const { error } = await sb.auth.updateUser({ password: new FormData(e.target).get('pw') });
    if (error) return toast(error.message, 'err');
    e.target.reset();
    toast('Password changed');
  });
  document.getElementById('logout').addEventListener('click', () => sb.auth.signOut());
}

/* ---------- routeur ---------- */

const routes = { booster: renderBooster, collection: renderCollection, ajouter: renderAjouter, profil: renderProfil };

async function route() {
  clearInterval(state.timer);
  if (!state.session) return renderLogin();
  const name = (location.hash.replace(/^#\/?/, '') || 'booster').split('?')[0];
  const page = routes[name] ? name : 'booster';
  $nav.hidden = false;
  $nav.querySelectorAll('a').forEach((a) => a.classList.toggle('active', a.dataset.route === page));
  try {
    await routes[page]();
  } catch (err) {
    $app.innerHTML = `<section class="panel"><p>Oops: ${esc(err.message)}</p><button class="btn" onclick="location.reload()">Try again</button></section>`;
  }
  window.scrollTo(0, 0);
}

window.addEventListener('hashchange', route);

let booted = false;
async function boot() {
  $app.innerHTML = `<div class="loading">${backHTML()}</div>`;
  try { await loadAll(); } catch (err) { toast(err.message, 'err'); }
  route();
}

// Le rappel ne doit jamais attendre un autre appel Supabase : la bibliothèque garde un verrou
// pendant son exécution, ce qui bloquait le chargement à la réouverture de l'app.
sb.auth.onAuthStateChange((event, session) => {
  const was = state.session?.user?.id;
  state.session = session;
  if (!session) { state.viewUser = null; setTimeout(route, 0); return; }
  if (was === session.user.id && booted) return; // simple rafraîchissement du jeton
  booted = true;
  setTimeout(boot, 0);
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
