"use client";

import { useEffect, useState } from "react";
import { DATASET_ID_RE, PROJECT_ID_RE } from "@/lib/flow";
import { DOCS_PATH } from "@/lib/links";
import { BUG_REPORT_URL, bugReportHref } from "@/lib/wording";
import { BookMark, BugMark } from "./Marks";

/** Where the visitor is: the address of the page, and the project and the dataset when the address names them. */
type Place = { page: string; projectId: string | null; datasetId: string | null };

const NOWHERE: Place = { page: "", projectId: null, datasetId: null };

/** A value of the address, only when it is one a project ID or a dataset name can be. Nothing else is repeated. */
const checked = (value: string | null, re: RegExp) => (value && re.test(value) ? value : null);

/**
 * The two quiet links in the top-right corner of every screen (decision
 * D-77): a book with the words "Documentation", which opens the
 * documentation site in a new tab (decision D-87), and a beetle with the
 * words "Report a bug". The book said "Read more" until the owner renamed it
 * on 2026-10-12, when the documentation became a site of its own.
 *
 * "Report a bug" opens `BUG_REPORT_URL` when that setting is set, and an email
 * to the support address while it is empty (`bugReportHref` in
 * `lib/wording.ts`). The email names the page the visitor is on, and the
 * project and the dataset when the app knows them.
 */
export default function TopLinks() {
  // Read after every drawing of the links, and not once: the app rewrites its own address as the visitor
  // answers and as the install takes its names (`history.replaceState`), and the email names the page.
  const [place, setPlace] = useState<Place>(NOWHERE);
  useEffect(() => {
    if (BUG_REPORT_URL) return;
    const page = window.location.href;
    if (page === place.page) return;
    const q = new URLSearchParams(window.location.search);
    setPlace({ page, projectId: checked(q.get("projectId"), PROJECT_ID_RE), datasetId: checked(q.get("datasetId"), DATASET_ID_RE) });
  });

  return (
    <nav className="toplinks" aria-label="Help">
      <a href={DOCS_PATH} target="_blank" rel="noopener">
        <BookMark />
        Documentation<span className="sr"> (opens in a new tab)</span>
      </a>
      <a href={bugReportHref(place)}>
        <BugMark />
        Report a bug
      </a>
    </nav>
  );
}
