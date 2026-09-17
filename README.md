# soksak

[한국어](README.ko.md)

A workspace for the soksak layout library, its workbench frontend, plugins, and applications.

| Directory | Contents |
| --- | --- |
| [`packages/soksak`](packages/soksak/README.md) | Headless soksak layout library |
| [`packages/workbench`](docs/spec/plugins.md) | Workbench frontend and plugin loading |
| [`packages/plugin-api`](docs/spec/plugins.md) | Plugin and environment formats |
| [`packages/host`](docs/spec/hosts.md) | Wails v3 and Tauri v2 native host libraries |
| `plugins/` | Browser, shell, and files plugins |
| [`sidecars`](docs/spec/sidecars.md) | Native processes used by plugins |
| [`apps`](apps/README.md) | Browser, Wails, and Tauri applications |
| `native/darwin` | Shared macOS native library |
| `e2e` | Window checks for running native applications |

```sh
make prepare
make verify
pnpm test
```

- [Layout rules and API](packages/soksak/docs/layout.md)
- [Applications](apps/README.md)
- [Plugins and application environments](docs/spec/plugins.md)
- [Projects, settings, and windows](docs/spec/projects.md)
- [Native hosts](docs/spec/hosts.md)
- [Native surface placement](docs/spec/native-surfaces.md)
- [data-native-modal](docs/spec/native-modals.md)
- [Private native APIs and update review](docs/operations/private-native-apis.md)
- [Implementation, validation, and release status](docs/features.md)
- [Changes](CHANGELOG.md)
- [Development and required checks](AGENTS.md)

MIT license: [LICENSE](LICENSE).
