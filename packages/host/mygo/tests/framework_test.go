package adapter_test

// Checks the framework port of the mygo framework adapter with a fixture workbench that draws one fixed scene and records each
// event that it receives (docs/spec/hosts.md#mygo-host). The tests run in the application of the framework on the main thread, as
// the host does, with the prohibited activation policy, so they take no activation and show no Dock icon. The tests that need a
// presented frame carry the build constraint e2e (presentation_test.go, launch_activation_test.go).

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"syscall"
	"testing"
	"testing/fstest"
	"time"
	"unsafe"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"

	host "github.com/soksak-app/core/packages/host/go/src"
	"github.com/soksak-app/core/packages/host/go/src/platform"
	adapter "github.com/soksak-app/core/packages/host/mygo/src"
)

var (
	_ host.Framework = (*adapter.Framework)(nil)
	_ host.Frontend  = (*adapter.Frontend)(nil)
)

// quitHelper names the child process of the quit test.
const quitHelper = "SOKSAK_MYGO_QUIT_HELPER"

// applicationHelper names the child process that runs the application; its value is the configuration directory.
const applicationHelper = "SOKSAK_MYGO_APPLICATION_HELPER"

// helpers holds the child processes of the tests, by the name of the variable that selects one.
var helpers = map[string]func(){quitHelper: runQuitHelper, applicationHelper: runApplicationHelper}

// TestMain runs the application of the framework on the main thread. The tests start when the application finished launching, and
// the process ends with their status.
func TestMain(m *testing.M) {
	for name, helper := range helpers {
		if os.Getenv(name) != "" {
			helper()
			return
		}
	}
	adapter.ConfigureApplication()
	mygo.App.SetActivationPolicy(mygo.ActivationPolicyProhibited)
	mygo.App.WhenReady(func() { go func() { os.Exit(m.Run()) }() })
	if err := mygo.App.Run(); err != nil {
		fmt.Fprintln(os.Stderr, "the application did not run:", err)
		os.Exit(1)
	}
	fmt.Fprintln(os.Stderr, "the application ended before the tests ended")
	os.Exit(1)
}

// runQuitHelper quits through the framework adapter and reports that the application ended after its quit listeners ran.
func runQuitHelper() {
	adapter.ConfigureApplication()
	mygo.App.SetActivationPolicy(mygo.ActivationPolicyProhibited)
	mygo.App.OnQuit(func() { fmt.Println("quit listener") })
	mygo.App.WhenReady(func() { go adapter.NewFramework(&sceneWorkbench{}).Quit() })
	if err := mygo.App.Run(); err != nil {
		fmt.Fprintln(os.Stderr, "the application did not run:", err)
		os.Exit(1)
	}
	fmt.Println("application ended")
}

// runApplicationHelper runs the application of the framework adapter with the fixture workbench and a fixture frontend.
func runApplicationHelper() {
	assets := fstest.MapFS{
		"frontend/core-root.json":                           {Data: []byte("[]")},
		"frontend/view-imports.json":                        {Data: []byte(`{"imports":{}}`)},
		"frontend/modules/@soksak/plugin-api/view-start.js": {Data: []byte("")},
	}
	mygo.App.SetActivationPolicy(mygo.ActivationPolicyProhibited)
	if err := adapter.Run(assets, host.Options{ConfigDir: os.Getenv(applicationHelper)}, &sceneWorkbench{}); err != nil {
		fmt.Fprintln(os.Stderr, "the application failed:", err)
		os.Exit(1)
	}
}

// sceneWorkbench is the fixture workbench: it draws one fixed scene and records what it receives.
type sceneWorkbench struct {
	mu      sync.Mutex
	records []string
}

func (w *sceneWorkbench) record(format string, values ...any) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.records = append(w.records, fmt.Sprintf(format, values...))
}

func (w *sceneWorkbench) received() []string {
	w.mu.Lock()
	defer w.mu.Unlock()
	return slices.Clone(w.records)
}

func (w *sceneWorkbench) Prepared(*host.Host) {}

func (w *sceneWorkbench) Shown(host.Frontend) {}

func (w *sceneWorkbench) Build(window host.Frontend) func(c *ui.Context) {
	w.record("build %s", window.Name())
	return func(c *ui.Context) {
		w.record("draw %s", window.Name())
		ui.Text(c, "scene")
	}
}

func (w *sceneWorkbench) Close(window host.Frontend) { w.record("close %s", window.Name()) }

func (w *sceneWorkbench) Emit(window host.Frontend, name string, data ...any) {
	w.record("event %s %s %v", window.Name(), name, data)
}

func (w *sceneWorkbench) Call(window host.Frontend, script string) {
	w.record("call %s %s", window.Name(), script)
}

