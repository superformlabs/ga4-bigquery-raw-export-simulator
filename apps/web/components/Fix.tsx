"use client";

import { useState, type ReactNode } from "react";
import { consoleLabel, consoleUrl } from "@/lib/wording";
import Mailed from "./Mailed";

type Props = {
  /** What is wrong, in one sentence. */
  text: string;
  /** What to do about it. */
  advice?: string;
  /** Names of missing permissions, shown in a block that can be copied. */
  missing?: string[];
  /** A page of the Google Cloud console where the problem can be fixed. */
  link?: string;
  children?: ReactNode;
};

const sentence = (s: string) => (/[.!?]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`);

/**
 * What a failed check or a failed step has to say: what is wrong, one line of
 * advice, the missing permissions ready to paste into a message, and the
 * console page to open. The words come from the backend.
 */
export default function Fix({ text, advice, missing, link, children }: Props) {
  const [copied, setCopied] = useState<"no" | "yes" | "failed">("no");
  const names = missing ?? [];
  const href = consoleUrl(link);

  async function copy() {
    try {
      await navigator.clipboard.writeText(names.join("\n"));
      setCopied("yes");
    } catch {
      setCopied("failed");
    }
  }

  return (
    <div className="fix">
      <strong>
        <Mailed text={sentence(text)} />
      </strong>{" "}
      {advice ? <Mailed text={sentence(advice)} /> : null}
      {names.length > 0 ? (
        <>
          <code>{names.join("\n")}</code>
          <button type="button" className="plain" onClick={copy}>
            {copied === "yes" ? "Copied" : "Copy the list"}
          </button>
          <span role="status" className={copied === "failed" ? undefined : "sr"}>
            {copied === "yes" ? "Copied." : ""}
            {copied === "failed" ? " Copying did not work. Select the list and copy it by hand." : ""}
          </span>
          <span className="gap" />
        </>
      ) : null}
      {href ? (
        <>
          {names.length === 0 ? " " : null}
          <a href={href} target="_blank" rel="noreferrer">
            {consoleLabel(href)}
            <span className="sr"> (opens in a new tab)</span>
          </a>
        </>
      ) : null}
      {children}
    </div>
  );
}
