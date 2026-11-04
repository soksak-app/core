// The chrome metrics: every length, ratio and duration that the stylesheets of the workbench read. workbench.json declares them, and the
// page sets them as custom properties of the document root, so a stylesheet holds no literal of its own (docs/spec/settings.md#values).

import declaration from "./workbench.json" with { type: "json" };

/** The chrome metrics of workbench.json: a custom property name without the leading dashes and its CSS value. */
export const CHROME = declaration.chrome;

/** Sets every chrome metric on root as the custom property --<name>. */
export function installChromeMetrics(root) {
  for (const [name, value] of Object.entries(CHROME)) root.style.setProperty(`--${name}`, value);
}

/**
 * Marks root with data-library-narrow while the window is at most the chrome metric library-narrow-w wide, and keeps the mark current. A media
 * condition cannot read a custom property, so library.css reads this mark.
 */
export function followLibraryWidth(root, view) {
  const narrow = view.matchMedia(`(max-width: ${CHROME["library-narrow-w"]})`);
  const mark = () => {
    if (narrow.matches) root.dataset.libraryNarrow = "";
    else delete root.dataset.libraryNarrow;
  };
  mark();
  narrow.addEventListener("change", mark);
}
