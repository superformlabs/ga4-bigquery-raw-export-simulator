"use client";

import { useLayoutEffect, useRef, useState } from "react";

/**
 * The size the lines are first measured at. Any size would do: the width of a
 * line of text grows with its size, so one measurement gives the size that
 * fills the column. A large one keeps the rounding of the browser small.
 */
const MEASURE_PX = 200;

/** The size and the letter spacing of each line, in pixels. Null until the browser has been asked. */
type Fit = { size: number; spacing: readonly number[] };

/** Below this the two fits are the same drawing, so React is not asked to draw again. */
const SAME_PX = 0.05;

const same = (a: Fit, b: Fit) => Math.abs(a.size - b.size) < SAME_PX && a.spacing.every((s, i) => Math.abs(s - b.spacing[i]) < SAME_PX);

/**
 * The width the words of one line take in pixels, drawn at `px` and with no
 * letter spacing of their own: the sum of the widths of its letters, which is
 * where a justified line puts its right edge.
 *
 * The line is measured as it will be drawn, and put back as it was: what is
 * shown comes from the state below, never from this.
 */
function naturalWidth(line: HTMLElement, px: number): number {
  const ink = line.firstElementChild;
  if (!(ink instanceof HTMLElement)) return 0;
  const was = { size: line.style.fontSize, spacing: ink.style.letterSpacing, margin: ink.style.marginRight };
  line.style.fontSize = `${px}px`;
  ink.style.letterSpacing = "normal";
  ink.style.marginRight = "0px";
  const width = ink.getBoundingClientRect().width;
  line.style.fontSize = was.size;
  ink.style.letterSpacing = was.spacing;
  ink.style.marginRight = was.margin;
  return width;
}

/**
 * A title on fixed lines, all drawn at one font size, with both edges
 * straight (decision D-93).
 *
 * The size is the one that makes the longest line fill exactly the width of
 * its column, so the left edge of the title is the left edge of the text
 * under it. Every shorter line is then spread with wider letter spacing until
 * it reaches the right edge of the column as well, so the right edge is
 * straight too, as it is in the justified paragraphs below. No line is given a
 * size of its own: decision D-83 refused two sizes, and decision D-93 asks
 * for both edges with the one size.
 *
 * `letter-spacing` adds its space after every letter, the last one included,
 * so a line of `n` letters gains the spacing `n` times while its right edge
 * only moves `n - 1` times. The spacing is therefore the room to fill divided
 * by `n - 1`, and the space added after the last letter is taken back with a
 * negative right margin, so the drawing stops at the edge of the column and
 * nothing overflows it.
 *
 * Nothing is guessed. No font file is loaded, so the words are drawn in the
 * visitor's own font and nobody can know in advance how wide they are. Each
 * line is laid out at `MEASURE_PX`, its natural width is read, and the size
 * that would make it fill the column follows; the smallest of those sizes is
 * the one every line takes. Each line is then measured again at that size, so
 * the spacing is worked out from the width the browser really draws and not
 * from a width scaled by hand. Measured again whenever the column changes
 * width, so a phone keeps the same lines, smaller, with both edges still
 * straight.
 *
 * The measurement happens before the browser paints (`useLayoutEffect`), so
 * no line is ever shown at the wrong size.
 */
export default function FitTitle({ lines }: { lines: readonly string[] }) {
  const column = useRef<HTMLSpanElement>(null);
  const [fit, setFit] = useState<Fit | null>(null);

  useLayoutEffect(() => {
    const box = column.current;
    if (!box) return;
    const measure = () => {
      const width = box.clientWidth;
      const drawn = Array.from(box.querySelectorAll<HTMLElement>(".line"));
      if (width <= 0 || drawn.length === 0) return;
      // One size for every line: the one of the longest line, which is the smallest of the sizes that fill the column.
      const size = Math.min(...drawn.map((line) => (MEASURE_PX * width) / (naturalWidth(line, MEASURE_PX) || MEASURE_PX)));
      // The room each line has left at that size, shared between the gaps after its letters, the last one apart.
      const spacing = drawn.map((line, i) => {
        const gaps = (lines[i]?.length ?? 1) - 1;
        return gaps > 0 ? (width - naturalWidth(line, size)) / gaps : 0;
      });
      const next: Fit = { size, spacing };
      setFit((before) => (before && same(before, next) ? before : next));
    };
    measure();
    const watcher = new ResizeObserver(measure);
    watcher.observe(box);
    return () => watcher.disconnect();
  }, [lines]);

  return (
    <span className="lines" ref={column}>
      {lines.map((line, i) => (
        <span key={line} className="line" style={fit ? { fontSize: `${fit.size}px` } : undefined}>
          <span className="ink" style={fit ? { letterSpacing: `${fit.spacing[i]}px`, marginRight: `${-fit.spacing[i]}px` } : undefined}>
            {line}
          </span>
        </span>
      ))}
    </span>
  );
}
