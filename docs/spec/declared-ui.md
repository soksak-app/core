# Declared UI

[한국어](declared-ui.ko.md)

Declared UI is a sidebar section whose every element is one of the vocabulary elements of this document. The plugin sends the value of a declared UI status, and the workbench draws it. This document defines the value, the elements, how each element binds to declared commands, how statuses map to drawing, what the receiver rejects, and the form of a sidebar section drawn from a declared UI status.

## Scope

- The vocabulary has four elements: `list`, `tree`, `button`, and `status-line`. Core declares no other element. A screen with text input, free DOM, a canvas, a document region, or an image region is a view. A tree that needs inline rename, drag and drop, or a context menu placed at a pointer is a view for the same reason. Core declares no element for those interactions.
- The workbench draws declared UI only in sidebar sections. Cards and other screens do not draw declared UI.
- The transport of a snapshot is in [plugin processes](plugin-processes.md) rule 2. The name, command, and DOM rules are in [exposure](exposure.md). The sidebar layout is in [plugins](plugins.md#sections).
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

A value is an object with the field `elements`, an array of 0 to 64 elements. Each element is an object with a `kind` field that selects one of the element kinds below. Each element has a `key` that is unique among the root elements. Root elements are drawn in array order; a tree section may therefore put button elements before its tree. No other field is accepted at the root.

## Element kinds

The field `kind` names each element's kind. `kind` is accepted on every root element and is not one of the listed fields. A list item and a tree node have no `kind`. The kinds are `list`, `tree`, `button`, and `status-line`. Every object accepts only the fields that its kind lists. An unlisted field is rejected.

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
| `tree` | `nodes` | array | yes | Root nodes. At most 5000 nodes in the whole tree, at most 16 levels (root nodes are level 1). |
| `tree` node | `key` | string | yes | Unique among its siblings. |
| `tree` node | `label` | string | yes | Plain text, at most 500 code points. |
| `tree` node | `command`, `params`, `icon`, `enabled` | as `button` | no | A single click on a node with `command` runs it. If `open` is present, the second click of a double press runs `open` instead of `command`. |
| `tree` node | `open` | string | no | A command of the plugin. Enter keydown on this node runs `open` and prevents the native click; a click with `event.detail === 2` runs `open`. The node's `params` apply to both `command` and `open`. |
| `tree` node | `branch` | boolean | no | `true` declares a branch even before it has child nodes. A non-boolean value is rejected. |
| `tree` node | `expanded` | boolean | no | The plugin's value for a branch. Allowed only on a branch, so a leaf that carries it is rejected. Default `false`. [Status mapping](#status-mapping) gives its precedence. |
| `tree` node | `selected` | boolean | no | Draws the node as selected. Default `false`. The plugin's value applies in every accepted value. |
| `tree` node | `detail` | string | no | Plain text, at most 500 code points, drawn after the label as a list item's `detail` is drawn. |
| `tree` node | `actions` | array | no | At most two `button` objects, with the rules of `button`, drawn after the label and detail. Each action key is unique within the node. |
| `tree` node | `children` | array | no | Child nodes, with the same rules. A node with nonempty `children` or `branch: true` is a branch; any other node is a leaf. |
| `status-line` | `key` | string | yes | Key rules below. |
| `status-line` | `text` | string | yes | Plain text, at most 500 code points. Drawn as one line. |

Key rules: a key is a string of 1 to 128 code points from `A-Z`, `a-z`, `0-9`, `.`, `_`, `:`, and `-`. Keys are compared as exact strings.

Text rules: a text field is plain text. The workbench draws it as text content, never as markup. A text field that contains a control character (U+0000 to U+001F, U+007F, or U+0080 to U+009F) is rejected.

The `status-line` has no tone and no error value. An error reaches the user only through the display path that writes it to the application log ([AGENTS](../../AGENTS.md)), so a declared element cannot draw an error.

A `list` is a column of rows, with its `empty` text when it has none. A `tree` is an indented outline, with its `empty` text when it has none. A node with nonempty `children` is a branch; `branch: true` also declares a branch whose children have not been supplied yet (an unloaded branch). A branch draws supplied children only while it is expanded; an unloaded branch has an expand control but no child rows until a later accepted value supplies them. A `button` is one button. A `status-line` is one line of text.

## Limits

Each limit is chosen by this document. Its reason is the work that the main page does for one declared UI snapshot: it parses, validates, and draws the value on the UI thread, and it keeps every drawn tree in the document. The limits in the table are the contract values.

| Limit | Value | Reason |
| --- | --- | --- |
| Serialized value | 1048576 bytes | The UTF-8 byte length of `JSON.stringify` of the value. It is parsed and validated on the UI thread for each declared UI snapshot. |
| Root elements | 64 | The main page's work per declared UI snapshot, as for the other limits. |
| List items | 1000 per list | Bounds the rows that one list draws per declared UI snapshot. |
| Tree nodes | 5000 per tree | Bounds the nodes that one tree draws per declared UI snapshot. |
| Tree levels | 16 | Bounds the indent of a tree inside a section. |
| Text field | 500 code points | Bounds the length of one text field. It does not bound the drawn width: a tree box scrolls a label wider than the box; a list label wraps at spaces, and a label of one unbreakable word wider than the section is drawn past the section edge and scrolls with the set; status-line text is clipped at its box. |
| Key | 128 code points | Bounds the identifier that the workbench keeps per element. |
| Parameter keys | 16 per object | Bounds the parameter record that each binding keeps. |
| Parameter key | 64 code points | Bounds the parameter record that each binding keeps. |
| Parameter string value | 1000 code points | Bounds the parameter record that each binding keeps. |

Each limit is checked on receipt. Every length of a key, a text field or a parameter counts code points. The serialized value counts UTF-8 bytes. A value that exceeds a limit is rejected, never truncated.

## Drawing benchmark

The dedicated workbench benchmark measures one validation and draw of a fully expanded tree with 5000 nodes within 16 levels and a list with 1000 command items. Acceptance bounds are 2000 ms for the tree and 500 ms for the list. The measured interval includes `validateValue`, expanded-state construction and `drawValue` into jsdom, including binding attributes and calls to a no-op binder. It excludes fixture creation, module loading, completeness checks, layout, paint and attachment of command listeners. Unit tests judge complete drawing without asserting elapsed time.

Each case runs in a separate process with a 30000 ms hang limit. A partial draw, a missing binding call, an invalid clock reading or an elapsed time above the acceptance bound fails the benchmark. Each measurement records the element count, binding count, elapsed milliseconds, bound, outcome, package version, Node and jsdom versions, OS and CPU details, and load averages. The command and supervisor are documented in [example verification](../operations/examples.md#declared-ui-benchmark).

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
| `tree` node with `open` | its `open` field | its `params` field |
| `tree` node action | its `command` field | its `params` field |
| `tree` branch expand control | `core.declared-ui.tree.expand` | `{status, tree, path, expanded}` |
| sidebar section header | `core.sidebar.section.fold` | `{sidebar, section}` |

A command name in a declared UI value is `<plugin>.<name>`, where `<plugin>` is the plugin of the status. A name of core, or of another plugin, is rejected, because a plugin value names only commands of its own plugin. A name that is not declared is rejected when the declared UI snapshot is received, not when the user presses the element, because the binder refuses an undeclared name at mark time ([exposure](exposure.md#user-interface)).

`core.declared-ui.tree.expand` is declared in `packages/workbench/exposure.json` together with its handler. It sends the requested `expanded` state to the chosen source of the status as `declared-ui.expanded {status, tree, path, expanded}`. The event's `status` is the name within the plugin; the command's `status` is `<plugin>.<name>`. The workbench does not change the drawing locally: the source updates its value and the tree changes only after the next accepted snapshot. Repeating the request sends the same desired value. `path` is the array of node keys from the root node of the tree to the branch. `tree` is the key of the tree element. A `path` that names no branch in the accepted value, or a `status` or `tree` that is not drawn, fails the command with `tree <tree> path <path> is not drawn`. In that message, `<path>` is a JSON array of strings.

The event carries the desired `expanded` value, the opposite of the branch in the current accepted plugin value. Repeating the event requests the same state.

A disabled element (`enabled: false`) is rendered with the `disabled` attribute, so no click reaches its binding.
A redraw keeps the element of each root element, list row, tree node, and expand control whose address stays, as [exposure](exposure.md#user-interface) requires of every redraw, so keyboard focus stays on a control after its command runs. Each such control is connected to its command once, and a redraw only updates its parameters. A list row or tree node whose `command` changes is a new element, because its key includes the command.
The elements that carry the native `button` element are the `button`, a list item with `command`, a tree node with `command` or `open`, a tree action, and the expand control of a tree branch. A static list row and a status line carry no button. The expand control of a branch shows the chevron-right icon of the core while the branch is collapsed, and the chevron-down icon while it is expanded.


Dom names. Every control that a declared UI value draws carries the dom name `core.sidebar.section.control` and the attribute `data-key` with the key of its root element. Controls of list items and tree nodes also carry `data-path`, a JSON array of the keys below the root element, and `data-role` (`label`, `expand`, or `action`). An action button also carries `data-action` with its action key. A leaf without `command` or `open` carries no label control. A branch without `command` carries only the attributes of its expand control unless it has actions. A non-interactive element, such as a static list row or a status line, carries neither. The section header carries `core.sidebar.section.header` ([plugins](plugins.md#sections)). These are the names that the sidebar already uses, so a declared section and a module section are audited the same way. A declared element does not carry a dom name of its own kind. Its kind is the kind of the value.

A request addresses a control of a declared section by a control address, `{sidebar, section, key, path?, role?, action?}`. `sidebar` is the sidebar instance as `core.sidebars` reports it (`left`, `right`, or `cardId:side`), `section` is the section id, and `key` is the key of the root element that holds the control. `sidebar`, `section`, and `key` are strings. `path` is an array of strings, the keys below the root element, and `role` is `label`, `expand`, or `action`. `path` and `role` are required for a control of a list item or a tree node and forbidden for a root button. `action` is required exactly when `role` is `action`, and otherwise forbidden; it is the unique key among the node's actions. With these fields the address is unique: one sidebar instance draws a section once, keys are unique among their siblings, and the path, role, and optional action key name one control. The `core.sidebar.section.control` dom entry is declared `many` because several elements share that name. A value of another type is refused with -32602, as [exposure](exposure.md#errors) defines, and so is a field of `address` other than these six. An address that matches no control fails with the error code of [exposure](exposure.md#errors).

Native keyboard operation uses the native `button` element, so Enter and Space reach a button's command through the same binding. A tree node with `open` handles Enter keydown itself: it runs `open` and prevents the native click. Declared tree nodes also handle the ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Home and End keys without a modifier, as the [Tree keys](#tree-keys) section of this document specifies. No other declared UI element has a key handler. For a node with both `command` and `open`, the first click of a double press runs `command`, and the second click (`event.detail === 2`) runs `open` instead of `command`.

## Tree keys

The focus target of a tree node is its label control when that control exists and is enabled. Otherwise it is the expand control of a branch. A node with neither has no focus target. Every branch has an expand control, so every branch has a focus target. The visible nodes of a tree are the nodes that its drawing shows, in drawing order; the children of a branch are visible only while the branch is expanded.

The keys apply while the label control or the expand control of a visible node has keyboard focus. A key with a modifier (Shift, Control, Alt, or Meta) is not handled. A handled key calls `preventDefault`, so that the sidebar does not scroll by the key. A key that no row below applies to is not handled and keeps its default.

- ArrowDown moves focus to the focus target of the next visible node that has one. At the last such node, focus stays.
- ArrowUp moves focus to the focus target of the previous visible node that has one. At the first such node, focus stays.
- Home and End move focus to the focus target of the first and the last visible node that has one.
- ArrowRight on a collapsed branch runs `core.declared-ui.tree.expand` with `expanded: true`. On an expanded branch it moves focus to the focus target of its first child node that has one; when no child node has one, focus stays. On a leaf it is not handled.
- ArrowLeft on an expanded branch runs `core.declared-ui.tree.expand` with `expanded: false`. On a collapsed branch or a leaf it moves focus to the focus target of the parent node. On a root node, which has no parent, focus stays.

A focus move runs `core.declared-ui.tree.move {status, tree, path, key}`, where `key` is the key that was pressed, and declared in `packages/workbench/exposure.json` with its handler. The expansion rows run `core.declared-ui.tree.expand` as the Binding section defines it. The key rows are the rows of the keyboard shortcut table of [exposure](exposure.md#keyboard-shortcuts). The move command changes only the focus in the drawn tree; it sends no request to the source.

A redraw keeps the focus on the control that stays. When an accepted value removes the focused control, focus moves to the focus target of the nearest node that precedes the removed node in the drawing before the value and still has a focus target in the accepted value. When no such node exists, focus moves to the focus target of the first node of the same tree that has one in the accepted value. When neither exists, focus moves to the document body. When a rejection or a change of source removes the focused control, focus moves to the document body.

## Status mapping

A declared UI status is drawn through its declared UI snapshots, as follows:

- Each accepted declared UI snapshot replaces the tree of its status. The plugin's `expanded` field is authoritative for every branch: `true` draws its children and absent or `false` leaves it collapsed. The workbench keeps no expansion override.
- The expand control sends `declared-ui.expanded {status, tree, path, expanded}` to the source of the status. It sends the requested value, the opposite of the branch state in the current accepted plugin value. The source updates its value and pushes a snapshot; only that accepted value changes the tree.
- A branch's accepted `expanded` value is never overridden by a prior value or a request. When a branch first appears, returns after being absent, or changes from a leaf, its expanded state is the value the plugin supplied in that accepted snapshot.
- A rejected value clears the drawing and does not change the plugin's source state. The next accepted value determines the branch expansion again. A change of source also clears the drawing; the new source's accepted value determines expansion.
- A path that is a leaf in an accepted value has no expand control. If that path later becomes a branch, its new accepted `expanded` value determines whether its children draw.
- A pull reply with `value: null` means that the source has no value yet. The section stays cleared until the first push from the source. The `seq` of a pull reply is the seq of the source's last declared UI snapshot, or 0 when `value` is `null`. A pull reply whose `seq` is lower than the `seq` of the last accepted value from its source is discarded without validation; every other non-null pull reply follows the validation rules.
- A pull that fails, because the source replies with an error or the call is refused, leaves the section cleared: it draws no value, neither the last accepted value nor an empty tree. Its error is reported once through the error display path (`error: <where>: <text>` in the application log, as in [the error display](native-surfaces.md#view-surfaces)), and the section shows no rejection for it. The workbench does not retry a failed pull on a timer or by any other schedule; the next pull is the one of the next change of source in (c).
- No core command changes `selected`, so the plugin's value applies in every accepted value.
- A plugin process restart is a process end, which removes the registrations of the old process as transition (d), followed by a registration from the new process, which chooses the source again as transition (a). The new source's accepted value determines every branch state.
- The workbench saves no expansion state with a space or project. A reload draws the plugin's accepted `expanded` values.
- A declared status is served by a plugin process. A declared status source is the first of these that registered the status. First, the view of the active tab of the card that holds the sidebar, when that view's page registered the status: for a card sidebar, that card; for a fixed window sidebar, the focused content card and its active tab while a [plugin override](external-sidebars.md#override-context-and-rail-border) applies, as `core.sidebars` reports them, and this step is skipped when no plugin override applies. Second, the [plugin host](plugin-host.md) of the plugin, when the plugin has one; its section draws the snapshot pushed by the host page ([declared UI snapshots](plugin-host.md#declared-ui-snapshots)). Otherwise the section is cleared until one of them registers the status. A registration by a state module does not serve a declared UI status, because it has no snapshot protocol. A declared UI status that only a state module registers has no source, and its section is cleared. A process registers a status when its page calls `page.exposure.register("status", name)`, and the registration belongs to that process. A declared status source is the pair of a process and its registration of the status. A change of source means a different pair. A re-registration by the same process for the same status is not a change.

The source changes by these rules:

- (a) The source is chosen again when the active tab of the sidebar's card, the focused card of a fixed window sidebar, or a registration changes, or the plugin override of the fixed window sidebar starts or stops applying.
- (b) On a change of source, the section is cleared until the first value from the new source is accepted. No expansion state survives the change; the new source's accepted value determines it.
- (c) On a change of source, the workbench pulls the current value from the new source once. The workbench pulls only from the chosen source at the load of the main page, at a change of source, and at no other time, because a running view has no other way to send its last value to a new reader. A pulled value follows the same validation and rejection rules as a pushed declared UI snapshot.
- The workbench completes the snapshot subscription to a new source before it pulls that source. Subscription readiness means the source has installed the listener that receives pushed snapshots. The subscription operation resolves to its unsubscribe function only after readiness; a source whose listener is installed synchronously resolves readiness immediately. If the source changes or the section closes before readiness, the workbench unsubscribes as soon as readiness completes and does not pull that source. A snapshot delivered after readiness and before the pull reply is accepted normally, so the pull's lower sequence cannot replace it.
- (d) A process end removes its registrations, and the source is chosen again as in (a).
- A declared UI snapshot from a pair that is not the chosen source is acknowledged, then discarded without validation. A pull reply from such a pair, or a pull reply whose `seq` is lower than the `seq` of the last accepted value from its source, is discarded without validation. Neither changes the tree nor the error display.
- Before the first accepted value, the section shows no tree. The rejection text is the only content it can show before that, and it shows it only after a rejected value.
- The status of a declared UI value is not a change feed: the plugin sends the whole value again when any element changes.
- When the main page loads, the workbench pulls the current value of each declared status once, from the source chosen for it.

## Sidebar section form

A sidebar section is declared in `plugin.json` ([plugins](plugins.md#sections)) with the `status` form, which is its only form. A section declares `id`, `name`, `status`, and optional `fill`. `fill: true` has the meaning that [plugins](plugins.md#sections) gives a section: an open section shares the sidebar height that the other sections leave, and its body scrolls inside it.
A sidebar section with the `status` form is declared UI. A plugin that needs a view declares a card surface, and the sidebar holds a `button` whose command is a command of that plugin and opens it.

- A section with `status` is drawn from the declared UI value of that status. The status must be a status of the same plugin that `exposes.status` declares.
- A section with `module` is rejected with `plugin <plugin>: section <id> module is removed; a section takes status`, and a section without `status` is rejected with `plugin <plugin>: section <id> requires a status`. A `status` that is not a status of the plugin is rejected with `section <id> status <name> is not a status of plugin <plugin>`. `exposes.status` means the entries of `exposes.status` in `plugin.json` only.
- One status backs at most one section. A second section that names the same status is rejected when the manifest is read, with `status <plugin>.<name> backs section <first> and section <second>`. The check runs on the manifest, so it does not depend on the value.

A declared section draws its root elements in order inside its body.

- In vertical orientation the elements stack from top to bottom.
- In horizontal orientation the elements sit left to right in one row that wraps at the section width. A `tree` takes one full line of that width, as the paragraph below describes.
A tree in a horizontal section takes one full line of the section width and draws its outline as in vertical orientation, so the row wraps before and after it. A `list` keeps its content width, and shrinks to the line only when its content is wider. A tree's width follows its deepest visible row, so a branch that expands or collapses changes it; the full line keeps that change from reflowing the sibling elements. A tree box scrolls horizontally, with a thin scrollbar, when a label is wider than the box, so a label beyond the box is reached by scrolling. In a vertical section the tree box is the section width, so the scroll applies only when a label is wider than the section. No declared value depends on orientation: an orientation change neither checks nor pulls a declared value, and the accepted value stays drawn.

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

Every rejection text has the form `<pointer>: <reason>`. The pointer of each row of the table is the value that breaks the row, as its Pointer column states. A count or size limit points to the array, object, or string that exceeds it. A field-presence row (`unknown field`, `missing`, `requires command`) points to the object that holds the field. A field-value row points to the field. A duplicate key points to the second key. `/` is the root and the whole serialized value. `<field>` is the JSON field name. Pointers are JSON Pointers (RFC 6901). `<owner>` is the plugin id of the status. The `<field>`, `<key>`, `<value>`, `<name>`, and `<owner>` slots of a reason are written as JSON strings, and the composed `<owner>.<name>` slot is one JSON string: the value is escaped first, with control characters written as JSON escapes, and then wrapped in double quotes. The quotes count toward the limit of 128 code points. A quoted text longer than 128 code points keeps its opening quote and its first 125 code points, then the marker `…` (U+2026) and the closing quote, so the cut text has 128 code points. The `<type>` slot is a fixed type name of this document and is not quoted.
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
| An action that is not an object | `tree action must be an object` | that action |
| An element with no `kind` field | `missing kind` | the element |
| A `kind` that is not a string | `kind must be a string` | the element |
| A `kind` value that is not in the table | `unknown kind <value>` | the `kind` value |
| More than 1000 items in a list | `exceeds 1000 items` | `/elements/<i>/items` |
| More than 5000 nodes in a tree | `exceeds 5000 nodes` | `/elements/<i>/nodes` |
| More than two actions on a tree node | `exceeds 2 actions` | the `actions` array |
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

Rejections that concern a manifest, the section form and the one-section rule, are reported when the manifest is read, with the reasons in [sidebar section form](#sidebar-section-form), and not with a value pointer.

## Terms

The terms are in the [term list](terms.md): declared UI, declared UI snapshot, declared UI value, declared element, declared status line, declared UI schema, declared UI status, branch, and declared section.
