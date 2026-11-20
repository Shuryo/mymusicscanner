import * as store from './store.js';
import * as sp from './spotify.js';
import * as data from './data.js';
import * as scanner from './scanner.js';

// iPhone ignoruje „user-scalable=no”, więc blokujemy przybliżanie dwoma palcami ręcznie.
for (const ev of ['gesturestart', 'gesturechange', 'gestureend']) {
  document.addEventListener(ev, (e) => e.preventDefault(), { passive: false });
}
document.addEventListener('touchmove', (e) => { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const RING = 339.3;

// ====================== Wspólne ======================
let toastTimer;
function toast(msg, err = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'show' + (err ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = ''), err ? 5000 : 2600);
}

function showError(e) {
  console.error(e);
  let msg = e?.message || String(e);
  if (e?.reason === 'PREMIUM_REQUIRED') msg = 'Sterowanie odtwarzaniem wymaga Spotify Premium.';
  else if (e?.status === 403 && /user may not be registered|not registered/i.test(msg)) {
    msg = 'To konto Spotify nie jest dodane do aplikacji (Dashboard → User Management).';
  }
  toast(msg, true);
}

const cleanTitle = (t) => String(t || '')
  .replace(/\s+-\s+.*(remaster|version|wersja|mono|stereo|edit|mix|live|from|single|radio|feat\.|anniversary|deluxe).*$/i, '')
  .replace(/\s*[([].*(remaster|version|edit|mix|feat\.|live|from).*[)\]]\s*$/i, '')
  .trim();

const firstLetter = (s) => {
  const m = String(s || '').match(/[\p{L}\p{N}]/u);
  return m ? m[0].toUpperCase() : '?';
};

const yearOf = (date) => parseInt(String(date || '').slice(0, 4), 10) || null;

function fmtTime(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function fmtDate(ts) {
  return new Date(ts).toLocaleString('pl-PL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

// ====================== Zakładki ======================
function goto(tab) {
  if (tab !== 'graj') stopScan();
  $$('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  $$('main .view').forEach((v) => (v.hidden = v.id !== 'v-' + tab));
  if (tab === 'karty') renderCards();
  if (tab === 'historia') renderHistory();
  if (tab === 'ustawienia') renderSettings();
  window.scrollTo(0, 0);
}
$$('.tabs button').forEach((b) => b.addEventListener('click', () => goto(b.dataset.tab)));
document.addEventListener('click', (e) => {
  const a = e.target.closest('[data-goto]');
  if (a) { e.preventDefault(); goto(a.dataset.goto); }
});

function renderChip() {
  const c = $('#chip-spotify');
  const ok = sp.isLoggedIn();
  c.textContent = ok ? 'Spotify ✓' : 'Połącz Spotify';
  c.classList.toggle('ok', ok);
}
$('#chip-spotify').addEventListener('click', () => goto('ustawienia'));

// ====================== Ustawienia gry ======================
const START_OPIS = {
  poczatek: 'Utwór gra od samego początku.',
  intro: 'Pomija wstęp: start ok. 30 s (zwykle blisko pierwszego refrenu). Spotify nie udostępnia dokładnego położenia refrenu.',
  losowo: 'Start w losowym miejscu środkowej części utworu.',
};

function renderSegs() {
  const s = store.settings();
  $$('#seg-limit button').forEach((b) => b.classList.toggle('on', +b.dataset.v === s.limit));
  $$('#seg-start button').forEach((b) => b.classList.toggle('on', b.dataset.v === s.start));
  $('#start-opis').textContent = START_OPIS[s.start];
}
$('#seg-limit').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  store.saveSettings({ limit: +b.dataset.v }); renderSegs();
});
$('#seg-start').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  store.saveSettings({ start: b.dataset.v }); renderSegs();
});

// ====================== Skanowanie ======================
function showPart(part) {
  $('#graj-start').hidden = part !== 'start';
  $('#graj-skan').hidden = part !== 'skan';
  $('#graj-runda').hidden = part !== 'runda';
}

async function startScan() {
  if (!sp.isLoggedIn()) { toast('Najpierw połącz się ze Spotify.', true); goto('ustawienia'); return; }
  goto('graj');
  showPart('skan');
  try {
    await scanner.start($('#video'), (text) => handleCode(text));
  } catch (e) {
    showPart(round ? 'runda' : 'start');
    toast('Brak dostępu do aparatu: ' + (e.message || e.name) + '. Możesz wpisać kod ręcznie.', true);
  }
}

function stopScan() {
  scanner.stop();
  if (!$('#graj-skan').hidden) showPart(round ? 'runda' : 'start');
}

$('#btn-skanuj').addEventListener('click', startScan);
$('#btn-nastepna').addEventListener('click', async () => { await endRound(); startScan(); });
$('#btn-anuluj-skan').addEventListener('click', stopScan);
$('#in-foto').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  stopScan();
  try {
    const text = await scanner.decodeFile(file);
    if (text) handleCode(text);
    else toast('Nie znalazłem kodu QR na zdjęciu. Zrób zdjęcie z bliska, ostro i bez odblasków.', true);
  } catch (err) { showError(err); }
});

$('#form-kod').addEventListener('submit', (e) => {
  e.preventDefault();
  const v = $('#in-kod').value.trim();
  if (v) handleCode(v);
});

async function handleCode(text) {
  const card = await data.resolve(text);
  if (!card) {
    showPart(round ? 'runda' : 'start');
    toast('To nie wygląda na kod karty: ' + String(text).slice(0, 60), true);
    return;
  }
  if (card.brak) {
    showPart(round ? 'runda' : 'start');
    toast(`Nie znam karty ${card.talia} / ${card.numer}. Dodaj ją w zakładce Karty.`, true);
    return;
  }
  startRound(card);
}

// ====================== Runda ======================
let round = null;
let tick = null;

function getHistory() { return store.get('historia', []); }
function saveHistory(h) { store.set('historia', h.slice(0, 500)); }

