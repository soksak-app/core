//go:build darwin && cgo

package darwin

import "github.com/soksak-app/core/packages/host/go/tests/platform/darwin/standalone/staticsupport"

// InstallTestSupport connects native test observers to Wails' statically linked production state.
func InstallTestSupport() error { return staticsupport.InstallTestSupport() }
