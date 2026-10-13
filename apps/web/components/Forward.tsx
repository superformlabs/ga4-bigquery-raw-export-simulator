"use client";

import { useEffect, useRef } from "react";

type Props = {
  /** The sentence is hidden, also from the keyboard and from screen readers, until this is true. */
  show: boolean;
  children: string;
  onGo: () => void;
  /** Less room above, for a page that is already long. */
  close?: boolean;
  danger?: boolean;
  /** A filled button, blue with white words, in the place of the plain sentence (task UI-32). */
  filled?: boolean;
  /** False when the Enter key must not stand for a click on the sentence. */
  enter?: boolean;
};

/**
 * The way forward: a plain sentence, no arrow. It says what comes next. The
 * sentence that installs is a filled button (task UI-32). The Enter key acts only while the sentence is visible, and not from a
 * button or a link, which have their own meaning for Enter.
 */
export default function Forward({ show, children, onGo, close = false, danger = false, filled = false, enter = true }: Props) {
  const go = useRef(onGo);
  go.current = onGo;

  useEffect(() => {
    if (!show || !enter) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || e.defaultPrevented || e.isComposing) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "BUTTON" || tag === "A" || tag === "TEXTAREA") return;
      if (document.querySelector("dialog[open]")) return;
      e.preventDefault();
      go.current();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [show, enter]);

  return (
    <div className={close ? "forward close" : "forward"}>
      <button
        type="button"
        className={`go${show ? " show" : ""}${danger ? " danger" : ""}${filled ? " fill" : ""}`}
        tabIndex={show ? 0 : -1}
        aria-hidden={!show}
        onClick={() => show && onGo()}
      >
        {children}
      </button>
    </div>
  );
}

/** The same sentence, as a link that leaves the app. */
export function ForwardLink({ href, children, newTab = false, filled = false }: { href: string; children: string; newTab?: boolean; filled?: boolean }) {
  return (
    <a className={`go show${filled ? " fill" : ""}`} href={href} {...(newTab ? { target: "_blank", rel: "noreferrer" } : {})}>
      {children}
      {newTab ? <span className="sr"> (opens in a new tab)</span> : null}
    </a>
  );
}
