// Spotify: logowanie (PKCE, bez serwera), Web API i sterowanie odtwarzaniem w aplikacji Spotify.
import * as store from './store.js';

const SCOPES = 'user-read-playback-state user-modify-playback-state';
const API = 'https://api.spotify.com/v1';

export class SpotifyError extends Error {
  constructor(msg, status, reason) { super(msg); this.status = status; this.reason = reason; }
}

function redirectUri() {
  // zawsze katalog aplikacji (…/), niezależnie od tego, czy otwarto „/” czy „/index.html”
  return new URL('./', location.href).href;
}

function b64url(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function isLoggedIn() {
  return !!store.get('spotifyToken');
}

export function logout() {
  store.del('spotifyToken');
}

export async function login() {
  const cid = store.clientId();
  if (!cid) throw new SpotifyError('Brak Client ID Spotify – uzupełnij w Ustawieniach.');
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  store.set('pkce', { verifier, hash: location.hash });
  const q = new URLSearchParams({
    response_type: 'code', client_id: cid, scope: SCOPES, redirect_uri: redirectUri(),
    code_challenge_method: 'S256', code_challenge: challenge,
  });
  location.href = 'https://accounts.spotify.com/authorize?' + q;
}

// Wywołać przy starcie: kończy logowanie, jeśli wróciliśmy ze Spotify z ?code=
export async function handleRedirect() {
  const p = new URLSearchParams(location.search);
  const code = p.get('code'), err = p.get('error');
  if (!code && !err) return null;
  const pk = store.get('pkce', {});
  history.replaceState(null, '', redirectUri() + (pk.hash || ''));
  store.del('pkce');
  if (err) throw new SpotifyError('Spotify odmówił logowania: ' + err);
  await tokenRequest({
    grant_type: 'authorization_code', code, redirect_uri: redirectUri(),
    client_id: store.clientId(), code_verifier: pk.verifier,
  });
  return true;
}

async function tokenRequest(params) {
  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (params.grant_type === 'refresh_token') logout();
    throw new SpotifyError('Błąd logowania Spotify: ' + (j.error_description || j.error || r.status), r.status);
  }
  const old = store.get('spotifyToken', {});
  store.set('spotifyToken', {
    access: j.access_token,
    refresh: j.refresh_token || old.refresh,
    expires: Date.now() + (j.expires_in - 60) * 1000,
  });
}

async function accessToken() {
  const t = store.get('spotifyToken');
  if (!t) throw new SpotifyError('Nie połączono ze Spotify.', 401, 'NO_LOGIN');
  if (Date.now() > t.expires) {
    await tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh, client_id: store.clientId() });
    return store.get('spotifyToken').access;
  }
  return t.access;
}

