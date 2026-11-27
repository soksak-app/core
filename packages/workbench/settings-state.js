// The state of the settings tab (docs/spec/settings.md#settings-tab). It lives while the window lives and no file stores it. The pages, the
// controls and the commands of settings-ui.js read and change it through the functions of this module.
import { COMMON_ONLY, defaults, overridden, scopedValue, settingProject, settingProjectRoot } from "./settings.js";
import * as projects from "./projects.js";

/** The page of the tab and its scope. The scope is project only while a project is selected (docs/spec/settings.md#page-head). */
export const state = {
  page: "look",
  scope: "common",
  /** The text of the menu search. An empty text shows the page. */
  find: "",
  /** The text of the installed-plugin search. */
  query: "",
  /** The filter of 설치됨: all, active, disabled, updates or problems. */
  filter: "all",
  /** The search text, the switch and the number of catalog rows shown in 찾아보기. */
  browse: { query: "", hideInstalled: false, shown: 30 },
  /** The plugin whose page is shown, or null. */
  plugin: null,
  /** The page that the back link of a plugin page returns to: installed or browse. */
  back: "installed",
  /** The id of the set in edit, or null. */
  editing: null,
  /** The removal that waits for the answer of the person: {kind, id} with kind set or plugin, or null (docs/spec/settings.md#status). */
  confirm: null,
  /** The fields of the group 계정 of the shown plugin page (docs/spec/settings.md#plugin-page). */
  account: { plugin: null, name: "", kind: null, edit: null, editName: "" },
};

/** Whether a project is selected, so that the project scope exists (docs/spec/settings.md#page-head). */
export const projectSelected = () => settingProject() !== null;

/** The title of the selected project, which names the project scope in the labels of the tab. */
export function projectTitle() {
  const id = settingProject();
  const project = projects.all().find((item) => item.id === id);
  if (!project) throw new Error(`the selected project ${id} is not in the project list`);
  return project.title;
}

/** Sets the scope; the project scope falls back to the common scope when no project is selected. */
export function setScope(next) {
  state.scope = next === "project" && projectSelected() ? "project" : "common";
}

/** The value a control of key shows in the current scope: the project value when the project scope applies, otherwise the common value. */
export const shownValue = (key) => scopedValue(key, state.scope);

/** Whether the current scope shows a project override of key: the project scope, or the common scope of a project with an override. */
export const isOverridden = (key) => projectSelected() && overridden(key);

/** Whether key is a setting that only the common scope holds (docs/spec/settings.md#scope-of-a-control). */
export const commonOnly = (key) => COMMON_ONLY.includes(key);

/** The scope that a write of a control goes to: the scope the tab shows (docs/spec/settings.md#scope-of-a-control). */
export const writeScope = () => state.scope;

/** The folder of the selected project, or null. */
export const projectFolder = () => settingProjectRoot();

/** The default value of key, which a reset of the common scope shows. */
export const defaultOf = (key) => defaults[key];

