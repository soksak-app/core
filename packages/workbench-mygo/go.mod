module github.com/soksak-app/core/packages/workbench-mygo

go 1.27.3

require github.com/egoist/mygo v0.7.4

// The replacement runs no Go code on the main thread, as packages/host/mygo states.
replace github.com/egoist/mygo => ../../../mygo-integration
