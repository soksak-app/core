// The call route of a view (docs/spec/native-surfaces.md#view-surfaces). The host forwards each call request of a view as the
// view-call event of the main page; answerViewCall answers it with the handlers that a DOM surface context uses.

/**
 * Answers one call request of a view of plugin and resolves with its result. It rejects with the reason of a refusal, and it runs
 * nothing that the request does not name.
 *
 *     request   {command, params} of the call request
 *     options   plugin: the plugin id of the view
 *               tab: {read()} of the tab state of the surface, or null when the plugin declares no surface.unload
 *               runCore(name, params): runs a core command, as runtime.command does
 *               runOwned(name, params, owner): runs a command that the plugin registered, as the exposure owner check does
 */
export async function answerViewCall({ command, params }, { plugin, tab, runCore, runOwned }) {
  if (command === "tab.state.read") {
    if (!tab) throw new Error(`view call ${command}: the tab state is not declared`);
    return tab.read();
  }
  const dot = command.indexOf(".");
  const owner = dot < 0 ? "" : command.slice(0, dot);
  if (owner === "core") return runCore(command, params);
  if (owner === plugin) return runOwned(command, params, plugin);
  if (owner === "") throw new Error(`view call ${command} names no owner`);
  throw new Error(`command ${command} belongs to ${owner}, not ${plugin}`);
}
