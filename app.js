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
      <a class="game-card" href="#/marbles">
        <span class="game-art marbles-art" aria-hidden="true">${['#ff4d6d', '#3d8bff', '#3d8bff', '#ffc933', '#36c96a', '#a45cff'].map((c, i) => `<i style="--c:${c};left:${[6, 18, 31, 43, 50, 46][i]}px;top:${[44, 50, 47, 38, 25, 12][i]}px"></i>`).join('')}</span>
        <span><b>Marbles</b><small class="muted">A chain of marbles rolls toward the hole: shoot to make three of the same color pop. Each level cleared gives ${Number(state.settings?.marbles_coins_per_level ?? 10)} ${COIN}, within the daily limit.</small></span>
      </a>
      <a class="game-card" href="#/merge">
        <span class="game-art merge-art" aria-hidden="true"><i>2</i><i>4</i><i>8</i><i>16</i></span>
        <span><b>2048 Cards</b><small class="muted">Slide your cards and merge equal ones, from Common up to Gold. From 128, each new card gives ${COIN}, within the daily limit.</small></span>
      </a>
      <a class="game-card" href="#/spot">
        <span class="game-art spot-art" aria-hidden="true"><i></i><i><b></b></i></span>
        <span><b>7 Differences</b><small class="muted">One of your photos and a copy with ${SD_COUNT} changes: find them all. Each photo solved gives ${Number(state.settings?.spot_coins_per_round ?? 15)} ${COIN}, within the daily limit.</small></span>
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
    <div class="tile r-${c.rarity}" role="button" tabindex="0" data-k="${k}" data-id="${c.id}" aria-label="Hidden card">
      <div class="tile-inner">
        <div class="tile-back">${backHTML()}</div>
        <div class="tile-front"><div class="tile-pic">${c.image_path && url(c.image_path) ? `<img src="${esc(url(c.image_path))}" alt="" draggable="false">` : `<span class="placeholder">${esc(firstEmoji(c.description))}</span>`}</div></div>
      </div>
    </div>`).join('');

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
  board.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.classList.contains('tile')) { e.preventDefault(); e.target.click(); }
  });
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

/* ---------- mini-jeu : Marbles (façon Zuma) ---------- */

const MB_W = 360;
const MB_H = 480;
const MB_R = 11;
const MB_D = MB_R * 2;
const MB_SHOT = 720; // vitesse d'une bille tirée, en px/s
const MB_BACK = 260; // vitesse à laquelle un morceau de chaîne revient quand les couleurs se touchent
const MB_COLORS = [
  ['#ff4d6d', '#ffd0da', '#9e1030'],
  ['#3d8bff', '#cfe2ff', '#123f8f'],
  ['#36c96a', '#cdf6da', '#13733a'],
  ['#ffc933', '#fff4c7', '#a87800'],
  ['#a45cff', '#e6d3ff', '#5418a3'],
  ['#f4f2f8', '#ffffff', '#8b8798'],
];
const MB_POWERS = { slow: '🐢', back: '⏪', bomb: '💥' };

function marblesLevel(n) {
  return {
    path: n % 2 ? 'spiral' : 'heart',
    colors: n <= 2 ? 4 : n <= 5 ? 5 : 6,
    total: Math.min(110, 34 + n * 6),
    speed: Math.min(30, 10 + n * 1.6),
    powers: n >= 2 ? 0.06 : 0.035,
  };
}

// le chemin des billes, rééchantillonné tous les 1 px pour placer une bille à une distance donnée
function marblesPath(kind) {
  const N = 4000;
  let pts = [];
  let shooter = [180, 236];
  const even = (list) => {
    const out = [list[0]];
    let acc = 0, next = 1, [px, py] = list[0];
    for (let i = 1; i < list.length; i++) {
      const [x, y] = list[i];
      const seg = Math.hypot(x - px, y - py);
      while (seg > 0 && acc + seg >= next) {
        const f = (next - acc) / seg;
        out.push([px + (x - px) * f, py + (y - py) * f]);
        next++;
      }
      acc += seg; px = x; py = y;
    }
    return out;
  };
  // moyenne glissante pour arrondir la pointe et le creux du cœur
  const smooth = (list, w) => list.map((_, i) => {
    let sx = 0, sy = 0, n = 0;
    for (let j = Math.max(0, i - w); j <= Math.min(list.length - 1, i + w); j++) { sx += list[j][0]; sy += list[j][1]; n++; }
    return [sx / n, sy / n];
  });
  if (kind === 'heart') {
    const t0 = 1.3 * Math.PI, t1 = 3.6 * Math.PI, k0 = 10.8, k1 = 5.6;
    for (let i = 0; i <= N; i++) {
      const u = i / N, t = t0 + u * (t1 - t0), k = k0 + (k1 - k0) * u;
      const x = 16 * Math.sign(Math.sin(t)) * Math.sin(t) ** 2;
      const y = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t);
      pts.push([180 + x * k, 232 - y * k * 1.18]);
    }
    pts = even(smooth(smooth(even(pts), 26), 26));
    shooter = [180, 258];
  } else {
    for (let i = 0; i <= N; i++) {
      const u = i / N, a = -Math.PI / 2 + u * 1.65 * 2 * Math.PI;
      pts.push([180 + (162 - 82 * u) * Math.cos(a), 236 + (218 - 108 * u) * Math.sin(a)]);
    }
    pts = even(pts);
  }
  return { xs: Float32Array.from(pts, (p) => p[0]), ys: Float32Array.from(pts, (p) => p[1]), L: pts.length - 1, shooter };
}

const marblesAt = (P, s) => {
  const v = Math.max(0, Math.min(P.L, s));
  const i = Math.floor(v), j = Math.min(P.L, i + 1), f = v - i;
  return [P.xs[i] + (P.xs[j] - P.xs[i]) * f, P.ys[i] + (P.ys[j] - P.ys[i]) * f];
};

function heartShape(ctx, s) { // pointe vers +y
  ctx.beginPath();
  ctx.moveTo(0, s * 0.95);
  ctx.bezierCurveTo(-s * 1.25, s * 0.1, -s * 0.95, -s * 0.95, 0, -s * 0.38);
  ctx.bezierCurveTo(s * 0.95, -s * 0.95, s * 1.25, s * 0.1, 0, s * 0.95);
  ctx.closePath();
}

async function renderMarbles() {
  const today = todayParis();
  const cap = Number(state.settings?.games_daily_cap ?? 60);
  let earned = state.me.game_coins_on === today ? Number(state.me.game_coins_today || 0) : 0;
  const perLevel = Number(state.settings?.marbles_coins_per_level ?? 10);
  const best = (p) => (Number(p?.marbles_best) ? String(p.marbles_best) : '—');
  const other = partner();
  let saved = 1;
  try { saved = Number(localStorage.getItem('marblesLevel')) || 1; } catch { /* rien */ }
  let level = Math.max(1, Math.min(saved, Number(state.me.marbles_best ?? 0) + 1));

  $app.innerHTML = `
    <section class="marbles-page">
      <a class="back-link" href="#/jeu">← Games</a>
      <header class="page-head">
        <h1>Marbles</h1>
        <p class="coins" id="coins">${Number(state.me.coins ?? 0)} ${COIN}</p>
      </header>
      <div class="mb-board" id="mb-board">
        <div class="bbar">
          <span>Level <b id="mb-level">${level}</b></span>
          <b id="mb-score">0</b>
          <span>Best <b id="mb-best">${best(state.me)}</b></span>
          ${other ? `<span>${esc(other.display_name || 'Partner')} <b>${best(other)}</b></span>` : ''}
        </div>
        <canvas id="mb-canvas" width="${MB_W}" height="${MB_H}"></canvas>
        <div class="mb-bar"><i id="mb-progress"></i></div>
        <div class="b-overlay" id="mb-overlay"></div>
      </div>
      <p class="muted small">Touch the board to aim and let go to shoot. Tap the heart to swap the two marbles.</p>
    </section>`;

  const $ = (id) => document.getElementById(id);
  const board = $('mb-board');
  const canvas = $('mb-canvas');
  const ctx = canvas.getContext('2d');
  let scale = 1, sprites = [], bg = null;
  let P, cfg, balls, shots, parts, floats, spawned, cleared, cur, nxt, angle, aiming, onShooter, reload;
  let score, combo, slowT, backT, rushing, st = 'intro', raf = 0, last = 0, t0 = 0;

  // une photo de vos cartes en fond, si vous en avez
  const photos = puzzlePool();
  if (photos.length) {
    const card = pick(photos);
    signedUrls([card.image_path]).then((url) => {
      const u = url(card.image_path);
      if (u && board.isConnected) board.style.setProperty('--photo', `url("${u.replace(/"/g, '%22')}")`);
    });
  }

  const overlay = (html) => {
    const o = $('mb-overlay');
    o.innerHTML = html ? `<div class="panel b-panel">${html}</div>` : '';
    o.classList.toggle('on', !!html);
  };

  // billes dessinées une fois par couleur, à la bonne résolution
  const makeSprites = () => {
    const px = Math.ceil(MB_D * scale) + 2;
    sprites = MB_COLORS.map(([base, light, dark]) => {
      const c = document.createElement('canvas');
      c.width = c.height = px;
      const g = c.getContext('2d');
      g.scale(px / MB_D, px / MB_D);
      const grad = g.createRadialGradient(MB_R * 0.65, MB_R * 0.6, MB_R * 0.1, MB_R, MB_R, MB_R);
      grad.addColorStop(0, light);
      grad.addColorStop(0.35, base);
      grad.addColorStop(1, dark);
      g.fillStyle = grad;
      g.beginPath(); g.arc(MB_R, MB_R, MB_R - 0.4, 0, Math.PI * 2); g.fill();
      g.fillStyle = 'rgba(255,255,255,.75)';
      g.beginPath(); g.ellipse(MB_R * 0.68, MB_R * 0.55, MB_R * 0.28, MB_R * 0.18, -0.6, 0, Math.PI * 2); g.fill();
      return c;
    });
  };

  // le rail, l'entrée et le trou, dessinés une fois par niveau
  const makeBg = () => {
    bg = document.createElement('canvas');
    bg.width = canvas.width; bg.height = canvas.height;
    const g = bg.getContext('2d');
    g.scale(scale, scale);
    const trace = () => { g.beginPath(); g.moveTo(P.xs[0], P.ys[0]); for (let i = 4; i <= P.L; i += 4) g.lineTo(P.xs[i], P.ys[i]); g.lineTo(P.xs[P.L], P.ys[P.L]); };
    g.lineCap = 'round'; g.lineJoin = 'round';
    trace(); g.strokeStyle = 'rgba(10,4,14,.55)'; g.lineWidth = MB_D + 10; g.stroke();
    trace(); g.strokeStyle = 'rgba(255,255,255,.07)'; g.lineWidth = MB_D + 2; g.stroke();
    trace(); g.strokeStyle = 'rgba(255,255,255,.05)'; g.lineWidth = 2; g.setLineDash([2, 9]); g.stroke(); g.setLineDash([]);
    const [sx, sy] = [P.xs[0], P.ys[0]];
    g.fillStyle = '#140b18'; g.beginPath(); g.arc(sx, sy, MB_R + 6, 0, Math.PI * 2); g.fill();
    g.strokeStyle = 'rgba(255,255,255,.25)'; g.lineWidth = 2; g.stroke();
  };

  const resize = () => {
    const w = canvas.clientWidth || MB_W;
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    scale = (w * dpr) / MB_W;
    canvas.width = Math.round(MB_W * scale);
    canvas.height = Math.round(MB_H * scale);
    makeSprites();
    if (P) makeBg();
  };

  const present = () => [...new Set(balls.map((b) => b.c))];
  const randColor = () => {
    const pool = spawned >= cfg.total && balls.length ? present() : [...Array(cfg.colors).keys()];
    return pick(pool);
  };
  const fixShooter = () => {
    if (spawned < cfg.total || !balls.length) return;
    const pool = present();
    if (!pool.includes(cur)) cur = pick(pool);
    if (!pool.includes(nxt)) nxt = pick(pool);
  };
  const newBall = (s) => {
    const prev = balls[0];
    let c;
    // des suites de 1 ou 2 couleurs, jamais 3 identiques d'entrée
    if (prev && Math.random() < 0.38 && !(balls[1] && balls[1].c === prev.c)) c = prev.c;
    else { do c = Math.floor(Math.random() * cfg.colors); while (prev && c === prev.c && cfg.colors > 1); }
    const pw = spawned > 6 && Math.random() < cfg.powers ? pick(Object.keys(MB_POWERS)) : null;
    return { c, s, pw };
  };

  const showStats = () => {
    $('mb-level').textContent = level;
    $('mb-score').textContent = score;
    $('mb-progress').style.width = `${Math.min(100, (cleared / cfg.total) * 100)}%`;
  };

  const startLevel = () => {
    cfg = marblesLevel(level);
    P = marblesPath(cfg.path);
    resize();
    balls = []; shots = []; parts = []; floats = [];
    spawned = 0; cleared = 0; score = 0; combo = 0; slowT = 0; backT = 0; reload = 0;
    rushing = true; aiming = false;
    angle = -Math.PI / 2;
    cur = Math.floor(Math.random() * cfg.colors); nxt = Math.floor(Math.random() * cfg.colors);
    st = 'play';
    t0 = performance.now();
    try { localStorage.setItem('marblesLevel', String(level)); } catch { /* rien */ }
    overlay('');
    showStats();
    last = performance.now();
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(frame);
  };

  const pop = (removed) => {
    const n = removed.length;
    const gain = n * 10 * Math.max(1, combo);
    score += gain;
    cleared += n;
    let sx = 0, sy = 0;
    for (const b of removed) {
      const [x, y] = marblesAt(P, b.s);
      sx += x; sy += y;
      for (let k = 0; k < 5; k++) {
        const a = Math.random() * Math.PI * 2, v = 40 + Math.random() * 90;
        parts.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, t: 0.45, c: b.c });
      }
    }
    floats.push({ x: sx / n, y: sy / n, t: 1, text: `+${gain}${combo > 1 ? `  ×${combo}` : ''}` });
    for (const b of removed) if (b.pw) power(b.pw, b);
    showStats();
    fixShooter();
  };

  function power(kind, b) {
    const [x, y] = marblesAt(P, b.s);
    floats.push({ x, y: y - 16, t: 1.2, text: MB_POWERS[kind] });
    if (kind === 'slow') slowT = 6;
    else if (kind === 'back') backT = 2.5;
    else {
      const near = balls.filter((o) => {
        if (o.s < -MB_R) return false;
        const [ox, oy] = marblesAt(P, o.s);
        return Math.hypot(ox - x, oy - y) < 62;
      });
      if (near.length) { balls = balls.filter((o) => !near.includes(o)); pop(near); }
    }
  }

  // groupe de même couleur collé autour de la bille i ; 3 ou plus disparaissent
  const matchAt = (i) => {
    const c = balls[i].c;
    let a = i, b = i;
    while (a > 0 && balls[a - 1].c === c && balls[a].s - balls[a - 1].s <= MB_D + 0.6) a--;
    while (b < balls.length - 1 && balls[b + 1].c === c && balls[b + 1].s - balls[b].s <= MB_D + 0.6) b++;
    if (b - a + 1 < 3) return false;
    combo++;
    pop(balls.splice(a, b - a + 1));
    return true;
  };

  const insertShot = (sh, j) => {
    const b = balls[j];
    const [ax, ay] = marblesAt(P, b.s + MB_R);
    const [bx, by] = marblesAt(P, b.s - MB_R);
    const ahead = (sh.x - ax) ** 2 + (sh.y - ay) ** 2 < (sh.x - bx) ** 2 + (sh.y - by) ** 2;
    const nb = { c: sh.c, s: ahead ? b.s + MB_D : b.s, ix: sh.x, iy: sh.y, it: 0.12, chk: true };
    balls.splice(ahead ? j + 1 : j, 0, nb);
    combo = 0;
  };

  const fire = () => {
    if (st !== 'play' || reload > 0 || shots.length >= 2) return;
    const [x, y] = P.shooter;
    shots.push({ x: x + Math.cos(angle) * 26, y: y + Math.sin(angle) * 26, vx: Math.cos(angle) * MB_SHOT, vy: Math.sin(angle) * MB_SHOT, c: cur });
    cur = nxt;
    nxt = randColor();
    reload = 0.16;
  };

  const win = () => {
    st = 'won';
    const secs = Math.round((performance.now() - t0) / 1000);
    overlay(`<h2>Level ${level} cleared!</h2><p>Score ${score} · ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}</p><p class="muted small" id="mb-gain">…</p><button class="btn primary" id="mb-next" type="button">Next level</button>`);
    const done = level;
    $('mb-next').addEventListener('click', () => { level = done + 1; startLevel(); });
    try { localStorage.setItem('marblesLevel', String(done + 1)); } catch { /* rien */ }
    sb.rpc('marbles_level', { level: done }).then(({ data, error }) => {
      const el = $('mb-gain');
      if (error || !data) { if (el) el.textContent = ''; return; }
      state.me.coins = data.coins;
      state.me.game_coins_on = today;
      state.me.game_coins_today = data.today;
      state.me.marbles_best = data.best;
      earned = data.today;
      if ($('coins')) $('coins').textContent = `${data.coins} ${COIN}`;
      if ($('mb-best')) $('mb-best').textContent = best(state.me);
      if (el) el.textContent = data.gain ? `+${data.gain} ${COIN} (today: ${data.today}/${data.cap})` : data.today >= data.cap ? 'Daily coin limit reached' : '';
    });
  };
  const lose = () => {
    st = 'lost';
    overlay(`<h2>The marbles reached the hole</h2><p>Level ${level} · Score ${score}</p><button class="btn primary" id="mb-retry" type="button">Try again</button>`);
    $('mb-retry').addEventListener('click', startLevel);
  };

  function update(dt) {
    reload -= dt;
    slowT = Math.max(0, slowT - dt);
    backT = Math.max(0, backT - dt);
    parts = parts.filter((p) => (p.t -= dt) > 0);
    parts.forEach((p) => { p.x += p.vx * dt; p.y += p.vy * dt; });
    floats = floats.filter((f) => (f.t -= dt) > 0);

    if (st === 'sinking') {
      balls.forEach((b) => { b.s += 520 * dt; });
      balls = balls.filter((b) => b.s < P.L + MB_R);
      if (!balls.length) lose();
      return;
    }
    if (st !== 'play') return;

    // nouvelles billes qui sortent de l'entrée
    while (spawned < cfg.total && (!balls.length || balls[0].s >= 0)) {
      const s0 = balls.length ? balls[0].s : MB_D;
      balls.unshift(newBall(s0 < MB_D ? s0 - MB_D : -MB_D));
      spawned++;
    }

    // tirs en vol
    for (const sh of shots) {
      const steps = Math.ceil((MB_SHOT * dt) / 6);
      for (let k = 0; k < steps && !sh.done; k++) {
        sh.x += (sh.vx * dt) / steps; sh.y += (sh.vy * dt) / steps;
        if (sh.x < -30 || sh.x > MB_W + 30 || sh.y < -30 || sh.y > MB_H + 30) { sh.done = true; break; }
        for (let j = 0; j < balls.length; j++) {
          if (balls[j].s < -MB_R) continue;
          const [x, y] = marblesAt(P, balls[j].s);
          if ((x - sh.x) ** 2 + (y - sh.y) ** 2 < (MB_D * 0.92) ** 2) { insertShot(sh, j); sh.done = true; break; }
        }
      }
    }
    shots = shots.filter((sh) => !sh.done);

    // la chaîne avance : le morceau du fond pousse, les autres attendent ou reviennent vers une même couleur
    const n = balls.length;
    for (let i = 0; i < n; i++) balls[i].gb = i > 0 && balls[i].s - balls[i - 1].s > MB_D + 0.5;
    const head = n ? balls[n - 1].s : 0;
    if (rushing && head > P.L * 0.22) rushing = false;
    let fwd = rushing ? 340 : cfg.speed * (slowT > 0 ? 0.35 : 1) * (head > P.L * 0.78 ? 0.55 : 1);
    if (backT > 0) fwd = -Math.max(70, cfg.speed * 3);
    let a = 0;
    for (let i = 1; i <= n; i++) {
      if (i === n || balls[i].gb) {
        const mv = a === 0 ? fwd * dt : balls[a].c === balls[a - 1].c ? -MB_BACK * dt : 0;
        for (let j = a; j < i; j++) balls[j].s += mv;
        a = i;
      }
    }
    const joins = [];
    for (let i = 1; i < n; i++) {
      if (balls[i].s < balls[i - 1].s + MB_D) {
        if (balls[i].gb) joins.push(balls[i]);
        balls[i].s = balls[i - 1].s + MB_D;
      }
    }
    for (const b of joins) {
      const i = balls.indexOf(b);
      if (i > 0 && balls[i - 1].c === b.c) matchAt(i);
    }
    // une bille tirée qui vient de se poser
    for (const b of balls) if (b.it > 0) b.it -= dt;
    const landed = balls.find((b) => b.chk && !(b.it > 0));
    if (landed) { landed.chk = false; matchAt(balls.indexOf(landed)); }

    if (balls.length && balls[balls.length - 1].s >= P.L) { st = 'sinking'; shots = []; aiming = false; return; }
    if (spawned >= cfg.total && !balls.length) win();
  }

  // premier obstacle sur la ligne de visée
  const aimEnd = () => {
    const [x0, y0] = P.shooter;
    const dx = Math.cos(angle), dy = Math.sin(angle);
    for (let d = 26; d < 640; d += 7) {
      const x = x0 + dx * d, y = y0 + dy * d;
      if (x < 0 || x > MB_W || y < 0 || y > MB_H) return [x, y];
      for (const b of balls) {
        if (b.s < 0) continue;
        const [bx, by] = marblesAt(P, b.s);
        if ((bx - x) ** 2 + (by - y) ** 2 < MB_D * MB_D * 0.85) return [x, y];
      }
    }
    return [x0 + dx * 640, y0 + dy * 640];
  };

  const ball = (c, x, y, r = MB_R) => ctx.drawImage(sprites[c], x - r, y - r, r * 2, r * 2);

  function draw() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (bg) ctx.drawImage(bg, 0, 0);
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    if (!P) return;

    // le trou, rouge quand la chaîne approche
    const head = balls.length ? balls[balls.length - 1].s / P.L : 0;
    const [hx, hy] = [P.xs[P.L], P.ys[P.L]];
    const danger = Math.max(0, (head - 0.7) / 0.3);
    if (danger > 0) {
      const glow = ctx.createRadialGradient(hx, hy, 6, hx, hy, 40);
      glow.addColorStop(0, `rgba(255,60,90,${0.65 * danger * (0.75 + 0.25 * Math.sin(performance.now() / 120))})`);
      glow.addColorStop(1, 'rgba(255,60,90,0)');
      ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(hx, hy, 40, 0, Math.PI * 2); ctx.fill();
    }
    const hole = ctx.createRadialGradient(hx, hy, 2, hx, hy, MB_R + 8);
    hole.addColorStop(0, '#000'); hole.addColorStop(0.75, '#1d0d22'); hole.addColorStop(1, '#ff6f9c');
    ctx.fillStyle = hole; ctx.beginPath(); ctx.arc(hx, hy, MB_R + 8, 0, Math.PI * 2); ctx.fill();

    ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const b of balls) {
      if (b.s < -MB_R + 2) continue;
      let [x, y] = marblesAt(P, Math.min(b.s, P.L));
      if (b.it > 0) { const f = b.it / 0.12; x += (b.ix - x) * f; y += (b.iy - y) * f; }
      ball(b.c, x, y);
      if (b.pw) ctx.fillText(MB_POWERS[b.pw], x, y + 0.5);
    }
    for (const sh of shots) ball(sh.c, sh.x, sh.y);

    // lanceur en forme de cœur, la pointe vers la cible
    const [sx, sy] = P.shooter;
    if (aiming && st === 'play' && !onShooter) {
      const [ex, ey] = aimEnd();
      ctx.save();
      ctx.strokeStyle = MB_COLORS[cur][0]; ctx.globalAlpha = 0.55; ctx.lineWidth = 2; ctx.setLineDash([3, 7]);
      ctx.beginPath(); ctx.moveTo(sx + Math.cos(angle) * 36, sy + Math.sin(angle) * 36); ctx.lineTo(ex, ey); ctx.stroke();
      ctx.restore();
    }
    ctx.save();
    ctx.translate(sx, sy);
    ctx.rotate(angle - Math.PI / 2);
    ctx.shadowColor = 'rgba(0,0,0,.45)'; ctx.shadowBlur = 8; ctx.shadowOffsetY = 3;
    const hg = ctx.createLinearGradient(0, -24, 0, 24);
    hg.addColorStop(0, '#ff9ab8'); hg.addColorStop(1, '#c2346b');
    ctx.fillStyle = hg; heartShape(ctx, 24); ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.strokeStyle = 'rgba(255,255,255,.55)'; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.restore();
    if (st === 'play' || st === 'intro') {
      ball(cur, sx + Math.cos(angle) * 26, sy + Math.sin(angle) * 26);
      ball(nxt, sx - Math.cos(angle) * 3, sy - Math.sin(angle) * 3, 6.5);
    }

    for (const p of parts) {
      ctx.globalAlpha = Math.min(1, p.t / 0.3);
      ctx.fillStyle = MB_COLORS[p.c][0];
      ctx.beginPath(); ctx.arc(p.x, p.y, 2.6, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.font = '700 15px "DM Sans", system-ui, sans-serif';
    for (const f of floats) {
      ctx.globalAlpha = Math.min(1, f.t / 0.5);
      ctx.fillStyle = '#fff'; ctx.strokeStyle = 'rgba(20,10,25,.8)'; ctx.lineWidth = 3;
      const y = f.y - (1 - f.t) * 26;
      ctx.strokeText(f.text, f.x, y); ctx.fillText(f.text, f.x, y);
    }
    ctx.globalAlpha = 1;
  }

  function frame(now) {
    if (!canvas.isConnected) return;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (!document.hidden) update(dt);
    draw();
    raf = requestAnimationFrame(frame);
  }

  // visée au doigt ou à la souris
  const local = (e) => {
    const r = canvas.getBoundingClientRect();
    return [((e.clientX - r.left) * MB_W) / r.width, ((e.clientY - r.top) * MB_H) / r.height];
  };
  const nearShooter = ([x, y]) => P && Math.hypot(x - P.shooter[0], y - P.shooter[1]) < 30;
  const aimAt = (pt) => { if (!nearShooter(pt)) angle = Math.atan2(pt[1] - P.shooter[1], pt[0] - P.shooter[0]); };
  canvas.addEventListener('pointerdown', (e) => {
    if (st !== 'play' || !e.isPrimary) return;
    e.preventDefault();
    const pt = local(e);
    aiming = true;
    onShooter = nearShooter(pt);
    try { canvas.setPointerCapture(e.pointerId); } catch { /* rien */ }
    aimAt(pt);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (st !== 'play' || (!aiming && e.pointerType !== 'mouse')) return;
    const pt = local(e);
    if (onShooter && !nearShooter(pt)) onShooter = false;
    aimAt(pt);
  });
  canvas.addEventListener('pointerup', (e) => {
    if (!aiming) return;
    aiming = false;
    const pt = local(e);
    if (onShooter && nearShooter(pt)) { [cur, nxt] = [nxt, cur]; onShooter = false; return; }
    onShooter = false;
    aimAt(pt);
    fire();
  });
  canvas.addEventListener('pointercancel', () => { aiming = false; onShooter = false; });
  canvas.mbState = () => ({ st, level, score, spawned, total: cfg.total, cur, nxt, shooter: P.shooter, balls: balls.map((b) => ({ c: b.c, s: b.s, pos: marblesAt(P, b.s) })) }); // pour les tests
  window.addEventListener('resize', function onResize() {
    if (!canvas.isConnected) { window.removeEventListener('resize', onResize); return; }
    resize();
  });

  // écran d'accueil avec le chemin du niveau en fond
  cfg = marblesLevel(level);
  P = marblesPath(cfg.path);
  balls = []; shots = []; parts = []; floats = []; spawned = 0; cleared = 0; score = 0;
  angle = -Math.PI / 2; cur = 0; nxt = 1;
  resize();
  showStats();
  draw();
  overlay(`<h2>Level ${level}</h2>
    <p class="muted">A chain of marbles rolls toward the hole. Shoot marbles into it: three or more of the same color pop. Don't let the chain reach the hole!</p>
    <p class="muted small">Some marbles carry a bonus: ${MB_POWERS.slow} slows the chain, ${MB_POWERS.back} pushes it back, ${MB_POWERS.bomb} blows up its neighbours. Each level cleared gives ${perLevel} ${COIN} (today: ${earned}/${cap}).</p>
    <button class="btn primary" id="mb-start" type="button">Play level ${level}</button>
    ${level > 1 ? '<button class="btn ghost" id="mb-restart" type="button">Start again from level 1</button>' : ''}`);
  $('mb-start').addEventListener('click', startLevel);
  $('mb-restart')?.addEventListener('click', () => { level = 1; startLevel(); });
}

