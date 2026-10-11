// A resolution hook for the tests of the runtime: the Wails runtime module is served by the asset server of the application at
// /wails/runtime.js, which a test run has no file for. The hook gives the specifier a module that reads the runtime from
// `globalThis.__wailsRuntime`, which a test sets.
export async function resolve(specifier, context, next) {
  if (specifier === "/wails/runtime.js") {
    const source = "const runtime = globalThis.__wailsRuntime; export const Call = runtime.Call; export const Window = runtime.Window; export const Events = runtime.Events;";
    return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
  }
  return next(specifier, context);
}
