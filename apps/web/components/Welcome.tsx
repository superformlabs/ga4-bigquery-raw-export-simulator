"use client";

import { useEffect, useRef } from "react";
import { loginUrl } from "@/lib/auth";
import { DOCS_PATH, SOURCE_CODE_URL } from "@/lib/links";
import { SUBTITLES, SUPPORT_EMAIL, WELCOME_DOCS_LINK, WELCOME_SOURCE_LINK, WELCOME_TITLE } from "@/lib/wording";
import Fix from "./Fix";
import { GoogleMark } from "./Marks";
import Screen from "./Screen";

// What the backend sends back as /?error=<CODE> after a sign-in that did not complete.
const SIGN_IN_ADVICE: Record<string, [string, string]> = {
  ACCESS_DENIED: ["The sign-in did not complete", "You closed Google's page or declined the permission. Sign in again and click Allow"],
  PERMISSION_DENIED: ["The sign-in did not complete", "You closed Google's page or declined the permission. Sign in again and click Allow"],
  INVALID_ARGUMENT: ["The sign-in did not complete", "Google sent back something unexpected. Start again from this page"],
  UPSTREAM_ERROR: ["The sign-in did not complete", "Google answered with an error. Wait a moment, then sign in again"],
  // The sign-in allowlist (decision D-16).
  ACCOUNT_NOT_ALLOWED: [
    "This Google account cannot use this site",
    // The backend sends the code and no text: these words are the app's own, and name the address (decision D-35).
    `The site is open to certain accounts only. Sign in again with an account that is allowed, or ask for access at ${SUPPORT_EMAIL}`,
  ],
};

type Props = {
  /** Where the backend sends the visitor after the sign-in. Defaults to the first page. */
  returnTo?: string;
  /** The code of a sign-in that did not complete. */
  errorCode?: string | null;
  /** One line for a visitor whose sign-in has ended. */
  ended?: string | null;
};

/** The first page. The button is a plain link: the backend does the sign-in with Google. */
export default function Welcome({ returnTo, errorCode = null, ended = null }: Props) {
  const button = useRef<HTMLAnchorElement>(null);
  useEffect(() => button.current?.focus({ preventScroll: true }), []);
  const advice = errorCode ? (SIGN_IN_ADVICE[errorCode] ?? ["The sign-in did not complete", `Sign in again. If it keeps failing, please report it to ${SUPPORT_EMAIL}, with this code: ${errorCode}`]) : null;

  return (
    // The title is one short line since decision D-90, read from the left, its left edge on the left edge
    // of the text under it. Two sets of words of the welcome text are links, both opened in a new tab:
    // "read the documentation" goes to the documentation site at /docs (decisions D-82 and D-87), and
    // "open source code" to the public repository (decision D-90).
    <Screen
      title={WELCOME_TITLE}
      titleLeft
      subtitle={SUBTITLES.welcome}
      subtitleLinks={[
        { text: WELCOME_DOCS_LINK, href: DOCS_PATH },
        { text: WELCOME_SOURCE_LINK, href: SOURCE_CODE_URL },
      ]}
    >
      <a className="google" href={loginUrl(returnTo)} ref={button}>
        <GoogleMark />
        Sign in with Google
      </a>
      {advice ? (
        <div className="advice" role="alert">
          <Fix text={advice[0]} advice={advice[1]} />
        </div>
      ) : null}
      {ended && !advice ? (
        <p className="advice" role="status">
          {ended}
        </p>
      ) : null}
    </Screen>
  );
}
