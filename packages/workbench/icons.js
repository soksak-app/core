// Icons.
//
// All are strokes on a 24 viewBox.

import declaration from "./workbench.json" with { type: "json" };

/**
 * The split icon elements drawn inside the rounded frame of a group card, the icon of a group split button (docs/spec/groups.md#headers):
 * in the 16 point box of a head icon drawn at card-icon, the frame runs along the edge of the box in the stroke of the icon with the
 * radius card-group-frame-radius, and the split icon is scaled into the box inside the frame less the padding card-group-frame-pad, in the
 * same stroke width.
 */
export function framedIcon(elements) {
  const { chrome } = declaration;
  const unit = 16 / parseFloat(chrome["card-icon"]);
  const stroke = Number(chrome["icon-stroke"]);
  const inner = stroke + parseFloat(chrome["card-group-frame-pad"]) * unit;
  const scale = (16 - 2 * inner) / 16;
  return `<rect x="${stroke / 2}" y="${stroke / 2}" width="${16 - stroke}" height="${16 - stroke}" rx="${parseFloat(chrome["card-group-frame-radius"]) * unit}"/>`
    + `<g transform="translate(${inner} ${inner}) scale(${scale})" stroke-width="${stroke / scale}">${elements}</g>`;
}

/**
 * The icons of the card head, declared in workbench.json for both workbenches, and the icons of the group split buttons, the split icon
 * of each side in the frame of a group card.
 */
export const declaredIcons = { ...declaration.icons, "card-group-x": framedIcon(declaration.icons["card-split-x"]),
  "card-group-y": framedIcon(declaration.icons["card-split-y"]) };

const PATHS = {
  "panel-left": declaredIcons["panel-left"],
  "panel-right": declaredIcons["panel-right"],
  "panel-top": declaredIcons["panel-top"],
  "panel-bottom": declaredIcons["panel-bottom"],
  star: '<path d="m12 3 2.8 5.7 6.3.9-4.6 4.4 1.1 6.3-5.6-3-5.6 3 1.1-6.3-4.6-4.4 6.3-.9Z"/>',
  projects: declaredIcons["projects"],
  "columns-3": declaredIcons["columns-3"],
  "layout-grid": declaredIcons["layout-grid"],
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
