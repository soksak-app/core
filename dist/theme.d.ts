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
/** Colours used by the sheet. */
export interface ThemePalette {
    /** A boundary line where cards end against it. */
    line: string;
    /** The rest of that line, where a card crosses it. */
    lineCrossing: string;
    /** The grip drawn on a divider. */
    grip: string;
    /** The grip while the divider is hovered, dragged or focused. */
    gripActive: string;
}
/** Sizes used by the sheet, in px. */
export interface ThemeMetrics {
    /** Thickness of the grip across the line. */
    gripThickness: number;
    /** Length of the grip along the line. */
    gripLength: number;
}
export interface ThemeOptions {
    /** Class name and token prefix, matching the view's. Default `sp`. */
    prefix?: string;
    /** Default token colours. */
    palette?: Partial<ThemePalette>;
    /** Default token sizes. */
    metrics?: Partial<ThemeMetrics>;
}
/** Token names, so a host can redirect them to its own colours. */
export declare function themeTokens(prefix?: string): Record<keyof ThemePalette | keyof ThemeMetrics, string>;
/** Returns the stylesheet as text. */
export declare function themeCSS(options?: ThemeOptions): string;
/**
 * Adds the sheet to a document once.
 *
 * Keyed by prefix, so views with different prefixes each get their own sheet and
 * a second view with the same prefix adds no second copy. It is inserted first
 * in the head so a host's own rules follow it and win at equal specificity.
 */
export declare function installTheme(doc: Document, options?: ThemeOptions): HTMLStyleElement;
