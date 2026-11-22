# Activity

[한국어](activity.ko.md)

The activity of a tab tells a person, without opening the tab, whether its surface runs something, waits for the person or ended with a failure. A plugin reports the activity of its surfaces as a status; each window derives the activity of every card, group card and space from the activity of their tabs, the application derives the activity of every project from those of its spaces, and core reports them as a status and draws it as an icon in both workbenches. Core names no plugin.

## Activities

The activities, from the highest to the lowest. `running` stands above `failed`, because a holder that runs work now shows that work before a failure that already ended:

| Activity | Meaning |
| --- | --- |
| `attention` | The surface waits for the person, such as a program that asks for an approval or an answer |
| `running` | The surface runs something, such as a program or an agent |
| `failed` | What the surface ran ended with a failure |
| `idle` | The surface does no work and has no approval or answer pending, such as a shell at its prompt or a program that rests at its own prompt |

## Declaration

A status entry of a plugin marks the status that reports the activity of a surface with the member `activity: true` ([entry fields](exposure.md#entry-fields)). The value of such a status is the activity itself: one of the strings `attention`, `failed`, `running` and `idle`, or `null` for no activity. A plugin whose state is an object, such as the state of a terminal, publishes this string as a separate status, so the plugin and not core decides which of its states is a failure. The manifest check of each reader refuses another form with this text, where `<at>` is `<plugin> exposes <status>`:

| Found | Text |
| --- | --- |
| `activity` that is not `true` | `<at>: activity must be true` |

The cases of `docs/spec/cases/manifest-validation.json` hold this text for the readers of `packages/plugin-api`, `packages/sok/go` and `packages/sok/rust`.

## Activity of a tab

The activity of a tab is the highest activity among the statuses of its plugin that declare `activity`, each read on the surface of the tab: a status whose value is an activity gives that activity, and a status whose value is `null` gives none. A status that the surface has not registered gives none, so a tab whose surface has not started, is unloaded ([memory saver](plugins.md#memory-saver)) or ended has no activity. A tab that no status gives an activity has none.

A value that is neither an activity nor `null` is an error of the plugin: it gives no activity, and the workbench shows the text `<plugin> exposes <status> on tab <tab>: activity value <value> is not one of attention, running, failed, idle`, where `<value>` is the JSON text of the value, in the error banner of the window through the error display path, with the source `activity <tab>`; the first such status of the tab in the order of its declaration gives the text, and the error is withdrawn when the statuses of the tab report valid values again or the tab leaves the window.

The workbench follows each such status of each tab of the projects of its window by a watch of that surface ([relay](exposure.md#relay)), which sends each change of the value; it reads no value on a timer. It starts and ends the watches when a layout, a project or the registration of a surface changes, and derives the activities again at each value that a watch delivers.

## Activity of a card, a group card and a space

Each holder has the highest activity among what it holds, and none when nothing that it holds has an activity:

- a content card holds its tabs;
- a group card holds its members, content cards and group cards, so an enclosing group card holds the activities of the group cards inside it ([group cards](groups.md#model));
- a space holds the cards of its layout.

A window derives these activities from the tabs of the projects that it holds: the projects that it opened, whose tabs stay surfaces of the window ([memory saver](plugins.md#memory-saver)), with the drawn layout in the place of the stored layout of the shown space. The surfaces of a project are surfaces of the window that holds it, so no other window can derive them. The shared cases `windows` of `docs/spec/cases/activity.json` state the activity of a tab from its statuses and the activities of the spaces of each project from the layouts of the stored form ([storage](groups.md#storage)), and `packages/workbench/activity.js` and `packages/workbench-mygo/src/activity.go` run them. A window derives no activity of a project.

## Activity of a project

The application holds one record of the activities of its projects, in the host, by project and not by window: a project has the highest activity among its spaces, the shown space and the spaces that are not shown, and the record lists only a project that has one, as `{activity, spaces}`. A project gives the same value in each window, whichever window holds it and whether it shares that window with other projects or has a window of its own, and the record is the only place where the activity of a project is derived.

The window that holds a project publishes the activities of its spaces with the host call `projectActivity({id, spaces})` after each change of them: `spaces` maps each space of the project that has an activity to `{activity, cards, groups}` as the cases `windows` derive it, and an empty `spaces` withdraws the project from the record. The host refuses a publication with one of these texts and leaves the record unchanged:

| Found | Text |
| --- | --- |
| an `id` that is not a project id | `invalid project id` |
| a window that does not hold the project | `project <id> is not owned by this window` |
| an `activity` of a space that is not an activity | `project <id> space <space>: activity <value> is not one of attention, running, failed, idle` |
| a value of `cards` that is not an activity | `project <id> space <space> card <card>: activity <value> is not one of attention, running, failed, idle` |
| a value of `groups` that is not an activity | `project <id> space <space> group <card>: activity <value> is not one of attention, running, failed, idle` |

`<value>` is the JSON text of the value; the spaces are checked in code point order of their identifiers, each its `activity`, then its `cards` and its `groups` in code point order. The host removes the entry of a project when the window that published it releases the project ([projects](projects.md#project-identity)), closes, or its page ends or a new page starts, because the surfaces that gave the activities ended with it; the window that holds the project next publishes it again once its surfaces report. So a project that leaves one window for another keeps no entry of its earlier window, and a removed project has none.

Each change of the record raises its `revision`, a whole number that starts at 0, and the host sends the record `{revision, projects}` as the event `project-activity` to every window; it sends the current record to a window when that window reports ready (`windowReady`), so a new window starts with the projects of the other windows. A window keeps the record of the highest revision that it received. The shared cases `records` of `docs/spec/cases/activity.json` state the record after each publication and removal, and the records of `packages/host/go`, of `packages/host/rust` and of `packages/workbench/activity.js`, which the browser runtime uses, run them.

## Status

`core.activity` reports the activities as `{projects, tabs}`. `projects` is the record of the projects of the application ([activity of a project](#activity-of-a-project)): it holds for each project that has an activity, held by this window or by another, `{activity, spaces}`, and `spaces` holds for each of its spaces that has an activity `{activity, cards, groups}`: `cards` maps each content card of the space that has an activity to it and `groups` each group card that has an activity to it, by card identifier. `tabs` maps each tab of the projects of this window that has an activity to it, by tab identifier. A holder without an activity is not listed, so an application in which no tab has an activity reports `{projects: {}, tabs: {}}`. The project tabs, the space tabs and the group headers of a window draw the activities of `projects`, and the tabs of the cards draw those of `tabs`.

## Drawing

Each workbench draws the icon of the activity immediately before the name of each tab of a card (`core.activity.tab`), of each group header (`core.activity.group`), of each space tab (`core.activity.space`) and of each project tab (`core.activity.project`) that has an activity, and draws nothing where there is none; a content card shows the activities of its tabs and draws no icon of its own. Each icon is an image of the element name above, one element per drawn icon in workbench order, with the Korean name of its activity as its accessible name and tooltip; it runs no command, and `core.activity` holds its activity.

The icons are the declared icons `activity-attention`, `activity-failed`, `activity-running` and `activity-idle` of `packages/workbench/workbench.json` on a 16 point view box, drawn in strokes of the chrome value `activity-stroke`. The icon and its gap to the name are shares of the text size of the name, the same in every holder: the icon is `activity-icon-em` of that size wide and high, and the gap is `activity-gap-em` of it, in a tab and a group header at the small text size and in a space tab and a project tab at the control text size; a group header drops the start padding of its name beside an icon, so that gap stands alone. The names of the activities are `activities` of the same file. A space tab and a project tab follow the frame text scale as their names do; a project tab in the column shows its icon and its name centred together:

| Activity | Icon | Color | Name |
| --- | --- | --- | --- |
| `attention` | a ring with an exclamation mark | `focus` | 응답 대기 |
| `failed` | a ring with a cross | `fail` | 실패 |
| `running` | a ring with a triangle | `rail` | 실행 중 |
| `idle` | a ring | `muted` | 유휴 |

The icons are static: a change of activity draws the next icon once, and no icon animates, so the activity adds no work to a frame while no activity changes. Each activity has its own color in every theme and mode: the theme declares `fail` beside `focus`, `rail` and `muted`, and the four differ. No icon uses the error color `no`, which belongs to the display of errors.
