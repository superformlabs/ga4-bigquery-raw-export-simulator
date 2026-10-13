"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ApiRequestError, getInstallStatus, toApiError, uninstall } from "@/lib/api";
import { loginUrl } from "@/lib/auth";
import type { InstallStatus } from "@/lib/contract";
import { plural } from "@/lib/wording";
import Fix from "./Fix";
import Forward, { ForwardLink } from "./Forward";

/** `installId` names the install to remove (api.md v2.0). Absent for an install made before v2.0. */
export type UninstallTarget = { projectId: string; region: string; datasetId: string; installId?: string };

/** What an uninstall did, handed to the page that shows the result. */
export type UninstallDone = {
  target: UninstallTarget;
  /** The visitor ticked "also delete the dataset". */
  deleteRequested: boolean;
  /** From the backend: the dataset is gone because the visitor asked for it. */
  datasetDeleted: boolean;
  /** The project as it is after the uninstall, or null when that check failed. */
  status: InstallStatus | null;
  /** The installs the project still holds in other regions (api.md v1.9). Empty in the normal case. */
  remaining: { region: string; datasetId: string }[];
};

type Props = {
  target: UninstallTarget;
  /** How many tables the dataset holds, when the page knows it. Only used in the wording. */
  tableCount?: number | null;
  /** This page's address, so "Sign in again" comes back here. */
  returnTo: string;
  /** The words that open the question, and how they look: small and grey, or the sentence of the page. */
  label?: string;
  look?: "quiet" | "sentence";
  onDone: (done: UninstallDone) => void;
};

type Stage =
  | { kind: "confirm" }
  // Second confirmation, only when the dataset is to be deleted: that cannot be undone.
  | { kind: "confirm-delete" }
  | { kind: "running" }
  | { kind: "error"; error: ApiRequestError };

/**
 * Uninstall (decision D-17, Phase 5 item 8): the word that opens the
 * question, and the question. It says what is removed and what stays, asks a
 * second time before deleting the dataset, shows that the uninstall is
 * running, and shows an error with what to do next. On success it closes and
 * hands the result to the page.
 */