function answerOf(card, info) {
  const fromSpotify = !card.rok;
  return {
    tytul: card.tytul || cleanTitle(info?.nazwa),
    wykonawca: card.wykonawca || (info?.wykonawcy || []).join(', '),
    rok: card.rok || yearOf(info?.data),
    rokZeSpotify: fromSpotify,
    okladka: info?.okladka || '',
  };
}

async function startRound(card) {
  await endRound(true);
  round = {
    card, info: null, used: new Set(), revealed: false,
    remaining: 0, playing: false, expired: false, segEnd: 0, startPos: 0, id: Date.now(),
  };
  goto('graj');
  showPart('runda');
  resetRoundUi();
  $('#r-talia').textContent = card.numer ? `${card.taliaNazwa} · karta ${card.numer}` : card.taliaNazwa;

  const prev = getHistory().filter((h) => h.klucz === card.klucz);
  $('#r-powtorka').hidden = !prev.length;
  if (prev.length) $('#r-powtorka').textContent = `grana ${prev.length}× · ostatnio ${fmtDate(prev[0].ts)}`;

  setPlayIcon('wait');
  setStatus('Ładuję utwór…');
  const myId = round.id;
  try {
    if (!card.spotify) {
      setStatus('Szukam utworu w Spotify…');
      card.spotify = await findTrackId(card);
    }
    const info = await sp.track(card.spotify);
    if (!round || round.id !== myId) return;
    round.info = info;
    round.answer = answerOf(card, info);
    addHistory();
    await playSegment(true);
  } catch (e) {
    if (!round || round.id !== myId) return;
    setPlayIcon('play');
    setStatus('Nie udało się odtworzyć – dotknij, aby spróbować ponownie.');
    showError(e);
  }
}

// Karta bez ID Spotify (np. z importu): znajdź utwór po tytule, wykonawcy i roku, zapamiętaj i zapisz w bazie.
const mainArtist = (a) => String(a || '').split(/,|\s+(?:feat\.?|ft\.?|&|x|i)\s+/i)[0].trim();

