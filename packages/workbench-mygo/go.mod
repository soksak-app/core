module github.com/soksak-app/core/packages/workbench-mygo

go 1.27.3

require (
	github.com/egoist/mygo v0.7.4
	github.com/soksak-app/core/packages/host/go v0.0.0
)

require (
	github.com/Masterminds/semver/v3 v3.5.0 // indirect
	github.com/ebitengine/purego v0.11.1 // indirect
	github.com/fsnotify/fsnotify v1.10.1 // indirect
	github.com/go-text/typesetting v0.3.5 // indirect
	github.com/soksak-app/core/packages/sok/go v0.0.0
	golang.org/x/image v0.46.0 // indirect
	golang.org/x/net v0.59.0 // indirect
	golang.org/x/sys v0.48.0 // indirect
	golang.org/x/text v0.43.0
)

// The replacement runs no Go code on the main thread, reports the presentation
// of a frame, lets the application own its activation, its signals and the
// notification center delegate, draws while a window is occluded, and builds
// a frame that an open transaction of the application keeps from a drawable
// to draw it after the commit.
replace github.com/egoist/mygo => github.com/min-0-max/mygo v0.7.4-244-g4abb83d-soksak.11
