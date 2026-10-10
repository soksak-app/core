// The steps and the scope of the text size. docs/spec/text-size.md
//
// The scope is the place the user pressed last. Pressing a card makes it that card, and pressing the frame outside the plane makes it the
// frame. It is null if nothing was pressed yet, and then the focused card is the scope.

/** The steps of the text size scale. */
export const TEXT_STEPS = Object.freeze([0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3]);

/**
 * The scale moved from value in direction. 1 is the next larger step, -1 is the next smaller step, and 0 is 1.
 * Moving further from an end step leaves the value unchanged. A value that is not a step and any other direction are errors.
 */
export function nextTextSize(value, direction) {
  if (direction !== 1 && direction !== -1 && direction !== 0) {
    throw new Error(`text size direction ${direction} is invalid`);
  }
  const index = TEXT_STEPS.indexOf(value);
  if (index < 0) throw new Error(`text size ${value} is not a step`);
  if (direction === 0) return 1;
  return TEXT_STEPS[Math.min(TEXT_STEPS.length - 1, Math.max(0, index + direction))];
}

let scope = null;
const listeners = new Set();
const sizeListeners = new Set();

let resolveSurface = null;

/** Sets the function that computes the actual scale of a surface. The plane sets it. */
export function setSurfaceTextSize(fn) {
  resolveSurface = fn;
}

/** The actual scale of a surface. It is null for a surface that is not in the plane. It is an error before the computing function is set. */
export function surfaceTextSize(surfaceId) {
  if (!resolveSurface) throw new Error("the surface text size is not available before the plane starts");
  return resolveSurface(surfaceId);
}

/** Tells that the scale may have changed. A surface reads its actual scale again. */
export function notifyTextSize() {
  for (const fn of sizeListeners) fn();
}

/** Registers a function to call when the scale may have changed. It returns the function that ends the registration. */
export function onTextSize(fn) {
  sizeListeners.add(fn);
  return () => sizeListeners.delete(fn);
}

/** The current scope. It is {kind: "card", card} or {kind: "frame"}, and null before any press. */
export const textScope = () => scope;

/**
 * The scope in which the text size changes. It is the place pressed if there is one, and otherwise the focused card. A window without a focused card (the library before
 * a space opens) uses frame (docs/spec/text-size.md#scope).
 */
export function effectiveTextScope(pressed, focused) {
  if (pressed) return pressed;
  return typeof focused === "string" && focused ? { kind: "card", card: focused } : { kind: "frame" };
}

/** Changes the scope and notifies. */
export function setTextScope(next) {
  if (next?.kind === "card") {
    if (typeof next.card !== "string" || !next.card) throw new Error("a card text scope requires a card");
    scope = { kind: "card", card: next.card };
  } else if (next?.kind === "frame") {
    scope = { kind: "frame" };
  } else {
    throw new Error(`text scope ${JSON.stringify(next)} is invalid`);
  }
  for (const fn of listeners) fn(scope);
}

/** Registers a function to call when the scope changes. It returns the function that ends the registration. */
export function onTextScope(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
