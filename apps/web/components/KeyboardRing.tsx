"use client";

import { useEffect, useSyncExternalStore } from "react";
import { announced, subscribe } from "@/lib/announce";

/**
 * Two things every page needs and nobody sees.
 *
 * The ring: a ring around the field that has the cursor is shown only to
 * someone who moves with the Tab key, and goes away at the next mouse click.
 *
 * The title of the screen, said to screen readers when the screen changes.
 */
export default function KeyboardRing() {
  useEffect(() => {
    const root = document.documentElement;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Tab") root.classList.add("kbd");
    };
    const onMouse = () => root.classList.remove("kbd");
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onMouse);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onMouse);
    };
  }, []);

  const title = useSyncExternalStore(subscribe, announced, () => "");
  return (
    <p className="sr" aria-live="polite" aria-atomic="true">
      {title}
    </p>
  );
}
