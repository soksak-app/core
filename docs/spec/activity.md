# Activity

[한국어](activity.ko.md)

The activity of a tab tells a person, without opening the tab, whether its surface runs something, waits for the person or ended with a failure. A plugin reports the activity of its surfaces as a status; core derives the activity of every card, group card, space and project from the activity of their tabs, reports it as a status and draws it as an icon in both workbenches. Core names no plugin.

## Activities

The activities, from the highest to the lowest:

| Activity | Meaning |
| --- | --- |
| `attention` | The surface waits for the person, such as a program that asks a question |
| `failed` | What the surface ran ended with a failure |
| `running` | The surface runs something, such as a program or an agent |
| `idle` | The surface runs nothing and waits for nothing |

## Declaration

A status entry of a plugin marks the status that reports the activity of a surface with the member `activity: true` ([entry fields](exposure.md#entry-fields)). The value of such a status is the activity itself: one of the strings `attention`, `failed`, `running` and `idle`, or `null` for no activity. A plugin whose state is an object, such as the state of a terminal, publishes this string as a separate status, so the plugin and not core decides which of its states is a failure. The manifest check of each reader refuses another form with this text, where `<at>` is `<plugin> exposes <status>`:

| Found | Text |
| --- | --- |
| `activity` that is not `true` | `<at>: activity must be true` |

The cases of `docs/spec/cases/manifest-validation.json` hold this text for the readers of `packages/plugin-api`, `packages/sok/go` and `packages/sok/rust`.

## Activity of a tab

The activity of a tab is the highest activity among the statuses of its plugin that declare `activity`, each read on the surface of the tab: a status whose value is an activity gives that activity, and a status whose value is `null` gives none. A status that the surface has not registered gives none, so a tab whose surface has not started, is unloaded ([memory saver](plugins.md#memory-saver)) or ended has no activity. A tab that no status gives an activity has none.

A value that is neither an activity nor `null` is an error of the plugin: it gives no activity, and the workbench shows the text `<plugin> exposes <status> on tab <tab>: activity value <value> is not one of attention, failed, running, idle`, where `<value>` is the JSON text of the value, in the error banner of the window through the error display path, with the source `activity <tab>`; the first such status of the tab in the order of its declaration gives the text, and the error is withdrawn when the statuses of the tab report valid values again or the tab leaves the window.

The workbench follows each such status of each tab of the projects of its window by a watch of that surface ([relay](exposure.md#relay)), which sends each change of the value; it reads no value on a timer. It starts and ends the watches when a layout, a project or the registration of a surface changes, and derives the activities again at each value that a watch delivers.

## Activity of a card, a group card, a space and a project

Each holder has the highest activity among what it holds, and none when nothing that it holds has an activity:

- a content card holds its tabs;
- a group card holds its members, content cards and group cards, so an enclosing group card holds the activities of the group cards inside it ([group cards](groups.md#model));
- a space holds the cards of its layout;
- a project holds its spaces, the shown space and the spaces that are not shown.

The projects of a window are the projects that the window opened, whose tabs stay surfaces of the window ([memory saver](plugins.md#memory-saver)); a project that another window opened has no activity in this window, because its surfaces are not surfaces of this window. The shared cases of `docs/spec/cases/activity.json` state the activity of a tab from its statuses and the activities of the holders from the layouts of the stored form ([storage](groups.md#storage)), and `packages/workbench/activity.js` and `packages/workbench-mygo/src/activity.go` run them.

## Status

`core.activity` reports the activities of the window as `{projects, tabs}`. `projects` holds for each project of the window that has an activity `{activity, spaces}`, and `spaces` holds for each of its spaces that has an activity `{activity, cards, groups}`: `cards` maps each content card of the space that has an activity to it and `groups` each group card that has an activity to it, by card identifier. `tabs` maps each tab that has an activity to it, by tab identifier. A holder without an activity is not listed, so a window in which no tab has an activity reports `{projects: {}, tabs: {}}`.

## Drawing

Each workbench draws the icon of the activity immediately before the name of each tab of a card (`core.activity.tab`), of each group header (`core.activity.group`), of each space tab (`core.activity.space`) and of each project tab (`core.activity.project`) that has an activity, and draws nothing where there is none; a content card shows the activities of its tabs and draws no icon of its own. Each icon is an image of the element name above, one element per drawn icon in workbench order, with the Korean name of its activity as its accessible name and tooltip; it runs no command, and `core.activity` holds its activity.

The icons are the declared icons `activity-attention`, `activity-failed`, `activity-running` and `activity-idle` of `packages/workbench/workbench.json` on a 16 point view box, drawn in strokes of the chrome value `activity-stroke` at the size `activity-icon`, with the gap of its holder to the name: `tab-gap` in a tab, `card-head-gap` in a group header and `bar-tab-gap` in a space or project tab. The names of the activities are `activities` of the same file. A space tab and a project tab follow the frame text scale as their names do; a project tab in the column shows its icon and its name centred together:

| Activity | Icon | Color | Name |
| --- | --- | --- | --- |
| `attention` | a ring with an exclamation mark | `focus` | 응답 대기 |
| `failed` | a ring with a cross | `fg` | 실패 |
| `running` | a ring with a triangle | `rail` | 실행 중 |
| `idle` | a ring | `muted` | 유휴 |

The icons are static: a change of activity draws the next icon once, and no icon animates, so the activity adds no work to a frame while no activity changes. No icon uses the error color `no`, which belongs to the display of errors.
