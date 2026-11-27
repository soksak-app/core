# Settings tab

[한국어](settings.ko.md)

The settings tab is the contract of the settings of the application and of the plugin pages. It is a tab of the main window, beside the project tabs. Scopes and storage files are defined in [projects](projects.md#settings), the drawing rules of the tab in [native modals](native-modals.md), the window sidebars in [external window sidebars](external-sidebars.md), the plugin declarations in [plugins](plugins.md), and the plugin operations in [plugin operations in the application](installation.md#plugin-operations-in-the-application). [Features](../features.md) records implementation and validation.

The settings tab has one menu, one page at a time and one content pane. While the window lives, the tab keeps its page, its plugin search, its selected plugin and its edited set when it is closed and reopened. No file stores them.

## Opening and closing

- `core.settings.open` opens the settings tab beside the project tabs, or brings the open tab to the front. The tab shows the chip `⚙ 설정` with a close control. The chrome button (element `core.chrome.settings`), the app menu item 설정… and `cmd+,` run this command.
- Each project window has one settings tab. The tab stands after the project tabs in every position of `projectTabs`. Its scope is the project of its window. When the window shows the project home, no project is selected and the page head has no scope control ([page head](#page-head)).
- The close control of the chip (element `core.settings-tab.close`) runs `core.settings.close`. The command closes the tab and brings the work screen of the window to the front.
- While the settings tab is in front, the surfaces of the window are not drawn and keep their sessions, as a hidden tab keeps them.
- The title bar shows the tools of the screen in front only. The work screen shows four sidebar toggles, a separator and the ⚙ button. The project home shows the ⚙ button. The settings tab in front shows no tool. The ⚙ button runs `core.settings.open`, so each screen has one settings entry.
- After the settings tab is closed, the work screen shows a hint at its bottom right: the text `설정이 닫혀 있다` and the button `설정 열기` (element `core.settings-tab.reopen`), which runs `core.settings.open`. The hint shows only while the work screen is in front and only after this page has opened the tab, so a window that never opened the tab shows none. The hint hides when the tab opens again.
- The settings tab has no drag and no rectangle of its own. Its content is the content of the main window.

## Menu

The menu stands at the left of the tab. Its top holds the search field.

| Element | Text | Command |
| --- | --- | --- |
| Search field | placeholder `설정 찾기` | `core.settings-tab.find {query}` |

The menu has two groups and one list of plugins.

Group `설정`:

| Page | Item | Badge |
| --- | --- | --- |
| `look` | 모양 | none |
| `workspace` | 작업 공간 | none |
| `sets` | 사이드바 세트 | none |
| `behavior` | 동작 | none |
| `agents` | 에이전트 연동 | warn, the number of setup parts that are not `ok` |
| `diag` | 진단 | none |

Group `플러그인`:

| Page | Item | Badge |
| --- | --- | --- |
| `installed` | 설치됨 | warn with title `문제 <n>` when a plugin has a problem; else acc with title `업데이트 <n>` when a plugin has an update; else the number of installed plugins as plain text |
| `browse` | 찾아보기 | the catalog count as plain text |

The catalog holds the plugins that the registry index lists with a version that is not revoked, and the plugins that are installed or loaded ([registry index](installation.md#registry-index)).

Group `설정이 있는 플러그인`: one item per loaded and enabled plugin that declares settings or accounts, labelled with the plugin name and marked with a green dot (title `사용 중`). The group lists only these plugins. Every other plugin page opens from 설치됨, so the menu stays short with many installed plugins.

Each page item runs `core.settings-tab.nav {page}`. Each plugin item runs `core.settings-tab.plugin {plugin}`. The item of the page in front is selected: its background is the accent tint and its text is bold. A search shows no selected item.

## Page head

The head of a page shows the title, a one-line description and the scope control.

- The scope control is the segment `전역 | <project name> · <n>`. `<n>` is the number of settings of the page that the selected project overrides. The segment runs `core.settings-tab.scope {scope}` with `common` or `project`. The segment shows only while a project is selected and the page has a setting that a project can override. On the project home no project is selected, so the segment is absent there.
- A page that has a setting but no setting a project can override shows the badge `전역 전용` (neutral) in place of the segment.
- A page without settings shows neither: 설치됨, 찾아보기 and a plugin page before installation.
- A plugin page shows a back link above its title. The link is `‹ 설치된 플러그인` when the page was opened from 설치됨 or the menu, and `‹ 찾아보기` when it was opened from 찾아보기. The link runs `core.settings-tab.back`, which returns to the page named by the `back` status.
- In the project scope, a caption under the scope control shows the folder of the project (element `core.settings-tab.folder`). The folder is the only mark of the project that the scope stores into. Two projects can end in the same name, so the caption shows the whole path inside the width of the pane. A line breaks at a space, after a hyphen and after a path separator (`/` or `\`), and a name wider than the line breaks at the end of the line. The caption is never shortened with an ellipsis, never runs past the pane and is never cut off.
- A change redraws the content and keeps its scroll position. Showing another page, scope, plugin page or edited set starts at the top. The `scroll` status reports the position.

## Rows

A setting is a row. The row shows its label in bold, its description under the label and its control in the control column at the right. The control column is 260 points wide. A row without a label keeps an empty label cell, so its control stays in the control column. Wide controls (the theme swatches, the account list, the setup state) take the whole row. A unit is part of its control.

Every control is usable from the keyboard, shows its focus and has a disabled state. Korean text wraps at spaces.

### Scope of a control

Every control of a setting follows one rule, in the tab and in the window chrome alike. The control shows the applied value of its setting and the scope that the value comes from, and it writes to that scope. A setting that the selected project overrides takes its value from the project scope; every other setting takes its value from the common scope.

- In the project scope a row whose setting the project overrides shows the badge `<project> 값` (acc) and the reset control ↺, titled `<label> 전역 값으로 되돌리기`. The reset control runs `core.settings.reset {key, scope}`, which removes the project value. The control shows the project value.
- In the project scope a row whose setting the project does not override shows the value of the common scope. A change of that row adds a project value.
- In the project scope a common-only setting is disabled and shows the badge `전역 전용`.
- In the common scope a row whose setting the selected project overrides shows the common value and the chip `<project>: <value>` (warn badge) at the row's end. The chip runs `core.settings-tab.scope {scope: "project"}`, which opens the project scope. The chip has the element name `core.settings-tab.applied` and the key `applied:<setting>`.
- In the common scope every control writes the common value. The common scope never adds a project value and never removes one.
- A link control follows `links` and offers the sets of the scope of `links`. The set list, its buttons and the set editor follow `sets`. The theme swatches follow `theme`. An order row follows its key. The chip of `links` stands after the link controls, the chip of `sets` after the set list, the chip of `theme` in the swatch grid and the chip of an order on its first row.
- The chrome switches of the window follow the same rule: a side switch and the fold control of a window sidebar follow their side ([window tools](external-sidebars.md#window-tools)), and the mode of the window follows `mode`.

## Saving and undo

- Every change is saved when it is made. The page has no save button.
- The foot of the tab shows a check icon and the text `바꾼 값은 바로 저장된다`.
- A change of a setting shows a toast `<label>: <old> → <new>` with the button `되돌리기` for 5 seconds (5000 ms). The button `되돌리기` (`core.settings-tab.undo`) runs the command of the change with the old value and removes the toast. A new toast replaces the one that is shown. The toast has no close control and disappears when its time ends.
- The toast of a side switch reads `왼쪽 사이드바 보이기: 켬 → 끔`. The toast of a sidebar order reads `배치 순서: 왼쪽 → 오른쪽 → 위 → 아래`. The toast of a plugin order reads `창 사이드바 배치 순서: <sides>` or `카드 사이드바 배치 순서: <sides>`, where `<sides>` joins the side names with ` → `.
- A slider does not show a toast while it is dragged. It shows one toast when the drag ends.
- The toast appears on the settings tab only. A change made on the work screen, such as a sidebar shortcut, shows no toast and writes the same stored value.

## Search

`core.settings-tab.find {query}` searches the settings and the plugins. The query is trimmed of leading and trailing spaces. A match is a case-insensitive substring.

- A setting matches by its label, its description, its group name and its key. The key of a core setting is its name in the [values](#values) table. A plugin setting matches by its label, description, group and plugin name.
- An installed plugin matches by its name, its id, its description and its category name.
- A catalog plugin that is not installed matches by its name, its id and its description. It is counted, not listed.

The result shows the heading `“<query>” 찾기`. The line under the heading shows `<N>개 설정`, followed by ` · 플러그인 <M>개` when plugins match. The scope segment shows when a result has a setting that a project can override. Otherwise the badge `전역 전용` shows.

- Setting results are grouped by page. Each group has a heading: the page name for a core setting (`모양`, `작업 공간`, `동작`, `에이전트 연동`, `진단`), and `플러그인 › <plugin name>` for a plugin setting. Each row shows its group name above it, then its label, description and control.
- Installed plugins matching the query form the group `설치된 플러그인`, with rows like the rows of 설치됨.
- Catalog plugins that are not installed and match form a card `찾아보기에 <N>개 더 있다`. A line under the card lists up to four names joined by `, `, followed by ` …` when more match. The button `찾아보기에서 보기` runs `core.settings-tab.browse {query}`, which opens 찾아보기 with the query.
- A query without a match shows `일치하는 설정이 없다.`
- A search does not match the content of the set list or of the installed list.
- A search shows no selected menu item. Clearing the query returns to the last page.
- The search field shows no shortcut hint while no shortcut is bound to it.
- The search runs over the loaded data at each input event. It uses no timer.

## Pages

The pages follow the menu order. The text in quotation marks is the label shown to the person.

### 모양

The page 모양 has the title `모양` and the description `테마와 모드, 카드의 간격·모서리·글꼴.`

The top of the page is a preview: two sample cards headed `터미널` and `브라우저`, drawn with the applied theme, gap, radius, font and size. The sample text is fixed. A gap of 0 makes the cards share one line.

Group `테마`, description `테마가 색과 형태의 기본값을 정하고, 모드는 그 테마의 밝은 쪽과 어두운 쪽을 고른다.`

| Label | Control | Choices | Default | Scope |
| --- | --- | --- | --- | --- |
| `테마` | Swatches | The ten themes `midnight`, `nord`, `solar`, `forest`, `ember`, `slate`, `mist`, `grape`, `sand` and `paper`; each swatch shows the theme colors and its name | `midnight` | common and project |
| `모드` | Segment | `어두움` (`dark`), `밝음` (`light`) | `어두움` | common and project |

Group `형태`, description `테마가 준 값에서 시작한다.`

| Label | Control | Range | Default | Scope |
| --- | --- | --- | --- | --- |
| `통로` (description `카드 사이 간격. 0이면 카드가 선 하나를 공유한다.`) | Slider with unit `px` | 0–48 | the theme value | common and project |
| `모서리` (description `카드 모서리의 둥글기.`) | Slider with unit `px` | 0–24 | the theme value | common and project |
| `폰트` | Select | `시스템 고정폭` (`mono-system`), `SF Mono / Menlo` (`mono-sf`), `JetBrains Mono` (`mono-jet`), `시스템 비례` (`sans-system`), `Inter` (`sans-inter`) | the theme value | common and project |
| `글자 크기` | Stepper `− value +` with unit `px` | 10–18 | the theme value | common and project |
| `textSize` | Select of the text size steps | 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3 | 1 | common only |

Group `표시`:

| Label | Control | Choices | Default | Scope |
| --- | --- | --- | --- | --- |
| `포커스 표시` | Segment | `border`, `corner` | `border` | common and project |
| `경계선` | Segment | `under`, `over`, `none` | `under` | common and project |
| `포커스 밖 흐리게` | Switch | on, off | off | common and project |

The choices of `focusInd` and `fullRule` are shown by their values, because the page declares no label for them.

### 작업 공간

The page 작업 공간 has the title `작업 공간` and the description `프로젝트 창, 탭 위치, 사이드바 배치와 크기.`

Group `프로젝트`, description `프로젝트를 여는 방식. 모든 프로젝트에 적용되며, 이미 열린 창은 그대로 둔다.`

| Label | Control | Choices | Default | Scope |
| --- | --- | --- | --- | --- |
| `열기 방식` | Segment | `별도 창` (`windows`), `현재 창의 새 탭` (`tabs`) | `별도 창` | common only |

Group `위치`, description `프로젝트 탭이 놓이는 위치. 바꾸면 카드 배치도 함께 바뀐다.`

| Label | Control | Choices | Default | Scope |
| --- | --- | --- | --- | --- |
| `프로젝트 탭 위치` | Select box | `위` (`top`), `아래` (`bottom`), `왼쪽` (`left`), `오른쪽` (`right`) | `위` | common and project |

Group `사이드바`, description `위에 있는 줄부터 자리를 잡는다. 먼저 놓인 변이 그 변의 전체 길이를 쓰고, 다음 변은 그만큼 빠진다. 끈 변도 자기 순서를 지킨다.`

The group shows a list of four rows. Each row is one side, and the row order is the placement order stored in `sidebarOrder`. Each row shows, from left to right:

1. The number of the row (1 to 4).
2. The side name `왼쪽`, `오른쪽`, `위` or `아래`.
3. In the project scope, when the project overrides a value of the row, the badge `<project> 값` (acc).
4. The set select of the side, with the options `사용 안 함` and every set. A set option shows a hint `목록 · <n>` or `탭 · <n>` with the number of sections of the set. The select runs `core.settings.link {place, plugin: null, set, scope}` and is disabled while the side is off. The stored link is kept while the side is off.
5. The on/off switch of the side, which runs `core.settings.change {key, value, scope}` with `left`, `right`, `top` or `bottom`.
6. The button ↑ titled `위로`, which moves the row one place up. The first row has it disabled.
7. The button ↓ titled `아래로`, which moves the row one place down. The last row has it disabled.

Each button of 6 and 7 runs `core.settings.change {key: sidebarOrder, value, scope}` with the whole new order as `value`.

The text under the list shows the shortcuts in a fixed order that does not follow the rows: `⌘B 왼쪽 · ⌥⌘B 오른쪽 · ⇧⌘J 위 · ⌘J 아래`.

In the project scope, when the project overrides a side switch, a side link of the general sides or `sidebarOrder`, the button `<project> 값 지우기` (reset icon) shows. The button runs `core.settings.reset {key, scope: "project"}` once for each of these keys.

Group `사이드바 크기`, description `처음 폭은 최소 폭과 최대 폭 사이여야 한다. 위·아래 사이드바에는 높이로 적용된다.`

| Label | Control | Range | Default | Description | Scope |
| --- | --- | --- | --- | --- | --- |
| `최소 폭` | Slider with unit `pt` | 60–800 | 120 | none | common and project |
| `최대 폭` | Slider with unit `pt` | 60–800 | 480 | none | common and project |
| `처음 폭` | Slider with unit `pt` | 60–800 | 190 | `카드 안 사이드바와 저장된 크기가 없는 창 사이드바가 여는 크기.` | common and project |

The three widths keep the scope of the current contract, common and project, because the stored project settings hold each of them per project ([layout values](#layout-values)).

The group checks the effective values of the scope, because a project value can differ from the common value:

- When the minimum is not less than the maximum, the group shows the line `최소 폭(<값>pt)이 최대 폭(<값>pt)보다 작아야 한다.`
- When the first width is outside the range from the minimum to the maximum, the group shows the line `처음 폭 <값>pt가 범위 <최소>–<최대>pt 밖이다.` and the button `범위 안으로 맞추기`. The button runs `core.settings.change {key: sidebarWidth, value, scope}` with the value cut to the range.

### 사이드바 세트

The page 사이드바 세트 has the title `사이드바 세트` and the description `사이드바에 보여 줄 섹션 묶음. 어느 변에 놓을지는 작업 공간과 플러그인에서 고른다.` The scope control shows, because the sets follow the scope rule.

The page lists the sets. Each set row shows:

- The name, or `(이름 없음)` when the name is empty.
- The layout badge `탭` or `목록` (neutral).
- The line `· 쓰는 곳: <list>` when a link uses the set. The list names the sides (`왼쪽`) and the plugin windows (`<plugin name> 창 <side>`). The line is absent when no link uses the set.
- The section chips. A chip shows the section name. A section of a plugin that is not loaded shows its chip with a dashed border in the muted tone and its name struck through, with the tooltip `<name>(<id>) 플러그인 필요` ([missing plugins](plugins.md#missing-plugins)). The set line shows, under the chips, one warning line for each such plugin ([missing plugins](plugins.md#missing-plugins)). A set without sections shows `섹션 없음`.
- The button `편집` (secondary, sm), which runs `core.settings-tab.edit {set}`, and the button `삭제` (ghost, sm).

While a set is edited its row shows the button `완료` (primary, sm) in place of `편집`. `완료` runs `core.settings-tab.edit {set: null}`.

Pressing `삭제` runs `core.settings-tab.confirm {kind: "set", id, answer: "ask"}`, which shows a confirmation under the row: `쓰는 곳은 “사용 안 함”이 된다.` when a link uses the set, else `삭제할까?`. The buttons are `취소` (ghost, sm), which runs the same command with `answer: "no"`, and `삭제` (danger, sm), which runs it with `answer: "yes"`. A `yes` answer runs `core.settings.sets.delete {id, scope}`.

The button `새 세트` (plus icon) runs `core.settings.sets.create {scope}`, which adds a set titled `새 세트` with layout `list` and no sections, and opens the editor for it.

The editor of a set shows:

- `이름`: a text field that runs `core.settings.sets.update {id, title, scope}`. An empty name shows the line `이름이 필요하다.` under the field. A name of 1 to 40 characters is stored.
- `배치`: a segment `목록` (`list`) and `탭` (`tabs`), which runs `core.settings.sets.update {id, layout, scope}`.
- `섹션`: one chip per section of the set, in set order, each with the section name and the button × (`<section name> 빼기`);a section of a plugin that is not loaded shows its chip with a dashed border in the muted tone and its name struck through, with the tooltip `<name>(<id>) 플러그인 필요` ([missing plugins](plugins.md#missing-plugins)). When the set has no section, the line `아직 섹션이 없다.` shows. After the chips stands the select `섹션 추가…`, whose options are the registered sections that the set does not contain, each with the plugin id as its hint, grouped by plugin in plugin and declaration order; the select is disabled while the set contains every registered section.
- The line `바꾼 값은 바로 저장된다. 같은 섹션은 한 세트에 한 번만 들어간다.`
- The button `완료`.

The section controls run `core.settings.sets.row {id, action, index?, section?, scope}`:

| Control | Action | Effect |
| --- | --- | --- |
| × of chip `index` | `remove` with `index` | Removes the section at `index` |
| An option of `섹션 추가…` | `add` with `section` | Appends `section` to the set |

The chips have no reorder control: the order of the sections is the order in which they were added, and a section is moved by removing it and adding it again. A change that would repeat a section in the set fails with -32602 (invalid params) and the error "section <id> is already in set <id>", and changes nothing; an `add` without a registered `section` fails with -32602 and "unknown section <id>". Every change is saved at once to the scope of `sets` that the [scope rule](#scope-of-a-control) gives.

### 동작

The page 동작 has the title `동작` and the description `언어, 메모리, 알림.` The scope control shows, because `language` can be overridden by a project.

Group `언어`, description `애플리케이션 메뉴의 언어. 자동은 시스템 언어를 따르고, 목록에 없으면 영어다.`

| Label | Control | Choices | Default | Scope |
| --- | --- | --- | --- | --- |
| `언어` | Segment | `자동 (시스템)` (`auto`), `한국어` (`ko`), `English` (`en`) | `auto` | common and project |

Group `카드`:

| Label | Control | Choices | Default | Scope |
| --- | --- | --- | --- | --- |
| `카드 자동 정렬` (description `resize는 배치를 지키며 카드 크기를 고르게 나눈다. even은 카드를 같은 격자로 놓는다.`) | Segment | `resize`, `even` | `resize` | common and project |

Group `메모리`, description `메모리 절약을 켜면 숨긴 지 정한 시간이 지난 탭을 내리고, 다시 보일 때 저장된 상태로 연다.` Every row of the group is common only.

| Label | Control | Choices or range | Default | Dependency |
| --- | --- | --- | --- | --- |
| `보기 프로세스` (description `새로 여는 보기부터 적용된다.`) | Segment | `플러그인마다 하나` (`plugin`), `카드마다 하나` (`view`) | `plugin` | none |
| `메모리 절약` | Switch | on, off | on | none |
| `숨긴 뒤 내리기까지` | Slider with unit `분` | 5–720 | 120 | Indented. Disabled while `메모리 절약` is off |

Group `알림` follows [notifications](notifications.md#settings). Its keys are `toastStyle`, `noticeCenterStyle`, `quietToasts`, `autoDismissProblemToasts` and `problemToastDismissSeconds`, and every row of the group is common only.

### 에이전트

<a id="agents"></a>The page 에이전트 연동 has the title `에이전트 연동`, the description `에이전트가 이 애플리케이션을 배우고 다루게 하는 항목.` and the badge `전역 전용`.

The page shows the setup parts that let an agent on the machine learn and connect to the application ([agents](cli.md#agents)). The parts belong to the machine and the person, so the page is common only. The page reads the parts through the host call `setupState()`, which reports the user PATH registration and the other setup parts in the environment of the person's login shell. The page reads the parts when it is shown, when the window becomes the key window (`window-active`), after each `setup-changed` event and when `core.setup.check` runs. No timer reads them again.

The group 에이전트 연동 has one wide row `연동 상태`:

- The summary shows the badge `<n>개 중 <m>개가 다름` (warn, with a warning icon), where `<m>` counts the parts that are `differs` or `missing`. When every part is `ok` the summary shows `모두 설치됨` (ok).
- The button `다시 확인` (refresh icon, sm) runs `core.settings-tab.setup-check`, which runs `core.setup.check`.
- The button `모두 설치` (primary, sm) runs `core.settings-tab.setup-install-all` with the kinds `skill` and `mcp` that have a part that is not `ok`. It is disabled when no such part exists.

Each part is one row, in part order (element name `core.settings-tab.setup`). A row shows the name, the file and the state:

| Part | Name | File | Actions |
| --- | --- | --- | --- |
| `path` | 명령 경로 | the `sok` of the application bundle | `끄기` runs `core.settings-tab.setup-change {part: "path", enabled: false}` while enabled. While disabled the state shows `사용 안 함` and `켜기` runs the same command with `enabled: true` |
| `skill` | 스킬 | the skill file | `고치기` (state `missing` with reason `differs`) or `설치` (state `missing` with another reason), sm, each running `core.settings-tab.setup-install {parts: ["skill"]}` |
| `mcp` | MCP 등록 | the registration file | `고치기` or `설치`, sm, each running `core.settings-tab.setup-install {parts: ["mcp"]}` |
| `hook` | 훅 | the hook file | none; the install command does not take hooks |

The state badge is `설치됨` (ok, state `ok`), `다름` (warn, state `missing` with reason `differs` or `<kind> differs`) or `없음` (warn, state `missing` with reason `absent`). A part in state `error` shows its error text through the error display path ([controls](#controls)). A part that does not apply has no row. When no row exists, the page shows `이 컴퓨터에서 설정할 에이전트 항목이 없습니다.`

`core.setup.check` takes no parameters, reads the parts again and answers `{parts}`. `core.setup.install` takes `{parts}`, a non-empty list of `skill` and `mcp` without repetition, runs the host call `setupInstall` and answers its `{parts}`. It fails with -32602 (invalid params) for another list, with the host error when the installation fails or another operation runs, and with "setup operations need a native host" without a host. The command `core.setup.change {part, enabled}` accepts `part: "path"` and a boolean `enabled`. It runs `setupChange` with the same parameters and answers `{parts}` after it saves and applies the preference. A failed read or operation shows through the error display, which writes it to the application log.

### 진단

The page 진단 has the title `진단`, the description `문제를 추적할 때만 켠다.` and the badge `전역 전용`.

Group `진단`, description `켜면 성능 트레이스와 모든 로그 종류의 상세 기록이 남는다. 끄면 오류만 기록된다.` It has one row `디버그 기록`, a switch that runs `core.settings.debug {on}`. The switch shows on when `diagnostics.performance` is true and every class of `diagnostics.log` is `trace`.

`diagnostics.performance` is the permanent performance trace ([performance trace](performance-trace.md)). It is a boolean that defaults to false, so a release records no trace unless its person turns it on. While it is false no layer performs any performance logging work: no event is built and none is stored. Setting it true makes the layers store the events of the trace in the event files under `logs/`, and setting it back false stops the storing at the next event boundary. The event files and their rotation belong to the [event contract](logging.md#files), not to the setting.

`diagnostics.log` is the [policy](logging.md#policy) of the event log: an object that names the least severe level (`off`, `error`, `warn`, `info`, `debug` or `trace`) that is stored for some of the classes `lifecycle`, `input`, `call`, `io` and `frame`. A class that it does not name takes the default policy, which stores only `error`, and it defaults to `{}`, which stores only `error` in every class, so the record of every error that the display path shows remains. It is set through the settings file; a class outside the five and a value outside the six levels are refused with an error that names the setting. The page sends the policy to the host, which writes `<config-dir>/log-policy.json`, and every process applies the file when it changes.

The command `core.settings.debug {on}` turns both settings on and off together: on sets `diagnostics.performance` to true and `diagnostics.log` to `trace` in every class; off sets `diagnostics.performance` to false and `diagnostics.log` to `{}`. While both are off, no layer builds or stores an event of the trace or an event below `error`.

## Plugins

The plugin pages hold the settings of the loaded plugins, because a plugin's settings, sections and sidebar choices come from its loaded manifest. A plugin is one unit that contributes its surface, its sections, its settings and its accounts. Each control of a plugin setting that holds a plugin reference shows the badge `<id> 필요` (warn) when its value names no loaded plugin ([dependency and validation rules](#dependency-and-validation-rules)). A plugin that is not loaded declares no window or card selectors, so its plugin page draws its info card and no sidebar group.

The plugin pages are 설치됨, 찾아보기 and one page for each plugin. The pages show the plugin descriptions, versions and sidecars, and they run the plugin operations. The plugin operations are defined in [plugin operations in the application](installation.md#plugin-operations-in-the-application), and the state changes that they apply are defined in [applying a change](installation.md#applying-a-change).

### 설치됨

The page 설치됨 has the title `설치된 플러그인`, the description `켜고 끄기, 업데이트, 문제 고치기. 하나를 누르면 그 플러그인의 정보와 설정이 한 페이지에 있다. 새로 찾는 일은 ‘찾아보기’ 화면에서 한다.` and no scope control.

The page shows the rows of the plugins that `installed.json` lists or that the window loaded. Before the rows, the page shows these lines when they apply:

- The core update row, when the registry index lists a newer core release: `core: <running> → <available>`, a link to the release page that runs `core.app.release`, and the button `업데이트`, which runs `core.app.update`. The row is the element `core.settings-tab.plugins.app`, its link `core.settings-tab.plugins.app-release` and its button `core.settings-tab.plugins.app-update`, and each installed plugin that the available release does not fit shows a notice, the element `core.settings-tab.plugins.incompatible`. The update rules are in [application update](installation.md#application-update). Each installed plugin that the available release does not fit shows the notice `<id> <installed> (<range>): <available>에 맞는 최신 버전 <version>`, or `<id> <installed> (<range>): <available>에 맞는 버전 없음` when no version fits, with the element `core.settings-tab.plugins.incompatible`. The link of the row is the element `core.settings-tab.plugins.app-release` with the label `릴리스 페이지`, and its button is the element `core.settings-tab.plugins.app-update`.
- The outdated sidecars, each with `<running> → <installed>` and the button `세션 <sessions>개를 끝내고 적용`, or `세션 <sessions>개를 끝내고 종료` for a sidecar that is no longer declared. Each button runs `core.plugins.replace {sidecar}`. A running service of a sidecar that is no longer declared shows the installed side as `선언 없음`, and a running side that the service did not report, a service of an earlier version, shows as `이전 버전`.

The tool row has:

- The search field, placeholder `설치된 플러그인 찾기`, which runs `core.settings-tab.search {query}`. The search matches the name, the id, the description and the category name of a plugin.
- The filter segment with the label `거르기` and the choices `전체 <n>`, `사용 중 <n>`, `꺼짐 <n>`, `업데이트 <n>` and `문제 <n>`. Each choice runs `core.settings-tab.filter {filter}` with `all`, `active`, `disabled`, `updates` or `problems`. The filter `updates` is the one that the command `core.plugins.show-updates` selects.
- The button `모두 업데이트 (<n>)` (sm), shown when a plugin has an update. It runs `core.plugins.update-all`.

A row shows, from left to right: a letter icon (the first letter of the name, in the accent token with the text token), the name with its badges, and the meta line `분류 · 패키지 또는 키 · v<버전>`: the plugin category of the plugin, when it declares one, its key, and its version, when one is known; a part without a value is left out. The maker of a plugin is not shown, because the registry index lists none. The right side of the row holds the buttons, in this order:

1. `<필요 이름> 설치` (sm) for a required plugin that is missing. It runs `core.plugins.install {plugin}` for the required plugin.
2. `업데이트` (sm) when the plugin has an update. It runs `core.plugins.update {plugin}`.
3. A switch titled `<이름> 사용`, which runs `core.plugins.enable {plugin}` or `core.plugins.disable {plugin}` by its value.
4. An icon button titled `<이름> 정보와 설정`, which runs `core.settings-tab.plugin {plugin}` and opens the plugin page.

The badges of a row appear in this order:

| Badge | Tone | Condition |
| --- | --- | --- |
| `꺼짐` | neutral | `installed.json` lists the plugin disabled |
| `업데이트 <latest>` | acc | the installed version is older than `latest` |
| `개발 빌드` | warn, title `설치 <v> > 배포 <v>` | the installed version is newer than the newest published version; versions compare as numbers |
| `<id> 필요` | warn | a plugin named in `dependencies` is not installed |
| `필요한 플러그인 없음` | warn | the state `requires`: no loaded and enabled plugin of the window is of a category that the plugin requires ([plugin categories](plugins.md#plugin-categories)) |
| `창을 다시 불러오면 적용` | warn | the state `reload`: `installed.json` differs from what the window loaded ([applying a change](installation.md#applying-a-change)) |
| `불러오지 못함` | warn | the state `refused`: the window refused the entry or the manifest of the plugin |

A row with a plugin that has a problem, which is a missing dependency, the state `requires` or the state `refused`, counts as a problem. The filter `problems` and the menu badge count the rows with a problem.

The rows are sorted: rows with a problem first, then rows with an update, then the rest, each group by name with `localeCompare`.

An operation that runs disables every action of every row, and the row of its plugin shows `<plugin> <action> 진행 중`. A failed operation shows its error under its row. A plugin that the host holds ([persistent services](persistent-services.md#updates)) shows its error and the action `세션 <n>개를 끝내고 업데이트`, `세션 <n>개를 끝내고 설치` or `세션 <n>개를 끝내고 사용`, by the action of the held entry, which runs `core.plugins.update`, `core.plugins.install` or `core.plugins.enable` with `{plugin, end: true}`. `<n>` is the sum of the `sessions` of the plugin's sidecars; the action is absent while a `sessions` is `null`.

Below the rows, a dashed card titled `플러그인 찾아보기` says `카탈로그 <N>개 중 <M>개를 더 설치할 수 있다. 설치 전에 필요한 플러그인을 확인한다.`, where `<N>` is the catalog count and `<M>` the number of catalog plugins that are not installed. The button `찾아보기` (primary, search icon) runs `core.settings-tab.nav {page: "browse"}`. When no row matches the filter, the page shows `맞는 플러그인이 없다.`

### 찾아보기

The page 찾아보기 has the title `플러그인 찾아보기` and the description `카탈로그 <N>개. 하나를 누르면 설치 전에 자세히 본다.` It has no scope control.

- The search field, placeholder `이름, 기능으로 찾기`, runs `core.settings-tab.browse {query}`. It matches the name, the id and the description of a catalog plugin.
- The switch `설치한 것 숨기기` (off by default) runs `core.settings-tab.browse {hideInstalled}`.
- The count line shows `<N>개` and, while a query or the switch filters the list, `<shown> / <N>개`.

Each row is one catalog plugin. It shows the name (a button, bold), the badge `<id> 필요` (warn) when a dependency is not installed, the description on one line, and the meta line `<package> · v<latest>`. The right side of the row shows:

- `설치` (primary, sm, plus icon) when the plugin is not installed. It runs `core.plugins.install {plugin}`. The dependencies of the plugin install with it, as [dependencies](plugins.md#pluginjson) states.
- The badge `설치됨` (ok) when the plugin is installed and enabled.
- The badge `설치됨 · 꺼짐` (neutral) when the plugin is installed and disabled.

Clicking the row runs `core.settings-tab.plugin {plugin}`, which opens the plugin page with the back link `‹ 찾아보기`.

The list shows 30 rows at once. When more rows match, the button `<n>개 더 보기` shows, where `<n>` is the number of rows that the press adds: 30, or fewer for the last rows. The button runs `core.settings-tab.browse {more: true}`. When no row matches, the page shows `맞는 플러그인이 없다.`

The rows are sorted by name with `localeCompare`. The registry index lists no categories, no install counts, no publication dates and no makers, so the page filters and sorts by none of them. Rows show only the fields that the manifest and the index provide.

### Plugin page

A plugin page has the back link, the title (the plugin name), and the description. The name, id, version, description, sections, settings, accounts and categories come from the loaded manifest. The latest version and the revocation come from the registry index ([registry index](installation.md#registry-index)). The description of the registry entry stands in only while no manifest is loaded. The plugin page of a plugin that only `installed.json` lists has the plugin id as its name and no description. The description line of the plugin is the element `core.settings-tab.plugins.about`, and it shows only when the plugin has a description.

Before installation the page shows:

- A card row with the letter icon, the name, the meta line `<package or key> · v<latest>` and the button `설치` (primary, plus icon). When a required plugin is not installed, the button reads `<필요 이름>와 함께 설치`.
- The info rows, each a label and a value:

| Label | Value |
| --- | --- |
| `필요` | The names of the `dependencies` with the badge `있음` (ok) when installed, `함께 설치됨` (warn) when installed with the plugin, else `없음` |
| `사이드카` | The name and the range of each sidecar, or `없음` |
| `더하는 것` | `사이드바 섹션 <n> · 설정 <n> · <기여>` from the loaded manifest, or `—` when no manifest is loaded |

- The line `설정을 선언한 플러그인은 설치하면 메뉴 ‘설정이 있는 플러그인’에 들어오고, 이 페이지에 그 설정이 나타난다.`

After installation the page shows an info card with these rows:

- `사용`: the switch `<이름> 사용`, which runs `core.plugins.enable` or `core.plugins.disable`. The meta line reads `<분류> · <패키지> · 설치 <버전>` and then ` · 최신` or ` · 배포 <버전>`, then the sidecar and the contribution. The badge `개발 빌드` shows as in the list. The button `<배포 버전>로 업데이트` (sm) shows when an update exists and runs `core.plugins.update {plugin}`.
- `필요`: this row exists only while a plugin named in `dependencies` is not installed. It shows the warning line `필요한 <이름>(<키>) 플러그인이 설치되어 있지 않다.` and the button `<이름> 설치` (primary, sm), which runs `core.plugins.install {plugin}` for that plugin.
- `제거`: the description `설정 값은 남겨 두고, 다시 설치하면 이어서 쓴다.` and the button `제거…` (danger, sm). Pressing it shows the buttons `취소` (ghost, sm) and `제거` (danger, sm). `제거` runs `core.plugins.remove {plugin}` and returns to 설치됨.

The held action and the error line of the plugin row also appear on the plugin page, in the `사용` row.

The info card shows one line for each contribution of the plugin: `<point> 기여 <n>: <state>`, where `<n>` is the number of the entry in the plugin's `contributes`. The line is the element `core.settings-tab.plugins.contribution`, and its state is `연결됨` (connected), `제공자 없음` (provider-missing) or `version 불일치` (version-mismatch). An invalid contribution shows `<point> 기여 <n>: <reason>` in place of the state, and the same text goes through the error display path, which marks it as an error; the error is withdrawn when the contribution becomes valid.

After the info card, the page shows these groups in this order: `계정`, `설정`, `섹션`, `창 사이드바`, `카드 사이드바`. A group shows its title and its description: `계정` `에이전트 CLI 계정.`, `설정` `플러그인이 선언한 설정.`, `섹션` `이 플러그인이 사이드바에 제공하는 섹션.`. The group `설정` always shows, and shows `이 플러그인에는 설정이 없다.` when the plugin declares no setting. The other groups do not show when they are empty.

The group `계정` is shown for a plugin that declares [accounts](plugins.md#accounts). The account list has one row per account, with the element `core.settings-tab.account` and its `id`. The row shows the identifier, the CLI, the login state (`로그인됨` with ok, or `로그인 안 됨` with neutral) and the usage line, and the buttons `로그인`, `취소`, `로그아웃`, `이름 변경` and `삭제`. Their elements are `core.settings-tab.account-login`, `account-login-cancel`, `account-logout`, `account-edit` and `account-remove`. A row being renamed shows the field and the buttons `core.settings-tab.account-edit-name`, `account-save` and `account-edit-cancel`. The last row, 새 계정, holds a field with the placeholder `새 계정 식별자` (`core.settings-tab.account-name`), a select of the CLI kinds (`core.settings-tab.account-kind`) and the button `추가` (`core.settings-tab.account-add`), which is disabled while the field is empty. A rejected identifier shows the line `소문자, 숫자, _ - 만 쓸 수 있다.` or `이미 있는 식별자다.` under the field. The commands of the group are `core.accounts.add`, `core.accounts.rename`, `core.accounts.remove`, `core.accounts.login`, `core.accounts.login-cancel` and `core.accounts.logout`, each with `{plugin, ...}`. The scrolling pane of the page is the element `core.settings-tab.pane`.

The group `설정` shows one row for each setting that the manifest declares, in manifest order. The row has the `label` as its name and the `description` below it when the declaration has one. Its control follows its form ([controls](#controls)).

The group `섹션` shows the names of the sections that the plugin declares as read-only chips.

The group `창 사이드바` has the description `이 플러그인의 탭이 포커스 카드의 활성 탭인 동안 쓰는 창 사이드바. 세트를 고른 변만 바뀌고, 위에 있는 줄부터 자리를 잡는다.` It shows the four-row list of [the sidebar group](#작업-공간) without the switch: the number, the side name, the project badge, a set select and the buttons ↑ and ↓. The set select runs `core.settings.link {place: "window-<side>", plugin, set, scope}`. The order runs `core.settings.change {key: "<plugin>.win.order", value, scope}` with the whole new order. In the project scope the badges and the reset button follow the rule of [the sidebar group](#작업-공간): a row whose link or whose order the project overrides shows the badge `<project> 값`, and the button `<project> 값 지우기` runs `core.settings.reset {key, scope: "project"}` once for `links` and for `<plugin>.win.order` when the project overrides them. The default order is `left`, `right`, `top`, `bottom`.

The group `카드 사이드바` has the description `카드 안쪽 네 변. 세트를 고른 변만 보이고, 위에 있는 줄부터 자리를 잡는다. 순서는 이 플러그인의 카드에만 적용된다.` It works the same way with `card-<side>` links and the key `<plugin>.card.order`. It is shown for a plugin with a surface.

Every plugin has the window selectors and the card selectors that its declaration allows. The plugin declares its own settings, sections and accounts, and the core page names no plugin and no plugin setting.

### Plugin commands

`core.plugins.install`, `core.plugins.update`, `core.plugins.remove`, `core.plugins.enable` and `core.plugins.disable` take `{plugin}` and run the host call `pluginsRun` with their action. `core.plugins.install`, `core.plugins.update` and `core.plugins.enable` also take `end: true`, which they pass to `pluginsRun`. A command fails with -32602 (invalid params) when `plugin` is not a non-empty string or when `end` is present and not `true`. It fails with the host error when the operation fails or another operation runs, and with "plugin operations need a native host" without a host. A command records its operation in `core.plugins` before it calls the host, and its result after the call.

`core.plugins.apply` asks for each modified tab of the window and starts its workbench again as [applying a change](installation.md#applying-a-change) states. It answers `{reloaded: true}` before the new start, and `{reloaded: false}` when a tab is kept.

`core.plugins.replace {sidecar}` runs the host call `sidecarsReplace` ([persistent services](persistent-services.md#updates)). It fails with -32602 (invalid params) when `sidecar` is not a non-empty string and with the host error when the replacement fails.

`core.plugins.registry {index}` runs the host call `pluginsUseRegistry` and reads the plugin state again. It fails with -32602 (invalid params) when `index` is not a non-empty string, and with the host error when the index cannot be read or checked.

`core.plugins.update-all` takes no parameters. It runs the host call `pluginsRun` with the action `update` for each plugin with an update, in id order, one after the other. It reads the plugin state again after each, and it stops at the first failure with the host error. It fails with "plugin operations need a native host" without a host and when another operation runs, and it does nothing when no plugin has an update.

`core.plugins.browse` opens the settings tab on 설치됨. `core.plugins.show-updates` opens the settings tab on 설치됨 with the filter `updates`, and scrolls the list to its top. The window bar has no update control ([window tools](external-sidebars.md#window-tools)): the menu badge of 설치됨 shows the number of updates, and the filter choice `업데이트 <n>` lists them.

The host's plugin state reads and the outdated sidecar reads run when the page is shown, after each `plugins-changed` event and after each `sidecars-changed` event. A read that finds what the page holds draws nothing.

Without a host, as in the browser application, the page has only the loaded plugins, each as `loaded`, and no action.

## Controls

The settings tab draws every setting with one control from a fixed set, chosen by the form of the setting ([values](#values) and the plugin declarations of [plugins](plugins.md)). Each form has exactly one control, and no setting has a control of its own. The choice of a control follows these rules:

- Two or three listed values: a segment.
- Four or more listed values: a select box.
- On or off: a switch.
- A continuous integer with a unit: a slider with the value and the unit beside it.
- A small integer: a stepper `− value +` with the unit inside it.
- A text value: a one-line text field, in a fixed-width font for identifiers and addresses.

| Form | Control | Command |
| --- | --- | --- |
| A boolean (`left`, `right`, `top`, `bottom`, `dim`, `memorySaver`, `autoDismissProblemToasts`) | Switch | `core.settings.change {key, value, scope}` |
| A choice of two or three listed values (`projectOpening`, `mode`, `focusInd`, `fullRule`, `cardArrange`, `language`, `viewProcess`, the set layout, a plugin `enum` of two or three values) | Segment | `core.settings.change {key, value, scope}` |
| A choice of four or more listed values (`font`, `textSize`, `projectTabs`, a plugin `enum` of four or more values) | Select box with one option per value in the declared order | `core.settings.change {key, value, scope}` |
| A theme of the catalog (`theme`) | Swatch grid with one swatch per theme, drawn with that theme's colors and shape | `core.settings.theme {name, scope}` |
| A bounded integer with a unit (`gap`, `radius`, `memorySaverDelay`, the [layout values](#layout-values), a plugin `integer` with a continuous range) | Slider between the bounds, with the value and the unit; a drag shows each value beside the slider and runs the command once, with the value at its release | `core.settings.change {key, value, scope}` |
| A small bounded integer (`size`, `problemToastDismissSeconds`, a plugin `integer` with a small range) | Stepper `− value +` with the unit | `core.settings.change {key, value, scope}` |
| A string (a plugin `string`) | One-line text field | `core.settings.change {key, value, scope}` |
| An address (a plugin `address`) | One-line text field in a fixed-width font; an empty value or a value that starts with `http://` or `https://` is accepted, and any other value shows `http:// 또는 https:// 로 시작하는 주소여야 한다.` under the field | `core.settings.change {key, value, scope}` |
| A plugin of a category (a plugin `plugin`, [plugin categories](plugins.md#plugin-categories)) | Select box with one option per loaded and enabled plugin of the category, labelled with its name | `core.settings.change {key, value, scope}` |
| A set reference (a link of [sidebar choices](#sidebar-choices)) | Select box of `사용 안 함` and every set, with the hint of each set | `core.settings.link {place, plugin, set, scope}` |
| A list of sides in order (`sidebarOrder`, `<plugin>.win.order`, `<plugin>.card.order`) | One row per side in the current order, named by the side; the first row has no ↑, the last row has no ↓ | `core.settings.change {key, value, scope}` with the whole new list as `value` |
| An account list (the [accounts](plugins.md#accounts) of a plugin) | One row per account, and the row 새 계정 | `core.accounts.add`, `core.accounts.rename`, `core.accounts.remove`, `core.accounts.login`, `core.accounts.login-cancel` and `core.accounts.logout` with `{plugin, ...}` |

The set editor uses the same controls: 이름 is a text field, 배치 a segment, the sections chips with × each, and `섹션 추가…` a select box. The buttons (`편집`, `삭제`, `새 세트`, `완료`, `찾아보기`, `설치`, `업데이트` and the rest) run actions and are not setting controls. The ▲ ▼ of a side row are the control of its order. The chips of the scope control select the scope and are not settings. A setting that has no control in this table, such as `sets`, `diagnostics.performance` and `diagnostics.log`, changes through its own command or through the settings file.

The settings tab defines this control set instead of rendering the tab with the form library at `~/Projects/polyspec/crudui`. That library compiles a form template, binds a record that the application submits as a whole, and keeps row identity, an undo history, `name`-based controls and its own event binding (`connectForm`). The settings tab applies each change at once through a declared command, every control names its command through the shared binder and carries an element name ([exposure](exposure.md)), and the host draws a copy of the control in which no listener runs ([native modals](native-modals.md)). The library's markup and binding meet none of these rules without a layer that rewrites its output, while the plugin setting declarations need only the forms of the table above, so adding the dependency is not justified.

Sizes and keys of the controls:

- An input and a select are 28 points high, a small button (sm) is 24 points high, and a row is at least 36 points high.
- A select box moves its highlight with ↑ and ↓, chooses with Enter, closes with Escape and leaves with Tab. Each option shows its hint at its end. The list opens upward when no room is below the control.
- A text field stores its value on Enter and on blur.
- A key press that changes a value runs the command of its control. A key that only moves the focus or the highlight runs no command.
- Every color of a control is a token of the applied theme. The tone of a badge is one of `ok`, `warn`, `err`, `acc` and `neutral`, drawn from the theme tokens: `ok` and `acc` from `rail`, `warn` from `focus`, `err` from `no` and `neutral` from `muted`; the text of a badge tells `ok` from `acc`, because the themes have no further token.

### Dependency and validation rules

- Every error line of the tab is shown through the error display path, which writes `error: <where>: <text>` to the application log ([exposure](exposure.md)), and is the only red text of the tab. An invalid field shows its error line under the field. The field keeps the value that the person typed, and the stored value does not change.
- A rule across several fields shows its error line under the group, with a fix button when a fix exists. The width rules of [layout values](#layout-values) are the example.
- A row error, such as a failed set section, and a part error of the setup state show their error line at the place of their row, through the same path.
- A badge of a state (`없음`, `불러오지 못함`, `<id> 필요`) uses the tone warn or neutral, never err.
- A setting that depends on another is indented under it. It is disabled while its parent is off: `memorySaverDelay` depends on `memorySaver`, and `problemToastDismissSeconds` depends on `autoDismissProblemToasts`.
- A text field of a set name with an empty value shows `이름이 필요하다.`. A text field of an account identifier shows `소문자, 숫자, _ - 만 쓸 수 있다.` for an invalid identifier and `이미 있는 식별자다.` for a repeated one.
- Names of the sides are `왼쪽`, `오른쪽`, `위` and `아래`. The text `상단` and `하단` is not used.

## Values

Each core setting accepts one form. Reading the settings files and every change check each value against it. A value of another form fails with `Invalid setting <key>: <value>` and the reason. A load reports the error and replaces nothing, and a change fails with -32602 (invalid params) and changes nothing. `core.settings.change` takes a value of the form of its setting, or the string of a control, which becomes the boolean or the number that the setting declares. It converts no other input, so a value of another type is refused. A setting of a list form, such as `sidebarOrder`, takes the whole list as an array.

| Key | Form |
| --- | --- |
| `projectOpening` | `tabs` or `windows`, common scope |
| `theme` | `midnight`, `nord`, `solar`, `forest`, `ember`, `slate`, `mist`, `grape`, `sand` or `paper` |
| `mode` | `dark` or `light` |
| `font` | `mono-system`, `mono-sf`, `mono-jet`, `sans-system` or `sans-inter` |
| `gap` | An integer from 0 to 48 (px): the gap between two adjacent cards: the full distance between them. The margin between the plane and the edge of the stage is half the gap. At 0 the two cards share one line: the plane gap is the border width, a card draws no border and no radius of its own, the drop zone of a tab drag draws no radius and a border of the border width, and the stage has no margin and shares its top line with the bottom line of the space bar and, while the project tabs stand at the left, its left line with the right line of the project column, so the edge of the plane is one line on each side (the seam) |
| `radius` | An integer from 0 to 24 (px) |
| `size` | An integer from 10 to 18 (px) |
| `textSize` | A [text size step](text-size.md), common scope, default 1 |
| `projectTabs` | `top`, `bottom`, `left` or `right`, default `top`. `top` puts the project tabs in the title bar beside the logo. `bottom` puts them in a row under the work area. `left` and `right` put them in a column at that side of the work area. The project home draws no project tab in any position |
| `left`, `right`, `top`, `bottom`, `dim`, `diagnostics.performance` | A boolean; `left` and `right` default to `true`, `top` and `bottom` to `false`, `dim` and `diagnostics.performance` to `false` |
| `sidebarOrder` | An array that holds each of `left`, `right`, `top` and `bottom` once, default `["left", "right", "top", "bottom"]`: the order in which the window sidebars take the room of the plane ([external window sidebars](external-sidebars.md#fixed-placement-and-persistence)). A repeated, missing or other value is refused with `Invalid setting sidebarOrder: <value> is not an order of "left", "right", "top", "bottom"` |
| `<plugin>.win.order`, `<plugin>.card.order` | An array in the form of `sidebarOrder`, default `["left", "right", "top", "bottom"]`, in the scope of the plugin's own settings |
| `diagnostics.log` | An object of the classes and their levels |
| `focusInd` | `border` or `corner` |
| `fullRule` | `under`, `over` or `none` |
| `cardArrange` | `resize` (keeps the arrangement and gives the cards fair sizes, the default) or `even` (an equal grid of the cards, `arrange("even")`). The card auto-arrange command runs the value of this setting, and its toolbar icon shows it |
| `language` | `auto` or a language of the application menu (`ko`, `en`) |
| `sidebarMinWidth`, `sidebarMaxWidth`, `sidebarWidth` | [Layout values](#layout-values) |
| `viewProcess` | `plugin` or `view`, common scope, default `plugin`: the WebContent process of a view that the host creates afterwards, shared by the views of its plugin or its own ([view processes](plugin-processes.md#view-processes)) |
| `memorySaver` | A boolean, common scope, default `true`: the [memory saver](plugins.md#memory-saver) unloads hidden tabs |
| `memorySaverDelay` | An integer from 5 to 720 (minutes), common scope, default 120: the time a tab stays hidden before the memory saver unloads it. Another value is refused with `Invalid setting memorySaverDelay: <value>`, and a change re-arms the scheduler |
| `autoDismissProblemToasts` | A boolean, common scope, default `false` ([notifications](notifications.md#settings)) |
| `problemToastDismissSeconds` | An integer from 1 to 60 (seconds), common scope, default 5 ([notifications](notifications.md#settings)) |
| `sets`, `links` | [Stored sets and links](#stored-sets-and-links) |

The theme catalog with the modes, the fonts, the menu languages with the default language, and the defaults, ranges, choices, switches and common-only keys of these settings are declared once, in the settings of `packages/workbench/workbench.json`. `settings.js` and `text-size.js` import that file as a JSON module and define none of them. The browser runtime imports the common-only keys from that file. Each language host library embeds a copy of that file and reads the common-only keys from it, and `make check-exposure` fails when a copy differs from its source. The defaults of `gap`, `radius`, `font` and `size` are the shape values of the applied theme in that file.

Plugin settings take the form of their declaration ([plugins](plugins.md)).

## Earlier formats

The settings files carry their form in the member `format` (format 1 is the current form; a file of another form, or without the member, is refused, [stored data formats](installation.md#stored-data-formats)). The member is the carrier of the stored form, not a setting: the workspace hides it from the snapshot and preserves it when it writes, and a settings key named `format` is refused like any other unknown key. The rest of this section holds for the settings of the file after the carrier.

The settings files are read only in their current form, and the page does not convert them. A key that is not a declared setting, including the keys of earlier settings (`cardSidebar`, `rail`, `railWidth`, `sidebarFoldedWidth`, `latency`, `skew`, `cardSplit`, `autoDismissErrorToasts`, `errorToastDismissSeconds`), fails with `settings.json: unknown setting <key>` for the common settings and `<project root>/.soksak/settings.json: unknown setting <key>` for the settings of the project that the window opens. A `rail` link, a side link (`left`, `right`, `top` or `bottom`) that names a plugin, and a link to a set that the scope does not hold fail the check of sets and links below. A failure replaces nothing and writes nothing.

## Stored sets and links

`sets` and `links` are settings. Their default values come from normalized plugin sidebar declarations, replaced by explicit `environment.json` `sidebars` when present. A change writes the whole list to the scope that the [scope rule](#scope-of-a-control) gives, like any other setting. A project override of `sets` or `links` replaces the common list.

A set is `{id, title, sections, layout}`:

- `id`: a non-empty string, unique in the list. A created set receives `set-<n>` with the smallest positive `n` that no set in the list uses.
- `title`: a string of 1 to 40 characters.
- `sections`: section ids without repetition.
- `layout`: `list` or `tabs` ([plugins](plugins.md#sections)).

A link is `{place, plugin, set}` with the rules of `environment.json` `sidebars.links`. The effective `sets` and `links` are validated with the plugin-api functions `validateSidebars` and `checkSidebarReferences`, which also validate `environment.json` `sidebars`. The native workbench checks the same rules with the same messages, and a window takes the lists that the check accepted without a second check. The check runs when settings load and before a change is stored. A set that names a section its loaded plugin does not declare, a card-side link naming a loaded plugin without a surface, or a link of a loaded plugin naming a missing set, fails. References to plugins that are not loaded are kept, including a link to a set that only a removed plugin declared, which is used again when the plugin is installed again ([plugins](plugins.md#plugins-that-are-not-loaded)). A failure is reported as follows: a load reports the error and replaces nothing, and a change fails with -32602 (invalid params) and changes nothing.

Deleting a set writes the remaining sets and the links without the ones to it to the same scope in one change.

## Sidebar choices

An absent link explicitly selects `off`. Every selector rejects a current value outside its offered choices instead of allowing the browser to select the first option.

| Link | Meaning |
| --- | --- |
| `{place: "left", "right", "top" or "bottom", plugin: null, set}` | General content of the fixed window sidebar of that side |
| `{place: "window-left", "window-right", "window-top" or "window-bottom", plugin, set}` | Plugin content override of the fixed window sidebar of that side |
| `{place: "card-top", "card-bottom", "card-left", or "card-right", plugin, set}` | Default set for that internal side of the plugin's cards |

Every `set` is a known set ID. Each place/plugin pair appears at most once. Reject plugin side links, null sets and rail links. Set IDs `off` and `inherit` are reserved. Fixed sidebar selection and override rail borders follow [external window sidebars](external-sidebars.md). The switch of a side hides its fixed sidebar without changing choices. A plugin set on a side whose switch is off stores the link and draws nothing on that side: the plugin set replaces only the content of a shown side.

`core.settings.link {place, plugin, set, scope}` accepts a set ID to store a link, or `off` to remove it. `inherit` fails with -32602 for every default link. The separate `core.card.sidebar.set` command still accepts `inherit` to remove a particular card's explicit override ([example model](example-model.md)).

## Layout values

The following values were constants in `plane.js` and `app.css`. They are core settings shown in 작업 공간 › 사이드바 크기, integers in points.

| Key | Label | Default | Range | Use |
| --- | --- | --- | --- | --- |
| `sidebarMinWidth` | 최소 폭 | 120 | 60–800 | Smallest width of an internal card sidebar |
| `sidebarMaxWidth` | 최대 폭 | 480 | 60–800 | Largest width of an internal card sidebar |
| `sidebarWidth` | 처음 폭 | 190 | 60–800 | Initial internal card-sidebar size, and size on its axis of a window sidebar without a saved size: the width of a left or right sidebar, the height of a top or bottom sidebar |

The three values share one range, 60 to 800 points, and their sliders use that range, so equal values sit at equal slider positions. A change that leaves `sidebarMinWidth` ≤ `sidebarWidth` ≤ `sidebarMaxWidth` false fails with -32602 (invalid params) and changes nothing. A stored card width outside the current range is drawn as stored until the grip changes it.

The layout values that both workbenches read have one source, the chrome metrics of `workbench.json`: the card head `head-h` and foot `foot-h`, the head of which is also the tab strip of the target search, the width `drop-band` and the margin `drop-band-margin` of the bands of the target search ([target search](groups.md#target-search)), and the tab strip thresholds `tab-peek-w`, `tab-min-w` and `tab-grab-w`. A value written in the code of each workbench would be a second copy that drifts from the first. The window sidebar sizes of a new space come from the `workspace.grid` cards of `environment.json`.

The lengths, ratios and durations of the workbench stylesheets (`app.css`, `home.css`, `settings.css` and `overlay.html`) are the chrome metrics of `packages/workbench/workbench.json`. The workbench sets each of them as a custom property of the document root before the page draws, and the stylesheets read the custom properties; a stylesheet holds no literal length, ratio or duration. The focus mark stands outside the body of the focused card on every side by `focus-mark-t`, the thickness of its stroke, so the stroke does not cover the surface.

Every text of the workbench has the line height `line-height` of the chrome metrics, which the body gives and the text inherits, except a text whose rule names `line-height-tight`. A `font` shorthand resets the line height to `normal`, which the font decides and no chrome metric holds, so a rule that sets the font with the shorthand names the line height in it: the name of a section head and of a tab of a `tabs` set has `line-height` at the size `section-head-text`, and stands in the middle of the head. The native workbench draws these texts with the same line height, so the element of a section name has the same height and place on every host. A line box of the page takes the whole points of its line height: the computed line height of 12 at 1.45 is 17.4, and WebKit 21624.5.1.11.3 of macOS 26.6.2 lays out each line of that text 17 high, three lines 51, and a fixed line height of 20.7 as 20. The text of the native workbench lays out each line at the same whole points (the mygo fork from `v0.7.4-244-g4abb83d-soksak.11`), and the workbench counts a line in a place that it computes, such as the middle of a tab, by the same rule (`lineBox` of `packages/workbench-mygo/src/shell.go`).

An input and a select of the page without a rule of their own take their look from the browser, in the color scheme of the page, so no stylesheet declares it. The native workbench draws them from `plainControls` of `workbench.json`, the values that a window of the page measures, and no stylesheet reads that table. It also does what the browser does with them: Escape empties a search, Tab selects the text of the field it moves to, and a focus command selects the text of a field that has not had the focus and leaves the selection of one that has. The magnifier and the cancel of a search are the symbols of the system that the browser draws, and a system without them is an error.

The focus ring of such a control is the focus color of the system in the dark appearance, which the page always has, so it follows the accent color and no declaration holds it. Its other colors do not follow the system: the placeholder is the color of the stylesheet of the browser, and the magnifier and the cancel of a search are images of the system in colors of their own, whatever the color of the text is.

A scroll pane of the workbench follows the scroller style of the system. Under the overlay style its scroll bars take no room. Under the classic style a pane whose content overflows takes the width of its vertical bar, the value of `scrollerWidthForControlSize:scrollerStyle:` of AppKit for the legacy style, 17 points at the regular size and 13 at the small size of a `scrollbar-width:thin` pane, from the width that lays out its content, and the same height for a horizontal bar. The web view of a page host does this, and the mygo framework reads the style, its change notice and both widths from AppKit and does the same. The list of a menu is the one thin pane of both workbenches.

## Performance

The settings tab keeps these rules, which apply to every page:

- Each row has a label area and a control area. The control area is 260 points wide and starts at the same x in every row of the pane, and the label area takes the remaining width; a row without a label keeps an empty label area. The width of the pane is read once per layout pass, and no row is measured, so a value change moves no row. The browser host meets this with a CSS grid of the columns `minmax(0,1fr)` and 260 points and uses no `ResizeObserver`; the native host computes the same x from the pane width.
- A change updates the rows of the changed setting only, the rows of the settings that depend on it, because a dependent row is disabled while its parent is off, and the row that reads it, such as the debug switch of the diagnostics settings; a rule across several fields draws its whole group again, because its error line and its fix button stand under the group. The page is built when it is shown, not when the window is created.
- The host builds the settings model only when a setting, an account, the language, the shown page, the plugin state, the application update state or the setup state changes; the changes of the settings, the accounts, the plugin state and the application update advance the inputs of the model through their callbacks, and the key holds the page, the language, the setup generation and the running plugin operation, never an encoded status. A change of a setting builds the model once. The answer of a write, successful or failed, builds nothing: the model shows the value of the change, and a write that the host refuses puts the stored value back in the store and in the control, and the error is shown once through the one display path, so the control shows the value that the host stores. A frame without a change builds nothing, and the model is never built per frame.
- No timer or poll sets a status. A status that is not known yet shows no placeholder state and no delayed state. The setup state and the plugin state are read by the events of [Agents](#에이전트) and [설치됨](#설치됨).
- The undo toast lasts 5 seconds. This duration is a deadline the person sees, and the toast uses the existing toast mechanism.
- No animation changes a layout property. A shadow appears only on a static surface.
- The catalog list shows 30 rows at once, and the page loads the rest when the person asks for it.
- A slider runs its command once, at the release of the drag.
- The search and the filters run over the loaded data at each input event, and they use no timer.

## Status

`core.settings-tab` reports:

| Field | Value |
| --- | --- |
| `page` | The shown page: `look`, `workspace`, `sets`, `behavior`, `agents`, `diag`, `installed`, `browse` or `plugin` |
| `scope` | `common` or `project` |
| `find` | The text of the menu search; empty by default |
| `query` | The text of the installed-plugin search; empty by default |
| `filter` | The filter of 설치됨: `all`, `active`, `disabled`, `updates` or `problems` |
| `browse` | `{query, hideInstalled, shown}` of 찾아보기: the search text, the switch, and the number of rows shown |
| `listed` | The plugin ids of the rows shown in order in 설치됨 or 찾아보기, or `[]` on other pages |
| `actions` | The action buttons of the plugin rows and pages in document order as `{plugin, action, disabled}`. The position of an entry is the index of the element name `core.settings-tab.plugins.action` |
| `plugin` | The plugin whose page is shown, or `null` |
| `back` | `installed` or `browse`: the page that the back link of the plugin page returns to |
| `editing` | The edited set id, or `null` |
| `rows` | Each declared plugin setting row on a plugin page as `{key, name, description}` |
| `controls` | Every control with its element name, key, command, current value, `disabled` (true while a dependent setting's parent is off or a common-only setting is shown in the project scope), and the option values of a select box (`options`, otherwise `null`) |
| `scroll` | The scroll position of the shown content, in points from the top. It is negative while the content is pulled past its start, and a value that is not a number is refused |
| `undo` | The toast that is shown as `{key, label, old, new}`, or `null` |
| `confirm` | The open confirmation as `{kind, id}`, `kind` being `set` or `plugin`, or `null` |
| `errors` | The error lines that are shown as `{key, text}`, or `[]` |
| `results` | On a search, `{settings, plugins, catalog}`: the keys of the matching settings, the ids of the matching installed plugins and the number of matching catalog plugins; otherwise `null` |
| `missing` | The keys of the plugin settings whose value names no loaded plugin, or `[]` |

The element names of the plugin pages keep the prefix `core.settings-tab.plugins.`: `core.settings-tab.plugins.about` for each description line, and `core.settings-tab.plugins.contribution` for each contribution line, in document order.

`core.plugins` reports:

| Field | Value |
| --- | --- |
| `core` | The version of the running core that `pluginsState` reports, or `null` before the state is read, when it cannot be read and without a host |
| `registry` | The registry index URL, or `null` |
| `error` | The registry index error or the plugin state error, or `null` |
| `plugins` | One entry per row, sorted by id: `{id, name, description, state, composition, installed, latest, incompatible, sidecars}`. `state` is one of `loaded`, `disabled`, `available`, `reload`, `refused` and `requires`. `composition` is the surface composition kind of the manifest loaded in this window, or `null` when no surface declaration is loaded; it does not depend on whether a tab is open. `installed` is `{version, enabled}` or `null`. `latest` is the newest version that the registry index lists, that is not revoked and whose `engines.soksak` contains the running core, or `null`. `incompatible` is `true` when the registry index lists a version of the plugin that is not revoked and none of them contains the running core. `sidecars` lists `{name, range, version}` sorted by name, or is `null` for an `incompatible` plugin that is neither installed nor loaded; `range` and `version` are `null` when unknown |
| `operation` | `null` before the first operation, then `{action, plugin, state, error}` of the latest one. `state` is `running`, `done` or `failed`, and `error` is the message of a failed operation or `null` |
| `reload` | `true` when a plugin has the state `reload`; a plugin of the state `refused` does not set it |
| `updates` | The installed plugins whose `latest` version is newer than the installed one, sorted by id: `{id, installed, latest}` |
| `held` | The `held` list of `pluginsState`, or `[]` before the state is read and without a host |
| `outdated` | The outdated sidecars: `{sidecar, running, installed, sessions, surfaces}` sorted by sidecar, or `[]` without a host ([persistent services](persistent-services.md#updates)) |

`core.settings` reports every effective value, including `sets`, `links`, and the layout values, in `values`, and the common value of every key in `common`: the stored common value, or the default when the common settings store none. A key that the selected project overrides has its project value in `values` and its common value in `common`. `core.themes` reports the theme catalog in order: each theme's `name`, `shape` values, and the color tokens of its `dark` and `light` modes.

`core.setup` reports `{parts, running}`: the parts of the last read or operation as `setupState()` returns them, `[]` before the first read, and `running`, the list of kinds in the current operation, or `null`.

## Acceptance

- 동작 and 모양 hold the settings of their groups, and every setting of a page is drawn with the one control of its form in [controls](#controls). No choice is drawn as a row of buttons.
- 작업 공간 › 사이드바 holds the four side rows with the set select, the switch, ↑ and ↓. The row order is the placement order. The first row has no ↑ and the last row has no ↓.
- 사이드바 세트 holds the set list, `새 세트`, and the editor. The editor shows the sections as chips with ×, and one select box `섹션 추가…` for the registered sections that the set does not contain.
- The section controls remove and add sections through `core.settings.sets.row`. A repeated section is rejected.
- 설치됨 shows the rows of the installed and loaded plugins with their problems and updates first, filtered by `core.settings-tab.filter`. A row opens its plugin page, and the back link returns to the page named by `back`.
- 찾아보기 shows the catalog plugins that are not installed, filtered by the search and the switch, and installs one with `core.plugins.install`.
- A plugin page shows its accounts, settings, sections and sidebar choices. A plugin without settings shows `이 플러그인에는 설정이 없다.`. The page names no plugin in core code and no plugin setting in core.
- 에이전트 연동 shows each setup part that applies with the state that `sok setup check` reports. `모두 설치` installs the missing skill files and registration and changes nothing that is in place. The path action applies and saves the desired user registration without elevation.
- A change of a setting shows the undo toast for 5 seconds, and `되돌리기` restores the old value through the same command.
- Each control's element name and command appear in the `controls` of `core.settings-tab`.
- Every press and key of the tab runs a declared command. A check presses an element through its declared command.
- The order rows move a side up and down through `core.settings.change` with the whole order, and the window sidebars arrange in the new order.
- The window sidebar and card sidebar choices of a plugin stay independent through focus and tab changes. A side that is off stays off while a plugin set is chosen for it.
- The layout values change internal sidebar limits and initial size and the initial size of a window sidebar on its axis.
- A chrome switch, the fold control of a window sidebar and every control of the common scope change the value that they show, in the scope that the value comes from.
