import { matchSettings } from "./settings-match.js";
// The core setting rows of the settings tab (docs/spec/settings.md#pages). Each page lists its groups, and each group lists its rows in the
// order the page draws them. The search reads the same rows (docs/spec/settings.md#search), so a label, a description or a key is written once.
// A row names its form, and the form picks its control (docs/spec/settings.md#controls). The forms `sidebar`, `sets`, `theme`, `setup` and
// `debug` are drawn by their own pages (settings-pages.js, settings-sets.js).
import { PROBLEM_TOAST_DISMISS_SECONDS, FONTS, LAYOUT_RANGES, MEMORY_SAVER_DELAY, MENU_LANGUAGES, SHAPE_RANGES, CHOICES, THEMES } from "./settings.js";
import declaration from "./workbench.json" with { type: "json" };

/** The pages in menu order (docs/spec/settings.md#menu), read from the rows section of the workbench declaration. */
export const PAGES = declaration.rows.pages;

/** The labels of the choices that have one. A choice without a label is shown by its value (docs/spec/settings.md#pages). The static labels
 * come from the rows section of the declaration; the language and font labels come from the menu languages and the fonts. */
const LABELS = Object.freeze({
  ...declaration.rows.labels,
  language: { auto: "자동 (시스템)", ...Object.fromEntries(MENU_LANGUAGES.map((language) => [language.id, language.label])) },
  font: Object.fromEntries(FONTS.map((font) => [font.id, font.name])),
});

/** The labels of a choice setting, in the declared order (docs/spec/settings.md#values). */
export function choicesOf(key) {
  return CHOICES[key].map((choice) => [choice, LABELS[key]?.[choice] ?? String(choice)]);
}

const range = (key) => (LAYOUT_RANGES[key] ?? SHAPE_RANGES[key] ?? (key === "memorySaverDelay" ? MEMORY_SAVER_DELAY
  : key === "problemToastDismissSeconds" ? PROBLEM_TOAST_DISMISS_SECONDS : null));

/** The bounds of a slider or stepper row: [min, max] (docs/spec/settings.md#values). */
export function rangeOf(key) {
  const bounds = range(key);
  if (!bounds) throw new Error(`settings row ${key} has no range`);
  return bounds;
}

/**
 * The groups of the pages, read from the rows section of the workbench declaration. A row is {key, label, form, description?, scope?, depends?}:
 * scope is `common` for a common-only setting (the default is `both`), and depends names the parent whose off state disables the row.
 */
export const GROUPS = declaration.rows.groups;

/** The rows of a page in order, flattened over its groups. */
export const rowsOf = (page) => GROUPS[page].flatMap((group) => group.rows.map((row) => ({ ...row, group: group.name, page })));

/** Every core setting row, which the search reads (docs/spec/settings.md#search). */
export const ALL_ROWS = PAGES.flatMap((page) => rowsOf(page.id));

/**
 * The keys of the core rows that match a query, in the order of ALL_ROWS. A row matches when the lower-case query is a substring of its label,
 * description, group name or key (docs/spec/settings.md#search). The Go host matches the same rows with the same rule (settings_search.go).
 */
export function matchingRowKeys(query) {
  return matchSettings({ query, rows: ALL_ROWS, pluginUnits: [], settingDefs: {}, plugins: [] }).settings;
}

/** The page of a row key, or null for a key that no core page draws. */
export const pageOfKey = (key) => ALL_ROWS.find((row) => row.key === key)?.page ?? null;

/** The theme names in the order of the swatch grid (docs/spec/settings.md#pages). */
export const THEME_NAMES = THEMES.map((theme) => theme.name);
