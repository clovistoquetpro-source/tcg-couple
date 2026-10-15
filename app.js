import { SUPABASE_URL, SUPABASE_KEY, LOGIN_DOMAIN, COOLDOWN_HOURS } from './config.js';

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true },
});

const cooldownMs = () => Number(state.settings?.cooldown_hours ?? COOLDOWN_HOURS) * 3600 * 1000;
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

const maxPacks = () => Math.max(1, Number(state.settings?.max_stored_packs ?? 2));

// Packs gratuits en réserve : un de plus à chaque délai écoulé depuis pack_clock, jusqu'à maxPacks().
function packStatus(profile) {
  const cd = cooldownMs(), cap = maxPacks(), now = Date.now();
  const clock = profile?.pack_clock ?? profile?.last_pack_at;
  const start = clock ? new Date(clock).getTime() : -Infinity;
  if (start <= now - cap * cd) return { avail: cap, cap, next: null, start: now - cap * cd };
  const avail = Math.floor((now - start) / cd);
  return { avail, cap, next: start + (avail + 1) * cd, start };
}

const fmtShort = (ms) => fmtDuration(ms).slice(0, 5).replace(':', 'h ') + 'm';

/* ---------- taux de drop (lus dans game_settings, les mêmes que ceux du serveur) ---------- */

function dropRates() {
  const s = state.settings || {};
  const w = Object.fromEntries(RARITIES.map((r) => [r.id, Number(s[`rate_${r.id}`] ?? 0)]));
  const total = Object.values(w).reduce((a, b) => a + b, 0) || 1;
  const slot = Object.fromEntries(RARITIES.map((r) => [r.id, w[r.id] / total]));
  // la 5e carte est au moins peu commune
  const last = { ...slot, peu_commune: slot.peu_commune + slot.commune, commune: 0 };
  const special = { holo: Number(s.holo_chance ?? 0) / 100, gold: Number(s.gold_chance ?? 0) / 100 };
  return { slot, last, special };
}

// chance d'avoir au moins une fois l'événement dans un pack, avec p par carte (4 premières) et pLast (5e)
const perPack = (p, pLast) => 1 - (1 - p) ** 4 * (1 - pLast);

function cardChance(card, variant = 'normal') {
  const { slot, last, special } = dropRates();
  const n = state.cards.filter((c) => c.rarity === card.rarity).length || 1;
  let k = 1 / n;
  if (SPECIAL[card.rarity]) k *= variant === 'normal' ? 1 - special[SPECIAL[card.rarity]] : special[variant];
  return perPack(slot[card.rarity] * k, last[card.rarity] * k);
}

function fmtPct(p) {
  const v = p * 100;
  if (v === 0) return '0%';
  return `${v.toLocaleString('en-US', { maximumFractionDigits: v < 1 ? 2 : 1 })}%`;
}

const COIN = '🪙';
const packPrice = () => Number(state.settings?.pack_price ?? 150);
const coinValue = (rarity) => Number(state.settings?.[`coins_${rarity}`] ?? 0);

