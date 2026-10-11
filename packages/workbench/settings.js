// Settings outside the plane: theme, mode and shape.
//
// A changed value also changes the layout of the plane, but this module does not call the plane; it only notifies the change.
// If settings referred to the plane, every added setting would require choosing which plane function to call.

/* ── Theme ──────────────────────────────────────────────────────────────────
   There are two axes. The theme sets the shape and the colors, and the mode selects one of the dark and light
   variants of that theme. Every theme has both.

   The shape (corner radius, gap width, border width, font, font size) does not depend on the mode.
   There is no reason for the corners to change when the brightness changes.

   There are four line colors, one per role. If one accent color were reused with only its density changed, it
   would not show what belongs together.

     edge   the border of a card and a box. One step lighter than the background
     rule   the boundary line that divides the plane, and the divider
     rail   the line that joins a sidebar and a card into one
     focus  the place that currently receives input

   When the gap is 0 the cards touch and the two cards share one boundary line. That state
   is called the seam and is derived from the gap value. There is no separate setting for it.

   Applying means setting the values on the root. A surface and a modal are separate documents and cannot inherit
   the style sheet of this document, so the host sends these values as they are.     */

import { host as bridge } from "@soksak/runtime";
import { log, surfaces as host } from "./host.js";
import { checkSidebarReferences, isSettingAddress, validateSidebars } from "@soksak/plugin-api";
import { effectiveSettings } from "./settings-scope.js";
import { chooseLink, resolveSidebar } from "./sidebar-sets.js";
import { TEXT_STEPS, notifyTextSize } from "./text-size.js";
import { setTraceEnabled } from "./performance.js";
import { beginOperation } from "./operations.js";

/* The selectable fonts. A theme designates one of them as its default, and the settings change it.
   A name that is not installed falls through to the next name of the list. */
export const FONTS = [
  { id: "mono-system", name: "시스템 고정폭",
    stack: "ui-monospace,SFMono-Regular,Menlo,monospace" },
  { id: "mono-sf", name: "SF Mono / Menlo",
    stack: "'SF Mono',Menlo,'DejaVu Sans Mono',ui-monospace,monospace" },
  { id: "mono-jet", name: "JetBrains Mono",
    stack: "'JetBrains Mono','Fira Code',ui-monospace,monospace" },
  { id: "sans-system", name: "시스템 비례",
    stack: "ui-sans-serif,-apple-system,'Segoe UI',sans-serif" },
  { id: "sans-inter", name: "Inter",
    stack: "Inter,ui-sans-serif,-apple-system,'Segoe UI',sans-serif" },
];

