// A resolution hook for the tests of the runtime: the Wails runtime module is served by the asset server of the application at
// /wails/runtime.js, which a test run has no file for. The hook gives the specifier a module that reads the runtime from
// `globalThis.__wailsRuntime`, which a test sets. The module is evaluated once for the whole file, so each member reads the runtime
// that the running test set at the moment of its use.
export async function resolve(specifier, context, next) {
  if (specifier === "/wails/runtime.js") {
    const member = (name) => `export const ${name} = new Proxy({}, { get: (_, key) => globalThis.__wailsRuntime.${name}[key] });`;
    const source = ["Call", "Window", "Events"].map(member).join(" ");
    return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
  }
  return next(specifier, context);
}
