# Declared UI

[한국어](declared-ui.ko.md)

Declared UI is a sidebar section whose every element is one of the vocabulary elements of this document. The plugin sends the value of a declared UI status, and the workbench draws it. This document defines the value, the elements, how each element binds to declared commands, how statuses map to drawing, what the receiver rejects, and the form of a sidebar section drawn from a declared UI status.

## Scope

- The vocabulary has four elements: `list`, `tree`, `button`, and `status-line`. Core declares no other element. A screen with text input, free DOM, a canvas, a document region, or an image region is a view. A tree that needs inline rename, drag and drop, or a context menu placed at a pointer is a view for the same reason. Core declares no element for those interactions.
- The workbench draws declared UI only in sidebar sections. Cards and other screens do not draw declared UI.
- The transport of a snapshot is in [plugin processes](../plans/plugin-processes.md) rule 2. The name, command, and DOM rules are in [exposure](exposure.md). The sidebar layout is in [plugins](plugins.md#sections).
- Accessibility: no accessibility claim is made for declared UI until the platform accessibility interface is recorded by a check. This document defines no ARIA role.
- Core never truncates a value. A plugin that has more elements than a limit cuts its own value and states the cut in a `status-line`. A value above a limit is rejected, never shortened. There is no lazy loading.

## Declared status

A status is a declared UI status when a sidebar section names it with the `status` form of its section declaration ([sidebar section form](#sidebar-section-form)). That is the only route. No schema marker identifies a declared UI status.

A declared UI status declares its `schema` in `exposes.status` ([exposure](exposure.md#entry-fields)) as the subset that the exposure specification accepts:

```json
{"type": "object", "properties": {"elements": {"type": "array"}}}
```

The subset cannot express the limits and the reference rules below. The receiver applies them to every declared UI snapshot and every non-null pull reply before drawing.

Each pushed declared UI snapshot carries the full value of the status, not a change. A pull reply carries the full value of the status too, but it is a reply, not a declared UI snapshot. Each accepted value replaces the whole drawn tree of the status.

## Root

A value is an object with the field `elements`, an array of 0 to 64 elements. Each element is an object with a `kind` field that selects one of the element kinds below. Each element has a `key` that is unique among the root elements. No other field is accepted at the root.

## Element kinds

The field `kind` names each element's kind. `kind` is accepted on every element and is not one of the listed fields. The kinds are `list`, `tree`, `button`, and `status-line`. Every object accepts only the fields that its kind lists. An unlisted field is rejected.

| Kind | Field | Type | Required | Limit and meaning |
| --- | --- | --- | --- | --- |
| `button` | `key` | string | yes | Key rules below. A button that runs `command`. |
| `button` | `label` | string | yes | Plain text, at most 500 code points. |
| `button` | `command` | string | yes | A command of the plugin ([binding](#binding)). |
| `button` | `params` | object | no | Parameters, see [Parameters](#parameters). |
| `button` | `icon` | string | no | A name of the core icon table (`packages/workbench/icons.js`). |
| `button` | `enabled` | boolean | no | `false` disables the button. Default `true`. |
| `list` | `key` | string | yes | Key rules below. |
| `list` | `empty` | string | yes | Plain text, at most 500 code points. Drawn in place of the rows when `items` is empty. Every list states its empty state, as [plugins](plugins.md#sections) requires for every list. |
| `list` | `items` | array | yes | At most 1000 items. Each item has the fields below. |
| `list` item | `key` | string | yes | Unique within the list. |
| `list` item | `label` | string | yes | Plain text, at most 500 code points. |
| `list` item | `command` | string | no | With `command`, the item is a button; without it, the item is a static row. |
| `list` item | `params`, `icon`, `enabled` | as `button` | no | Same rules as in `button`. |
| `list` item | `selected` | boolean | no | Draws the item as selected. Default `false`. No workbench state is kept for it. |
| `list` item | `detail` | string | no | Plain text, at most 500 code points, drawn after the label. |
| `tree` | `key` | string | yes | Key rules below. |
| `tree` | `empty` | string | yes | Plain text, at most 500 code points. Drawn in place of the nodes when `nodes` is empty. |
| `tree` | `nodes` | array | yes | Root nodes. At most 5000 nodes in the whole tree, at most 16 levels (root nodes are level 1). A tree is not drawn in a horizontal section ([sidebar section form](#sidebar-section-form)). |
| `tree` node | `key` | string | yes | Unique among its siblings. |
| `tree` node | `label` | string | yes | Plain text, at most 500 code points. |
| `tree` node | `command`, `params`, `icon`, `enabled` | as `button` | no | A node with `command` runs it when its label is pressed. |
| `tree` node | `expanded` | boolean | no | The plugin's value for a branch. Allowed only on a branch, so a leaf that carries it is rejected. Default `false`. [Status mapping](#status-mapping) gives its precedence. |
| `tree` node | `selected` | boolean | no | Draws the node as selected. Default `false`. The plugin's value applies in every accepted value. |
| `tree` node | `children` | array | no | Child nodes, with the same rules. A node whose `children` is present and not empty is a branch; any other node is a leaf. |
| `status-line` | `key` | string | yes | Key rules below. |
| `status-line` | `text` | string | yes | Plain text, at most 500 code points. Drawn as one line. |

Key rules: a key is a string of 1 to 128 code points from `A-Z`, `a-z`, `0-9`, `.`, `_`, `:`, and `-`. Keys are compared as exact strings.

Text rules: a text field is plain text. The workbench draws it as text content, never as markup. A text field that contains a control character (U+0000 to U+001F, U+007F, or U+0080 to U+009F) is rejected.

The `status-line` has no tone and no error value. An error reaches the user only through the display path that writes it to the application log ([AGENTS](../../AGENTS.md)), so a declared element cannot draw an error.

A `list` is a column of rows, with its `empty` text when it has none. A `tree` is an indented outline, with its `empty` text when it has none. A `button` is one button. A `status-line` is one line of text.

## Limits

Each limit is chosen by this document. Its reason is the work that the main page does for one declared UI snapshot: it parses, validates, and draws the value on the UI thread, and it keeps every drawn tree in the document. The limits in the table are the contract values.

| Limit | Value | Reason |
| --- | --- | --- |
| Serialized value | 1048576 bytes | The UTF-8 byte length of `JSON.stringify` of the value. It is parsed and validated on the UI thread for each declared UI snapshot. |
| Root elements | 64 | The main page's work per declared UI snapshot, as for the other limits. |
| List items | 1000 per list | Bounds the rows that one list draws per declared UI snapshot. |
| Tree nodes | 5000 per tree | Bounds the nodes that one tree draws per declared UI snapshot. |
| Tree levels | 16 | Bounds the indent of a tree inside a section. |
| Text field | 500 code points | Bounds the width of one line of text in a section. |
| Key | 128 code points | Bounds the identifier that the workbench keeps per element. |
| Parameter keys | 16 per object | Bounds the parameter record that each binding keeps. |
| Parameter key | 64 code points | Bounds the parameter record that each binding keeps. |
| Parameter string value | 1000 code points | Bounds the parameter record that each binding keeps. |

Each limit is checked on receipt. Every length of a key, a text field or a parameter counts code points. The serialized value counts UTF-8 bytes. A value that exceeds a limit is rejected, never truncated.

## Icons

The `icon` field takes a name of the core icon table. A name that the table does not contain is rejected. A plugin cannot supply icon markup.

## Parameters

`params` of a declared element is a JSON object with at most 16 keys. Each key is a string of at most 64 code points. Each value is a string of at most 1000 code points, a finite number, a boolean, or `null`. An array, an object, or any other value is rejected. The one array in a parameter is the `path` of `core.declared-ui.tree.expand`, which the workbench sets for the expand control. A plugin value cannot carry it.

## Binding

Every element that a user can operate is bound to a command. The binding follows the [user interface](exposure.md#user-interface) rules: the element points to the command with `data-command`, its parameters are in `data-params`, and it is connected with `bind(element, name, params, {event: "click"})` of the binder in `@soksak/plugin-api`.

Declared UI elements bind to these commands:

| Element | Command | Parameters |
| --- | --- | --- |
| `button` | its `command` field | its `params` field |
| `list` item with `command` | its `command` field | its `params` field |
| `tree` node with `command` | its `command` field | its `params` field |
| `tree` branch expand control | `core.declared-ui.tree.expand` | `{status, tree, path, expanded}` |
| sidebar section header | `core.sidebar.section.fold` | `{sidebar, section}` |

A command name in a declared UI value is `<plugin>.<name>`, where `<plugin>` is the plugin of the status. A name of core, or of another plugin, is rejected, because a plugin value names only commands of its own plugin. A name that is not declared is rejected when the declared UI snapshot is received, not when the user presses the element, because the binder refuses an undeclared name at mark time ([exposure](exposure.md#user-interface)).

`core.declared-ui.tree.expand` is declared in `packages/workbench/exposure.json` together with its handler. It is a set operation: running it again with the same arguments has the same effect as running it once. Its `expanded` argument is the state that the control requests, which is the opposite of the state the branch showed when the control was drawn. The command sets the kept state of the branch at `path` in the tree `tree` of `status`, and it does not reach the plugin. `path` is the array of node keys from the root node of the tree to the branch. A `path` that names no drawn branch, or a `status` or `tree` that is not drawn, fails the command with `tree <tree> path <path> is not drawn`. In that message, `<path>` is a JSON array of strings.

The request carries the `expanded` value that the control requests, which is the opposite of the kept state when the workbench draws it. Repeating the request sets the same state.

A disabled element (`enabled: false`) is rendered with the `disabled` attribute, so no click reaches its binding.
The elements that carry the native `button` element are the `button`, a list item with `command`, a tree node with `command`, and the expand control of a tree branch. A static list row and a status line carry no button.


Dom names. Every control that a declared UI value draws carries the dom name `core.sidebar.section.control` and the attribute `data-key` with the key of its root element. Controls of list items and tree nodes also carry `data-path`, a JSON array of the keys below the root element, and `data-role` (`label` or `expand`). A leaf without `command` carries neither attribute set. A branch without `command` carries only the attributes of its expand control. A non-interactive element, such as a static list row or a status line, carries neither. The section header carries `core.sidebar.section.header` ([plugins](plugins.md#sections)). These are the names that the sidebar already uses, so a declared section and a module section are audited the same way. A declared element does not carry a dom name of its own kind. Its kind is the kind of the value.

A request addresses a control of a declared section by a control address, `{sidebar, section, key, path?, role?}`. `sidebar` is the sidebar instance as `core.sidebars` reports it (`left`, `right`, or `cardId:side`), `section` is the section id, and `key` is the key of the root element that holds the control. `sidebar`, `section`, and `key` are strings. `path` is an array of strings, the keys below the root element, and `role` is `label` or `expand`. `path` and `role` are required for a control of a list item or a tree node and forbidden for a button. With these fields the address is unique: one sidebar instance draws a section once, keys are unique among their siblings, and the path plus the role name one control. The `core.sidebar.section.control` dom entry is declared `many` because several elements share that name. A value of another type is refused with -32602, as [exposure](exposure.md#errors) defines. An address that matches no control fails with the error code of [exposure](exposure.md#errors).

Native keyboard operation uses the native `button` element, so Enter and Space reach the command through the same binding. A declared UI element has no key handler of its own.

## Status mapping

A declared UI status is drawn through its declared UI snapshots, as follows:

- Each accepted declared UI snapshot replaces the tree of its status. Elements are matched by their path of keys to keep workbench state.
- The workbench keeps the expanded state of each branch, keyed by the status, the tree key, and the path of node keys from the root. The user sets a kept state only through `core.declared-ui.tree.expand`. An accepted value also sets a kept state by the rules below.
- In an accepted value, a branch whose `expanded` differs from its `expanded` in the baseline takes the plugin's value, and the kept state is replaced with it. A branch whose `expanded` did not change keeps its kept state. With a baseline, a branch is new when the baseline has no branch at its path. Without a baseline, a branch with no kept state is new. A new branch takes the plugin's value, and a branch that is not new keeps its kept state.
- A rejected value does not change the kept state. The baseline is the last accepted value since the last rejection or change of source. A rejection and a change of source remove the baseline. With no baseline, the kept state wins for every path that is a branch in the accepted value and holds kept state.
- A path that is a leaf in an accepted value loses its kept state, with or without a baseline. A branch that is new takes the plugin's `expanded` value, with or without a baseline.
- A pull reply with `value: null` means that the source has no value yet. The section stays cleared until the first push from the source. The `seq` of a pull reply is the seq of the source's last declared UI snapshot, or 0 when `value` is `null`. A pull reply whose `seq` is lower than the `seq` of the last accepted value from its source is discarded without validation; every other non-null pull reply follows the validation rules.
- `selected` has no kept state. No core command changes it, so the plugin's value applies in every accepted value.
- A kept state is removed when its path is absent from an accepted value. A plugin process restart is a process end, which removes the registrations of the old process as transition (d), followed by a registration from the new process, which chooses the source again as transition (a). That change of source is handled by transitions (b) and (c), so the kept state survives by path.
- The kept state is not saved with the space or the project. A reload of the main page resets it to the plugin's values.
- A declared status is served by a plugin process. A declared status source is the first of these that registered the status. First, the view of the active tab of the card that holds the sidebar, when that view's page registered the status: for a card sidebar, that card; for a fixed window sidebar, the focused content card and its active tab while a [plugin override](external-sidebars.md#override-context-and-rail-border) applies, as `core.sidebars` reports them, and this step is skipped when no plugin override applies. Second, the plugin host of the plugin, when the plugin has one. Otherwise the section is cleared until one of them registers the status. A registration by a state module does not serve a declared UI status. A declared UI status that only a state module registers has no source, and its section is cleared. A process registers a status when its page calls `page.exposure.register("status", name)`, and the registration belongs to that process. A declared status source is the pair of a process and its registration of the status. A change of source means a different pair. A re-registration by the same process for the same status is not a change.

The source changes by these rules:

- (a) The source is chosen again when the active tab of the sidebar's card, the focused card of a fixed window sidebar, or a registration changes, or the plugin override of the fixed window sidebar starts or stops applying.
- (b) On a change of source, the section is cleared until the first value from the new source is accepted. The kept state survives by path ([status mapping](#status-mapping)).
- (c) On a change of source, the workbench pulls the current value from the new source once. The workbench pulls only from the chosen source at the load of the main page, at a change of source and at a change of orientation, and at no other time, because a running view has no other way to send its last value to a new reader. A pulled value follows the same validation and rejection rules as a pushed declared UI snapshot.
- (d) A process end removes its registrations, and the source is chosen again as in (a).
- A declared UI snapshot from a pair that is not the chosen source is acknowledged, then discarded without validation. A pull reply from such a pair, or a pull reply whose `seq` is lower than the `seq` of the last accepted value from its source, is discarded without validation. Neither changes the tree, the baseline, the kept state nor the error display.
- Before the first accepted value, the section shows no tree. The rejection text is the only content it can show before that, and it shows it only after a rejected value.
- The status of a declared UI value is not a change feed: the plugin sends the whole value again when any element changes.
- When the main page loads, the workbench pulls the current value of each declared status once, from the source chosen for it.

## Sidebar section form

A sidebar section is declared in `plugin.json` ([plugins](plugins.md#sections)) with exactly one of two forms: `module` or `status`. A section declares `id`, `name`, one of the two, and optional `fill`. `fill: true` has the meaning that [plugins](plugins.md#sections) gives a module section: an open section shares the sidebar height that the other sections leave, and its body scrolls inside it.
A sidebar section with the `status` form is declared UI. A plugin that needs a view declares a card surface, and the sidebar holds a `button` whose command is a command of that plugin and opens it.

- A section with `module` is drawn by its module. The workbench imports the module and calls `mount(root, context)` in the section element.
- A section with `status` is drawn from the declared UI value of that status. The status must be a status of the same plugin that `exposes.status` declares.
- A section with both fields, or with neither, is rejected with `section <id> declares both module and status` or `section <id> declares neither module nor status`. A `status` that is not a status of the plugin is rejected with `section <id> status <name> is not a status of plugin <plugin>`. `exposes.status` means the entries of `exposes.status` in `plugin.json` only.
- One status backs at most one section. A second section that names the same status is rejected when the manifest is read, with `status <plugin>.<name> backs section <first> and section <second>`. The check runs on the manifest, so it does not depend on the value.

A declared section draws its root elements in order inside its body.

- In vertical orientation the elements stack from top to bottom.
- In horizontal orientation the elements sit left to right in one row that wraps at the section width. A `tree` in a horizontal section is rejected as a value, with `<pointer of the tree>: tree cannot be drawn in a horizontal section`. The check is a value check, because the orientation of the section is known when the value is accepted.
The orientation check runs again when the section changes orientation, on the accepted value. A value that fails it is rejected with the rows of [Rejection](#rejection), its tree is removed, and the section is cleared. A change of orientation also pulls the current value from the source once, as on a change of source, because a value discarded for the previous orientation may be valid for the new one, and the source is the only holder of that value.

A declared section keeps the header, the fold control, and the tab selection of a sidebar section without change. Its header is `core.sidebar.section.header`, and folding it runs `core.sidebar.section.fold`. A set of declared sections follows the set rules in [plugins](plugins.md#sections). A section of a plugin that is not loaded is not drawn, as for any section.

The `core.sidebars` status reports each section with these fields:

- `controls` is the number of elements with the dom name `core.sidebar.section.control` in the body of the section. For a declared section these are its interactive elements.
- `mounted` is true while the section draws an accepted value. It is false when the section is cleared. A section is cleared when it has no accepted value: before its first accepted value, after a rejected value, and on a change of source until the first value from the new source is accepted (the transition rule (b) in [status mapping](#status-mapping)).
- `error` is the text of the current rejection while the last value is rejected, and null otherwise.
- `text` is the text of the body.

## Rejection

The receiver validates a whole declared UI snapshot value before it draws anything. A value that breaks one rule of this document is rejected as a whole: no element of it is drawn, and the previous tree of the status is removed. The receiver keeps no previous tree on a rejection, because a kept tree would show a value that the plugin no longer sends as its current value. A rejection discards the value, so no kept value exists to draw again.

The receiver acknowledges the declared UI snapshot. The acknowledgement confirms receipt, not validity, so the plugin receives no rejection signal. The rejection is shown only in the section.

The display path is `showError(element, where, text)`. For a rejected value, `where` is `declared UI <owner>.<status>` and `text` is `<pointer>: <reason>`. The section body is the element that `showError` shows, so the text in the section is the display of the rejection. The application log line that the same call writes is the record: `error: declared UI <owner>.<status>: <pointer>: <reason>`. The section does not show the error in a second display.

`showError` writes the log line once for the same `where` and the same `text`. It keeps the shown text, so a repeated rejection with the same text shows the same text and writes nothing more. A rejection with a different text writes its own line. The next accepted value of the status calls `hideError` for its `where`, which withdraws the display, so the same text is written again if it recurs after that.
A change of source, a process end, and a surface close call `hideError` for the status and set `error` to null.

Every rejection text has the form `<pointer>: <reason>`. The pointer of each row of the table is the value that breaks the row, as its Pointer column states. A count or size limit points to the array, object, or string that exceeds it. A field-presence row (`unknown field`, `missing`, `requires command`) points to the object that holds the field. A field-value row points to the field. A duplicate key points to the second key. `/` is the root and the whole serialized value. `<field>` is the JSON field name. Pointers are JSON Pointers (RFC 6901). `<owner>` is the plugin id of the status. The `<field>`, `<key>`, `<value>`, `<name>`, and `<owner>` slots of a reason are written as JSON strings: the value is escaped first, with control characters written as JSON escapes, and then wrapped in double quotes. The quotes count toward the limit of 128 code points. A quoted text longer than 128 code points keeps its opening quote and its first 125 code points, then the marker `…` (U+2026) and the closing quote, so the cut text has 128 code points. The `<type>` slot is a fixed type name of this document and is not quoted.
Field rows of an element use the field list of its kind, which its `kind` value selects, so the `missing kind`, `kind must be a string`, and `unknown kind` rows come before the rows that depend on the kind. When a value breaks more than one row, the first row in table order that any part of the value breaks applies. Among several occurrences of that row, the first in document order is reported. The naming row comes before the ownership row, so a name with no owner is reported as unnamed.

| Condition | Reason | Pointer |
| --- | --- | --- |
| The root is not an object | `root must be an object` | `/` |
| `elements` is not an array | `elements must be an array` | `/elements` |
| The serialized value is larger than 1048576 bytes | `exceeds 1048576 bytes` | `/` |
| More than 64 root elements | `exceeds 64 elements` | `/elements` |
| An element that is not an object | `element must be an object` | that element |
| A list item that is not an object | `list item must be an object` | that list item |
| A tree node that is not an object | `tree node must be an object` | that tree node |
| An element with no `kind` field | `missing kind` | the element |
| A `kind` that is not a string | `kind must be a string` | the element |
| A `kind` value that is not in the table | `unknown kind <value>` | the `kind` value |
| More than 1000 items in a list | `exceeds 1000 items` | `/elements/<i>/items` |
| More than 5000 nodes in a tree | `exceeds 5000 nodes` | `/elements/<i>/nodes` |
| A tree node deeper than 16 levels | `exceeds 16 levels` | the node |
| A text field longer than 500 code points | `exceeds 500 code points` | the text field |
| A key longer than 128 code points | `exceeds 128 code points` | the key |
| A key that does not match the key rules | `key must be 1 to 128 code points of A-Z, a-z, 0-9, ., _, : or -` | the key |
| A `params` object with more than 16 keys | `exceeds 16 keys` | the `params` object |
| A parameter key longer than 64 code points | `exceeds 64 code points` | the parameter key |
| A parameter string value longer than 1000 code points | `exceeds 1000 code points` | the parameter value |
| A parameter value that is not a string, a finite number, a boolean, or `null` | `params values must be string, finite number, boolean or null` | the parameter value |
| A field that the object does not list: a root, an element, a list item, or a tree node | `unknown field <field>` | the object |
| A required field is missing | `missing <field>` | the object |
| A `params` or `enabled` field in a list item or a tree node with no `command` field | `<field> requires command` | the object |
| A present field has the wrong type; an absent field is `missing <field>` | `<field> must be <type>` | the field |
| A text field contains a control character | `<field> contains a control character` | the field |
| Two keys are equal among their siblings, or among the items of a list | `duplicate key <key>` | the second key |
| A `command` name with no owner, that is, with no `.` | `command <name> must be named <owner>.<name>` | the `command` field |
| A `command` name whose owner is core or another plugin | `command <name> is not a command of plugin <owner>` | the `command` field |
| A `command` name that is not declared | `undeclared command <name>` | the `command` field |
| An icon name that is not in the core icon table | `unknown icon <name>` | the `icon` field |
| `expanded` on a leaf node | `expanded is allowed only on a branch` | the `expanded` field |
| A `tree` in a horizontal section | `tree cannot be drawn in a horizontal section` | the tree |

Rejections that concern a manifest, the section form and the one-section rule, are reported when the manifest is read, with the reasons in [sidebar section form](#sidebar-section-form), and not with a value pointer.

## Terms

The terms are in the [term list](terms.md): declared UI, declared UI snapshot, declared UI value, declared element, declared status line, declared UI schema, declared UI status, branch, and declared section.
