// 워크벤치 테스트용 런타임. 네이티브 호스트가 없다.
export const host = null;
export const page = null;

export const openStore = () => {
  throw new Error("workbench tests do not open a store");
};

export const windows = null;
