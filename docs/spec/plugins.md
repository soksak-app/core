# Plugins and application environments

[한국어](plugins.ko.md)

The independent window declaration, placement, association and rail-border contract is [external window sidebars](external-sidebars.md). The internal card-side contract remains independent.

The workbench does not reference any specific plugin. Each application declares its plugins and defaults in `environment.json`. Each plugin declares itself in `plugin.json`. [`@soksak/plugin-api`](../../packages/plugin-api/index.js) defines both formats, the `sidecar.json` format, the staged file layout, and the page import map. The workbench, plugins, and applications validate their own files with those functions.

## Workspace layout

| Directory | Contents |
| --- | --- |
| `packages/soksak` | Headless layout library |
| `packages/workbench` | Workbench frontend (core): projects, spaces, cards, tabs, sidebars, settings, plugin loading, and `soksak-stage` |
| `packages/plugin-api` | Declaration formats, staged layout, page import map, and helpers for plugin pages |
| `packages/client` | Client for the local endpoint and its latency benchmark |
| `packages/host/<name>` | [Native host](hosts.md) libraries (core): `wailsv3` in Go and `tauriv2` in Rust |
| `apps/<name>` | One application: `environment.json`, `runtime/`, the native entry point and framework configuration, and its tests |
| `native/darwin` | Shared macOS library used by the native hosts |
| `e2e` | Window checks for running native applications |