/* ---------- mini-jeu : 2048 en cartes ---------- */

const MG_N = 4;
// 2 et 4 communes, 8 et 16 peu communes… 1024 légendaire, 2048 et plus en Gold
const mergeRarity = (v) => {
  const k = Math.log2(v);
  return k <= 2 ? 'commune' : k <= 4 ? 'peu_commune' : k <= 6 ? 'rare' : k <= 8 ? 'epique' : 'legendaire';
};
const mergeGold = (v) => v >= 2048;

function loadMergeGame() {
  try { return JSON.parse(localStorage.getItem('mergeGame') || 'null'); } catch { return null; }
}
function saveMergeGame(g) {
  try { localStorage.setItem('mergeGame', JSON.stringify(g)); } catch { /* stockage indisponible */ }
}

// une photo de vos cartes pour chaque valeur, de la bonne rareté si vous en avez une
function mergePhotos() {
  const pool = puzzlePool();
  const photos = {};
  for (let v = 2; v <= 65536; v *= 2) {
    const r = mergeRarity(v);
    const same = pool.filter((c) => c.rarity === r);
    const c = same.length ? pick(same) : pool.length ? pick(pool) : null;
    if (c) photos[v] = c.id;
  }
  return photos;
}

function newMergeGame() {
  const g = { cells: Array(MG_N * MG_N).fill(0), score: 0, claimed: [], photos: mergePhotos(), won: false };
  mergeSpawn(g); mergeSpawn(g);
  return g;
}
function mergeSpawn(g) {
  const free = g.cells.map((v, i) => (v ? -1 : i)).filter((i) => i >= 0);
  if (!free.length) return -1;
  const i = pick(free);
  g.cells[i] = Math.random() < 0.9 ? 2 : 4;
  return i;
}
const mergeCanMove = (cells) => cells.some((v, i) => !v
  || (i % MG_N < MG_N - 1 && cells[i + 1] === v)
  || (i + MG_N < cells.length && cells[i + MG_N] === v));

