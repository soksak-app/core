// The owner routing of a command call of a view or a plugin host (docs/spec/native-surfaces.md#view-surfaces,
// docs/spec/plugin-host.md#command-call). It has no import, so the page modules and the tests load it alone.

/**
 * Runs the command named by a call with the owner checks of the view call: a core command runs through runCore, a command
 * that the plugin registered runs through runOwned, and any other name is refused with the error of the view call.
 *
 *     name      the non-empty command name of the call
 *     params    the params of the call, as the command takes them
 *     options   call: the name of the caller in the refusal text, `view call` or `plugin host call`
 *               plugin: the plugin id of the view or the plugin host
 *               runCore(name, params): runs a core command
 *               runOwned(name, params, owner): runs a command that the plugin registered under its owner
 */
export function runCommandCall(name, params, { call, plugin, runCore, runOwned }) {
  const dot = name.indexOf(".");
  const owner = dot < 0 ? "" : name.slice(0, dot);
  if (owner === "core") return runCore(name, params);
  if (owner === plugin) return runOwned(name, params, plugin);
  if (owner === "") throw new Error(`${call} ${name} names no owner`);
  // The tab and runtime names that the switch of the view calls does not serve are refused as not served, not as the names of another owner.
  if (owner === "tab" || owner === "runtime") throw new Error(`${call} ${name} is not served`);
  throw new Error(`command ${name} belongs to ${owner}, not ${plugin}`);
}
