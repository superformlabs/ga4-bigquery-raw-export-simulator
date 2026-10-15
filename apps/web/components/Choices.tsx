"use client";

import { useEffect, useRef, useState } from "react";

export type Choice = { id: string; label: string; icon?: string; hint?: string };

type Props = {
  /** What the choices answer. Read by screen readers. */
  label: string;
  items: readonly Choice[];
  /** The choice made earlier, shown as taken when the visitor comes back. */
  current?: string | null;
  onPick: (id: string) => void;
  /**
   * "modes": the three experiences, each an icon and a name in a larger
   * button; the hint is said to screen readers and not shown.
   * "places": the four locations, four small buttons of the same width, side
   * by side on one line and two by two on a narrow phone (decision D-93, in
   * the place of the four full-width rows of decision D-90). Since decision
   * D-90 a button reads the BigQuery location code alone, so nothing is shown
   * after the name and no place carries a hint any more.
   * "types": the four types of dataset, one full-width button per line, the
   * name on the first line and the hint under it as a second, smaller line
   * (decisions D-96 and D-97). A sentence does not fit in a small button, so
   * these are not the small buttons of "places".
   */
  look?: "choices" | "modes" | "places" | "types";
};

// Long enough to see the choice taken.
const MOVE_ON_MS = 320;

/** A screen made of choices only: no sentence, no hover effect. Choosing moves on. */
export default function Choices({ label, items, current = null, onPick, look = "choices" }: Props) {
  const [taken, setTaken] = useState<string | null>(current);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const group = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const buttons = group.current?.querySelectorAll("button");
    const first = Array.from(buttons ?? []).find((b) => b.getAttribute("aria-pressed") === "true") ?? buttons?.[0];
    first?.focus({ preventScroll: true });
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  function pick(id: string) {
    setTaken(id);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => onPick(id), MOVE_ON_MS);
  }

  // A hint that is shown is read as part of the button, so the button needs no name of its own.
  const shows = look === "types";
  return (
    <div className={look} role="group" aria-label={label} ref={group}>
      {items.map((it) => (
        <button
          key={it.id}
          type="button"
          aria-pressed={taken === it.id}
          // The description is not shown. A screen reader says "Automated: Just choose your project…".
          aria-label={it.hint && !shows ? `${it.label}: ${it.hint}` : undefined}
          onClick={() => pick(it.id)}
        >
          {it.icon ? (
            <span className="icon" aria-hidden="true">
              {it.icon}
            </span>
          ) : null}
          <span className="pick">{it.label}</span>
          {shows && it.hint ? <span className="hint">{it.hint}</span> : null}
        </button>
      ))}
    </div>
  );
}
