# Declared UI

[한국어](declared-ui.ko.md)

Declared UI is a sidebar section whose every element is one of the vocabulary elements of this document. The plugin sends the value of a declared UI status, and the workbench draws it. This document defines the value, the elements, how each element binds to declared commands, how statuses map to drawing, what the receiver rejects, and the form of a sidebar section drawn from a declared UI status.

## Scope

- The vocabulary has four elements: `list`, `tree`, `command`, and `status-line`. Core declares no other element. A screen with text input, free DOM, a canvas, a document region, or an image region is a view ([plugin processes](../plans/plugin-processes.md) layer rules). A tree that needs inline rename, drag and drop, or a context menu placed at a pointer is a view for the same reason. Core declares no element for those interactions.
- The workbench draws declared UI only in sidebar sections in this version. Cards and other screens do not draw declared UI.
- The plugin's repository declares each of its surfaces as declared UI or as a view. Core does not classify a plugin's surface.
- The transport of a snapshot is in [plugin processes](../plans/plugin-processes.md) rule 2. The name, command, and DOM rules are in [exposure](exposure.md). The sidebar layout is in [plugins](plugins.md#sections).
- Accessibility: no accessibility claim is made for declared UI until F212.12 records the platform interface ([plugin processes](../plans/plugin-processes.md) rule 8). This document defines no ARIA role.
- Core never truncates a value. A plugin that has more elements than a limit cuts its own value and states the cut in a `status-line`. A value above a limit is rejected, never shortened. This version has no lazy loading.

## Declared status

A plugin declares the status that carries a declared UI value in `plugin.json` under `exposes.status`. Its `schema` is the subset that [exposure](exposure.md#entry-fields) accepts:

```json
{"type": "object", "properties": {"elements": {"type": "array"}}}
```

The subset cannot express the limits and the reference rules below. The receiver applies them to every snapshot before drawing.

Each snapshot carries the full value of the status, not a change. Each accepted value replaces the whole drawn tree of the status.

## Root

A value is an object with the field `elements`, an array of 0 to 64 elements. Each element is an object with a `kind` field that selects one of the element kinds below. Each element has a `key` that is unique among the root elements. No other field is accepted at the root.

## Element kinds

The kinds are `list`, `tree`, `command`, and `status-line`. Every object accepts only the fields that its kind lists. An unlisted field is rejected.

| Kind | Field | Type | Required | Limit and meaning |
| --- | --- | --- | --- | --- |
| `command` | `key` | string | yes | Key rules below. A button that runs `command`. |
| `command` | `label` | string | yes | Plain text, at most 500 characters. |
| `command` | `command` | string | yes | A declared command name ([binding](#binding)). |
| `command` | `params` | object | no | Parameters, see [Parameters](#parameters). |
| `command` | `icon` | string | no | A name of the core icon table (`packages/workbench/icons.js`). |
| `command` | `enabled` | boolean | no | `false` disables the button. Default `true`. |
| `list` | `key` | string | yes | Key rules below. |
| `list` | `empty` | string | yes | Plain text, at most 500 characters. Drawn in place of the rows when `items` is empty. Every list states its empty state, as [plugins](plugins.md#sections) requires for every list. |
| `list` | `items` | array | yes | At most 1000 items. Each item has the fields below. |
| `list` item | `key` | string | yes | Unique within the list. |
| `list` item | `label` | string | yes | Plain text, at most 500 characters. |
| `list` item | `command` | string | no | With `command`, the item is a button; without it, the item is a static row. |
| `list` item | `params`, `icon`, `enabled` | as `command` | no | Same rules as in `command`. |
| `list` item | `selected` | boolean | no | Draws the item as selected. Default `false`. No workbench state is kept for it. |
| `list` item | `detail` | string | no | Plain text, at most 500 characters, drawn after the label. |
| `tree` | `key` | string | yes | Key rules below. |
| `tree` | `nodes` | array | yes | Root nodes. At most 5000 nodes in the whole tree, at most 16 levels (root nodes are level 1). A tree is not drawn in a horizontal section ([sidebar section form](#sidebar-section-form)). |
| `tree` node | `key` | string | yes | Unique among its siblings. |
| `tree` node | `label` | string | yes | Plain text, at most 500 characters. |
| `tree` node | `command`, `params`, `icon`, `enabled` | as `command` | no | A node with `command` runs it when its label is pressed. |
| `tree` node | `expanded` | boolean | no | The plugin's value for a branch. Default `false`. [Status mapping](#status-mapping) gives its precedence. |
| `tree` node | `selected` | boolean | no | Draws the node as selected. Default `false`. The plugin's value applies in every accepted value. |
| `tree` node | `children` | array | no | Child nodes, with the same rules. A node with `children` is a branch. |
| `status-line` | `key` | string | yes | Key rules below. |
| `status-line` | `text` | string | yes | Plain text, at most 500 characters. Drawn as one line. |

Key rules: a key is a string of 1 to 128 characters from `A-Z`, `a-z`, `0-9`, `.`, `_`, `:`, and `-`. Keys are compared as exact strings.

Text rules: a text field is plain text. The workbench draws it as text content, never as markup. A text field that contains a control character (U+0000 to U+001F or U+007F) is rejected.

The `status-line` has no tone and no error value. An error reaches the user only through the display path that writes it to the application log ([AGENTS](../../AGENTS.md)), so a declared element cannot draw an error.

A `list` is a column of rows, with its `empty` text when it has none. A `tree` is an indented outline. A `command` is one button. A `status-line` is one line of text.

## Limits

Each limit is chosen by this document. Its reason is the work that the main page does for one snapshot: it parses, validates, and draws the value on the UI thread, and it keeps every drawn tree in the document. The limits for list items and tree nodes are revised from a measured draw time of 5000 tree nodes and 1000 list items in the workbench before they are final.

| Limit | Value | Reason |
| --- | --- | --- |
| Serialized value | 1048576 bytes | The whole value is parsed and validated on the UI thread for each snapshot. |
| Root elements | 64 | One section body holds this many separate blocks. |
| List items | 1000 per list | Bounds the rows that one list draws per snapshot. Revised from the draw-time measurement. |
| Tree nodes | 5000 per tree | Bounds the nodes that one tree draws per snapshot. Revised from the draw-time measurement. |
| Tree levels | 16 | Bounds the indent of a tree inside a section. |
| Text field | 500 characters | Bounds the width of one line of text in a section. |
| Key | 128 characters | Bounds the identifier that the workbench keeps per element. |
| Parameters | 16 keys per object, 64 characters per key, 1000 characters per string value | Bounds the parameter record that each binding keeps. |

Each limit is checked on receipt. A value that exceeds a limit is rejected, never truncated.

## Icons

The `icon` field takes a name of the core icon table. A name that the table does not contain is rejected with `unknown icon <name>`. A plugin cannot supply icon markup.

## Parameters

`params` of a declared element is a JSON object with at most 16 keys. Each key is a string of at most 64 characters. Each value is a string of at most 1000 characters, a finite number, a boolean, or `null`. An array, an object, or any other value is rejected. The one array in a parameter is the `path` of `core.declared-ui.tree.expand`, which the workbench sets for the control and a plugin value cannot carry.

## Binding

Every element that a user can operate is bound to a declared command. The binding follows the [user interface](exposure.md#user-interface) rules: the element points to the command with `data-command`, its parameters are in `data-params`, and it is connected with `bind(element, name, params, {event: "click"})` of the binder in `@soksak/plugin-api`.

Declared UI elements bind to these commands:

| Element | Command | Parameters |
| --- | --- | --- |
| `command` | its `command` field | its `params` field |
| `list` item with `command` | its `command` field | its `params` field |
| `tree` node with `command` | its `command` field | its `params` field |
| `tree` branch expand control | `core.declared-ui.tree.expand` | `{status, tree, path, expanded}` |
| sidebar section header | `core.sidebar.section.fold` | `{sidebar, section}` |

A command name in a declared UI value is `<owner>.<name>`. The owner is the plugin of the status or `core`. A plugin can name its own commands and core commands only. A name that is not declared is rejected when the snapshot is received, not when the user presses the element, because the binder refuses an undeclared name at mark time ([exposure](exposure.md#user-interface)).

`core.declared-ui.tree.expand` is declared in `packages/workbench/exposure.json`. It is a set operation: running it again with the same arguments has the same effect as running it once. Its `expanded` argument is the state that the control requests, which is the opposite of the state the branch showed when the control was drawn. The command sets the kept state of the branch at `path` in the tree `tree` of `status`, and it does not reach the plugin. `path` is the array of node keys from a root node to the branch. A `path` that names no drawn branch, or a `status` or `tree` that is not drawn, fails the command with `tree <tree> path <path> is not drawn`.

A disabled element (`enabled: false`) is rendered with the `disabled` attribute, so no click reaches its binding.

Dom names. Every interactive element that a declared UI value draws carries the dom name `core.sidebar.section.control` and the attribute `data-key` with its `key`. The section header carries `core.sidebar.section.header` ([plugins](plugins.md#sections)). These are the names that the sidebar already uses, so a declared section and a module section are audited the same way. A declared element does not carry a dom name of its own kind. Its kind is the kind of the value.

Native keyboard operation uses the native `button` element, so Enter and Space reach the command through the same binding. A declared UI element has no key handler of its own.

## Status mapping

A declared UI status is drawn through its snapshots, as follows:

- Each accepted snapshot replaces the tree of its status. Elements are matched by their path of keys to keep workbench state.
- The workbench keeps the expanded state of each branch, keyed by the status, the tree key, and the path of node keys from the root. A kept state is set by `core.declared-ui.tree.expand` only.
- In an accepted value, a branch whose `expanded` differs from its `expanded` in the previous accepted value, or that is new, takes the plugin's value, and the kept state is replaced with it. A branch whose `expanded` did not change keeps its kept state. A new branch with no kept state takes the plugin's value.
- `selected` has no kept state. No core command changes it, so the plugin's value applies in every accepted value.
- A kept state is removed when its path is absent from an accepted value, and when the plugin process restarts. The workbench discards the kept state on a plugin restart, as [plugin processes](../plans/plugin-processes.md) rule 2 does for the snapshot of the previous process.
- The kept state is not saved with the space or the project. A reload of the main page resets it to the plugin's values.
- A section reads its status through the status follow of the plugin context ([plugins](plugins.md#sections)). Until the first snapshot is accepted, the section body is empty.
- The status of a declared UI value is not a change feed: the plugin sends the whole value again when any element changes.

## Sidebar section form

A sidebar section is declared in `plugin.json` ([plugins](plugins.md#sections)) with a `module` or with a `status`. Exactly one of the two is accepted. A declared section has the fields `id`, `name`, `status`, and optional `fill`. `fill: true` has the meaning that [plugins](plugins.md#sections) gives a module section: an open section shares the sidebar height that the other sections leave, and its body scrolls inside it.

- A section with `module` is drawn by its module, as today. The workbench imports the module and calls `mount(root, context)` in the section element.
- A section with `status` is drawn from the declared UI value of that status. The status must be a status of the same plugin that `exposes.status` declares with the declared UI schema. The section has no module, no `mount` call, and no `context.status` or `context.bind`.
- A section with both fields, or with neither, is rejected with `section <id> declares both module and status` or `section <id> declares neither module nor status`. A `status` that is not a status of the plugin is rejected with `section <id> status <name> is not a status of plugin <plugin>`.

A declared section draws its root elements in order inside its body.

- In vertical orientation the elements stack from top to bottom.
- In horizontal orientation the elements sit left to right in one row that wraps at the section width. A `tree` in a horizontal section is rejected as a whole, with `tree <key> cannot be drawn in a horizontal section`, because a tree's indent has no horizontal form in a row.

A declared section keeps the header, the fold control, and the tab selection of a sidebar section without change. Its header is `core.sidebar.section.header`, and folding it runs `core.sidebar.section.fold`. A set of declared sections follows the set rules in [plugins](plugins.md#sections). A section of a plugin that is not loaded is not drawn, as for any section.

The `core.sidebars` status counts, for each section, the elements with the dom name `core.sidebar.section.control` in its body, which are the interactive elements of a declared value, and the section header through its own element. Its `mounted` field is true from the first accepted value that the section draws until the section is cleared, and false before that. Its `error` field is the text of the current rejection, or null when the last value was accepted. Its `text` field is the text of the body.

## Rejection

The receiver validates a whole snapshot value before it draws anything. A value that breaks one rule of this document is rejected as a whole: no element of it is drawn, and the previous tree of the status is removed. The receiver keeps no previous tree on a rejection, because a kept tree would show a value that the plugin no longer sends as its current value.

The receiver acknowledges the snapshot. The acknowledgement confirms receipt, not validity, so the plugin receives no rejection signal. The rejection is shown only in the section.

The display path is `showError(element, where, text)`. For a rejected value, `where` is `declared UI <owner>.<status>` and `text` is `<JSON pointer>: <reason>`. The section body is the element that `showError` shows, so the text in the section is the display of the rejection. The application log line that the same call writes is the record: `error: declared UI <owner>.<status>: <JSON pointer>: <reason>`. The section does not show the error in a second display.

`showError` writes the log line once for the same `where` and the same `text`. It keeps the shown text, so a repeated rejection with the same text shows the same text and writes nothing more. A rejection with a different text writes its own line. The next accepted value of the status calls `hideError` for its `where`, which withdraws the display, so the same text is written again if it recurs after that.

The receiver rejects with these reasons:

| Condition | Reason |
| --- | --- |
| The root is not an object, or `elements` is not an array | `elements must be an array` |
| More than 64 root elements, 1000 list items, 5000 tree nodes, or 16 tree levels | `<field> exceeds <limit>` |
| A field that the kind does not list | `unknown field <name>` |
| A required field is missing | `missing <field>` |
| A `kind` value that is not in the table | `unknown kind <value>` |
| A field has the wrong type | `<field> must be <type>` |
| A text field exceeds its limit | `<field> exceeds 500 characters` |
| A text field contains a control character | `<field> contains a control character` |
| A key does not match the key rules | `key must be 1 to 128 characters of A-Z, a-z, 0-9, ., _, : or -` |
| Two keys are equal among their siblings, or among the items of a list | `duplicate key <key>` |
| A command name is not `<owner>.<name>` with the plugin or `core` as owner | `command <name> must be named <owner>.<name>` |
| A command name is not declared | `undeclared command <name>` |
| `params` is not an object of the allowed values, or has more than 16 keys | `params must be an object of at most 16 scalar values` |
| An icon name is not in the core icon table | `unknown icon <name>` |
| A `tree` in a horizontal section | `tree <key> cannot be drawn in a horizontal section` |
| The serialized value is larger than 1048576 bytes | `value exceeds 1048576 bytes` |

The JSON pointer names the failing field, for example `/elements/2/items/7/key`.

## What sections draw today

A section today is a JavaScript module. The workbench mounts it in the section element with a context of `card`, `surface`, `orientation`, the core `icon` function, `status(name, fn)` for the statuses of the plugin, and `bind(el, name, params, options)` for its commands. The module draws its own DOM, so the workbench checks neither its elements nor its names. A declared section replaces that module with the vocabulary above, which the workbench validates and draws.

## Terms

The terms are in the [term list](terms.md): declared UI, declared UI snapshot, declared element, declared status line, and declared UI schema.
