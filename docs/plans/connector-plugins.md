# Connector plugins

[한국어](connector-plugins.ko.md)

## Problem

The application surface ([external application surface](external-app-surface.md)) shows an application that contains an embed adapter inside an `appview` card, but a person names the executable and its arguments in the settings of the card. An application has no entry of its own in the registry, so it is not installed or started from there.

## Approach

Each application reaches people through a connector plugin: a plugin of the registry that holds no code or binary of the application. It declares the application, the platforms that the application supports, and for each platform how to find an application that is installed already and a recipe that installs it through the distribution of the application itself. soksak distributes no code of the application, so the license of the application is kept by its own distribution.

When the connector plugin is installed, the installer examines the machine: an application that is installed already is connected, its place recorded and nothing installed; otherwise the recipe installs it. The connector plugin depends on the plugin `appview`, which shows the application, so installing it installs the surface and the application sidecar.

## Contract: `application` of plugin.json

The recipe is a general field of the manifest, because core names no plugin:

```json
"application": {
  "id": "<application id>",
  "name": "<name shown>",
  "version": "<version of the application>",
  "platforms": {
    "darwin-arm64": {
      "locate": [{ "bundle": "<bundle id>" }, { "command": "<name on PATH>" }, { "path": "<absolute path>" }],
      "recipe": { "kind": "release", "url": "<address>", "sha256": "<hash>", "unpack": "zip" },
      "program": "<executable inside the installed folder>",
      "arguments": []
    }
  }
}
```

- `locate` lists the ways to find an installed application, tried in order: a bundle identifier through the metadata index of darwin, a name on `PATH`, or an absolute path that exists and is executable.
- `recipe` is one of `release` (download a release of the application's repository, compare its SHA-256, unpack `zip`, `tar.gz` or nothing), `package` (ask a package manager, such as `brew`, whether it has the package as the declared cask or formula, install it, and find it with the locate entries), or `source` (clone a repository at a ref into the folder of the application and run the build commands of that repository there).
- `program` and `arguments` start the application.

## Installation

1. After the plugin release is extracted, the installer selects the platform entry of `application` for the platform it runs on; a platform without an entry fails with `application <id> does not support <platform>`, and nothing changes.
2. It tries each `locate` entry in order. When one finds the application, the installer records its place and the way it was found and installs nothing.
3. When none finds it, the installer runs the recipe into `<config-dir>/applications/<id>/<version>/`. Each step (download, hash, unpack, each command) is an event; a step that fails stops the installation with an error that names the step and its output, and `installed.json` is left unchanged.
4. The result is recorded in `plugins/applications.json` (format 1) as `{id, version, path, how, method}`, where `how` is `located` or `installed`. Removing the connector plugin deletes an application whose `how` is `installed` and leaves a located application untouched.

## Surface

The `appview` card starts the program of its setting `program` when it names one, and otherwise the application that `applications.json` records for the connector plugin of the card, with its arguments.

## Order

Each step updates the specification first, then has a unit test that fails (Red) and passes after the change (Green), a changelog entry in English and Korean, and its own commit.

1. Specification: the field `application` in the plugin specification and the examination, installation, record and removal rules with the form of `applications.json` in the installation specification; `validateManifest` checks the field.
2. Examination: both `sok` implementations try `locate` (bundle, command, path) with the same result.
3. Recipe `release`: download, SHA-256, unpack, and the reversal of a failed installation.
4. Recipes `package` and `source`.
5. Record and removal in `applications.json`.
6. The plugin operations of the application run the same steps and report their progress.
7. `appview` starts the recorded application.
8. A test connector plugin whose recipe is a release of the test application of the embed kit, and a window check that installs it (installed when absent, connected when present), starts it in a card and runs the gate.
9. The connector plugin of the example application, once its own distribution provides a build with the embed adapter.