// Szuka utworu w Spotify po tytule, wykonawcy i roku. Zwraca najlepszy wynik albo null.
async function searchTrack({ tytul, wykonawca, rok }) {
  const title = String(tytul || '').trim();
  const artist = mainArtist(wykonawca);
  if (!title) return null;
  const year = parseInt(rok, 10) || 0;
  const nt = norm(title), na = norm(artist);
  const pick = (hits) => hits.map((h, i) => {
    const ht = norm(cleanTitle(h.nazwa));
    const st = ht === nt ? 4 : (ht.startsWith(nt) || nt.startsWith(ht) || ht.includes(nt)) ? 2 : 0;
    const sa = h.wykonawcy.some((w) => norm(w) === na) ? 4
      : h.wykonawcy.some((w) => norm(w).includes(na) || na.includes(norm(w))) ? 2 : 0;
    if (!st || !sa) return { h, s: -1 };
    let s = st + sa;
    if (h.typAlbumu === 'compilation') s -= 1;
    const y = yearOf(h.data);
    if (year && y && Math.abs(y - year) <= 1) s += 2;
    return { h, s: s - i * 0.01 };
  }).filter((x) => x.s >= 0).sort((a, b) => b.s - a.s)[0]?.h || null;
  const q = (s) => s.replace(/["']/g, ' ');
  // 1) zapytanie z filtrami, 2) zwykłe zapytanie, 3) sam tytuł
  return pick(await sp.search(`track:${q(title)} artist:${q(artist)}`))
    || pick(await sp.search(`${title} ${artist}`))
    || pick(await sp.search(title));
}

function rememberFound(klucz, id) {
  const cache = store.get('cacheZnalezione', {});
  cache[klucz] = id;
  const keys = Object.keys(cache);
  if (keys.length > 1500) keys.slice(0, keys.length - 1500).forEach((k) => delete cache[k]);
  store.set('cacheZnalezione', cache);
}

async function findTrackId(card) {
  const cache = store.get('cacheZnalezione', {});
  if (cache[card.klucz]) return cache[card.klucz];
  if (!card.tytul) throw new Error('Karta nie ma tytułu ani linku Spotify.');
  const hit = await searchTrack(card);
  if (!hit) throw new Error(`Nie znalazłem w Spotify: ${card.wykonawca} – ${card.tytul}. Wklej link do utworu w zakładce Karty.`);
  rememberFound(card.klucz, hit.id);
  if (card.zrodlo === 'wlasna') data.setTrackId(card.talia, card.numer, hit.id, hit.okladka).catch((e) => toast(e.message, true));
  return hit.id;
}

function addHistory() {
  const h = getHistory();
  const a = round.answer;
  h.unshift({
    id: round.id, ts: Date.now(), klucz: round.card.klucz,
    talia: round.card.taliaNazwa, numer: round.card.numer, spotify: round.card.spotify,
    tytul: a.tytul, wykonawca: a.wykonawca, rok: a.rok, okladka: round.info.okladkaMala, podpowiedzi: 0,
  });
  saveHistory(h);
}

function updateHistoryHints() {
  if (!round) return;
  const h = getHistory();
  const e = h.find((x) => x.id === round.id);
  if (e) { e.podpowiedzi = round.used.size; saveHistory(h); }
}

function computeStart(durMs, limitMs) {
  const mode = store.settings().start;
  let pos = 0;
  if (mode === 'intro') pos = Math.min(30000, durMs * 0.3);
  else if (mode === 'losowo') pos = durMs * (0.15 + Math.random() * 0.45);
  const room = limitMs || 20000;
  return Math.max(0, Math.min(pos, durMs - room - 3000));
}

async function playSegment(fresh) {
  const limit = store.settings().limit * 1000;
  if (fresh) {
    round.limit = limit;
    round.startPos = computeStart(round.info.czas, limit);
    round.remaining = limit;
    round.expired = false;
    setPlayIcon('wait');
    await sp.play(round.card.spotify, round.startPos);
  } else {
    setPlayIcon('wait');
    await sp.resume();
  }
  round.playing = true;
  round.playedOnce = true;
  setPlayIcon('pause');
  setStatus('');
  runTimer();
}

function runTimer() {
  clearInterval(tick);
  if (!round.limit) { renderTime(); return; }
  round.segEnd = Date.now() + round.remaining;
  const myId = round.id;
  tick = setInterval(() => {
    if (!round || round.id !== myId) { clearInterval(tick); return; }
    round.remaining = round.segEnd - Date.now();
    renderTime();
    if (round.remaining <= 0) {
      clearInterval(tick);
      round.playing = false;
      round.remaining = 0;
      sp.pause().catch(showError);
      if (round.bonus) {
        round.bonus = false;
        round.remaining = 0;
      }
      round.expired = true;
      setPlayIcon('done');
      setStatus('Czas minął! Zgadujcie – albo weźcie podpowiedź „+5 s”.');
      renderTime();
    }
  }, 100);
}

async function pauseSegment() {
  clearInterval(tick);
  if (round.limit) round.remaining = Math.max(0, round.segEnd - Date.now());
  round.playing = false;
  setPlayIcon('play');
  renderTime();
  await sp.pause();
}

$('#btn-play').addEventListener('click', async () => {
  if (!round) return;
  try {
    if (!round.info) { startRound(round.card); return; }
    if (round.playing) await pauseSegment();
    else if (round.expired) toast('Czas minął – użyj podpowiedzi „+5 s”.');
    else await playSegment(!round.playedOnce);
  } catch (e) { setPlayIcon('play'); showError(e); }
});

function renderTime() {
  if (!round) return;
  const ring = $('#ring');
  if (!round.limit) {
    $('#r-czas').textContent = round.playing ? 'gra…' : 'pauza';
    ring.style.strokeDashoffset = 0;
    return;
  }
  $('#r-czas').textContent = fmtTime(round.remaining);
  const total = round.bonus ? 5000 : round.limit;
  ring.style.strokeDashoffset = RING * (1 - Math.max(0, round.remaining) / total);
}

function setPlayIcon(state) {
  $('#play-ico').className = 'play-ico ' + (state === 'play' ? '' : state);
}
function setStatus(t) { $('#r-status').textContent = t; }

function resetRoundUi() {
  clearInterval(tick);
  $('[data-hint="plus5"] small').textContent = 'jeszcze raz posłuchaj';
  $$('.hint').forEach((b) => {
    b.classList.remove('used');
    const o = $('.hint-out', b); if (o) o.innerHTML = '';
  });
  $('[data-hint="plus5"]').hidden = !store.settings().limit;
  $('#odpowiedz').hidden = true;
  $('#odpowiedz').innerHTML = '';
  $('#btn-odpowiedz').hidden = false;
  $('#r-licznik').textContent = '0 użytych';
  $('#ring').style.strokeDashoffset = 0;
  $('#r-czas').textContent = '–';
  setStatus('');
}

async function endRound(silent) {
  clearInterval(tick);
  if (round?.playing) { try { await sp.pause(); } catch { /* trudno */ } }
  if (round) updateHistoryHints();
  if (!silent) round = null;
}

// ---------- Podpowiedzi ----------
function markUsed(btn, name) {
  if (!round.used.has(name)) {
    round.used.add(name);
    btn.classList.add('used');
    const n = round.used.size;
    $('#r-licznik').textContent = `${n} ${n === 1 ? 'użyta' : n < 5 ? 'użyte' : 'użytych'}`;
    updateHistoryHints();
  }
}

$('.hints').addEventListener('click', async (e) => {
  const btn = e.target.closest('.hint');
  if (!btn || !round?.answer) return;
  const name = btn.dataset.hint;
  const out = $('.hint-out', btn);
  const a = round.answer;
  try {
    if (name === 'plus5') {
      if (round.playing) { toast('Utwór jeszcze gra.'); return; }
      const n = (round.plus5 = (round.plus5 || 0) + 1);
      markUsed(btn, 'plus5_' + n); // każde +5 s liczy się jako osobna podpowiedź
      btn.querySelector('small').textContent = `użyto ${n}×`;
      round.bonus = true;
      round.expired = false;
      round.remaining = 5000;
      await playSegment(false);
      return;
    }
    if (out.innerHTML) return; // już odkryta
    markUsed(btn, name);
    if (name === 'litWyk') out.textContent = firstLetter(a.wykonawca) + '…';
    if (name === 'litTyt') out.textContent = firstLetter(a.tytul) + '…';
    if (name === 'zakres') {
      if (!a.rok) { out.textContent = '?'; return; }
      const thisYear = new Date().getFullYear();
      // okno 20 lat, rok utworu w losowym miejscu (żeby środek nie zdradzał odpowiedzi)
      let from = a.rok - Math.floor(Math.random() * 21);
      let to = from + 20;
      if (to > thisYear) { to = thisYear; from = to - 20; }
      out.textContent = `${from} – ${to}`;
    }
    if (name === 'okladka') {
      if (!a.okladka) { out.textContent = 'brak okładki'; return; }
      out.textContent = '…';
      const url = await songCover(round.info);
      out.innerHTML = `<img alt="Okładka" src="${esc(url)}">`;
    }
    if (name === 'foto') {
      out.textContent = '…';
      const url = await sp.artistImage(round.info.wykonawcaId);
      out.innerHTML = url ? `<img alt="Zdjęcie wykonawcy" src="${esc(url)}">` : 'brak zdjęcia';
    }
  } catch (err) { showError(err); }
});

// Okładka piosenki: Spotify nie ma okładek pojedynczych utworów, ale single to osobne wydania
// z własną okładką. Szukamy singla z tym samym tytułem i wykonawcą (najwcześniejszego);
// gdy go nie ma – zostaje okładka albumu, z którego gra utwór.
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');

async function songCover(info) {
  if (info.typAlbumu === 'single' || !info.wykonawcy?.length) return info.okladka;
  const cache = store.get('cacheSingle', {});
  if (info.id in cache) return cache[info.id] || info.okladka;
  const title = cleanTitle(info.nazwa);
  const artist = info.wykonawcy[0];
  let url = '';
  try {
    const q = `track:${title.replace(/["']/g, ' ')} artist:${artist.replace(/["']/g, ' ')}`;
    const hits = (await sp.search(q)).filter((t) => t.typAlbumu === 'single'
      && norm(cleanTitle(t.nazwa)) === norm(title)
      && t.wykonawcy.some((w) => norm(w) === norm(artist)));
    hits.sort((x, y) => String(x.data).localeCompare(String(y.data)));
    url = hits[0]?.okladka || '';
  } catch { /* zostaje okładka albumu */ }
  cache[info.id] = url;
  const keys = Object.keys(cache);
  if (keys.length > 800) delete cache[keys[0]];
  store.set('cacheSingle', cache);
  return url || info.okladka;
}

// ---------- Odpowiedź ----------
$('#btn-odpowiedz').addEventListener('click', () => {
  if (!round?.answer) return;
  const a = round.answer, c = round.card;
  round.revealed = true;
  const el = $('#odpowiedz');
  el.innerHTML = `
    ${a.okladka ? `<img src="${esc(a.okladka)}" alt="">` : '<div></div>'}
    <div>
      <div class="year">${esc(a.rok || '?')}</div>
      <div class="who">${esc(a.wykonawca)}</div>
      <div class="what">${esc(a.tytul)}</div>
    </div>
    <div class="note">
      <span>${a.rokZeSpotify ? 'Rok wg Spotify – może to być rok reedycji.' : c.poprawiona ? 'Dane poprawione w bazie.' : ''}</span>
      ${data.sheetEnabled() && c.numer ? '<button class="btn btn-ghost" type="button" id="btn-popraw">Popraw dane karty</button>' : ''}
    </div>`;
  el.hidden = false;
  $('#btn-odpowiedz').hidden = true;
  $('#btn-popraw')?.addEventListener('click', () => openCardForm({
    talia: c.talia, numer: c.numer, spotify: c.spotify, tytul: a.tytul, wykonawca: a.wykonawca, rok: a.rok, okladka: a.okladka,
  }, { lockKey: true, isNew: !c.poprawiona }));
});

// ====================== Historia ======================
function renderHistory() {
  const h = getHistory();
  const ul = $('#lista-historia');
  if (!h.length) { ul.innerHTML = '<li class="empty">Jeszcze nic nie zagrano.</li>'; return; }
  ul.innerHTML = h.map((x) => `
    <li data-klucz="${esc(x.klucz)}" title="Zagraj ponownie">
      ${x.okladka ? `<img class="thumb" src="${esc(x.okladka)}" alt="" loading="lazy">` : '<div class="thumb"></div>'}
      <div style="min-width:0">
        <div class="t1">${esc(x.wykonawca)} – ${esc(x.tytul)}</div>
        <div class="t2">${esc(fmtDate(x.ts))} · ${esc(x.talia)}${x.numer ? ' #' + esc(x.numer) : ''} · podpowiedzi: ${x.podpowiedzi || 0}</div>
      </div>
      <div class="yr">${esc(x.rok || '')}</div>
    </li>`).join('');
}
$('#lista-historia').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-klucz]');
  if (!li) return;
  const k = li.dataset.klucz;
  const [talia, numer] = k.split('/');
  handleCode(talia === 'spotify' ? 'spotify:track:' + numer : `${talia}/${numer}`);
});
$('#btn-wyczysc').addEventListener('click', () => {
  if (confirm('Usunąć całą historię zagranych utworów na tym urządzeniu?')) { store.set('historia', []); renderHistory(); }
});

