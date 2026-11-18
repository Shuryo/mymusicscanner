// Bezpieczny dostęp do localStorage (prywatne okna / zablokowane dane nie psują aplikacji).
import { CONFIG } from './config.js';

const P = 'hitskaner.';
const mem = {};

export function get(key, fallback = null) {
  try {
    const v = localStorage.getItem(P + key);
    return v === null ? fallback : JSON.parse(v);
  } catch {
    return key in mem ? mem[key] : fallback;
  }
}

export function set(key, value) {
  mem[key] = value;
  try { localStorage.setItem(P + key, JSON.stringify(value)); } catch { /* brak pamięci – trudno */ }
}

export function del(key) {
  delete mem[key];
  try { localStorage.removeItem(P + key); } catch { /* ignoruj */ }
}

// Ustawienia gry i aplikacji
const DEFAULTS = {
  limit: 30,          // sekundy słuchania: 15 / 30 / 60 / 0 = bez limitu
  start: 'intro',     // 'poczatek' | 'intro' | 'losowo'
  autor: '',          // podpis osoby dodającej karty
  haslo: '',          // hasło edycji bazy
  clientId: '',       // nadpisuje CONFIG.SPOTIFY_CLIENT_ID
  arkuszUrl: '',      // nadpisuje CONFIG.ARKUSZ_API_URL
  urzadzenie: null,   // id urządzenia Spotify
};

export function settings() {
  return { ...DEFAULTS, ...get('ustawienia', {}) };
}

export function saveSettings(patch) {
  set('ustawienia', { ...settings(), ...patch });
}

export function clientId() {
  return (settings().clientId || CONFIG.SPOTIFY_CLIENT_ID || '').trim();
}

export function sheetUrl() {
  return (settings().arkuszUrl || CONFIG.ARKUSZ_API_URL || '').trim();
}
