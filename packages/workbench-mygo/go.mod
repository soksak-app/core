module github.com/soksak-app/core/packages/workbench-mygo

go 1.27.3

require github.com/egoist/mygo v0.7.4

require (
	github.com/ebitengine/purego v0.11.1 // indirect
	github.com/go-text/typesetting v0.3.5 // indirect
	golang.org/x/image v0.46.0 // indirect
	golang.org/x/text v0.43.0 // indirect
)

// The replacement runs no Go code on the main thread, reports the presentation
// of a frame, lets the application own its activation, its signals and the
// notification center delegate, and draws while a window is occluded.
replace github.com/egoist/mygo => ../../../mygo-integration
