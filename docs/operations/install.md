# Install a release

[한국어](install.ko.md)

Each release publishes two macOS arm64 applications, `soksak-<version>-macos-arm64-wails.zip` and `soksak-<version>-macos-arm64-tauri.zip`. Both hold `soksak.app`; they keep their data in separate configuration folders, `app.soksak.wails` and `app.soksak.tauri` ([projects](../spec/projects.md#persistence)). To install both, rename one of them, for example `soksak (Tauri).app`.

The applications are not signed with a Developer ID or notarized, so macOS refuses the first start of a downloaded copy. To install one:

1. Open the zip file and move `soksak.app` to `Applications`.
2. Start it once. macOS reports that it cannot verify the application.
3. Open System Settings, Privacy & Security, and choose Open Anyway for `soksak.app`; then start it again and confirm Open.

Alternatively, remove the download quarantine in Terminal before the first start: `xattr -dr com.apple.quarantine /Applications/soksak.app`.

On its first start the application installs the starter plugins from the public registry `https://soksak-app.github.io/registry/index.json` ([first run](../spec/installation.md#first-run)).

To use the command line of an application from a shell, run its `sok path install` with administrator rights: `sudo /Applications/soksak.app/Contents/MacOS/sok path install` ([command line](../spec/cli.md)).
