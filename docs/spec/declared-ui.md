# Declared UI

[한국어](declared-ui.ko.md)

Declared UI is a screen whose every element is one of the vocabulary elements of this document. The plugin sends the value of a declared UI status, and the workbench draws it. This document defines the value, its elements, how each element binds to declared commands, how statuses map to drawing, what the receiver rejects, and the form of a sidebar section that is drawn from a declared UI status. The transport of a snapshot is in [plugin processes](../plans/plugin-processes.md) rule 2. The name, command, and DOM rules are in [exposure](exposure.md). A screen with text input, free DOM, a canvas, or a document region is a view, not declared UI ([plugin processes](../plans/plugin-processes.md) layer rules).

This document is the contract for the element drawing and the sidebar section drawing. [Feature status](../features.md) lists the parts that are not yet implemented.

## Declared status

A plugin declares the status that carries a declared UI value in `plugin.json` under `exposes.status`. Its `schema` is the subset that [exposure](exposure.md#entry-fields) accepts:

```json
{"type": "object", "properties": {"elements": {"type": "array"}}}
```

The subset cannot express the limits and the reference rules below. The receiver applies them to every snapshot before drawing, and a value that breaks them is rejected as specified in [Rejection](#rejection).

Each snapshot carries the full value of the status, not a change. Each accepted value replaces the whole drawn tree of the status.

## Root

A value is an object with the field `elements`, an array of 0 to 64 elements. Each element is an object with a `kind` field that selects one of the element kinds below. Each element has a `key` that is unique among the root elements. No other field is accepted at the root.

## Element kinds

The kinds are `list`, `tree`, `menu`, `command`, and `status-line`. Every object accepts only the fields that its kind lists. An unlisted field is rejected.

| Kind | Field | Type | Required | Limit and meaning |
| --- | --- | --- | --- | --- |
| `command` | `key` | string | yes | Key rules below. A button that runs `command`. |
| `command` | `label` | string | yes | Plain text, at most 500 characters. |
| `command` | `command` | string | yes | A declared command name ([binding](#binding)). |
| `command` | `params` | object | no | Parameters, see [Parameters](#parameters). |
| `command` | `icon` | string | no | A name of the core icon table (`packages/workbench/icons.js`). |
| `command` | `enabled` | boolean | no | `false` disables the button. Default `true`. |
| `list` | `key` | string | yes | Key rules below. |
| `list` | `label` | string | no | Plain text, at most 500 characters. |
| `list` | `items` | array | yes | At most 1000 items. Each item has the fields below. |
| `list` item | `key` | string | yes | Unique within the list. |
| `list` item | `label` | string | yes | Plain text, at most 500 characters. |
| `list` item | `command` | string | no | With `command`, the item is a button; without it, the item is a static row. |
| `list` item | `params`, `icon`, `enabled` | as `command` | no | Same rules as in `command`. |
| `list` item | `selected` | boolean | no | Draws the item as selected. Default `false`. |
| `list` item | `detail` | string | no | Plain text, at most 500 characters, drawn after the label. |
| `tree` | `key` | string | yes | Key rules below. |
| `tree` | `label` | string | no | Plain text, at most 500 characters. |
| `tree` | `nodes` | array | yes | Root nodes. At most 5000 nodes in the whole tree, at most 16 levels (root nodes are level 1). |
| `tree` node | `key` | string | yes | Unique among its siblings. |
| `tree` node | `label` | string | yes | Plain text, at most 500 characters. |
| `tree` node | `command`, `params`, `icon`, `enabled` | as `command` | no | A node with `command` runs it when its label is pressed. |
| `tree` node | `expanded` | boolean | no | The state of a branch before the workbench has a state for it. Default `false`. |
| `tree` node | `children` | array | no | Child nodes, with the same rules. A node with `children` is a branch. |
| `menu` | `key` | string | yes | Key rules below. |
| `menu` | `label` | string | yes | Plain text, at most 500 characters. Names the button that opens the menu. |
| `menu` | `items` | array | yes | At most 64 items. Each item has `key` (unique within the menu), `label`, `command` (required), `params`, `icon`, and `enabled`, with the same rules as `command`. |
| `status-line` | `key` | string | yes | Key rules below. |
| `status-line` | `text` | string | yes | Plain text, at most 500 characters. |
| `status-line` | `tone` | string | no | `neutral` (default) or `busy`. |

Key rules: a key is a string of 1 to 128 characters from `A-Z`, `a-z`, `0-9`, `.`, `_`, `:`, and `-`. Keys are compared as exact strings.

Text rules: a text field is plain text. The workbench draws it as text content, never as markup. A text field that contains a control character (U+0000 to U+001F or U+007F) is rejected.

The `status-line` tone has no `error` value. An error reaches the user only through the display path that writes it to the application log ([AGENTS](../../AGENTS.md)), so a declared element cannot draw an error.

A `list` is a single column of rows. A `tree` is an indented outline. A `menu` is a button that opens a list of commands. A `status-line` is a single line of text. A `command` is a single button.

## Icons

The `icon` field takes a name of the core icon table. A name that the table does not contain is rejected with `unknown icon <name>`. A plugin cannot supply icon markup.

## Parameters

`params` is a JSON object with at most 16 keys. Each key is a string of at most 64 characters. Each value is a string of at most 1000 characters, a finite number, a boolean, or `null`. An array, an object, or any other value is rejected.

## Binding

Every element that a user can operate is bound to a declared command. The binding follows the [user interface](exposure.md#user-interface) rules: the element points to the command with `data-command`, its parameters are in `data-params`, and it is connected with `bind(element, name, params, {event: "click"})` of the binder in `@soksak/plugin-api`.

Declared UI elements bind to these commands:

| Element | Command | Parameters |
| --- | --- | --- |
| `command` | its `command` field | its `params` field |
| `list` item with `command` | its `command` field | its `params` field |
| `tree` node with `command` | its `command` field | its `params` field |
| `tree` branch expand control | `core.declared-ui.tree.toggle` | `{status, tree, node}` |
| `menu` button | `core.declared-ui.menu.toggle` | `{status, menu}` |
| `menu` item | its `command` field | its `params` field |
| sidebar section header | `core.sidebar.section.fold` | `{sidebar, section}` |

A command name in a declared UI value is `<owner>.<name>`. The owner is the plugin of the status or `core`. A plugin can name its own commands and core commands only. A name that is not declared is rejected when the snapshot is received, not when the user presses the element, because the binder refuses an undeclared name at mark time ([exposure](exposure.md#user-interface)).

The core commands `core.declared-ui.tree.toggle` and `core.declared-ui.menu.toggle` are declared in `packages/workbench/exposure.json`. A fold or an open state is a document operation, so it runs a declared command like every other operation.

A disabled element (`enabled: false`) is rendered with the `disabled` attribute, so no click reaches its binding.

Dom names. Each interactive element carries the dom name of its kind through `data-expose`. The names are core declarations, with the `many` flag, in `packages/workbench/exposure.json`:

| Element | Dom name |
| --- | --- |
| `command` | `core.declared-ui.command` |
| `list` item with `command` | `core.declared-ui.list-item` |
| `tree` node | `core.declared-ui.tree-node` |
| `tree` branch expand control | `core.declared-ui.tree-toggle` |
| `menu` button | `core.declared-ui.menu` |
| `menu` item | `core.declared-ui.menu-item` |
| sidebar section header | `core.declared-ui.section-header` |

Each element that a dom name names carries `data-key` with its `key`, so that an external request addresses it by key.

Native keyboard operation uses the native `button` element, so Enter and Space reach the command through the same binding. A declared UI element has no key handler of its own.

## Status mapping

A declared UI status is drawn through its snapshots, as follows:

- Each accepted snapshot replaces the tree of its status. Elements are matched by key only to keep workbench state.
- The workbench keeps the state of a tree branch (expanded or collapsed) and of a menu (open or closed) for each status and element key. A state is kept while a snapshot contains the key, and it is removed when the key is absent from an accepted snapshot.
- The `expanded` and `selected` fields are the value that the plugin sends. A branch whose key has a kept state keeps the kept state, and `expanded` applies only to a branch with no kept state.
- A section reads its status through the status follow of the plugin context ([plugins](plugins.md#sections)). Until the first snapshot is accepted, the section body is empty.
- The status of a declared UI value is not a change feed: the plugin sends the whole value again when any element changes.

## Rejection

The receiver validates a whole snapshot value before it draws anything. A value that breaks one rule of this document is rejected as a whole: no element of it is drawn, and the previous tree of the status is removed. The receiver still acknowledges the snapshot, because the acknowledgement confirms receipt, not validity.

A rejected value is reported through the display path, which writes the application log line `error: declared UI <owner>.<status>: <JSON pointer>: <reason>`, and the sidebar section shows the same text in its error state. The section shows the error until the next accepted value.

The receiver rejects with these reasons:

| Condition | Reason |
| --- | --- |
| The root is not an object, or `elements` is not an array | `elements must be an array` |
| More than 64 root elements, 1000 list items, 64 menu items, 5000 tree nodes, or 16 tree levels | `<field> exceeds <limit>` |
| A field that the kind does not list | `unknown field <name>` |
| A required field is missing | `missing <field>` |
| A `kind` value that is not in the table | `unknown kind <value>` |
| A field has the wrong type | `<field> must be <type>` |
| A text field exceeds its limit | `<field> exceeds 500 characters` |
| A text field contains a control character | `<field> contains a control character` |
| A key does not match the key rules | `key must be 1 to 128 characters of A-Z, a-z, 0-9, ., _, : or -` |
| Two keys are equal among their siblings, or among the items of a list or menu | `duplicate key <key>` |
| `kind` is `status-line` with a tone other than `neutral` or `busy` | `tone must be neutral or busy` |
| A command name is not `<owner>.<name>` with the plugin or `core` as owner | `command <name> must be named <owner>.<name>` |
| A command name is not declared | `undeclared command <name>` |
| `params` is not an object of the allowed values, or has more than 16 keys | `params must be an object of at most 16 scalar values` |
| An icon name is not in the core icon table | `unknown icon <name>` |
| The serialized value is larger than 1048576 bytes | `value exceeds 1048576 bytes` |

The JSON pointer names the failing field, for example `/elements/2/items/7/key`.

## Sidebar section form

A sidebar section is declared in `plugin.json` ([plugins](plugins.md#sections)) with a `module` or with a `status`. Exactly one of the two is accepted.

- A section with `module` is drawn by its module, as today. The workbench imports the module and calls `mount(root, context)` in the section element.
- A section with `status` is drawn from the declared UI value of that status. The status must be a status of the same plugin that `exposes.status` declares with the declared UI schema. The section has no module, no `mount` call, and no `context.status` or `context.bind`; its elements are bound by the rules of this document.
- A section with both fields, or with neither, is rejected with `section <id> declares both module and status` or `section <id> declares neither module nor status`. A `status` that is not a status of the plugin is rejected with `section <id> status <name> is not a status of plugin <plugin>`.

A declared section draws its root elements in order inside its body, in the layout that the sidebar uses for its orientation. In vertical orientation the elements stack from top to bottom. In horizontal orientation the elements sit left to right in one row that wraps at the section width.

A declared section keeps the header, the fold control, and the tab selection of a sidebar section without change. Its header is a `core.declared-ui.section-header` element, and folding it runs `core.sidebar.section.fold`. A set of declared sections follows the set rules in [plugins](plugins.md#sections).

A section of a plugin that is not loaded is not drawn, as for any section.

## What sections draw today

A section today is a JavaScript module. The workbench mounts it in the section element with a context of `card`, `surface`, `orientation`, the core `icon` function, `status(name, fn)` for the statuses of the plugin, and `bind(el, name, params, options)` for its commands. The module draws its own DOM, so the workbench checks neither its elements nor its names. A declared section replaces that module with the vocabulary above, which the workbench validates and draws.

## Limits

| Limit | Value |
| --- | --- |
| Serialized value | 1048576 bytes |
| Root elements | 64 |
| List items | 1000 per list |
| Tree nodes | 5000 per tree |
| Tree levels | 16 |
| Menu items | 64 per menu |
| Text field | 500 characters |
| Key | 128 characters |
| Parameters | 16 keys per object, 64 characters per key, 1000 characters per string value |

Each limit is checked on receipt. A value that exceeds a limit is rejected, never truncated.

## Terms

The terms are in the [term list](terms.md): declared UI, declared UI snapshot, declared element, declared status line, and declared UI schema.
