# Plugins and application environments

[한국어](plugins.ko.md)

The workbench does not reference any specific plugin. Each application declares its plugins and defaults in `environment.json`. Each plugin declares itself in `plugin.json`. [`@soksak/plugin-api`](../../packages/plugin-api/index.js) defines both formats, the `sidecar.json` format, the staged file layout, and the page import map. The workbench, plugins, and applications validate their own files with those functions.

## Workspace layout

| Directory | Contents |
| --- | --- |
| `packages/soksak` | Headless layout library |
| `packages/workbench` | Workbench frontend (core): projects, spaces, cards, tabs, sidebars, settings, plugin loading, and `soksak-stage` |
| `packages/plugin-api` | Declaration formats, staged layout, page import map, and helpers for plugin pages |
| `packages/client` | Client for the local endpoint and its latency benchmark |
| `plugins/<id>` | One plugin: `plugin.json`, its pages, and its tests |
| `packages/host/<name>` | [Native host](hosts.md) libraries (core): `wailsv3` in Go and `tauriv2` in Rust |
| `apps/<name>` | One application: `environment.json`, `runtime/`, the native entry point and framework configuration, and its tests |
| `sidecars/<name>` | One [sidecar](sidecars.md): `sidecar.json`, a native process that plugins use through the host, and its tests |
| `native/darwin` | Shared macOS library used by the native hosts |
| `e2e` | Window checks for running native applications |

Common functionality belongs to the workbench or the native host so plugins do not reimplement it. Plugin functionality does not move into the workbench. A sidecar holds native functionality for one domain and can serve several plugins; general functionality such as the message relay belongs to the host.

## plugin.json

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | yes | Lowercase identifier. Tabs and settings reference it |
| `name` | yes | Display name |
| `surface` | no | `{ "url": "https://…" }` for an external page, or `{ "page": "ui/page.html" }` for a document inside the package |
| `mark` | with `surface` | Short text shown in the add menu and new tab titles |
| `icon` | with `surface` | SVG elements for a 16×16 view box |
| `sections` | no | Sidebar sections `{ "id": "<plugin id>.<name>", "name" }` |
| `preview` | no | `{ "ink": "--<token>" }`: the theme token name that colors the plugin's cards in library previews; requires `surface` |
| `sidecars` | no | Package names of the [sidecars](sidecars.md) the page surface uses; requires a `page` surface. Each must be a dependency in the plugin's `package.json` |

A plugin requires `surface`, `sections`, or both. Only plugins with a surface appear in the add menu and own a rail. The workbench opens a `page` surface at `modules/<package name>/<page>?id=<tab id>`. Unknown fields are rejected.

## environment.json

| Field | Meaning |
| --- | --- |
| `runtime` | Directory inside the application that contains the runtime module `index.js` |
| `plugins` | Plugin package names. Each must be a dependency of the application package. The order is the add-menu order |
| `workspace.grid` | Grid lines and cards of a new space. A card with `tabs` lists `{ plugin, title }` entries |
| `workspace.focus` | Card focused in a new space; it must have tabs |
| `sidebars.sets` | Default section sets |
| `sidebars.links` | Default assignments of sets to `left` (with `plugin: null`), `right`, or `rail` (with a plugin id) |

The workbench loads `environment.json` and every listed `plugin.json` before it reads settings or builds a space. A tab or link that names a plugin without a surface, or a set that names an unknown section, fails the load before any registration.

## Staged layout

`soksak-stage <output> [--executables <dir>]` runs in an application directory and resolves packages through Node module resolution. It copies files without changing them:

| Path | Source |
| --- | --- |
| `/` | `files` of `@soksak/workbench` |
| `/modules/<package>/` | `files` of `soksak`, `@soksak/plugin-api`, and each listed plugin |
| `/runtime/` | The application's `runtime` directory |
| `/environment.json` | The application's `environment.json` |
| `/modules/<sidecar>/sidecar.json` | `sidecar.json` of each sidecar package listed in a plugin's `sidecars` |

With `--executables <dir>`, the tool also copies each sidecar's built `executable` file into `<dir>` under its file name and fails when the file is not built. The debug staging targets `frontend-wailsv3` and `frontend-tauriv2` and the release build targets run the `sidecars` target, which builds every sidecar package, and then stage into `apps/<app>/src/frontend` with `--executables` set to the directory of the application executable (`target/debug` or `target/release`).

Every page declares one import map equal to `PAGE_IMPORTS`: `soksak`, `@soksak/plugin-api`, `@soksak/plugin-api/page`, `@soksak/runtime`, and `@soksak/workbench/`.

## Runtime module

`runtime/index.js` exports:

| Export | Meaning |
| --- | --- |
| `host` | Main-page host interface (`call`, `on`, `page`, `draggable`), or `null` without a native host |
| `page` | Surface and modal page interface (`theme`, `sidecar`, `modal`), or `null` without a native host |
| `openStore()` | Returns the workspace store. The browser application uses IndexedDB; native applications return `HostWorkspaceStore` |
| `windows` | Window and project-folder interface. Native applications export `hostWindows(host)` from `@soksak/workbench/host-windows.js`; the browser application exports its own implementation |

`windows` has these members:

| Member | Meaning |
| --- | --- |
| `createsFolders` | `true` when `chooseFolder` and `createFolder` are available |
| `newWindow()` | Opens a new window. The browser application opens a tab |
| `onActivate(fn)` | Calls `fn` when the host asks the window to show a project |
| `onCloseRequest(fn)` | Calls `fn` when the host asks the window to close |
| `ready()` | Reports that the window can receive requests |
| `close()` | Closes the window |
| `state()` | Returns the window geometry, or `null` when the runtime has none |
| `folder(root)` | Returns `{ root, identity }` for a project directory. The browser application returns the trimmed path and the identity `path:<trimmed path>` |
| `chooseFolder()` | Shows the folder selection dialog. The browser application rejects the call |
| `createFolder({ parent, name })` | Creates a project folder. The browser application rejects the call |
| `openProject({ id, root, title, geometry, separate, current })` | Opens a project and returns `{ local }`; `local` is `true` when the calling window shows the project. The browser application opens a separate project in a new tab |
| `releaseProject(id)` | Releases the calling window's ownership of a project |

The workbench uses only these exports and does not branch on the runtime.

Plugin pages import `followTheme` and `page` from `@soksak/plugin-api/page` and do not import workbench files.

## Tests

Each directory runs its own tests with `pnpm test`. A package checks its boundary with fixtures and does not read another package's source or real names. The plugin API tests the formats. The workbench tests loading with fixture files. Each plugin tests its `plugin.json` and pages. Each application tests that its `environment.json` resolves against its real plugin dependencies. The workbench colors library previews from each plugin's `preview.ink` and contains no plugin-specific CSS.

`node scripts/check-boundaries.mjs` checks the boundary rules in source files: core packages do not name plugin or sidecar packages or plugin ids, and plugins and sidecars name only packages declared in their `package.json`. It does not check `apps/`, `e2e/`, declaration files (`package.json`, `plugin.json`, `sidecar.json`), or `.md` files.
