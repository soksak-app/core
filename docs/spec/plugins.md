# Plugins and application environments

[한국어](plugins.ko.md)

The workbench does not reference any specific plugin. Each application declares its plugins and defaults in `environment.json`. Each plugin declares itself in `plugin.json`. [`@soksak/plugin-api`](../../packages/plugin-api/index.js) defines both formats, the staged file layout, and the page import map. The workbench, plugins, and applications validate their own files with those functions.

## Workspace layout

| Directory | Contents |
| --- | --- |
| `packages/soksak` | Headless layout library |
| `packages/workbench` | Workbench frontend (core): projects, spaces, cards, tabs, sidebars, settings, plugin loading, and `soksak-stage` |
| `packages/plugin-api` | Declaration formats, staged layout, page import map, and helpers for plugin pages |
| `plugins/<id>` | One plugin: `plugin.json`, its pages, and its tests |
| `apps/<name>` | One application: `environment.json`, `runtime/`, native host code, and its tests |
| `sidecars/<name>` | One [sidecar](sidecars.md): a native process that plugins use through the host |
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
| `sidecars` | no | [Sidecar](sidecars.md) names the page surface uses; requires a `page` surface |

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
| `sidecars` | Sidecars the native host runs. An application without a native host omits this field; otherwise every plugin sidecar must be listed |

The workbench loads `environment.json` and every listed `plugin.json` before it reads settings or builds a space. A tab or link that names a plugin without a surface, or a set that names an unknown section, fails the load before any registration.

## Staged layout

`soksak-stage <output>` runs in an application directory and resolves packages through Node module resolution. It copies files without changing them:

| Path | Source |
| --- | --- |
| `/` | `files` of `@soksak/workbench` |
| `/modules/<package>/` | `files` of `soksak`, `@soksak/plugin-api`, and each listed plugin |
| `/runtime/` | The application's `runtime` directory |
| `/environment.json` | The application's `environment.json` |

Every page declares one import map equal to `PAGE_IMPORTS`: `soksak`, `@soksak/plugin-api`, `@soksak/plugin-api/page`, `@soksak/runtime`, and `@soksak/workbench/`.

## Runtime module

`runtime/index.js` exports:

| Export | Meaning |
| --- | --- |
| `host` | Main-page host interface (`call`, `on`, `page`, `draggable`), or `null` without a native host |
| `page` | Surface and modal page interface (`theme`, `sidecar`, `modal`), or `null` without a native host |
| `openStore()` | Returns the workspace store. The browser application uses IndexedDB; native applications return `HostWorkspaceStore` |

Plugin pages import `followTheme` and `page` from `@soksak/plugin-api/page` and do not import workbench files.

## Tests

Each directory runs its own tests with `pnpm test`. A package checks its boundary with fixtures and does not read another package's source or real names. The plugin API tests the formats. The workbench tests loading with fixture files. Each plugin tests its `plugin.json` and pages. Each application tests that its `environment.json` resolves against its real plugin dependencies.
