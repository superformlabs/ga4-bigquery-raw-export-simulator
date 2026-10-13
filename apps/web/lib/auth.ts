// Builds the sign-in link. The backend does the OAuth dance; the browser only
// navigates to /auth/login. `returnTo` (docs/contracts/api.md v1.2) tells the
// backend where to send the visitor afterwards, so signing in from the
// progress page comes back to the same install.

/** A same-origin path the backend accepts as `returnTo`: starts with "/" but not "//". Anything else becomes "/". */
export function safeReturnTo(path: string | null | undefined): string {
  if (!path || !path.startsWith("/") || path.startsWith("//")) return "/";
  return path;
}

/** The href for a "Sign in with Google" link that comes back to `returnTo` (a path, with query string if any). */
export function loginUrl(returnTo?: string | null): string {
  const target = safeReturnTo(returnTo);
  if (target === "/") return "/auth/login";
  return `/auth/login?returnTo=${encodeURIComponent(target)}`;
}
