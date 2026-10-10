// The plugin search of the settings window (plugin section in docs/spec/settings.md).

/** Returns, in order, the plugins whose id, name, or description contains the query. It ignores case, and an empty query matches all. */
export function matchPlugins(units, query) {
  const needle = query.toLowerCase();
  return units.filter((u) => [u.id, u.name, u.description].some((text) => text.toLowerCase().includes(needle)));
}
