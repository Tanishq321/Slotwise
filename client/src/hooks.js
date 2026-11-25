import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errorMessage } from './api.js';

/** GET a URL and keep { data, error, loading } in sync. `reload()` fetches again. */
/** True while the CSS media query matches, e.g. useMediaQuery('(min-width: 1280px)'). */
export function useMediaQuery(query) {
  const [matches, setMatches] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);
  useEffect(() => {
    const m = window.matchMedia(query);
    const on = () => setMatches(m.matches);
    on();
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, [query]);
  return matches;
}

export function useFetch(url, { skip = false } = {}) {
  const [state, setState] = useState({ data: null, error: null, loading: !skip });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (skip || !url) return;
    let alive = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    api
      .get(url)
      .then((r) => alive && setState({ data: r.data, error: null, loading: false }))
      .catch((e) => alive && setState({ data: null, error: errorMessage(e), loading: false }));
    return () => {
      alive = false;
    };
  }, [url, skip, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { ...state, reload, setData: (data) => setState((s) => ({ ...s, data })) };
}

/** Delay a fast-changing value (e.g. a search box) before using it. */
export function useDebounced(value, ms = 300) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Run an async action with a busy flag and error message. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const mounted = useRef(true);
  useEffect(() => () => (mounted.current = false), []);
  const run = useCallback(async (fn) => {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      if (mounted.current) setError(errorMessage(e));
      throw e;
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, []);
  return { busy, error, setError, run };
}
