// Karty: wbudowane polskie talie Hitstera + własne karty z Arkusza Google (wspólna baza).
import * as store from './store.js';

let hitster = null;               // { talie: { sku: { nazwa, karty: { n: {s,t,a,y,g} } } } }
let sheetCards = store.get('cacheArkusz', []);

export const key = (talia, numer) => `${String(talia).trim().toLowerCase()}/${parseInt(numer, 10)}`;
export const isHitsterDeck = (talia) => /^aaa[a-z]\d{4}$/i.test(String(talia));

export async function loadHitster() {
  if (hitster) return hitster;
  const r = await fetch('data/hitster-pl.json');
  hitster = await r.json();
  return hitster;
}

export function hitsterDecks() {
  return Object.entries(hitster?.talie || {}).map(([sku, t]) => ({ sku, nazwa: t.nazwa, ile: Object.keys(t.karty).length }));
}

// ---------- Arkusz Google (Apps Script) ----------
export function sheetEnabled() { return !!store.sheetUrl(); }
export function customCards() { return sheetCards; }

export async function loadSheet() {
  const url = store.sheetUrl();
  if (!url) { sheetCards = []; return sheetCards; }
  const r = await fetch(url + (url.includes('?') ? '&' : '?') + 't=' + Date.now());
  const j = await r.json();
  if (!j.ok) throw new Error(j.blad || 'Błąd bazy');
  sheetCards = j.karty || [];
  store.set('cacheArkusz', sheetCards);
  return sheetCards;
}

async function sheetPost(payload) {
  const url = store.sheetUrl();
  if (!url) throw new Error('Brak adresu bazy (Arkusz Google) – uzupełnij w Ustawieniach.');
  const s = store.settings();
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // bez preflight CORS
    body: JSON.stringify({ ...payload, haslo: s.haslo, autor: s.autor }),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(j.blad || 'Nie udało się zapisać');
  sheetCards = j.karty || sheetCards;
  store.set('cacheArkusz', sheetCards);
  return j;
}

export const saveCard = (karta, oryginal) => sheetPost({ akcja: 'zapisz', karta, oryginal });
export const deleteCard = (talia, numer) => sheetPost({ akcja: 'usun', talia, numer });

export function customDecks() {
  const m = new Map();
  for (const c of sheetCards) {
    if (isHitsterDeck(c.talia)) continue;
    m.set(c.talia, (m.get(c.talia) || 0) + 1);
  }
  return [...m].map(([talia, ile]) => ({ talia, ile })).sort((a, b) => a.talia.localeCompare(b.talia, 'pl'));
}

// ---------- Rozpoznawanie kodu z karty ----------
// Zwraca { talia, numer } albo { spotify } albo null
export function parseCode(raw) {
  const s = String(raw || '').trim();
  let m;
  if ((m = s.match(/hitstergame\.com\/([a-z-]+)\/(aaa[a-z]\d{4})\/(\d+)/i))) return { talia: m[2].toLowerCase(), numer: +m[3] };
  if ((m = s.match(/hitstergame\.com\/([a-z-]+)\/(\d+)\b/i))) return { talia: m[1].toLowerCase() === 'pl' ? 'aaae0001' : m[1], numer: +m[2] };
  if ((m = s.match(/[#?&]k[=/]([^/\s]+)\/(\d+)/i))) return { talia: decodeURIComponent(m[1]).toLowerCase(), numer: +m[2] };
  if ((m = s.match(/(?:open\.spotify\.com\/(?:intl-[a-z]+\/)?track\/|spotify:track:)([A-Za-z0-9]{22})/))) return { spotify: m[1] };
  if ((m = s.match(/^([a-z0-9-]+)\s*[/ ]\s*(\d+)$/i))) return { talia: m[1].toLowerCase(), numer: +m[2] };
  return null;
}

// Link (kod QR) do własnej karty
export function cardUrl(talia, numer) {
  return new URL('./', location.href).href + '#k/' + encodeURIComponent(talia) + '/' + numer;
}

// Zwraca pełną kartę albo null. Wpis w arkuszu nadpisuje dane z Hitstera (np. poprawiony rok).
export async function resolve(code) {
  const c = typeof code === 'string' ? parseCode(code) : code;
  if (!c) return null;
  if (c.spotify) return { klucz: 'spotify/' + c.spotify, talia: 'spotify', taliaNazwa: 'Link Spotify', numer: '', spotify: c.spotify, zrodlo: 'link' };
  await loadHitster();
  const k = key(c.talia, c.numer);
  const h = hitster.talie[c.talia]?.karty?.[c.numer];
  const own = sheetCards.find((x) => key(x.talia, x.numer) === k);
  if (!h && !own) return { brak: true, talia: c.talia, numer: c.numer };
  const card = {
    klucz: k,
    talia: c.talia,
    taliaNazwa: hitster.talie[c.talia]?.nazwa || c.talia,
    numer: c.numer,
    spotify: h?.s,
    tytul: h?.t, wykonawca: h?.a, rok: h?.y,
    grupa: h?.g === 'z' ? 'zespół' : h?.g === 's' ? 'solo' : '',
    zrodlo: h ? 'hitster' : 'wlasna',
  };
  if (own) {
    card.spotify = own.spotify || card.spotify;
    if (own.tytul) card.tytul = own.tytul;
    if (own.wykonawca) card.wykonawca = own.wykonawca;
    if (own.rok) card.rok = parseInt(own.rok, 10) || card.rok;
    card.poprawiona = !!h;
  }
  return card;
}
