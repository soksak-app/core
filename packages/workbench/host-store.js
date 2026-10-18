// A store that asks the native host to read and write the settings file and the project list.
//
// The runtime module of a native application creates this store in openStore().

export class HostWorkspaceStore {
  constructor(host) {
    this.host = host;
  }
  onChange(fn) { return this.host.on("workspace-changed", fn); }
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
