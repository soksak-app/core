// 각 웹 문서에 배경 블러를 적용하고 제거한다. 기존 스타일시트는 변경하지 않는다.
(() => {
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(":root { filter: blur(3px) !important }");
  let enabled = window.__soksakBackground === true;
  Object.defineProperty(window, "__soksakBackground", {
    get: () => enabled,
    set(value) {
      enabled = value === true;
      const rest = document.adoptedStyleSheets.filter((item) => item !== sheet);
      document.adoptedStyleSheets = enabled ? [...rest, sheet] : rest;
    },
  });
  window.__soksakBackground = enabled;
})();