async function renderMerge() {
  const today = todayParis();
  const cap = Number(state.settings?.games_daily_cap ?? 60);
  let earned = state.me.game_coins_on === today ? Number(state.me.game_coins_today || 0) : 0;
  const perTile = Number(state.settings?.merge_coins_per_tile ?? 5);
  const other = partner();
  const bestTile = (p) => (Number(p?.merge_best) ? String(p.merge_best) : '—');
  let g = loadMergeGame();
  if (!g || g.cells?.length !== MG_N * MG_N) { g = newMergeGame(); saveMergeGame(g); }
  let bestScore = 0;
  try { bestScore = Number(localStorage.getItem('mergeBest')) || 0; } catch { /* rien */ }

  $app.innerHTML = `
    <section class="merge-page">
      <a class="back-link" href="#/jeu">← Games</a>
      <header class="page-head">
        <h1>2048 Cards</h1>
        <p class="coins" id="coins">${Number(state.me.coins ?? 0)} ${COIN}</p>
      </header>
      <div class="scores">
        <div><small class="muted">Score</small><b id="mg-score">${g.score}</b></div>
        <div><small class="muted">Best tile</small><b id="mg-best">${bestTile(state.me)}</b></div>
        ${other ? `<div><small class="muted">${esc(other.display_name || 'Partner')}</small><b>${bestTile(other)}</b></div>` : ''}
      </div>
      <p class="muted small">Swipe to slide every card. Two equal cards merge into the next one, from Common up to Legendary, then Gold at 2048. From 128, each new card earns ${COIN}.</p>
      <div class="mg-board" id="mg-board">
        ${Array.from({ length: MG_N * MG_N }, () => '<i class="mg-cell"></i>').join('')}
        <div class="mg-end" id="mg-end"></div>
      </div>
      <div class="reveal-actions"><button class="btn ghost" id="mg-new" type="button">New game</button></div>
    </section>`;

  const $ = (id) => document.getElementById(id);
  const board = $('mg-board');
  const ids = [...new Set(Object.values(g.photos))];
  const card = (v) => state.cards.find((c) => c.id === g.photos[v]);
  let url = () => '';
  let tiles = []; // { v, i, el }

  const tileHTML = (v) => {
    const c = card(v);
    const src = c?.image_path && url(c.image_path);
    return `${src ? `<img src="${esc(src)}" alt="" draggable="false">` : `<span class="mg-emoji">${esc(c ? firstEmoji(c.description) : '♥')}</span>`}<b>${v}</b>`;
  };
  const place = (el, i) => { el.style.setProperty('--r', Math.floor(i / MG_N)); el.style.setProperty('--c', i % MG_N); };
  const makeTile = (v, i, cls = '') => {
    const el = document.createElement('div');
    el.className = `mg-tile r-${mergeRarity(v)}${mergeGold(v) ? ' gold' : ''} ${cls}`;
    el.innerHTML = tileHTML(v);
    place(el, i);
    board.insertBefore(el, $('mg-end'));
    return { v, i, el };
  };
  const drawAll = () => {
    tiles.forEach((t) => t.el.remove());
    tiles = g.cells.map((v, i) => (v ? makeTile(v, i) : null)).filter(Boolean);
  };
  const showScore = () => {
    $('mg-score').textContent = g.score;
    if (g.score > bestScore) { bestScore = g.score; try { localStorage.setItem('mergeBest', String(bestScore)); } catch { /* rien */ } }
  };
  const end = (html) => {
    const e = $('mg-end');
    e.innerHTML = html ? `<div class="panel b-panel">${html}</div>` : '';
    e.classList.toggle('on', !!html);
  };

  const claim = (v) => {
    if (v < 128 || g.claimed.includes(v)) return;
    g.claimed.push(v);
    saveMergeGame(g);
    sb.rpc('merge_tile', { value: v }).then(({ data }) => {
      if (!data) return;
      state.me.coins = data.coins;
      state.me.game_coins_on = today;
      state.me.game_coins_today = data.today;
      state.me.merge_best = data.best;
      if ($('coins')) $('coins').textContent = `${data.coins} ${COIN}`;
      if ($('mg-best')) $('mg-best').textContent = bestTile(state.me);
      if (data.gain) toast(`New ${RARITY[mergeRarity(v)].label}${mergeGold(v) ? ' Gold' : ''} card: +${data.gain} ${COIN}`);
      else if (earned < data.cap && data.today >= data.cap) toast('Daily coin limit reached');
      earned = data.today;
    });
  };

  let busy = false;
  const move = (dir) => {
    if (busy || $('mg-end').classList.contains('on')) return;
    // dir : 0 gauche, 1 droite, 2 haut, 3 bas
    const at = new Map(tiles.map((t) => [t.i, t]));
    const moved = [], merged = [];
    const cells = Array(MG_N * MG_N).fill(0);
    let gain = 0;
    for (let line = 0; line < MG_N; line++) {
      const idx = [...Array(MG_N).keys()].map((k) => {
        const p = dir === 1 || dir === 3 ? MG_N - 1 - k : k;
        return dir <= 1 ? line * MG_N + p : p * MG_N + line;
      });
      let w = 0, lastTile = null;
      for (const i of idx) {
        const t = at.get(i);
        if (!t) continue;
        if (lastTile && lastTile.v === t.v && !lastTile.done) {
          const target = idx[w - 1];
          moved.push([t, target]);
          lastTile.done = true;
          cells[target] = t.v * 2;
          merged.push({ a: lastTile, b: t, i: target, v: t.v * 2 });
          gain += t.v * 2;
        } else {
          const target = idx[w++];
          moved.push([t, target]);
          cells[target] = t.v;
          lastTile = t;
        }
      }
    }
    tiles.forEach((t) => delete t.done);
    if (!moved.some(([t, i]) => t.i !== i) && !merged.length) return;
    busy = true;
    moved.forEach(([t, i]) => { t.i = i; place(t.el, i); });
    g.cells = cells;
    g.score += gain;
    const spawned = mergeSpawn(g);
    saveMergeGame(g);
    setTimeout(() => {
      for (const m of merged) {
        m.a.el.remove(); m.b.el.remove();
        tiles = tiles.filter((t) => t !== m.a && t !== m.b);
        tiles.push(makeTile(m.v, m.i, 'merged'));
        claim(m.v);
      }
      if (spawned >= 0) tiles.push(makeTile(g.cells[spawned], spawned, 'new'));
      showScore();
      busy = false;
      const top = Math.max(...g.cells);
      if (top >= 2048 && !g.won) {
        g.won = true; saveMergeGame(g);
        end(`<h2>A Gold card!</h2><p>You reached 2048 · Score ${g.score}</p><button class="btn primary" id="mg-go" type="button">Keep going</button>`);
        $('mg-go').addEventListener('click', () => end(''));
      } else if (!mergeCanMove(g.cells)) {
        end(`<h2>No more moves</h2><p>Score ${g.score} · Best card ${top}</p>${g.score >= bestScore ? '<p class="record">Best score!</p>' : `<p class="muted small">Best score: ${bestScore}</p>`}<button class="btn primary" id="mg-again" type="button">New game</button>`);
        $('mg-again').addEventListener('click', restart);
      }
    }, 130);
  };

  const restart = () => {
    g = newMergeGame();
    saveMergeGame(g);
    end('');
    signedUrls(Object.values(g.photos).map((id) => state.cards.find((c) => c.id === id)?.image_path)).then((u) => {
      url = u;
      drawAll();
    });
    showScore();
    drawAll();
  };
  $('mg-new').addEventListener('click', () => { if (g.score === 0 || confirmNew()) restart(); });
  const confirmNew = () => {
    const b = $('mg-new');
    if (b.dataset.sure) return true;
    b.dataset.sure = '1';
    b.textContent = 'Tap again to start over';
    setTimeout(() => { if (b.isConnected) { delete b.dataset.sure; b.textContent = 'New game'; } }, 2500);
    return false;
  };

  // glisser le doigt, ou les flèches du clavier
  let start = null;
  board.addEventListener('pointerdown', (e) => {
    if (!e.isPrimary) return;
    start = [e.clientX, e.clientY];
    try { board.setPointerCapture(e.pointerId); } catch { /* rien */ }
  });
  board.addEventListener('pointerup', (e) => {
    if (!start) return;
    const dx = e.clientX - start[0], dy = e.clientY - start[1];
    start = null;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < 24) return;
    move(Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? 0 : 1) : (dy < 0 ? 2 : 3));
  });
  board.addEventListener('pointercancel', () => { start = null; });
  const onKey = (e) => {
    if (!board.isConnected) { window.removeEventListener('keydown', onKey); return; }
    const dir = { ArrowLeft: 0, ArrowRight: 1, ArrowUp: 2, ArrowDown: 3 }[e.key];
    if (dir === undefined) return;
    e.preventDefault();
    move(dir);
  };
  window.addEventListener('keydown', onKey);

  drawAll();
  if (!mergeCanMove(g.cells)) {
    end(`<h2>No more moves</h2><p>Score ${g.score}</p><button class="btn primary" id="mg-again" type="button">New game</button>`);
    $('mg-again').addEventListener('click', restart);
  }
  url = await signedUrls(ids.map((id) => state.cards.find((c) => c.id === id)?.image_path));
  if (board.isConnected) drawAll();
}

