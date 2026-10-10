// The names of the files that stage.mjs creates in the publish root.
// stage.mjs imports this list and verifies it so that the declaration and the actual files match.
//
// Publish root files (modules can import them directly):
// - always: created in every build
// - diagnostics: created only with the --diagnostics flag
// - served: documents that the host provides. Staging writes them only with --installed
//
// Note: the files copied under modules/ are not declared here.
//      They are managed by the files array of each plugin or sidecar, and stage.mjs only copies them.
export const STAGED = Object.freeze({
  always: Object.freeze([
    "diagnostics.js", // a copy of observe.js with diagnostics, otherwise a copy of release-diagnostics.js
    "environment.json", // application settings
    "runtime/start.js", // the start document module of the application runtime
  ]),
  diagnostics: Object.freeze([
    "transcript.js", // the call recorder that the diagnostics module uses
    "resize-loop.js", // the ResizeObserver loop recorder that the diagnostics module uses
    "surface-reply-hold.js", // the hold of surface exposure replies that the diagnostics module uses
  ]),
  // A document that the native host creates and provides for each request. An application without a host uses the --installed staging.
  served: Object.freeze([
    "installed-plugins.json", // The enabled installed plugins and their manifests (docs/spec/installation.md)
  ]),
});
