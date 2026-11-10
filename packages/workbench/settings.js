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
import { reportTraceAtStart, setTraceEnabled } from "./performance.js";
import { setLogPolicy } from "./log-policy.js";
import { logPolicyOf } from "./log-gate.js";
import { CLASSES } from "./event-classes.js";
import { beginOperation } from "./operations.js";
import declaration from "./workbench.json" with { type: "json" };

/* The theme catalog, the fonts, the menu languages and the setting definitions are the declaration file workbench.json, which every host
   library embeds as it is (docs/spec/settings.md#values). This module reads them from it and holds no copy. */

/* The selectable fonts. A theme designates one of them as its default, and the settings change it.
   A name that is not installed falls through to the next name of the list. */
export const FONTS = declaration.fonts;

/* The themes: the shape (r, gap, bw, font, size) and the dark and light colors. A theme whose gap is 0 makes the cards touch and share
   one boundary line. */
export const THEMES = declaration.themes;

export const MODES = declaration.modes;

/* The theme of the defaults. Its shape gives the defaults of the four shape settings. */
const defaultTheme = THEMES.find((theme) => theme.name === declaration.settings.defaults.theme);
if (!defaultTheme) throw new Error(`the default theme ${declaration.settings.defaults.theme} is not a theme of workbench.json`);

/**
 * The current settings. A single object that is the JSON storage format as it is.
 *
 * With a variable per value, the list of stored values would need separate management and would have to
 * be edited whenever a value is added.
 *
 *   projectOpening   how a project opens: tabs or windows
 *   theme, mode      the theme and its dark or light variant
 *   language         the language of the application menu. auto = the system language (the default language if it is not supported)
 *   diagnostics.performance
 *                    the performance trace, present in every build. When it is on, the layers store the events of the trace in the event
 *                    files under <config-dir>/logs; when it is off, no layer builds or stores one. It is off by default and the debug switch
 *                    turns it on (docs/spec/settings.md, the section of core.settings.debug)
 *   diagnostics.log  the policy of the event log (docs/spec/logging.md#classes-and-policy): the least severe level that is stored for the
 *                    classes that the object names, one of off, error, warn, info, debug and trace; a class it does not name stores the level
 *                    error. The default stores only the errors of every class, and the debug switch sets every class to trace
 *   projectTabs      the position of the project tabs. top = the chrome row, left = the vertical list on the left
 *   left, right      whether the left and right regions are shown. links decides what they show
 *   dim              whether a surface that lost focus is dimmed
 *   focusInd         how the focused card is shown. border = a border, corner = marks at the four corners
 *   fullRule         where the boundary line of the section that a card crosses is drawn. over = over the surface, under = under the card,
 *                    none = not drawn
 *   gap, radius, font, size
 *                    the half width (px) of the gap (0 = the cards share one line), the corner radius (px) of a card (--r-sm and --r-xs are
 *                    derived from it), the font (an id of FONTS) and the font size (px). They start at the shape of the default theme, and
 *                    from then on the value the user specified is used. Choosing the theme again returns them to the values of that theme
 *   textSize         the scale of the text size applied to the frame chrome and every card: a value of TEXT_STEPS (docs/spec/text-size.md)
 *   sets, links      a sidebar is made by combining sets. A set holds sections in order, and links connects a set to a position. A link
 *                    uses the id, not the title. The defaults are decided by the sidebars of environment.json (setSidebarDefaults)
 *   sidebarMinWidth, sidebarMaxWidth, sidebarWidth
 *                    layout values (pt): the minimum and maximum width of a card sidebar and the initial width of a new sidebar
 *                    (docs/spec/settings.md)
 *   memorySaver, memorySaverDelay
 *                    the memory saver (docs/spec/plugins.md#memory-saver): whether hidden tabs are unloaded, and the minutes a tab stays
 *                    hidden before it is unloaded. Both are common-only
 */
export const defaults = {
  ...declaration.settings.defaults,
  gap: parseFloat(defaultTheme.shape.gap),
  radius: parseFloat(defaultTheme.shape.r),
  font: defaultTheme.shape.font,
  size: parseFloat(defaultTheme.shape.size),
};

/* The range of memorySaverDelay in minutes (docs/spec/settings.md#values). */
export const MEMORY_SAVER_DELAY = declaration.settings.memorySaverDelay;

/* The range of the layout values. Only integers are accepted. The three values share one range so that the same value is at the same slider position. */
export const LAYOUT_RANGES = declaration.settings.layoutRanges;

/* The languages that the application menu supports. A new language is added to this declaration and to the menu table of the host contract together. */
export const MENU_LANGUAGES = declaration.menuLanguages;
/* The default language used when the system language is not in the table. */
const DEFAULT_LANGUAGE = declaration.defaultLanguage;