export const THEMES = [
  { name: "midnight", shape: { r: "10px", gap: "6px", bw: "1px", font: "mono-system", size: "13px" },
    dark: { bg: "#101117", card: "#191b24", fg: "#ececf5", muted: "#8f92a4",
            edge: "#2b2e3d", rule: "#22242f", rail: "#7279ff", focus: "#ffb36b",
            no: "#ff7c7c" },
    light: { bg: "#eef0f4", card: "#ffffff", fg: "#252735", muted: "#6c6f7e",
             edge: "#d8dbe4", rule: "#e3e6ec", rail: "#5962e8", focus: "#c06a1f",
             no: "#c62c2c" } },

  { name: "nord", shape: { r: "8px", gap: "5px", bw: "1px", font: "mono-sf", size: "13px" },
    dark: { bg: "#2e3440", card: "#353c4a", fg: "#eceff4", muted: "#8b93a5",
            edge: "#454d5e", rule: "#3a4150", rail: "#81a1c1", focus: "#ebcb8b",
            no: "#bf616a" },
    light: { bg: "#eceff4", card: "#ffffff", fg: "#2e3440", muted: "#6d7789",
             edge: "#d8dee9", rule: "#e3e8ef", rail: "#5e81ac", focus: "#b48a2f",
             no: "#a3454e" } },

  { name: "solar", shape: { r: "6px", gap: "7px", bw: "2px", font: "mono-system", size: "13px" },
    dark: { bg: "#002b36", card: "#05323d", fg: "#eee8d5", muted: "#8b9ea0",
            edge: "#0f4451", rule: "#073642", rail: "#268bd2", focus: "#cb4b16",
            no: "#dc322f" },
    light: { bg: "#fdf6e3", card: "#fffdf6", fg: "#3b4a4f", muted: "#8a9599",
             edge: "#e8dfc4", rule: "#f0e7d0", rail: "#268bd2", focus: "#cb4b16",
             no: "#dc322f" } },

  { name: "forest", shape: { r: "14px", gap: "6px", bw: "1px", font: "sans-system", size: "13px" },
    dark: { bg: "#0e1512", card: "#141d19", fg: "#dfeee6", muted: "#7d9389",
            edge: "#22302a", rule: "#1a241f", rail: "#3f8f6b", focus: "#d9a441",
            no: "#e0736d" },
    light: { bg: "#eef4f0", card: "#ffffff", fg: "#1f3129", muted: "#6b8378",
             edge: "#d4e2da", rule: "#e2ebe6", rail: "#2f7a58", focus: "#a8761f",
             no: "#b1453f" } },

  { name: "ember", shape: { r: "4px", gap: "4px", bw: "2px", font: "mono-jet", size: "13px" },
    dark: { bg: "#17100e", card: "#201714", fg: "#f3e4de", muted: "#a1877e",
            edge: "#33241f", rule: "#271c18", rail: "#c4603a", focus: "#e8a33d",
            no: "#e05252" },
    light: { bg: "#faf0ea", card: "#fffaf6", fg: "#3a2822", muted: "#8d7268",
             edge: "#ecd9cd", rule: "#f3e6dd", rail: "#b1552f", focus: "#a56a17",
             no: "#b23a3a" } },

  /* Gap 0. The cards touch and share one boundary line. */
  { name: "slate", shape: { r: "0px", gap: "0px", bw: "1px", font: "sans-inter", size: "13px" },
    dark: { bg: "#15171a", card: "#1c1f23", fg: "#e6e9ee", muted: "#8d939d",
            edge: "#2c3036", rule: "#2c3036", rail: "#6b7480", focus: "#c7ced8",
            no: "#d97070" },
    light: { bg: "#f1f3f5", card: "#ffffff", fg: "#23282e", muted: "#6f7781",
             edge: "#dcdfe4", rule: "#dcdfe4", rail: "#7b8593", focus: "#3d4854",
             no: "#b1453f" } },

  { name: "mist", shape: { r: "12px", gap: "6px", bw: "1px", font: "mono-system", size: "13px" },
    dark: { bg: "#121821", card: "#18202a", fg: "#e2eaf2", muted: "#7f8fa1",
            edge: "#283344", rule: "#1d2531", rail: "#4c6c88", focus: "#8ec5ea",
            no: "#dd7a74" },
    light: { bg: "#eef2f5", card: "#f9fbfc", fg: "#2b3440", muted: "#71808f",
             edge: "#d5dee6", rule: "#e3eaf0", rail: "#6f92ad", focus: "#2f6f9f",
             no: "#b8453f" } },

  { name: "grape", shape: { r: "16px", gap: "5px", bw: "1px", font: "sans-inter", size: "13px" },
    dark: { bg: "#150f1c", card: "#1d1626", fg: "#ece2f6", muted: "#9b8bad",
            edge: "#2e2340", rule: "#221a2e", rail: "#8a5cd6", focus: "#e07bd0",
            no: "#e4707f" },
    light: { bg: "#f4eefb", card: "#fdfaff", fg: "#2f2438", muted: "#7d6e8c",
             edge: "#e0d3ee", rule: "#ebe2f5", rail: "#7a4fc0", focus: "#a8459a",
             no: "#b6455a" } },

  { name: "sand", shape: { r: "2px", gap: "4px", bw: "1px", font: "mono-sf", size: "13px" },
    dark: { bg: "#191712", card: "#221f19", fg: "#efe9dd", muted: "#9d9384",
            edge: "#342f25", rule: "#26221c", rail: "#8a7752", focus: "#d7b46a",
            no: "#cf6f62" },
    light: { bg: "#f2ede4", card: "#fbf8f2", fg: "#3a352c", muted: "#8a8172",
             edge: "#e0d8c8", rule: "#eae3d7", rail: "#a8926b", focus: "#7a5c2e",
             no: "#a8443c" } },

  /* Gap 0. */
  { name: "paper", shape: { r: "0px", gap: "0px", bw: "1px", font: "sans-system", size: "13px" },
    dark: { bg: "#0d0d0e", card: "#151517", fg: "#e9e9ea", muted: "#8f8f93",
            edge: "#26262a", rule: "#26262a", rail: "#6a6a70", focus: "#e0e0e2",
            no: "#c96a6a" },
    light: { bg: "#ffffff", card: "#fbfbfb", fg: "#1a1a1c", muted: "#6e6e73",
             edge: "#e2e2e5", rule: "#e2e2e5", rail: "#a0a0a6", focus: "#1a1a1c",
             no: "#b53a3a" } },
];

