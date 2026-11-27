// The search of the settings tab (docs/spec/settings.md#search). The query is matched at each input event over the loaded data: the core rows,
// the plugin settings, the installed plugins and the catalog plugins that are not installed. The match is a case-insensitive substring.
import { ALL_ROWS, PAGES } from "./settings-rows.js";
import { matchSettings } from "./settings-match.js";
import { pluginUnits } from "./environment.js";
import { settingDefinitions } from "./settings.js";
import { pluginOperations } from "./installed-plugins.js";
import { badge, button, element } from "./settings-controls.js";
import { coreRowFor, group, scopeSegment } from "./settings-pages.js";
import { projectSelected, commonOnly } from "./settings-state.js";
import { declaredRow, installedRow } from "./settings-plugins.js";

/** The matches of the query over the loaded data, computed by the pure matcher (settings-match.js). */
function matchesOf(query) {
  return matchSettings({
    query,
    rows: ALL_ROWS,
    pluginUnits: pluginUnits(),
    settingDefs: settingDefinitions(),
    plugins: pluginOperations.status().plugins,
  });
}

/** The heading of a core page in the result. */
const pageName = (page) => PAGES.find((item) => item.id === page).name;

/** The element of the search result for the query (docs/spec/settings.md#search). */
export function searchPage(query) {
  const { core, pluginSettings: plugins, installed, catalog, settings: keys } = matchesOf(query.toLowerCase());
  const count = keys.length;
  const head = element("div", "set-search__head");
  head.append(element("h2", "set-search__title", `“${query}” 찾기`));
  head.append(element("p", "set-caption", `${count}개 설정${installed.length ? ` · 플러그인 ${installed.length}개` : ""}`));
  // The scope control follows the rule of the page head: a setting that a project can override shows the segment while a project is selected.
  head.append(projectSelected() && keys.some((key) => !commonOnly(key)) ? scopeSegment(keys.filter((key) => !commonOnly(key))) : badge("전역 전용", "neutral"));
  const out = [head];
  if (count === 0 && installed.length === 0 && catalog.length === 0) {
    out.push(element("p", "set-caption", "일치하는 설정이 없다."));
    return out;
  }
  for (const page of PAGES.map((item) => item.id)) {
    const matches = core.filter((def) => def.page === page);
    if (matches.length === 0) continue;
    const rows = matches.flatMap((def) => [element("p", "set-caption set-search__group", `${pageName(page)} · ${def.group}`), coreRowFor(def)]);
    out.push(group(pageName(page), "", rows));
  }
  for (const [key, def] of plugins) {
    const unit = pluginUnits().find((item) => item.id === def.plugin);
    const label = `플러그인 › ${unit?.name ?? def.plugin}`;
    out.push(group(label, "", [element("p", "set-caption set-search__group", label), ...declaredRow(key, def)]));
  }
  if (installed.length) {
    const list = element("div", "set-plugin-list");
    list.append(...installed.map((item) => installedRow(item)));
    out.push(group("설치된 플러그인", "", [list]));
  }
  if (catalog.length) {
    const names = catalog.slice(0, 4).map((item) => item.name).join(", ") + (catalog.length > 4 ? " …" : "");
    const card = element("div", "set-browse-card");
    card.append(element("p", "set-caption", `찾아보기에 ${catalog.length}개 더 있다`), element("p", "set-caption", names));
    card.append(button("찾아보기에서 보기", { expose: "core.settings-tab.browse-find", command: "core.settings-tab.browse", params: { query }, variant: "sm" }));
    out.push(card);
  }
  return out;
}

/** The matches of a query for the status core.settings-tab: the keys of the settings, the ids of the installed plugins, and the catalog count. */
export function searchResults(query) {
  const { settings, pluginIds, catalogCount } = matchesOf(query.toLowerCase());
  return { settings, plugins: pluginIds, catalog: catalogCount };
}