async function api(path, { method = 'GET', body, retry = true } = {}) {
  const r = await fetch(API + path, {
    method,
    headers: { Authorization: 'Bearer ' + await accessToken(), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 401 && retry) {
    const t = store.get('spotifyToken');
    if (t) { t.expires = 0; store.set('spotifyToken', t); }
    return api(path, { method, body, retry: false });
  }
  if (r.status === 429 && retry) {
    const wait = Math.min(10, parseInt(r.headers.get('Retry-After') || '2', 10));
    await new Promise((res) => setTimeout(res, wait * 1000));
    return api(path, { method, body, retry: false });
  }
  if (r.status === 204) return null;
  const text = await r.text();
  const j = text ? (() => { try { return JSON.parse(text); } catch { return null; } })() : null;
  if (!r.ok) {
    const msg = j?.error?.message || r.statusText || String(r.status);
    throw new SpotifyError(msg, r.status, j?.error?.reason);
  }
  return j;
}

// ---------- Dane utworów (z pamięcią podręczną) ----------
const trackCache = store.get('cacheUtwory', {});
const artistCache = store.get('cacheWykonawcy', {});

function saveCache(key, obj, max = 800) {
  const keys = Object.keys(obj);
  if (keys.length > max) keys.slice(0, keys.length - max).forEach((k) => delete obj[k]);
  store.set(key, obj);
}

function slimTrack(t) {
  return {
    id: t.id,
    nazwa: t.name,
    wykonawcy: t.artists.map((a) => a.name),
    wykonawcaId: t.artists[0]?.id,
    okladka: t.album?.images?.[0]?.url || '',
    okladkaMala: t.album?.images?.at(-1)?.url || '',
    data: t.album?.release_date || '',
    czas: t.duration_ms,
  };
}

export async function track(id) {
  if (trackCache[id]) return trackCache[id];
  const t = slimTrack(await api('/tracks/' + encodeURIComponent(id)));
  trackCache[id] = t;
  saveCache('cacheUtwory', trackCache);
  return t;
}

export async function artistImage(id) {
  if (!id) return '';
  if (id in artistCache) return artistCache[id];
  const a = await api('/artists/' + encodeURIComponent(id));
  artistCache[id] = a.images?.[0]?.url || '';
  saveCache('cacheWykonawcy', artistCache);
  return artistCache[id];
}

export async function search(q) {
  const j = await api('/search?' + new URLSearchParams({ q, type: 'track', limit: '10', market: 'from_token' }));
  return (j?.tracks?.items || []).filter(Boolean).map(slimTrack);
}

// Bez logowania: tytuł i okładka z publicznego oEmbed (bez wykonawcy/roku).
export async function oembed(id) {
  const r = await fetch('https://open.spotify.com/oembed?url=' + encodeURIComponent('https://open.spotify.com/track/' + id));
  if (!r.ok) throw new Error('Nie znaleziono utworu');
  const j = await r.json();
  return { nazwa: j.title || '', okladka: j.thumbnail_url || '' };
}

// ---------- Odtwarzanie ----------
export async function devices() {
  const j = await api('/me/player/devices');
  return j?.devices || [];
}

async function pickDevice() {
  const list = await devices();
  if (!list.length) {
    throw new SpotifyError('Nie widzę żadnego urządzenia Spotify. Otwórz aplikację Spotify na telefonie (najlepiej puść na chwilę dowolny utwór) i spróbuj ponownie.', 404, 'NO_DEVICE');
  }
  const saved = store.settings().urzadzenie;
  const dev = list.find((d) => d.id === saved) || list.find((d) => d.is_active)
    || list.find((d) => d.type === 'Smartphone') || list[0];
  return dev.id;
}

let lastDevice = null;

export async function play(trackId, positionMs = 0) {
  const dev = await pickDevice();
  lastDevice = dev;
  const body = { uris: ['spotify:track:' + trackId], position_ms: Math.max(0, Math.round(positionMs)) };
  try {
    await api('/me/player/play?device_id=' + encodeURIComponent(dev), { method: 'PUT', body });
  } catch (e) {
    if (e.status !== 404) throw e;
    // Urządzenie uśpione – przenieś odtwarzanie i spróbuj raz jeszcze
    await api('/me/player', { method: 'PUT', body: { device_ids: [dev], play: false } });
    await new Promise((r) => setTimeout(r, 700));
    await api('/me/player/play?device_id=' + encodeURIComponent(dev), { method: 'PUT', body });
  }
  // Wyłącz powtarzanie i losowanie, żeby po końcu fragmentu nic nie grało dalej
  api('/me/player/repeat?state=off', { method: 'PUT' }).catch(() => {});
}

export async function resume() {
  await api('/me/player/play' + (lastDevice ? '?device_id=' + encodeURIComponent(lastDevice) : ''), { method: 'PUT' });
}

export async function pause() {
  try {
    await api('/me/player/pause' + (lastDevice ? '?device_id=' + encodeURIComponent(lastDevice) : ''), { method: 'PUT' });
  } catch (e) {
    // "już zatrzymane" nie jest błędem
    if (e.status !== 403 && e.status !== 404) throw e;
  }
}
