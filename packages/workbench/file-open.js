// Chooses the plugin that opens a file with core.file.open, from the surface.opens declarations of the loaded plugins
// (docs/spec/plugins.md#pluginjson). Only a declared extension connects a file to a plugin: a file whose extension no plugin
// declares has no opener, and two plugins that declare the extension are an error, not a choice.

/** The extension of the file name of path in lowercase, or null for a name without one. */
function extensionOf(path) {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : null;
}

/** The id of the plugin that opens path; plugins are {id, opens}, with opens the declared extensions or null. */
export function chooseOpener(plugins, path) {
  const extension = extensionOf(path);
  const openers = extension === null ? [] : plugins.filter((plugin) => plugin.opens?.includes(extension));
  if (openers.length === 0) throw new Error(`no plugin opens ${path}`);
  if (openers.length > 1) throw new Error(`${path} is opened by ${openers.map((plugin) => plugin.id).join(" and ")}`);
  return openers[0].id;
}

/** Returns path when it is relative to the project root and has no .. segment. */
export function checkOpenPath(path) {
  if (typeof path !== "string" || path === "" || path.startsWith("/") || path.split("/").includes("..")) {
    throw new Error(`path must be relative to the project root: ${path}`);
  }
  return path;
}
