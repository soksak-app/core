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
| `surface` | no | `{ "module": "ui/page.js", "composition": ... }`: a module inside the package and its required [surface composition](surface-composition.md). The module mounts into the app DOM; external web documents use document regions. A web address is not a surface |
| `home` | no | The `http` or `https` address the surface page opens first; requires `surface` |
| `mark` | with `surface` | Short text shown in the add menu and new tab titles |
| `icon` | with `surface` | SVG elements for a 16×16 view box |
| `sections` | no | Sidebar sections `{ "id": "<plugin id>.<name>", "name" }` |
| `preview` | no | `{ "ink": "--<token>" }`: the theme token name that colors the plugin's cards in library previews; requires `surface` |
| `sidecars` | no | Package names of the [sidecars](sidecars.md) the page surface uses; requires `surface`. Each must be a dependency in the plugin's `package.json` |
| `background` | no | `{ "sidecar": "<declared sidecar>", "operation": "<operation name>", "settings"?: { "<request field>": "<declared setting>" } }`: keeps one declared sidecar session for each non-active tab without creating a native surface; the workbench puts the current value of each mapped plugin setting into the request field, and `settings` cannot name `operation` or an undeclared setting; requires `surface` and `sidecars` |

A plugin requires `surface`, `sections`, or both. Only plugins with a surface appear in the add menu and own a rail. The workbench imports `modules/<package name>/<module>` and calls its `mount(root, context)` export. The surface identifier is an explicit context member, not a URL query. The old `page` declaration is rejected; it does not select an alternate implementation. Unknown fields are rejected.

