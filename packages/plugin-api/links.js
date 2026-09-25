// 링크 열기 capability. 호스트가 스킴을 검사하고 사용자의 기본 애플리케이션으로 연다
// (docs/spec/plugins.md#opening-links).

export function createLinkBridge(call) {
  if (typeof call !== "function") throw new TypeError("link bridge requires a call function");
  return Object.freeze({
    open(url) {
      if (typeof url !== "string" || url.length === 0) {
        return Promise.reject(new TypeError("link URL must be a non-empty string"));
      }
      return Promise.resolve(call("linkOpen", { url })).then(() => undefined);
    },
  });
}
