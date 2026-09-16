// 네이티브 호스트에 설정 파일과 프로젝트 목록의 읽기·쓰기를 요청하는 저장소.
//
// 네이티브 애플리케이션의 런타임 모듈이 openStore() 에서 이 저장소를 생성한다.

export class HostWorkspaceStore {
  constructor(host) {
    this.host = host;
  }
  onChange(fn) { return this.host.on("workspace-changed", fn); }
  snapshot() { return this.host.call("workspace", { kind: "snapshot" }); }
  add(project) { return this.host.call("workspace", { kind: "add", project }); }
  patch(id, patch) { return this.host.call("workspace", { kind: "patch", id, patch }); }
  remove(id) { return this.host.call("workspace", { kind: "remove", id }); }
  move(id, delta) { return this.host.call("workspace", { kind: "move", id, delta }); }
  settings(id, values) {
    const patch = {}, remove = [];
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) remove.push(key);
      else patch[key] = value;
    }
    return this.host.call("workspace", { kind: "settings", id, patch, remove });
  }
}
