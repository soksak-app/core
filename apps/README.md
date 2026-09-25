# Applications

[한국어](README.ko.md)

Each application assembles the same workbench with the plugins and defaults in its `environment.json`. The browser application has no native host and shows placeholders for plugin surfaces. The Wails and Tauri applications show plugin surfaces in native webviews.

```sh
make prepare
pnpm example
```

Open `http://localhost:8749/index.html` for the browser application. To build and run a native application on macOS 14.0 or later:

```sh
make wailsv3
make tauriv2
```

The targets build `target/debug/soksak-wailsv3.app` and `target/debug/soksak-tauriv2.app` and run them. The applications call the host libraries in `packages/host/wailsv3` and `packages/host/tauriv2`.

Startup displays the project library. Create a project or select a saved project to use that same window. The title bar’s project-list button returns to the library while preserving current work. New Window, including the macOS Dock menu, opens another library screen. The common opening mode applies when a window already owns a project. Common settings are stored in the application configuration directory; folder overrides are stored in `.soksak/settings.json` inside the project.

Settings uses `data-native-modal="dialog"`; add and split pickers use `data-native-modal="menu"`. The native host renders these existing DOM elements in webviews inside the main OS window.

- [Projects, settings, and windows](../docs/spec/projects.md)
- [Example model](../docs/spec/example-model.md)
- [Plugins and application environments](../docs/spec/plugins.md)
- [Native hosts and application structure](../docs/spec/hosts.md)
- [Native host interfaces](../docs/spec/native-host.md)
- [data-native-modal usage and behavior](../docs/spec/native-modals.md)
- [Native surface placement](../docs/spec/native-surfaces.md)
- [Build, run, and verify](../docs/operations/examples.md)
- [Implementation and platform status](../docs/features.md)