/* ---------- mini-jeu : 7 différences ---------- */

const SD_W = 360, SD_H = 270, SD_COUNT = 7, SD_LIVES = 3;
const SD_KINDS = ['mirror', 'flip', 'turn', 'clone', 'erase', 'tint', 'shade', 'zoom'];

// charge la photo en essayant d'abord en CORS, pour pouvoir lire ses pixels
function spotLoadImage(src) {
  const load = (cors) => new Promise((resolve, reject) => {
    const img = new Image();
    if (cors) img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
  return load(true).catch(() => load(false));
}

// une mesure du détail de la photo autour d'un point, pour que les différences tombent sur quelque chose de visible
function spotDetail(base) {
  try {
    const c = document.createElement('canvas');
    c.width = SD_W; c.height = SD_H;
    const x = c.getContext('2d');
    x.drawImage(base, 0, 0, SD_W, SD_H);
    const d = x.getImageData(0, 0, SD_W, SD_H).data;
    const lum = (px, py) => { const i = (py * SD_W + px) * 4; return d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11; };
    return (cx, cy, r) => {
      let s = 0, n = 0;
      for (let py = Math.max(1, Math.round(cy - r)); py < Math.min(SD_H - 1, cy + r); py += 3) {
        for (let px = Math.max(1, Math.round(cx - r)); px < Math.min(SD_W - 1, cx + r); px += 3) {
          s += Math.abs(lum(px + 1, py) - lum(px - 1, py)) + Math.abs(lum(px, py + 1) - lum(px, py - 1));
          n++;
        }
      }
      return n ? s / n : 0;
    };
  } catch {
    return null; // photo sans CORS : on place les différences au hasard
  }
}

function spotPlan(detail) {
  const kinds = [...SD_KINDS].sort(() => Math.random() - 0.5).slice(0, SD_COUNT);
  const diffs = [];
  const free = (x, y, r) => diffs.every((d) => Math.hypot(d.x - x, d.y - y) > d.r + r + 10);
  const inside = (x, y, r) => x > r && y > r && x < SD_W - r && y < SD_H - r;
  for (const kind of kinds) {
    const r = 10 + Math.random() * 5;
    let best = null;
    for (let k = 0; k < 60; k++) {
      const x = r + 6 + Math.random() * (SD_W - 2 * r - 12);
      const y = r + 6 + Math.random() * (SD_H - 2 * r - 12);
      if (!free(x, y, r)) continue;
      // toujours sur un endroit avec du détail, pour que la retouche touche un vrai objet
      const score = detail ? detail(x, y, r) : Math.random();
      if (!best || score > best.score) best = { x, y, r, score };
    }
    if (!best) continue;
    const d = { kind, x: best.x, y: best.y, r: best.r };
    if (kind === 'clone' || kind === 'erase') {
      // clone : un morceau d'ailleurs ; erase : le décor juste à côté recouvre l'objet
      for (let k = 0; k < 40 && d.sx === undefined; k++) {
        let sx, sy;
        if (kind === 'clone') { sx = Math.random() * SD_W; sy = Math.random() * SD_H; }
        else { const a = Math.random() * Math.PI * 2; sx = d.x + Math.cos(a) * d.r * 2.4; sy = d.y + Math.sin(a) * d.r * 2.4; }
        if (inside(sx, sy, d.r) && Math.hypot(sx - d.x, sy - d.y) > (kind === 'clone' ? 5 : 2) * d.r) { d.sx = sx; d.sy = sy; }
      }
      if (d.sx === undefined) d.kind = 'tint';
    }
    if (d.kind === 'tint') d.hue = Math.floor(Math.random() * 360);
    if (kind === 'shade') d.dark = Math.random() < 0.5;
    diffs.push(d);
  }
  return diffs;
}

// chaque retouche est peinte à part puis fondue sur les bords, pour qu'aucun contour ne la trahisse
function spotEdit(ctx, base, d, k) {
  const p = document.createElement('canvas');
  p.width = SD_W * k; p.height = SD_H * k;
  const c = p.getContext('2d');
  c.setTransform(k, 0, 0, k, 0, 0);
  const all = () => c.drawImage(base, 0, 0, SD_W, SD_H);
  c.save();
  if (d.kind === 'mirror') { c.translate(2 * d.x, 0); c.scale(-1, 1); all(); }
  else if (d.kind === 'flip') { c.translate(0, 2 * d.y); c.scale(1, -1); all(); }
  else if (d.kind === 'turn') { c.translate(d.x, d.y); c.rotate(Math.PI / 2); c.translate(-d.x, -d.y); all(); }
  else if (d.kind === 'zoom') { c.translate(d.x, d.y); c.scale(1.6, 1.6); c.translate(-d.x, -d.y); all(); }
  else if (d.kind === 'clone' || d.kind === 'erase') { c.translate(d.x - d.sx, d.y - d.sy); all(); }
  else {
    all();
    if (d.kind === 'tint') {
      c.globalCompositeOperation = 'color';
      c.globalAlpha = 0.6;
      c.fillStyle = `hsl(${d.hue} 95% 50%)`;
    } else {
      c.fillStyle = d.dark ? 'rgba(0,0,0,.42)' : 'rgba(255,255,255,.42)';
    }
    c.fillRect(d.x - d.r * 1.3, d.y - d.r * 1.3, d.r * 2.6, d.r * 2.6);
  }
  c.restore();
  const g = c.createRadialGradient(d.x, d.y, d.r * 0.7, d.x, d.y, d.r * 1.1);
  g.addColorStop(0, '#000');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  c.globalCompositeOperation = 'destination-in';
  c.fillStyle = g;
  c.fillRect(0, 0, SD_W, SD_H);
  ctx.drawImage(p, 0, 0, SD_W, SD_H);
}

async function renderSpot() {
  const today = todayParis();
  const perRound = Number(state.settings?.spot_coins_per_round ?? 15);
  const other = partner();
  const solved = (p) => String(Number(p?.spot_rounds ?? 0));
  const pool = puzzlePool();

  $app.innerHTML = `
    <section class="spot-page">
      <a class="back-link" href="#/jeu">← Games</a>
      <header class="page-head">
        <h1>7 Differences</h1>
        <p class="coins" id="coins">${Number(state.me.coins ?? 0)} ${COIN}</p>
      </header>
      <div class="scores">
        <div><small class="muted">Found</small><b id="sd-found">0 / ${SD_COUNT}</b></div>
        <div><small class="muted">Lives</small><b id="sd-lives">${'♥'.repeat(SD_LIVES)}</b></div>
        <div><small class="muted">Photos solved</small><b id="sd-solved">${solved(state.me)}</b></div>
        ${other ? `<div><small class="muted">${esc(other.display_name || 'Partner')}</small><b>${solved(other)}</b></div>` : ''}
      </div>
      <p class="muted small">Find the ${SD_COUNT} changes in the copy. A wrong tap costs a life. ${perRound} ${COIN} per photo solved.</p>
      <div class="sd-board" id="sd-board">
        ${pool.length ? `<div class="sd-pic" data-p="0"><canvas></canvas></div><div class="sd-pic" data-p="1"><canvas></canvas></div>` : '<p class="muted">Get some cards with photos first, then come back.</p>'}
        <div class="mg-end" id="sd-end"></div>
      </div>
      ${pool.length ? '<div class="reveal-actions"><button class="btn ghost" id="sd-hint" type="button">Hint (costs a life)</button><button class="btn ghost" id="sd-new" type="button">Other photo</button></div>' : ''}
    </section>`;
  if (!pool.length) return;

  const $ = (id) => document.getElementById(id);
  const board = $('sd-board');
  const pics = [...board.querySelectorAll('.sd-pic')];
  const k = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
  let round = null; // { diffs, found:Set, lives, done }
  let loading = false;

  const end = (html) => {
    const e = $('sd-end');
    e.innerHTML = html ? `<div class="panel b-panel">${html}</div>` : '';
    e.classList.toggle('on', !!html);
  };
  const mark = (cls, x, y, r) => pics.map((p) => {
    const i = document.createElement('i');
    i.className = `sd-ring ${cls}`;
    i.style.left = `${(x / SD_W) * 100}%`;
    i.style.top = `${(y / SD_H) * 100}%`;
    i.style.width = `${((2 * r + 12) / SD_W) * 100}%`;
    p.append(i);
    return i;
  });
  const showStats = () => {
    $('sd-found').textContent = `${round.found.size} / ${round.diffs.length}`;
    $('sd-lives').textContent = round.lives > 0 ? '♥'.repeat(round.lives) : '—';
  };

  const newRound = async () => {
    if (loading) return;
    loading = true;
    end('<p>Preparing the photo…</p>');
    pics.forEach((p) => p.querySelectorAll('.sd-ring').forEach((i) => i.remove()));
    let last = '';
    try { last = localStorage.getItem('spotLast') || ''; } catch { /* rien */ }
    const choices = pool.length > 1 ? pool.filter((c) => c.id !== last) : pool;
    const c = pick(choices);
    try { localStorage.setItem('spotLast', c.id); } catch { /* rien */ }
    let img;
    try {
      const url = await signedUrls([c.image_path]);
      img = await spotLoadImage(url(c.image_path));
    } catch {
      loading = false;
      if (board.isConnected) end('<p>This photo would not load.</p><button class="btn primary" id="sd-retry" type="button">Try another</button>');
      $('sd-retry')?.addEventListener('click', newRound);
      return;
    }
    if (!board.isConnected) return;
    // recadrage façon « cover » au format 4:3
    const iw = img.naturalWidth, ih = img.naturalHeight;
    const s = Math.max(SD_W / iw, SD_H / ih);
    const sw = SD_W / s, sh = SD_H / s;
    const base = document.createElement('canvas');
    base.width = SD_W * k; base.height = SD_H * k;
    base.getContext('2d').drawImage(img, (iw - sw) / 2, (ih - sh) / 2, sw, sh, 0, 0, SD_W * k, SD_H * k);
    const diffs = spotPlan(spotDetail(base));
    pics.forEach((p, n) => {
      const cv = p.querySelector('canvas');
      cv.width = SD_W * k; cv.height = SD_H * k;
      const ctx = cv.getContext('2d');
      ctx.setTransform(k, 0, 0, k, 0, 0);
      ctx.drawImage(base, 0, 0, SD_W, SD_H);
      if (n === 1) diffs.forEach((d) => spotEdit(ctx, base, d, k));
    });
    round = { diffs, found: new Set(), lives: SD_LIVES, done: false, card: c.id };
    showStats();
    end('');
    loading = false;
  };

  const win = () => {
    round.done = true;
    end(`<h2>All ${SD_COUNT} found!</h2><p id="sd-gain" class="muted small">…</p><button class="btn primary" id="sd-next" type="button">Next photo</button>`);
    $('sd-next').addEventListener('click', newRound);
    sb.rpc('spot_round').then(({ data }) => {
      if (!data) return;
      state.me.coins = data.coins;
      state.me.game_coins_on = today;
      state.me.game_coins_today = data.today;
      state.me.spot_rounds = data.rounds;
      if ($('coins')) $('coins').textContent = `${data.coins} ${COIN}`;
      if ($('sd-solved')) $('sd-solved').textContent = solved(state.me);
      if ($('sd-gain')) $('sd-gain').textContent = data.gain ? `+${data.gain} ${COIN}` : data.today >= data.cap ? 'Daily coin limit reached' : 'No coins this time';
    });
  };
  const lose = () => {
    round.done = true;
    round.diffs.forEach((d, i) => { if (!round.found.has(i)) mark('missed', d.x, d.y, d.r); });
    setTimeout(() => {
      if (!board.isConnected) return;
      end(`<h2>Out of lives</h2><p>${round.found.size} / ${SD_COUNT} found. The missing ones are circled.</p><button class="btn primary" id="sd-again" type="button">Next photo</button><button class="btn ghost" id="sd-look" type="button">Look first</button>`);
      $('sd-again').addEventListener('click', newRound);
      $('sd-look').addEventListener('click', () => end(''));
    }, 900);
  };
  const miss = () => {
    round.lives--;
    showStats();
    board.classList.remove('sd-shake'); void board.offsetWidth; board.classList.add('sd-shake');
    if (round.lives <= 0) lose();
  };

  pics.forEach((p) => p.addEventListener('pointerdown', (e) => {
    if (!round || loading) return;
    if (round.done) { if (!$('sd-end').classList.contains('on')) newRound(); return; }
    const rect = p.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * SD_W;
    const y = ((e.clientY - rect.top) / rect.height) * SD_H;
    let hit = -1, bestD = Infinity;
    round.diffs.forEach((d, i) => {
      const dist = Math.hypot(d.x - x, d.y - y);
      if (dist <= d.r + 10 && dist < bestD) { hit = i; bestD = dist; }
    });
    if (hit >= 0 && round.found.has(hit)) return; // déjà trouvée : pas de pénalité
    if (hit >= 0) {
      const d = round.diffs[hit];
      round.found.add(hit);
      mark('found', d.x, d.y, d.r);
      showStats();
      if (round.found.size === round.diffs.length) setTimeout(win, 500);
    } else {
      mark('wrong', x, y, 8).forEach((i) => setTimeout(() => i.remove(), 700));
      miss();
    }
  }));

  $('sd-hint').addEventListener('click', () => {
    if (!round || round.done || loading) return;
    const left = round.diffs.map((d, i) => i).filter((i) => !round.found.has(i));
    if (!left.length) return;
    const d = round.diffs[pick(left)];
    mark('hint', d.x, d.y, d.r).forEach((i) => setTimeout(() => i.remove(), 1600));
    miss();
  });
  $('sd-new').addEventListener('click', newRound);
  board.sdState = () => round && { diffs: round.diffs.map((d) => ({ ...d })), found: [...round.found], lives: round.lives, done: round.done }; // lecture seule, pour les tests

  await newRound();
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
          <label>2048 Cards: coins per card from 128<span class="pct"><input name="merge_coins_per_tile" type="number" inputmode="numeric" min="0" step="1" value="${Number(state.settings?.merge_coins_per_tile ?? 5)}">${COIN}</span></label>
          <label>7 Differences: coins per photo solved<span class="pct"><input name="spot_coins_per_round" type="number" inputmode="numeric" min="0" step="1" value="${Number(state.settings?.spot_coins_per_round ?? 15)}">${COIN}</span></label>
          <label>Marbles: coins per level<span class="pct"><input name="marbles_coins_per_level" type="number" inputmode="numeric" min="0" step="1" value="${Number(state.settings?.marbles_coins_per_level ?? 10)}">${COIN}</span></label>
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
    for (const k of ['pack_price', 'max_stored_packs', 'blocks_coins_per_line', 'puzzle_coins_per_piece', 'burger_coins_per_order', 'marbles_coins_per_level', 'merge_coins_per_tile', 'spot_coins_per_round', 'games_daily_cap', ...RARITIES.map((r) => `coins_${r.id}`)]) patch[k] = Math.round(Number(ratesForm[k].value));
    const { data, error } = await sb.from('game_settings').update(patch).eq('id', 1).select().maybeSingle();
    if (error) return toast(error.message, 'err');
    if (data) state.settings = data;
    toast('Settings saved');
  });
}

/* ---------- routeur ---------- */

const routes = { booster: renderBooster, collection: renderCollection, jeu: renderJeu, blocks: renderBlocks, memory: renderMemory, puzzle: renderPuzzle, burger: renderBurger, marbles: renderMarbles, merge: renderMerge, spot: renderSpot, ajouter: renderAjouter, profil: renderProfil };

async function route() {
  clearInterval(state.timer);
  if (!state.session) return renderLogin();
  const name = (location.hash.replace(/^#\/?/, '') || 'booster').split('?')[0];
  const page = routes[name] ? name : 'booster';
  $nav.hidden = false;
  const tab = ['blocks', 'memory', 'puzzle', 'burger', 'marbles', 'merge', 'spot'].includes(page) ? 'jeu' : page;
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
