// Package support holds the helpers of the tests of the mygo framework adapter: the run of the tests in the application of the
// framework, the fixture workbench, and the bundle and the log of a child application.
package support

import (
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"

	host "github.com/soksak-app/core/packages/host/go/src"
	"github.com/soksak-app/core/packages/host/go/src/platform"
	adapter "github.com/soksak-app/core/packages/host/mygo/src"
)

// Main runs the application of the framework on the main thread and the tests in it, as TestMain of a test package. The native
// provider of the platform is checked first, so no test and no helper runs over a broken native installation. A process whose
// environment names a variable of helpers runs that helper instead. The tests start when the application finished launching,
// cleanup runs after them, and the process ends with their status.
func Main(m *testing.M, helpers map[string]func(), cleanup func()) {
	system, err := platform.Current()
	if err == nil {
		err = system.RequireMainThread()
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	for name, helper := range helpers {
		if os.Getenv(name) != "" {
			helper()
			return
		}
	}
	adapter.ConfigureApplication()
	mygo.App.SetActivationPolicy(mygo.ActivationPolicyProhibited)
	mygo.App.WhenReady(func() {
		go func() {
			status := m.Run()
			cleanup()
			os.Exit(status)
		}()
	})
	if err := mygo.App.Run(); err != nil {
		fmt.Fprintln(os.Stderr, "the application did not run:", err)
		os.Exit(1)
	}
	fmt.Fprintln(os.Stderr, "the application ended before the tests ended")
	os.Exit(1)
}

// SceneWorkbench is the fixture workbench: it draws one fixed scene and records what it receives.
type SceneWorkbench struct {
	mu      sync.Mutex
	records []string
	// holding keeps the workbench from showing its first screen when it starts, as a start that still reads its state.
	holding bool
}

// HoldFirstScreen makes the starts after it show no first screen until the test calls FirstScreen of the window.
func (w *SceneWorkbench) HoldFirstScreen() {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.holding = true
}

// Record adds one record.
func (w *SceneWorkbench) Record(format string, values ...any) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.records = append(w.records, fmt.Sprintf(format, values...))
}

// Received returns the records in their order.
func (w *SceneWorkbench) Received() []string {
	w.mu.Lock()
	defer w.mu.Unlock()
	return slices.Clone(w.records)
}

func (w *SceneWorkbench) Prepared(*host.Host) {}

// Shown records the start and, unless the workbench holds it, shows the first screen at once, as the scene needs no state.
func (w *SceneWorkbench) Shown(window host.Frontend) {
	w.Record("shown %s", window.Name())
	w.mu.Lock()
	holding := w.holding
	w.mu.Unlock()
	if !holding {
		mygo.RunOnMain(window.(*adapter.Frontend).FirstScreen)
	}
}

// StartFailed records the refused start and shows its first screen as Shown does.
func (w *SceneWorkbench) StartFailed(window host.Frontend, err error) {
	w.Record("start failed %s: %v", window.Name(), err)
	w.mu.Lock()
	holding := w.holding
	w.mu.Unlock()
	if !holding {
		mygo.RunOnMain(window.(*adapter.Frontend).FirstScreen)
	}
}

func (w *SceneWorkbench) Build(window host.Frontend) func(c *ui.Context) {
	w.Record("build %s", window.Name())
	return func(c *ui.Context) {
		w.Record("draw %s", window.Name())
		ui.Text(c, "scene")
	}
}

func (w *SceneWorkbench) Close(window host.Frontend) { w.Record("close %s", window.Name()) }

func (w *SceneWorkbench) Emit(window host.Frontend, name string, data ...any) {
	w.Record("event %s %s %v", window.Name(), name, data)
}

func (w *SceneWorkbench) Call(window host.Frontend, script string) {
	w.Record("call %s %s", window.Name(), script)
}

// Wait waits for condition, which an event of the framework makes true, within the limit of a test.
func Wait(t *testing.T, what string, condition func() bool) {
	t.Helper()
	for limit := time.Now().Add(10 * time.Second); !condition(); time.Sleep(5 * time.Millisecond) {
		if time.Now().After(limit) {
			t.Fatalf("%s did not happen within 10 s", what)
		}
	}
}

// Open creates a window of a fixture workbench, which the test destroys at its end.
func Open(t *testing.T, name string) (*adapter.Framework, *SceneWorkbench, *adapter.Frontend) {
	t.Helper()
	workbench := &SceneWorkbench{}
	framework := adapter.NewFramework(workbench)
	window := framework.NewWindow(host.WindowOptions{Name: name, Title: "soksak", Width: 400, Height: 300}).(*adapter.Frontend)
	t.Cleanup(window.Window().Destroy)
	return framework, workbench, window
}

// Bundled returns the executable of a bundle that holds this test binary, because the notification center of a run requires a bundle.
func Bundled(t *testing.T) string {
	t.Helper()
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	contents := filepath.Join(t.TempDir(), "soksak-test.app", "Contents")
	if err := os.MkdirAll(filepath.Join(contents, "MacOS"), 0o755); err != nil {
		t.Fatal(err)
	}
	const plist = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>app.soksak.mygo.test</string>
<key>CFBundleExecutable</key><string>soksak-test</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>
`
	if err := os.WriteFile(filepath.Join(contents, "Info.plist"), []byte(plist), 0o644); err != nil {
		t.Fatal(err)
	}
	inside := filepath.Join(contents, "MacOS", "soksak-test")
	if err := os.Link(executable, inside); err != nil {
		t.Fatal(err)
	}
	return inside
}

// Logged returns the standard error and the crash output that the application wrote to its log folder. A fatal error of the Go
// runtime writes only to the crash output, and the folder ends with the test (docs/spec/logging.md#files).
func Logged(config string) string {
	var text strings.Builder
	for _, pattern := range []string{"host-*.stderr", "host-*.crash"} {
		files, _ := filepath.Glob(filepath.Join(config, "logs", pattern))
		for _, file := range files {
			if data, err := os.ReadFile(file); err == nil {
				text.Write(data)
			}
		}
	}
	return text.String()
}
