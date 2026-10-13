"use client";

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { Project } from "@/lib/contract";
import { PROJECT_ID_RE } from "@/lib/flow";
import { Chevron } from "./Marks";

type Props = {
  /** The id of the field, for the label the screen gives it. */
  id: string;
  /** Null while the list is being read. */
  projects: Project[] | null;
  /** The project chosen, or null. */
  chosen: Project | null;
  onChoose: (project: Project) => void;
  /** Puts the cursor in the field when the screen opens. */
  focus?: boolean;
  describedBy?: string;
};

type Option = { project: Project; typed: boolean };

// A visitor with hundreds of projects narrows the list by typing; the page never draws more than this.
const MOST_SHOWN = 100;

/**
 * The list of projects: a field that can be typed into (Phase 5, item 9).
 *
 * Only a click or the Enter key makes the choice. Moving through the list
 * with the arrow keys chooses nothing, because on two screens the choice
 * moves on, and in Automated it starts the install.
 *
 * A project that is not in the list can be named by its ID.
 */
export default function ProjectPicker({ id, projects, chosen, onChoose, focus = false, describedBy }: Props) {
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();
  const loading = projects === null;

  useEffect(() => {
    if (focus && !loading) input.current?.focus({ preventScroll: true });
  }, [focus, loading]);

  const { options, more } = useMemo(() => {
    const all = projects ?? [];
    const q = text.trim().toLowerCase();
    const found = q ? all.filter((p) => p.displayName.toLowerCase().includes(q) || p.projectId.toLowerCase().includes(q)) : all;
    const list: Option[] = found.slice(0, MOST_SHOWN).map((project) => ({ project, typed: false }));
    const typed = text.trim();
    if (PROJECT_ID_RE.test(typed) && !all.some((p) => p.projectId === typed)) {
      list.push({ project: { projectId: typed, displayName: typed }, typed: true });
    }
    return { options: list, more: found.length - Math.min(found.length, MOST_SHOWN) };
  }, [projects, text]);

  const optionId = (i: number) => `${listId}-${i}`;

  useEffect(() => {
    if (open) document.getElementById(optionId(active))?.scrollIntoView({ block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, active]);

  function close() {
    setOpen(false);
    setText("");
    setActive(0);
  }

  function choose(option: Option) {
    close();
    onChoose(option.project);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) {
        setOpen(true);
        setActive(0);
        return;
      }
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActive((a) => Math.max(0, Math.min(options.length - 1, a + step)));
    } else if (e.key === "Enter") {
      if (!open) return;
      // The key chooses in the list; it must not also stand for the sentence of the page.
      e.preventDefault();
      if (options[active]) choose(options[active]);
    } else if (e.key === "Escape") {
      if (!open) return;
      e.preventDefault();
      close();
    }
  }

  const shown = open ? text : (chosen?.displayName ?? "");
  const typedSomething = text.trim() !== "";

  return (
    <div className="picker">
      <input
        id={id}
        ref={input}
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && options[active] ? optionId(active) : undefined}
        aria-describedby={describedBy}
        autoComplete="off"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        disabled={loading}
        placeholder={loading ? "Loading your projects…" : "Select a project"}
        value={shown}
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
          setActive(0);
        }}
        onClick={() => (open ? close() : setOpen(true))}
        onKeyDown={onKeyDown}
        onBlur={close}
      />
      <Chevron />
      {open ? (
        <ul id={listId} role="listbox" aria-label="Projects">
          {options.map((o, i) => (
            <li
              key={`${o.typed ? "typed" : "listed"}-${o.project.projectId}`}
              id={optionId(i)}
              role="option"
              aria-selected={i === active}
              // Keeps the cursor in the field, so that the click is not lost to the field closing.
              onMouseDown={(e) => e.preventDefault()}
              onMouseMove={() => setActive(i)}
              onClick={() => choose(o)}
            >
              {o.typed ? (
                <>Use the project ID {o.project.projectId}</>
              ) : (
                <>
                  {o.project.displayName}
                  {o.project.displayName !== o.project.projectId ? <span className="id">{o.project.projectId}</span> : null}
                </>
              )}
            </li>
          ))}
          {more > 0 ? (
            <li className="none" role="presentation">
              {more} more. Type a few letters to narrow the list.
            </li>
          ) : null}
          {options.length === 0 ? (
            <li className="none" role="presentation">
              {typedSomething
                ? "No project with that name. To use a project that is not listed, type its ID."
                : "No project found for this account. Type the ID of your project."}
            </li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}
