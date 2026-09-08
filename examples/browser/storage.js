// 네이티브 호스트가 설정 파일과 프로젝트 목록의 읽기·쓰기를 처리한다.
import { host } from "./framework/index.js";

export class WorkspaceStore {
  static async open() {
    if (!host) return (await import("./browser-storage.js")).WorkspaceStore.open();
    return new WorkspaceStore();
  }
  onChange(fn) { return host.on("workspace-changed", fn); }
  snapshot() { return host.call("workspace", { kind: "snapshot" }); }
  add(project) { return host.call("workspace", { kind: "add", project }); }
  patch(id, patch) { return host.call("workspace", { kind: "patch", id, patch }); }
  remove(id) { return host.call("workspace", { kind: "remove", id }); }
  move(id, delta) { return host.call("workspace", { kind: "move", id, delta }); }
  settings(id, values) {
    const patch = {}, remove = [];
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) remove.push(key);
      else patch[key] = value;
    }
    return host.call("workspace", { kind: "settings", id, patch, remove });
  }
}
