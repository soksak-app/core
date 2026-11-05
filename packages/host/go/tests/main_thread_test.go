// The start of the library on macOS requires the two main-thread functions that the framework adapter installs (docs/spec/hosts.md,
// main thread of the Wails host).
package host_test

import (
	"testing"
	"testing/fstest"
	"unsafe"

	host "github.com/soksak-app/core/packages/host/go/src"
	"github.com/soksak-app/core/packages/host/go/src/platform/darwin"
	fixture "github.com/soksak-app/core/packages/host/go/tests/platform/darwin"
)

// startFramework is a framework adapter that installs its main-thread functions as each case states and is never reached: a start
// that lacks a function fails before it asks anything of the framework.
type startFramework struct{ t *testing.T }

func (f startFramework) reached(method string) {
	f.t.Errorf("the start reached %s of the framework", method)
}

func (f startFramework) ApplicationName() string                              { f.reached("ApplicationName"); return "fixture" }
func (f startFramework) DisplayName() string                                  { f.reached("DisplayName"); return "Fixture" }
func (f startFramework) MainPage() bool                                       { f.reached("MainPage"); return true }
func (startFramework) RecordSteps(func(host.StepRecord), func(uint64)) func() { return nil }
func (startFramework) RegisteredCallbacks() int64                             { return 0 }
func (f startFramework) Step(func())                                          { f.reached("Step") }
func (f startFramework) Post(func())                                          { f.reached("Post") }
func (f startFramework) Quit()                                                { f.reached("Quit") }
func (f startFramework) ChooseFolder(host.Frontend, string) (string, error) {
	f.reached("ChooseFolder")
	return "", nil
}
func (f startFramework) SaveFile(host.Frontend, string, string) (string, error) {
	f.reached("SaveFile")
	return "", nil
}
func (f startFramework) SetMenu([]host.Menu) error { f.reached("SetMenu"); return nil }
func (f startFramework) InstallDock(func()) error  { f.reached("InstallDock"); return nil }
func (f startFramework) Windows() []host.Frontend  { f.reached("Windows"); return nil }
func (f startFramework) NewWindow(host.WindowOptions) host.Frontend {
	f.reached("NewWindow")
	return nil
}

// contract: host.main-thread.start-requires-both-functions
func TestTheStartRequiresBothMainThreadFunctions(t *testing.T) {
	const installs = "; the framework adapter installs them through darwin.InstallMainThread before the start of the library"
	run := fixture.TestOnlyRunDirectly()
	for _, c := range []struct {
		name         string
		worker, main unsafe.Pointer
		want         string
	}{
		{"no function", nil, nil, "main-thread functions are not installed: hostRunOnWorker and hostRunOnMain" + installs},
		{"only hostRunOnWorker", run, nil, "main-thread functions are not installed: hostRunOnMain" + installs},
		{"only hostRunOnMain", nil, run, "main-thread functions are not installed: hostRunOnWorker" + installs},
	} {
		t.Run(c.name, func(t *testing.T) {
			darwin.InstallMainThread(c.worker, c.main)
			// TestMain installed the test function for both, which the other tests of the package run through.
			t.Cleanup(func() { darwin.InstallMainThread(run, run) })
			session, err := host.Prepare(startFramework{t}, fstest.MapFS{}, host.Options{ConfigDir: t.TempDir()})
			if session != nil {
				t.Error("the start returned a session")
			}
			if err == nil || err.Error() != c.want {
				t.Fatalf("the start failed with %v, want %q", err, c.want)
			}
		})
	}
}