/* The range (px) of the shape values. Only integers are accepted, and the slider of the settings window uses the same range. */
export const SHAPE_RANGES = declaration.settings.shapeRanges;

/* The core settings that take one choice. The select control of the settings window shows the choices in this order (docs/spec/settings.md#values).
   workbench.json states the fixed lists; the theme, mode, font, text size and language choices are the catalogs above. */
const { projectOpening, projectTabs, focusInd, fullRule } = declaration.settings.choices;
export const CHOICES = {
  projectOpening,
  theme: THEMES.map((theme) => theme.name),
  mode: MODES,
  font: FONTS.map((font) => font.id),
  textSize: TEXT_STEPS,
  projectTabs,
  focusInd,
  fullRule,
  language: ["auto", ...MENU_LANGUAGES.map((language) => language.id)],
};

/* The core settings that take an integer range. The layout values and the shape values do not share keys. */
const RANGES = { ...LAYOUT_RANGES, ...SHAPE_RANGES };

/* The core settings that take a boolean. */
const SWITCHES = declaration.settings.switches;

/* The core settings that hold an object or a list: the log policy, and the sets and links that checkSidebars validates. */
const STRUCTURED = ["diagnostics.log", "sets", "links"];

/* The core settings whose value is an order of their listed values, each once: the order of the window sidebars
   (docs/spec/settings.md#values). The order rows of the settings window show the values in the current order. */
export const ORDERS = declaration.settings.orders;

