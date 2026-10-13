"use client";

import { useEffect, useLayoutEffect, useState, type ReactNode } from "react";
import { announce } from "@/lib/announce";
import { logout } from "@/lib/api";
import { forgetAll } from "@/lib/cache";
import { dropAllWishes } from "@/lib/wish";
import { AgainArrow, LeftArrow } from "./Marks";
import Powered from "./Powered";
import TopLinks from "./TopLinks";

type Props = {
  title: string;
  /**
   * True on the welcome page alone (decision D-90): the title takes the text
   * column of the paragraphs under it and is read from the left, so its left
   * edge is their left edge. It keeps one font size, written in
   * `app/globals.css` (`h1.left`). Everywhere else the title is one centred
   * block that wraps by itself.
   */
  titleLeft?: boolean;
  /**
   * One sentence under the title, one fact (decision D-37). A list of
   * sentences is shown as one paragraph for each: that is the welcome text of
   * decisions D-74 and D-82, and the only screen that has more than one.
   */
  subtitle?: string | readonly string[];
  /**
   * Words of the subtitle that are a link, when it holds any: the welcome text
   * and its "read the documentation" (decision D-82) and "open source code"
   * (decision D-90). Each link opens in a new tab, as the book in the
   * top-right corner does, so a visitor never loses their place. The words
   * stay part of the sentence a screen reader hears.
   */
  subtitleLinks?: readonly { text: string; href: string }[];
  /**
   * True on the one screen that keeps the entry animations, "Choose your
   * experience" (decision D-75): the title falls into place, the subtitle
   * appears while it lands, and the rest of the page follows. Everywhere else
   * the screen appears at once.
   */
  entry?: boolean;
  /** Where the arrow in the bottom-left corner leads. No arrow without it. */
  onBack?: (() => void) | null;
  /**
   * On the last page only (task UI-32): the bottom-left corner holds a circular
   * arrow that starts the flow again, in the place of the back arrow.
   */
  onAgain?: (() => void) | null;
  /**
   * True on a screen where a visitor is signed in and may leave: the words
   * "Sign out" stand in the bottom-right corner, in line with the back arrow
   * (decision D-41). Not on the welcome page, and not while the steps of an
   * install run: they are sent by the page, and leaving would stop them halfway.
   */
  signOut?: boolean;
  /**
   * True on a screen whose subtitle follows a field as the visitor changes it:
   * the two period screens, which say how many days were chosen and how long
   * the install takes (decision D-79). The subtitle is then a live region, so
   * a screen reader hears it change, and what is said when the screen opens is
   * the title alone: the subtitle is not read twice.
   */
  liveSubtitle?: boolean;
  children?: ReactNode;
};

// Where the design puts the two corners, and the size of the arrow (app/globals.css).
const CORNER = { side: 24, bottom: 20, size: 44 };
// What the page may hold: anything the bottom of the screen could lie on.
const CONTENT = "h1 .w, input, select, button, a, label, li, p, pre, code, [role=listbox]";

/**
 * Where the three things at the bottom go (tasks UI-10 and UI-22, decision
 * D-86). The design fixes the back arrow to the bottom-left corner of the
 * screen, the words "Sign out" to the bottom-right one, and since decision
 * D-86 "powered by GA4Dataform" to the bottom centre. The three sit on one
 * line. On a page that is higher than the screen, what is fixed lies on
 * whatever scrolls under it. So when the page is higher than the screen and
 * something of the page reaches the band of one of them, all three leave the
 * screen for the page together: they sit at the bottom of the page, in the
 * empty band under the content, still in line with each other. In every other
 * case they stay exactly where the design puts them.
 *
 * The words at the bottom centre are on every screen, so this now runs on
 * every screen, where before it slept on a screen without a corner. The two
 * links of the top-right corner are not placed here: they stay on the screen
 * and carry a white background instead (decision D-77).
 *
 * Returns the distance from the top of the page, or null for the place of
 * the design.
 */
function useBottomPlace(left: boolean, right: boolean): number | null {
  const [top, setTop] = useState<number | null>(null);
  useLayoutEffect(() => {
    const main = document.querySelector("main");
    if (!main) return;
    const place = () => {
      const higher = main.offsetHeight > window.innerHeight + 1;
      const words = document.querySelector<HTMLElement>("button.signout");
      const middle = document.querySelector<HTMLElement>("footer.powered");
      const page = document.documentElement.clientWidth;
      const fromLeft = CORNER.side + CORNER.size + 8;
      const fromRight = page - (CORNER.side + (words?.offsetWidth ?? 0) + 8);
      // The band the words at the bottom centre take, with room on each side.
      const half = (middle?.offsetWidth ?? 0) / 2 + 8;
      const reached =
        higher &&
        Array.from(main.querySelectorAll<HTMLElement>(CONTENT)).some((e) => {
          if (e.classList.contains("sr")) return false;
          const r = e.getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0) return false;
          return (left && r.left < fromLeft) || (right && r.right > fromRight) || (r.right > page / 2 - half && r.left < page / 2 + half);
        });
      setTop(reached ? main.offsetTop + main.offsetHeight - CORNER.bottom - CORNER.size : null);
    };
    place();
    const watcher = new ResizeObserver(place);
    watcher.observe(main);
    main.querySelectorAll(".col").forEach((e) => watcher.observe(e));
    window.addEventListener("resize", place);
    return () => {
      watcher.disconnect();
      window.removeEventListener("resize", place);
    };
  }, [left, right]);
  return top;
}