export const MODES = ["dark", "light"];

/**
 * The current settings. A single object that is the JSON storage format as it is.
 *
 * With a variable per value, the list of stored values would need separate management and would have to
 * be edited whenever a value is added.
 */
export const defaults = {
  projectOpening: "windows",
  theme: THEMES[0].name,
  mode: "dark",
  /* The language of the application menu. auto = the system language (en if it is not supported). */
  language: "auto",

  /* The performance trace, present in every build. When it is on, the layers store the events of the trace in the event
     files under <config-dir>/logs; when it is off, no layer builds or stores one. While the release version is
     0.0.x it is on by default, so a defect is recorded when it appears (AGENTS.md, docs/spec/settings.md). */
  "diagnostics.performance": true,

  /* The position of the project tabs. top = the chrome row, left = the vertical list on the left. */
  projectTabs: "top",
  /* Whether the left and right regions are shown. links decides what they show. */
  left: true,
  right: true,
  /* Whether a surface that lost focus is dimmed. */
  dim: false,
  /* How the focused card is shown. border = a border, corner = marks at the four corners. */
  focusInd: "border",
  /* Where the boundary line of the section that a card crosses is drawn.
     over = over the surface, under = under the card, none = not drawn. */
  fullRule: "under",
  /* The next four are given defaults by the theme, and from then on the value the user specified is used.
     Choosing the theme again returns them to the values of that theme. */
  /* The half width (px) of the gap. When it is 0 the cards share one line. */
  gap: parseFloat(THEMES[0].shape.gap),
  /* The corner radius (px) of a card. --r-sm and --r-xs are derived from it. */
  radius: parseFloat(THEMES[0].shape.r),
  /* The font: an id of FONTS. */
  font: THEMES[0].shape.font,
  /* The font size (px). */
  size: parseFloat(THEMES[0].shape.size),
  /* The scale of the text size applied to the frame chrome and every card: a value of TEXT_STEPS (docs/spec/text-size.md). */
  textSize: 1,

  /* A sidebar is made by combining sets. A set holds sections in order, and links connects
     a set to a position. A link uses the id, not the title. The defaults are decided by the
     sidebars of environment.json (setSidebarDefaults). */
  sets: [],
  links: [],

  /* Layout values (pt): the minimum and maximum width of a card sidebar and the initial width of a new sidebar (docs/spec/settings.md). */
  sidebarMinWidth: 120,
  sidebarMaxWidth: 480,
  sidebarWidth: 190,
};