// ====================== Karty (baza) ======================
let cardsLoadedOnce = false;

async function renderCards(reload = false) {
  const enabled = data.sheetEnabled();
  $('#karty-brak-bazy').hidden = enabled;
  $('#karty-panel').hidden = !enabled;
  await data.loadHitster();
  $('#lista-talii').innerHTML = data.hitsterDecks()
    .map((d) => `<li>${esc(d.nazwa)} <span class="badge">${esc(d.sku)} · ${d.ile}</span></li>`).join('');
  if (!enabled) return;
  if (reload || !cardsLoadedOnce) {
    try { await data.loadSheet(); cardsLoadedOnce = true; } catch (e) { showError(e); }
  }
  const sel = $('#sel-talia');
  const cur = sel.value;
  const decks = data.customDecks();
  const fixes = data.customCards().filter((c) => data.isHitsterDeck(c.talia)).length;
  sel.innerHTML = '<option value="">Wszystkie własne karty</option>'
    + decks.map((d) => `<option value="${esc(d.talia)}">${esc(d.talia)} (${d.ile})</option>`).join('')
    + (fixes ? `<option value="__hitster">Poprawki kart Hitstera (${fixes})</option>` : '');
  sel.value = [...sel.options].some((o) => o.value === cur) ? cur : '';
  $('#dl-talie').innerHTML = decks.map((d) => `<option value="${esc(d.talia)}">`).join('');
  renderCardList();
}

