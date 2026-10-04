# Text size

[한국어](text-size.ko.md)

The example application changes the text size of one card or of the whole window. It does not zoom the main webview: the layout and native surfaces are placed in unzoomed CSS pixels, so a webview zoom moves them out of the window. Implementation and validation status are recorded in [features](../features.md).

## Scope

The scope is the place the user pressed last:

- A press on a card, including its native terminal region or browser document, selects that card.
- A press on the frame outside the plane (the project bar, the space bar, or the frame chrome) selects the frame.

The window starts with the focused card as the scope. A window without a focused card, such as the library before a space opens, has the frame as the scope, because the frame is the only place whose text it shows.

## Steps and values

A text size is a factor. The steps are 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, and 3. Enlarging moves to the next larger step, reducing to the next smaller step, and restoring sets 1. Enlarging at 3 and reducing at 0.5 leave the value unchanged.

- The frame factor applies to the frame chrome and to every card.
- A card factor applies to that card only.
- A card's effective factor is the frame factor multiplied by the card factor.

The frame factor is the common setting `textSize`. A card factor is stored in the card's layout data as `textSize` and is saved with the space; a card without it has factor 1.

## Rendering

- The frame chrome (project bar and space bar) uses CSS `zoom` with the frame factor, so its rows grow with the text and the plane receives the remaining height.
- A DOM card's content uses CSS `zoom` with the card's effective factor inside its slot; the slot rectangle, and therefore native placement, does not change.
- A terminal card sets its font size to 13 points multiplied by the effective factor. The sidecar recomputes the cell size, columns, and rows from that size.
- A browser document region sets its page zoom to the effective factor. The host keeps the factor when it places the region or the surface scale changes.

## Commands and shortcuts

| Command | Effect |
| --- | --- |
| `core.text.larger` | Enlarge the text of the current scope |
| `core.text.smaller` | Reduce the text of the current scope |
| `core.text.reset` | Restore the text of the current scope to factor 1 |

The status `core.text` reports `{scope: {kind: "frame"} or {kind: "card", card}, frame, cards}`, where `cards` maps each card identifier to its card factor.

The View menu of both hosts has the items 글자 크게 (Command `=`), 글자 작게 (Command `-`), and 글자 기본 크기 (Command `0`). A menu key equivalent works whatever view has the keyboard focus, including a native terminal region or a browser document, and each item runs the command in the main page of the application's main window, or of its frontmost visible window when the application has not been active and has no main window.
