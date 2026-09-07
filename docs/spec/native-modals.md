# Native modals

[한국어](native-modals.ko.md)

This specification defines `data-native-modal`. [Features](../features.md) records implementation, validation, and release status.

The application owns the existing settings and picker DOM. `overlay.show()` renders a marked element in another native webview inside the main OS window. The element requires `dialog` or `menu`, a unique `id`, and an `aria-label`.

| Mode | Webview area | Background | Dismissal |
| --- | --- | --- | --- |
| `dialog` | Main content viewport | Black at 50% opacity; 3px CSS blur on each background web document | Settings closes with its × button |
| `menu` | Picker rectangle | No backdrop or blur | Selection, outside click, or Escape |

The main document measures the card rectangle. Moving the card updates its DOM position without moving the full-viewport dialog webview. The dialog webview resizes with the main window, blocks background input, and remains above newly created surfaces.

The dialog document draws the translucent backdrop with CSS. Each background webview applies the same CSS blur to its own content. A CSS filter in the dialog cannot blur a separate native webview. The dialog content remains clear. Hosts assign the boolean `window.__soksakBackground` through webview APIs. The background script applies state assigned before its initialization and handles later assignments through the same property.

Opening, closing, surface creation, and surface navigation must apply the current background state. Closing removes the applied stylesheet without changing the page's existing styles. Reloading main removes its modal and background effect. Modal webviews and their initial documents are transparent; the card paints its own background. No additional OS window or platform visual-effect view is required.

Acceptance requires captured pixels showing blur and translucent shading, clear dialog content, blocked background clicks and scrolling, ×-only settings dismissal, and restored appearance and input after closing. Card movement, content updates, surface replacement and navigation, parent resizing, and main-document reload must preserve these requirements. Add and split menus apply neither background effect.

The visual definition is shared web code. Each platform still requires a working native webview host and behavior verification. Current Wails additional-webview creation is implemented only on macOS. Windows and Linux execution is unverified.

## Usage

An empty value or any other value is rejected by `show()`. The element also
needs a unique, nonempty `id` and a nonempty `aria-label`. Choose the mode before
opening; to change modes, close and open the view again.
Only one overlay is open at a time. Opening another closes the previous native
view; its owner remains responsible for cleaning up the previous DOM.

The following markup uses the example's `app.css` classes. The scrim remains in
the main document to block its DOM input; only the card is copied into the
native webview.

```html
<div class="set-scrim" id="preferences-scrim">
  <div id="preferences" class="set-card" data-native-modal="dialog"
       role="dialog" aria-modal="true" aria-label="Preferences">
    <header class="set-card__head">
      <span class="set-card__title">Preferences</span>
      <button class="act" type="button" data-key="close" aria-label="Close">×</button>
    </header>
  </div>
</div>
```

In a native host, open that element after inserting it into the main document:

```js
import { overlay } from "./host.js";

const el = document.getElementById("preferences");
const scrim = document.getElementById("preferences-scrim");
const plane = document.getElementById("plane").getBoundingClientRect();
const r = el.getBoundingClientRect();
overlay.show(el, {
  x: r.left - plane.left, y: r.top - plane.top, w: r.width, h: r.height,
}, (key, value) => {
  if (key === "close") {
    overlay.hide(el);
    scrim.remove();
  }
  // Handle the card's other answers here.
});
el.style.visibility = "hidden";
```

Frames passed to `show()` and `place()` are CSS pixels relative to `#plane`.
`show()` copies the root class, inner markup and page stylesheets. It does not
hide or remove the original DOM. Keep that DOM measurable with
`visibility: hidden` if it owns layout, then call `overlay.place(el, rect)` when
it moves or changes size and `overlay.update(el)` when its content changes.
JavaScript listeners and form properties are not serialized; use attributes
such as `checked`, `selected` and `value` for the copied initial state.

[`browser/card.js`](../../examples/browser/card.js) forwards `data-key` clicks and `data-set`
changes as `(key, value)`. Escape in a `menu` sends an empty key. The owning
component decides what the answer does and removes its own DOM when closing;
outside-click handling belongs to that component too. The actual owners are
[`settings-ui.js`](../../examples/browser/settings-ui.js) and [`plane.js`](../../examples/browser/plane.js).
