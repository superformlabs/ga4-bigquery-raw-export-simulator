"use client";

import { useEffect, useState } from "react";
import { DATASET_ID_RE, PROJECT_ID_RE } from "@/lib/flow";
import { DOCS_PATH, SOURCE_CODE_URL } from "@/lib/links";
import { BUG_REPORT_URL, bugReportHref } from "@/lib/wording";
import { BookMark, BugMark, GitHubMark } from "./Marks";

/** Where the visitor is: the address of the page, and the project and the dataset when the address names them. */
type Place = { page: string; projectId: string | null; datasetId: string | null };

const NOWHERE: Place = { page: "", projectId: null, datasetId: null };

/** A value of the address, only when it is one a project ID or a dataset name can be. Nothing else is repeated. */
const checked = (value: string | null, re: RegExp) => (value && re.test(value) ? value : null);

/**
 * The three quiet links in the top-right corner of every screen, in this
 * order (decision D-89): a book with the words "Documentation", which opens
 * the documentation site in a new tab (decision D-87); GitHub's mark with the
 * words "Source code", which opens the public repository of the app in a new
 * tab (decision D-88); and a beetle with the words "Report a bug". The book
 * and the beetle are the two links of decision D-77; the book said "Read
 * more" until the owner renamed it on 2026-10-12, when the documentation
 * became a site of its own.
 *
 * "Source code" was built on 2026-10-13 by decision D-93, which asked for it
 * without waiting for the repository to be made public. Its address is
 * `SOURCE_CODE_URL`, written once in `lib/links.ts` and read from there.
 *
 * "Report a bug" opens the public bug form of decision D-88 when
 * `BUG_REPORT_URL` is set, in a new tab, and an email to the support address
 * while that setting is empty, in the same tab (`bugReportHref` in
 * `lib/wording.ts`). Both name the page the visitor is on; only the email
 * names the project and the dataset, because only we read it.
 */
export default function TopLinks() {
  // The form is the live link since 2026-10-13; the email is what stands in its place when the setting is empty.
  const form = Boolean(BUG_REPORT_URL);
  // Read after every drawing of the links, and not once: the app rewrites its own address as the visitor
  // answers and as the install takes its names (`history.replaceState`), and the link names the page.
  const [place, setPlace] = useState<Place>(NOWHERE);
  useEffect(() => {
    // The form is given the address without its query, because the app's own address carries `projectId`
    // and `datasetId` and a public issue is readable by everyone (`docs/contracts/bug-form.md`).
    const page = form ? window.location.origin + window.location.pathname : window.location.href;
    if (page === place.page) return;
    if (form) {
      setPlace({ page, projectId: null, datasetId: null });
      return;
    }
    const q = new URLSearchParams(window.location.search);
    setPlace({ page, projectId: checked(q.get("projectId"), PROJECT_ID_RE), datasetId: checked(q.get("datasetId"), DATASET_ID_RE) });
  });

  return (
    <nav className="toplinks" aria-label="Help">
      <a href={DOCS_PATH} target="_blank" rel="noopener">
        <BookMark />
        Documentation<span className="sr"> (opens in a new tab)</span>
      </a>
      <a href={SOURCE_CODE_URL} target="_blank" rel="noopener noreferrer">
        <GitHubMark />
        Source code<span className="sr"> (opens in a new tab)</span>
      </a>
      <a href={bugReportHref(place)} target={form ? "_blank" : undefined} rel={form ? "noopener noreferrer" : undefined}>
        <BugMark />
        Report a bug
        {form ? <span className="sr"> (opens in a new tab)</span> : null}
      </a>
    </nav>
  );
}
