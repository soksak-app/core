# Example model

[한국어](example-model.ko.md)

The example application owns projects, spaces, and tabs. The layout library owns card geometry.

| Object | Contents |
| --- | --- |
| Project | Root path, name, color, and spaces |
| Space | Card arrangement, focused card, rail widths, and tabs |
| Card | Layout slots, optional pixel size, and tabs |
| Tab | Plugin and title |

The [project contract](projects.md) defines directory identity, persistence, settings inheritance, startup selection, and project windows. Switching spaces captures the current application state and restores the selected space through `Soksak.replace()`.

The add and split buttons select a plugin for a new tab. Dropping a tab on a card center adds it to that card; dropping it at a card edge creates adjacent space. Moving the only tab in a card moves the card.

Plugins register surfaces as `{url}` for an external document or `{page}` for an application document. Plugins can contribute sidebar sections. Settings stores section sets and their assignments to the left sidebar, plugin rail, or right sidebar.

The browser example simulates native surfaces. Its commit-delay and placement-offset controls exercise the page verifier. Browser checks do not verify native composition; native acceptance requires the host checks in [verification](../operations/examples.md).

`plane.js` owns card and tab actions. `compositor.js` measures or predicts surface rectangles. `host.js` sends native requests. `framework/` implements transport for each runtime. `settings-ui.js` owns settings DOM; `card.js` handles inputs shared with `overlay.html`.
