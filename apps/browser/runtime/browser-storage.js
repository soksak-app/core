// IndexedDB transactions handle duplicate projects and simultaneous changes from several windows.
export class WorkspaceStore {
  constructor(database, channel) {
    this.database = database;
    this.channel = channel;
    this.listeners = new Set();
    if (channel) channel.onmessage = () => this.changed();
  }

  static async open({ indexedDB = globalThis.indexedDB, name = "soksak", channel = true } = {}) {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => {
        const projects = request.result.createObjectStore("projects", { keyPath: "id" });
        projects.createIndex("root", "root", { unique: true });
        projects.createIndex("identity", "identity", { unique: true });
        request.result.createObjectStore("settings");
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("Workspace database is blocked by another window"));
    });
    return new WorkspaceStore(database, channel ? new BroadcastChannel(name) : null);
  }

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  changed() { for (const fn of this.listeners) fn(); }
  close() { this.channel?.close(); this.database.close(); }

  transaction(mode, run) {
    return new Promise((resolve, reject) => {
      const tx = this.database.transaction(["projects", "settings"], mode);
      let result;
      tx.oncomplete = () => {
        if (mode === "readwrite") { this.channel?.postMessage(null); this.changed(); }
        resolve(result);
      };
      // default: A transaction that ended with abort() has a null error, so the abort is turned into an error.
      tx.onabort = () => reject(tx.error ?? new Error("Workspace transaction was aborted"));
      tx.onerror = () => {};
      run(tx.objectStore("projects"), tx.objectStore("settings"), (value) => { result = value; });
    });
  }

  snapshot() {
    return this.transaction("readonly", (projects, settings, done) => {
      const out = { projects: [], common: {} };
      projects.getAll().onsuccess = (e) => { out.projects = e.target.result; };
      // default: IndexedDB get returns undefined for a missing key. A store that never saved common settings has empty common settings.
      settings.get("common").onsuccess = (e) => { out.common = e.target.result ?? {}; };
      settings.get("order").onsuccess = (e) => {
        // default: A store that never added a project has no order record, and its order is an empty list.
        out.order = e.target.result ?? [];
        done(out);
      };
    }).then((out) => ({ ...out, projects: out.order.map((id) => out.projects.find((p) => p.id === id)) }));
  }

  add(project) {
    return this.transaction("readwrite", (projects, settings, done) => {
      projects.index("identity").get(project.identity).onsuccess = (e) => {
        if (e.target.result) { done(e.target.result); return; }
        projects.index("root").get(project.root).onsuccess = (e) => {
          if (e.target.result) { done(e.target.result); return; }
          projects.add(project);
          // default: A store that never added a project has no order record, and its order is an empty list.
          settings.get("order").onsuccess = (e) => settings.put([...(e.target.result ?? []), project.id], "order");
          done(project);
        };
      };
    });
  }

  patch(id, patch) {
    return this.transaction("readwrite", (projects, _, done) => {
      projects.get(id).onsuccess = (e) => {
        if (!e.target.result) { done(false); return; }
        projects.put({ ...e.target.result, ...patch, id });
        done(true);
      };
    });
  }

  remove(id) {
    return this.transaction("readwrite", (projects, settings) => {
      projects.delete(id);
      // default: A store that never added a project has no order record, and its order is an empty list.
      settings.get("order").onsuccess = (e) => settings.put((e.target.result ?? []).filter((key) => key !== id), "order");
    });
  }

  move(id, delta) {
    return this.transaction("readwrite", (_, settings) => {
      settings.get("order").onsuccess = (e) => {
        // default: A store that never added a project has no order record, and its order is an empty list.
        const order = e.target.result ?? [];
        const from = order.indexOf(id), to = from + delta;
        if (from < 0 || to < 0 || to >= order.length) return;
        order.splice(from, 1); order.splice(to, 0, id);
        settings.put(order, "order");
      };
    });
  }

  settings(id, patch) {
    if (id && Object.hasOwn(patch, "projectOpening")) return Promise.reject(new Error("Project opening mode is common-only"));
    return this.transaction("readwrite", (projects, settings) => {
      const store = id ? projects : settings;
      // default: Without an id, the common settings are changed (settings(null, patch)).
      store.get(id ?? "common").onsuccess = (e) => {
        if (id && !e.target.result) return;
        // default: A store that never saved common settings has no common settings record, so the change starts from an empty record. The project record was verified above.
        const record = e.target.result ?? {};
        const values = id ? record.settings : record;
        for (const [key, value] of Object.entries(patch)) {
          if (value === undefined) delete values[key];
          else values[key] = value;
        }
        if (id) projects.put(record);
        else settings.put(values, "common");
      };
    });
  }
}