/* The range of the layout values. Only integers are accepted. The three values share one range so that the same value is at the same slider position. */
const WIDTH_RANGE = [60, 800];
export const LAYOUT_RANGES = {
  sidebarMinWidth: WIDTH_RANGE,
  sidebarMaxWidth: WIDTH_RANGE,
  sidebarWidth: WIDTH_RANGE,
};

/* The languages that the application menu supports. A new language is added to this declaration and to the menu table of the host contract together. */
export const MENU_LANGUAGES = [
  { id: "ko", label: "한국어" },
  { id: "en", label: "English" },
];
/* The default language used when the system language is not in the table. */
const DEFAULT_LANGUAGE = "en";

/* The range (px) of the shape values. Only integers are accepted, and the slider of the settings window uses the same range. */
export const SHAPE_RANGES = {
  gap: [0, 24],
  radius: [0, 24],
  size: [10, 18],
};

/* The core settings that take one choice. The select control of the settings window shows the choices in this order (docs/spec/settings.md#values). */
export const CHOICES = {
  projectOpening: ["tabs", "windows"],
  theme: THEMES.map((theme) => theme.name),
  mode: MODES,
  font: FONTS.map((font) => font.id),
  textSize: TEXT_STEPS,
  projectTabs: ["top", "left"],
  focusInd: ["border", "corner"],
  fullRule: ["under", "over", "none"],
  language: ["auto", ...MENU_LANGUAGES.map((language) => language.id)],
};

/* The core settings that take an integer range. The layout values and the shape values do not share keys. */
const RANGES = { ...LAYOUT_RANGES, ...SHAPE_RANGES };

/* The core settings that take a boolean. */
const SWITCHES = ["left", "right", "dim", "diagnostics.performance"];

/** Validates the effective settings: the sidebar sets and links, and whether the initial width of a sidebar inside a card is between the minimum and the maximum. */
function checkValues(values) {
  checkSidebars(values);
  if (!(values.sidebarMinWidth <= values.sidebarWidth && values.sidebarWidth <= values.sidebarMaxWidth)) {
    throw new Error("Invalid setting: sidebarMinWidth <= sidebarWidth <= sidebarMaxWidth does not hold");
  }
}

let settings = structuredClone(defaults);
const pluginDefinitions = new Map();
/* The manifest of the environment. The sections of the stored sets and the plugins of the links are validated against this list. */
let manifestList = [];

/** Validates the sets and links of the effective settings with the same function as the sidebars of environment.json. */
function checkSidebars(values) {
  const sidebars = { sets: values.sets, links: values.links };
  validateSidebars(sidebars, "settings", new Set(manifestList.map((manifest) => manifest.id)));
  checkSidebarReferences(sidebars, manifestList, "settings");
}

let common = {};
let overrides = {};
let projectId = null;
let store;
let writing = Promise.resolve();
let changes = 0;
let revision = 0;

/** Validates one value in the declared format of its setting. sets and links are validated by checkSidebars over the whole effective settings. */
function validateValue(key, value) {
  const choices = CHOICES[key];
  if (choices && !choices.includes(value)) {
    throw new Error(`Invalid setting ${key}: ${JSON.stringify(value)} is not one of ${choices.map((choice) => JSON.stringify(choice)).join(", ")}`);
  }
  if (SWITCHES.includes(key) && typeof value !== "boolean") {
    throw new Error(`Invalid setting ${key}: ${JSON.stringify(value)} is not a boolean`);
  }
  const range = RANGES[key];
  if (range && (!Number.isInteger(value) || value < range[0] || value > range[1])) {
    throw new Error(`Invalid setting ${key}: ${JSON.stringify(value)} is not an integer from ${range[0]} to ${range[1]}`);
  }
  const definition = pluginDefinitions.get(key);
  if (!definition) return;
  if (definition.type === "enum" && !definition.values.includes(value)) {
    throw new Error(`Invalid setting ${key}: value is not declared`);
  }
  if (definition.type === "integer" &&
      (!Number.isInteger(value) || value < definition.minimum || value > definition.maximum)) {
    throw new Error(`Invalid setting ${key}: integer value is outside its declared range`);
  }
  if (definition.type === "string" &&
      (typeof value !== "string" || value.length === 0 || value.length > definition.maxLength)) {
    throw new Error(`Invalid setting ${key}: string value must be non-empty and at most ${definition.maxLength} characters`);
  }
  if (definition.type === "address" && !isSettingAddress(value)) {
    throw new Error(`Invalid setting ${key}: address value must be empty or an http or https address`);
  }
}

