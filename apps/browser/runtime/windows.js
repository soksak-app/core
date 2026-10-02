// 브라우저 런타임의 창 인터페이스. 창은 브라우저 탭이다.
//
// 폴더는 확인할 수 없으므로 입력한 경로를 그대로 사용하고, 식별자는 경로에서 만든다.

export const windows = {
  createsFolders: false,
  newWindow() {
    const target = new URL(location.href);
    target.search = "";
    if (!window.open(target, "_blank")) throw new Error("The browser blocked the new window");
  },
  onActivate: async () => {},
  onCloseRequest: async () => {},
  ready: async () => {},
  close: async () => {},
  state: async () => null,
  folder: async (root) => ({ root: root.trim(), identity: `path:${root.trim()}` }),
  chooseFolder: () => Promise.reject(new Error("The browser runtime cannot choose folders")),
  createFolder: () => Promise.reject(new Error("The browser runtime cannot create folders")),
  /**
   * 다른 프로젝트가 열린 탭에서 별도 창 열기를 요청하면 새 탭에서 열고 `local: false` 를 반환한다.
   */
  async openProject({ id, separate, current }) {
    if (!separate || current === null || current === id) return { local: true };
    const target = new URL(location.href);
    target.search = "";
    target.searchParams.set("project", id);
    if (!window.open(target, `soksak-${id}`)) throw new Error("The browser blocked the project window");
    return { local: false };
  },
  releaseProject: async () => {},
};