// wait waits for condition, which an event of the framework makes true, within the limit of a test.
func wait(t *testing.T, what string, condition func() bool) {
	t.Helper()
	for limit := time.Now().Add(10 * time.Second); !condition(); time.Sleep(5 * time.Millisecond) {
		if time.Now().After(limit) {
			t.Fatalf("%s did not happen within 10 s", what)
		}
	}
}

// open creates a window of a fixture workbench, which the test destroys at its end.
func open(t *testing.T, name string) (*adapter.Framework, *sceneWorkbench, *adapter.Frontend) {
	t.Helper()
	workbench := &sceneWorkbench{}
	framework := adapter.NewFramework(workbench)
	window := framework.NewWindow(host.WindowOptions{Name: name, Title: "soksak", Width: 400, Height: 300}).(*adapter.Frontend)
	t.Cleanup(window.Window().Destroy)
	return framework, workbench, window
}

// contract: application.framework.names-the-application
func TestTheMygoFrameworkNamesTheApplicationOfTheEndpoint(t *testing.T) {
	framework := adapter.NewFramework(&sceneWorkbench{})
	if name := framework.ApplicationName(); name != "mygo" {
		t.Fatalf("application name %q, want mygo", name)
	}
	if name := framework.DisplayName(); name != "mygo" {
		t.Fatalf("display name %q, want mygo", name)
	}
	if framework.MainPage() {
		t.Fatal("the mygo framework reports a main page")
	}
}

// The adapter installs both main-thread functions, so the start of the library passes its check of them without a test function.
func TestTheAdapterInstallsBothMainThreadFunctions(t *testing.T) {
	system, err := platform.Current()
	if err != nil {
		t.Fatal(err)
	}
	if err := system.RequireMainThread(); err != nil {
		t.Fatal(err)
	}
}

// The port gives logical lengths as float64 and the framework holds integers, so the adapter takes the nearest integer.
func TestALogicalLengthOfThePortIsTheNearestIntegerOfTheFramework(t *testing.T) {
	for length, want := range map[float64]int{1200: 1200, 1200.4: 1200, 1200.5: 1201, -10.6: -11} {
		if got := adapter.Pixels(length); got != want {
			t.Errorf("%v is %d pixels of the framework, want %d", length, got, want)
		}
	}
}

func TestTheStartWithoutAWorkbenchFails(t *testing.T) {
	err := adapter.Run(nil, host.Options{}, nil)
	if !errors.Is(err, adapter.ErrNoWorkbench) || err.Error() != "no workbench is installed" {
		t.Fatalf("the start without a workbench returned %v", err)
	}
}

func TestStepAndPostRunOnTheMainThreadInOrder(t *testing.T) {
	framework := adapter.NewFramework(&sceneWorkbench{})
	var order []string
	done := make(chan struct{})
	framework.Step(func() {
		framework.Post(func() { order = append(order, "first post") })
		framework.Post(func() {
			order = append(order, "second post")
			close(done)
		})
		order = append(order, "step")
	})
	<-done
	if want := []string{"step", "first post", "second post"}; !slices.Equal(order, want) {
		t.Fatalf("the tasks ran in the order %v, want %v", order, want)
	}
}

func TestQuitEndsTheApplicationThroughItsQuitListeners(t *testing.T) {
	child := exec.Command(os.Args[0])
	child.Env = append(os.Environ(), quitHelper+"=1")
	output, err := child.CombinedOutput()
	if err != nil {
		t.Fatalf("the child failed: %v\n%s", err, output)
	}
	if !strings.Contains(string(output), "quit listener\napplication ended") {
		t.Fatalf("the child reported %q", output)
	}
}