/**
 * Whether this is a stored setting of a plugin that is not loaded. The part of such a key before the first `.` is a plugin id that is not a loaded plugin,
 * and the key stays in the file as it is, neither validated nor applied (docs/spec/plugins.md).
 */
function keptSetting(key) {
  const dot = key.indexOf(".");
  return !Object.hasOwn(defaults, key) && dot > 0 && !manifestList.some((manifest) => manifest.id === key.slice(0, dot));
}

/** Keeps only the settings to apply. The settings of a plugin that is not loaded exist only in the store. */
function applied(values) {
  return Object.fromEntries(Object.entries(values).filter(([key]) => !keptSetting(key)));
}

/**
 * The common-only keys that a project setting cannot override (docs/spec/projects.md#persistence). The host decides the window title bar from the
 * textSize of the common settings before the page starts, so the frame scale is common-only (docs/spec/native-surfaces.md#title-bar-height).
 */
const COMMON_ONLY = Object.freeze(["projectOpening", "textSize"]);

/** It is an error when a project setting holds a common-only key. */
function checkCommonOnly(values) {
  for (const key of COMMON_ONLY) {
    if (Object.hasOwn(values, key)) throw new Error(`project settings: ${key} is common-only`);
  }
}

function validateValues(values, where) {
  if (!values || typeof values !== "object") throw new Error(`${where} are not an object`);
  for (const [key, value] of Object.entries(values)) {
    if (keptSetting(key)) continue;
    if (!Object.hasOwn(defaults, key)) throw new Error(`${where}: unknown setting ${key}`);
    validateValue(key, value);
  }
}

/** Registers the validated plugin settings before the persistent settings are loaded. */
export function setPluginSettings(manifests, applicationValues = {}) {
  if (store) throw new Error("plugin settings must be set before settings are connected");
  manifestList = manifests;
  for (const manifest of manifests) {
    // default: settings is an optional field of plugin.json, and without it the plugin has no settings (docs/spec/plugins.md).
    for (const [local, definition] of Object.entries(manifest.settings ?? {})) {
      const key = `${manifest.id}.${local}`;
      if (pluginDefinitions.has(key) || Object.hasOwn(defaults, key)) {
        throw new Error(`duplicate setting: ${key}`);
      }
      pluginDefinitions.set(key, Object.freeze({ ...definition, plugin: manifest.id, local }));
      defaults[key] = definition.default;
      // default: a plugin to which environment.json gives no initial value has no initial value.
      if (Object.hasOwn(applicationValues[manifest.id] ?? {}, local)) {
        validateValue(key, applicationValues[manifest.id][local]);
        defaults[key] = applicationValues[manifest.id][local];
      }
    }
  }
  settings = structuredClone(defaults);
}

export const settingDefinitions = () => Object.fromEntries(
  [...pluginDefinitions.entries()].map(([key, definition]) => [key, structuredClone(definition)]),
);

export function pluginSettings(pluginId) {
  const values = {};
  for (const [key, definition] of pluginDefinitions) {
    if (definition.plugin === pluginId) values[definition.local] = settings[key];
  }
  return values;
}