function renderCardList() {
  const deck = $('#sel-talia').value;
  const q = $('#in-szukaj').value.trim().toLowerCase();
  let list = data.customCards();
  if (deck === '__hitster') list = list.filter((c) => data.isHitsterDeck(c.talia));
  else if (deck) list = list.filter((c) => c.talia === deck);
  else list = list.filter((c) => !data.isHitsterDeck(c.talia));
  if (q) list = list.filter((c) => `${c.tytul} ${c.wykonawca} ${c.rok} ${c.talia}`.toLowerCase().includes(q));
  list = [...list].sort((a, b) => a.talia.localeCompare(b.talia, 'pl') || a.numer - b.numer);
  $('#btn-drukuj').disabled = !deck || deck === '__hitster';
  const ul = $('#lista-kart');
  if (!list.length) { ul.innerHTML = '<li class="empty">Brak kart. Dodaj pierwszą przyciskiem „+ Dodaj kartę”.</li>'; return; }
  ul.innerHTML = list.map((c) => `
    <li data-talia="${esc(c.talia)}" data-numer="${esc(c.numer)}">
      ${c.okladka ? `<img class="thumb" src="${esc(c.okladka)}" alt="" loading="lazy">` : '<div class="thumb"></div>'}
      <div style="min-width:0">
        <div class="t1">${esc(c.wykonawca)} – ${esc(c.tytul)}</div>
        <div class="t2">${esc(c.talia)} #${esc(c.numer)}${c.dodal ? ' · dodał(a): ' + esc(c.dodal) : ''}${c.spotify ? '' : ' · <b>bez Spotify</b>'}</div>
      </div>
      <div class="yr">${esc(c.rok)}</div>
      <button type="button" class="play-mini${previewKey === data.key(c.talia, c.numer) ? ' on' : ''}" data-play aria-label="Odsłuchaj">${previewKey === data.key(c.talia, c.numer) ? '❚❚' : '▶'}</button>
    </li>`).join('');
}

$('#sel-talia').addEventListener('change', renderCardList);
$('#in-szukaj').addEventListener('input', renderCardList);
$('#btn-odswiez').addEventListener('click', () => renderCards(true).then(() => toast('Odświeżono')));
$('#btn-dodaj').addEventListener('click', () => {
  const d = $('#sel-talia').value;
  openCardForm({ talia: d && d !== '__hitster' ? d : '' }, { isNew: true });
});
$('#btn-drukuj').addEventListener('click', () => {
  const d = $('#sel-talia').value;
  if (d) window.open('drukuj.html?talia=' + encodeURIComponent(d), '_blank');
});
// Wyszukuje w Spotify wszystkie karty bez ID (w wybranej talii albo we wszystkich) i zapisuje ID w bazie.
let finding = false;
$('#btn-znajdz').addEventListener('click', async () => {
  if (finding) { finding = false; return; } // drugi klik = zatrzymaj
  if (!sp.isLoggedIn()) { toast('Najpierw połącz się ze Spotify.', true); goto('ustawienia'); return; }
  const deck = $('#sel-talia').value;
  const todo = data.customCards().filter((c) => !c.spotify && c.tytul
    && (deck && deck !== '__hitster' ? c.talia === deck : !data.isHitsterDeck(c.talia)));
  const info = $('#znajdz-info');
  info.hidden = false;
  if (!todo.length) { info.textContent = 'Wszystkie karty mają już utwór w Spotify.'; return; }
  finding = true;
  const btn = $('#btn-znajdz');
  btn.textContent = 'Zatrzymaj wyszukiwanie';
  const found = [], missing = [];
  let saveErr = null;
  const flush = async () => {
    const part = found.splice(0);
    if (part.length) await data.setTrackIds(part).catch((e) => { saveErr = e; });
  };
  try {
    for (let i = 0; i < todo.length && finding; i++) {
      const c = todo[i];
      info.textContent = `Szukam ${i + 1} z ${todo.length}: ${c.wykonawca} – ${c.tytul}…`;
      try {
        const hit = await searchTrack(c);
        if (hit) {
          found.push({ talia: c.talia, numer: c.numer, spotify: hit.id, okladka: hit.okladka });
          rememberFound(data.key(c.talia, c.numer), hit.id);
        } else missing.push(c);
      } catch (e) {
        if (e.status === 401 || e.status === 403) throw e;
        missing.push(c);
      }
      if (found.length >= 25) await flush();
    }
    await flush();
  } catch (e) {
    await flush();
    showError(e);
  } finally {
    finding = false;
    btn.textContent = 'Znajdź utwory w Spotify';
    const ok = todo.length - missing.length;
    info.innerHTML = `Znaleziono ${ok} z ${todo.length}.`
      + (saveErr ? ` <b>${esc(saveErr.message)}</b>` : '')
      + (missing.length ? `<br>Nie znaleziono (kliknij kartę i wklej link ze Spotify):<br>${missing.map((c) => `${esc(c.talia)} #${esc(c.numer)}: ${esc(c.wykonawca)} – ${esc(c.tytul)}`).join('<br>')}` : '');
    renderCardList();
  }
});

// ---------- Import playlisty Spotify ----------
const dlgImport = $('#dlg-import');
let importItems = [];

// Odmiana: 1 karta, 2–4 karty, 5 kart (12–14 kart, 22 karty…)
const plural = (n, one, few, many) => {
  if (n === 1) return `1 ${one}`;
  const d = n % 10, dd = n % 100;
  return `${n} ${d >= 2 && d <= 4 && !(dd >= 12 && dd <= 14) ? few : many}`;
};

const playlistId = (s) => (String(s).match(/playlist[/:]([A-Za-z0-9]{22})/) || String(s).trim().match(/^([A-Za-z0-9]{22})$/) || [])[1];

// Najpierw Web API (pełna playlista, z datami); gdy Spotify odmówi – strona embed przez Apps Script (max 100).
async function loadPlaylist(link, onInfo) {
  const id = playlistId(link);
  if (!id) throw new Error('Wklej link do playlisty (Spotify → playlista → Udostępnij → Kopiuj link).');
  try {
    const p = await sp.playlist(id);
    if (p.utwory.length) return { ...p, zrodlo: 'api' };
  } catch (e) {
    if (e.reason === 'NO_LOGIN') throw e;
  }
  onInfo('Spotify nie udostępnił playlisty przez API – pobieram ją inaczej…');
  const j = await data.playlistFromSheet(id);
  const out = new Array(j.utwory.length);
  let next = 0;
  const worker = async () => {
    while (next < j.utwory.length) {
      const i = next++, u = j.utwory[i];
      onInfo(`Sprawdzam lata wydania: ${i + 1} z ${j.utwory.length}…`);
      try { out[i] = await sp.track(u.id); } catch { out[i] = { id: u.id, nazwa: u.tytul, wykonawcy: u.wykonawcy, data: '', okladka: '' }; }
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  return { nazwa: j.nazwa, utwory: out, zrodlo: 'embed', moglaBycDluzsza: j.utwory.length >= 100 };
}

function buildImportItems(utwory) {
  const hIds = data.hitsterIdIndex();
  const own = data.customCards().filter((c) => !data.isHitsterDeck(c.talia));
  const seen = new Set();
  return utwory.map((t) => {
    const tytul = cleanTitle(t.nazwa);
    const wykonawca = t.wykonawcy.slice(0, 2).join(', ');
    const tk = norm(tytul) + '|' + norm(mainArtist(wykonawca));
    const ownHit = own.find((c) => c.spotify === t.id || norm(c.tytul) + '|' + norm(mainArtist(c.wykonawca)) === tk);
    let dup = '';
    if (seen.has(t.id) || seen.has(tk)) dup = 'powtórka na playliście';
    else if (ownHit) dup = `już w bazie: ${ownHit.talia} #${ownHit.numer}`;
    else if (hIds.has(t.id)) dup = `w Hitsterze: ${hIds.get(t.id)}`;
    seen.add(t.id); seen.add(tk);
    return { spotify: t.id, tytul, wykonawca, rok: yearOf(t.data) || '', okladka: t.okladka || '', okladkaMala: t.okladkaMala || t.okladka || '', dup, on: !dup };
  });
}

function renderImport() {
  const n = importItems.filter((x) => x.on).length;
  $('#i-lista-box').hidden = !importItems.length;
  $('#i-licznik').textContent = `${n} z ${importItems.length}`;
  $('#i-wszystkie').checked = importItems.length > 0 && n === importItems.length;
  $('#i-dodaj').disabled = !n;
  $('#i-dodaj').textContent = n ? `Dodaj ${n}` : 'Dodaj';
  $('#i-lista').innerHTML = importItems.map((x, i) => `
    <li data-i="${i}" class="${x.dup ? 'dup' : ''}${x.on ? '' : ' off'}">
      <input type="checkbox" ${x.on ? 'checked' : ''} aria-label="Dodaj">
      ${x.okladkaMala ? `<img src="${esc(x.okladkaMala)}" alt="" loading="lazy">` : '<div class="thumb" style="width:40px;height:40px"></div>'}
      <div style="min-width:0">
        <div class="t1">${esc(x.wykonawca)} – ${esc(x.tytul)}</div>
        <div class="t2">${esc(x.rok || 'brak roku')}${x.dup ? ' · ' + esc(x.dup) : ''}</div>
      </div>
    </li>`).join('');
}

$('#btn-import').addEventListener('click', () => {
  if (!data.sheetEnabled()) { toast('Najpierw skonfiguruj bazę kart (Ustawienia → Zaawansowane).', true); return; }
  if (!sp.isLoggedIn()) { toast('Najpierw połącz się ze Spotify.', true); goto('ustawienia'); return; }
  const d = $('#sel-talia').value;
  if (d && d !== '__hitster' && !$('#i-talia').value) $('#i-talia').value = d;
  $('#i-blad').hidden = true;
  renderImport();
  dlgImport.showModal();
});
$('#i-zamknij').addEventListener('click', () => dlgImport.close());

$('#i-wczytaj').addEventListener('click', async () => {
  const btn = $('#i-wczytaj');
  const info = $('#i-info');
  $('#i-blad').hidden = true;
  btn.disabled = true;
  info.textContent = 'Wczytuję playlistę…';
  try {
    await data.loadHitster();
    const p = await loadPlaylist($('#i-link').value, (t) => { info.textContent = t; });
    importItems = buildImportItems(p.utwory);
    const dups = importItems.filter((x) => x.dup).length;
    info.textContent = `„${p.nazwa}”: ${plural(importItems.length, 'utwór', 'utwory', 'utworów')}`
      + (dups ? `, odznaczone: ${dups} (już są w bazie lub w Hitsterze)` : '')
      + '. Lata to daty wydania w Spotify – przy reedycjach i składankach mogą być późniejsze, sprawdź przed drukiem.'
      + (p.moglaBycDluzsza ? ' Uwaga: tą drogą Spotify podaje najwyżej 100 utworów.' : '');
    if (!$('#i-talia').value && p.nazwa) {
      $('#i-talia').value = p.nazwa.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ł/g, 'l')
        .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
    }
  } catch (e) {
    importItems = [];
    info.textContent = '';
    $('#i-blad').textContent = e.message || String(e);
    $('#i-blad').hidden = false;
  } finally {
    btn.disabled = false;
    renderImport();
  }
});

$('#i-lista').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-i]');
  if (!li) return;
  const x = importItems[+li.dataset.i];
  x.on = e.target.matches('input[type="checkbox"]') ? e.target.checked : !x.on;
  renderImport();
});
$('#i-wszystkie').addEventListener('change', (e) => { importItems.forEach((x) => { x.on = e.target.checked; }); renderImport(); });

