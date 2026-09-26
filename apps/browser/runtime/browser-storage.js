// IndexedDB 트랜잭션이 프로젝트 중복과 여러 창의 동시 수정을 처리한다.
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
      // 기본값: abort() 로 끝난 트랜잭션은 error 가 null 이므로 중단 사실을 오류로 만든다.
      tx.onabort = () => reject(tx.error ?? new Error("Workspace transaction was aborted"));
      tx.onerror = () => {};
      run(tx.objectStore("projects"), tx.objectStore("settings"), (value) => { result = value; });
    });
  }

  snapshot() {
    return this.transaction("readonly", (projects, settings, done) => {
      const out = { projects: [], common: {} };
      projects.getAll().onsuccess = (e) => { out.projects = e.target.result; };
      // 기본값: IndexedDB 의 get 은 없는 키에 undefined 를 돌려준다. 공통 설정을 한 번도 저장하지 않은 저장소의 공통 설정은 비어 있다.
      settings.get("common").onsuccess = (e) => { out.common = e.target.result ?? {}; };
      settings.get("order").onsuccess = (e) => {
        // 기본값: 프로젝트를 한 번도 추가하지 않은 저장소에는 순서 기록이 없고, 그 순서는 빈 목록이다.
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
          // 기본값: 프로젝트를 한 번도 추가하지 않은 저장소에는 순서 기록이 없고, 그 순서는 빈 목록이다.
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
      // 기본값: 프로젝트를 한 번도 추가하지 않은 저장소에는 순서 기록이 없고, 그 순서는 빈 목록이다.
      settings.get("order").onsuccess = (e) => settings.put((e.target.result ?? []).filter((key) => key !== id), "order");
    });
  }

  move(id, delta) {
    return this.transaction("readwrite", (_, settings) => {
      settings.get("order").onsuccess = (e) => {
        // 기본값: 프로젝트를 한 번도 추가하지 않은 저장소에는 순서 기록이 없고, 그 순서는 빈 목록이다.
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
      // 기본값: id 가 없으면 공통 설정을 바꾼다(settings(null, patch)).
      store.get(id ?? "common").onsuccess = (e) => {
        if (id && !e.target.result) return;
        // 기본값: 공통 설정을 한 번도 저장하지 않은 저장소의 공통 설정 기록은 없고, 빈 기록에서 시작한다. 프로젝트 기록은 위에서 확인했다.
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
