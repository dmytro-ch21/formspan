"use client";

import { useSyncExternalStore } from "react";

export type Theme = "light" | "dark";
export const THEME_KEY = "vola-theme";

/*
  The theme lives on <html data-theme>, not in React state.

  It has to: an inline script applies it before first paint (see ThemeScript
  below), so React isn't the source of truth, and syncing it into state in an
  effect would mean one frame of disagreement plus a cascading render.
  Reading it through useSyncExternalStore is exactly what that hook is for —
  external, mutable, subscribable state — and it gives a correct server
  snapshot for free.
*/
const listeners = new Set<() => void>();

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function getSnapshot(): Theme {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

// Web is light by default — it's the desk surface. The phone is dark-first.
function getServerSnapshot(): Theme {
  return "light";
}

function setTheme(next: Theme) {
  document.documentElement.dataset.theme = next;
  try {
    window.localStorage.setItem(THEME_KEY, next);
  } catch {
    // Private mode or blocked storage: the toggle still works for this
    // session, it just won't be remembered. Not worth telling anyone about.
  }
  listeners.forEach((fn) => fn());
}

/**
 * Light/dark switch.
 *
 * Stored per browser rather than on the profile: it's a property of where
 * you're sitting, not of who you are. The same account on a bright monitor
 * at work and a dim laptop at night wants different answers.
 */
export function ThemeToggle() {
  const theme = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const dark = theme === "dark";

  return (
    <button
      type="button"
      onClick={() => setTheme(dark ? "light" : "dark")}
      // A switch, not a button: it has an on/off state and a screen reader
      // should say so rather than just reading the label.
      role="switch"
      aria-checked={dark}
      aria-label="Dark mode"
      title={dark ? "Switch to light" : "Switch to dark"}
      className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-text-muted transition hover:bg-surface-hover hover:text-text"
    >
      <span aria-hidden="true">{dark ? "☾" : "☀"}</span>
      <span>{dark ? "Dark" : "Light"}</span>
    </button>
  );
}

/**
 * Applies the stored theme before first paint.
 *
 * A blocking inline script in <head>. If this waited for hydration, someone
 * on dark would get a white flash on every navigation — the single most
 * obvious way a theme toggle looks broken.
 */
export function ThemeScript() {
  const js = `(function(){try{if(localStorage.getItem(${JSON.stringify(
    THEME_KEY,
  )})==="dark"){document.documentElement.dataset.theme="dark"}}catch(e){}})();`;
  return <script dangerouslySetInnerHTML={{ __html: js }} />;
}