Plugins and sidecars live in their own repositories ([repositories](#repositories)).

Common functionality belongs to the workbench or the native host so plugins do not reimplement it. Plugin functionality does not move into the workbench. A sidecar holds native functionality for one domain and can serve several plugins; general functionality such as the message relay belongs to the host.

## Repositories

Core, each plugin and each sidecar are separate git repositories in sibling folders of the core checkout. Each keeps its own tests, its own `docs/features.md` checklist and its own build; none reads the files of another.

| Folder | Repository | GitHub |
| --- | --- | --- |
| `core` | The layout library, workbench, plugin-api, client, command line, hosts, applications, specifications and window checks | `soksak-app/core` |
| `../registry` | The public registry: one file per entry, its checks and its publication ([public registry](registry.md)) | `soksak-app/registry` |
| `../plugins/<id>` | One plugin: `plugin.json`, its pages, its `package.json` with `engines.soksak`, and its tests. The plugins are `browser`, `terminal`, `files` and `shell` | `soksak-app/plugin-<id>` for `browser`, `terminal` and `files`; `shell` is not published |
| `../sidecars/vt` | The terminal engine: the crates `vt-core` and `vt-alacritty`, and the sidecar `@soksak/sidecar-vt-alacritty` in `vt-alacritty` | `soksak-app/sidecar-vt` |
| `../sidecars/files`, `../sidecars/shell` | The sidecars `@soksak/sidecar-files` and `@soksak/sidecar-shell` | `soksak-app/sidecar-files`; `shell` is not published |

A checkout places the repositories in these sibling folders, and a workflow that needs more than one repository checks them out the same way, so the relative folders of `scripts/workspace-registry.json` hold everywhere.

The version of a plugin or sidecar is its own and has no relation to a core version; the `engines.soksak` range of a plugin states which core versions install it. A plugin repository depends on `@soksak/plugin-api` for its tests through a git dependency on a core release tag that its `package.json` names, with `path:/packages/plugin-api`; a sidecar repository whose tests validate its `sidecar.json` with `validateSidecar` depends on it the same way. The release workflow of a plugin or sidecar repository builds `sok` from a core release that the workflow declares in `CORE_RELEASE`, independent of the tag it releases. A plugin repository does not depend on sidecars for its build; the `dependencies` of its `plugin.json` name them and their ranges for installation. `make test` runs the tests of a plugin repository and `make pack OUT=<folder>` writes its release with `sok plugin pack`. A sidecar repository has `make test`, `make build`, which writes the executable that its `sidecar.json` names, and `make release OUT=<folder>`, which runs `sok sidecar release` for the current platform. The registry repository `../registry` receives a new plugin, sidecar or version, also from a third party, as a pull request that changes its entry files; its workflows check the pull request, merge it and publish the index ([public registry](registry.md)), and its `make build` runs `sok registry build`, which checks every release against its entry before it writes `index.json`.

Core window checks install plugins from a registry fixture. `scripts/workspace-registry.json` declares, by folder relative to the core checkout, the plugin repositories and the sidecar folders (the folder that holds `sidecar.json`), and the packs. `make registry` builds each declared sidecar, releases it, packs each declared plugin, and builds the index in `target/registry`; it uses no network. The `shell` plugin and `@soksak/sidecar-shell` have repositories but are not declared, so the new-space layout of both applications has a terminal card where it had a shell card.

## plugin.json

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | yes | Lowercase identifier. Tabs and settings reference it |
| `name` | yes | Display name |
| `description` | yes | One or two sentences of 1 to 200 characters that say what the plugin does; the [plugin screen](installation.md#plugin-screen) shows it, and the plugin screen and the settings window search it |
| `surface` | no | `{ "module": "ui/page.js", "composition": ... }`: a module inside the plugin and its required [surface composition](surface-composition.md). The module mounts into the app DOM; external web documents use document regions. A web address is not a surface |
| `mark` | with `surface` | Short text shown in the add menu and new tab titles |
| `icon` | with `surface` | SVG elements for a 16×16 view box |
| `sections` | no | Sidebar sections `{ "id": "<plugin id>.<name>", "name", "module" }`; `module` is a JavaScript path inside the plugin that draws the section, and the optional `fill: true` gives it the remaining sidebar height ([sections](#sections)) |
| `sidebars` | no | Local default sets and optional four-side `card` assignments ([default sidebar sets](#default-sidebar-sets)) |
| `preview` | no | `{ "ink": "--<token>" }`: the theme token name that colors the plugin's cards in library previews; requires `surface` |
| `dependencies` | no | `{ "<package>": "<version range>" }`: the sidecars and plugins the plugin needs, each with the range of its versions that the plugin works with ([versions and ranges](installation.md#versions-and-ranges)). A dependency names either a [sidecar](sidecars.md) that the page surface or the state module uses, and then requires `surface` or `state`, or a plugin whose [extension points](#extension-points) the plugin contributes to, and installing the plugin installs it. A dependency names a plugin when a plugin of the registry index or of `installed.json` has that name, and a sidecar otherwise. It is the only declaration of the plugin's requirements of other sidecars and plugins |
| `extends` | no | `{ "<point>": { "version": "x.y.z", "schema": <schema>, "modules"?: { "<bare specifier>": "<path>" } } }`: the [extension points](#extension-points) that other plugins contribute to; requires `surface` |
| `contributes` | no | `{ "<plugin id>.<point>": [ { "range": "<version range>", "module": "<path>", ... } ] }`: the items the plugin contributes to extension points of other plugins |
| `state` | no | `{ "module": "ui/state.js" }`: the [plugin state](#plugin-state) module that holds state outside a surface; requires `sections` |
| `data` | no | `{ "<key>": { "schema": <schema>, "default": <value>, "format"?: <positive integer> } }`: [project data](#project-data) the state module stores for each project; requires `state` |
| `background` | no | `{ "sidecar": "<declared sidecar>", "operation": "<operation name>", "settings"?: { "<request field>": "<declared setting>" } }`: keeps one declared sidecar session for each non-active tab without creating a native surface; the workbench puts the current value of each mapped plugin setting into the request field, and `settings` cannot name `operation` or an undeclared setting; requires `surface` and `dependencies` |

A plugin requires `surface`, `sections` or `contributes`. Only plugins with a surface appear in the add menu and own a card-left sidebar. The workbench imports `modules/<name>/<module>`, where `<name>` is the `name` of the plugin's `package.json`, and calls its `mount(root, context)` export. The surface identifier is an explicit context member, not a URL query. The old `page` declaration is rejected; it does not select an alternate implementation. Unknown fields are rejected.

`surface.params`, when present, is the schema of the parameters of a tab of the plugin, in the schema subset of exposure declarations with `type` `object`. `core.card.add-tab {card, plugin, params}` checks `params` against it, stores them with the tab in the space layout, and fails with `params do not match <plugin> surface.params` or, for a plugin without `surface.params`, `plugin <plugin> declares no tab params`. The surface context gives them as `tab.params`, a copy, or `null` for a tab without parameters. A stored tab whose parameters do not match the declaration of the loaded plugin opens as a placeholder that states `<plugin> <version> 탭의 인자가 선언과 맞지 않습니다` with the reason, and the parameters are not converted.

`surface.opens`, when present, is `{ "extensions": [...] }`: the file name extensions, without the dot and in lowercase, of the files that the plugin opens, or `"*"` for any file. It requires `surface.params` with a string property `path`. `core.file.open {path, card}` opens the file `path`, relative to the root of the project that the window shows, in the plugin that declares the file's extension, or else in the plugin that declares `"*"`; a file whose name has no extension is opened only by `"*"`. When a tab of that plugin with the same `path` exists in the space, the command activates it; otherwise it adds a tab with `params` `{path}` to `card`, or to the focused card when `card` is omitted. The command fails with `no plugin opens <path>` when no loaded plugin declares the extension or `"*"`, with `<path> is opened by <plugin> and <plugin>` when more than one loaded plugin declares the deciding entry, with `path must be relative to the project root: <path>` for an absolute path or a path with a `..` segment, and with `this window shows no project` in a window without a project.

`surface.drop`, when present, names a command in `exposes` that the page runs on the surface when files are dropped on it, with `{urls}` holding the dropped file URLs ([native surfaces](native-surfaces.md#input-over-native-views)).

`surface.composition` is either `{ "kind": "dom" }` or a hybrid declaration with `kind: "hybrid"`, complete `regions`, and complete `overlays`. An image region names a sidecar already listed in `dependencies`. The manifest declaration is authority data sent to the host; page code cannot add a region, supplier, input owner, or stacking entry that is absent from it.

## Default sidebar sets

Optional plugin `sidebars` contains `sets` and optional `card` and `window` mappings. Each set is `{id, title, sections, layout}` with a local lowercase identifier; `layout` is `list` or `tabs`. Section IDs may refer to any installed plugin. A `card` mapping requires a surface and maps `top`, `bottom`, `left`, and `right` to local set IDs. Missing sides declare no default. Unknown fields, duplicate or reserved local IDs, missing sets, and uninstalled sections fail explicitly.

A `window` mapping accepts `left` and `right` local set IDs and does not require a surface. It is independent of `card`; invalid mappings or missing local sets fail explicitly.

Core normalizes each local set ID to `<plugin>.<local>`, each card mapping to `{place: "card-<side>", plugin, set}`, and each window mapping to `{place: "window-<side>", plugin, set}`. An omitted environment `sidebars` uses these normalized defaults. An explicit environment `sidebars` supplies both `sets` and `links` and replaces both lists completely. Stored common and project lists then override each effective list as specified in [settings](settings.md#stored-sets-and-links). Defaults removed by an override are not restored. Plugin declarations are validated even when environment overrides replace their output.

Window links require registered plugins but not surfaces; card links require surfaces. A `left` or `right` link is the general choice and requires `plugin: null`; a plugin-specific window link uses `window-left` or `window-right`.

## Sections

A section's `module` is either one JavaScript path used in both orientations or `{horizontal, vertical}` paths. The object requires both keys and rejects other keys. Each value is a relative `.js` path inside the plugin, and both files must be published. A missing orientation is not replaced by the other implementation. Card layout selects `horizontal` for top/bottom and `vertical` for left/right and external window sidebars. The workbench passes `context.orientation` to the selected implementation's `mount(root, context)` and exposes orientation in `core.sidebars`. An orientation change disposes the old implementation and mounts the new one while preserving section selection and folding. Horizontal `list` places sections left to right; vertical `list` places them top to bottom. Final shared suites and release application remain pending.

A section is part of a sidebar that a plugin draws. The workbench imports the section's `module` and calls its `mount(root, context)` export in the section's element, as it does for a surface page, and calls the returned dispose function when the section leaves the sidebar. `context.card` is the id of the card the sidebar belongs to and `context.surface` is that card's active tab, or both are `null` for the left sidebar. Sections are drawn in the application document; they have no native surface.

A section shows its plugin's state through the plugin's declared statuses and changes it through the plugin's declared commands; it keeps no copy of that state. `context.status(name, fn)` follows a status of the section's plugin and returns a function that stops following. `fn(value, source)` receives the current value and every later change; `source` is the surface that registered the status, or `"state"` when the plugin's state module registered it. A status that the state module registered is followed before any surface. Otherwise the section follows `context.surface` when that surface registered the name, otherwise the surface a request without `surface` would use ([choosing a surface](exposure.md#choosing-a-surface)), and receives `fn(null, null)` while no surface registered it; it chooses again when registrations change. A failure to start, read, or stop following a status is reported as a page error. `context.bind(element, name, params, options)` connects an element to a command of the section's plugin with the shared binder and gives it the dom name `core.sidebar.section.control`, because the element belongs to the application document and not to a surface page. The command runs in the state module when it registered the command, on `context.surface` when that surface registered it, otherwise on the surface a request without `surface` would use. A section may also follow a core status and bind a core command, whose names start with `core.`; `context.status` then follows the application document's registration and `source` is `"core"`. The application document registers its core statuses and commands before it awaits anything at startup, so they are registered before the first section mounts. An operation that a library draws inside its own shadow root, such as opening a folder of a tree, reaches its command through the element that holds the library: the section binds that element to the command with a custom event (`context.bind(holder, name, (event) => params, {event: "<type>"})`) and dispatches the event with the operation's parameters in `detail`. A section cannot use names of another plugin. `core.sidebars` reports the text each section drew and the number of its controls, so checks read what a section shows and find its controls among the `core.sidebar.section.control` elements.

A set combines sections of any plugins in order and has a `layout` chosen when the set is made. With `list` the sidebar shows every section of the set top to bottom in vertical orientation and left to right in horizontal orientation, each under a header with its name that folds and unfolds it. With `tabs` the sidebar shows a row of tabs with the section names and only the section of the selected tab. The selected tab and the folded sections are kept for each sidebar and saved with the space ([projects](projects.md#persistence)), so a reload and a restart show them again. Card layout selects section orientation and arrangement by side.

A sidebar shows no set title or place label: its sections start at its top. A window sidebar ends in a status line that states its place and ends in a fold control (`core.sidebar.fold`) that turns the sidebar off with `core.settings.set` (`left` or `right` false); the window header control turns it on again; an internal card sidebar ends in its own status line that names its side and its set ([card layout](example-model.md)). A folded section keeps only its header. A section takes the height of its content, except that open sections declared with `fill: true` share the sidebar height left after the other sections and scroll their content inside it; a folded fill section gives that room to the other fill sections. The height is declared because a virtual list, such as the file tree, has no content height from which the workbench could tell that it needs room, while a short list that stretched would show empty space. Section headers have the height of a card header and the status line has the height of a card footer, so their rules line up with those of the neighbouring cards. A section states an empty list in words, such as 기록 없음.

The sidebar is identified by the id of the card that holds it: `left`, `right`, or `cardId:side` for an internal card sidebar (`top`, `bottom`, `left`, `right`). Folding a section header runs `core.sidebar.section.fold` and choosing a tab runs `core.sidebar.section.select`, both with `{sidebar, section}`; status `core.sidebars` reports every drawn sidebar with its set, layout, selected tab, and each section's fold and mount state. A section module is a file listed in the `files` of `package.json`, so the plugin release holds it; `sok plugin pack` fails when a section module is not listed.

An open fill section in a vertical list retains its intrinsic header and body minimum height. When the sidebar is smaller, the whole set scrolls rather than shrinking a section to zero height. A plugin using a virtual list declares its minimum visible row height. The file tree reserves a 28-point toolbar and at least one 20-point row. This does not increase the card content residual or change saved sidebar sizes.

## Plugin state

A plugin without a surface, or with state that no single tab owns, declares a `state` module. While a window shows a project, the workbench imports the module once and calls its `mount(context)` export; when the window shows another project or the library, it calls the returned `dispose` first. The context has:

- `project`: `{id, root}`, the shown project and its canonical directory ([projects](projects.md)).
- `exposure.status(name, read, subscribe)` and `exposure.command(name, run)`: register the plugin's declared statuses and commands in the application document's registry. `subscribe(fn)` may be called more than once and returns a function that stops that subscription. These entries answer requests without `surface` before any surface registration of the same name ([choosing a surface](exposure.md#choosing-a-surface)), and dispose removes them.
- `sidecar`: `{send(body), on(fn), onFailure(fn)}` for the plugin's only declared sidecar; `onFailure` receives the reason of each [sidecar failure](sidecars.md#failure) of the session. The session identifier is `state:<plugin id>:<project id>`, so the host gives the sidecar the project directory as `root` ([sidecars](sidecars.md#messages)).
- `data.get(key)` and `data.set(key, value)`: the plugin's [project data](#project-data).

The state module is a file listed in the `files` of `package.json`; `sok plugin pack` fails when it is not listed. A mount or dispose failure is reported as a page error.

## Project data

`data` declares keys that the state module stores for each project. `schema` uses the schema subset of exposure declarations (`type`, `enum`, `properties`, `items`), and `default` must match it. The optional `format` is a positive integer, 1 when omitted, that the plugin increases when it changes the stored form of the key. The workbench stores each value as `{ "format": <format>, "value": <value> }` in the project's `plugins.<plugin id>.<key>` entry of `projects.json` ([persistence](projects.md#persistence)). `data.get` returns the stored value or the default and fails when a stored value does not match the schema; `data.set` fails without writing when the value does not match or the key is not declared, stores the declared format, and resolves after the store accepted the write.

A stored entry is in the current form when it is an object with exactly `format`, a positive integer, and `value`. Before the workbench mounts a state module for a project, it converts each declared key stored in an earlier form or format, once: a value stored without a format, the form before formats existed, is format 1; a value of a lower format than the declaration is passed to the state module's `convertData({ key, format, value })` export, which returns the value in the declared format. The workbench checks the value against the schema, stores it with the declared format, and writes a line that names the project, plugin, key and both formats to the application log. A value stored with a higher format than the declaration, a missing `convertData` export, a failing conversion, or a value that does not match the schema is left unchanged, and `data.get` of that key fails with a message that names the project, plugin, key and formats or the schema mismatch.

## Extension points

A plugin extends another plugin through an extension point that the other plugin declares. The provider declares the point in `extends`, a contributor declares items in `contributes`, and the workbench connects them from these declarations alone; no plugin names another in its code.

- **Names and versions.** A point `<name>` of the plugin `<id>` is named `<id>.<name>`. `version` is the version of the point's interface, and each contributed item states with `range` which versions it works with. A provider raises the major part of `version` when an item written for the previous version can fail, and the minor part when it adds to the interface.
- **Items.** Each item has `range`, `module`, a JavaScript path inside the contributor, and the fields that the point's `schema` declares, in the schema subset of exposure declarations. The workbench validates every item against the schema.
- **Shared modules.** `modules` maps bare import specifiers to files of the provider. The page import map maps `@soksak/shared/` to `/shared/`, and `/shared/<plugin id>.<point>/<specifier>.js` serves the provider's file for that specifier ([serving installed plugins](installation.md#serving-installed-plugins)); the path ends in `.js` because the webview of the Tauri host takes the MIME type of a module from the end of its path. The provider and its contributors import a shared library as `@soksak/shared/<plugin id>.<point>/<specifier>.js`, so they load it from one URL and use one instance; each bundles the library as that external import.
- **Connection.** When a page loads, the workbench resolves the contributions of the installed and enabled plugins. An item is `connected` when its provider is installed and enabled and its `range` contains the point's `version`, `provider-missing` when the provider is not installed or not enabled, `version-mismatch` when the range does not contain the version, and `invalid` when the item does not match the schema or its module fails to load or to extend. The status `core.contributions` reports every item as `{plugin, point, state, reason}`; a state other than `connected` is not an error of the application, and `invalid` is shown through the error display.
- **Installation.** A contributor that names the provider in `dependencies` is installed together with the provider. A contributor without that dependency is connected only when the provider is installed. Installing, enabling, disabling or removing a contributor or a provider applies to pages that load after the change, like any plugin change ([installation](installation.md)).
- **Provider interface.** The surface context of the provider's page has `contributions(point)`, which returns the connected items of that point as `{plugin, item, module}` with `module` the URL to import. The provider imports each module and calls the export that the point's interface defines; an export that fails makes that item `invalid` and leaves the other items connected.
- **Privileges.** A contributed module runs in the provider's page with the privileges of that page. Installing a contributor gives it what the provider's page receives, such as the provider's documents and input.

## Third-party libraries

A plugin page, section, or state module imports only files inside its plugin and the shared modules of [extension points](#extension-points), and a provider page also the contributed modules of its points, because staging copies the `files` of `package.json` and the page import map names only core modules and `@soksak/shared/`. A plugin that uses a third-party browser library bundles it into one ES module under `ui/vendor/` with a `scripts/build-vendor.mjs` of its own (esbuild), commits the bundle together with a `.LICENSE.txt` file that holds the license and notice texts of every bundled package, and lists them in `files` through `ui`. The library and esbuild are exact-version `devDependencies`. The plugin's `pnpm test` runs the script with `--check`, which fails when the committed files differ from a new build. The files plugin bundles `@pierre/trees` 1.0.0-beta.4 (Apache-2.0) and its `preact` dependency (MIT) through the vanilla entry `@pierre/trees`; plugins do not use React.

## Diagnostic declarations

A plugin with a surface may keep status and command entries that exist only for checks in a `diagnostics.json` file at the root of the plugin: `{ "module": "ui/<file>.js", "exposes": { ... } }`. `module` is a file inside the plugin, and `exposes` has the form and owner rules of `plugin.json` `exposes`. A name is declared in `plugin.json` or in `diagnostics.json`, not in both. Neither `diagnostics.json` nor its module is listed in the `files` of `package.json`, so a plugin release holds them only when `sok plugin pack --diagnostics` writes it ([command line](cli.md#releases-and-the-registry)); staging and packing fail when either is listed. An entry belongs in `diagnostics.json` when it injects state that user input or the OS produces, or records internal events for a check; an entry that reports visible state or performs a user operation belongs in `plugin.json`.

In a diagnostic build the workbench adds the declarations to the plugin's surface declarations and imports the module before it mounts the surface. The surface context carries the module as `diagnostics`; in a release build `diagnostics` is `null`. The surface module passes it to its implementation, which calls the module with the internal operations the diagnostic entries use.

## Surface module ownership

Each OS window has one app DOM WebView. The workbench owns the surface element and its Shadow Root; a plugin owns the DOM it mounts inside that root. Shadow DOM isolates styles, not security privileges. The context exposes surface-scoped commands, statuses, DOM bindings, sidecar messages and [sidecar failures](sidecars.md#failure), and the declared composition controller. The host validates the window, surface, and declaration again. Sidecar messages sent through the context reach the sidecar in send order: the workbench starts a send only after the previous send to the same sidecar finished, and every surface and background session of that sidecar shares one order. A send whose surface is not the context's surface is rejected. Plugins do not create internal WebViews or iframes.

`mount(root, context)` may be asynchronous and returns `{ dispose() }`. Native surface registration completes before mounting can attach a region. Mounting failure is a visible error; it cannot become a successful empty surface. Native readiness requires the first presented region, not merely a completed module import. The workbench distinguishes loading, ready, and error.

Hiding a tab or visiting the library hides its DOM and native regions without disposing its module or closing its session. Explicit removal disposes the module and releases its bindings, event subscriptions, and regions; disposal failures are reported. Removal does not wait for a module that has not finished mounting: it releases the regions that the module created and removes the surface at once, a later `composition.create` of that module fails, and when its mount ends the workbench disposes the returned module. The workbench gives a surface focus after the module is ready and the layout is presented; when the removal of the surface starts while that focus waits, it does not call the module's `focus`, because the detached regions of a disposed module reject focus. The workbench detaches the regions of the module's compositions before it calls the module's `dispose`, because a module ends its sidecar session in `dispose` and a supplier releases its transfer images when its session ends; a frame that the supplier sent before that is then answered `stale` for a detached region instead of failing with `notFound` on a region that is still attached ([image regions](native-surfaces.md#image-regions)). Every operation remains subject to the shared binder and [exposure](exposure.md) contract. Menus and settings are DOM overlays in the same app WebView, with declared input ownership above native regions.

A `background` declaration is an explicit session-lifetime contract, not a second page or a hidden WebView. The workbench sends the declared `operation` through the declared sidecar using the sidecar message protocol. The manifest uses the full field name `operation`; the sidecar request body retains its existing operation selector. The workbench does not invent a request, substitute a missing operation, or hide an error. When the tab becomes visible, its surface sends the same operation with its image region and reattaches to the existing session. Removing the tab removes the background session.

## Tab reports

A surface context has `tab.title(text)`, `tab.footer(text)`, `tab.directory(path)`, `tab.notify(text, policy)`, `tab.modified(value)`, and `tab.error(text)`, a frozen `origin` object, and a frozen `project` object.

`tab.modified(value)` reports whether the surface holds changes that are not saved, as `true` or `false`; another value throws. While a tab is modified it shows a dot before its name, `core.grid` reports `modified` for each tab, and the state is not saved with the layout. `surface.save`, when present, names a command in `exposes` that saves the surface's changes. `core.tab.close` and `core.card.close` do not close a modified tab: the workbench opens the selection layer `<name> 탭에 저장하지 않은 변경이 있습니다` at the tab with 저장하고 닫기 (only with `surface.save`), 저장하지 않고 닫기 and 닫지 않기, and the command answers `{closed: false}`. 저장하고 닫기 runs the save command on the surface and closes the tab when the command succeeds and the tab is no longer modified; a failed save reports `저장하지 못했습니다 · <command>: <error>` as the tab's error and keeps the tab. 저장하지 않고 닫기 closes the tab and discards its changes; 닫지 않기 and closing the layer keep it. Closing a window, quitting the application, removing a space and removing a project ask in the same way for each modified tab before they proceed.

`tab.error(text)` shows the error of an operation of the surface that failed after the surface became ready, such as a save, as text of 1 to 1024 characters without control characters, and `tab.error(null)` removes it; another value throws. While the tab is active, its card's status row shows the text through the error display, which writes `error: tab error <tab id>: <text>` to the application log when the text appears. `core.grid` reports `error` for each tab, the text or `null`, and the error is not saved with the layout. The surface status keeps `error` for a failure of the surface itself, which stays until the tab closes.

`tab.title(text)` sets the title that the surface's tab shows in place of its name, and `tab.title(null)` removes it so the tab shows its name again. The text is a string of 1 to 256 characters without control characters (U+0000–U+001F and U+007F–U+009F); any other value throws. The title is not saved with the layout. `core.grid` reports each tab's shown title as `label`, or `null`.

`tab.footer(text)` sets the text that the content footer of the surface's card shows while the surface is the card's active tab, such as the terminal's working directory or the address of the link under the pointer in a browser document, and `tab.footer(null)` removes it. The text is a string of 1 to 1024 characters without control characters; any other value throws. The footer text is not saved with the layout. `core.grid` reports each tab's footer text as `footer`, or `null`, and each card's shown footer as `status`.

`tab.notify(text, policy)` gives the tab a notice when the tab is not the active tab of the focused card; for that tab the call changes nothing, because the surface is in view. `policy` is `tab` or `system`; omitted policy means `tab`. The terminal plugin supplies its `terminal.notifications` setting. The text follows the title rules with up to 1024 characters; another value throws. `tab` shows the dot and tooltip in `core.grid`; `system` sends the notice only to the host notification center and reports `notice: null` in the grid. The notice is removed when the tab becomes the active tab of the focused card or is closed, and a later notice replaces an earlier one. The workbench does not save notices.

The `system` policy is a system notification. The host posts it through the operating system's notification center with the tab's label as the title and the notice text as the body, also while the application is active; a later notice of the tab replaces the tab's notification, and removing the notice removes it. If the host cannot start the notification center, it reports the native error and does not silently switch to `tab` or drop the notice. Activating a notification makes its window the key window and runs `core.tab.select` for its tab. `core.notifications` reports `{authorization, error, posted}`: `authorization` is `notDetermined`, `denied`, `authorized`, or `provisional`; `error` is the last failure to request permission, post, or remove a notification, or `null`; and `posted` lists, in order, the tabs of the window whose notification the notification center accepted and that were not removed since. While permission is denied, the tooltip of a tab with a notice and of its card's tab list button ends with the line `System notifications are turned off for this application.`

`tab.directory(path)` records the surface's working directory, an absolute path, and `tab.directory(null)` removes it; any other value throws. The workbench does not read the filesystem for it and does not save it. When `+` or a split creates a tab, the new surface's `origin.directory` is the directory that the active tab of the card that was added to or split recorded at that moment, or `null`.

`project` is `{root}` with the canonical `root` of the project that the surface's window shows when the surface mounts ([projects](projects.md#project-identity)), or `null` in a window without a project. A surface that starts in a working directory uses `origin.directory` when it is not `null`, otherwise `project.root`, otherwise the account's home directory.

## Opening links

A surface context has `runtime.links.open(url)`, which asks the host to open an absolute `http`, `https`, or `mailto` URL with the user's default application for its scheme. The host rejects another scheme, a URL that does not parse, and a URL longer than 8192 characters, and the returned promise rejects with the reason. The macOS hosts open the URL through `NSWorkspace`; the Windows platform returns `not implemented on windows`.

## Tracing

`context.runtime.trace(event, fields)` writes an event of the surface to the [performance trace](performance-trace.md) with the page layer: `event` is a non-empty name and `fields` an object, and the event carries `plugin` and `surface`, the ids of the plugin and the surface. It writes nothing while the trace is off and on a page without a host. A plugin traces the steps of an input whose effect it cannot show otherwise, so a defect that appears once is recorded with the events of the host and the sidecars.

## Icons

A surface context and a section context have `icon(name)`, which returns the core icon `name` as SVG markup with a 24-unit `viewBox`, stroke paths only, and `aria-hidden`; an unknown name throws. Core keeps the icons in `packages/workbench/icons.js`, and a plugin page draws them through the context instead of carrying its own artwork, because plugins cannot import the workbench. The markup carries no style: the page sets the size, color, and stroke in its own Shadow Root. The names are `star`, `projects`, `panel-left`, `panel-right`, `sun`, `moon`, `settings`, `close`, and the Lucide icons `chevron-left`, `chevron-right`, and `rotate-cw`.

The browser back, forward, and reload buttons draw `chevron-left`, `chevron-right`, and `rotate-cw` with the look of the card header buttons: a 20×20 button, a 14px icon, the `--muted` color, and the `--inset` background with the `--fg` color under the pointer. The stroke width is 1.95 units, which draws the icon with the width of the header buttons' 1.3-unit stroke in a 16-unit `viewBox`.

## environment.json

| Field | Meaning |
| --- | --- |
| `runtime` | Directory inside the application that contains the runtime module `index.js` |
| `workspace.grid` | Grid lines and cards of a new space. A card with `tabs` lists `{ plugin, title }` entries. An optional card `width` is a finite positive number of points; the left and right fixed sidebar cards start at that width and use `sidebarWidth` when it is omitted |
| `workspace.focus` | Card focused in a new space; it must have tabs |
| `sidebars.sets` | Optional explicit override of plugin defaults: section sets `{id, title, sections, layout}`; `layout` is `list` or `tabs` |
| `sidecars` | Optional. `false` states that the runtime cannot run [sidecars](sidecars.md), as in the browser example; the load fails when an installed plugin's `state` module uses sidecars in such an environment. The default is `true` |
| `starter` | Optional. The registry pack that the [first run](installation.md#first-run) installs |
| `registry` | Optional. The `https:` or absolute `file:` URL of the default registry index that the first run sets when no registry is set ([first run](installation.md#first-run)) |
| `sidebars.links` | Default sidebar choices: general left/right links, four card-side links, and window-left/window-right links. Plugin left/right forms, null sets and rail links are rejected. |

The workbench registers `environment.json` and the [installed plugins](installation.md#serving-installed-plugins) with their manifests, in the order of their ids, which is the add-menu order, before it applies settings or builds a space. A tab or card-side link that names a loaded plugin without a surface, a set that names a section that its loaded plugin does not declare, or a plugin whose state module uses sidecars in an environment with `sidecars: false`, fails the load before any registration. References to plugins that are not loaded follow [plugins that are not loaded](#plugins-that-are-not-loaded). A plugin surface that declares sidecars may be listed there, because the workbench does not mount such a surface without a host ([runtime module](#runtime-module)). Saved spaces are not environment files; opening rejects invalid or obsolete window sidebar state ([projects](projects.md#persistence)). Stored sidebar sets and links are settings and pass the same sidebars validation as `environment.json`; a stored set that names a section its loaded plugin does not declare, or a card-side link that names a loaded plugin without a surface, fails the settings load with an error ([settings window](settings.md#stored-sets-and-links)).

## Plugins that are not loaded

A plugin is loaded when the window loaded its manifest at startup. Installation can remove or disable a plugin that saved spaces, settings and project data still name, so a reference to a plugin that is not loaded is kept unchanged and does not fail a load:

- A content tab of such a plugin opens as a placeholder card. The card shows the plugin id and one line by the reason, and the tab keeps its id, title and stored state in the saved space; closing the tab removes it as for any tab. `core.surfaces` reports the tab with `placeholder` set to the reason; a mounted surface reports `placeholder: null`.

| Reason | Line | Action |
| --- | --- | --- |
| `missing` | <plugin> 플러그인이 설치되어 있지 않습니다. | 설치, `core.plugins.install {plugin}`, when the registry index lists the plugin |
| `disabled` | <plugin> 플러그인을 사용하지 않습니다. | 사용, `core.plugins.enable {plugin}` |
| `reload` | 창을 다시 불러오면 <plugin> 플러그인이 열립니다. | none; 적용 on the plugin card reloads the window ([applying a change](installation.md#applying-a-change)) |
| `host` | <plugin> 플러그인은 네이티브 호스트가 있어야 설치됩니다. | none; the application has no host |
| `unread` | <plugin> 플러그인의 설치 상태를 읽지 못했습니다. | none; the plugin state cannot be read |

  The reason is `disabled` when `installed.json` lists the plugin disabled, `reload` when it lists the plugin enabled, `missing` when it does not list it, `host` without a host, and `unread` when the [plugin state](installation.md#plugin-operations-in-the-application) cannot be read. The workbench reads the plugin state before it opens the first space. The card updates its reason after each `plugins-changed` event.
- A sidebar link that names such a plugin is kept and selects no content. A set section whose plugin, the id before the first `.`, is not loaded is kept in the set and not shown; the set editor shows its row as "<section id> (불러오지 않음)" with ▲, ▼ and −.
- Project data under `plugins.<plugin id>` of such a plugin is kept unchanged.
- `environment.json` entries that name such a plugin are kept: its `settings` are neither checked nor applied, and its `workspace` tabs open as placeholder cards. An application whose environment names a plugin therefore still starts after that plugin is disabled or removed.

A plugin that becomes loaded after a restart uses the kept tabs, links, sections and data again.

## Staged layout

`soksak-stage <output> [--diagnostics] [--installed <configuration directory>]` runs in an application directory and resolves packages through Node module resolution. It copies files without changing them:

| Path | Source |
| --- | --- |
| `/` | `files` of `@soksak/workbench` |
| `/modules/<package>/` | `files` of `soksak` and `@soksak/plugin-api` |
| `/runtime/` | The application's `runtime` directory |
| `/environment.json` | The application's `environment.json` |
| `/diagnostics.js` | With `--diagnostics`, the workbench's `observe.js` (the page diagnostic methods); otherwise the workbench's empty module `release-diagnostics.js` |
| `/transcript.js` | With `--diagnostics`, the workbench's `transcript.js` (the call recorder of the diagnostic module); otherwise absent |

An application has no plugins in its bundle: the host serves the plugins installed in the configuration directory ([serving installed plugins](installation.md#serving-installed-plugins)). An application without a host, the browser example, passes `--installed <configuration directory>`, and the tool then writes the documents a host would serve from that directory: `/installed-plugins.json` and the files of each enabled installed plugin at `/modules/<package>/`, with `diagnostics` only under `--diagnostics`.

Every file imported by published files must be listed in the `files` array of its `package.json`; this is validated by `packages/workbench/test/published-imports.test.mjs`.

The debug staging targets `frontend-wailsv3` and `frontend-tauriv2` add `--diagnostics`; release builds contain no page diagnostic code, and plugin diagnostic code reaches only configurations that install [diagnostic releases](cli.md#releases-and-the-registry). `make release-check` fails when a staged release frontend contains `/transcript.js` or a page diagnostic module.

Every page declares one import map equal to `PAGE_IMPORTS`: `soksak`, `@soksak/plugin-api`, `@soksak/plugin-api/page`, `@soksak/runtime`, and `@soksak/workbench/`.

## Runtime module

`runtime/index.js` exports:

| Export | Meaning |
| --- | --- |
| `host` | Main-page host interface (`call`, `on`, `page`, `draggable`), or `null` without a native host |
| `page` | Surface and modal page interface (`theme`, `sidecar`, `exposure`, `document`, `modal`), or `null` without a native host |
| `openStore()` | Returns the workspace store. The browser application uses IndexedDB; native applications return `HostWorkspaceStore` |
| `windows` | Window and project-folder interface. Native applications export `hostWindows(host)` from `@soksak/workbench/host-windows.js`; the browser application exports its own implementation |

`runtime/start.js` default-exports the [start document](native-host.md#page-start) of the window's main page; only the main page imports it.

`windows` has these members:

| Member | Meaning |
| --- | --- |
| `createsFolders` | `true` when `chooseFolder` and `createFolder` are available |
| `newWindow()` | Opens a new window. The browser application opens a tab |
| `onActivate(fn)` | Calls `fn` when the host asks the window to show a project |
| `onCloseRequest(fn)` | Calls `fn` when the host asks the window to close |
| `ready()` | Reports that the window can receive requests |
| `close()` | Closes the window |
| `closeKept()` | Reports that the page kept a modified tab after a close request, so the window stays open; the host ends the quit that the request belonged to |
| `state()` | Returns the window geometry, or `null` when the runtime has none |
| `folder(root)` | Returns `{ root, identity }` for a project directory. The browser application returns the trimmed path and the identity `path:<trimmed path>` |
| `chooseFolder()` | Shows the folder selection dialog. The browser application rejects the call |
| `createFolder({ parent, name })` | Creates a project folder. The browser application rejects the call |
| `openProject({ id, root, title, geometry, separate, current })` | Opens a project and returns `{ local }`; `local` is `true` when the calling window shows the project. The browser application opens a separate project in a new tab |
| `releaseProject(id)` | Releases the calling window's ownership of a project |
| `askRemoveProject(id)` | Asks the window that shows the project whether the project may be removed and resolves `true` when it may; resolves `true` at once when no other window shows it |
| `onRemoveProjectRequest(fn)` | Calls `fn(id)` when another window asks whether the project that this window shows may be removed |
| `answerRemoveProject(id, allowed)` | Answers a removal request of `onRemoveProjectRequest` |

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

`node scripts/check-boundaries.mjs` checks the boundary rules in source files: core packages do not name plugins, sidecars or plugin ids, and plugins and sidecars name only the dependencies declared in their `package.json`. It does not check `apps/`, `e2e/`, declaration files (`package.json`, `plugin.json`, `sidecar.json`), or `.md` files.
