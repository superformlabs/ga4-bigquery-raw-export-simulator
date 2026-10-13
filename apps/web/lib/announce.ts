// The title of the screen, said to screen readers when the screen changes.
// The cursor goes to the first field of each screen, so without this a
// screen reader would name the field and never the question.

let current = "";
const listeners = new Set<() => void>();

export function announce(title: string): void {
  if (title === current) return;
  current = title;
  listeners.forEach((l) => l());
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export const announced = () => current;
