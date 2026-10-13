"use client";

import { useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";
import { BadMark, OkMark, SkipMark, WaitMark } from "./Marks";

/** wait: not finished yet. ok: done. bad: stopped on a problem. skip: not started. */
export type LineState = "wait" | "ok" | "bad" | "skip";

export type Line = {
  key: string;
  text: string;
  state: LineState;
  /** What the line has to add: what to fix, or how far the work is. */
  more?: ReactNode;
  /** True for the one line that is being worked on. The lines after it wait for their turn. */
  now?: boolean;
  /** True when the words of the line say its state themselves: no word is added for screen readers. */
  plain?: boolean;
};

const MARK: Record<LineState, () => ReactNode> = { wait: WaitMark, ok: OkMark, bad: BadMark, skip: SkipMark };
const SAID: Record<LineState, string> = { wait: "in progress", ok: "done", bad: "stopped", skip: "not started" };

type Props = {
  /** What the list is about. Read by screen readers, and the name of the box when it scrolls. */
  label: string;
  lines: Line[];
  /**
   * True on the installing page (decision D-85): the list is a box of its own
   * that scrolls, capped in height by the height of the screen, so that it
   * never pushes what the visitor has to act on out of sight. The box takes
   * the Tab key, carries the name of the list, and scrolls with the arrow
   * keys. Every other list is as tall as its lines.
   */
  scroll?: boolean;
};

/**
 * Keeps the line that is being worked on inside the box, and scrolls nothing
 * else: a box capped in height would otherwise hide the step that is running
 * on a phone, and the install would go on out of sight. Only the box is
 * scrolled, never the page, so nothing a visitor is reading moves.
 */
function useFollow(box: RefObject<HTMLUListElement | null>, now: string | null, on: boolean) {
  useLayoutEffect(() => {
    if (!on || !now) return;
    const list = box.current;
    const line = list?.querySelector<HTMLElement>("li.now");
    if (!list || !line) return;
    const b = list.getBoundingClientRect();
    const r = line.getBoundingClientRect();
    if (r.bottom > b.bottom) list.scrollTop += r.bottom - b.bottom;
    else if (r.top < b.top) list.scrollTop -= b.top - r.top;
  }, [box, now, on]);
}

/** One sentence per item, a plain mark, no separators. */
export default function CheckList({ label, lines, scroll = false }: Props) {
  const box = useRef<HTMLUListElement>(null);
  useFollow(box, lines.find((l) => l.now)?.key ?? null, scroll);
  return (
    <ul className={scroll ? "checks box" : "checks"} aria-label={label} tabIndex={scroll ? 0 : undefined} ref={box}>
      {lines.map((line) => {
        const classes = [line.state === "ok" ? "" : line.state, line.now ? "now" : ""].filter(Boolean).join(" ");
        const Mark = MARK[line.state];
        return (
          <li key={line.key} className={classes || undefined}>
            <span className="mark">
              <Mark />
            </span>
            <span className="text">
              {line.text}
              {line.plain ? null : <span className="sr">, {line.state === "wait" && !line.now ? "waiting" : SAID[line.state]}</span>}
              {line.more}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
