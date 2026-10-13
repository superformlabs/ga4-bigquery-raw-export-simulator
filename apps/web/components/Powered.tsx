import type { CSSProperties } from "react";
import { BoltMark } from "./Marks";

/** Where the words lead (decision D-86), in the owner's own answer: "https://ga4dataform.com/". */
export const GA4DATAFORM_URL = "https://ga4dataform.com/";

type Props = {
  /**
   * True on a page that is higher than the screen and reaches the bottom of
   * it: the words leave the screen for the page, with the two corners, so
   * that they never lie on the content (`useBottomPlace` in `Screen.tsx`).
   */
  low?: boolean;
  /** Where the words sit when they belong to the page. */
  style?: CSSProperties;
};

/**
 * "powered by GA4Dataform", small and grey, at the bottom centre of every
 * screen (decision D-86). A yellow lightning flash (decision D-90,
 * `BoltMark`), then the words, which stay grey. It opens
 * `https://ga4dataform.com/` in a new tab, so a visitor in the middle of an
 * install never loses their place.
 *
 * Only this footer has the flash: the footer of the documentation site has no
 * icon and is not touched.
 */
export default function Powered({ low = false, style }: Props) {
  return (
    <footer className={`powered${low ? " low" : ""}`} style={style}>
      <a href={GA4DATAFORM_URL} target="_blank" rel="noopener noreferrer">
        <BoltMark />
        powered by GA4Dataform<span className="sr"> (opens in a new tab)</span>
      </a>
    </footer>
  );
}
