// The page 사이드바 세트 of the settings tab: the list of the sets, the confirmation of a removal, and the editor of one set
// (docs/spec/settings.md#사이드바-세트). Every change runs a declared core command of the sets, and the scope of a change is the scope the tab shows.
import { pluginUnits } from "./environment.js";
import { missingChipNode, missingGroups, missingLineNode, pluginRowsNow } from "./missing-plugins.js";
import { hasSection, section, sectionNames } from "./registry.js";
import { mark } from "./commands.js";
import { badge, button, chip, element, row, textField } from "./settings-controls.js";
import { group } from "./settings-pages.js";
import { state, shownValue, writeScope, isOverridden, projectTitle } from "./settings-state.js";

/** The names of the places that use a set: the sides and the plugin windows, in link order (docs/spec/settings.md#사이드바-세트). */
function usesOf(setId) {
  const names = [];
  for (const link of shownValue("links")) {
    if (link.set !== setId) continue;
    names.push(linkName(link));
  }
  return names;
}

/** The name of a link's place for the line 쓰는 곳 (docs/spec/settings.md#사이드바-세트). */
const SIDE_LABEL = { left: "왼쪽", right: "오른쪽", top: "위", bottom: "아래" };
function linkName(link) {
  // default: a place without a side label is shown as its place.
  if (link.plugin === null) return SIDE_LABEL[link.place] ?? link.place;
  const [, side] = link.place.split("-");
  const name = pluginNameOf(link.plugin);
  // default: a side without a label is shown as its name.
  return `${name} 창 ${SIDE_LABEL[side] ?? side}`;
}

/** The name of a plugin of this window, or its id when the plugin is not loaded. */
// default: a plugin that is not loaded is named by its id.
const pluginNameOf = (id) => pluginUnits().find((unit) => unit.id === id)?.name ?? id;

/** The sections of a set with the badge 불러오지 않음 for a section of a plugin that is not loaded (docs/spec/settings.md#사이드바-세트). */
function sectionChips(set, { removable }) {
  const wrap = element("span", "set-chips");
  if (set.sections.length === 0) {
    wrap.append(element("span", "set-caption", "섹션 없음"));
    return wrap;
  }
  set.sections.forEach((id, index) => {
    const name = sectionNames([id])[0];
    const item = element("span", "set-chip-group");
    if (hasSection(id)) item.append(element("span", "set-chip set-chip--neutral", name));
    else item.append(missingChipNode(document, id, missingGroups([id], pluginRowsNow())[0]));
    if (removable) {
      item.append(button("×", {
        expose: "core.settings-tab.row-act", command: "core.settings.sets.row",
        params: { id: set.id, action: "remove", index, scope: writeScope() }, variant: "icon", title: `${name} 빼기`,
      }));
    }
    wrap.append(item);
  });
  return wrap;
}

/** The row of one set in the list (docs/spec/settings.md#사이드바-세트). */
export function setRow(set) {
  const title = set.title === "" ? "(이름 없음)" : set.title;
  const head = element("span", "set-set__head");
  head.append(element("span", "set-set__title", title), badge(set.layout === "tabs" ? "탭" : "목록", "neutral"));
  const uses = usesOf(set.id);
  const lines = [head];
  // One warning line for each plugin of the set that cannot be loaded (docs/spec/plugins.md#missing-plugins).
  for (const group of missingGroups(set.sections, pluginRowsNow())) {
    const warning = missingLineNode(document, group);
    if (warning !== null) lines.push(warning);
  }
  if (uses.length) lines.push(element("span", "set-caption", `· 쓰는 곳: ${uses.join(", ")}`));
  lines.push(sectionChips(set, { removable: false }));
  const actions = element("span", "set-set__actions");
  if (state.editing === set.id) {
    actions.append(button("완료", { expose: "core.settings-tab.edit", command: "core.settings-tab.edit", params: { set: null }, variant: "primary" }));
  } else {
    actions.append(button("편집", { expose: "core.settings-tab.edit", command: "core.settings-tab.edit", params: { set: set.id }, variant: "sm" }));
  }
  actions.append(button("삭제", { expose: "core.settings-tab.delete", command: "core.settings-tab.confirm", params: { kind: "set", id: set.id, answer: "ask" }, variant: "ghost" }));
  const el = element("div", "set-set");
  el.dataset.set = set.id;
  el.append(...lines, actions);
  if (state.confirm && state.confirm.kind === "set" && state.confirm.id === set.id) el.append(confirmation(set, uses));
  return el;
}