`surface.drop`, when present, names a command in `exposes` that the page runs on the surface when files are dropped on it, with `{urls}` holding the dropped file URLs ([native surfaces](native-surfaces.md#input-over-native-views)).

`surface.composition` is either `{ "kind": "dom" }` or a hybrid declaration with `kind: "hybrid"`, complete `regions`, and complete `overlays`. An image region names a sidecar already listed in `sidecars`. The manifest declaration is authority data sent to the host; page code cannot add a region, supplier, input owner, or stacking entry that is absent from it.

## Diagnostic declarations

A plugin with a surface may keep status and command entries that exist only for checks in a `diagnostics.json` file at its package root: `{ "module": "ui/<file>.js", "exposes": { ... } }`. `module` is a file inside the package, and `exposes` has the form and owner rules of `plugin.json` `exposes`. A name is declared in `plugin.json` or in `diagnostics.json`, not in both. Neither `diagnostics.json` nor its module is listed in the package's `files`, so release staging never copies them; staging fails when either is listed. An entry belongs in `diagnostics.json` when it injects state that user input or the OS produces, or records internal events for a check; an entry that reports visible state or performs a user operation belongs in `plugin.json`.

In a diagnostic build the workbench adds the declarations to the plugin's surface declarations and imports the module before it mounts the surface. The surface context carries the module as `diagnostics`; in a release build `diagnostics` is `null`. The surface module passes it to its implementation, which calls the module with the internal operations the diagnostic entries use.

## Surface module ownership

Each OS window has one app DOM WebView. The workbench owns the surface element and its Shadow Root; a plugin owns the DOM it mounts inside that root. Shadow DOM isolates styles, not security privileges. The context exposes surface-scoped commands, statuses, DOM bindings, sidecar messages, and the declared composition controller. The host validates the window, surface, and declaration again. Sidecar messages sent through the context reach the sidecar in send order: the workbench starts a send only after the previous send to the same sidecar finished, and every surface and background session of that sidecar shares one order. A send whose surface is not the context's surface is rejected. Plugins do not create internal WebViews or iframes.

`mount(root, context)` may be asynchronous and returns `{ dispose() }`. Native surface registration completes before mounting can attach a region. Mounting failure is a visible error; it cannot become a successful empty surface. Native readiness requires the first presented region, not merely a completed module import. The workbench distinguishes loading, ready, and error.

Hiding a tab or visiting the library hides its DOM and native regions without disposing its module or closing its session. Explicit removal disposes the module and releases its bindings, event subscriptions, and regions; disposal failures are reported. Every operation remains subject to the shared binder and [exposure](exposure.md) contract. Menus and settings are DOM overlays in the same app WebView, with declared input ownership above native regions.

A `background` declaration is an explicit session-lifetime contract, not a second page or a hidden WebView. The workbench sends the declared `operation` through the declared sidecar using the sidecar message protocol. The manifest uses the full field name `operation`; the sidecar request body retains its existing operation selector. The workbench does not invent a request, substitute a missing operation, or hide an error. When the tab becomes visible, its surface sends the same operation with its image region and reattaches to the existing session. Removing the tab removes the background session.

## Tab reports

A surface context has `tab.title(text)`, `tab.directory(path)`, and `tab.notify(text)`, and a frozen `origin` object.

`tab.title(text)` sets the title that the surface's tab shows in place of its name, and `tab.title(null)` removes it so the tab shows its name again. The text is a string of 1 to 256 characters without control characters (U+0000–U+001F and U+007F–U+009F); any other value throws. The title is not saved with the layout. `core.grid` reports each tab's shown title as `label`, or `null`.

`tab.notify(text)` gives the tab a notice when the tab is not the active tab of the focused card; for that tab the call changes nothing, because the surface is in view. The text follows the title rules with up to 1024 characters; another value throws. A tab with a notice shows a dot, and its tab and the card's tab list button carry the text as their tooltip; the tab list shows the dot beside the tab. The notice is removed when the tab becomes the active tab of the focused card or is closed, and a later notice replaces an earlier one. `core.grid` reports each tab's notice as `notice`, or `null`. The workbench does not save notices.

`tab.directory(path)` records the surface's working directory, an absolute path, and `tab.directory(null)` removes it; any other value throws. The workbench does not read the filesystem for it and does not save it. When `+` or a split creates a tab, the new surface's `origin.directory` is the directory that the active tab of the card that was added to or split recorded at that moment, or `null`.

## Opening links

A surface context has `runtime.links.open(url)`, which asks the host to open an absolute `http`, `https`, or `mailto` URL with the user's default application for its scheme. The host rejects another scheme, a URL that does not parse, and a URL longer than 8192 characters, and the returned promise rejects with the reason. The macOS hosts open the URL through `NSWorkspace`; the Windows platform returns `not implemented on windows`.

## environment.json

| Field | Meaning |
| --- | --- |
| `runtime` | Directory inside the application that contains the runtime module `index.js` |
| `plugins` | Plugin package names. Each must be a dependency of the application package. The order is the add-menu order |
| `workspace.grid` | Grid lines and cards of a new space. A card with `tabs` lists `{ plugin, title }` entries |
| `workspace.focus` | Card focused in a new space; it must have tabs |
| `sidebars.sets` | Default section sets |
| `sidebars.links` | Default assignments of sets to `left` (with `plugin: null`), `right`, or `rail` (with a plugin id) |

The workbench loads `environment.json` and every listed `plugin.json` before it reads settings or builds a space. A tab or link that names a plugin without a surface, or a set that names an unknown section, fails the load before any registration. Saved spaces and settings are not environment files; their unregistered plugins and sections are dropped when a space opens ([projects](projects.md#persistence)).

## Staged layout

`soksak-stage <output> [--executables <dir>] [--diagnostics]` runs in an application directory and resolves packages through Node module resolution. It copies files without changing them:

| Path | Source |
| --- | --- |
| `/` | `files` of `@soksak/workbench` |
| `/modules/<package>/` | `files` of `soksak`, `@soksak/plugin-api`, and each listed plugin |
| `/runtime/` | The application's `runtime` directory |
| `/environment.json` | The application's `environment.json` |
| `/modules/<sidecar>/sidecar.json` | `sidecar.json` of each sidecar package listed in a plugin's `sidecars` |
| `/diagnostics.js` | With `--diagnostics`, the workbench's `observe.js` (the page diagnostic methods); otherwise an empty module |
| `/transcript.js` | With `--diagnostics`, the workbench's `transcript.js` (the call recorder of the diagnostic module); otherwise absent |
| `/diagnostic-plugins.json` | With `--diagnostics`, an object that maps each listed plugin package with a `diagnostics.json` to that file's content; otherwise `{}` |
| `/modules/<package>/<module>` | With `--diagnostics`, the `module` file named by the plugin's `diagnostics.json`; otherwise absent |

Every file imported by published files must be listed in the package's `files` array; this is validated by `packages/workbench/test/published-imports.test.mjs`.

With `--executables <dir>`, the tool also copies each sidecar's built `executable` file into `<dir>` under its file name and fails when the file is not built. The debug staging targets `frontend-wailsv3` and `frontend-tauriv2` run `sidecars-debug` and the release build targets run `sidecars-release`; those targets build the sidecar packages the applications declare and the helpers those sidecars declare, in that profile. They then stage into `apps/<app>/src/frontend` with `--executables` set to the directory of the application executable (`target/debug` or `target/release`). The debug targets add `--diagnostics`; release builds contain no page or plugin diagnostic code. `make release-check` fails when a staged release frontend has a non-empty `/diagnostic-plugins.json`, contains a plugin diagnostic module, or contains a name declared in a plugin's `diagnostics.json`.

Every page declares one import map equal to `PAGE_IMPORTS`: `soksak`, `@soksak/plugin-api`, `@soksak/plugin-api/page`, `@soksak/runtime`, and `@soksak/workbench/`.

## Runtime module

`runtime/index.js` exports:

| Export | Meaning |
| --- | --- |
| `host` | Main-page host interface (`call`, `on`, `page`, `draggable`), or `null` without a native host |
| `page` | Surface and modal page interface (`theme`, `sidecar`, `exposure`, `document`, `modal`), or `null` without a native host |
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

Plugin pages import from `@soksak/plugin-api/page` and do not import workbench files: `followTheme`, `page`, `expose` ([exposure](exposure.md)), `ownManifest()` (the page's validated `plugin.json`), and `createSurfaceComposition(...)` ([surface composition](surface-composition.md)). The exported `page` object does not expose raw document or image attach/place ports. Region handles come only from the validated composition.

## Tests

### Browser address input

The browser address field selects its full value when it gains focus through the declared `browser.address.select` command. The initial pointer release preserves that selection, so typing replaces the previous address. Later clicks in an already focused field allow caret placement instead of selecting everything again. The plugin uses its owning Shadow Root to determine focus, keeps in-progress input across navigation status updates, and releases all handlers when disposed. Native keyboard checks type the replacement directly; they do not manually select text to compensate for missing behavior.

Each directory runs its own tests with `pnpm test`. A package checks its boundary with fixtures and does not read another package's source or real names. The plugin API tests the formats. The workbench tests loading with fixture files. Each plugin tests its `plugin.json` and pages. Each application tests that its `environment.json` resolves against its real plugin dependencies. The workbench colors library previews from each plugin's `preview.ink` and contains no plugin-specific CSS.

### Settings declarations

A plugin may declare typed settings in `plugin.json` under `settings`. The object keys are plugin-local setting names; the workbench exposes them under `<plugin id>.<key>`. Each declaration has `type`, `default`, and `values` for an enum; `type`, `default`, `minimum`, and `maximum` for a bounded integer; or `type`, `default`, and `maxLength` for a non-empty string of at most `maxLength` characters. The declaration is the only source of the type and validation rule; unknown setting keys and invalid defaults fail manifest validation.

An application may provide initial values in `environment.json` under `settings`, keyed by plugin id and local setting name. The values must name declared settings and pass the plugin declaration. The precedence is plugin default, application value, saved common value, then saved project override. Stored values are validated against the declaration before becoming effective; invalid stored data is an explicit load error and is not replaced.

`node scripts/check-boundaries.mjs` checks the boundary rules in source files: core packages do not name plugin or sidecar packages or plugin ids, and plugins and sidecars name only packages declared in their `package.json`. It does not check `apps/`, `e2e/`, declaration files (`package.json`, `plugin.json`, `sidecar.json`), or `.md` files.