/** Registers the sidebar defaults of environment.json. Call it before the settings store is connected. */
export function setSidebarDefaults(sidebars) {
  if (store) throw new Error("sidebar defaults must be set before settings are connected");
  defaults.sets = structuredClone(sidebars.sets);
  defaults.links = structuredClone(sidebars.links);
  settings = structuredClone(defaults);
}

/** The file of the settings of a project of the snapshot (docs/spec/projects.md#settings). */
const projectSettingsFile = (project) => `${project.root}/.soksak/settings.json`;

/**
 * Applies the settings of the first screen from the snapshot of the start document (docs/spec/native-host.md#page-start). id is the project that the window opens, and
 * it is null for the library. Connecting the store and later changes are handled by connectSettings.
 */
export function beginSettings(snapshot, id) {
  const nextCommon = snapshot.common;
  const project = snapshot.projects.find((p) => p.id === id);
  // default: a project that overrides no setting has no settings.
  const nextOverrides = project?.settings ?? {};
  validateValues(nextCommon, "settings.json");
  if (project) validateValues(nextOverrides, projectSettingsFile(project));
  checkCommonOnly(nextOverrides);
  checkValues(effectiveSettings(defaults, applied(nextCommon), applied(nextOverrides)));
  projectId = id;
  common = nextCommon;
  overrides = nextOverrides;
  apply();
}

export async function connectSettings(storage) {
  store = storage;
  store.onChange(() => { if (!changes) return refresh().catch((e) => dispatchEvent(new ErrorEvent("error", { message: e.message }))); });
  await refresh();
}

async function refresh() {
  const mine = ++revision;
  const snapshot = await store.snapshot();
  if (changes || mine !== revision) return;
  const project = snapshot.projects.find((p) => p.id === projectId);
  // default: a project that overrides no setting has no settings.
  const nextOverrides = project?.settings ?? {};
  validateValues(snapshot.common, "settings.json");
  if (project) validateValues(nextOverrides, projectSettingsFile(project));
  checkCommonOnly(nextOverrides);
  checkValues(effectiveSettings(defaults, applied(snapshot.common), applied(nextOverrides)));
  if (JSON.stringify(common) !== JSON.stringify(snapshot.common) || JSON.stringify(overrides) !== JSON.stringify(nextOverrides)) {
    common = snapshot.common;
    overrides = nextOverrides;
    apply();
  }
  await setTraceEnabled(settings["diagnostics.performance"]);
}

function apply() {
  settings = effectiveSettings(defaults, applied(common), applied(overrides));
  install();
  announce();
}

export async function selectProject(id) {
  await writing;
  projectId = id;
  await refresh();
}

export const settingProject = () => projectId;
export const scopedValue = (key, scope) => scope === "common"
  // default: a setting without a stored common value takes its default value.
  ? (common[key] ?? defaults[key]) : settings[key];
export const overridden = (key) => Object.hasOwn(overrides, key);
export const flushSettings = () => writing;
export const reset = (key, actor) => set({ [key]: undefined }, "project", actor);

/** Returns the theme by name. Throws when the name is not in the list. */
function themeOf(name) {
  const found = THEMES.find((t) => t.name === name);
  if (!found) throw new Error(`unknown theme: ${name}`);
  return found;
}

/** The current token values. A surface and a modal receive the same values. */
function themeTokens() {
  const theme = themeOf(settings.theme);
  const c = theme[settings.mode];
  return {
    "--bg": c.bg, "--card": c.card, "--fg": c.fg, "--muted": c.muted,
    "--edge": c.edge, "--rule": c.rule, "--rail": c.rail, "--focus": c.focus,
    "--no": c.no,
    // The four shape values are kept by the settings, not by the theme. A theme sets the values once when it is
    // selected (applyTheme). Writing the theme values here would erase the values the user changed.
    "--r": `${settings.radius}px`, "--half-gap": `${halfGap()}px`,
    "--bw": theme.shape.bw,
    "--font": fontOf(settings.font).stack, "--size": `${settings.size}px`,
  };
}

