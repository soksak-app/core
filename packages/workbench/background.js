// Applies and removes the background blur on each web document. Existing stylesheets are not changed.
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
