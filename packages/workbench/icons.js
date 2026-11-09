// Icons.
//
// All are strokes on a 24 viewBox.

import declaration from "./workbench.json" with { type: "json" };

/** The icons of the card head, declared in workbench.json for both workbenches. */
export const declaredIcons = declaration.icons;

const PATHS = {
  "panel-left": declaredIcons["panel-left"],
  "panel-right": declaredIcons["panel-right"],
  "panel-top": declaredIcons["panel-top"],
  "panel-bottom": declaredIcons["panel-bottom"],
  star: '<path d="m12 3 2.8 5.7 6.3.9-4.6 4.4 1.1 6.3-5.6-3-5.6 3 1.1-6.3-4.6-4.4 6.3-.9Z"/>',
  projects: declaredIcons["projects"],
  "columns-3": declaredIcons["columns-3"],
  sun: declaredIcons["sun"],
  moon: declaredIcons["moon"],
  settings: declaredIcons["settings"],
  close: declaredIcons["close"],
  // They are chevron-down, chevron-up, chevron-left, chevron-right, and rotate-cw of Lucide.
  "chevron-down": '<path d="m6 9 6 6 6-6"/>',
  "chevron-up": '<path d="m18 15-6-6-6 6"/>',
  "chevron-left": '<path d="m15 18-6-6 6-6"/>',
  "chevron-right": '<path d="m9 18 6-6-6-6"/>',
  "rotate-cw": '<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>',
};

/** The one icon of that name. A name that does not exist is a fault of the caller, so it fails. */
export function icon(name) {
  const body = PATHS[name];
  if (!body) throw new Error(`unknown icon: ${name}`);
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;
}

/** Whether the core icon table has the name. */
export const hasIcon = (name) => Object.hasOwn(PATHS, name);
