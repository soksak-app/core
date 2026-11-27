# Notifications

[한국어](notifications.ko.md)

Every notice that the person sees goes through one notification path. A notice is shown in up to three places: the status line of the card it belongs to, a toast under the bell, and the notice center, which keeps every notice. An error that the application shows is a notice of the kind `error`; this path is the one display path of errors ([exposure](exposure.md#error-presentation)). A notification of the operating system is a system notification ([tab reports](plugins.md#tab-reports)), not a notice.

## Notices

A notice is a record:

| Field | Value |
| --- | --- |
| `id` | A string that the workbench assigns |
| `kind` | `success`, `info`, `warning`, `error` or `progress` |
| `title` | 1 to 120 characters without control characters |
| `text` | 0 to 1024 characters without control characters |
| `source` | `{kind: "card", card, tab, plugin}`, `{kind: "sidebar", sidebar, card, plugin}`, `{kind: "plugin", plugin}`, `{kind: "settings"}` or `{kind: "core"}` |
| `actions` | Up to two `{label, command, params}` of declared commands; a label has 1 to 24 characters |
| `progress` | For `progress`, a number from 0 to 1, or `null` while the amount is unknown; absent for the other kinds |
| `at` | The time of the latest occurrence, ISO 8601 with the offset |
| `count` | The number of occurrences that the notice merged |
| `read` | Whether the person has seen it: in the center, or in its card while the card has the focus |

Each kind has its own icon shape and color token: success a check in the success token, info an `i` in the accent, warning a triangle in the warning token, error a cross in the error token, and progress a turning ring, which becomes the success or error icon when its work ends. The color is never the only mark. A request for a confirmation, such as an agent that waits for the person, is a `warning` notice whose action answers it.

An occurrence with the same kind and title as a notice that is still shown as a toast or on a status line merges into it: `count` grows, `at`, `text`, `source` and `actions` take the new values, and the title reads `<title> ×<count>`. A redraw of an occurrence that the person closed leaves it closed; the next occurrence, after its origin changed or recovered, opens a new toast and adds a new center entry. A card notice (source `card`) merges only with a shown notice of the same card, so the same kind and title on two cards are two notices; an app notice (no card) merges only with an app notice.

The workbench writes one application log line when a notice appears or merges, in the class of its source: `error: <where>: <text>` at the level `error` for an error, which the default policy stores ([logging](logging.md#policy)), and `notice <kind>: <where>: <title>` at the level `info` for the other kinds, which the policy stores when it names that class at `info`. `<where>` names the source.

## Places

| Place | Notices | Where | How long |
| --- | --- | --- | --- |
| Card status line | The notices of that card, and the notices of a sidebar on the status line of that sidebar | The content footer of the card, or the status line of the sidebar | `success` and `info` 6 seconds; `warning` and `error` until the person closes them; `progress` until it ends |
| Toast | The notices whose source is not a card or a sidebar, the `warning` and `error` notices of a card that does not have the focus, and the `warning` notices of a card sidebar as described in [sidebar notices](#sidebar-notice), except a missing-plugin warning | Under the bell, at the right of the window | `success` and `info` 4 seconds; `warning` and `error` until the person closes them, or after the delay of 오류·경고 자동 닫힘; `progress` until it ends |
| Notice center | Every notice | Opened by the bell | `error` until the person clears it; every other kind 7 days after `at` |

A notice of the focused card shows on its status line only. A `warning` or `error` notice of a card that does not have the focus shows on its status line and as a toast with the action `카드로 가기`, which runs `core.card.focus {card}`. Focusing a card marks its notices read.

The durations are timers, because no event ends a notice that is only to be read: the timer of a shown notice pauses while the pointer is over it or while it holds the keyboard focus, and a redraw, a move to another place or a transfer to a modal does not restart it. The status `core.toasts` reports each remaining time, so each expiry is a change of that status.

Closing a toast or a status line notice removes it from that place and keeps its center entry. The origins and the withdrawal of errors are the rules of [error presentation](exposure.md#error-presentation): a pending or recovered state withdraws the notices that it owns from the toasts and the status lines, closing a tab withdraws the notices of that tab, and each withdrawal marks the center entry read and changes `core.toasts` and `core.grid`. The entry stays in the center until the person clears it or it expires.

## Card status line

The content footer of a card ([tab reports](plugins.md#tab-reports)) shows the newest unclosed notice of any tab of the card, and the footer text of the active tab while the card has no unclosed notice. A notice line reads `● <title> · <text> · [<action>] · ×`: the dot is the icon of the kind, the line shows the first action only, the tab name precedes the title when the notice comes from a tab that is not the active tab, and a `warning` or `error` line tints its background with the light tone of its kind. The line is the element `core.card.notice` with the parameter `card`; its close control runs `core.notices.close {id}`. `core.grid` reports for each card its `notice` (the `id`, `kind` and `title` of the shown notice, or `null`) beside its `status` (the shown footer text, or `null` while a notice is shown).

## Sidebar notice

A sidebar notice (source `sidebar`) shows on the status line of its sidebar, in the form of the card status line, and its close control runs `core.notices.close`. It merges only with a shown notice of the same sidebar. Its `card` is the card of a card sidebar and null for a window sidebar. A window sidebar's notice is never a toast: it shows on its status line. A card sidebar's notice is a toast only while its card does not have the focus, and that toast carries `카드로 가기` when `card` is not null. A missing-plugin warning is no toast and no status line notice: it is one line at the top of its sidebar ([missing plugins](plugins.md#missing-plugins)), and the notice center and the bell keep it as its record. When the notice is withdrawn, the status line and the toast drop it and the center keeps its entry.

## Toasts

The toasts lie under the bell at the right edge of the window, above every card and surface ([native modals](native-modals.md#toast-overlay)). The setting 토스트 모양 (`toastStyle`) chooses their form:

| Value | Label | Form |
| --- | --- | --- |
| `card` | 카드 | A column at the top right, newest first. Three toasts show and a line `+<n>개 더` counts the rest. A toast that closes by itself shows its remaining time as a thin bar at its bottom |
| `line` | 한 줄 | One line of inverted colors at the top center. One notice shows; a red count shows the number of the others, and a press on the count runs `core.toasts.list {open}`, which shows them as the card column under the line. The line shows one action |
| `deck` | 덱 | A stack at the top right. The front toast shows whole; the pointer over the stack spreads it |

A toast shows the icon, the title, the text, its actions and a close control, which runs `core.notices.close {id}`. Running an action closes the toast. A source that can run its failed operation again passes that operation as the first action of the error notice, `{label: "다시 시도", command, params}`; core adds no retry, and an error that core makes carries none. An error also offers `자세히`, which runs `core.notices.show {id}` and opens the center at the notice; a warning offers the action that resolves it, such as an install; a success may offer `되돌리기` or `설정 열기`.

While the notice center is open, no toast appears, and a new notice shows in the center only. While the center is a drawer, the toasts lie left of it. The setting 조용히 (`quietToasts`) shows only `error` notices as toasts; every other notice goes to the center and to the status line of its card.

An error toast has `role="alert"`, every other toast `role="status"`. With reduced motion, toasts appear and close without animation.

## Bell

The bell is the last element of the title bar on every screen, the work screen, the settings tab and the project home, after the tools of the screen ([window tools](external-sidebars.md#window-tools)), so that a split of the cards or a hidden sidebar does not move it. It is the element `core.chrome.notices` and runs `core.notices.toggle`. It shows the number of unread notices: in the error token while an unread notice is a `warning` or an `error`, otherwise in the accent, and no number while every notice is read. Its tooltip reads `알림 센터`, and `알림 센터, 읽지 않음 <n>개` while notices are unread.

## Notice center

The setting 알림 센터 모양 (`noticeCenterStyle`) chooses `popover` (팝오버), which drops under the bell, or `drawer` (서랍), which fills the right side of the window from the bottom of the title bar to the bottom of the window. Escape and the close control close it. The title bar row grows with the frame text factor ([text size](text-size.md)), and the popover, the drawer and the toasts start below the drawn row, so the row covers none of them and none of them covers the bell.

- The head shows `알림`, the button `모두 읽음` (`core.notices.read-all`), the button ⚙, the settings icon of the title bar ⚙ at the same size and stroke, which runs `core.settings-tab.nav {page: "behavior", group: "notices"}` and so opens the settings tab at the group 알림 of the page 동작, and the close control, the element `core.notices.toggle`, which runs `core.notices.toggle`.
- The filter segment shows `전체 <n>`, `오류·경고 <n>` and `진행 중 <n>` (`core.notices.filter {filter}` with `all`, `problems` or `progress`), with the switch 조용히 beside it (element `core.notices.quiet`, which runs `core.settings.set {patch: {quietToasts}}`).
- The list groups the entries: `진행 중` first, with a progress bar for each, then `오늘`, `어제` and each earlier day. Each group has the button `지우기` (`core.notices.clear {group}`).
- An entry shows the icon, the title with its count, the text, the source chip (the tab label that the entry keeps, the plugin name, `설정` or `soksak`), the time and its actions. An unread entry has a dot at its left, in the error token for an error. A press on the entry of a card notice runs `core.card.focus {card}`.
- The foot reads `오류는 지울 때까지, 나머지는 7일 동안 남는다.` with the button `모두 지우기` (`core.notices.clear-all`).
- An entry that arrives while the center is open is highlighted at the top of its group for one second.

The center keeps its entries in `notices.json` of the application configuration directory ([projects](projects.md#project-identity)), because the design keeps a notice for days and a restart must not drop it. The file holds `{format: 2, notices}` and is read only in its current form; a reader refuses any other form with an error that names the file and what it found. A card entry keeps the title of its tab in `source.label` when the entry is added, and the chip shows that label; a card entry without a label is refused. An entry whose card or tab no longer exists after a restart keeps its text and source chip and has no action and no focus press. The workbench removes the expired entries when it reads the file, when it writes it and when the center opens, so no timer runs for the expiry.

## Settings

The group 알림 of the page 동작 ([settings](settings.md#declarations)) has the description `알림은 세 곳에 나온다: 카드 상태줄(그 카드의 알림), 토스트(앱 알림), 알림 센터(전부).` Every row is common only.

| Key | Label | Control | Choices or range | Default |
| --- | --- | --- | --- | --- |
| `toastStyle` | `토스트 모양` (description `앱 알림과, 보고 있지 않은 카드의 오류·경고가 뜨는 모양. 종 아래에 나타난다.`) | Segment | `카드` (`card`), `한 줄` (`line`), `덱` (`deck`) | `card` |
| `noticeCenterStyle` | `알림 센터 모양` (description `제목줄 종을 누르면 여는 모양.`) | Segment | `팝오버` (`popover`), `서랍` (`drawer`) | `popover` |
| `quietToasts` | `조용히` (description `켜면 오류만 토스트로 띄우고 나머지는 알림 센터에만 쌓는다.`) | Switch | on, off | off |
| `autoDismissProblemToasts` | `오류·경고 자동 닫힘` (description `끄면 오류·경고 토스트는 ×로만 닫힌다. 성공·정보는 4초 뒤 늘 닫힌다.`) | Switch | on, off | off |
| `problemToastDismissSeconds` | `닫힐 때까지` | Stepper with unit `초` | 1–60 | 5 |

`problemToastDismissSeconds` is indented and disabled while `autoDismissProblemToasts` is off. Turning the switch off cancels the deadlines of the open `warning` and `error` toasts and keeps them open; turning it on, or changing the delay, starts the delay for each of them. The keys are camelCase because a key with a dot names a plugin setting ([settings](settings.md#values)).

## Plugin notices

A page gives its card a notice with `tab.notify({kind, title, text, action, system})`: `kind` is one of the kinds, `title` and `text` follow the notice fields and `text` may be absent, which shows no text, a `progress` notice starts with the progress `null`, `action` is an optional `{label, command, params}` of a command that the plugin declares, and `system` is an optional boolean. The call returns the notice `id`; `tab.progress(id, progress)` sets the progress of a `progress` notice, and `tab.done(id, kind, title)` ends it as `success` or `error`. Another value throws. The plugin decides which of its events are notices, such as a command that ended with a status other than zero, a finished build or an agent that asks for a confirmation, and which of its own settings set `system`.

A page also gives its plugin a notice that belongs to no card, such as the end of a background job, a sidecar event or an update of the plugin, with `page.notify(fields)`, and sets it with `page.progress(id, progress)` and `page.done(id, kind, title)`, which take the fields of the `tab` calls. Such a notice has the source `plugin`: it shows as a toast and in the center with the plugin name as its source chip, has no card status line and no `카드로 가기`, and stays after every surface of the plugin closes. A card notice shows in the center too; `page.notify` is for a notice that no card owns. The `system` field of `page.notify` and of `core.notices.add {plugin}` is allowed: the host posts the notice as a system notification under the rule of [tab reports](plugins.md#tab-reports), keyed by the plugin id instead of a tab, so the notice stays a system notification of the plugin while none of its surfaces is visible.

With `system: true` the host also posts the notice as a system notification, under the rules of [tab reports](plugins.md#tab-reports). `tab.error(text)` reports the error state of an operation of the surface: it shows as an `error` notice of the card, and `tab.error(null)` withdraws it.

## Commands and statuses

The commands create, read and remove notices as `tab.notify` does, so that an agent, `sok` and a test give and read notices through the [exposure](exposure.md) without a page. `tab.notify`, `page.notify`, their progress and done calls and the commands run one path. A notice always belongs to a card, a plugin, the settings or the core, so a command names its card or its plugin.


| Name | Kind | Contract |
| --- | --- | --- |
| `core.notices` | status | `{open, style, filter, unread, problems, shown, entries}`: whether the center is open, its style, its filter, the number of unread entries, whether an unread entry is a warning or an error, the `id` of the shown entry (the entry that `core.notices.show` marked, or `null` while none is marked or the marked entry is removed), and the entries in center order, each with the fields of the [notice](#notices), `read` and `source` |
| `core.notices.add {card?, plugin?, kind, title, text?, action?, system?}` | command | Gives the card `card`, or the plugin `plugin`, a notice with the fields of `tab.notify` and returns its `id`; exactly one of `card` and `plugin` is given; a card or a plugin that does not exist and a field that `tab.notify` refuses fail with -32602 and the same text |
| `core.notices.progress {id, progress}` | command | Sets the progress of a `progress` notice, as `tab.progress` |
| `core.notices.done {id, kind, title}` | command | Ends a `progress` notice as `success` or `error`, as `tab.done` |
| `core.notices.read {id}` | command | Marks one entry read; an id that no entry has fails with -32602 |
| `core.notices.toggle` | command | Opens or closes the center |
| `core.notices.filter {filter}` | command | Sets the filter of the center |
| `core.notices.read-all` | command | Marks every entry read |
| `core.notices.clear {group}` | command | Removes the entries of a group of the center |
| `core.notices.clear-all` | command | Removes every entry |
| `core.notices.close {id}` | command | Closes the toast and the status line notice of the notice and keeps its entry; an id that no shown notice has fails with -32602 |
| `core.notices.show {id}` | command | Opens the center, scrolled to the entry of `id` and marking that entry as the shown entry; an id that no entry has fails with -32602, which names the id |
| `core.toasts.list {open}` | command | Shows (`open` true) or hides (`open` false) the other toasts as the card column under the line form; Escape and a second press on the count also hide it |
| `core.toasts` | status | `{toasts, listOpen}`: the shown toasts in order, each with `id`, `kind`, `title`, `count` and its remaining time in milliseconds, or `null` while it waits for the person, and `listOpen`, whether the line form shows the list of its other toasts |

`core.notices.close` and `core.toasts` replace `core.error.dismiss` and `core.workbench.error`.

## Decisions

- The center is stored, because the design keeps errors until they are cleared and the other kinds for 7 days, which a restart must not cut short. It is data of the person, not a diagnostic record: the application log stays the one diagnostic record, and each notice writes its log line there.
- The bell and the status line use the error token, and a status line shows the text of an error, because they are places of the one display path of errors; no element outside this path uses the error token. The design asks for the bell in the error token for an unread warning as well, so the bell marks unread problems, not the kind of one notice.
- Notices merge by kind and title, as the design states; the merged notice takes the source of its newest occurrence.
- `tab.notify` takes a record, because the policy `tab` or `system` cannot express the five kinds. The posting condition of system notifications is unchanged, and a plugin maps its own setting to `system`.
- The setting keys keep camelCase and not the dotted names of the design, because dotted keys are plugin keys. `autoDismissErrorToasts` and `errorToastDismissSeconds` are renamed, because they now govern warnings as well; the stored files are edited into the new keys in the same change.
