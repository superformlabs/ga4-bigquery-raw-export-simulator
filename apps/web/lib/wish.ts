// An install starts by itself only when the visitor asked for it in this
// browser tab. Opening a link must never be enough: anyone could send a
// signed-in visitor a link that installs into their project.
//
// When the visitor asks for an install, the page keeps what they asked for in
// the tab's sessionStorage under a random key, and names the key in the
// address (`go`). A link can carry a key, but not the entry that goes with it.
// The entry lives as long as the tab, so it is still there after a reload or
// a return from the Google sign-in. It holds no personal data.

import type { InstallSpec } from "./contract";
import { wishOf } from "./flow";

const PREFIX = "ga4sim.wish.";
const KEY_RE = /^[A-Za-z0-9-]{8,64}$/;

/** Remembers the wish and returns its key, or null when the browser offers no storage. */
export function keepWish(spec: InstallSpec): string | null {
  try {
    const key = crypto.randomUUID();
    window.sessionStorage.setItem(PREFIX + key, wishOf(spec));
    return key;
  } catch {
    return null;
  }
}

/** True when this tab holds the wish the key names, for this install. */
export function holdsWish(key: string | null, spec: InstallSpec): boolean {
  if (!key || !KEY_RE.test(key)) return false;
  try {
    return window.sessionStorage.getItem(PREFIX + key) === wishOf(spec);
  } catch {
    return false;
  }
}

/** Forgets every wish this tab holds. For a visitor who signs out: the next one must start from nothing. */
export function dropAllWishes(): void {
  try {
    const store = window.sessionStorage;
    const mine: string[] = [];
    for (let i = 0; i < store.length; i++) {
      const name = store.key(i);
      if (name && name.startsWith(PREFIX)) mine.push(name);
    }
    mine.forEach((name) => store.removeItem(name));
  } catch {
    // Nothing to forget.
  }
}

export function dropWish(key: string | null): void {
  if (!key || !KEY_RE.test(key)) return;
  try {
    window.sessionStorage.removeItem(PREFIX + key);
  } catch {
    // Nothing to forget.
  }
}
