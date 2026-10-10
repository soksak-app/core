// The place where two texts first differ and its surroundings. When long requests differ, the failure message states
// the difference (F40).

const AROUND = 40;

/**
 * null when a and b are equal; otherwise the number of the first differing character and AROUND characters before and
 * after it.
 */
export function textDifference(a, b) {
  if (a === b) return null;
  let index = 0;
  while (index < a.length && index < b.length && a[index] === b[index]) index++;
  const start = Math.max(0, index - AROUND);
  const part = (text) => `…${text.slice(start, index + AROUND)}`;
  return `first difference at character ${index}: ${part(a)} instead of ${part(b)}`;
}