/** Returns the font by id. Throws when the id is not in the list. */
function fontOf(id) {
  const found = FONTS.find((f) => f.id === id);
  if (!found) throw new Error(`unknown font: ${id}`);
  return found;
}

/**
 * The seam. When the gap is 0 the cards share one line; otherwise the gap separates the cards.
 *
 * There is no separate setting for it. With two values there could be a state with gap 0 and a seam of gap, and
 * there is nothing to draw in that state.
 */
const seam = () => (settings.gap === 0 ? "line" : "gap");

/* A page that the application serves is a separate document and does not inherit the style sheet of this document.
   It receives the token values that are sent and sets them on its own root. */
const pageTheme = () => ({ scheme: settings.mode, tokens: themeTokens() });

/**
 * Applies the theme and the mode.
 *
 * Sets the values on the root. The style sheet is not replaced, so the values the user specified with a color input
 * are kept.
 */
export function applyTheme(name, next, scope, actor) {
  if (!MODES.includes(next)) throw new Error(`unknown mode: ${next}`);
  const theme = themeOf(name);
  // Choosing a theme also sets the four shape values.
  return set({
    theme: theme.name, mode: next,
    gap: parseFloat(theme.shape.gap), radius: parseFloat(theme.shape.r),
    font: theme.shape.font, size: parseFloat(theme.shape.size),
  }, scope, actor);
}

/** Returns one setting value. */
export const value = (key) => settings[key];

/**
 * Changes part of the settings, applies the values and then notifies the change.
 *
 * This function is the only path of change. With a function per value, some function would omit the application. `actor` names
 * what changes the settings: the command, or the surface of a gesture. The change is the operation `page.settings.change`
 * (docs/spec/logging.md#operation-chains), and its identifiers go with the write to the host.
 */
export function set(patch, scope = projectId ? "project" : "common", actor) {
  if (typeof actor !== "string" || actor === "") throw new Error("set requires the actor that changes the settings");
  const id = scope === "project" ? projectId : null;
  if (scope === "project" && !id) throw new Error("No project is selected");
  if (id && Object.hasOwn(patch, "projectOpening")) throw new Error("Project opening mode is common-only");
  if (id && Object.hasOwn(patch, "textSize")) throw new Error("Text size is common-only");
  for (const [key, val] of Object.entries(patch)) {
    if (!Object.hasOwn(defaults, key)) throw new Error(`Unknown setting: ${key}`);
    if (val !== undefined) validateValue(key, val);
  }
  const target = id ? overrides : common;
  const patched = { ...target };
  for (const [key, val] of Object.entries(patch)) {
    if (val === undefined) delete patched[key];
    else patched[key] = val;
  }
  checkValues(id ? effectiveSettings(defaults, applied(common), applied(patched)) : effectiveSettings(defaults, applied(patched), applied(overrides)));
  const cids = beginOperation("page.settings.change", { scope: id ? "project" : "common", actor, keys: Object.keys(patch).join(",") });
  for (const [key, val] of Object.entries(patch)) {
    if (val === undefined) delete target[key];
    else target[key] = val;
  }
  changes++;
  revision++;
  apply();
  const propagation = Object.hasOwn(patch, "diagnostics.performance")
    ? setTraceEnabled(settings["diagnostics.performance"]) : Promise.resolve();
  const saved = Promise.all([writing, propagation]).then(() => store.settings(id, patch, cids));
  writing = saved.finally(async () => {
    changes--;
    if (changes) return;
    await refresh();
    savedListener();
  });
  return writing;
}

let savedListener = () => {};

/** Returns whether a settings change is being saved. */
export const saving = () => changes > 0;

/** Calls fn when every change that is being saved has been saved. */
export function onSaved(fn) {
  savedListener = fn;
}

