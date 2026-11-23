// The parameters of a tab (docs/spec/plugins.md#pluginjson): checked against the plugin's surface.params when a tab
// opens, stored with the tab, and checked again when a stored tab opens. Stored parameters are not converted.
import { matchesSchema } from "@soksak/plugin-api";

/**
 * Why params do not match declaration, or null when they match: the schema check, then the first member in code point order that
 * the properties of the declaration do not name, as the parameters of a command are refused (docs/spec/exposure.md#command-parameters).
 */
function mismatch(plugin, declaration, params) {
  if (!matchesSchema(declaration, params)) return `params do not match ${plugin} surface.params`;
  // default: a declaration without properties names no parameter.
  const declared = declaration.properties ?? {};
  const unknown = Object.keys(params).sort().find((key) => !Object.hasOwn(declared, key));
  return unknown === undefined ? null : `params do not match ${plugin} surface.params: unknown parameter ${unknown}`;
}

/** Checks the params that core.card.add-tab gives for plugin, whose surface.params is declaration, and returns a copy. */
export function checkTabParams(plugin, declaration, params) {
  if (params === undefined || params === null) return null;
  if (!declaration) throw new Error(`plugin ${plugin} declares no tab params`);
  const problem = mismatch(plugin, declaration, params);
  if (problem) throw new Error(problem);
  return structuredClone(params);
}

/** The text that a placeholder shows for a stored tab whose params do not match its plugin, or null when they match. */
export function storedParamsProblem(plugin, version, declaration, params) {
  if (params === undefined || params === null) return null;
  const reason = !declaration ? `plugin ${plugin} declares no tab params` : mismatch(plugin, declaration, params);
  return reason && `${plugin} ${version} 탭의 인자가 선언과 맞지 않습니다: ${reason}`;
}