function showRatesModal() {
  const { slot, last, special } = dropRates();
  const count = (r) => state.cards.filter((c) => c.rarity === r).length;
  const rows = RARITIES.map((r) => `
    <tr><td><span class="pill r-${r.id}">${r.label}</span></td><td>${fmtPct(slot[r.id])}</td><td>${fmtPct(perPack(slot[r.id], last[r.id]))}</td><td>${count(r.id)}</td></tr>`).join('');
  const specialRows = Object.entries(SPECIAL).map(([r, v]) => `
    <tr><td><span class="pill v-${v}">${VARIANTS[v]}</span></td><td>${fmtPct(slot[r] * special[v])}</td><td>${fmtPct(perPack(slot[r] * special[v], last[r] * special[v]))}</td><td class="muted">${fmtPct(special[v])} of ${{ epique: 'epics', legendaire: 'legendaries' }[r]}</td></tr>`).join('');
  const m = document.createElement('div');
  m.className = 'modal';
  m.innerHTML = `
    <div class="modal-inner wide panel">
      <h2>Drop rates</h2>
      <table class="rates">
        <thead><tr><th>Rarity</th><th>Per card</th><th>At least 1 per pack</th><th>Cards</th></tr></thead>
        <tbody>${rows}${specialRows}</tbody>
      </table>
      <p class="muted small">Each pack has 5 cards. The 5th card is always Uncommon or better. A free pack every ${Number(state.settings?.cooldown_hours ?? COOLDOWN_HOURS)} h, and up to ${maxPacks()} can stack up while you wait. Tap any card to see its own drop chance.</p>
      <h2>Coins</h2>
      <p class="muted small">Every duplicate gives coins: ${RARITIES.map((r) => `${r.label} ${coinValue(r.id)}`).join(', ')}. Holo and Gold duplicates give twice as much. A pack costs ${packPrice()} ${COIN}.</p>
      <button class="btn ghost" data-close>Close</button>
    </div>`;
  document.body.appendChild(m);
  requestAnimationFrame(() => m.classList.add('open'));
  m.addEventListener('click', (e) => {
    if (e.target === m || e.target.closest('[data-close]')) { m.classList.remove('open'); setTimeout(() => m.remove(), 250); }
  });
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
        <div class="card-art">${art}${v ? `<span class="vbadge">${VARIANTS[v]}</span>` : ''}${opts.isNew ? '<span class="new">New</span>' : opts.coins ? `<span class="new coin">+${opts.coins} ${COIN}</span>` : ''}</div>
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
  const chance = (v) => `Drop chance${v !== 'normal' ? ` (${VARIANTS[v]})` : ''}: ${fmtPct(cardChance(card, v))} per pack`;
  m.innerHTML = `<div class="modal-inner"><div class="modal-card">${cardHTML(card, url, { big: true, variant })}</div>${versions}<div class="modal-extra">${extra}<p class="muted small" id="chance">${chance(variant)}</p></div><button class="btn ghost" data-close>Close</button></div>`;
  document.body.appendChild(m);
  attachTilt(m.querySelector('.card'));
  m.querySelectorAll('[data-variant]').forEach((b) => b.addEventListener('click', () => {
    m.querySelectorAll('[data-variant]').forEach((x) => x.setAttribute('aria-selected', x === b));
    m.querySelector('#chance').textContent = chance(b.dataset.variant);
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
  const [p, c, o, g] = await Promise.all([
    sb.from('profiles').select('*').order('created_at'),
    sb.from('cards').select('*').order('id'),
    sb.from('user_cards').select('*'),
    sb.from('game_settings').select('*').eq('id', 1).maybeSingle(),
  ]);
  if (p.error || c.error || o.error) throw p.error || c.error || o.error;
  if (g.data) state.settings = g.data;
  state.profiles = p.data;
  state.me = p.data.find((x) => x.id === state.session.user.id) || { id: state.session.user.id, display_name: '', last_pack_at: null };
  state.cards = c.data.sort((a, b) => RARITY[a.rarity].rank - RARITY[b.rarity].rank || a.id - b.id);
  state.owned = new Map();
  for (const row of o.data) {
    if (row.count <= 0) continue; // carte retirée de la collection
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
  const mine = packStatus(state.me);
  const ready = mine.avail > 0;
  const other = partner();
  const theirs = other && packStatus(other);

  $app.innerHTML = `
    <section class="booster-page">
      <header class="page-head">
        <h1>Pack</h1>
        <p class="coins" id="coins" title="Your coins">${Number(state.me.coins ?? 0)} ${COIN}</p>
      </header>
      <div class="pack-zone">
        <button class="pack${ready ? ' ready' : ''}${mine.avail > 1 ? ' stacked' : ''}" id="pack" ${ready ? '' : 'disabled'} aria-label="Open the pack">
          ${mine.avail > 1 ? `<span class="pack-count">×${mine.avail}</span>` : ''}
          <span class="pack-top"></span>
          <span class="pack-body">
            <span class="pack-emblem">♥</span>
            <span class="pack-name">Our Cards</span>
            <span class="pack-sub">5 cards</span>
          </span>
        </button>
        <div class="pack-cta">
          ${ready
            ? `<p class="big">${mine.avail > 1 ? `${mine.avail} packs ready` : 'Your pack is ready'}</p><p class="muted">Tap to open${mine.next ? ` · next one in <span id="countdown">${fmtDuration(mine.next - Date.now())}</span>` : ''}</p>`
            : `<p class="muted">Next pack in</p><p class="countdown" id="countdown">${fmtDuration(mine.next - Date.now())}</p>`}
          <div class="shop">
            <button class="btn buy" id="buy-btn" type="button" ${Number(state.me.coins ?? 0) >= packPrice() ? '' : 'disabled'}>Buy a pack · ${packPrice()} ${COIN}</button>
            ${Number(state.me.coins ?? 0) >= packPrice() ? '' : `<p class="muted small">${packPrice() - Number(state.me.coins ?? 0)} ${COIN} to go. Duplicates give coins.</p>`}
          </div>
          <button class="link-btn" id="rates-btn" type="button">Drop rates</button>
        </div>
      </div>
      ${other ? `<p class="partner muted">${esc(other.display_name || 'Your partner')} ${theirs.avail > 1 ? `has ${theirs.avail} packs waiting ✦` : theirs.avail === 1 ? 'has a pack waiting ✦' : `can open their next pack in ${fmtShort(theirs.next - Date.now())}`}</p>` : ''}
      <div id="reveal"></div>
    </section>`;

  clearInterval(state.timer);
  if (mine.next) {
    state.timer = setInterval(() => {
      const left = mine.next - Date.now();
      const el = document.getElementById('countdown');
      if (!el) return clearInterval(state.timer);
      if (left <= 0) { clearInterval(state.timer); renderBooster(); return; }
      el.textContent = fmtDuration(left);
    }, 1000);
  }

  document.getElementById('rates-btn').addEventListener('click', showRatesModal);
  const packBtn = document.getElementById('pack');
  if (ready) packBtn.addEventListener('click', () => openPack(packBtn), { once: true });
  document.getElementById('buy-btn').addEventListener('click', () => {
    if (!confirm(`Buy a pack for ${packPrice()} coins?`)) return;
    packBtn.disabled = true;
    packBtn.classList.add('ready');
    openPack(packBtn, true);
  }, { once: true });
}

async function openPack(packBtn, bought = false) {
  packBtn.classList.add('shake');
  document.getElementById('buy-btn').disabled = true;
  const { data, error } = await sb.rpc(bought ? 'buy_pack' : 'open_pack');
  if (error) {
    packBtn.classList.remove('shake');
    const m = /COOLDOWN:(\S+)/.exec(error.message);
    if (m) { state.me.pack_clock = new Date(new Date(m[1]).getTime() - cooldownMs()).toISOString(); renderBooster(); return; }
    toast(/Aucune carte/.test(error.message) ? 'No cards yet: add some photos first'
      : /NOT_ENOUGH_COINS/.test(error.message) ? 'Not enough coins yet'
      : error.message || 'Could not open the pack', 'err');
    await loadAll().catch(() => {});
    renderBooster();
    return;
  }
  const earned = data.reduce((a, c) => a + Number(c.coins || 0), 0);
  if (bought) state.me.coins = Number(state.me.coins ?? 0) - packPrice();
  else { state.me.pack_clock = new Date(packStatus(state.me).start + cooldownMs()).toISOString(); state.me.last_pack_at = new Date().toISOString(); }
  state.me.coins = Number(state.me.coins ?? 0) + earned;
  document.getElementById('coins').textContent = `${state.me.coins} ${COIN}`;
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
            <div class="flip-front">${cardHTML(c, url, { isNew: c.is_new, variant: c.variant, coins: c.coins })}</div>
          </div>
        </div>`).join('')}
    </div>
    <div class="reveal-actions">
      <button class="btn ghost" id="flip-all">Flip all</button>
      <button class="btn ghost" id="back-to-packs" hidden>Back</button>
      <a class="btn primary" href="#/collection" id="to-collection" hidden>See my collection</a>
    </div>`;
  document.getElementById('back-to-packs').addEventListener('click', () => renderBooster());

  const flips = [...reveal.querySelectorAll('.flip')];
  const done = () => {
    if (flips.every((f) => f.classList.contains('flipped'))) {
      document.getElementById('flip-all').hidden = true;
      document.getElementById('to-collection').hidden = false;
      document.getElementById('back-to-packs').hidden = false;
      const news = pulled.filter((c) => c.is_new).length;
      const special = pulled.find((c) => c.variant === 'gold') || pulled.find((c) => c.variant === 'holo');
      const coins = earned ? ` +${earned} ${COIN}` : '';
      toast(special ? `A ${VARIANTS[special.variant]} card!${coins}` : news ? `${news} new card${news > 1 ? 's' : ''}!${coins}` : `Only duplicates ·${coins}`);
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

/* ---------- mini-jeu : Memory ---------- */

const MEMORY_PAIRS = 6;
const todayParis = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Paris' });

function renderJeu() {
  const today = todayParis();
  const gamesToday = state.me.game_coins_on === today ? Number(state.me.game_coins_today || 0) : 0;
  const cap = Number(state.settings?.games_daily_cap ?? 60);
  $app.innerHTML = `
    <section>
      <header class="page-head">
        <h1>Play</h1>
        <p class="coins">${Number(state.me.coins ?? 0)} ${COIN}</p>
      </header>
      <a class="game-card blocks-card" href="#/blocks">
        <span class="game-art" aria-hidden="true">${['#ff6f9c', '#f5c46b', '#52c98f', '#5aa2ff', '#b977ff', '#ff6f9c', '#f5c46b', '#52c98f', '#5aa2ff'].map((c, i) => `<i style="background:${[0, 1, 2, 4, 6].includes(i) ? c : 'transparent'}"></i>`).join('')}</span>
        <span><b>Blocks</b><small class="muted">Fill rows and columns to clear them. Each line gives ${Number(state.settings?.blocks_coins_per_line ?? 3)} ${COIN}. Today: ${gamesToday}/${cap} ${COIN}.</small></span>
      </a>
      <a class="game-card" href="#/memory">
        <span class="game-art memory-art" aria-hidden="true">${backHTML()}</span>
        <span><b>Memory</b><small class="muted">Find the pairs among your cards. ${state.me.memory_reward_on === today ? 'Today\'s coins already earned.' : `First game of the day: up to 50 ${COIN}.`}</small></span>
      </a>
      <a class="game-card" href="#/burger">
        <span class="game-art burger-art" aria-hidden="true">${stackHTML(['bun', 'patty', 'cheese', 'lettuce', 'top'])}</span>
        <span><b>Burger Shop</b><small class="muted">Grill the meat, fry the fries without burning them, build several orders at once and serve before the customers lose patience. Each order gives ${Number(state.settings?.burger_coins_per_order ?? 4)} ${COIN}, within the daily limit.</small></span>
      </a>
      <a class="game-card" href="#/puzzle">
        <span class="game-art puzzle-art" aria-hidden="true">${[0, 1, 2, 3].map((i) => `<i class="pz${i}"></i>`).join('')}</span>
        <span><b>Puzzle</b><small class="muted">Put one of your photos back together. Each finished puzzle gives up to ${puzzleReward(5)} ${COIN}, within the same daily limit as Blocks.</small></span>
      </a>
    </section>`;
}

function renderMemory() {
  const ownedIds = [...(state.owned.get(state.me.id)?.keys() || [])];
  const pool = state.cards.filter((c) => ownedIds.includes(c.id));
  const other = partner();
  const rewardDone = state.me.memory_reward_on === todayParis();
  const best = (p) => (p?.memory_best ? `${p.memory_best} moves` : '—');

  $app.innerHTML = `
    <section class="jeu">
      <a class="back-link" href="#/jeu">← Games</a>
      <header class="page-head">
        <h1>Memory</h1>
        <p class="coins" id="coins">${Number(state.me.coins ?? 0)} ${COIN}</p>
      </header>
      <p class="muted">Find the pairs among your own cards in as few moves as possible. ${rewardDone
        ? 'You already earned today\'s coins: play just for fun or to beat your record.'
        : `Your first game of the day earns up to 50 ${COIN}.`}</p>
      <div class="scores">
        <div><small class="muted">My record</small><b>${best(state.me)}</b></div>
        ${other ? `<div><small class="muted">${esc(other.display_name || 'Partner')}'s record</small><b>${best(other)}</b></div>` : ''}
      </div>
      ${pool.length < MEMORY_PAIRS
        ? `<p class="panel muted">Collect at least ${MEMORY_PAIRS} different cards to play (you have ${pool.length}).</p>`
        : `<div class="memory-bar"><span id="moves">0 moves</span><span id="clock">0:00</span></div>
           <div class="memory" id="board"></div>
           <div class="reveal-actions"><button class="btn primary" id="start">Start a game</button></div>`}
    </section>`;

  if (pool.length >= MEMORY_PAIRS) document.getElementById('start').addEventListener('click', () => startMemory(pool));
}

async function startMemory(pool) {
  const picked = [...pool].sort(() => Math.random() - 0.5).slice(0, MEMORY_PAIRS);
  const deck = [...picked, ...picked].map((c, i) => ({ c, i })).sort(() => Math.random() - 0.5);
  const url = await signedUrls(picked.map((c) => c.image_path));
  const board = document.getElementById('board');
  const startBtn = document.getElementById('start');
  startBtn.hidden = true;
  board.innerHTML = deck.map(({ c }, k) => `
    <button class="tile r-${c.rarity}" data-k="${k}" data-id="${c.id}" aria-label="Hidden card">
      <span class="tile-inner">
        <span class="tile-back">${backHTML()}</span>
        <span class="tile-front">${c.image_path && url(c.image_path) ? `<img src="${esc(url(c.image_path))}" alt="" draggable="false">` : `<span class="placeholder">${esc(firstEmoji(c.description))}</span>`}</span>
      </span>
    </button>`).join('');

  let first = null, lock = false, moves = 0, found = 0;
  const t0 = Date.now();
  const clock = setInterval(() => {
    const el = document.getElementById('clock');
    if (!el) return clearInterval(clock);
    const sec = Math.floor((Date.now() - t0) / 1000);
    el.textContent = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
  }, 250);

  board.querySelectorAll('.tile').forEach((tile) => tile.addEventListener('click', async () => {
    if (lock || tile.classList.contains('up')) return;
    tile.classList.add('up');
    if (!first) { first = tile; return; }
    moves++;
    document.getElementById('moves').textContent = `${moves} move${moves > 1 ? 's' : ''}`;
    if (first.dataset.id === tile.dataset.id) {
      first.classList.add('matched'); tile.classList.add('matched');
      first = null;
      if (++found === MEMORY_PAIRS) {
        clearInterval(clock);
        finishMemory(moves, Math.round((Date.now() - t0) / 1000));
      }
      return;
    }
    lock = true;
    const a = first;
    first = null;
    setTimeout(() => { a.classList.remove('up'); tile.classList.remove('up'); lock = false; }, 850);
  }));
}

async function finishMemory(moves, seconds) {
  const { data, error } = await sb.rpc('claim_memory', { moves, seconds });
  const time = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  let line = '';
  if (error) line = `<p class="muted">${esc(error.message)}</p>`;
  else {
    const newRecord = !state.me.memory_best || moves < state.me.memory_best;
    state.me.coins = data.coins;
    state.me.memory_best = data.best;
    if (data.reward) state.me.memory_reward_on = todayParis();
    document.getElementById('coins').textContent = `${data.coins} ${COIN}`;
    line = `${data.reward ? `<p class="big">+${data.reward} ${COIN}</p>` : '<p class="muted">Today\'s coins were already earned.</p>'}${newRecord ? '<p class="record">New record!</p>' : ''}`;
  }
  const done = document.createElement('div');
  done.className = 'panel memory-done';
  done.innerHTML = `<h2>All pairs found</h2><p>${moves} moves · ${time}</p>${line}<button class="btn primary" id="again">Play again</button>`;
  document.getElementById('board').after(done);
  done.scrollIntoView({ behavior: 'smooth', block: 'center' });
  document.getElementById('again').addEventListener('click', () => renderMemory());
}

/* ---------- mini-jeu : Blocks ---------- */

const BOARD = 8;
const SHAPES = [
  [[0, 0]],
  [[0, 0], [0, 1]], [[0, 0], [1, 0]],
  [[0, 0], [0, 1], [0, 2]], [[0, 0], [1, 0], [2, 0]],
  [[0, 0], [0, 1], [0, 2], [0, 3]], [[0, 0], [1, 0], [2, 0], [3, 0]],
  [[0, 0], [0, 1], [0, 2], [0, 3], [0, 4]], [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0]],
  [[0, 0], [0, 1], [1, 0], [1, 1]],
  [[0, 0], [0, 1], [0, 2], [1, 0], [1, 1], [1, 2], [2, 0], [2, 1], [2, 2]],
  [[0, 0], [1, 0], [1, 1]], [[0, 0], [0, 1], [1, 0]], [[0, 0], [0, 1], [1, 1]], [[0, 1], [1, 0], [1, 1]],
  [[0, 0], [1, 0], [2, 0], [2, 1]], [[0, 0], [0, 1], [0, 2], [1, 0]], [[0, 0], [0, 1], [1, 1], [2, 1]], [[0, 2], [1, 0], [1, 1], [1, 2]],
  [[0, 0], [0, 1], [0, 2], [1, 1]], [[0, 1], [1, 0], [1, 1], [2, 1]],
  [[0, 0], [0, 1], [1, 1], [1, 2]], [[0, 1], [1, 0], [1, 1], [2, 0]],
  [[0, 0], [1, 0], [2, 0], [2, 1], [2, 2]],
];
const BLOCK_COLORS = ['#ff6f9c', '#f5c46b', '#52c98f', '#5aa2ff', '#b977ff', '#ff9a5a'];

const newPiece = () => ({
  cells: SHAPES[Math.floor(Math.random() * SHAPES.length)],
  color: BLOCK_COLORS[Math.floor(Math.random() * BLOCK_COLORS.length)],
});
const pieceSize = (p) => [Math.max(...p.cells.map((c) => c[0])) + 1, Math.max(...p.cells.map((c) => c[1])) + 1];

function loadBlocksGame() {
  try {
    const g = JSON.parse(localStorage.getItem('blocksGame') || 'null');
    if (g && g.grid?.length === BOARD * BOARD && !g.over) return g;
  } catch { /* rien d'enregistré */ }
  return { grid: Array(BOARD * BOARD).fill(null), pieces: [newPiece(), newPiece(), newPiece()], score: 0, lines: 0, over: false };
}
function saveBlocksGame(g) {
  try { localStorage.setItem('blocksGame', JSON.stringify(g)); } catch { /* stockage indisponible */ }
}

const canPlace = (grid, p, r, c) => p.cells.every(([dr, dc]) => {
  const rr = r + dr, cc = c + dc;
  return rr >= 0 && cc >= 0 && rr < BOARD && cc < BOARD && !grid[rr * BOARD + cc];
});
const fitsSomewhere = (grid, p) => {
  for (let r = 0; r < BOARD; r++) for (let c = 0; c < BOARD; c++) if (canPlace(grid, p, r, c)) return true;
  return false;
};

function pieceHTML(p, cell) {
  const [h, w] = pieceSize(p);
  const on = new Set(p.cells.map(([r, c]) => `${r},${c}`));
  let cells = '';
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) cells += `<i${on.has(`${r},${c}`) ? ` style="background:${p.color}"` : ''}></i>`;
  return `<div class="piece" style="grid-template-columns:repeat(${w},${cell}px);grid-template-rows:repeat(${h},${cell}px)">${cells}</div>`;
}

function renderBlocks() {
  const g = loadBlocksGame();
  const today = todayParis();
  const cap = Number(state.settings?.games_daily_cap ?? 60);
  let earnedToday = state.me.game_coins_on === today ? Number(state.me.game_coins_today || 0) : 0;

  $app.innerHTML = `
    <section class="blocks-page">
      <a class="back-link" href="#/jeu">← Games</a>
      <header class="page-head">
        <h1>Blocks</h1>
        <p class="coins" id="coins">${Number(state.me.coins ?? 0)} ${COIN}</p>
      </header>
      <div class="scores">
        <div><small class="muted">Score</small><b id="score">${g.score}</b></div>
        <div><small class="muted">Record</small><b id="best">${state.me.blocks_best ?? 0}</b></div>
        <div><small class="muted">Coins today</small><b id="today">${earnedToday}/${cap}</b></div>
      </div>
      <div class="board" id="board">${g.grid.map(() => '<i></i>').join('')}</div>
      <div class="tray" id="tray">${[0, 1, 2].map((i) => `<div class="slot" data-i="${i}"></div>`).join('')}</div>
      <div id="blocks-end"></div>
      <div class="reveal-actions"><button class="btn ghost" id="restart">New game</button></div>
    </section>`;

  const board = document.getElementById('board');
  const cellsEl = [...board.children];
  const tray = document.getElementById('tray');

  const paint = () => {
    g.grid.forEach((col, k) => { cellsEl[k].style.background = col || ''; cellsEl[k].className = col ? 'on' : ''; });
    tray.querySelectorAll('.slot').forEach((slot) => {
      const p = g.pieces[slot.dataset.i];
      slot.innerHTML = p ? pieceHTML(p, 20) : '';
      slot.classList.toggle('blocked', !!p && !fitsSomewhere(g.grid, p));
    });
    document.getElementById('score').textContent = g.score;
  };

  const gameOver = async () => {
    g.over = true;
    saveBlocksGame(g);
    const { data } = await sb.rpc('blocks_end', { score: g.score });
    const record = data && data.best === g.score && g.score > 0 && g.score > Number(state.me.blocks_best ?? 0);
    if (data) { state.me.blocks_best = data.best; document.getElementById('best').textContent = data.best; }
    document.getElementById('blocks-end').innerHTML = `
      <div class="panel memory-done"><h2>No more room</h2><p>Score ${g.score} · ${g.lines} line${g.lines > 1 ? 's' : ''}</p>${record ? '<p class="record">New record!</p>' : ''}<button class="btn primary" id="again">Play again</button></div>`;
    document.getElementById('again').addEventListener('click', restart);
  };

  const restart = () => {
    try { localStorage.removeItem('blocksGame'); } catch { /* rien */ }
    renderBlocks();
  };
  document.getElementById('restart').addEventListener('click', () => {
    if (g.over || g.score === 0 || confirm('Start a new game? The current one will be lost.')) restart();
  });

  const place = async (i, r, c) => {
    const p = g.pieces[i];
    p.cells.forEach(([dr, dc]) => { g.grid[(r + dr) * BOARD + (c + dc)] = p.color; });
    g.pieces[i] = null;
    g.score += p.cells.length;

    const rows = [], cols = [];
    for (let k = 0; k < BOARD; k++) {
      if ([...Array(BOARD).keys()].every((j) => g.grid[k * BOARD + j])) rows.push(k);
      if ([...Array(BOARD).keys()].every((j) => g.grid[j * BOARD + k])) cols.push(k);
    }
    const lines = rows.length + cols.length;
    if (lines) {
      const clear = new Set();
      rows.forEach((k) => { for (let j = 0; j < BOARD; j++) clear.add(k * BOARD + j); });
      cols.forEach((k) => { for (let j = 0; j < BOARD; j++) clear.add(j * BOARD + k); });
      paint();
      clear.forEach((k) => cellsEl[k].classList.add('clearing'));
      await new Promise((res) => setTimeout(res, 280));
      clear.forEach((k) => { g.grid[k] = null; });
      g.lines += lines;
      g.score += lines * lines * 10;
      sb.rpc('blocks_lines', { lines }).then(({ data }) => {
        if (!data) return;
        state.me.coins = data.coins;
        state.me.game_coins_on = today;
        state.me.game_coins_today = data.today;
        earnedToday = data.today;
        document.getElementById('coins').textContent = `${data.coins} ${COIN}`;
        document.getElementById('today').textContent = `${data.today}/${data.cap}`;
        toast(data.gain ? `${lines > 1 ? `${lines} lines! ` : ''}+${data.gain} ${COIN}` : `${lines > 1 ? `${lines} lines! ` : 'Line! '}Daily coin limit reached`);
      });
    }
    if (g.pieces.every((x) => !x)) g.pieces = [newPiece(), newPiece(), newPiece()];
    paint();
    saveBlocksGame(g);
    if (g.pieces.every((x) => !x || !fitsSomewhere(g.grid, x))) gameOver();
  };

  // glisser une pièce du plateau du bas vers la grille
  tray.querySelectorAll('.slot').forEach((slot) => slot.addEventListener('pointerdown', (e) => {
    const i = Number(slot.dataset.i);
    const p = g.pieces[i];
    if (!p || g.over) return;
    e.preventDefault();
    const rect = board.getBoundingClientRect();
    const cell = rect.width / BOARD;
    const [h, w] = pieceSize(p);
    const ghost = document.createElement('div');
    ghost.className = 'drag-ghost';
    ghost.innerHTML = pieceHTML(p, cell - 2);
    document.body.appendChild(ghost);
    slot.classList.add('dragging');
    const lift = e.pointerType === 'mouse' ? 0 : cell * 1.6; // au doigt, la pièce passe au-dessus pour rester visible
    let target = null;

    const move = (ev) => {
      const x = ev.clientX - (w * cell) / 2;
      const y = ev.clientY - (h * cell) / 2 - lift;
      ghost.style.transform = `translate(${x}px, ${y}px)`;
      const r = Math.round((y - rect.top) / cell), c = Math.round((x - rect.left) / cell);
      cellsEl.forEach((el) => el.classList.remove('preview'));
      target = canPlace(g.grid, p, r, c) ? [r, c] : null;
      if (target) p.cells.forEach(([dr, dc]) => cellsEl[(r + dr) * BOARD + (c + dc)].classList.add('preview'));
      board.style.setProperty('--preview', p.color);
    };
    const end = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      ghost.remove();
      slot.classList.remove('dragging');
      cellsEl.forEach((el) => el.classList.remove('preview'));
      if (target) place(i, ...target);
    };
    move(e);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  }));

  paint();
  if (g.pieces.every((x) => !x || !fitsSomewhere(g.grid, x))) gameOver();
}

/* ---------- mini-jeu : Puzzle ---------- */

const PUZZLE_SIZES = [3, 4, 5];
const fmtClock = (sec) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
const puzzleReward = (n) => n * n * Number(state.settings?.puzzle_coins_per_piece ?? 2);

function puzzlePool() {
  const mine = state.owned.get(state.me.id) || new Map();
  return state.cards.filter((c) => mine.has(c.id) && c.image_path);
}

function loadPuzzleGame() {
  try {
    const g = JSON.parse(localStorage.getItem('puzzleGame') || 'null');
    if (g && g.order?.length === g.size * g.size) return g;
  } catch { /* rien d'enregistré */ }
  return null;
}
function savePuzzleGame(g) {
  try {
    if (g) { localStorage.setItem('puzzleGame', JSON.stringify(g)); localStorage.setItem('puzzleSize', g.size); }
    else localStorage.removeItem('puzzleGame');
  } catch { /* stockage indisponible */ }
}

function newPuzzleGame(size, pool, avoidId) {
  const choices = pool.length > 1 ? pool.filter((c) => c.id !== avoidId) : pool;
  const card = choices[Math.floor(Math.random() * choices.length)];
  const n = size * size;
  const order = [...Array(n).keys()];
  // mélange jusqu'à ce que presque aucun morceau ne soit déjà à sa place
  do {
    for (let i = n - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
  } while (order.filter((p, k) => p === k).length > 1);
  return { cardId: card.id, size, order, moves: 0, elapsed: 0 };
}

async function renderPuzzle() {
  const pool = puzzlePool();
  const today = todayParis();
  const cap = Number(state.settings?.games_daily_cap ?? 60);
  const earned = state.me.game_coins_on === today ? Number(state.me.game_coins_today || 0) : 0;
  let g = loadPuzzleGame();
  if (g && !pool.some((c) => c.id === g.cardId)) g = null;
  let savedSize = 4;
  try { savedSize = Number(localStorage.getItem('puzzleSize')) || 4; } catch { /* rien */ }
  if (!g && pool.length) { g = newPuzzleGame(PUZZLE_SIZES.includes(savedSize) ? savedSize : 4, pool); savePuzzleGame(g); }

  $app.innerHTML = `
    <section class="puzzle-page">
      <a class="back-link" href="#/jeu">← Games</a>
      <header class="page-head">
        <h1>Puzzle</h1>
        <p class="coins" id="coins">${Number(state.me.coins ?? 0)} ${COIN}</p>
      </header>
      ${!pool.length
        ? '<p class="panel muted">Pull a card with a photo to play: the puzzle uses the photos of your own cards.</p>'
        : `<div class="scores">
            <div><small class="muted">Moves</small><b id="moves">${g.moves}</b></div>
            <div><small class="muted">Time</small><b id="clock">${fmtClock(g.elapsed)}</b></div>
            <div><small class="muted">Coins today</small><b id="today">${earned}/${cap}</b></div>
          </div>
          <div class="sizes" role="group" aria-label="Number of pieces">
            ${PUZZLE_SIZES.map((n) => `<button type="button" class="size${n === g.size ? ' on' : ''}" data-n="${n}">${n}×${n}<small>+${puzzleReward(n)} ${COIN}</small></button>`).join('')}
          </div>
          <p class="muted small">Tap two pieces to swap them, or drag one onto another.</p>
          <div class="puzzle" id="puzzle"><div class="peek-img" id="peek-img"></div></div>
          <div id="puzzle-end"></div>
          <div class="reveal-actions">
            <button class="btn ghost" id="peek" type="button">Hold to peek</button>
            <button class="btn ghost" id="new-photo" type="button">Another photo</button>
          </div>`}
    </section>`;
  if (!pool.length) return;

  const card = pool.find((c) => c.id === g.cardId);
  const url = await signedUrls([card.image_path]);
  const src = url(card.image_path);
  const board = document.getElementById('puzzle');
  if (!board) return;
  const img = new Image();
  img.src = src;
  await img.decode().catch(() => {});
  if (!board.isConnected) return;

  const size = g.size;
  const n = size * size;
  const tiles = [];
  for (let p = 0; p < n; p++) {
    const t = document.createElement('div');
    t.className = 'ptile';
    t.style.backgroundImage = `url("${src}")`;
    board.appendChild(t);
    tiles.push(t);
  }
  const peekImg = document.getElementById('peek-img');
  peekImg.style.backgroundImage = `url("${src}")`;

  let tw = 0, th = 0, selected = null, solved = false;
  const slotOf = (p) => g.order.indexOf(p);
  const layout = () => {
    const W = board.clientWidth, H = W * 4 / 3;
    board.style.height = `${H}px`;
    tw = W / size; th = H / size;
    // la photo couvre tout le plateau, comme sur la carte
    const iw = img.naturalWidth || W, ih = img.naturalHeight || H;
    const s = Math.max(W / iw, H / ih), bw = iw * s, bh = ih * s, ox = (W - bw) / 2, oy = (H - bh) / 2;
    peekImg.style.backgroundSize = `${bw}px ${bh}px`;
    peekImg.style.backgroundPosition = `${ox}px ${oy}px`;
    tiles.forEach((t, p) => {
      const k = slotOf(p);
      t.dataset.slot = k;
      t.style.width = `${tw}px`; t.style.height = `${th}px`;
      t.style.backgroundSize = `${bw}px ${bh}px`;
      t.style.backgroundPosition = `${ox - (p % size) * tw}px ${oy - Math.floor(p / size) * th}px`;
      t.style.transform = `translate(${(k % size) * tw}px, ${Math.floor(k / size) * th}px)`;
      t.classList.toggle('ok', k === p);
    });
  };
  layout();
  new ResizeObserver(() => { if (board.isConnected) layout(); }).observe(board);

  const t0 = Date.now() - g.elapsed * 1000;
  const clock = setInterval(() => {
    const el = document.getElementById('clock');
    if (!el || solved) return clearInterval(clock);
    g.elapsed = Math.floor((Date.now() - t0) / 1000);
    el.textContent = fmtClock(g.elapsed);
  }, 250);

  const clearSel = () => { if (selected !== null) tiles[g.order[selected]].classList.remove('selected'); selected = null; };
  const swap = (a, b) => {
    [g.order[a], g.order[b]] = [g.order[b], g.order[a]];
    g.moves++;
    g.elapsed = Math.floor((Date.now() - t0) / 1000);
    document.getElementById('moves').textContent = g.moves;
    layout();
    savePuzzleGame(g);
    if (g.order.every((p, k) => p === k)) finish();
  };

  const finish = async () => {
    solved = true;
    clearInterval(clock);
    savePuzzleGame(null);
    board.classList.add('solved');
    const seconds = Math.max(1, Math.round((Date.now() - t0) / 1000));
    const { data, error } = await sb.rpc('claim_puzzle', { size, moves: g.moves, seconds });
    let line = '';
    if (error) line = `<p class="muted">${esc(error.message)}</p>`;
    else {
      const prev = Number(state.me.puzzle_best?.[size] ?? 0);
      state.me.coins = data.coins;
      state.me.game_coins_on = today;
      state.me.game_coins_today = data.today;
      state.me.puzzle_best = { ...(state.me.puzzle_best || {}), [size]: data.best };
      document.getElementById('coins').textContent = `${data.coins} ${COIN}`;
      document.getElementById('today').textContent = `${data.today}/${data.cap}`;
      line = `${data.gain ? `<p class="big">+${data.gain} ${COIN}</p>` : '<p class="muted">Daily coin limit reached.</p>'}${!prev || seconds < prev ? `<p class="record">New ${size}×${size} record!</p>` : `<p class="muted small">Your ${size}×${size} record: ${fmtClock(prev)}</p>`}`;
    }
    const entry = state.owned.get(state.me.id)?.get(card.id);
    const end = document.getElementById('puzzle-end');
    if (!end) return;
    end.innerHTML = `
      <div class="panel memory-done">
        <h2>Photo complete!</h2>
        <p>${g.moves} moves · ${fmtClock(seconds)}</p>
        ${line}
        <div class="puzzle-card">${cardHTML(card, url, { variant: entry ? bestVariant(entry) : 'normal' })}</div>
        <button class="btn primary" id="again" type="button">Next puzzle</button>
      </div>`;
    setTimeout(() => end.scrollIntoView({ behavior: 'smooth', block: 'center' }), 500);
    document.getElementById('again').addEventListener('click', () => { savePuzzleGame(newPuzzleGame(size, pool, card.id)); renderPuzzle(); });
  };

  // toucher deux morceaux pour les échanger, ou en glisser un sur un autre
  board.addEventListener('pointerdown', (e) => {
    const el = e.target.closest('.ptile');
    if (!el || solved) return;
    e.preventDefault();
    const from = Number(el.dataset.slot);
    const rect = board.getBoundingClientRect();
    const base = el.style.transform;
    const sx = e.clientX, sy = e.clientY;
    let dragging = false;
    const move = (ev) => {
      const dx = ev.clientX - sx, dy = ev.clientY - sy;
      if (!dragging && Math.hypot(dx, dy) > 8) { dragging = true; clearSel(); el.classList.add('dragging'); }
      if (dragging) el.style.transform = `translate(${(from % size) * tw + dx}px, ${Math.floor(from / size) * th + dy}px) scale(1.06)`;
    };
    const up = (ev) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      el.classList.remove('dragging');
      if (dragging) {
        const c = Math.floor((ev.clientX - rect.left) / tw), r = Math.floor((ev.clientY - rect.top) / th);
        const to = ev.type === 'pointerup' && r >= 0 && r < size && c >= 0 && c < size ? r * size + c : from;
        if (to !== from) swap(from, to); else el.style.transform = base;
      } else if (selected === null) { selected = from; el.classList.add('selected'); }
      else if (selected === from) clearSel();
      else { const a = selected; clearSel(); swap(a, from); }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  });

  const peek = document.getElementById('peek');
  const showPeek = (on) => board.classList.toggle('peek', on);
  peek.addEventListener('pointerdown', (e) => { e.preventDefault(); showPeek(true); });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => peek.addEventListener(ev, () => showPeek(false)));

  const restart = (newSize) => {
    if (!solved && g.moves > 0 && !confirm('Start a new puzzle? The current one will be lost.')) return;
    savePuzzleGame(newPuzzleGame(newSize, pool, card.id));
    renderPuzzle();
  };
  document.getElementById('new-photo').addEventListener('click', () => restart(size));
  document.querySelectorAll('.sizes .size').forEach((b) => b.addEventListener('click', () => {
    if (Number(b.dataset.n) !== size) restart(Number(b.dataset.n));
  }));
}

/* ---------- mini-jeu : Burger Shop ---------- */

// kind : bun = pain, grill = à cuire sur le grill, fry = friteuse, top = se pose directement
const INGREDIENTS = [
  { id: 'bun', label: 'Bun', kind: 'bun', from: 1 },
  { id: 'hdbun', label: 'Hot dog', kind: 'bun', from: 3 },
  { id: 'patty', label: 'Patty', kind: 'grill', from: 1 },
  { id: 'bacon', label: 'Bacon', kind: 'grill', from: 2 },
  { id: 'sausage', label: 'Sausage', kind: 'grill', from: 3 },
  { id: 'cheese', label: 'Cheese', kind: 'top', from: 1 },
  { id: 'lettuce', label: 'Lettuce', kind: 'top', from: 1 },
  { id: 'tomato', label: 'Tomato', kind: 'top', from: 1 },
  { id: 'onion', label: 'Onion', kind: 'top', from: 2 },
  { id: 'sauce', label: 'Sauce', kind: 'top', from: 3 },
  { id: 'fries', label: 'Fries', kind: 'fry', from: 1 },
];
const DRINKS = [
  { id: 'cola', label: 'Cola', from: 1 },
  { id: 'lemon', label: 'Lemonade', from: 2 },
  { id: 'orange', label: 'Orange', from: 4 },
];
// secondes de cuisson : prêt à partir de done, brûlé à partir de burn
const COOK = {
  patty: { done: 5, burn: 11 },
  bacon: { done: 3.5, burn: 8 },
  sausage: { done: 4.5, burn: 10 },
  fries: { done: 5, burn: 10.5 },
};
const CUSTOMERS = ['👩', '👨', '👧', '👦', '👵', '👴', '🧔', '👩‍🦰', '👨‍🦱', '👱‍♀️', '👩‍🦳', '🧑‍🦱', '👨‍🦰', '👱'];
const MAX_LAYERS = 9;
const GRILL_SLOTS = 3;
const FRYER_SLOTS = 2;
const TRAYS = 3;

const stackHTML = (layers) => `<span class="bstack">${layers.map((l) => `<i class="L L-${l}"></i>`).join('')}</span>`;
const cupHTML = (d) => (d ? `<span class="cup cup-${d}"><i></i></span>` : '');
const friesHTML = (on = true) => (on ? '<span class="fries"></span>' : '');
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const shuffle = (a) => a.sort(() => Math.random() - 0.5);
const cookState = (it) => (it.t < COOK[it.item].done ? 'raw' : it.t < COOK[it.item].burn ? 'done' : 'burnt');

function burgerLevel(n) {
  const open = (x) => x.from <= n;
  return {
    goal: 4 + n * 2,
    seats: Math.min(3, 1 + Math.ceil(n / 2)),
    extras: INGREDIENTS.filter((i) => open(i) && (i.kind === 'top' || i.id === 'bacon')).map((i) => i.id),
    drinks: DRINKS.filter(open).map((d) => d.id),
    maxExtra: Math.min(4, 1 + Math.floor(n / 2)),
    patience: Math.max(16, 34 - n * 2),
    drinkChance: Math.min(0.7, 0.3 + n * 0.1),
    friesChance: Math.min(0.6, 0.2 + n * 0.1),
    hotdogChance: n >= 3 ? 0.3 : 0,
  };
}

function newOrder(cfg) {
  let layers;
  if (Math.random() < cfg.hotdogChance) {
    const extras = shuffle(['onion', 'sauce', 'cheese'].filter((x) => cfg.extras.includes(x))).slice(0, Math.floor(Math.random() * 3));
    layers = ['hdbun', 'sausage', ...extras];
  } else {
    const extras = shuffle([...cfg.extras]).slice(0, 1 + Math.floor(Math.random() * cfg.maxExtra));
    layers = ['bun', ...shuffle(['patty', ...extras]), 'top'];
  }
  const drink = Math.random() < cfg.drinkChance ? pick(cfg.drinks) : null;
  const fries = Math.random() < cfg.friesChance;
  const cooking = Math.max(0, ...layers.filter((l) => COOK[l]).map((l) => COOK[l].done), fries ? COOK.fries.done : 0);
  const patience = cfg.patience + layers.length * 2.5 + cooking * 1.5 + (drink ? 2 : 0) + (fries ? 3 : 0);
  return { layers, drink, fries, patience };
}

function renderBurger() {
  const cap = Number(state.settings?.games_daily_cap ?? 60);
  const today = todayParis();
  let earned = state.me.game_coins_on === today ? Number(state.me.game_coins_today || 0) : 0;
  const perOrder = Number(state.settings?.burger_coins_per_order ?? 4);
  const byId = Object.fromEntries(INGREDIENTS.map((i) => [i.id, i]));
  const binOrder = ['bun', 'hdbun', 'patty', 'bacon', 'sausage', 'cheese', 'lettuce', 'tomato', 'onion', 'sauce', 'fries'];
  const binArt = (id) => (id === 'fries' ? friesHTML() : id === 'bun' ? stackHTML(['top']) : stackHTML([id]));
  const emptyTray = () => ({ layers: [], drink: null, fries: false });
  const isEmpty = (tr) => !tr.layers.length && !tr.drink && !tr.fries;

  $app.innerHTML = `
    <section class="burger-page">
      <a class="back-link" href="#/jeu">← Games</a>
      <header class="page-head">
        <h1>Burger Shop</h1>
        <p class="coins" id="coins">${Number(state.me.coins ?? 0)} ${COIN}</p>
      </header>
      <div class="bshop" id="bshop">
        <div class="bbar">
          <span>Level <b id="b-level">1</b></span>
          <b id="b-score">$0</b>
          <span id="b-lives">♥♥♥</span>
          <span><b id="b-served">0/6</b> served</span>
        </div>
        <div class="counter" id="counter">${[0, 1, 2].map((s) => `<div class="seat" data-s="${s}"></div>`).join('')}</div>
        <div class="counter-edge"></div>
        <div class="stations">
          <div class="grill" id="grill">${[...Array(GRILL_SLOTS).keys()].map((k) => `<button class="gslot empty" type="button" data-g="${k}"></button>`).join('')}</div>
          <div class="fryer" id="fryer">${[...Array(FRYER_SLOTS).keys()].map((k) => `<button class="fslot empty" type="button" data-f="${k}"></button>`).join('')}</div>
        </div>
        <div class="work" id="trays">${[...Array(TRAYS).keys()].map((t) => `<div class="btray" data-t="${t}"></div>`).join('')}</div>
        <div class="bins" id="bins">
          ${binOrder.map((id) => `<button class="bin" type="button" data-add="${id}" data-from="${byId[id].from}"><span class="bin-art">${binArt(id)}</span><small>${byId[id].label}</small></button>`).join('')}
          ${DRINKS.map((d) => `<button class="bin drink" type="button" data-drink="${d.id}" data-from="${d.from}"><span class="bin-art">${cupHTML(d.id)}</span><small>${d.label}</small></button>`).join('')}
          <button class="bin trash" type="button" id="trash"><span class="bin-art">🗑️</span><small>Trash</small></button>
        </div>
        <div class="b-overlay" id="b-overlay"></div>
      </div>
    </section>`;

  const $ = (id) => document.getElementById(id);
  const shop = $('bshop');
  const counter = $('counter');
  const seatsEl = [...counter.children];
  const grillEl = [...$('grill').children];
  const fryerEl = [...$('fryer').children];
  const trayEl = [...$('trays').children];
  const g = { level: 1, score: 0, lives: 3, running: false };
  let cfg, seats, trays, grill, fryer, spawned, resolved, served, nextSpawn, last, loop;
  let drag = null;

  const showStats = () => {
    $('b-level').textContent = g.level;
    $('b-score').textContent = `$${g.score}`;
    $('b-lives').textContent = '♥'.repeat(Math.max(0, g.lives)) + '♡'.repeat(Math.max(0, 3 - g.lives));
    $('b-served').textContent = `${served}/${cfg.goal}`;
  };
  const showTray = (t) => {
    const tr = trays[t];
    trayEl[t].innerHTML = `
      <span class="tplate">${tr.layers.length ? stackHTML(tr.layers) : '<span class="plate-hint">Drop a bun here</span>'}</span>
      <span class="tsides"><span class="tside${tr.fries ? '' : ' off'}">${friesHTML(tr.fries)}</span><span class="tside${tr.drink ? '' : ' off'}">${cupHTML(tr.drink)}</span></span>`;
  };
  const showTrays = () => trayEl.forEach((el, t) => showTray(t));
  const showBins = () => {
    document.querySelectorAll('#bins [data-from]').forEach((b) => {
      const locked = Number(b.dataset.from) > g.level;
      b.disabled = locked;
      b.classList.toggle('locked', locked);
    });
  };
  const pop = (el) => { el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop'); };

  // grill et friteuse : une aiguille avance sur une barre grise (cru), verte (prêt) puis rouge (brûlé)
  const drawCook = (el, it) => {
    if (!it) { el.className = el.dataset.g !== undefined ? 'gslot empty' : 'fslot empty'; el.innerHTML = ''; delete el.dataset.item; return; }
    const c = COOK[it.item];
    if (el.dataset.item !== it.item || !el.firstChild) {
      el.dataset.item = it.item;
      const doneP = (c.done / c.burn) * 100;
      el.innerHTML = `<span class="citem">${it.item === 'fries' ? friesHTML() : stackHTML([it.item])}</span>
        <span class="cookbar" style="background:linear-gradient(90deg, rgba(255,255,255,.18) 0 ${doneP}%, #52c98f ${doneP}% 96%, #ff5a6e 96%)"><i></i></span>`;
    }
    const st = cookState(it);
    const warn = st === 'done' && it.t > c.done + 0.65 * (c.burn - c.done);
    const dragged = drag?.src.el === el;
    el.className = `${el.dataset.g !== undefined ? 'gslot' : 'fslot'} ${st}${warn ? ' warn' : ''}${dragged ? ' dragging' : ''}`;
    el.querySelector('.cookbar i').style.left = `${Math.min(100, (it.t / c.burn) * 100)}%`;
    if (dragged && drag.ghost) drag.ghost.className = `bdrag-ghost g-cook ${st}`;
  };
  const drawStations = () => {
    grillEl.forEach((el, k) => drawCook(el, grill[k]));
    fryerEl.forEach((el, k) => drawCook(el, fryer[k]));
  };

  const drawSeat = (s) => {
    const c = seats[s];
    const el = seatsEl[s];
    el.className = `seat${c ? ' on' : ''}${c?.happy ? ' happy' : ''}${s >= cfg.seats ? ' closed' : ''}`;
    el.innerHTML = c ? `
      <div class="bubble">${stackHTML(c.order.layers)}${friesHTML(c.order.fries)}${cupHTML(c.order.drink)}</div>
      <div class="face">${c.face}<span class="mood"></span></div>
      <div class="patience"><i></i></div>` : '';
    if (c) updateSeat(s);
  };
  const updateSeat = (s) => {
    const c = seats[s];
    if (!c) return;
    const el = seatsEl[s];
    const r = Math.max(0, c.left / c.order.patience);
    const bar = el.querySelector('.patience i');
    if (bar) { bar.style.width = `${r * 100}%`; bar.style.background = r > 0.5 ? '#52c98f' : r > 0.25 ? '#f5c46b' : '#ff5a6e'; }
    const mood = el.querySelector('.mood');
    if (mood) mood.textContent = c.happy ? '😍' : r > 0.5 ? '' : r > 0.25 ? '😐' : '😠';
  };
  const floatText = (el, text, bad = false) => {
    const f = document.createElement('span');
    f.className = `float-gain${bad ? ' bad' : ''}`;
    f.textContent = text;
    el.appendChild(f);
    setTimeout(() => f.remove(), 1300);
  };
  const overlay = (html) => {
    const o = $('b-overlay');
    o.innerHTML = html ? `<div class="panel b-panel">${html}</div>` : '';
    o.classList.toggle('on', !!html);
  };

  const startLevel = () => {
    endDrag();
    cfg = burgerLevel(g.level);
    seats = [null, null, null];
    trays = Array.from({ length: TRAYS }, emptyTray);
    grill = Array(GRILL_SLOTS).fill(null);
    fryer = Array(FRYER_SLOTS).fill(null);
    spawned = 0; resolved = 0; served = 0;
    nextSpawn = performance.now() + 600;
    last = performance.now();
    g.running = true;
    seatsEl.forEach((el, s) => drawSeat(s));
    showStats(); showTrays(); showBins(); drawStations(); overlay('');
    clearInterval(loop);
    loop = setInterval(tick, 100);
  };

  const endLevel = () => {
    g.running = false;
    clearInterval(loop);
    g.lives = Math.min(3, g.lives + 1);
    showStats();
    const unlock = [...INGREDIENTS, ...DRINKS].filter((x) => x.from === g.level + 1).map((x) => (x.id === 'hdbun' ? 'Hot dogs' : x.label));
    overlay(`<h2>Level ${g.level} complete!</h2><p>Score $${g.score}</p>${unlock.length ? `<p class="muted small">New: ${unlock.join(', ')}</p>` : ''}<button class="btn primary" id="b-next" type="button">Next level</button>`);
    $('b-next').addEventListener('click', () => { g.level++; startLevel(); });
  };

  const gameOver = async () => {
    g.running = false;
    clearInterval(loop);
    const { data } = await sb.rpc('burger_end', { score: g.score });
    const prev = Number(state.me.burger_best ?? 0);
    if (data) state.me.burger_best = data.best;
    if (!$('b-overlay')) return;
    overlay(`<h2>The shop is closed</h2><p>Level ${g.level} · Score $${g.score}</p>${g.score > prev ? '<p class="record">New record!</p>' : `<p class="muted small">Record: $${Math.max(prev, g.score)}</p>`}<button class="btn primary" id="b-again" type="button">Play again</button>`);
    $('b-again').addEventListener('click', () => { g.level = 1; g.score = 0; g.lives = 3; startLevel(); });
  };

  const leave = (s) => {
    seats[s] = null;
    resolved++;
    drawSeat(s);
    nextSpawn = Math.max(nextSpawn, performance.now() + 1500 + Math.random() * 2500);
    showStats();
    if (g.lives <= 0) gameOver();
    else if (resolved >= cfg.goal) endLevel();
  };

  function tick() {
    if (!counter.isConnected) { clearInterval(loop); endDrag(); return; }
    const now = performance.now();
    const dt = (now - last) / 1000;
    last = now;
    if (!g.running || document.hidden) { nextSpawn += dt * 1000; return; }
    [...grill, ...fryer].forEach((it) => { if (it) it.t += dt; });
    drawStations();
    seats.forEach((c, s) => {
      if (!c || c.happy || !g.running) return;
      c.left -= dt;
      if (c.left <= 0) {
        g.lives--;
        toast('A customer left angry 😠', 'err');
        leave(s);
      } else updateSeat(s);
    });
    if (!g.running) return;
    if (spawned < cfg.goal && now >= nextSpawn) {
      const free = [...Array(cfg.seats).keys()].filter((s) => !seats[s]);
      if (free.length) {
        const s = pick(free);
        const order = newOrder(cfg);
        seats[s] = { face: pick(CUSTOMERS), order, left: order.patience, happy: false };
        spawned++;
        drawSeat(s);
        nextSpawn = now + 3000 + Math.random() * 4000;
      }
    }
  }

  // pose un pain sur l'assiette t : celui du dessous si elle est vide, sinon le chapeau
  const addBun = (t, id) => {
    const L = trays[t].layers;
    if (id === 'hdbun') {
      if (L.length) { toast('Start a hot dog on an empty plate'); return false; }
    } else if (L[0] === 'hdbun') { toast('A hot dog has no top bun'); return false; }
    else if (L[L.length - 1] === 'top') { toast('This burger is closed: serve it or trash it'); return false; }
    else if (L.length >= MAX_LAYERS) { toast('Too tall!'); return false; }
    L.push(id === 'hdbun' ? 'hdbun' : L.length ? 'top' : 'bun');
    showTray(t);
    return true;
  };
  // ajoute une couche sur le pain de l'assiette t ; renvoie false si c'est impossible
  const addLayer = (t, id) => {
    const L = trays[t].layers;
    if (!L.length) { toast(id === 'sausage' ? 'Put a hot dog bun first' : 'Put a bun first'); return false; }
    if (L[L.length - 1] === 'top') { toast('This burger is closed: serve it or trash it'); return false; }
    if (L.length >= MAX_LAYERS) { toast('Too tall!'); return false; }
    L.push(id);
    showTray(t);
    return true;
  };

  const burn = (el) => {
    g.score = Math.max(0, g.score - 2);
    showStats();
    floatText(el.parentElement, 'Burnt! −$2', true);
  };

  const serve = (s, t) => {
    const c = seats[s];
    const tr = trays[t];
    if (!g.running || !c || c.happy || isEmpty(tr)) return;
    const ok = tr.layers.join() === c.order.layers.join() && tr.drink === c.order.drink && tr.fries === c.order.fries;
    if (!ok) {
      c.left = Math.max(0.5, c.left - 3);
      seatsEl[s].classList.remove('wrong'); void seatsEl[s].offsetWidth; seatsEl[s].classList.add('wrong');
      toast('That\'s not my order!', 'err');
      return;
    }
    const tip = Math.round(3 * c.left / c.order.patience);
    const price = c.order.layers.length + (c.order.drink ? 2 : 0) + (c.order.fries ? 2 : 0) + tip;
    g.score += price;
    served++;
    c.happy = true;
    trays[t] = emptyTray();
    showTray(t); drawSeat(s); showStats();
    floatText(seatsEl[s], `+$${price}`);
    sb.rpc('burger_serve').then(({ data }) => {
      if (!data) return;
      state.me.coins = data.coins;
      state.me.game_coins_on = today;
      state.me.game_coins_today = data.today;
      if (data.gain) setTimeout(() => floatText(seatsEl[s], `+${data.gain} ${COIN}`), 350);
      else if (earned < data.cap && data.today >= data.cap) toast('Daily coin limit reached');
      earned = data.today;
      const el = $('coins');
      if (el) el.textContent = `${data.coins} ${COIN}`;
    });
    setTimeout(() => { if (seats[s] === c) leave(s); }, 900);
  };

  // met un steak, du bacon, une saucisse ou des frites à cuire
  const load = (id) => {
    const list = byId[id].kind === 'grill' ? grill : fryer;
    const k = list.indexOf(null);
    if (k < 0) { toast(list === grill ? 'The grill is full' : 'The fryer is full'); return false; }
    list[k] = { item: id, t: 0 };
    drawStations();
    return true;
  };
  const cooking = (src) => (src.type === 'grill' ? grill : src.type === 'fryer' ? fryer : null);

  /* glisser-déposer : un ingrédient sur une assiette, une assiette sur un client ou à la poubelle */
  const sourceOf = (target) => {
    const bin = target.closest('.bin');
    if (bin) {
      if (bin.disabled || bin.id === 'trash') return null;
      return bin.dataset.drink ? { type: 'drink', id: bin.dataset.drink, el: bin } : { type: 'bin', id: bin.dataset.add, el: bin };
    }
    const slot = target.closest('.gslot, .fslot');
    if (slot) {
      const type = slot.dataset.g !== undefined ? 'grill' : 'fryer';
      const k = Number(slot.dataset.g ?? slot.dataset.f);
      return cooking({ type })[k] ? { type, k, el: slot } : null;
    }
    const tr = target.closest('.btray');
    if (tr && !isEmpty(trays[tr.dataset.t])) return { type: 'tray', t: Number(tr.dataset.t), el: tr };
    return null;
  };
  const ghostOf = (src) => {
    const gh = document.createElement('div');
    gh.className = `bdrag-ghost g-${src.type}`;
    if (src.type === 'drink') gh.innerHTML = cupHTML(src.id);
    else if (src.type === 'bin') gh.innerHTML = binArt(src.id);
    else if (src.type === 'tray') {
      const tr = trays[src.t];
      gh.innerHTML = `${tr.layers.length ? stackHTML(tr.layers) : ''}${friesHTML(tr.fries)}${cupHTML(tr.drink)}`;
    } else {
      const it = cooking(src)[src.k];
      gh.className = `bdrag-ghost g-cook ${cookState(it)}`;
      gh.innerHTML = it.item === 'fries' ? friesHTML() : stackHTML([it.item]);
    }
    return gh;
  };
  const accepts = (src, el) => {
    if (el.classList.contains('btray')) return src.type !== 'tray';
    if (el.classList.contains('seat')) return src.type === 'tray';
    if (el.id === 'trash') return src.type === 'tray' || !!cooking(src);
    if (el.id === 'grill') return src.type === 'bin' && byId[src.id].kind === 'grill';
    if (el.id === 'fryer') return src.type === 'bin' && byId[src.id].kind === 'fry';
    return false;
  };
  const targetAt = (x, y) => {
    const el = document.elementFromPoint(x, y)?.closest('.btray, .seat.on:not(.happy), #trash, #grill, #fryer');
    return el && shop.contains(el) && drag && accepts(drag.src, el) ? el : null;
  };

  const tap = (src) => {
    if (src.type === 'bin' && byId[src.id].kind !== 'bun' && byId[src.id].kind !== 'top') { if (load(src.id)) pop(src.el); return; }
    const list = cooking(src);
    if (list) {
      const st = cookState(list[src.k]);
      if (st === 'burnt') { list[src.k] = null; burn(src.el); drawStations(); return; }
      if (st === 'raw') { toast(list === grill ? 'Still cooking…' : 'Still frying…'); return; }
    }
    toast(src.type === 'tray' ? 'Drag the plate onto the customer' : 'Drag it onto a plate');
  };

  const drop = (src, el) => {
    if (el.id === 'grill' || el.id === 'fryer') { load(src.id); return; }
    if (el.classList.contains('seat')) { serve(Number(el.dataset.s), src.t); return; }
    if (el.id === 'trash') {
      if (src.type === 'tray') { trays[src.t] = emptyTray(); showTray(src.t); return; }
      const list = cooking(src);
      const it = list[src.k];
      if (!it) return;
      list[src.k] = null;
      if (cookState(it) === 'burnt') burn(src.el);
      drawStations();
      return;
    }
    const t = Number(el.dataset.t);
    const tr = trays[t];
    let ok = false;
    if (src.type === 'drink') { tr.drink = src.id; showTray(t); ok = true; }
    else if (src.type === 'bin') {
      const kind = byId[src.id].kind;
      if (kind === 'grill') toast('Cook it on the grill first');
      else if (kind === 'fry') toast('Fry them first');
      else if (kind === 'bun') ok = addBun(t, src.id);
      else ok = addLayer(t, src.id);
    } else {
      const list = cooking(src);
      const it = list[src.k];
      if (!it) return;
      const st = cookState(it);
      if (st === 'raw') toast(list === grill ? 'Still cooking…' : 'Still frying…');
      else if (st === 'burnt') toast('Burnt! Throw it in the trash');
      else if (it.item === 'fries') {
        if (tr.fries) toast('There are already fries on this plate');
        else { tr.fries = true; list[src.k] = null; showTray(t); ok = true; }
      } else if (addLayer(t, it.item)) { list[src.k] = null; ok = true; }
      drawStations();
    }
    if (ok) pop(el);
  };

  function endDrag() {
    if (!drag) return;
    drag.ghost?.remove();
    drag.over?.classList.remove('over');
    drag.src.el.classList.remove('dragging');
    drag = null;
  }
  shop.addEventListener('pointerdown', (e) => {
    if (drag || !g.running || !e.isPrimary || e.button > 0) return;
    const src = sourceOf(e.target);
    if (!src) return;
    e.preventDefault();
    // au doigt, l'objet flotte un peu au-dessus pour rester visible
    drag = { src, id: e.pointerId, x0: e.clientX, y0: e.clientY, lift: e.pointerType === 'mouse' ? 0 : 42, ghost: null, over: null };
    try { shop.setPointerCapture(e.pointerId); } catch { /* rien */ }
  });
  shop.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    if (!drag.ghost) {
      if (Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 8) return;
      drag.ghost = ghostOf(drag.src);
      document.body.appendChild(drag.ghost);
      drag.src.el.classList.add('dragging');
    }
    drag.ghost.style.left = `${e.clientX}px`;
    drag.ghost.style.top = `${e.clientY - drag.lift}px`;
    const over = targetAt(e.clientX, e.clientY - drag.lift);
    if (over !== drag.over) { drag.over?.classList.remove('over'); over?.classList.add('over'); drag.over = over; }
  });
  shop.addEventListener('pointerup', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const { src, ghost } = drag;
    const over = ghost ? targetAt(e.clientX, e.clientY - drag.lift) : null;
    endDrag();
    if (!g.running) return;
    if (!ghost) tap(src);
    else if (over) drop(src, over);
  });
  shop.addEventListener('pointercancel', endDrag);
  shop.addEventListener('lostpointercapture', endDrag);
  counter.addEventListener('click', (e) => {
    if (g.running && e.target.closest('.seat.on:not(.happy)')) toast('Drag a plate onto the customer');
  });

  cfg = burgerLevel(1); seats = [null, null, null]; trays = Array.from({ length: TRAYS }, emptyTray);
  grill = Array(GRILL_SLOTS).fill(null); fryer = Array(FRYER_SLOTS).fill(null); served = 0;
  showStats(); showBins(); showTrays();
  overlay(`<h2>Open the shop</h2>
    <p class="muted">Drag the patty, bacon or sausage onto the grill and the fries into the fryer (a tap works too). Take them out when the needle is in the green: too late and they burn.</p>
    <p class="muted">Drag a bun onto one of the 3 plates, then each ingredient onto that bun, in the bubble's order. Add fries and the drink, then drag the plate onto the customer.</p>
    <p class="muted small">Each order gives ${perOrder} ${COIN} (today: ${earned}/${cap}). Three angry customers and the shop closes. Record: $${Number(state.me.burger_best ?? 0)}</p>
    <button class="btn primary" id="b-start" type="button">Open the shop</button>`);
  $('b-start').addEventListener('click', startLevel);
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
      <form id="rates-form" class="panel stack">
        <h2>Game settings</h2>
        <p class="muted small">Chance for each card of a pack to be of this rarity. The total must be 100%.</p>
        <div class="rates-grid">
          ${RARITIES.map((r) => `<label><span class="pill r-${r.id}">${r.label}</span><span class="pct"><input name="rate_${r.id}" type="number" inputmode="decimal" min="0" max="100" step="any" value="${Number(state.settings?.[`rate_${r.id}`] ?? 0)}">%</span></label>`).join('')}
        </div>
        <p class="total" id="rates-total"></p>
        <div class="rates-grid">
          <label><span class="pill v-holo">Holo</span><small class="muted">share of Epics</small><span class="pct"><input name="holo_chance" type="number" inputmode="decimal" min="0" max="100" step="any" value="${Number(state.settings?.holo_chance ?? 25)}">%</span></label>
          <label><span class="pill v-gold">Gold</span><small class="muted">share of Legendaries</small><span class="pct"><input name="gold_chance" type="number" inputmode="decimal" min="0" max="100" step="any" value="${Number(state.settings?.gold_chance ?? 25)}">%</span></label>
          <label>Pack price<span class="pct"><input name="pack_price" type="number" inputmode="numeric" min="1" step="1" value="${packPrice()}">${COIN}</span></label>
          <label>Time between packs<span class="pct"><input name="cooldown_hours" type="number" inputmode="decimal" min="0.1" max="72" step="any" value="${Number(state.settings?.cooldown_hours ?? COOLDOWN_HOURS)}">h</span></label>
          <label>Free packs that stack up<span class="pct"><input name="max_stored_packs" type="number" inputmode="numeric" min="1" max="10" step="1" value="${maxPacks()}"></span></label>
        </div>
        <p class="muted small">Coins for each duplicate (×2 for Holo and Gold):</p>
        <div class="rates-grid">
          ${RARITIES.map((r) => `<label><span class="pill r-${r.id}">${r.label}</span><span class="pct"><input name="coins_${r.id}" type="number" inputmode="numeric" min="0" step="1" value="${coinValue(r.id)}">${COIN}</span></label>`).join('')}
        </div>
        <div class="rates-grid">
          <label>Blocks: coins per line<span class="pct"><input name="blocks_coins_per_line" type="number" inputmode="numeric" min="0" step="1" value="${Number(state.settings?.blocks_coins_per_line ?? 3)}">${COIN}</span></label>
          <label>Puzzle: coins per piece<span class="pct"><input name="puzzle_coins_per_piece" type="number" inputmode="numeric" min="0" step="1" value="${Number(state.settings?.puzzle_coins_per_piece ?? 2)}">${COIN}</span></label>
          <label>Burger Shop: coins per order<span class="pct"><input name="burger_coins_per_order" type="number" inputmode="numeric" min="0" step="1" value="${Number(state.settings?.burger_coins_per_order ?? 4)}">${COIN}</span></label>
          <label>Daily coin limit for games<span class="pct"><input name="games_daily_cap" type="number" inputmode="numeric" min="0" step="1" value="${Number(state.settings?.games_daily_cap ?? 60)}">${COIN}</span></label>
        </div>
        <button class="btn" type="submit">Save settings</button>
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

  const ratesForm = document.getElementById('rates-form');
  const totalEl = document.getElementById('rates-total');
  const rateSum = () => RARITIES.reduce((a, r) => a + Number(ratesForm[`rate_${r.id}`].value || 0), 0);
  const showTotal = () => {
    const t = Math.round(rateSum() * 100) / 100;
    totalEl.textContent = `Total: ${t}%`;
    totalEl.classList.toggle('bad', t !== 100);
  };
  showTotal();
  ratesForm.addEventListener('input', showTotal);
  ratesForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (Math.round(rateSum() * 100) / 100 !== 100) return toast('The rarity rates must add up to 100%', 'err');
    const patch = { updated_at: new Date().toISOString() };
    for (const k of [...RARITIES.map((r) => `rate_${r.id}`), 'holo_chance', 'gold_chance', 'cooldown_hours']) patch[k] = Number(ratesForm[k].value);
    for (const k of ['pack_price', 'max_stored_packs', 'blocks_coins_per_line', 'puzzle_coins_per_piece', 'burger_coins_per_order', 'games_daily_cap', ...RARITIES.map((r) => `coins_${r.id}`)]) patch[k] = Math.round(Number(ratesForm[k].value));
    const { data, error } = await sb.from('game_settings').update(patch).eq('id', 1).select().maybeSingle();
    if (error) return toast(error.message, 'err');
    if (data) state.settings = data;
    toast('Settings saved');
  });
}

/* ---------- routeur ---------- */

const routes = { booster: renderBooster, collection: renderCollection, jeu: renderJeu, blocks: renderBlocks, memory: renderMemory, puzzle: renderPuzzle, burger: renderBurger, ajouter: renderAjouter, profil: renderProfil };

async function route() {
  clearInterval(state.timer);
  if (!state.session) return renderLogin();
  const name = (location.hash.replace(/^#\/?/, '') || 'booster').split('?')[0];
  const page = routes[name] ? name : 'booster';
  $nav.hidden = false;
  const tab = ['blocks', 'memory', 'puzzle', 'burger'].includes(page) ? 'jeu' : page;
  $nav.querySelectorAll('a').forEach((a) => a.classList.toggle('active', a.dataset.route === tab));
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