export default function Uninstall({ target, tableCount = null, returnTo, label = "Uninstall", look = "quiet", onDone }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [stage, setStage] = useState<Stage>({ kind: "confirm" });
  const [deleteDataset, setDeleteDataset] = useState(false);
  const mounted = useRef(true);
  // The question is attached to the page body, so it is not part of the screen that fades in.
  const [body, setBody] = useState<HTMLElement | null>(null);
  const titleId = useId();
  const helpId = useId();

  useEffect(() => {
    mounted.current = true;
    setBody(document.body);
    return () => {
      mounted.current = false;
    };
  }, []);

  // Each stage starts at its heading, so keyboard and screen reader users
  // hear what changed and nobody lands on a destructive word by accident.
  useEffect(() => {
    if (dialogRef.current?.open) headingRef.current?.focus();
  }, [stage.kind]);

  function open() {
    setStage({ kind: "confirm" });
    setDeleteDataset(false);
    dialogRef.current?.showModal();
    headingRef.current?.focus();
  }

  function close() {
    dialogRef.current?.close();
  }

  async function start() {
    setStage({ kind: "running" });
    try {
      const res = await uninstall({ ...target, deleteDataset });
      // Ask the project what is left, so the result shows facts and not only the answer to the request.
      let status: InstallStatus | null = null;
      try {
        status = await getInstallStatus(target);
      } catch {
        status = null;
      }
      if (!mounted.current) return;
      close();
      onDone({
        target,
        deleteRequested: deleteDataset,
        datasetDeleted: res.datasetDeleted,
        status,
        remaining: Array.isArray(res.remainingInstalls) ? res.remainingInstalls : [],
      });
    } catch (e) {
      if (!mounted.current) return;
      setStage({ kind: "error", error: toApiError(e) });
    }
  }

  const tables = tableCount && tableCount > 0 ? `its ${plural(tableCount, "table", "tables")}` : "its tables";

  const dialog = (
    <dialog
      ref={dialogRef}
      className="ask"
      aria-labelledby={titleId}
      // Escape closes the question, except while the uninstall is running.
      onCancel={(e) => {
        if (stage.kind === "running") e.preventDefault();
      }}
    >
      {stage.kind === "confirm" ? (
        <>
          <h2 id={titleId} ref={headingRef} tabIndex={-1}>
            Uninstall from {target.projectId}?
          </h2>
          <p>This removes the daily schedule, the daily job and the service account from your project.</p>
          <p>
            The dataset {target.datasetId} and {tables} stay, unless you tick the box.
          </p>
          <label className="tick">
            <input
              type="checkbox"
              checked={deleteDataset}
              onChange={(e) => setDeleteDataset(e.target.checked)}
              aria-describedby={helpId}
            />
            <span>Also delete the dataset and all its tables</span>
          </label>
          <p className="small" id={helpId}>
            Deleting cannot be undone.
          </p>
          <Forward show enter={false} onGo={() => (deleteDataset ? setStage({ kind: "confirm-delete" }) : void start())}>
            {deleteDataset ? "Continue" : "Uninstall"}
          </Forward>
          <button type="button" className="quiet" onClick={close}>
            Cancel
          </button>
        </>
      ) : null}

      {stage.kind === "confirm-delete" ? (
        <>
          <h2 id={titleId} ref={headingRef} tabIndex={-1}>
            Delete the dataset too?
          </h2>
          <p className="warning">
            The dataset {target.datasetId} in {target.projectId} and {tables} will be deleted.
          </p>
          <p>This cannot be undone. Anything else you saved in that dataset is deleted with it.</p>
          <Forward show danger enter={false} onGo={() => void start()}>
            Yes, uninstall and delete the dataset
          </Forward>
          <button type="button" className="quiet" onClick={() => setStage({ kind: "confirm" })}>
            Go back
          </button>
        </>
      ) : null}

      {stage.kind === "running" ? (
        <div aria-live="polite">
          <h2 id={titleId} ref={headingRef} tabIndex={-1}>
            Uninstalling
          </h2>
          <p>
            Removing the daily schedule, the daily job and the service account
            {deleteDataset ? `, and deleting the dataset ${target.datasetId}` : ""}.
          </p>
          <p>
            <span className="spin" aria-hidden="true" />
          </p>
          <p className="small">Keep this page open until it finishes.</p>
        </div>
      ) : null}

      {stage.kind === "error" ? (
        <>
          <h2 id={titleId} ref={headingRef} tabIndex={-1}>
            The uninstall did not finish
          </h2>
          <div role="alert">
            <Fix text={stage.error.message} advice={stage.error.hint} missing={stage.error.missing} link={stage.error.link} />
          </div>
          <p className="small">Uninstalling is safe to repeat: what is already removed is skipped.</p>
          <div className="forward">
            {stage.error.status === 401 ? (
              <ForwardLink href={loginUrl(returnTo)}>Sign in again</ForwardLink>
            ) : stage.error.code === "CONFLICT" ? (
              // Trying the same thing again cannot fix a 409. Going back lets the visitor change the choice.
              // The box is emptied: what was refused is not asked again by a click on the sentence, and
              // keeping the dataset is the safe state of a choice that cannot be undone (task UI-11).
              <button
                type="button"
                className="go show"
                onClick={() => {
                  setDeleteDataset(false);
                  setStage({ kind: "confirm" });
                }}
              >
                Go back
              </button>
            ) : (
              <button type="button" className="go show" onClick={() => void start()}>
                Try again
              </button>
            )}
          </div>
          <button type="button" className="quiet" onClick={close}>
            Close
          </button>
        </>
      ) : null}
    </dialog>
  );

  return (
    <>
      {look === "sentence" ? (
        <div className="forward">
          <button type="button" className="go show" onClick={open} disabled={!body}>
            {label}
          </button>
        </div>
      ) : (
        <div>
          <button type="button" className="quiet" onClick={open} disabled={!body}>
            {label}
          </button>
        </div>
      )}
      {body ? createPortal(dialog, body) : null}
    </>
  );
}
