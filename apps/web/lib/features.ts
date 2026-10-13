// What the app holds and does not show for now. One constant per feature, so
// that a feature comes back by switching it, and not by writing it again.

/**
 * The uninstall (decision D-30, api.md v1.13). Off: the last page shows no
 * word at the bottom, no question can open, and the page that says what an
 * uninstall did cannot be reached. `components/Uninstall.tsx` and the page
 * `Uninstalled` of `components/Install.tsx` stay in the repository. The
 * backend and the mock have a setting of their own, `UNINSTALL_ENABLED`.
 */
export const UNINSTALL: boolean = false;
