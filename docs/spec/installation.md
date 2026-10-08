# Plugin installation formats

[한국어](installation.ko.md)

These are the formats that plugin installation uses. The [command line `sok`](cli.md) validates them in both implementations, and the host contract cases `install.*` state each rule ([host contract](host-contract.md)). Every check rejects an unknown field and names the field that is wrong; fields are checked in a fixed order, so a file with several errors reports the same one in both implementations. A version part is at most 4294967295. [Serving installed plugins](#serving-installed-plugins) states how the hosts and the workbench load them.

## Versions and ranges

A version is `x.y.z` with numeric parts and no leading zeros; versions compare by number. A range is one of:

| Range | Versions |
| --- | --- |
| `*` | `>=0.0.0`: every version |
| `x.y.z` | that version only |
| `^x.y.z` | from `x.y.z` below the next change of the first non-zero part: `^1.2.3` is below `2.0.0`, `^0.2.3` below `0.3.0`, `^0.0.2` below `0.0.3` |
| `~x.y.z` | from `x.y.z` below `x.(y+1).0` |
| `>=x.y.z` | `x.y.z` and every later version |
| `>=x.y.z <a.b.c` | from `x.y.z` below `a.b.c`; an empty range is rejected |

Other forms, such as `latest`, `**` or pre-release suffixes, are rejected.

## Plugin release

A plugin release is the file `<id>-<version>.tgz` of the plugin's files that `sok plugin pack` writes. Its `package.json` declares:

| Field | Meaning |
| --- | --- |
| `name` | The name under which the installed files are served at `/modules/<name>/` |
| `version` | Plugin version |
| `engines.soksak` | Range of core API versions the plugin supports |
| `files` | Paths inside the plugin that the release holds; it includes `plugin.json` |

Other `package.json` fields belong to package tools and are not read, except `soksak`, which is refused: the sidecars of a plugin and their ranges are the `dependencies` of its `plugin.json` ([plugins](plugins.md#pluginjson)).

A plugin repository builds against the `@soksak/plugin-api` of one core release. Its `engines.soksak` is `*`, which every core version satisfies, `^<version>` of that `@soksak/plugin-api`, which only that release satisfies, or `>=<x.y.z>` with a lower bound up to that version, which that core release and every later one satisfy; a plugin that uses a manifest field that core added in a release declares `>=` that release. The command `soksak-engines` of `@soksak/plugin-api` checks it in the plugin repository and fails with `package.json: engines.soksak <range> must be *, ^<version> or >= a version up to <version>, the @soksak/plugin-api version`; each plugin repository runs it in `make test`.

## Sidecar release

A sidecar version is released as one release per platform, `<file name>-<version>-<platform>.tar.gz`. The file name of a sidecar `@scope/name` is `scope-name`; an unscoped name is used as it is. A platform is one of `darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64`, `windows-arm64` and `windows-x64`. The installer checks a sidecar release only against the `sha256` of its registry entry before it extracts and runs it; a sidecar, including one from a third party, is not signed or otherwise reviewed by the application.

## Registry index

The registry index `index.json` has `format` 1 and these lists:

| Field | Entry |
| --- | --- |
| `plugins` | `{ id, package, name, description, license, repository, versions }`; each version is `{ version, release: { url, sha256 }, engines: { soksak }, sidecars }` where `sidecars` maps the sidecar dependencies of the version's `plugin.json` to their ranges and is `{}` for a plugin without sidecars; plugin dependencies are not listed in the index |
| `sidecars` | `{ name, repository, versions }`; each version is `{ version, protocol: 1, releases }` where `releases` maps platforms to `{ url, sha256 }` |
| `packs` | `{ name, description, plugins }`: plugin ids installed together |
| `revoked` | `{ plugins: [{ id, version, reason }], sidecars: [{ name, version, reason }] }` |

`url` is an `https:` URL of a published release or an absolute `file:` URL of a local one ([fetching](#fetching)); `sha256` is 64 lowercase hexadecimal digits. A description has 1 to 200 characters (Unicode code points). The index check also rejects a repeated plugin id, package, sidecar, pack or version; a pack that names an unknown plugin; a plugin version that needs an unknown sidecar or a range that no listed sidecar version satisfies; and a revoked version that is not listed. `sok registry build` also reads the `plugin.json` of each plugin and fails when a dependency names neither a listed plugin nor a listed sidecar, or when no listed version of a plugin dependency satisfies its range.

## Fetching

A registry index and an release are read from a location: an `https:` URL, an absolute `file:` URL, or, where a command takes a path, a file path. Any other URL fails with `<url>: the URL must be https: or an absolute file: URL`. An `https:` URL is read with these rules, which both implementations follow with the same texts:

- The connection uses TLS with the certificate authorities that the operating system trusts.
- A redirect is followed when its target is an `https:` URL, at most 5 times; a redirect to another scheme fails with `<url>: redirect to <target> is not https`, and a sixth redirect fails with `<url>: more than 5 redirects`.
- A response other than 200 fails with `<url>: HTTP <status>`.
- The whole request, from connecting to the last byte, takes at most 60 seconds for an index and 600 seconds for an release; a slower request fails with `<url>: timed out after <seconds> s`.
- An index holds at most 8 MiB and an release at most 256 MiB; a larger body fails with `<url>: larger than <bytes> bytes`.
- A failure to connect or to read fails with `<url>: cannot connect: <reason>`, where the reason is the text of the network library.

Nothing is cached: each command and each plugin operation reads the index and the releases it needs again, and an release is checked against its `sha256` before it is extracted.

## Version selection

Installing a plugin for a core version and platform selects the newest plugin version whose `engines.soksak` contains the core version and that is not revoked. Each installation has one version of a sidecar, shared by every installed plugin that names it. For each sidecar of the selected plugin version, the ranges are the range of that version and the ranges of the other installed plugins that name the sidecar. The version in use is kept when it satisfies every range, is not revoked and has a release for the platform; otherwise the newest sidecar version that satisfies every range, is not revoked and has a release for the platform is selected. When a selection is empty, installation fails with the plugin, the version or ranges and the core version or platform; for a sidecar it names each plugin and range.

A dependency of the selected version's `plugin.json` that names the package of a plugin of the index is a plugin dependency; installation reads the `plugin.json` from the downloaded release before it extracts anything. Installing the plugin installs each plugin dependency by the same rules, recursively: an installed provider is kept when its version satisfies the range of every installed plugin that names it, and otherwise the newest provider version that satisfies every range, `engines.soksak` and revocation is selected; a provider that is installed but not enabled is enabled. A dependency that names neither a plugin of the index nor a sidecar of the index fails with `<plugin> <version>: dependency <package> is neither a plugin nor a sidecar of the registry`, and a cycle fails with `plugin dependency cycle: <id> -> <id> -> <id>`. `sok plugin update` selects only provider versions that satisfy the range of every installed plugin that names the provider. `sok plugin remove` and `sok plugin disable` fail with `plugin <id> is required by <dependent> <range>` when an enabled installed plugin names its package; `installed.json` and the folders stay unchanged.

## Installation layout

Inside the configuration directory, plugin version `<version>` of `<id>` is extracted into `plugins/<id>/<version>`, and the platform release of a sidecar version into `sidecars/<file name>/<version>/<platform>`. `plugins/installed.json` has `format` 2, `plugins` and `sidecars`. `plugins` maps each plugin id to `{ package, version, path, enabled, sidecars, previous? }`: the `name` of the plugin's `package.json`, the version in use, the folder that installation extracted that version into, `plugins/<id>/<version>`, whether the plugin loads, the sidecar ranges of that version, and the version that rollback restores. A `name` appears once. `sidecars` maps each sidecar that an installed plugin names to `{ version, path }`: the version in use, which satisfies the range of every installed plugin that names it, and the folder that installation extracted its platform release into, `sidecars/<file name>/<version>/<platform>`; a sidecar that no installed plugin names is not listed. Each `path` is relative to the configuration directory and must equal the folder that these rules give, so the configuration directory can move ([projects](projects.md#persistence)). Installation records each `path` when it extracts the release, and the hosts and `sok` read files only from recorded paths, resolved against the configuration directory. A file whose `format` is not 2 fails with `<file>: plugins/installed.json: format must be 2` and stays unchanged.

## Serving installed plugins

Both hosts serve these paths from the configuration directory and read `plugins/installed.json` for each request, so a page that loads after a change sees it:

| Path | Content |
| --- | --- |
| `/installed-plugins.json` | `{ "plugins": [{ id, package, version, manifest, diagnostics? }] }`: each enabled plugin of `installed.json`, sorted by id, with `manifest` the content of its installed `plugin.json`. In a diagnostic build `diagnostics` is the content of the plugin's `diagnostics.json` when its installed package holds one; a release build never sends it. A missing `installed.json` gives `{ "plugins": [] }`. When `installed.json`, a `plugin.json` or a `diagnostics.json` cannot be read or checked, the document is `{ "error": "<message>" }` |
| `/modules/<package>/<path>` | For the package of an enabled installed plugin, the file `<path>` inside the plugin's recorded `path`; a path with an empty, `.` or `..` segment, or a missing file, is not found. Other packages come from the application frontend |
| `/shared/<plugin id>.<point>/<specifier>.js` | The file that `extends.<point>.modules` of the enabled installed plugin `<plugin id>` maps `<specifier>` to, inside that plugin's recorded `path`; a path that does not end in `.js`, a point that no enabled plugin declares, a specifier that the point does not map, or a missing file is not found |

The workbench imports `/installed-plugins.json` as a JSON module, registers each plugin from its `manifest`, and fails the load with the `error` text when the document has one. A manifest that the workbench rejects is reported as `installed plugin <id> <version> (<package>): <reason>`. The main page installs its error display and reserves the window button area before it registers the plugins, so a rejected manifest or an `error` document stops the page start with that error shown and written to the application log; the page does not report ready, and `host.window.reload` starts it again.

When a host starts, it reads the sidecars that the `dependencies` of the `plugin.json` of each enabled installed plugin name, in name order, leaving out the packages of installed plugins. A sidecar runs from the `path` that `installed.json` records for it, and its executable is the `executable` path of the `sidecar.json` in that folder. A plugin installed or enabled while the application runs is served to pages that load after the change: a `pluginsRun` install, update or enable that succeeds declares the sidecars of the enabled installed plugins that the host has not declared yet, so a page that loads after it, such as the page that the first run reloads, starts them. After each `pluginsRun` operation the host applies the change to the sidecars that it has declared, as [applying a change](#applying-a-change) states.

## Plugin operations in the application

Both hosts run plugin operations with the installer library of their command line (`packages/sok`), so an operation in the application and the same `sok plugin` command change the configuration directory identically. The runtime adapter exposes two host calls and one event:

| Host call or event | Meaning |
| --- | --- |
| `pluginsState()` | Returns `{ registry, index, installed, firstRun }`: `registry` is the `index` URL of `plugins/registry.json` or `null` without one; `index` is the checked registry index, `null` without a registry, or `{ "error": "<message>" }` when it cannot be read or checked; `installed` is the content of `plugins/installed.json`, or `{ "format": 1, "plugins": {}, "sidecars": {} }` without one; `firstRun` is `true` while `plugins/installed.json` does not exist. A failure to read `installed.json` rejects the call with its message |
| `pluginsRun({ action, plugin })` | Runs `install`, `update`, `remove`, `enable` or `disable` for the plugin id with the core version and platform of the application, and returns the output of the matching `sok plugin` command. Any other `action` or a plugin id that is not a non-empty string rejects the call without a change. An operation that fails rejects the call with the message of the matching command and leaves `installed.json` as that command defines |
| `pluginsUseRegistry({ index })` | Sets the registry index as `sok registry use <index>` does and returns its output `{ index }`; an `index` that is not a non-empty string rejects with `index must be a non-empty string` |
| `plugins-changed` | Sent to every window after `pluginsRun` changed `installed.json`, with `{ action, plugin }` |

A host runs one operation at a time: a `pluginsRun` call while another runs rejects with `another plugin operation is running`. A host does not observe changes that a `sok` process makes; the next `pluginsState` call and pages that load later read them. A change of a `pluginsRun` operation applies at once, as [applying a change](#applying-a-change) states; a change that a `sok` process makes applies to pages that load later and to sidecars when the application starts. The browser application has no host, so it has no plugin operations.

### Applying a change

After a `pluginsRun` operation succeeds, the host applies it to its sidecars before it answers the call and sends `plugins-changed`:

- It declares each sidecar that the enabled installed plugins name, from the folder that `installed.json` records. A standard input and output sidecar whose recorded folder changed is replaced: the host stops its running process by the stop rules of [sidecars](sidecars.md#declaration-and-startup), and the next send starts the executable of the new folder. A sidecar that no enabled installed plugin names is stopped and no longer declared, so a send to it fails as a send to an undeclared sidecar does.
- A persistent sidecar whose running service has another version than `installed.json` records is reported and replaced as [terminal runtime](terminal-runtime.md#updates) states.

A window that receives `plugins-changed` reloads its page, so it loads the plugins that `installed.json` lists. Before the reload it asks for each modified tab of the window, as closing the window does ([plugins](plugins.md)). 닫지 않기 keeps the page of that window: its plugins stay as loaded, and the cards of the changed plugins show the state `reload` until `core.plugins.apply` reloads the page after the same questions. A window whose page reload fails shows the error through the error display.

## Plugin screen

The library screen of a window ([projects](projects.md#project-identity)) has two pages, 프로젝트 and 플러그인, selected by the tabs at the start of its heading, which run `core.library.page {page}` with `projects` or `plugins`. 플러그인 is the plugin screen: it lists plugins with their descriptions and runs the plugin operations. The settings window keeps only the settings of loaded plugins ([settings window](settings.md#플러그인)). `core.plugins.browse` closes the settings window when it is open, shows the library when the window shows a workspace, and selects 플러그인. `core.projects.browse` selects 프로젝트. The window keeps the plugin search while it shows a workspace.

The page has a search field and one card per plugin that the window loaded, that `installed.json` lists, or that the registry index lists, sorted by id. The search field runs `core.library.plugins.search {query}`; the page shows the plugins whose id, name, or description contains the query, ignoring letter case, and an empty query shows every plugin. A query that matches no plugin shows "찾는 플러그인이 없습니다."

A card shows:

- The name, the plugin id and one state:

| State | Text | Condition |
| --- | --- | --- |
| `loaded` | 사용 중 | The window loaded the plugin, and `installed.json` lists the same version enabled |
| `disabled` | 사용 안 함 | `installed.json` lists the plugin disabled, and the window did not load it |
| `available` | 설치 안 됨 | Only the registry index lists the plugin |
| `reload` | 창을 다시 불러오면 적용 | `installed.json` differs from what the window loaded, because the window kept its page when a modified tab was kept ([applying a change](#applying-a-change)) |

- The description of the loaded manifest, else of the registry entry ([plugins](plugins.md) and [registry index](#registry-index) require one); a plugin that only `installed.json` lists has no description and shows its id as its name.
- A version line with 설치된 버전 <version> and 최신 버전 <version>, the newest version that the registry index lists, each when present.
- A sidecar line, 사이드카 followed by each sidecar that the plugin names, sorted by name: the installed version from `installed.json` `sidecars`, or else the range that the plugin declares. The sidecars and ranges come from the `installed.json` entry of an installed plugin, else from the newest registry version, else from the `dependencies` of the loaded manifest. A plugin without sidecars shows 사이드카 없음.
- Actions, each a button bound to its command: 설치 `core.plugins.install` when the registry lists the plugin and it is not installed; 업데이트 `core.plugins.update` when it is installed and the registry lists a version newer than the installed one; 적용 `core.plugins.apply` when its state is `reload`; 사용 `core.plugins.enable` or 사용 안 함 `core.plugins.disable` when it is installed, by its `enabled` value; 제거 `core.plugins.remove` when it is installed. While an operation runs, every action of every card is disabled and the card of its plugin shows "<plugin> <action> 진행 중". After a failed operation the card shows its error.

The page reads the plugin state with `pluginsState` when it is shown and after each `plugins-changed` event. A registry index that cannot be read shows "레지스트리를 읽지 못했습니다: <message>" above the cards, and the page keeps the loaded and installed plugins. A plugin state that cannot be read, such as an invalid `installed.json`, shows "플러그인 상태를 읽지 못했습니다: <message>" and no cards. Without a host, as in the browser application, the page has only the loaded plugins, each `loaded`, and no action.

`core.plugins.registry` takes `{index}`, runs the host call `pluginsUseRegistry` and reads the plugin state again; it fails with -32602 (invalid params) when `index` is not a non-empty string and with the host error when the index cannot be read or checked. `core.plugins.install`, `core.plugins.update`, `core.plugins.remove`, `core.plugins.enable` and `core.plugins.disable` take `{plugin}` and run the host call `pluginsRun` with their action. A command fails with -32602 (invalid params) when `plugin` is not a non-empty string, with the host error when the operation fails or another operation runs, and with "plugin operations need a native host" without a host. A command records its operation in `core.plugins` before it calls the host, and its result after the call. `core.plugins.apply` asks for each modified tab of the window and reloads its page as [applying a change](#applying-a-change) states; it answers `{reloaded: false}` when a tab is kept. `core.plugins.replace` takes `{sidecar}` and runs the host call `sidecarsReplace` ([terminal runtime](terminal-runtime.md#updates)); it fails with -32602 (invalid params) when `sidecar` is not a non-empty string and with the host error when the replacement fails.

`core.library` reports `page` (`projects` or `plugins`) and `plugins` `{query, shown, actions}`: the plugin search text, the plugin ids of the cards shown in order, and the action buttons of the cards in document order as `{plugin, action, disabled}`, whose position is the index of the dom name `core.library.plugins.action`; `shown` and `actions` are `[]` while the page is not shown. `core.plugins` reports:

| Field | Value |
|---|---|
| `registry` | The registry index URL, or `null` |
| `error` | The registry index error or the plugin state error, or `null` |
| `plugins` | One entry per card, sorted by id: `{id, name, description, state, installed, latest, sidecars}`; `installed` is `{version, enabled}` or `null`, `latest` is the newest version that the registry index lists, or `null`, and `sidecars` lists `{name, range, version}` sorted by name, where `range` and `version` are `null` when unknown |
| `operation` | `null` before the first operation, then `{action, plugin, state, error}` of the latest one: `state` is `running`, `done` or `failed`, and `error` is the message of a failed operation or `null` |
| `reload` | `true` when a plugin has the state `reload` |
| `updates` | The installed plugins for which the registry index lists a newer version, sorted by id: `{id, installed, latest}` |

Acceptance:

- The plugin page of the library lists loaded, installed and registry plugins with their name, description, state, versions and sidecars, filtered by the search, and `core.plugins.browse` shows it from the workspace and from the settings window.
- Installing, updating, disabling, enabling and removing a plugin from its card changes `installed.json` as the matching `sok plugin` command does, reports the operation in `core.plugins`, applies the change to the sidecars, and reloads every window page that keeps no modified tab, so the windows show the changed plugins without an application restart.

## First run

`environment.json` names the starter pack in `starter`. When a window starts and `pluginsState` reports `firstRun`, the workbench installs every plugin of that pack from the registry index with `pluginsRun`, in the pack's order, before it builds a space, and then reloads the page so that the installed plugins load. The first installation writes `installed.json`, so a later start, also after every plugin was removed, installs nothing. When `environment.json` names a default registry in `registry` and `pluginsState` reports no registry, the workbench first sets that registry with `pluginsUseRegistry` and reads the state again. Without either registry the window starts with no plugin, logs `first run: no registry is set; the starter pack <name> was not installed`, and shows the application error `플러그인 레지스트리가 없어 시작 플러그인 묶음 <name>을 설치하지 못했습니다. sok registry use 로 레지스트리를 정한 뒤 다시 시작하세요.`, so a window without plugins states why; a registry index that cannot be read, or one without the pack, fails the start with its error. An environment without `starter`, or without a host, installs nothing.

