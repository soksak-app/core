module github.com/soksak-app/core/apps/wailsv3

go 1.27.3

require (
	github.com/soksak-app/core/packages/host/go v0.0.0
	github.com/soksak-app/core/packages/host/wailsv3 v0.0.0
)

require (
	github.com/Masterminds/semver/v3 v3.5.0 // indirect
	github.com/adrg/xdg v0.5.3 // indirect
	github.com/coder/websocket v1.8.14 // indirect
	github.com/fsnotify/fsnotify v1.10.1 // indirect
	github.com/go-ole/go-ole v1.3.0 // indirect
	github.com/godbus/dbus/v5 v5.2.2 // indirect
	github.com/mattn/go-colorable v0.1.14 // indirect
	github.com/mattn/go-isatty v0.0.20 // indirect
	github.com/soksak-app/core/packages/sok/go v0.0.0 // indirect
	github.com/wailsapp/wails/v3 v3.0.0-beta.27 // indirect
	golang.org/x/sys v0.46.0 // indirect
)

// The replacement runs no Go code on the main thread, avoids duplicate
// transport-error records, rejects callbacks from retired windows while
// preserving window event routing, and gives a window and its web view the
// size that it was asked for.
replace github.com/wailsapp/wails/v3 => github.com/min-0-max/wails/v3 v3.0.0-20261105142514-75cb0e38d6aa
