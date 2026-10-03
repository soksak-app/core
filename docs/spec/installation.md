# Plugin installation formats

[한국어](installation.ko.md)

These are the formats that plugin installation uses. The [command line `sok`](cli.md) validates them in both implementations, and the host contract cases `install.*` state each rule ([host contract](host-contract.md)). Every check rejects an unknown field and names the field that is wrong; fields are checked in a fixed order, so a file with several errors reports the same one in both implementations. A version part is at most 4294967295. [Serving installed plugins](#serving-installed-plugins) states how the hosts and the workbench load them.

## Versions and ranges

A version is `x.y.z` with numeric parts and no leading zeros; versions compare by number. A range is one of:

| Range | Versions |
| --- | --- |
| `x.y.z` | that version only |
| `^x.y.z` | from `x.y.z` below the next change of the first non-zero part: `^1.2.3` is below `2.0.0`, `^0.2.3` below `0.3.0`, `^0.0.2` below `0.0.3` |
| `~x.y.z` | from `x.y.z` below `x.(y+1).0` |
| `>=x.y.z <a.b.c` | from `x.y.z` below `a.b.c`; an empty range is rejected |

Other forms, such as `*`, `latest` or pre-release suffixes, are rejected.

## Plugin package

A plugin package is the archive `<id>-<version>.tgz` of the plugin's files. Its `package.json` declares:

| Field | Meaning |
| --- | --- |
| `name` | Package name; the installed files are served at `/modules/<name>/` |
| `version` | Plugin version |
| `engines.soksak` | Range of core API versions the plugin supports |
| `soksak.sidecars` | Optional map from each sidecar that `plugin.json` `sidecars` names to a version range; it lists exactly those sidecars |
| `files` | Paths inside the package that the archive holds; it includes `plugin.json` |

Other `package.json` fields belong to package tools and are not read.

## Sidecar release asset

A sidecar version is released as one archive per platform, `<file name>-<version>-<platform>.tar.gz`. The file name of a sidecar `@scope/name` is `scope-name`; an unscoped name is used as it is. A platform is one of `darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64`, `windows-arm64` and `windows-x64`. The installer checks a sidecar archive only against the `sha256` of its registry entry before it extracts and runs it; a sidecar, including one from a third party, is not signed or otherwise reviewed by the application.

## Registry index

The registry index `index.json` has `format` 1 and these lists:

| Field | Entry |
| --- | --- |
| `plugins` | `{ id, package, name, description, license, repository, versions }`; each version is `{ version, package: { url, sha256 }, engines: { soksak }, sidecars }` where `sidecars` maps sidecar names to ranges and is `{}` for a plugin without sidecars |
| `sidecars` | `{ name, repository, versions }`; each version is `{ version, protocol: 1, assets }` where `assets` maps platforms to `{ url, sha256 }` |
| `packs` | `{ name, description, plugins }`: plugin ids installed together |
| `revoked` | `{ plugins: [{ id, version, reason }], sidecars: [{ name, version, reason }] }` |

`url` is an absolute `file:` URL of a local release archive, because version 0.0.2 installs only from a local registry; `sha256` is 64 lowercase hexadecimal digits. A description has 1 to 200 characters (Unicode code points). The index check also rejects a repeated plugin id, package, sidecar, pack or version; a pack that names an unknown plugin; a plugin version that needs an unknown sidecar or a range that no listed sidecar version satisfies; and a revoked version that is not listed.

## Version selection

Installing a plugin for a core version and platform selects the newest plugin version whose `engines.soksak` contains the core version and that is not revoked. Each installation has one version of a sidecar, shared by every installed plugin that names it. For each sidecar of the selected plugin version, the ranges are the range of that version and the ranges of the other installed plugins that name the sidecar. The version in use is kept when it satisfies every range, is not revoked and has an asset for the platform; otherwise the newest sidecar version that satisfies every range, is not revoked and has an asset for the platform is selected. When a selection is empty, installation fails with the plugin, the version or ranges and the core version or platform; for a sidecar it names each plugin and range.

## Installation layout

Inside the configuration directory, plugin version `<version>` of `<id>` is extracted into `plugins/<id>/<version>`, and the platform asset of a sidecar version into `sidecars/<file name>/<version>/<platform>`. `plugins/installed.json` has `format` 1, `plugins` and `sidecars`. `plugins` maps each plugin id to `{ package, version, path, enabled, sidecars, previous? }`: the package name, the version in use, the absolute folder that installation extracted that version into, whether the plugin loads, the sidecar ranges of that version, and the version that rollback restores. A package appears once. `sidecars` maps each sidecar that an installed plugin names to `{ version, path }`: the version in use, which satisfies the range of every installed plugin that names it, and the absolute folder that installation extracted its platform asset into; a sidecar that no installed plugin names is not listed. Installation records each `path` when it extracts the archive, and the hosts read files only from recorded paths.

## Serving installed plugins

Both hosts serve these paths from the configuration directory and read `plugins/installed.json` for each request, so a page that loads after a change sees it:

| Path | Content |
| --- | --- |
| `/installed-plugins.json` | `{ "plugins": [{ id, package, version, manifest, diagnostics? }] }`: each enabled plugin of `installed.json`, sorted by id, with `manifest` the content of its installed `plugin.json`. In a diagnostic build `diagnostics` is the content of the plugin's `diagnostics.json` when its installed package holds one; a release build never sends it. A missing `installed.json` gives `{ "plugins": [] }`. When `installed.json`, a `plugin.json` or a `diagnostics.json` cannot be read or checked, the document is `{ "error": "<message>" }` |
| `/modules/<package>/<path>` | For the package of an enabled installed plugin, the file `<path>` inside the plugin's recorded `path`; a path with an empty, `.` or `..` segment, or a missing file, is not found. Other packages come from the application frontend |

The workbench imports `/installed-plugins.json` as a JSON module, registers each plugin from its `manifest`, and fails the load with the `error` text when the document has one.

When a host starts, it reads the sidecars that the `plugin.json` of each enabled installed plugin names. A sidecar runs from the `path` that `installed.json` records for it, and its executable is the `executable` path of the `sidecar.json` in that folder. A plugin installed or enabled while the application runs is served to pages that load after the change, and its sidecars start after the application restarts.

## Plugin operations in the application

Both hosts run plugin operations with the installer library of their command line (`packages/sok`), so an operation in the application and the same `sok plugin` command change the configuration directory identically. The runtime adapter exposes two host calls and one event:

| Host call or event | Meaning |
| --- | --- |
| `pluginsState()` | Returns `{ registry, index, installed, firstRun }`: `registry` is the `index` URL of `plugins/registry.json` or `null` without one; `index` is the checked registry index, `null` without a registry, or `{ "error": "<message>" }` when it cannot be read or checked; `installed` is the content of `plugins/installed.json`, or `{ "format": 1, "plugins": {}, "sidecars": {} }` without one; `firstRun` is `true` while `plugins/installed.json` does not exist. A failure to read `installed.json` rejects the call with its message |
| `pluginsRun({ action, plugin })` | Runs `install`, `update`, `remove`, `enable` or `disable` for the plugin id with the core version and platform of the application, and returns the output of the matching `sok plugin` command. Any other `action` or a plugin id that is not a non-empty string rejects the call without a change. An operation that fails rejects the call with the message of the matching command and leaves `installed.json` as that command defines |
| `plugins-changed` | Sent to every window after `pluginsRun` changed `installed.json`, with `{ action, plugin }` |

A host runs one operation at a time: a `pluginsRun` call while another runs rejects with `another plugin operation is running`. A host does not observe changes that a `sok` process makes; the next `pluginsState` call and pages that load later read them. A change takes effect when the application restarts: the windows that are open keep the plugins they loaded, and sidecars start only at startup. The browser application has no host, so it has no plugin operations.

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
| `restart` | 다시 시작하면 적용 | `installed.json` differs from what the window loaded: the plugin was installed, removed, updated, enabled or disabled after the window loaded |

- The description of the loaded manifest, else of the registry entry ([plugins](plugins.md) and [registry index](#registry-index) require one); a plugin that only `installed.json` lists has no description and shows its id as its name.
- A version line with 설치된 버전 <version> and 최신 버전 <version>, the newest version that the registry index lists, each when present.
- A sidecar line, 사이드카 followed by each sidecar that the plugin names, sorted by name: the installed version from `installed.json` `sidecars`, or else the range that the plugin declares. The sidecars and ranges come from the `installed.json` entry of an installed plugin, else from the newest registry version, else from the `sidecars` of the loaded manifest without a range. A plugin without sidecars shows 사이드카 없음.
- Actions, each a button bound to its command: 설치 `core.plugins.install` when the registry lists the plugin and it is not installed; 업데이트 `core.plugins.update` when it is installed and the registry lists it; 사용 `core.plugins.enable` or 사용 안 함 `core.plugins.disable` when it is installed, by its `enabled` value; 제거 `core.plugins.remove` when it is installed. While an operation runs, every action of every card is disabled and the card of its plugin shows "<plugin> <action> 진행 중". After an operation the card shows "애플리케이션을 다시 시작하면 적용됩니다." or the error of the failed operation.

The page reads the plugin state with `pluginsState` when it is shown and after each `plugins-changed` event. A registry index that cannot be read shows "레지스트리를 읽지 못했습니다: <message>" above the cards, and the page keeps the loaded and installed plugins. A plugin state that cannot be read, such as an invalid `installed.json`, shows "플러그인 상태를 읽지 못했습니다: <message>" and no cards. Without a host, as in the browser application, the page has only the loaded plugins, each `loaded`, and no action.

`core.plugins.install`, `core.plugins.update`, `core.plugins.remove`, `core.plugins.enable` and `core.plugins.disable` take `{plugin}` and run the host call `pluginsRun` with their action. A command fails with -32602 (invalid params) when `plugin` is not a non-empty string, with the host error when the operation fails or another operation runs, and with "plugin operations need a native host" without a host. A command records its operation in `core.plugins` before it calls the host, and its result after the call.

`core.library` reports `page` (`projects` or `plugins`) and `plugins` `{query, shown, actions}`: the plugin search text, the plugin ids of the cards shown in order, and the action buttons of the cards in document order as `{plugin, action, disabled}`, whose position is the index of the dom name `core.library.plugins.action`; `shown` and `actions` are `[]` while the page is not shown. `core.plugins` reports:

| Field | Value |
|---|---|
| `registry` | The registry index URL, or `null` |
| `error` | The registry index error or the plugin state error, or `null` |
| `plugins` | One entry per card, sorted by id: `{id, name, description, state, installed, latest, sidecars}`; `installed` is `{version, enabled}` or `null`, `latest` is the newest version that the registry index lists, or `null`, and `sidecars` lists `{name, range, version}` sorted by name, where `range` and `version` are `null` when unknown |
| `operation` | `null` before the first operation, then `{action, plugin, state, error}` of the latest one: `state` is `running`, `done` or `failed`, and `error` is the message of a failed operation or `null` |
| `restart` | `true` when a plugin has the state `restart` |

Acceptance:

- The plugin page of the library lists loaded, installed and registry plugins with their name, description, state, versions and sidecars, filtered by the search, and `core.plugins.browse` shows it from the workspace and from the settings window.
- Installing, updating, disabling, enabling and removing a plugin from its card changes `installed.json` as the matching `sok plugin` command does, reports the operation in `core.plugins`, and marks the plugin `restart` until the application restarts.

## First run

`environment.json` names the starter pack in `starter`. When a window starts and `pluginsState` reports `firstRun`, the workbench installs every plugin of that pack from the registry index with `pluginsRun`, in the pack's order, before it builds a space, and then reloads the page so that the installed plugins load. The first installation writes `installed.json`, so a later start, also after every plugin was removed, installs nothing. Without a registry the window starts with no plugin, logs `first run: no registry is set; the starter pack <name> was not installed`, and shows the application error `플러그인 레지스트리가 없어 시작 플러그인 묶음 <name>을 설치하지 못했습니다. sok registry use 로 레지스트리를 정한 뒤 다시 시작하세요.`, so a window without plugins states why; a registry index that cannot be read, or one without the pack, fails the start with its error. An environment without `starter`, or without a host, installs nothing.

