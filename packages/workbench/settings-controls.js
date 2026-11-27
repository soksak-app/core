// The standard control set of the settings tab (docs/spec/settings.md#controls). Each form has one control, every control runs a declared
// command through the shared binder (commands.js), and every control and every reset, chip and badge of a row follows the scope rule
// (docs/spec/settings.md#scope-of-a-control).
import { mark } from "./commands.js";
import { designIcon, icon } from "./icons.js";
import { isOverridden, commonOnly, projectSelected, projectTitle, state, writeScope } from "./settings-state.js";
import { scopedValue } from "./settings.js";

/** The text of a value in a badge or a chip: a switch shows on or off, a choice shows its label, and a number shows its unit. */
export function valueText(value, labels = null, unit = "") {
  if (typeof value === "boolean") return value ? "켬" : "끔";
  if (labels && Object.hasOwn(labels, value)) return labels[value];
  return `${value}${unit}`;
}

/** Creates an element with a class and a text. */
export function element(tag, className = "", text = null) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== null) el.textContent = text;
  return el;
}

/** Creates a button that runs command with params. key is the target of the control, and expose names the element (docs/spec/exposure.md). */
export function button(label, { expose, command, params = {}, key = null, on = null, disabled = false, variant = "ui", title = null }) {
  const el = element("button", `ui-button set-button set-button--${variant}`, label);
  el.type = "button";
  el.dataset.expose = expose;
  if (key !== null) el.dataset.key = key;
  if (on !== null) el.dataset.on = String(on);
  if (title !== null) el.title = title;
  el.disabled = disabled;
  mark(el, command, params);
  return el;
}

/** An icon-only button, which keeps its title as its name (docs/spec/settings.md#page-head). */
export function iconButton(name, title, { expose, command, params = {}, key = null, disabled = false }) {
  const el = button("", { expose, command, params, key, disabled, variant: "icon", title });
  el.setAttribute("aria-label", title);
  el.insertAdjacentHTML("afterbegin", icon(name));
  return el;
}

/** A status badge: ok, warn, err, acc or neutral, which is the tone of the token of the badge, with the icon of its name when one is given (docs/spec/settings.md#controls). */
export function badge(text, tone = "neutral", { title = null, expose = "core.settings-tab.badge", key = null, iconName = null } = {}) {
  const el = element("span", `set-badge set-badge--${tone}`, text);
  if (iconName !== null) el.insertAdjacentHTML("afterbegin", designIcon(iconName));
  el.dataset.expose = expose;
  if (key !== null) el.dataset.key = key;
  if (title !== null) el.title = title;
  return el;
}

/** A chip, which is a button of a state or a section, and runs its command when it is pressed. */
export function chip(text, tone, { expose, command = null, params = {}, key = null }) {
  const el = command ? button(text, { expose, command, params, key, variant: "chip" }) : element("span", "set-chip", text);
  // default: a chip without a tone is neutral.
  el.classList.add(`set-chip--${tone ?? "neutral"}`);
  if (key !== null) el.dataset.key = key;
  el.dataset.expose = expose;
  return el;
}

/**
 * The row of a setting: its label in bold, its description under the label and its control in the 260-point control column. A row
 * without a label keeps an empty label cell (docs/spec/settings.md#rows). wide rows take the whole row.
 */
export function row({ label = "", description = null, control = null, key = null, wide = false, indent = false, extras = [] }) {
  const el = element("div", "set-row");
  if (wide) el.classList.add("set-row--wide");
  if (indent) el.classList.add("set-row--indent");
  if (key !== null) el.dataset.row = key;
  const head = element("div", "set-row__label");
  const name = element("span", "set-row__name", label);
  head.append(name);
  if (description) head.append(element("p", "set-caption", description));
  el.append(head);
  if (control || extras.length) {
    const column = element("div", "set-row__control");
    if (control) column.append(control);
    column.append(...extras);
    el.append(column);
  }
  return el;
}

/** The control of a choice: a segment for two or three values (docs/spec/settings.md#controls), a select box for four or more. */
export function choice(key, options, now, { command = "core.settings.change", scope = writeScope(), disabled = false } = {}) {
  if (!options.some(([value]) => value === now)) throw new Error(`settings choice ${String(now)} of ${key} is not declared`);
  if (options.length >= 4) return select(key, options, now, { command, params: { key, scope }, disabled, expose: "core.settings-tab.choice" });
  const wrap = element("span", "set-seg");
  wrap.setAttribute("role", "group");
  for (const [value, label] of options) {
    const pressed = value === now;
    const el = button(label, { expose: "core.settings-tab.choice", command, params: { key, value, scope }, key, on: pressed, disabled, variant: "seg" });
    el.setAttribute("aria-pressed", String(pressed));
    wrap.append(el);
  }
  return wrap;
}

