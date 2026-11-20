// Package support holds the helpers of the tests of the mygo framework adapter: the run of the tests in the application of the
// framework, the fixture workbench, and the bundle and the log of a child application.
package support

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"
	"github.com/fsnotify/fsnotify"

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
	// drawing runs in the next draw of the scene (InNextDraw).
	drawing func()
	// pressable draws the scene as one button that records each click (Pressable).
	pressable bool
	// recorded holds the functions that OnRecord added, each called after each record.
	recorded map[uint64]func()
	next     uint64
}

// OnRecord calls fn after each record of the workbench and returns the function that removes it.
func (w *SceneWorkbench) OnRecord(fn func()) (off func()) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.recorded == nil {
		w.recorded = make(map[uint64]func())
	}
	w.next++
	id := w.next
	w.recorded[id] = fn
	return func() {
		w.mu.Lock()
		defer w.mu.Unlock()
		delete(w.recorded, id)
	}
}

// InNextDraw has the next draw of the scene run step while it builds the frame, as the workbench of the application opens the layout
// of the frame that draws other surface lines (OpenLayout of the framework adapter).
func (w *SceneWorkbench) InNextDraw(step func()) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.drawing = step
}

// Pressable draws the scene of the windows built after it as one button over the window, which records `click <window>` in the
// frame that reads its click.
func (w *SceneWorkbench) Pressable() {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.pressable = true
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
	w.records = append(w.records, fmt.Sprintf(format, values...))
	recorded := make([]func(), 0, len(w.recorded))
	for _, fn := range w.recorded {
		recorded = append(recorded, fn)
	}
	w.mu.Unlock()
	for _, fn := range recorded {
		fn()
	}
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
		w.mu.Lock()
		step := w.drawing
		w.drawing = nil
		w.mu.Unlock()
		if step != nil {
			step()
		}
		w.mu.Lock()
		pressable := w.pressable
		w.mu.Unlock()
		if pressable {
			if ui.ButtonBase(c).Grow(1).Label("scene").Clicked() {
				w.Record("click %s", window.Name())
			}
			return
		}
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

// Subscribe adds fn to an event and returns the function that removes it, as the event methods of a window of the framework
// (OnShow) and OnRecord of the fixture workbench do.
type Subscribe func(fn func()) (off func())

// Wait returns once condition holds. It reads condition at once and again after each event of sources, the events that change
// what condition reads; it subscribes before the first read, so no event between the read and the wait is lost. A condition
// that never holds leaves the check to the limit of its runner, and the log of the check names what it waited for.
func Wait(t *testing.T, what string, condition func() bool, sources ...Subscribe) {
	t.Helper()
	if len(sources) == 0 {
		t.Fatalf("the wait for %s names no event", what)
	}
	changed := make(chan struct{}, 1)
	for _, source := range sources {
		off := source(func() {
			select {
			case changed <- struct{}{}:
			default:
			}
		})
		defer off()
	}
	if condition() {
		return
	}
	t.Logf("waiting for %s", what)
	for !condition() {
		<-changed
	}
}

// Poll returns once condition holds, for a state of which no event reports a change, which reason names; it reads condition at
// each display refresh. A condition that never holds leaves the check to the limit of its runner.
func Poll(t *testing.T, what, reason string, condition func() bool) {
	t.Helper()
	if condition() {
		return
	}
	t.Logf("waiting for %s, read at each display refresh because %s", what, reason)
	for !condition() {
		time.Sleep(time.Second / 60)
	}
}

// Changes is the source of Wait of the changes of the entries of directory: fsnotify reports each creation, write, rename and
// removal of an entry. The watch ends with the test.
func Changes(t *testing.T, directory string) Subscribe {
	t.Helper()
	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		t.Fatal(err)
	}
	if err := watcher.Add(directory); err != nil {
		t.Fatal(errors.Join(fmt.Errorf("watch %s: %w", directory, err), watcher.Close()))
	}
	var (
		mu        sync.Mutex
		listeners = map[uint64]func(){}
		next      uint64
	)
	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			select {
			case _, open := <-watcher.Events:
				if !open {
					return
				}
				mu.Lock()
				called := make([]func(), 0, len(listeners))
				for _, fn := range listeners {
					called = append(called, fn)
				}
				mu.Unlock()
				for _, fn := range called {
					fn()
				}
			case err, open := <-watcher.Errors:
				if !open {
					return
				}
				t.Errorf("watch %s: %v", directory, err)
			}
		}
	}()
	t.Cleanup(func() {
		if err := watcher.Close(); err != nil {
			t.Errorf("end the watch of %s: %v", directory, err)
		}
		<-done
	})
	return func(fn func()) func() {
		mu.Lock()
		defer mu.Unlock()
		next++
		id := next
		listeners[id] = fn
		return func() {
			mu.Lock()
			defer mu.Unlock()
			delete(listeners, id)
		}
	}
}

