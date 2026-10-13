"use client";

import { useEffect, useState } from "react";
import { ApiRequestError, getMe, toApiError } from "./api";
import type { Me } from "./contract";

export type SessionState =
  | { kind: "loading" }
  | { kind: "signed-out" }
  | { kind: "signed-in"; me: Me }
  | { kind: "error"; error: ApiRequestError };

/** Asks GET /api/me who is signed in. `again` asks once more, after an error. */
export function useSession(): { session: SessionState; again: () => void } {
  const [session, setSession] = useState<SessionState>({ kind: "loading" });
  const [turn, setTurn] = useState(0);
  useEffect(() => {
    let cancelled = false;
    getMe()
      .then((me) => !cancelled && setSession({ kind: "signed-in", me }))
      .catch((e: unknown) => {
        if (cancelled) return;
        const error = toApiError(e);
        setSession(error.status === 401 ? { kind: "signed-out" } : { kind: "error", error });
      });
    return () => {
      cancelled = true;
    };
  }, [turn]);
  return {
    session,
    again: () => {
      setSession({ kind: "loading" });
      setTurn((t) => t + 1);
    },
  };
}
