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
/** The token names, so a host can point them at its own colours. */
export declare function themeTokens(prefix?: string): Record<keyof ThemePalette | keyof ThemeMetrics, string>;
/** The stylesheet, as text. */
export declare function themeCSS(options?: ThemeOptions): string;
/**
 * Puts the sheet in a document, once.
 *
 * Keyed by prefix, so two views with different prefixes each get their own and a
 * second view with the same prefix does not add a second copy. It goes first in
 * the head, so a host's own rules follow it and win on equal weight.
 */
export declare function installTheme(doc: Document, options?: ThemeOptions): HTMLStyleElement;
