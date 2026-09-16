/**
 * Default stylesheet for the boundary lines and the dividers.
 *
 * Separate from the view. The view sets position and handles input and applies
 * no appearance; a host that wants the default look installs this sheet.
 *
 * The view draws the lines and dividers because their shape carries two rules:
 * a divider's hit target is finger-wide while its grip is a hairline, and a
 * line a card crosses is drawn too, or one line renders as two.
 *
 * Colour is not part of those rules. Each colour is a token with a standalone
 * default, and a host redirects the tokens to its own values from its own
 * stylesheet. This module reads no host token name and selects no light or dark
 * variant.
 *
 * The sheet is text rather than a file because its class names derive from the
 * prefix the view was given.
 */
const PALETTE = {
    line: 'rgb(0 0 0 / 0.16)',
    lineCrossing: 'rgb(0 0 0 / 0.06)',
    grip: 'rgb(0 0 0 / 0.28)',
    gripActive: 'rgb(0 0 0 / 0.55)',
};
const METRICS = { gripThickness: 3, gripLength: 24 };
/** Token names, so a host can redirect them to its own colours. */
export function themeTokens(prefix = 'sp') {
    return {
        line: `--${prefix}-line`,
        lineCrossing: `--${prefix}-line-crossing`,
        grip: `--${prefix}-grip`,
        gripActive: `--${prefix}-grip-active`,
        gripThickness: `--${prefix}-grip-thickness`,
        gripLength: `--${prefix}-grip-length`,
    };
}
/** Returns the stylesheet as text. */
export function themeCSS(options = {}) {
    var _a;
    const prefix = (_a = options.prefix) !== null && _a !== void 0 ? _a : 'sp';
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

/* The part of a line a card crosses rather than ends against. Same line and
   coordinate, drawn fainter. Omitting it renders one line as two wherever the
   cards on the two sides differ. */
.${prefix}-rule[data-virtual="true"] {
  background: var(--${prefix}-line-crossing);
}

/* The divider is the hit target and the grip inside it is what is drawn, so the
   target can be finger-wide without appearing that wide. */
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
 * Adds the sheet to a document once.
 *
 * Keyed by prefix, so views with different prefixes each get their own sheet and
 * a second view with the same prefix adds no second copy. It is inserted first
 * in the head so a host's own rules follow it and win at equal specificity.
 */
export function installTheme(doc, options = {}) {
    var _a;
    const prefix = (_a = options.prefix) !== null && _a !== void 0 ? _a : 'sp';
    const id = `${prefix}-theme`;
    const found = doc.getElementById(id);
    if (found)
        return found;
    const style = doc.createElement('style');
    style.id = id;
    style.textContent = themeCSS(options);
    doc.head.prepend(style);
    return style;
}
