// The matching of the settings search (docs/spec/settings.md#search), as a pure function of its inputs: the query, the core rows, the
// plugin units, the plugin setting definitions, the installed plugin rows and the catalog plugin rows. It reads no state and draws nothing.
// The Go host matches the same inputs with the same rule (settings_search.go).

/** Whether a text contains the lower-case needle, ignoring case. */
// default: a text that is absent, such as the description of a row without one, matches no needle.
export const containsNeedle = (text, needle) => String(text ?? "").toLowerCase().includes(needle);

/**
 * The matches of a query. A core row matches when its label, description, group name or key contains the query; a plugin setting when
 * its label, description or plugin name does; an installed or catalog plugin row when its name, id, description or the name of one of its plugin categories does.
 * Installed rows are the status rows that are not available; catalog rows are the available ones.
 */
export function matchSettings({ query, rows, pluginUnits, settingDefs, plugins }) {
  const needle = query.toLowerCase();
  const core = rows.filter((row) => [row.label, row.description, row.group, row.key].some((text) => containsNeedle(text, needle)));
  const pluginSettings = Object.entries(settingDefs).filter(([, def]) => {
    const unit = pluginUnits.find((item) => item.id === def.plugin);
    return [def.label, def.description, unit?.name].some((text) => containsNeedle(text, needle));
  });
  // A plugin row matches by the categories of its plugin unit (docs/spec/settings.md#plugins); a row without a loaded unit has none.
  const categoriesOf = (id) => pluginUnits.find((unit) => unit.id === id)?.categories ?? [];
  const matchesPlugin = (item) => [item.name, item.id, item.description, ...categoriesOf(item.id)].some((text) => containsNeedle(text, needle));
  const installed = plugins.filter((item) => item.state !== "available" && matchesPlugin(item));
  const catalog = plugins.filter((item) => item.state === "available" && matchesPlugin(item));
  return {
    core,
    pluginSettings,
    installed,
    catalog,
    settings: [...core.map((row) => row.key), ...pluginSettings.map(([key]) => key)],
    pluginIds: installed.map((item) => item.id),
    catalogCount: catalog.length,
  };
}
