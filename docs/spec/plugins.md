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
| `description` | yes | One or two sentences of 1 to 200 characters that say what the plugin does; the settings window shows and searches it |
| `surface` | no | `{ "module": "ui/page.js", "composition": ... }`: a module inside the package and its required [surface composition](surface-composition.md). The module mounts into the app DOM; external web documents use document regions. A web address is not a surface |
| `mark` | with `surface` | Short text shown in the add menu and new tab titles |
| `icon` | with `surface` | SVG elements for a 16×16 view box |
| `sections` | no | Sidebar sections `{ "id": "<plugin id>.<name>", "name", "module" }`; `module` is a JavaScript path inside the package that draws the section, and the optional `fill: true` gives it the remaining sidebar height ([sections](#sections)) |
| `preview` | no | `{ "ink": "--<token>" }`: the theme token name that colors the plugin's cards in library previews; requires `surface` |
| `sidecars` | no | Package names of the [sidecars](sidecars.md) the page surface or the state module uses; requires `surface` or `state`. Each must be a dependency in the plugin's `package.json` |
| `state` | no | `{ "module": "ui/state.js" }`: the [plugin state](#plugin-state) module that holds state outside a surface; requires `sections` |
| `data` | no | `{ "<key>": { "schema": <schema>, "default": <value> } }`: [project data](#project-data) the state module stores for each project; requires `state` |
| `background` | no | `{ "sidecar": "<declared sidecar>", "operation": "<operation name>", "settings"?: { "<request field>": "<declared setting>" } }`: keeps one declared sidecar session for each non-active tab without creating a native surface; the workbench puts the current value of each mapped plugin setting into the request field, and `settings` cannot name `operation` or an undeclared setting; requires `surface` and `sidecars` |

A plugin requires `surface`, `sections`, or both. Only plugins with a surface appear in the add menu and own a rail. The workbench imports `modules/<package name>/<module>` and calls its `mount(root, context)` export. The surface identifier is an explicit context member, not a URL query. The old `page` declaration is rejected; it does not select an alternate implementation. Unknown fields are rejected.

`surface.drop`, when present, names a command in `exposes` that the page runs on the surface when files are dropped on it, with `{urls}` holding the dropped file URLs ([native surfaces](native-surfaces.md#input-over-native-views)).

`surface.composition` is either `{ "kind": "dom" }` or a hybrid declaration with `kind: "hybrid"`, complete `regions`, and complete `overlays`. An image region names a sidecar already listed in `sidecars`. The manifest declaration is authority data sent to the host; page code cannot add a region, supplier, input owner, or stacking entry that is absent from it.

## Sections

A section is part of a sidebar that a plugin draws. The workbench imports the section's `module` and calls its `mount(root, context)` export in the section's element, as it does for a surface page, and calls the returned dispose function when the section leaves the sidebar. `context.card` is the id of the card the sidebar belongs to and `context.surface` is that card's active tab, or both are `null` for the left sidebar. Sections are drawn in the application document; they have no native surface.

A section shows its plugin's state through the plugin's declared statuses and changes it through the plugin's declared commands; it keeps no copy of that state. `context.status(name, fn)` follows a status of the section's plugin and returns a function that stops following. `fn(value, source)` receives the current value and every later change; `source` is the surface that registered the status, or `"state"` when the plugin's state module registered it. A status that the state module registered is followed before any surface. Otherwise the section follows `context.surface` when that surface registered the name, otherwise the surface a request without `surface` would use ([choosing a surface](exposure.md#choosing-a-surface)), and receives `fn(null, null)` while no surface registered it; it chooses again when registrations change. A failure to start, read, or stop following a status is reported as a page error. `context.bind(element, name, params, options)` connects an element to a command of the section's plugin with the shared binder and gives it the dom name `core.sidebar.section.control`, because the element belongs to the application document and not to a surface page. The command runs in the state module when it registered the command, on `context.surface` when that surface registered it, otherwise on the surface a request without `surface` would use. A section may also follow a core status and bind a core command, whose names start with `core.`; `context.status` then follows the application document's registration and `source` is `"core"`. An operation that a library draws inside its own shadow root, such as opening a folder of a tree, reaches its command through the element that holds the library: the section binds that element to the command with a custom event (`context.bind(holder, name, (event) => params, {event: "<type>"})`) and dispatches the event with the operation's parameters in `detail`. A section cannot use names of another plugin. `core.sidebars` reports the text each section drew and the number of its controls, so checks read what a section shows and find its controls among the `core.sidebar.section.control` elements.

A set combines sections of any plugins in order and has a `layout` chosen when the set is made. With `list` the sidebar shows every section of the set from top to bottom, each under a header with its name that folds and unfolds it. With `tabs` the sidebar shows a row of tabs with the section names and only the section of the selected tab. The selected tab and the folded sections are kept for each sidebar and saved with the space ([projects](projects.md#persistence)), so a reload and a restart show them again. Every sidebar that shows the set, whether a rail, an inset sidebar, or the left or right sidebar, draws it the same way.

A sidebar shows no set title or place label: its sections start at its top. A left, right, or rail sidebar ends in a status line that states its place; an inset sidebar has no status line, and its sections fill down to its card footer. A folded section keeps only its header. A section takes the height of its content, except that open sections declared with `fill: true` share the sidebar height left after the other sections and scroll their content inside it; a folded fill section gives that room to the other fill sections. The height is declared because a virtual list, such as the file tree, has no content height from which the workbench could tell that it needs room, while a short list that stretched would show empty space. Section headers have the height of a card header and the status line has the height of a card footer, so their rules line up with those of the neighbouring cards. A section states an empty list in words, such as 기록 없음.

The sidebar is identified by the id of the card that holds it: the `left`, `right`, or rail card, or the card of an inset sidebar. Folding a section header runs `core.sidebar.section.fold` and choosing a tab runs `core.sidebar.section.select`, both with `{sidebar, section}`; status `core.sidebars` reports every drawn sidebar with its set, layout, selected tab, and each section's fold and mount state. A section module is a file listed in the package's `files`, so release staging copies it; staging fails when a section module is not listed.

## Plugin state

A plugin without a surface, or with state that no single tab owns, declares a `state` module. While a window shows a project, the workbench imports the module once and calls its `mount(context)` export; when the window shows another project or the library, it calls the returned `dispose` first. The context has:

- `project`: `{id, root}`, the shown project and its canonical directory ([projects](projects.md)).
- `exposure.status(name, read, subscribe)` and `exposure.command(name, run)`: register the plugin's declared statuses and commands in the application document's registry. `subscribe(fn)` may be called more than once and returns a function that stops that subscription. These entries answer requests without `surface` before any surface registration of the same name ([choosing a surface](exposure.md#choosing-a-surface)), and dispose removes them.
- `sidecar`: `{send(body), on(fn)}` for the plugin's only declared sidecar. The session identifier is `state:<plugin id>:<project id>`, so the host gives the sidecar the project directory as `root` ([sidecars](sidecars.md#messages)).
- `data.get(key)` and `data.set(key, value)`: the plugin's [project data](#project-data).

The state module is a file listed in the package's `files`; staging fails when it is not listed. A mount or dispose failure is reported as a page error.

## Project data

`data` declares keys that the state module stores for each project. `schema` uses the schema subset of exposure declarations (`type`, `enum`, `properties`, `items`), and `default` must match it. The workbench stores the values in the project's `plugins.<plugin id>.<key>` entry of `projects.json` ([persistence](projects.md#persistence)). `data.get` returns the stored value or the default and fails when a stored value does not match the schema; `data.set` fails without writing when the value does not match or the key is not declared, and resolves after the store accepted the write.

## Third-party libraries

A plugin page, section, or state module imports only files inside its package, because staging copies the package `files` and the page import map names only core modules. A plugin that uses a third-party browser library bundles it into one ES module under `ui/vendor/` with a `scripts/build-vendor.mjs` of its own (esbuild), commits the bundle together with a `.LICENSE.txt` file that holds the license and notice texts of every bundled package, and lists them in `files` through `ui`. The library and esbuild are exact-version `devDependencies`. The plugin's `pnpm test` runs the script with `--check`, which fails when the committed files differ from a new build. The files plugin bundles `@pierre/trees` 1.0.0-beta.4 (Apache-2.0) and its `preact` dependency (MIT) through the vanilla entry `@pierre/trees`; plugins do not use React.

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

A notice is also a system notification. The host of the window posts it through the operating system's notification center with the tab's label as the title and the notice text as the body, also while the application is active; a later notice of the tab replaces the tab's notification, and removing the notice removes it. The host asks the user for permission at the first notification. On macOS the notification center serves only a process that runs from an application bundle, so the applications run from bundles ([hosts](hosts.md#frontend-and-executables)). Activating a notification makes its window the key window and runs `core.tab.select` for its tab. `core.notifications` reports `{authorization, error, posted}`: `authorization` is `notDetermined`, `denied`, `authorized`, or `provisional`; `error` is the last failure to request permission, post, or remove a notification, or `null`; and `posted` lists, in order, the tabs of the window whose notification the notification center accepted and that were not removed since. While permission is denied, the tooltip of a tab with a notice and of its card's tab list button ends with the line `System notifications are turned off for this application.`

`tab.directory(path)` records the surface's working directory, an absolute path, and `tab.directory(null)` removes it; any other value throws. The workbench does not read the filesystem for it and does not save it. When `+` or a split creates a tab, the new surface's `origin.directory` is the directory that the active tab of the card that was added to or split recorded at that moment, or `null`.

## Opening links

A surface context has `runtime.links.open(url)`, which asks the host to open an absolute `http`, `https`, or `mailto` URL with the user's default application for its scheme. The host rejects another scheme, a URL that does not parse, and a URL longer than 8192 characters, and the returned promise rejects with the reason. The macOS hosts open the URL through `NSWorkspace`; the Windows platform returns `not implemented on windows`.

## Icons

A surface context has `icon(name)`, which returns the core icon `name` as SVG markup with a 24-unit `viewBox`, stroke paths only, and `aria-hidden`; an unknown name throws. Core keeps the icons in `packages/workbench/icons.js`, and a plugin page draws them through the context instead of carrying its own artwork, because plugins cannot import the workbench. The markup carries no style: the page sets the size, color, and stroke in its own Shadow Root. The names are `star`, `projects`, `panel-left`, `panel-right`, `sun`, `moon`, `settings`, `close`, and the Lucide icons `chevron-left`, `chevron-right`, and `rotate-cw`.

The browser back, forward, and reload buttons draw `chevron-left`, `chevron-right`, and `rotate-cw` with the look of the card header buttons: a 20×20 button, a 14px icon, the `--muted` color, and the `--inset` background with the `--fg` color under the pointer. The stroke width is 1.95 units, which draws the icon with the width of the header buttons' 1.3-unit stroke in a 16-unit `viewBox`.

## environment.json

| Field | Meaning |
| --- | --- |
| `runtime` | Directory inside the application that contains the runtime module `index.js` |
| `plugins` | Plugin package names. Each must be a dependency of the application package. The order is the add-menu order |
| `workspace.grid` | Grid lines and cards of a new space. A card with `tabs` lists `{ plugin, title }` entries |
| `workspace.focus` | Card focused in a new space; it must have tabs |
| `sidebars.sets` | Default section sets `{id, title, sections, layout}`; `layout` is `list` or `tabs` |
| `sidecars` | Optional. `false` states that the runtime cannot run [sidecars](sidecars.md), as in the browser example; such an environment cannot list a plugin whose `state` module uses sidecars. The default is `true` |
| `sidebars.links` | Default sidebar choices in the form of [sidebar choices](settings.md#sidebar-choices): general `left` and `right` links with `plugin: null`, plugin `left` and `right` links with a set or `null`, and `rail` links with a plugin id |

The workbench loads `environment.json` and every listed `plugin.json` before it reads settings or builds a space. A tab or link that names a plugin without a surface, a set that names an unknown section, or a plugin whose state module uses sidecars in an environment with `sidecars: false`, fails the load before any registration. A plugin surface that declares sidecars may be listed there, because the workbench does not mount such a surface without a host ([runtime module](#runtime-module)). Saved spaces are not environment files; their tabs and rails of unregistered plugins are dropped when a space opens ([projects](projects.md#persistence)). Stored sidebar sets and links are settings and pass the same sidebars validation as `environment.json`; a stored set that names an unregistered section, or a link that names a plugin without a surface, fails the settings load with an error ([settings window](settings.md#stored-sets-and-links)).

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

The workbench uses only these exports and does not branch on the runtime. When `host` is `null`, a surface whose plugin declares sidecars or a `hybrid` composition cannot run, because its sidecars, native regions, and exposure relay need the host. The workbench does not import its module; the surface slot shows the placeholder "<plugin name> 표면은 네이티브 호스트가 있어야 열립니다", the surface reports `ready`, takes no focus, and its placeholder leaves with its tab. A `dom` surface without sidecars mounts. Without a host, `report` writes its line to the console as an error.

Plugin pages import from `@soksak/plugin-api/page` and do not import workbench files: `followTheme`, `page`, `expose` ([exposure](exposure.md)), `ownManifest()` (the page's validated `plugin.json`), and `createSurfaceComposition(...)` ([surface composition](surface-composition.md)). The exported `page` object does not expose raw document or image attach/place ports. Region handles come only from the validated composition.

## Tests

### Browser sections

The browser page reports its session history as `browser.history`, `{entries: [{url, title}], index}` from its [document region](native-surfaces.md#document-regions), and `browser.history.go {index}` loads the entry at that position. The 히스토리 section lists the entries of the followed surface from the oldest, marks the current entry, and binds each entry to `browser.history.go`. The 탭 section follows `core.grid` and lists the tabs whose plugin is `browser` in the card that holds `context.surface` with their shown titles, marks the active tab, and binds each tab to `core.tab.select`. The page reports the document's elements as `browser.elements` and its recorded requests as `browser.requests`, the `elements` and `requests` of the region state. The DOM section lists the elements indented by depth as `tag#id.class` and states when the list is truncated; the 네트워크 section lists each request's type, address, and duration and states when the list is truncated. Both follow the section's surface and have no controls. After each region state, the browser page sets its tab title through `tab.title` ([tab reports](#tab-reports)) to the document title, or to the address when the title is empty, with control characters removed and cut to 256 characters; with neither it removes the title, so the tab shows its name. The 탭 section shows the same shown title.

### Browser address input

The browser address field selects its full value when it gains focus through the declared `browser.address.select` command. The initial pointer release preserves that selection, so typing replaces the previous address. Later clicks in an already focused field allow caret placement instead of selecting everything again. The plugin uses its owning Shadow Root to determine focus and releases all handlers when disposed. Text typed into the field stays until the field loses focus or a declared navigation command (`browser.navigate`, `browser.back`, `browser.forward`, `browser.reload`) runs; document state updates do not replace it. Otherwise the field shows `browser.location.url` after each state update, including while it keeps focus after Enter. The status `browser.address.text` reports `{value, focused}`, the text the field shows and whether it has focus. Native keyboard checks type the replacement directly; they do not manually select text to compensate for missing behavior.

Each directory runs its own tests with `pnpm test`. A package checks its boundary with fixtures and does not read another package's source or real names. The plugin API tests the formats. The workbench tests loading with fixture files. Each plugin tests its `plugin.json` and pages. Each application tests that its `environment.json` resolves against its real plugin dependencies. The workbench colors library previews from each plugin's `preview.ink` and contains no plugin-specific CSS.

### Settings declarations

A plugin may declare typed settings in `plugin.json` under `settings`. The object keys are plugin-local setting names; the workbench exposes them under `<plugin id>.<key>`. Each declaration has a `label` of 1 to 40 characters, the Korean row name in the settings window, and may have a `description` of 1 to 200 characters shown under the row; a description is required wherever the label and value names do not state what a value does. Each declaration also has `type`, `default`, and `values` for an enum; `type`, `default`, `minimum`, and `maximum` for a bounded integer; `type`, `default`, and `maxLength` for a non-empty string of at most `maxLength` characters; or `type` and `default` for an address, which is the empty string or an `http` or `https` address of at most 2048 characters. The settings window shows a string or an address as a one-line text field. The declaration is the only source of the type and validation rule; unknown setting keys and invalid defaults fail manifest validation.

An application may provide initial values in `environment.json` under `settings`, keyed by plugin id and local setting name. The values must name declared settings and pass the plugin declaration. The precedence is plugin default, application value, saved common value, then saved project override. Stored values are validated against the declaration before becoming effective; invalid stored data is an explicit load error and is not replaced.

`node scripts/check-boundaries.mjs` checks the boundary rules in source files: core packages do not name plugin or sidecar packages or plugin ids, and plugins and sidecars name only packages declared in their `package.json`. It does not check `apps/`, `e2e/`, declaration files (`package.json`, `plugin.json`, `sidecar.json`), or `.md` files.