// OnClosed is the source of Wait of the close of ended, as the end of a child process.
func OnClosed(ended <-chan struct{}) Subscribe {
	return func(fn func()) func() {
		off := make(chan struct{})
		go func() {
			select {
			case <-ended:
				fn()
			case <-off:
			}
		}()
		return func() { close(off) }
	}
}

// NextFrame returns the answer of a notice of the next frame of window. The main thread runs its queue in order, so the requests
// that the caller made before (Invalidate) run before the notice: a window that holds its frames answers at once (mygo.PresentHeld),
// and one that does not answers with the frame of a request.
func NextFrame(t *testing.T, window *adapter.Frontend) mygo.Presentation {
	t.Helper()
	answered := make(chan mygo.Presentation, 1)
	err := window.Window().AfterPresent(func(presented mygo.Presentation, failure error) {
		if failure != nil {
			t.Errorf("the notice of the frame of %s failed: %v", window.Name(), failure)
		}
		answered <- presented
	})
	if err != nil {
		t.Fatalf("the notice of the frame of %s: %v", window.Name(), err)
	}
	return <-answered
}

// HoldsFrames fails unless the answer of the next frame of window (NextFrame) is that the window holds its frames.
func HoldsFrames(t *testing.T, window *adapter.Frontend) {
	t.Helper()
	if presented := NextFrame(t, window); presented != mygo.PresentHeld {
		t.Fatalf("window %s presented a frame (%v) while it holds its frames", window.Name(), presented)
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

// The setup of a host that a test starts (docs/spec/cli.md#agents-in-the-application): after the start of its first window the
// host runs `<sok> setup environment` of its bundle through the login shell of the person and brings the agent skill current in
// that environment. A test gives the host a HOME of its own, so the login shell reads no start file of the person and the setup
// writes no file of the person, and puts beside the executable of the host a sok that answers as the setup contract states: one
// JSON line of HOME, PATH, CLAUDE_CONFIG_DIR and the environment of these variables with that HOME, which holds no agent folder, so the
// host logs no error; the environment is the base of the sidecars of the host.

// installSetupSok links the sidecar fixture program of the repository (docs/spec/cases/sidecars/fixture.sh) as the sok of folder and
// writes its control file, which answers `sok setup environment` with home. A sok or a control file already in folder is an error.
func installSetupSok(folder, home string) error {
	// The program is found from this file: support, tests, mygo, host, packages and the repository root.
	_, here, _, ok := runtime.Caller(0)
	if !ok {
		return errors.New("the source file of the support package is unknown")
	}
	program := filepath.Join(filepath.Dir(here), "..", "..", "..", "..", "..", "docs", "spec", "cases", "sidecars", "fixture.sh")
	if _, err := os.Stat(program); err != nil {
		return err
	}
	environment, err := json.Marshal(map[string]any{"HOME": home, "PATH": "/usr/bin:/bin", "CLAUDE_CONFIG_DIR": nil,
		"environment": map[string]string{"HOME": home, "PATH": "/usr/bin:/bin"}})
	if err != nil {
		return err
	}
	for _, name := range []string{"sok", "control"} {
		_, err := os.Lstat(filepath.Join(folder, name))
		if err == nil {
			return fmt.Errorf("%s holds %s already", folder, name)
		}
		if !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	link := filepath.Join(folder, "sok")
	if err := os.Symlink(program, link); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(folder, "control"), []byte("write "+string(environment)+"\nexit 0\n"), 0o644); err != nil {
		return errors.Join(err, os.Remove(link))
	}
	return nil
}

// Bundled returns the executable of a bundle that holds this test binary, because the notification center of a run requires a bundle,
// and the HOME entry of the environment of the child application. The bundle holds the sok of the setup, which answers with that
// HOME, a folder of the test without an agent folder.
func Bundled(t *testing.T) (executable, home string) {
	t.Helper()
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	folder := t.TempDir()
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
	if err := installSetupSok(filepath.Dir(inside), folder); err != nil {
		t.Fatal(err)
	}
	return inside, "HOME=" + folder
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

// ChildTemporary returns the TMPDIR entry of the environment of a child application: a short folder of the test, removed when the
// test ends. The host keeps its socket folder `soksak` in the temporary folder across its runs (host.SocketDirectory), so a child
// that starts the host writes that folder into the temporary folder that it receives. The name is short because a socket path holds
// at most 103 bytes (docs/spec/host-contract.md, endpoint.socket.path-over-limit).
func ChildTemporary(t *testing.T) string {
	t.Helper()
	folder, err := hostTemporary()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.RemoveAll(folder); err != nil {
			t.Errorf("cannot remove %s: %v", folder, err)
		}
	})
	return "TMPDIR=" + folder
}

// HostSetup gives a host that a test starts in its own process what Bundled gives a child application: it sets HOME of the
// process to a new folder and puts the sok of the setup beside the executable of the process, which is the folder of the bundle
// of that host. The returned end removes the sok and its control file, sets HOME back and removes the folder; the process calls it
// after the host ended.
func HostSetup() (end func() error, err error) {
	executable, err := os.Executable()
	if err != nil {
		return nil, err
	}
	if executable, err = filepath.EvalSymlinks(executable); err != nil {
		return nil, err
	}
	folder, err := os.MkdirTemp("", "soksak-home")
	if err != nil {
		return nil, err
	}
	bundle := filepath.Dir(executable)
	if err := installSetupSok(bundle, folder); err != nil {
		return nil, errors.Join(err, os.RemoveAll(folder))
	}
	previous, set := os.LookupEnv("HOME")
	if err := os.Setenv("HOME", folder); err != nil {
		return nil, errors.Join(err, os.Remove(filepath.Join(bundle, "sok")), os.Remove(filepath.Join(bundle, "control")), os.RemoveAll(folder))
	}
	return func() error {
		var restored error
		if set {
			restored = os.Setenv("HOME", previous)
		} else {
			restored = os.Unsetenv("HOME")
		}
		return errors.Join(restored, os.Remove(filepath.Join(bundle, "sok")), os.Remove(filepath.Join(bundle, "control")), os.RemoveAll(folder))
	}, nil
}

// HostTemporary gives a host that a test starts in its own process the short temporary folder that ChildTemporary gives a child
// application: it sets TMPDIR of the process to a new folder, so the host makes its socket folder `soksak` there. The returned end
// sets TMPDIR back and removes the folder; the process calls it after the host ended.
func HostTemporary() (end func() error, err error) {
	folder, err := hostTemporary()
	if err != nil {
		return nil, err
	}
	previous, set := os.LookupEnv("TMPDIR")
	if err := os.Setenv("TMPDIR", folder); err != nil {
		os.RemoveAll(folder)
		return nil, err
	}
	return func() error {
		if set {
			os.Setenv("TMPDIR", previous)
		} else {
			os.Unsetenv("TMPDIR")
		}
		return os.RemoveAll(folder)
	}, nil
}

// hostTemporary creates the short temporary folder of a host that a test starts. The name is short because a socket path holds at
// most 103 bytes.
func hostTemporary() (string, error) { return os.MkdirTemp("", "ct") }
