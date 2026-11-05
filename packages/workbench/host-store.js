// A store that asks the native host to read and write the settings file and the project list.
//
// The runtime module of a native application creates this store in openStore().

/**
 * The errors of the refused stored files of a snapshot: the host reports a refused projects.json as projectsError and a
 * refused settings.json as settingsError, and the page shows each of them and starts (docs/spec/projects.md#settings).
 */
export function storedFileErrors(snapshot) {
  return [snapshot.projectsError, snapshot.settingsError].filter((text) => text !== undefined);
}

export class HostWorkspaceStore {
  #listeners = [];
  #listening = null;
  constructor(host) {
    this.host = host;
  }
  /**
   * Calls fn at each change with the read of that change. The registry and the settings of a window both listen, and the host
   * reads two files and answers with the whole registry, so the listeners that read while one call runs share it, and each
   * receives a value of its own. A listener that reads after that call ended calls the host again: its read can wait behind
   * other work, and a write can follow the call that ended.
   */
  onChange(fn) {
    this.#listeners.push(fn);
    if (this.#listeners.length > 1) return this.#listening;
    this.#listening = this.host.on("workspace-changed", () => {
      let reading = null;
      const read = () => {
        if (!reading) {
          reading = this.snapshot();
          const ended = () => { reading = null; };
          reading.then(ended, ended);
        }
        return reading.then((snapshot) => structuredClone(snapshot));
      };
      for (const listener of this.#listeners) listener(read);
    });
    return this.#listening;
  }
  snapshot() { return this.host.call("workspace", { kind: "snapshot" }); }
  add(project) { return this.host.call("workspace", { kind: "add", project }); }
  patch(id, patch) { return this.host.call("workspace", { kind: "patch", id, patch }); }
  tabState() { return this.host.call("workspace", { kind: "tabState" }); }
  tabStatePut(tab, entry) { return this.host.call("workspace", { kind: "tabStatePut", tab, entry }); }
  tabSession(tab) { return this.host.call("workspace", { kind: "tabSession", tab }); }
  tabSessionPut(tab, regions) { return this.host.call("workspace", { kind: "tabSessionPut", tab, regions }); }
  tabSessions() { return this.host.call("workspace", { kind: "tabSessions" }); }
  remove(id) { return this.host.call("workspace", { kind: "remove", id }); }
  move(id, delta) { return this.host.call("workspace", { kind: "move", id, delta }); }
  settings(id, values, cids) {
    const patch = {}, remove = [];
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) remove.push(key);
      else patch[key] = value;
    }
    return this.host.call("workspace", { kind: "settings", id, patch, remove }, { cids });
  }
}
