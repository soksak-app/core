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
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { RUNTIME, importSpecifiers, pageImports } from "@soksak/plugin-api";

export const STAGED = Object.freeze({
  // The pages that a host opens from the staged frontend.
  pages: Object.freeze(["index.html", "overlay.html"]),
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
  // Modules served to plugin view documents only in diagnostic builds.
  viewDiagnostics: Object.freeze([
    Object.freeze({ package: "@soksak/plugin-api", file: "diagnostic-view-frames.js" }),
  ]),
  // A document that the native host creates and provides for each request. An application without a host uses the --installed staging.
  served: Object.freeze([
    "installed-plugins.json", // The enabled installed plugins and their manifests (docs/spec/installation.md)
  ]),
});

/** Returns the scripts and styles that a page names, with the specifiers of its inline scripts, in that order. */
export function pageReferences(html) {
  const text = html.replace(/<!--[\s\S]*?-->/g, "");
  const scripts = [...text.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)]
    .filter(([, attributes]) => !attributes.includes('type="importmap"'))
    .flatMap(([, attributes, body]) => {
      const source = attributes.match(/\bsrc="([^"]+)"/);
      return source ? [source[1]] : importSpecifiers(body);
    });
  const styles = [...text.matchAll(/<link\b[^>]*>/g)]
    .filter(([tag]) => tag.includes('rel="stylesheet"'))
    .map(([tag]) => tag.match(/\bhref="([^"]+)"/)[1]);
  return [...scripts, ...styles];
}

/** Returns the path in the staged frontend of a specifier of importer through the import map of its page, or undefined when the map does not hold it. */
function stagedPath(specifier, importer, imports) {
  const mapped = Object.entries(imports).find(([name]) => name === specifier || (name.endsWith("/") && specifier.startsWith(name)));
  const relative = /^\.{0,2}\//.test(specifier);
  if (!mapped && !relative) return undefined;
  const target = mapped ? `${mapped[1]}${specifier.slice(mapped[0].length)}` : specifier;
  return new URL(target, `http://stage/${importer}`).pathname.slice(1);
}

/**
 * Walks the references from a staged page through its modules and returns one line for each reference that the frontend in out does not
 * hold. The walk stops at the runtime directory: staging copies it whole, and its modules import what their framework or host serves.
 */
export function missingPageReferences(out, page) {
  const html = readFileSync(join(out, page), "utf8");
  const imports = pageImports(html);
  const pending = pageReferences(html).map((specifier) => ({ importer: page, specifier }));
  const seen = new Set();
  const missing = [];
  while (pending.length > 0) {
    const { importer, specifier } = pending.shift();
    const path = stagedPath(specifier, importer, imports);
    if (path === undefined) {
      missing.push(`${importer} imports ${specifier}, which the import map of ${page} does not map`);
    } else if (!STAGED.served.includes(path) && !seen.has(path)) {
      if (!existsSync(join(out, path))) {
        missing.push(`${importer} imports ${specifier}, which is not staged`);
      } else {
        seen.add(path);
        if (path.endsWith(".js") && !path.startsWith(`${RUNTIME}/`)) pending.push(...importSpecifiers(readFileSync(join(out, path), "utf8")).map((next) => ({ importer: path, specifier: next })));
      }
    }
  }
  return missing;
}