$('#i-dodaj').addEventListener('click', async () => {
  const talia = $('#i-talia').value.trim();
  const blad = (t) => { $('#i-blad').textContent = t; $('#i-blad').hidden = false; };
  if (!talia) { blad('Wpisz nazwę talii.'); $('#i-talia').focus(); return; }
  if (data.isHitsterDeck(talia)) { blad('Nie można dodawać do talii Hitstera – wpisz własną nazwę.'); return; }
  if (!store.settings().haslo) { blad('Wpisz hasło do bazy w Ustawieniach.'); return; }
  const karty = importItems.filter((x) => x.on).map((x) => ({
    spotify: x.spotify, tytul: x.tytul, wykonawca: x.wykonawca, rok: x.rok, okladka: x.okladka, uwagi: 'z playlisty – sprawdź rok',
  }));
  const btn = $('#i-dodaj');
  btn.disabled = true;
  btn.textContent = 'Zapisuję…';
  try {
    const r = await data.importCards(talia, karty);
    dlgImport.close();
    importItems = [];
    $('#i-link').value = '';
    toast(`Dodano ${plural(r.dodane, 'kartę', 'karty', 'kart')} do talii ${r.talia} (od #${r.od})`
      + (r.pominiete ? `, pominięte: ${r.pominiete} (już były w tej talii)` : '') + '.');
    await renderCards();
    $('#sel-talia').value = r.talia;
    renderCardList();
  } catch (e) {
    blad(e.message || String(e));
    renderImport();
  }
});