/** The visitor signs out: the backend forgets the sign-in, the tab forgets what it holds, and the welcome page opens. */
async function leave() {
  try {
    await logout();
  } catch {
    // The welcome page asks who is signed in, and shows what is true.
  }
  dropAllWishes();
  forgetAll();
  window.location.assign("/");
}

/**
 * One screen: the two links in the top-right corner, a title, its subtitle,
 * the rest of the page, and "powered by GA4Dataform" at the bottom centre
 * (decision D-86). The screen appears at once, except on "Choose your
 * experience", which keeps the entry animations of the design (`entry`,
 * decision D-75): there the title falls into place, the subtitle appears while
 * it lands, and the rest follows a moment later. The title has two wrappers:
 * one stays in place, one inside it falls. No shadow, on the letters or under
 * them (decision D-37).
 */
export default function Screen({ title, titleLeft = false, subtitle, subtitleLinks = [], entry = false, onBack, onAgain, signOut = false, liveSubtitle = false, children }: Props) {
  // The paragraphs of a subtitle that is a list of sentences; null for the one sentence of every other screen.
  const paragraphs: readonly string[] | null = typeof subtitle === "object" ? subtitle : null;
  // Said to screen readers when the screen changes: the title, then its subtitle, read as one text.
  // A subtitle that follows a field says itself when it changes (`liveSubtitle`), so it is not said here.
  const said = liveSubtitle ? "" : paragraphs ? paragraphs.join(" ") : subtitle;
  useEffect(() => announce(said ? `${title}. ${said}` : title), [title, said]);
  const bottomTop = useBottomPlace(!!onBack || !!onAgain, signOut);
  const [leaving, setLeaving] = useState(false);
  const low = bottomTop === null ? "" : " low";
  const style = bottomTop === null ? undefined : { top: bottomTop };
  return (
    <>
      <TopLinks />
      <main className={entry ? "entry" : undefined}>
        <div className="col wide">
          <h1 className={titleLeft ? "left" : undefined}>
            <span className="w">
              <span className="t">{title}</span>
            </span>
          </h1>
          {paragraphs ? (
            <div className="sub many" id="sub">
              {paragraphs.map((line) => (
                <p key={line}>{linked(line, subtitleLinks)}</p>
              ))}
            </div>
          ) : subtitle ? (
            <p className="sub" id="sub" role={liveSubtitle ? "status" : undefined}>
              {subtitle}
            </p>
          ) : null}
          <div className="rest">{children}</div>
        </div>
      </main>
      {onAgain ? (
        <button type="button" className={`startagain${low}`} style={style} aria-label="Start again" onClick={onAgain}>
          <AgainArrow />
        </button>
      ) : onBack ? (
        <button type="button" className={`backarrow${low}`} style={style} aria-label="Go back" onClick={onBack}>
          <LeftArrow />
        </button>
      ) : null}
      {signOut ? (
        <button
          type="button"
          className={`signout${low}`}
          style={style}
          disabled={leaving}
          onClick={() => {
            setLeaving(true);
            void leave();
          }}
        >
          Sign out
        </button>
      ) : null}
      {/* The bottom centre of every screen (decision D-86), in line with the two corners and placed by the same rule. */}
      <Powered low={low !== ""} style={style} />
    </>
  );
}

/**
 * One paragraph of a subtitle, with the words of each link of `links` shown
 * as a link when the paragraph holds them (decisions D-82 and D-90). The
 * words stay where they are in the sentence, so what a screen reader reads is
 * unchanged. A paragraph may hold several: the welcome text holds two.
 */
function linked(line: string, links: readonly { text: string; href: string }[]): ReactNode {
  // The links in the order they stand in this paragraph, so the text is cut once, from left to right.
  const found = links
    .map((link) => ({ link, at: line.indexOf(link.text) }))
    .filter((f) => f.at >= 0)
    .sort((a, b) => a.at - b.at);
  if (found.length === 0) return line;
  const parts: ReactNode[] = [];
  let from = 0;
  for (const { link, at } of found) {
    if (at < from) continue;
    if (at > from) parts.push(line.slice(from, at));
    parts.push(
      <a key={link.href} href={link.href} target="_blank" rel="noopener noreferrer">
        {link.text}
        <span className="sr"> (opens in a new tab)</span>
      </a>
    );
    from = at + link.text.length;
  }
  if (from < line.length) parts.push(line.slice(from));
  return <>{parts}</>;
}

/** A page that does not know yet what to show. Empty at first; a quiet mark if the answer is slow. */
export function Waiting({ label }: { label: string }) {
  return (
    <>
      <TopLinks />
      <main>
        <p className="waiting" role="status">
          <span className="spin" aria-hidden="true" />
          <span className="sr">{label}</span>
        </p>
      </main>
      {/* Every screen, this one included (decision D-86). It holds nothing, so nothing can be in the way. */}
      <Powered />
    </>
  );
}
