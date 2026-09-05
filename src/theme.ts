/**
 * The look of the two things on the plane that are not cards.
 *
 * Separate from the view on purpose. The view places elements and handles input
 * and decides no appearance at all; a host that wants the default look asks for
 * it here. Nothing calls this on a host's behalf.
 *
 * The view draws the boundary lines and the dividers on them, because their
 * shape carries rules a host would have to rediscover: a divider's target is as
 * wide as a finger while its grip is a hairline, and a line a card crosses is
 * drawn too, or one line reads as two.
 *
 * Their colour is not a rule. Each is named in a token with a value that stands
 * alone, and a host with colours of its own points the tokens at them from its
 * own stylesheet. Nothing here reads a host's token names, and nothing here
 * decides light from dark: a host changes its tokens when its theme changes,
 * and these change with them.
 *
 * The sheet is text rather than a file because its class names come from the
 * prefix the view was given, and a sheet written for one prefix is wrong for
 * another.
 */

/** The colours the sheet draws with. */
export interface ThemePalette {
  /** A boundary line where cards meet it. */
  line: string;
  /** The rest of that line, where a card crosses instead of ending. */
  lineCrossing: string;
  /** The grip drawn on a divider. */
  grip: string;
  /** The grip while the divider is hovered, held or focused. */
  gripActive: string;
}

/** The sizes the sheet draws with, in px. */
export interface ThemeMetrics {
  /** Thickness of the grip across the line. */
  gripThickness: number;
  /** Length of the grip along the line. */
  gripLength: number;
}

export interface ThemeOptions {
  /** Class name and token stem, matching the view's. Default `sp`. */
  prefix?: string;
  /** Values the tokens start at. */
  palette?: Partial<ThemePalette>;
  /** Sizes the tokens start at. */
  metrics?: Partial<ThemeMetrics>;
}

const PALETTE: ThemePalette = {
  line: 'rgb(0 0 0 / 0.16)',
  lineCrossing: 'rgb(0 0 0 / 0.06)',
  grip: 'rgb(0 0 0 / 0.28)',
  gripActive: 'rgb(0 0 0 / 0.55)',
};

const METRICS: ThemeMetrics = { gripThickness: 3, gripLength: 24 };

/** The token names, so a host can point them at its own colours. */
export function themeTokens(prefix = 'sp'): Record<keyof ThemePalette | keyof ThemeMetrics, string> {
  return {
    line: `--${prefix}-line`,
    lineCrossing: `--${prefix}-line-crossing`,
    grip: `--${prefix}-grip`,
    gripActive: `--${prefix}-grip-active`,
    gripThickness: `--${prefix}-grip-thickness`,
    gripLength: `--${prefix}-grip-length`,
  };
}

/** The stylesheet, as text. */
export function themeCSS(options: ThemeOptions = {}): string {
  const prefix = options.prefix ?? 'sp';
  const palette = { ...PALETTE, ...options.palette };
  const metrics = { ...METRICS, ...options.metrics };

  return `:root {
  --${prefix}-line: ${palette.line};
  --${prefix}-line-crossing: ${palette.lineCrossing};
  --${prefix}-grip: ${palette.grip};
  --${prefix}-grip-active: ${palette.gripActive};
  --${prefix}-grip-thickness: ${metrics.gripThickness}px;
  --${prefix}-grip-length: ${metrics.gripLength}px;
}

.${prefix}-rule {
  background: var(--${prefix}-line);
}

/* The part of a line a card crosses rather than ends against. Same line, same
   coordinate, drawn fainter: leaving it out makes one line read as two wherever
   the cards above and below it disagree. */
.${prefix}-rule[data-virtual="true"] {
  background: var(--${prefix}-line-crossing);
}

/* The divider is a target, not a mark. What is seen is the grip inside it, so
   the target can be as wide as a finger without looking like it. */
.${prefix}-divider::after {
  content: "";
  position: absolute;
  inset: 0;
  margin: auto;
  border-radius: 99px;
  background: var(--${prefix}-grip);
  transition: background 0.12s;
}

.${prefix}-divider:hover::after,
.${prefix}-divider:focus-visible::after,
.${prefix}-divider[data-dragging]::after {
  background: var(--${prefix}-grip-active);
}

.${prefix}-divider[data-axis="x"] {
  cursor: col-resize;
}

.${prefix}-divider[data-axis="x"]::after {
  width: var(--${prefix}-grip-thickness);
  height: var(--${prefix}-grip-length);
}

.${prefix}-divider[data-axis="y"] {
  cursor: row-resize;
}

.${prefix}-divider[data-axis="y"]::after {
  height: var(--${prefix}-grip-thickness);
  width: var(--${prefix}-grip-length);
}

@media (prefers-reduced-motion: reduce) {
  .${prefix}-divider::after {
    transition: none;
  }
}
`;
}

/**
 * Puts the sheet in a document, once.
 *
 * Keyed by prefix, so two views with different prefixes each get their own and a
 * second view with the same prefix does not add a second copy. It goes first in
 * the head, so a host's own rules follow it and win on equal weight.
 */
export function installTheme(doc: Document, options: ThemeOptions = {}): HTMLStyleElement {
  const prefix = options.prefix ?? 'sp';
  const id = `${prefix}-theme`;
  const found = doc.getElementById(id);
  if (found) return found as HTMLStyleElement;

  const style = doc.createElement('style');
  style.id = id;
  style.textContent = themeCSS(options);
  doc.head.prepend(style);
  return style;
}
