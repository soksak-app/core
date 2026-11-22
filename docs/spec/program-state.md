# Program state

[한국어](program-state.ko.md)

The program state of a tab tells a person and the plugins of the application whether the program that the surface of the tab runs is idle, works or waits for the person, without opening the tab. A plugin whose tabs run programs, such as an agent CLI, declares which of its own statuses carries that state; each window follows that status on each tab of its projects and reports it in `core.grid`. Core names no plugin.

The program state is separate from the activity of a tab ([activity](activity.md)). An activity is a presentation phase that core derives for the icons of the holders: its values include `failed`, which names no state of a program, and its highest value is taken for each holder, so the activity of a card does not tell which of its tabs waits. A program state has its own three values and is read per tab.

## Declaration

`surface.program`, when present, names a status of `exposes.status` in the same plugin.json ([plugin.json](plugins.md#pluginjson)). The status is the only source of the program state of the plugin's tabs. The manifest check refuses the declaration with these texts, where `<plugin>` is `plugin <id>`:

| Found | Text |
| --- | --- |
| `surface.program` that is not a string | `<plugin>: surface program must be a status name` |
| a name that no status of `exposes.status` declares | `<plugin>: surface program <name> must name a status declared in exposes` |
| a status whose schema is not the schema below | `<plugin>: surface program <name> must have a schema of type object and null whose state is one of idle, working, blocked` |

The schema of the status has `type` as a list that contains `object` and `null`, `required` as a list that contains `state`, and `properties.state` as `{type: "string", enum}` whose `enum` holds exactly the three values `idle`, `working` and `blocked`. The reader of each language checks the same conditions, and the shared cases of `docs/spec/cases/manifest-validation.json` state them.

## Value

The value of the status is `null` when the tab has no program state, or an object whose only member is `state`:

| `state` | Meaning |
| --- | --- |
| `idle` | The program rests at its own prompt and has no work or question pending |
| `working` | The program runs work |
| `blocked` | The program waits for the person, such as an approval or an answer |

A value that is neither `null` nor an object with only the member `state` and one of the three values is an error of the plugin. The tab then has no program state, and the workbench shows the text `<plugin> exposes <status> on tab <tab>: program value <value> is not null or an object with only the member state, one of idle, working, blocked`, where `<value>` is the JSON text of the value, in the error banner of the window through the error display path with the source `program <tab>`. The error is withdrawn when the status reports a valid value again or the tab leaves the window.

## Following

The workbench follows the status on the surface of each tab of the projects of its window by a watch of that surface, as it follows the activity statuses ([activity of a tab](activity.md#activity-of-a-tab)). A surface that has not registered the status has the value `null`. The workbench sends no request on a timer and derives the program state again at each value that a watch delivers. A tab whose plugin declares no `surface.program` has the value `null`, and the watch of a tab starts and ends with the tab.

## Status

`core.grid` reports `program` for each tab of a content card, in `cards[].tabs[]` ([groups](groups.md#model)): `{state}` with the state of the tab, or `null` when the tab has no program state. The member has the same meaning in both workbenches. A plugin reads the program state of the tabs of any plugin from `core.grid`, which is a core status, so a view needs no declaration to read it.
