import { useEffect, useState } from 'react';

// Catalog data (cases, attributes, operators) is fixed while the server runs, but the server can restart with new
// config while this page stays open. So a cached answer only lives briefly: it saves the burst of identical calls
// a screen makes, and the next visit or tab focus sees the server's current config.
const TTL_MS = 30_000;
const cache = new Map<string, { at: number; value: Promise<unknown> }>();

export function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value as Promise<T>;
  const value = load();
  value.catch(() => cache.delete(key)); // a failed call may be retried
  cache.set(key, { at: Date.now(), value });
  return value;
}

/** Forget every cached answer (e.g. when the tab comes back into focus). */
export const clearCache = () => cache.clear();

export interface Async<T> {
  data?: T;
  error?: Error;
  loading: boolean;
  reload: () => void;
}

/** Runs `load` whenever `key` changes; `null` key = nothing to load yet. */
export function useAsync<T>(key: string | null, load: () => Promise<T>): Async<T> {
  const [state, setState] = useState<{ data?: T; error?: Error; loading: boolean }>({ loading: key !== null });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (key === null) {
      setState({ loading: false });
      return;
    }
    let live = true;
    setState((s) => ({ data: s.data, loading: true }));
    load().then(
      (data) => live && setState({ data, loading: false }),
      (error) => live && setState({ error, loading: false }),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, tick]);
  return { ...state, reload: () => setTick((t) => t + 1) };
}

/** `value` once it has stopped changing for `ms`. */
export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function useHash(): [string, (h: string) => void] {
  const [hash, setHash] = useState(() => window.location.hash.slice(1) || '/');
  useEffect(() => {
    const on = () => setHash(window.location.hash.slice(1) || '/');
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return [hash, (h: string) => (window.location.hash = h)];
}

export function readStore(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStore(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* per-viewer convenience only */
  }
}

export type Theme = 'system' | 'light' | 'dark';

/** Sets the theme on <html> (no attribute = follow the OS) and remembers it. */
export function applyTheme(t: Theme) {
  if (t === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  writeStore('ruler.theme', t);
}

export const savedTheme = (): Theme => {
  const t = readStore('ruler.theme');
  return t === 'light' || t === 'dark' ? t : 'system';
};
