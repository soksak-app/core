// 네이티브 호스트에 창과 프로젝트 폴더 작업을 요청하는 창 인터페이스.
//
// 네이티브 애플리케이션의 런타임 모듈이 이 인터페이스를 `windows` 로 내보낸다. 브라우저
// 런타임은 같은 인터페이스를 브라우저 API 로 구현한다.

export function hostWindows(host) {
  return {
    /** 새 폴더 생성과 폴더 선택 대화상자를 제공한다. */
    createsFolders: true,
    newWindow: () => host.call("windowNew"),
    onActivate: (fn) => host.on("project-activate", fn),
    onCloseRequest: (fn) => host.on("project-close-request", fn),
    /** 메인 페이지가 등록하거나 표면을 올리기 전에 부른다. 호스트가 이전 페이지의 상태를 정리한 뒤 돌아온다. */
    ready: () => host.call("windowReady"),
    close: () => host.call("windowClose"),
    /** 창의 현재 크기와 위치. */
    state: () => host.call("windowState"),
    folder: (root) => host.call("projectFolder", root),
    chooseFolder: () => host.call("folderChoose"),
    createFolder: (request) => host.call("projectCreate", request),
    /**
     * 프로젝트를 연다. 호스트가 창 소유 관계로 이 창에서 열지 결정하고,
     * `{ local }` 로 이 창에서 열어야 하는지 반환한다.
     */
    openProject: ({ id, root, title, separate, geometry }) =>
      host.call("projectOpen", { id, root, title, separate, geometry }),
    releaseProject: (id) => host.call("projectRelease", id),
  };
}
