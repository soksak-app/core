# Examples

[한국어](README.ko.md)

The browser page demonstrates projects, spaces, cards, tabs, sidebars, and plugin selection. The Wails and Tauri applications use the same frontend with native browser and terminal webviews.

```sh
make prepare
pnpm example
```

Open `http://localhost:8749/examples/browser/index.html` for the browser example. To build and run a native example on macOS:

```sh
make wails
make tauri
```

Settings uses `data-native-modal="dialog"`; add and split pickers use `data-native-modal="menu"`. The native host renders these existing DOM elements in webviews inside the main OS window.

- [Example model](../docs/spec/example-model.md)
- [Native host interfaces](../docs/spec/native-host.md)
- [data-native-modal usage and behavior](../docs/spec/native-modals.md)
- [Native surface placement](../docs/spec/native-surfaces.md)
- [Build, run, and verify](../docs/operations/examples.md)
- [Implementation and platform status](../docs/features.md)
