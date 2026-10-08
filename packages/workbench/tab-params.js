// The parameters of a tab (docs/spec/plugins.md#pluginjson): checked against the plugin's surface.params when a tab
// opens, stored with the tab, and checked again when a stored tab opens. Stored parameters are not converted.
import { matchesSchema } from "@soksak/plugin-api";

/** Checks the params that core.card.add-tab gives for plugin, whose surface.params is declaration, and returns a copy. */
export function checkTabParams(plugin, declaration, params) {
  if (params === undefined || params === null) return null;
  if (!declaration) throw new Error(`plugin ${plugin} declares no tab params`);
  if (!matchesSchema(declaration, params)) throw new Error(`params do not match ${plugin} surface.params`);
  return structuredClone(params);
}

/** The text that a placeholder shows for a stored tab whose params do not match its plugin, or null when they match. */
export function storedParamsProblem(plugin, version, declaration, params) {
  if (params === undefined || params === null) return null;
  const reason = !declaration ? `plugin ${plugin} declares no tab params`
    : matchesSchema(declaration, params) ? null : `params do not match ${plugin} surface.params`;
  return reason && `${plugin} ${version} 탭의 인자가 선언과 맞지 않습니다: ${reason}`;
}