/** Whether value is an array that holds each of the values once. */
function isOrder(value, values) {
  return Array.isArray(value) && value.length === values.length && values.every((item) => value.includes(item));
}

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
/* Whether a refresh reported the stored switch at the start of the page; only a later change takes the change path. */
let reported = false;
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
  if (Object.hasOwn(ORDERS, key) && !isOrder(value, ORDERS[key])) {
    throw new Error(`Invalid setting ${key}: ${JSON.stringify(value)} is not an order of ${ORDERS[key].map((item) => JSON.stringify(item)).join(", ")}`);
  }
  if (key === "diagnostics.log") {
    try {
      logPolicyOf(value);
    } catch (error) {
      throw new Error(`Invalid setting ${key}: ${error.message}`, { cause: error });
    }
    for (const [name, level] of Object.entries(value)) {
      if (!["off", "error", "warn", "info", "debug", "trace"].includes(level)) {
        throw new Error(`Invalid setting ${key}: the level ${JSON.stringify(level)} of the class ${name} is not one of off, error, warn, info, debug, trace`);
      }
    }
  }
  if (key === "memorySaverDelay" && (!Number.isInteger(value) || value < MEMORY_SAVER_DELAY[0] || value > MEMORY_SAVER_DELAY[1])) {
    throw new Error(`Invalid setting memorySaverDelay: ${JSON.stringify(value)}`);
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

/** The JavaScript type of the values of a setting, which its declaration decides. */
export function settingType(key) {
  if (SWITCHES.includes(key)) return "boolean";
  if (STRUCTURED.includes(key) || Object.hasOwn(ORDERS, key)) return "object";
  if (Object.hasOwn(RANGES, key) || key === "memorySaverDelay") return "number";
  if (CHOICES[key]) return typeof CHOICES[key][0];
  const definition = pluginDefinitions.get(key);
  if (!definition) throw new Error(`Unknown setting: ${key}`);
  if (definition.type === "integer") return "number";
  if (definition.type === "enum") return typeof definition.values[0];
  return "string";
}

/**
 * The value of a setting from the input of a control. A control gives a string, so a string becomes the boolean or the number that the
 * setting declares; every other input stays as it is, and validateValue refuses a value of another type with its cause.
 */
export function controlValue(key, input) {
  if (typeof input !== "string") return input;
  const type = settingType(key);
  if (type === "boolean" && (input === "true" || input === "false")) return input === "true";
  if (type === "number" && input.trim() !== "" && Number.isFinite(Number(input))) return Number(input);
  return input;
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
 * The memory saver settings are common-only because the memory of the application is shared by its projects (docs/spec/settings.md#values).
 */
export const COMMON_ONLY = declaration.settings.commonOnly;

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
  store.onChange((read) => { if (!changes) return refresh(read).catch((e) => dispatchEvent(new ErrorEvent("error", { message: e.message }))); });
  await refresh();
}

// default: a read that no change of the store gave reads the store itself.
async function refresh(read = () => store.snapshot()) {
  const mine = ++revision;
  const snapshot = await read();
  if (changes || mine !== revision) return;
  const project = snapshot.projects.find((p) => p.id === projectId);
  // The settings file of the shown project that the host now refuses is reported, and the applied settings stay
  // (docs/spec/projects.md#settings).
  if (project?.settingsError) throw new Error(project.settingsError);
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
  // The first refresh that applied the snapshot reports the stored switch unchanged: the switch of the host can be on
  // from a page that ended while the stored setting says off, and only this report turns a stale switch off
  // (docs/spec/performance-trace.md#the-switch). A refresh that bailed on an in-flight change reports nothing, so the
  // first report always carries the stored value and never the defaults.
  if (reported) await setTraceEnabled(settings["diagnostics.performance"]);
  else {
    reported = true;
    await reportTraceAtStart(settings["diagnostics.performance"]);
  }
  await setLogPolicy(settings["diagnostics.log"]);
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
/** The sets and links of a project that is not necessarily the selected one: its own overrides over the common settings. */
export function projectSidebars(project) {
  // default: a project that overrides no setting has no settings.
  const { sets, links } = effectiveSettings(defaults, applied(common), applied(project.settings ?? {}));
  return { sets, links };
}
export const scopedValue = (key, scope) => scope === "common"
  // default: a setting without a stored common value takes its default value.
  ? (common[key] ?? defaults[key]) : settings[key];
export const overridden = (key) => Object.hasOwn(overrides, key);
/** The scope that the applied value of key comes from: the project while the selected project overrides key, and otherwise the common scope (docs/spec/settings.md#scope-of-a-control). */
export const sourceScope = (key) => (projectId && overridden(key) ? "project" : "common");
/** The parameters of core.settings.set that write value of key to the scope that the applied value of key comes from. */
export const appliedPatch = (key, next) => ({ patch: { [key]: next }, scope: sourceScope(key) });
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
 * what changes the settings: the command, or the surface of a gesture. The change is the operation `workbench.settings.change`
 * (docs/spec/logging.md#operation-chains), and its identifiers go with the write to the host.
 */
export function set(patch, scope = projectId ? "project" : "common", actor) {
  if (typeof actor !== "string" || actor === "") throw new Error("set requires the actor that changes the settings");
  const id = scope === "project" ? projectId : null;
  if (scope === "project" && !id) throw new Error("No project is selected");
  for (const key of COMMON_ONLY) if (id && Object.hasOwn(patch, key)) throw new Error(`${key} is common-only`);
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
  const cids = beginOperation("workbench.settings.change", { scope: id ? "project" : "common", actor, keys: Object.keys(patch).join(",") });
  for (const [key, val] of Object.entries(patch)) {
    if (val === undefined) delete target[key];
    else target[key] = val;
  }
  changes++;
  revision++;
  apply();
  const propagation = Promise.all([
    Object.hasOwn(patch, "diagnostics.performance") ? setTraceEnabled(settings["diagnostics.performance"]) : undefined,
    Object.hasOwn(patch, "diagnostics.log") ? setLogPolicy(settings["diagnostics.log"], cids) : undefined,
  ]);
  const saved = Promise.all([writing, propagation]).then(() => store.settings(id, patch, cids));
  const finished = saved.finally(async () => {
    changes--;
    if (changes) return;
    await refresh();
    savedListener();
  });
  // The refusal reaches the caller through finished; the next write does not depend on it.
  writing = finished.then(() => undefined, () => undefined);
  return finished;
}

/**
 * Turns the debug switch on or off (docs/spec/settings.md, the section of core.settings.debug). On sets the trace on and every class of the policy to trace; off sets the
 * trace off and the policy to the empty object, which stores only the errors. Both values are common settings.
 */
export function setDebug(on, actor) {
  return set({
    "diagnostics.performance": on,
    "diagnostics.log": on ? Object.fromEntries(CLASSES.map((name) => [name, "trace"])) : {},
  }, "common", actor);
}

/** Whether the debug switch is on: the trace is on and every class of the policy is at trace. */
export const debugOn = () => settings["diagnostics.performance"] === true
  && CLASSES.every((name) => settings["diagnostics.log"][name] === "trace");

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
  installTokens(root);
  // A page that the host serves does not inherit the style sheet of this document, so the values are
  // sent separately.
  host.theme(pageTheme());
  // The language of the application menu. The host recreates the menu only when the effective language changes.
  host.menuLanguage(menuLanguage());
}

/**
 * Sets the theme tokens of the current settings on root. Before the settings connect they are the tokens of the default theme, so the page
 * sets them first and an error that stops the start is shown in the shape of the default theme.
 */
export function installTokens(root) {
  for (const [token, value] of Object.entries(themeTokens())) {
    root.style.setProperty(token, value);
  }
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
