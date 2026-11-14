import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

// ---- hash router ----

export type Route =
  | { page: "overview" }
  | { page: "deals"; location: string | null }
  | { page: "deal"; key: string }
  | { page: "watchlist" }
  | { page: "hotel"; key: string; item?: string; date?: string }
  | { page: "activity" };

export function parseRoute(hash: string): Route {
  const h = hash.replace(/^#/, "") || "/";
  let m = h.match(/^\/hotel\/([^/]+)(?:\/([^/]+))?(?:\/(\d{4}-\d{2}-\d{2}))?$/);
  if (m) return { page: "hotel", key: decodeURIComponent(m[1]), item: m[2] && decodeURIComponent(m[2]), date: m[3] };
  m = h.match(/^\/deals(?:\/([a-z0-9-]+))?$/);
  if (m) return { page: "deals", location: m[1] ?? null };
  m = h.match(/^\/deal\/([^/]+)$/);
  if (m) return { page: "deal", key: decodeURIComponent(m[1]) };
  if (h === "/watchlist") return { page: "watchlist" };
  if (h === "/activity") return { page: "activity" };
  return { page: "overview" };
}

const subscribeHash = (cb: () => void) => {
  window.addEventListener("hashchange", cb);
  return () => window.removeEventListener("hashchange", cb);
};

export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribeHash, () => location.hash);
  return parseRoute(hash);
}

// ---- persisted preference ----

export function usePref<T>(key: string, initial: T): [T, (v: T | ((p: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw == null ? initial : { ...(initial as object), ...JSON.parse(raw) } as T;
    } catch {
      return initial;
    }
  });
  const set = useCallback(
    (v: T | ((p: T) => T)) =>
      setValue((prev) => {
        const next = typeof v === "function" ? (v as (p: T) => T)(prev) : v;
        try {
          localStorage.setItem(key, JSON.stringify(next));
        } catch {
          /* storage unavailable */
        }
        return next;
      }),
    [key],
  );
  return [value, set];
}

/** Primitive preference (string). */
export function useStringPref(key: string, initial: string): [string, (v: string) => void] {
  const [value, setValue] = useState(() => {
    try {
      return localStorage.getItem(key) ?? initial;
    } catch {
      return initial;
    }
  });
  const set = useCallback(
    (v: string) => {
      setValue(v);
      try {
        localStorage.setItem(key, v);
      } catch {
        /* ignore */
      }
    },
    [key],
  );
  return [value, set];
}

// ---- theme ----

export type Theme = "system" | "light" | "dark";

export function useTheme(): [Theme, (t: Theme) => void, boolean] {
  const [theme, setTheme] = useStringPref("sh.theme", "system");
  const [systemDark, setSystemDark] = useState(() => matchMedia("(prefers-color-scheme: dark)").matches);
  useEffect(() => {
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const on = () => setSystemDark(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  useEffect(() => {
    if (theme === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
  }, [theme]);
  const dark = theme === "dark" || (theme === "system" && systemDark);
  return [theme as Theme, setTheme as (t: Theme) => void, dark];
}

// ---- element width (charts) ----

export function useWidth<T extends HTMLElement>(): [(el: T | null) => void, number] {
  const [el, setEl] = useState<T | null>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.round(e.contentRect.width)));
    ro.observe(el);
    setW(Math.round(el.getBoundingClientRect().width));
    return () => ro.disconnect();
  }, [el]);
  return [setEl, w];
}