/** The confirmation under the row of a set: the buttons 취소 (answer no) and 삭제 (answer yes) (docs/spec/settings.md#사이드바-세트). */
function confirmation(set, uses) {
  const wrap = element("div", "set-confirm");
  const text = uses.length ? "쓰는 곳은 “사용 안 함”이 된다." : "삭제할까?";
  wrap.append(element("span", "set-caption", text));
  wrap.append(button("취소", { expose: "core.settings-tab.confirm-no", command: "core.settings-tab.confirm", params: { kind: "set", id: set.id, answer: "no" }, variant: "ghost" }));
  wrap.append(button("삭제", { expose: "core.settings-tab.confirm-yes", command: "core.settings-tab.confirm", params: { kind: "set", id: set.id, answer: "yes" }, variant: "danger" }));
  return wrap;
}

/** The select box of the sections that the set does not contain, grouped by plugin in plugin and declaration order (docs/spec/settings.md#사이드바-세트). */
function addSection(set) {
  const contained = new Set(set.sections);
  const wrap = element("span", "select-field");
  const el = element("select");
  el.dataset.expose = "core.settings-tab.add";
  el.dataset.set = `add:${set.id}`;
  el.setAttribute("aria-label", "섹션 추가…");
  const first = element("option", "", "섹션 추가…");
  first.value = "";
  el.append(first);
  let any = false;
  for (const unit of pluginUnits()) {
    const free = unit.sections.filter((id) => !contained.has(id));
    if (free.length === 0) continue;
    const band = element("optgroup");
    band.label = unit.name;
    for (const id of free) {
      const option = element("option", "", `${section(id).name} · ${unit.id}`);
      option.value = id;
      band.append(option);
      any = true;
    }
    el.append(band);
  }
  el.disabled = !any;
  mark(el, "core.settings.sets.row", { id: set.id, action: "add", scope: writeScope() }, "section");
  wrap.append(el);
  return wrap;
}

/** The editor of one set: its name, its layout, its sections as chips with ×, the select 섹션 추가… and the line on saving (docs/spec/settings.md#사이드바-세트). */
function editor(set) {
  const name = textField(`title:${set.id}`, {
    command: "core.settings.sets.update", params: { id: set.id, scope: writeScope() }, now: set.title, maxLength: 40,
    expose: "core.settings-tab.set-title", valueName: "title",
  });
  const layout = element("span", "set-seg");
  layout.setAttribute("role", "group");
  for (const [value, label] of [["list", "목록"], ["tabs", "탭"]]) {
    const pressed = value === set.layout;
    const option = button(label, { expose: "core.settings-tab.layout", command: "core.settings.sets.update", params: { id: set.id, layout: value, scope: writeScope() }, on: pressed, variant: "seg" });
    option.setAttribute("aria-pressed", String(pressed));
    layout.append(option);
  }
  const sections = sectionChips(set, { removable: true });
  const wrap = element("div", "set-editor");
  wrap.dataset.set = set.id;
  wrap.append(
    row({ label: "이름", control: name, key: `title:${set.id}` }),
    row({ label: "배치", control: layout, key: `layout:${set.id}` }),
    row({ label: "섹션", control: sections, key: `sections:${set.id}`, extras: [addSection(set)] }),
    element("p", "set-caption", "바꾼 값은 바로 저장된다. 같은 섹션은 한 세트에 한 번만 들어간다."),
    button("완료", { expose: "core.settings-tab.edit", command: "core.settings-tab.edit", params: { set: null }, variant: "primary" }),
  );
  return wrap;
}

/** The page 사이드바 세트: the list of the sets, the button 새 세트, and the editor of the set in edit (docs/spec/settings.md#사이드바-세트). */
export function setsPage() {
  const sets = shownValue("sets");
  if (state.editing !== null && !sets.some((set) => set.id === state.editing)) state.editing = null;
  const list = element("div", "set-list");
  if (sets.length === 0) list.append(element("p", "set-caption", "세트가 없다. 새 세트를 만들어 사이드바에 보여 줄 섹션을 고른다."));
  for (const set of sets) list.append(setRow(set));
  const create = button("새 세트", { expose: "core.settings-tab.create", command: "core.settings.sets.create", params: { scope: writeScope() }, variant: "primary" });
  const parts = [list, create];
  if (state.scope === "common" && isOverridden("sets")) {
    parts.push(chip(`${projectTitle()}: 세트 ${sets.length}개`, "warn", { expose: "core.settings-tab.applied", command: "core.settings-tab.scope", params: { scope: "project" }, key: "applied:sets" }));
  }
  const body = [group("세트", "사이드바에 보여 줄 섹션 묶음. 어느 변에 놓을지는 작업 공간과 플러그인에서 고른다.", parts)];
  const edited = sets.find((set) => set.id === state.editing);
  if (edited) body.push(group(`세트 편집: ${edited.title}`, "바꾼 값은 바로 저장된다. 같은 섹션은 한 세트에 한 번만 들어간다.", [editor(edited)]));
  return body;
}
