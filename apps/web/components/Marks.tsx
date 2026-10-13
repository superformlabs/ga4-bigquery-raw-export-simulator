// The small drawings of the app. Each is decoration: the words next to it say the same.

export const OkMark = () => (
  <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true">
    <path d="M4 10.6l4 4 8-8.8" fill="none" stroke="#1e7e45" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const BadMark = () => (
  <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true">
    <path d="M5 5l10 10M15 5L5 15" fill="none" stroke="#b3261e" strokeWidth="2.6" strokeLinecap="round" />
  </svg>
);

export const SkipMark = () => (
  <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true">
    <path d="M5 10h10" stroke="#a3aab4" strokeWidth="2.6" strokeLinecap="round" />
  </svg>
);

export const WaitMark = () => <span className="spin" aria-hidden="true" />;

export const LeftArrow = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M19 12H5M11 5l-7 7 7 7" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** A circular arrow that turns back on itself: start again. */
export const AgainArrow = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M3.5 12a8.500 8.500 0 1 0 2.600-6.100L3.500 8.500M3.500 3.500v5h5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);


/**
 * An open book: the "Documentation" link in the top-right corner (decisions
 * D-77 and D-87).
 * Drawn in the colour of the words beside it.
 */
export const BookMark = () => (
  <svg width="17" height="17" viewBox="0 0 24 24" aria-hidden="true">
    <path
      d="M12 7v12.5M12 7C12 7 10 5 6.25 5H3v12h3.25C10 17 12 19.5 12 19.5M12 7c0 0 2-2 5.75-2H21v12h-3.25C14 17 12 19.5 12 19.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

/**
 * A beetle: the "Report a bug" link in the top-right corner (decision D-77).
 * A body, two antennae and six legs, in the colour of the words beside it.
 */
export const BugMark = () => (
  <svg width="17" height="17" viewBox="0 0 24 24" aria-hidden="true">
    <g fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 8.5a4.5 4.5 0 0 1 4.5 4.5v1.5a4.5 4.5 0 0 1-9 0V13A4.5 4.5 0 0 1 12 8.5z" />
      <path d="M9.5 4.5 11 7.5M14.5 4.5 13 7.5" />
      <path d="M7.5 11 4 9.5M7.5 14H4M7.5 17 4.5 19M16.5 11 20 9.5M16.5 14H20M16.5 17 19.5 19" />
    </g>
  </svg>
);

/**
 * A lightning flash: the words "powered by GA4Dataform" at the bottom centre
 * of every screen (decision D-86). Yellow since decision D-90, where the book
 * and the beetle of decision D-77 stay in the colour of the words beside
 * them. The words of the footer stay grey.
 *
 * It is filled as well as drawn, in the same yellow: at 15 px a line of
 * 1.7 px in this yellow is too faint to read as a flash on white. #eab308 is
 * a yellow that still stands out against white; nothing depends on seeing it,
 * because the words beside it say the same and the flash is decoration
 * (`aria-hidden`).
 */
export const BoltMark = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M13.5 2.5 5 13.5h5l-1.5 8 8.5-11h-5l1.5-8z" fill="#eab308" stroke="#eab308" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const Chevron = () => (
  <svg className="chevron" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
    <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** The Google "G", in its standard colours. */
export const GoogleMark = () => (
  <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
    <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.9 6.2C12.4 13.6 17.7 9.5 24 9.5z" />
    <path fill="#4285F4" d="M46.1 24.6c0-1.6-.1-3.1-.4-4.6H24v9.1h12.4c-.5 2.9-2.2 5.3-4.6 7l7.2 5.6c4.2-3.9 7.1-9.700 7.1-17.1z" />
    <path fill="#FBBC05" d="M10.500 28.6c-.5-1.500-.8-3-.8-4.600s.3-3.100.8-4.600l-7.900-6.200C.9 16.500 0 20.100 0 24s.9 7.500 2.600 10.800l7.900-6.200z" />
    <path fill="#34A853" d="M24 48c6.300 0 11.700-2.100 15.600-5.700l-7.200-5.600c-2.100 1.400-4.900 2.300-8.400 2.300-6.300 0-11.600-4.100-13.500-9.900l-7.900 6.200C6.500 42.600 14.600 48 24 48z" />
  </svg>
);