// Odsłuch karty z listy: gra utwór od początku w Spotify, drugi klik zatrzymuje.
let previewKey = null;
async function togglePreview(c, btn) {
  const k = data.key(c.talia, c.numer);
  if (previewKey === k) {
    previewKey = null;
    renderCardList();
    sp.pause().catch(() => {});
    return;
  }
  if (!sp.isLoggedIn()) { toast('Najpierw połącz się ze Spotify.', true); goto('ustawienia'); return; }
  btn.disabled = true;
  btn.textContent = '…';
  try {
    if (round) await endRound(true);
    const id = c.spotify || await findTrackId({
      ...c, klucz: k, zrodlo: data.isHitsterDeck(c.talia) ? 'hitster' : 'wlasna', rok: parseInt(c.rok, 10) || 0,
    });
    await sp.play(id, 0);
    previewKey = k;
  } catch (e) {
    previewKey = null;
    showError(e);
  }
  renderCardList();
}

$('#lista-kart').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-talia]');
  if (!li) return;
  const playBtn = e.target.closest('[data-play]');
  if (playBtn) {
    const pc = data.customCards().find((x) => data.key(x.talia, x.numer) === data.key(li.dataset.talia, li.dataset.numer));
    if (pc) togglePreview(pc, playBtn);
    return;
  }
  const c = data.customCards().find((x) => data.key(x.talia, x.numer) === data.key(li.dataset.talia, li.dataset.numer));
  if (c) openCardForm(c, { isNew: false, lockKey: data.isHitsterDeck(c.talia) });
});

// ---------- Formularz karty ----------
const dlg = $('#dlg-karta');
let formCtx = null;
let searchTimer = null;

function openCardForm(c, { isNew = true, lockKey = false } = {}) {
  if (!data.sheetEnabled()) { toast('Najpierw skonfiguruj bazę kart (Ustawienia → Zaawansowane).', true); return; }
  formCtx = { isNew, original: isNew ? null : { talia: c.talia, numer: c.numer } };
  $('#dlg-tytul').textContent = lockKey ? 'Popraw kartę Hitstera' : isNew ? 'Nowa karta' : 'Edytuj kartę';
  $('#f-talia').value = c.talia || '';
  $('#f-numer').value = c.numer || '';
  $('#f-talia').readOnly = $('#f-numer').readOnly = lockKey;
  $('#f-spotify').value = c.spotify ? 'https://open.spotify.com/track/' + c.spotify : '';
  $('#f-tytul').value = c.tytul || '';
  $('#f-wykonawca').value = c.wykonawca || '';
  $('#f-rok').value = c.rok || '';
  $('#f-uwagi').value = c.uwagi || '';
  $('#f-rok-uwaga').textContent = '';
  setFormCover(c.okladka);
  $('#f-szukaj').value = '';
  $('#f-wyniki').innerHTML = '';
  $('#f-szukaj-box').hidden = !sp.isLoggedIn() || lockKey;
  $('#f-szukaj-off').hidden = sp.isLoggedIn() || lockKey;
  $('#f-usun').hidden = isNew;
  $('#f-blad').hidden = true;
  if (!store.settings().haslo) {
    $('#f-blad').textContent = 'Uwaga: nie wpisano hasła do edycji bazy (Ustawienia).';
    $('#f-blad').hidden = false;
  }
  dlg.showModal();
  if (!lockKey) ($('#f-szukaj-box').hidden ? $('#f-spotify') : $('#f-szukaj')).focus();
}

function setFormCover(url) {
  const img = $('#f-okladka');
  img.hidden = !url;
  img.src = url || '';
  img.dataset.url = url || '';
}

function fillFromTrack(t) {
  $('#f-spotify').value = 'https://open.spotify.com/track/' + t.id;
  $('#f-tytul').value = cleanTitle(t.nazwa);
  $('#f-wykonawca').value = t.wykonawcy.join(', ');
  $('#f-rok').value = yearOf(t.data) || '';
  $('#f-rok-uwaga').textContent = 'Rok wg Spotify – sprawdź, czy to rok oryginalnego wydania, a nie reedycji.';
  setFormCover(t.okladka);
}

$('#f-szukaj').addEventListener('input', () => {
  clearTimeout(searchTimer);
  const q = $('#f-szukaj').value.trim();
  if (q.length < 2) { $('#f-wyniki').innerHTML = ''; return; }
  searchTimer = setTimeout(async () => {
    try {
      const res = await sp.search(q);
      formCtx.results = res;
      $('#f-wyniki').innerHTML = res.map((t, i) => `
        <li tabindex="0" data-i="${i}">
          <img src="${esc(t.okladkaMala)}" alt="">
          <div style="min-width:0"><div class="t1">${esc(t.nazwa)}</div><div class="t2">${esc(t.wykonawcy.join(', '))}</div></div>
          <b>${esc(yearOf(t.data) || '')}</b>
        </li>`).join('') || '<li>Brak wyników</li>';
    } catch (e) { showError(e); }
  }, 350);
});
$('#f-wyniki').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-i]');
  if (!li) return;
  fillFromTrack(formCtx.results[+li.dataset.i]);
  $('#f-wyniki').innerHTML = '';
  $('#f-szukaj').value = '';
});
$('#f-wyniki').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.click(); });

$('#f-spotify').addEventListener('change', async () => {
  const p = data.parseCode($('#f-spotify').value);
  if (!p?.spotify) return;
  try {
    if (sp.isLoggedIn()) fillFromTrack(await sp.track(p.spotify));
    else {
      const o = await sp.oembed(p.spotify);
      if (!$('#f-tytul').value) $('#f-tytul').value = cleanTitle(o.nazwa);
      setFormCover(o.okladka);
    }
  } catch (e) { showError(e); }
});