/** Sets the values on the document root. It is called once at start and then on every change. */
export function install() {
  const root = document.documentElement;
  root.style.colorScheme = settings.mode;
  // It is read when the style sheet chooses a different color per mode (the letters of the logo).
  root.dataset.mode = settings.mode;
  // The two values that the style sheet reads. Only the display changes, so the plane is not recreated.
  root.dataset.focusInd = settings.focusInd;
  root.dataset.fullRule = settings.fullRule;
  root.dataset.seam = seam();
  // The frame text scale that the CSS zoom of the frame chrome reads is not written here. The drawing of the prepared layout uses it (frame-text.js).
  // A surface reads its actual scale again.
  notifyTextSize();
  for (const [token, value] of Object.entries(themeTokens())) {
    root.style.setProperty(token, value);
  }
  // A page that the host serves does not inherit the style sheet of this document, so the values are
  // sent separately.
  host.theme(pageTheme());
  // The language of the application menu. The host recreates the menu only when the effective language changes.
  host.menuLanguage(menuLanguage());
}

/** The effective language of the application menu. When the setting is auto, the primary tag of the system language is looked up in the table, and the default language is used if it is not found. */
export function menuLanguage() {
  const chosen = settings.language;
  if (chosen !== "auto") return chosen;
  // default: navigator.language can be empty in an embedded context and similar cases, and then the default language of the contract replaces the system language.
  const tag = (navigator.language ?? DEFAULT_LANGUAGE).split("-")[0].toLowerCase();
  return MENU_LANGUAGES.some((language) => language.id === tag) ? tag : DEFAULT_LANGUAGE;
}
/** The corner radius (px) of a card. When the seam is line, the cards are square. */
export const cardRadius = () => (seam() === "line" ? 0 : settings.radius);

/* The receiver of settings changes. One plane is connected. */
const listeners = new Set();

/** Registers the function to call when the settings change. */
export function onSettingsChange(fn) {
  if (typeof fn !== "function") throw new TypeError("settings listener must be a function");
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const announce = () => { for (const fn of listeners) fn(); };

/** Returns every set. It is used as the list of choices when a sidebar is edited. */
export const sets = () => settings.sets;

/**
 * Changes one sidebar choice. choice is a set id, off or inherit (the sidebar choice in docs/spec/settings.md).
 */
export function link(place, plugin, choice, scope, actor) {
  return set({ links: chooseLink(scopedValue("links", scope), place, plugin, choice) }, scope, actor);
}

/** Returns the set to show at the position. For left and right, the choice of a plugin takes precedence over the general choice. Returns null when there is none. */
export const linkedSet = (place, plugin) => resolveSidebar(settings.links, settings.sets, place, plugin);

/** Returns the current theme name and mode. */
export const themeName = () => settings.theme;
export const modeName = () => settings.mode;

/**
 * The half width (px) of the gap. The plane sets gap to twice this value.
 *
 * When the setting is 0, returns half the line width. With a gap of 0 the rects of the cards touch, so
 * there is no place to draw the boundary line, and two native surfaces also touch, so the line goes behind the surfaces.
 * If the cards are separated by one line, that place becomes the border that the two cards share.
 */
export function halfGap() {
  if (settings.gap > 0) return settings.gap;
  return parseFloat(themeOf(settings.theme).shape.bw) / 2;
}

/** The line width (px) of the current theme. The card border and the rail are drawn with this width. */
export const borderWidth = () => parseFloat(themeOf(settings.theme).shape.bw);

/**
 * The distance (px) by which the plane extends into the stage. It is the bleed of the view.
 *
 * It is the inner margin of the stage, and the line extends out of the plane by that amount to reach the border of the stage.
 * It is not half the gap: at the seam the style sheet sets that margin to 0, and half the gap is
 * half the line width, so using the half would put the line outside a plane that has no margin and
 * draw it over the border.
 */
export const stagePad = () => (seam() === "line" ? 0 : halfGap());

/** The gap value (px) held in the settings. It is the value the slider shows. */
export const gapSetting = () => settings.gap;