// bundled returns the executable of a bundle that holds this test binary, because the notification center of a run requires a bundle.
func bundled(t *testing.T) string {
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

// logged returns the standard error and the crash output that the application wrote to its log folder. A fatal error of the Go
// runtime writes only to the crash output, and the folder ends with the test (docs/spec/logging.md#files).
func logged(config string) string {
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

// contract: application.framework.names-the-application
func TestARunPublishesTheEndpointWritesItsLogAndQuitsOnASignal(t *testing.T) {
	config := t.TempDir()
	child := exec.Command(bundled(t))
	child.Env = append(os.Environ(), applicationHelper+"="+config)
	var output bytes.Buffer
	child.Stdout, child.Stderr = &output, &output
	if err := child.Start(); err != nil {
		t.Fatal(err)
	}
	ended := make(chan error, 1)
	go func() { ended <- child.Wait() }()
	var endpoint host.EndpointInfo
	for limit := time.Now().Add(10 * time.Second); ; time.Sleep(10 * time.Millisecond) {
		data, err := os.ReadFile(filepath.Join(config, "endpoint.json"))
		if err == nil && json.Unmarshal(data, &endpoint) == nil {
			break
		}
		select {
		case failure := <-ended:
			t.Fatalf("the application ended before it published its endpoint: %v\n%s%s", failure, output.String(), logged(config))
		default:
		}
		if time.Now().After(limit) {
			child.Process.Kill()
			t.Fatalf("endpoint.json did not appear within 10 s\n%s%s", output.String(), logged(config))
		}
	}
	if endpoint.Application != "mygo" || endpoint.PID != child.Process.Pid {
		t.Fatalf("the endpoint names %+v", endpoint)
	}
	// The host owns the signal: one quit runs through the framework, and the process ends with the status of a normal quit.
	if err := child.Process.Signal(syscall.SIGTERM); err != nil {
		t.Fatal(err)
	}
	select {
	case failure := <-ended:
		if failure != nil {
			t.Fatalf("the application ended with %v after the signal\n%s%s", failure, output.String(), logged(config))
		}
	case <-time.After(10 * time.Second):
		child.Process.Kill()
		t.Fatalf("the application did not end within 10 s of the signal\n%s%s", output.String(), logged(config))
	}
	records, err := filepath.Glob(filepath.Join(config, "logs", "host-*.jsonl"))
	if err != nil || len(records) == 0 {
		t.Fatalf("the application log has no event file: %v, %v", records, err)
	}
	var log strings.Builder
	for _, file := range records {
		data, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		log.Write(data)
	}
	for _, cause := range []string{`"cause":"signal"`, `"cause":"exit-request"`, `"cause":"exit"`} {
		if count := strings.Count(log.String(), cause); count != 1 {
			t.Fatalf("the application log holds %s %d times:\n%s", cause, count, log.String())
		}
	}
	if strings.Contains(log.String(), "host.record.error") {
		t.Fatalf("the application log holds an error:\n%s", log.String())
	}
	stderr, err := filepath.Glob(filepath.Join(config, "logs", "host-*.stderr"))
	if err != nil || len(stderr) != 1 {
		t.Fatalf("the application log has no stderr file: %v, %v", stderr, err)
	}
	info, err := os.Stat(stderr[0])
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("the stderr file %v, %v", info, err)
	}
}

func TestDialogsAttachToTheWindow(t *testing.T) {
	_, _, window := open(t, "dialogs")
	folder := adapter.FolderDialog(window.Window(), "프로젝트 폴더 선택")
	if folder.Parent != window.Window() || folder.Title != "프로젝트 폴더 선택" || !folder.Directory || folder.Multiple || !folder.CreateDirectories {
		t.Fatalf("folder panel %+v", folder)
	}
	save := adapter.SaveDialog(window.Window(), "name.txt", "/folder")
	if save.Parent != window.Window() || save.DefaultPath != "/folder/name.txt" || !save.CreateDirectories {
		t.Fatalf("save panel %+v", save)
	}
	if path := adapter.SaveDialog(window.Window(), "name.txt", "").DefaultPath; path != "name.txt" {
		t.Fatalf("save panel without a folder starts at %q", path)
	}
}

func TestTheDockMenuHasTheNewWindowItem(t *testing.T) {
	framework := adapter.NewFramework(&sceneWorkbench{})
	opened := make(chan struct{}, 1)
	if err := framework.InstallDock(func() { opened <- struct{}{} }); err != nil {
		t.Fatal(err)
	}
	items := mygo.App.Dock.Menu().Items()
	if len(items) != 1 || items[0].Label != adapter.DockNewWindow {
		t.Fatalf("the Dock menu has %d items", len(items))
	}
	items[0].Click(items[0], nil)
	<-opened
}

func TestAWindowStartsHiddenWithItsWorkbench(t *testing.T) {
	framework, workbench, window := open(t, "main")
	if window.Name() != "main" || window.ID() == 0 {
		t.Fatalf("window %q with the identifier %d", window.Name(), window.ID())
	}
	if window.Window().IsVisible() {
		t.Fatal("a new window is visible before the host shows it")
	}
	if window.NativeWindow() == nil {
		t.Fatal("a new window has no native window")
	}
	if got := window.Window().Title(); got != "soksak" {
		t.Fatalf("title %q", got)
	}
	if got := framework.Windows(); len(got) != 1 || got[0] != host.Frontend(window) {
		t.Fatalf("the open windows are %v", got)
	}
	if width, height := window.Size(); width != 400 || height != 300 {
		t.Fatalf("size %v×%v", width, height)
	}
	if !slices.Contains(workbench.received(), "build main") {
		t.Fatalf("the workbench received %v", workbench.received())
	}
}

func TestTheTitleOfTheWindowChanges(t *testing.T) {
	_, _, window := open(t, "title")
	window.SetTitle("next")
	if got := window.Window().Title(); got != "next" {
		t.Fatalf("title %q", got)
	}
}

func TestEventsAndCallsReachTheWorkbenchOfTheWindow(t *testing.T) {
	_, workbench, window := open(t, "events")
	window.Emit("theme", "dark", 1)
	window.CallWorkbench("window.__soksakBackground = true")
	received := workbench.received()
	for _, want := range []string{"event events theme [dark 1]", "call events window.__soksakBackground = true"} {
		if !slices.Contains(received, want) {
			t.Fatalf("the workbench received %v, want %q", received, want)
		}
	}
}

func TestSizeAndPositionOfTheWindow(t *testing.T) {
	_, _, window := open(t, "bounds")
	resized := make(chan struct{}, 8)
	moved := make(chan struct{}, 8)
	window.OnWindowEvent(host.WindowResize, func() { resized <- struct{}{} })
	window.OnWindowEvent(host.WindowMove, func() { moved <- struct{}{} })
	window.SetSize(500, 320)
	<-resized
	if width, height := window.Size(); width != 500 || height != 320 {
		t.Fatalf("size %v×%v", width, height)
	}
	window.SetPosition(40, 60)
	<-moved
	if x, y := window.Position(); x != 40 || y != 60 {
		t.Fatalf("position %v, %v", x, y)
	}
}

func TestMaximizeAndItsState(t *testing.T) {
	_, _, window := open(t, "maximise")
	if window.IsMaximized() || window.IsFullscreen() || window.IsMinimized() {
		t.Fatal("a new window is maximised, in full screen or minimised")
	}
	window.Maximize()
	wait(t, "the maximize", window.IsMaximized)
	window.Unmaximize()
	wait(t, "the restore", func() bool { return !window.IsMaximized() })
}

// contract: application.framework.window-events-are-port-events
func TestEachWindowEventOfTheFrontendIsAnEventOfMygo(t *testing.T) {
	_, _, window := open(t, "sources")
	for _, event := range []host.WindowEvent{host.WindowResize, host.WindowMove, host.WindowFocus, host.WindowFocusLost, host.WindowShow, host.WindowHide} {
		if !adapter.WindowEventSource(window.Window(), event, func() {}) {
			t.Errorf("the window event %d has no event of mygo", event)
		}
	}
	for _, event := range []host.WindowEvent{host.WindowWorkbenchEnded, host.WindowWorkbenchCommitted} {
		if adapter.WindowEventSource(window.Window(), event, func() {}) {
			t.Errorf("the workbench event %d has an event of mygo, and no process or navigation of a mygo workbench ends", event)
		}
	}
}

func TestAClosingHookKeepsOrClosesTheWindow(t *testing.T) {
	framework, workbench, window := open(t, "closing")
	keep := true
	window.OnClosing(func() bool { return keep })
	window.Close()
	if window.NativeWindow() == nil {
		t.Fatal("a hook that keeps the window closed it")
	}
	keep = false
	window.Close()
	if window.NativeWindow() != nil {
		t.Fatal("a hook that lets the window close kept it")
	}
	if got := framework.Windows(); len(got) != 0 {
		t.Fatalf("the open windows are %v", got)
	}
	if !slices.Contains(workbench.received(), "close closing") {
		t.Fatalf("the workbench received %v", workbench.received())
	}
}

func TestStartWorkbenchClosesAndBuildsTheWorkbench(t *testing.T) {
	_, workbench, window := open(t, "restart")
	window.StartWorkbench()
	received := workbench.received()
	close, build := slices.Index(received, "close restart"), slices.Index(received[1:], "build restart")
	if close < 0 || build < 0 || build+1 < close {
		t.Fatalf("the workbench received %v, want a close before a second build", received)
	}
}

func TestTheLayoutObserverReportsTheTransactionOfAWindow(t *testing.T) {
	_, _, window := open(t, "layout")
	system, err := platform.Current()
	if err != nil {
		t.Fatal(err)
	}
	native := window.NativeWindow()
	reports := make(chan string, 8)
	report := func(what string) func(unsafe.Pointer) {
		return func(reported unsafe.Pointer) {
			if reported != native {
				t.Errorf("%s reported another window", what)
			}
			reports <- what
		}
	}
	mygo.RunOnMain(func() { err = system.ObserveLayout(report("started"), report("ended")) })
	if err != nil {
		t.Fatal(err)
	}
	ready := make(chan bool, 1)
	mygo.RunOnMain(func() { err = system.BeginLayout(native, 1, func(allowed bool) { ready <- allowed }) })
	if err != nil {
		t.Fatal(err)
	}
	if !<-ready {
		t.Fatal("the transaction of the window did not start")
	}
	if got := <-reports; got != "started" {
		t.Fatalf("the first report is %q", got)
	}
	var committed bool
	mygo.RunOnMain(func() { committed = system.CommitLayout(native, 1) })
	if !committed {
		t.Fatal("the transaction of the window did not commit")
	}
	if got := <-reports; got != "ended" {
		t.Fatalf("the second report is %q", got)
	}
}