$('#f-anuluj').addEventListener('click', () => dlg.close());

$('#form-karta').addEventListener('submit', async (e) => {
  e.preventDefault();
  const p = data.parseCode($('#f-spotify').value) || {};
  const id = p.spotify || ($('#f-spotify').value.trim().match(/^[A-Za-z0-9]{22}$/) || [])[0];
  const err = (m) => { $('#f-blad').textContent = m; $('#f-blad').hidden = false; };
  if (!id) return err('Nieprawidłowy link/ID utworu Spotify.');
  const talia = $('#f-talia').value.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9ąćęłńóśźż_-]/g, '');
  if (!talia) return err('Podaj nazwę talii.');
  if (data.isHitsterDeck(talia) && !$('#f-talia').readOnly) return err('Ta nazwa jest zarezerwowana dla talii Hitstera.');
  const karta = {
    talia,
    numer: $('#f-numer').value.trim(),
    spotify: id,
    tytul: $('#f-tytul').value.trim(),
    wykonawca: $('#f-wykonawca').value.trim(),
    rok: $('#f-rok').value.trim(),
    uwagi: $('#f-uwagi').value.trim(),
    okladka: $('#f-okladka').dataset.url || '',
  };
  $('#f-zapisz').disabled = true;
  try {
    const r = await data.saveCard(karta, formCtx.original);
    dlg.close();
    toast(`Zapisano: ${r.karta?.talia} #${r.karta?.numer}`);
    cardsLoadedOnce = true;
    if (!$('#v-karty').hidden) renderCards();
    if (round && data.key(karta.talia, karta.numer) === round.card.klucz) {
      round.card = await data.resolve({ talia: round.card.talia, numer: round.card.numer });
    }
  } catch (ex) { err(ex.message); } finally { $('#f-zapisz').disabled = false; }
});

$('#f-usun').addEventListener('click', async () => {
  const o = formCtx.original;
  if (!o || !confirm(`Usunąć kartę ${o.talia} #${o.numer} z bazy? Tego nie da się cofnąć.`)) return;
  try {
    await data.deleteCard(o.talia, o.numer);
    dlg.close();
    toast('Usunięto kartę');
    renderCards();
  } catch (ex) { $('#f-blad').textContent = ex.message; $('#f-blad').hidden = false; }
});

// ====================== Ustawienia ======================
async function renderSettings() {
  const s = store.settings();
  const ok = sp.isLoggedIn();
  $('#sp-stan').textContent = !store.clientId()
    ? 'Brak Client ID – uzupełnij w sekcji Zaawansowane (instrukcja w README).'
    : ok ? 'Połączono ze Spotify.' : 'Nie połączono.';
  $('#btn-sp-login').hidden = ok;
  $('#btn-sp-logout').hidden = !ok;
  $('#in-autor').value = s.autor;
  $('#in-haslo').value = s.haslo;
  $('#in-client').value = s.clientId;
  $('#in-client').placeholder = store.clientId() ? '(z pliku config.js)' : '';
  $('#in-arkusz').value = s.arkuszUrl;
  $('#in-arkusz').placeholder = store.sheetUrl() ? '(z pliku config.js)' : '';
  $('#redirect-uri').textContent = new URL('./', location.href).href;
  if (ok) loadDevices();
  else $('#sel-urzadzenie').innerHTML = '<option>—</option>';
}

async function loadDevices() {
  const sel = $('#sel-urzadzenie');
  try {
    const list = await sp.devices();
    const saved = store.settings().urzadzenie;
    sel.innerHTML = '<option value="">Automatycznie (aktywne / ten telefon)</option>'
      + list.map((d) => `<option value="${esc(d.id)}">${esc(d.name)} · ${esc(d.type)}${d.is_active ? ' (aktywne)' : ''}</option>`).join('');
    sel.value = list.some((d) => d.id === saved) ? saved : '';
  } catch (e) { showError(e); }
}

$('#btn-sp-login').addEventListener('click', () => sp.login().catch(showError));
$('#btn-sp-logout').addEventListener('click', () => { sp.logout(); renderChip(); renderSettings(); });
$('#btn-urzadzenia').addEventListener('click', loadDevices);
$('#sel-urzadzenie').addEventListener('change', (e) => store.saveSettings({ urzadzenie: e.target.value || null }));
$('#in-autor').addEventListener('change', (e) => store.saveSettings({ autor: e.target.value.trim() }));
$('#in-haslo').addEventListener('change', (e) => store.saveSettings({ haslo: e.target.value }));
$('#btn-zapisz-adv').addEventListener('click', () => {
  store.saveSettings({ clientId: $('#in-client').value.trim(), arkuszUrl: $('#in-arkusz').value.trim() });
  cardsLoadedOnce = false;
  toast('Zapisano ustawienia');
  renderSettings();
});
$('#btn-cache').addEventListener('click', () => {
  ['cacheUtwory', 'cacheWykonawcy', 'cacheArkusz'].forEach(store.del);
  toast('Wyczyszczono pamięć podręczną – przeładowuję');
  setTimeout(() => location.reload(), 800);
});

// ====================== Start ======================
async function init() {
  renderSegs();
  try {
    if (await sp.handleRedirect()) toast('Połączono ze Spotify ✓');
  } catch (e) { showError(e); }
  renderChip();
  data.loadHitster().catch(showError);
  if (data.sheetEnabled()) data.loadSheet().then(() => (cardsLoadedOnce = true)).catch(() => { /* działa z kopii */ });

  // Karta otwarta bezpośrednio z kodu QR (aparat telefonu → link #k/talia/numer)
  const m = location.hash.match(/^#k\/([^/]+)\/(\d+)/);
  if (m) {
    history.replaceState(null, '', location.pathname);
    if (sp.isLoggedIn()) handleCode(`#k/${m[1]}/${m[2]}`);
    else toast('Połącz się ze Spotify, a potem zeskanuj kartę.', true);
  }
}
init();