/** A select box. Its change runs command with the selected string, which the command converts to the declared type. */
export function select(key, options, now, { command = "core.settings.change", params = { key, scope: writeScope() }, valueName = "value", disabled = false, expose = "core.settings-tab.set" } = {}) {
  if (!options.some(([value]) => value === now)) throw new Error(`settings choice ${String(now)} of ${key} is not declared`);
  const wrap = element("span", "select-field");
  const el = element("select");
  el.dataset.set = key;
  el.dataset.expose = expose;
  el.disabled = disabled;
  mark(el, command, params, valueName);
  for (const [value, label] of options) {
    const item = element("option", "", label);
    item.value = String(value);
    if (value === now) {
      item.selected = true;
      item.setAttribute("selected", "");
    }
    el.append(item);
  }
  wrap.append(el);
  return wrap;
}

/** A switch of an on or off value. */
export function toggle(key, now, { command = "core.settings.change", params = null, scope = writeScope(), valueName = "value", label = null, disabled = false, expose = "core.settings-tab.set" } = {}) {
  const el = element("input", "set-switch");
  el.type = "checkbox";
  el.checked = now === true;
  el.disabled = disabled;
  el.dataset.set = key;
  el.dataset.expose = expose;
  if (label !== null) el.setAttribute("aria-label", label);
  // default: a control without command parameters marks its key and scope.
  mark(el, command, params ?? { key, scope }, valueName);
  return el;
}

/** A slider of an integer range. Its command runs once, when the drag ends (docs/spec/settings.md#performance). */
export function slider(key, [min, max], now, { unit = "", command = "core.settings.change", scope = writeScope(), disabled = false } = {}) {
  const wrap = element("span", "set-slide");
  const el = element("input");
  el.type = "range";
  el.min = String(min);
  el.max = String(max);
  el.step = "1";
  el.value = String(now);
  el.disabled = disabled;
  el.dataset.set = key;
  el.dataset.expose = "core.settings-tab.set";
  mark(el, command, { key, scope }, "value");
  const out = element("output", "", `${now}${unit}`);
  // The value that the output shows follows the drag without a command; the command runs at the release.
  el.addEventListener("input", () => { out.textContent = `${el.value}${unit}`; });
  wrap.append(el, out);
  return wrap;
}

/** A stepper − value + of an integer range, with its unit inside (docs/spec/settings.md#controls). */
export function stepper(key, [min, max], now, { unit = "", command = "core.settings.change", scope = writeScope(), disabled = false } = {}) {
  const wrap = element("span", "set-step");
  const down = button("−", { expose: "core.settings-tab.step", command, params: { key, value: now - 1, scope }, key, disabled: disabled || now <= min, variant: "icon", title: "줄이기" });
  const out = element("output", "set-step__value", `${now}${unit}`);
  const up = button("+", { expose: "core.settings-tab.step", command, params: { key, value: now + 1, scope }, key, disabled: disabled || now >= max, variant: "icon", title: "늘리기" });
  wrap.append(down, out, up);
  return wrap;
}

/** A one-line text field that stores its value on Enter and on blur (docs/spec/settings.md#controls). */
export function textField(key, { command, params = {}, now = "", maxLength = 40, mono = false, expose = "core.settings-tab.text", valueName = "value" }) {
  const el = element("input", `text-field${mono ? " text-field--mono" : ""}`);
  el.type = "text";
  el.value = now;
  el.maxLength = maxLength;
  el.dataset.set = key;
  el.dataset.expose = expose;
  mark(el, command, params, valueName);
  return el;
}

/** The reset control ↺ of a project override, which removes the project value (docs/spec/settings.md#scope-of-a-control). */
export function resetButton(key, label) {
  return iconButton("rotate-cw", `${label} 전역 값으로 되돌리기`, {
    expose: "core.settings-tab.reset", command: "core.settings.reset", params: { key, scope: "project" }, key,
  });
}

/**
 * The scope marks of the row of key, in the scope that the tab shows (docs/spec/settings.md#scope-of-a-control):
 * the project scope shows the badge `<project> value` and the reset control of an override, or the badge `global only` of a common-only setting;
 * the common scope shows the chip `<project>: <value>` of an override, which opens the project scope.
 */
export function scopeMarks(key, label, valueLabels = null, unit = "") {
  const marks = [];
  if (state.scope === "project") {
    if (commonOnly(key)) marks.push(badge("전역 전용", "neutral"));
    else if (isOverridden(key)) {
      marks.push(badge(`${projectTitle()} 값`, "acc", { expose: "core.settings-tab.override", key }));
      marks.push(resetButton(key, label));
    }
  } else if (isOverridden(key) && !commonOnly(key)) {
    const projectValue = valueText(projectOverride(key), valueLabels, unit);
    marks.push(chip(`${projectTitle()}: ${projectValue}`, "warn", {
      expose: "core.settings-tab.applied", command: "core.settings-tab.scope", params: { scope: "project" }, key: `applied:${key}`,
    }));
  }
  return marks;
}

/** The project value of key: the applied value of the selected project, which is its override while the project overrides key. */
function projectOverride(key) {
  if (!projectSelected()) throw new Error(`no project is selected for the override of ${key}`);
  return scopedValue(key, "project");
}

/** Whether a row can be changed in the current scope: a common-only setting is disabled in the project scope. */
export const editable = (key) => !(state.scope === "project" && commonOnly(key));
