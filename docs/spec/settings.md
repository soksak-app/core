# Settings window

[한국어](settings.ko.md)

This specification defines the sections of the settings window, the settings they show, and the stored form of sidebar sets. [Projects](projects.md#settings) defines scopes and storage files, [native modals](native-modals.md) defines how the window is drawn, and [plugins](plugins.md) defines plugin declarations. [Features](../features.md) records implementation and validation.

## Sections

Plugins are installed from separate repositories, so their number and the number of their sections grow without bound. No control of the window is repeated per plugin or per section, except rows of a list and options of a select box.

The left navigation lists three sections in this order. Every section shows the scope tabs (전역, 프로젝트) above its controls; the project tab exists only while a project is selected.

| Id | Label | Content |
|---|---|---|
| `general` | 일반 | Settings that apply to the whole workbench, including the sidebar appearance |
| `plugins` | 플러그인 | A searchable list of the environment plugins, and the page of the selected plugin |
| `sidebars` | 사이드바 | The set list with create, edit, and delete, and the set editor |

`core.settings-modal.nav {section}` shows a section. The window keeps the section, the plugin search, the selected plugin, and the edited set while it is closed and reopened.

### 일반

| Group | Rows |
|---|---|
| 프로젝트 (common scope only) | 열기 방식 `projectOpening` |
| 테마 | theme swatches `theme`, 모드 `mode` |
| 형태 | 통로 `gap`, 모서리 `radius`, 폰트 `font`, 글자 크기 `size` |
| 위치 | 프로젝트 탭 위치 `projectTabs` |
| 사이드바 | 사이드바 위치 `cardSidebar`, 왼쪽 사이드바 보이기 `left`, 오른쪽 사이드바 보이기 `right`, 왼쪽 사이드바 세트 and 오른쪽 사이드바 세트 (each a select of all sets and 사용 안 함, `core.settings.link {place, plugin: null, set}`) |
| 사이드바 크기 | the width settings of [layout values](#layout-values) |
| 표시 | 포커스 표시 `focusInd`, 경계선 `fullRule`, 포커스 밖 흐리게 `dim` |
| 언어 | 언어 `language` |
| 진단 | 성능 트레이스 `diagnostics.performance` |

사이드바 위치 is one setting for every plugin; its default is `inset`, and its control lists 카드 안 first. `flow` shows the card sidebar beside the focused card, `pin` keeps it where it stood, `inset` shows it inside every card, and `off` hides it ([example model](example-model.md)). No plugin setting appears in 일반.
### 진단

`diagnostics.performance` is the permanent performance trace ([performance trace](performance-trace.md)). It is a boolean, default false, set through the settings file rather than a settings-window control. While it is false no layer performs any performance logging work — no file is created, no formatting runs. Setting it true makes every layer append events to `logs/performance.ndjson` under the configuration directory, and setting it back false stops the logging at the next event boundary; the file and its rotation belong to the trace, not to the setting, so an old log survives a restart with the flag off.


### 플러그인

Without a selected plugin the section shows a search field and a list. The list has one row per plugin of `environment.json`, in its declared order, with the manifest `name` and `description`; a plugin is one unit that contributes its surface, sections, and settings. The window has no install, enable, or disable action.

- The search field runs `core.settings-modal.search {query}` with its text. The list shows the plugins whose id, name, or description contains the query, ignoring letter case; an empty query shows every plugin. A query that matches no plugin shows "찾는 플러그인이 없습니다."
- A row runs `core.settings-modal.plugin {plugin}`, which opens that plugin's page.

The page of a plugin replaces the search field and the list. It shows:

- 목록: a button that runs `core.settings-modal.plugin {plugin: null}` and returns to the list with the same query.
- The plugin name and description.
- 설정: one row per setting the manifest declares, in manifest order, named with its `label` and followed by its `description` when it has one. An `enum` is a choice row, an `integer` a slider between its bounds, and a `string` a text field. A plugin without settings shows "이 플러그인에는 설정이 없습니다."
- 섹션: the names of the sections the plugin declares, as one line of text.
- 사이드바, for a plugin with a surface: 왼쪽 사이드바 and 오른쪽 사이드바, each a select of 일반 따름, 사용 안 함, and all sets, and 레일 사이드바, a select of 사용 안 함 and all sets. Each runs `core.settings.link {place, plugin, set}`.

### 사이드바

The section shows the set list and 새 세트. Each row shows the set title, its layout (목록 or 탭), its section names, and two buttons: 편집 (`core.settings-modal.edit {set}`) and 삭제 (`core.settings.sets.delete {id, scope}`). 새 세트 runs `core.settings.sets.create {scope}`, which adds a set titled "새 세트" with layout `list` and no sections, and opens it for editing.

The editor of a set shows:

- 이름: a text field, `core.settings.sets.update {id, title, scope}`.
- 배치: 목록 (`list`) or 탭 (`tabs`), `core.settings.sets.update {id, layout, scope}`.
- 섹션: one row per section of the set, in set order. A row is a select box of every registered section with one `optgroup` per plugin, labelled with the plugin name, and the buttons ▲, ▼, and −. Below the rows, + adds a row.
- 완료: `core.settings-modal.edit {set: null}` closes the editor.

Every section row control runs `core.settings.sets.row {id, action, index, section?, scope}`:

| Control | Action | Effect |
|---|---|---|
| select box of row `index` | `choose` with `section` | Replaces the section of row `index` |
| ▲ | `up` | Swaps row `index` with the row above; absent on the first row |
| ▼ | `down` | Swaps row `index` with the row below; absent on the last row |
| − | `remove` | Removes row `index` |
| + | `add` | Appends the first registered section, in plugin and declaration order, that the set does not contain |

A change that would repeat a section in the set fails with -32602 (invalid params) and the error "section <id> is already in set <id>", and changes nothing; so does + when the set already contains every registered section, with "set <id> already contains every registered section". Every change is saved immediately to the scope shown.

## Stored sets and links

`sets` and `links` are settings. Their default values come from normalized plugin sidebar declarations, replaced by explicit `environment.json` `sidebars` when present. A change writes the whole list to the shown scope, like any other setting; a project override of `sets` or `links` replaces the common list.

A set is `{id, title, sections, layout}`:

- `id`: a non-empty string, unique in the list. A created set receives `set-<n>` with the smallest positive `n` that no set in the list uses.
- `title`: a string of 1 to 40 characters.
- `sections`: section ids without repetition.
- `layout`: `list` or `tabs` ([plugins](plugins.md#sections)).

A link is `{place, plugin, set}` with the rules of `environment.json` `sidebars.links`. The effective `sets` and `links` are validated with the plugin-api functions `validateSidebars` and `checkSidebarReferences`, which also validate `environment.json` `sidebars`. The check runs when settings load and before a change is stored. A set that names a section the environment does not register, or a link that names a plugin without a surface or a missing set, fails: a load reports the error and replaces nothing, and a change fails with -32602 (invalid params) and changes nothing.

Deleting a set writes the remaining sets and the links without the ones to it to the same scope in one change.

## Sidebar choices

`links` holds the sidebar choices:

| Link | Meaning |
|---|---|
| `{place: "left" or "right", plugin: null, set: "<set id>"}` | The general choice of that sidebar. Without it the general choice is 사용 안 함 |
| `{place: "left" or "right", plugin: "<plugin id>", set: "<set id>"}` | The plugin shows that set in that sidebar |
| `{place: "left" or "right", plugin: "<plugin id>", set: null}` | The plugin hides that sidebar (사용 안 함). Without a link for the plugin, the plugin follows the general choice (일반 따름) |
| `{place: "card-left", plugin: "<plugin id>", set: "<set id>"}` | The card-left sidebar of that plugin shows the set. Without it the plugin has no card-left sidebar |

`place` and `plugin` together appear at most once. `set: null` is allowed only on a left or right link that names a plugin. A set id cannot be `off` or `inherit`, because the selects use those two values.

The left or right sidebar of a window is resolved from the plugin of the focused card's active tab:

1. If `links` has a link for that place and that plugin, its `set` applies: a set is shown, and `null` hides the sidebar.
2. Otherwise the general link of that place applies: its set is shown, and without it the sidebar is hidden.
3. The sidebar stands only while the switch `left` or `right` is on; the switch hides the resolved set without changing any choice.

So both levels can hide a sidebar: with the general choice 사용 안 함, a plugin that chose a set shows it while its card is focused; with a general set, a plugin that chose 사용 안 함 hides the sidebar while its card is focused.

`core.settings.link {place, plugin, set, scope}` changes one choice. `set` is a set id, `off`, or `inherit`:

| Place and plugin | `set` id | `off` | `inherit` |
|---|---|---|---|
| left or right, `plugin: null` | Stores the general link | Removes the general link (사용 안 함) | Fails with -32602 |
| left or right, a plugin | Stores the plugin link | Stores the plugin link with `set: null` | Removes the plugin link (일반 따름) |
| card-left, a plugin | Stores the card-left link | Removes the card-left link | Fails with -32602 |

## Layout values

The following values were constants in `plane.js` and `app.css`. They are core settings shown in 일반 › 사이드바 크기, integers in points.

| Key | Label | Default | Range | Use |
|---|---|---|---|---|
| `sidebarMinWidth` | 최소 폭 | 120 | 60–800 | Smallest width of an inset sidebar |
| `sidebarMaxWidth` | 최대 폭 | 480 | 60–800 | Largest width of an inset sidebar |
| `sidebarWidth` | 처음 폭 | 190 | 60–800 | Width of an inset sidebar that has no stored width, and of a card sidebar column that its plugin has not resized in the space |

The three values share one range, 60 to 800 points, and their sliders use that range, so equal values sit at equal slider positions. The rows are named 최소 폭, 최대 폭, and 처음 폭 on one line under the group 사이드바 크기.

A change that leaves `sidebarMinWidth` ≤ `sidebarWidth` ≤ `sidebarMaxWidth` false fails with -32602 (invalid params) and changes nothing. A stored card width outside the current range is drawn as stored until the grip changes it.

The following layout constants remain in code because they are tied to the document structure rather than to a preference: the card header 32 and footer 22 points and the tab strip thresholds (`plane.js`). The left and right sidebar widths of a new space come from the `workspace.grid` cards of `environment.json`.

## Status

`core.settings-modal` reports:

| Field | Value |
|---|---|
| `section` | The shown section id |
| `scope` | `common` or `project` |
| `query` | The plugin search text; empty by default |
| `listed` | The plugin ids of the list rows shown in order, or `[]` outside the plugin list |
| `plugin` | The plugin whose page is shown, or `null` |
| `editing` | The edited set id, or `null` |
| `rows` | Each declared plugin setting row on a plugin page as `{key, name, description}` |
| `controls` | Every control with its dom name, key, and command |

`core.settings` reports every effective value, including `sets`, `links`, and the layout values.

## Acceptance

- 일반 holds the sidebar appearance controls (`cardSidebar`, `left`, `right`, the left link, the widths) and no plugin setting.
- 사이드바 holds only the set list, 새 세트, and the editor. The editor has no control per registered section: its section controls are one select box and ▲ ▼ − per row, and one +.
- The section rows choose, move, remove, and add sections through `core.settings.sets.row`; a repeated section is rejected.
- 플러그인 shows a filtered list; a row opens the plugin page with its settings, sections, and sidebar choices, and 목록 returns to the list.
- The sidebar resolution holds: general 사용 안 함 with a plugin set shows the set while that plugin's card is focused; a general set with plugin 사용 안 함 hides the sidebar; plugin 일반 따름 shows the general set.
- The layout values change the inset sidebar limits, default width, folded width, and new card sidebar width.
