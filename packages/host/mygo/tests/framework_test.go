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
	"syscall"
	"testing"
	"testing/fstest"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"

	host "github.com/soksak-app/core/packages/host/go/src"
	"github.com/soksak-app/core/packages/host/go/src/platform"
	adapter "github.com/soksak-app/core/packages/host/mygo/src"
	"github.com/soksak-app/core/packages/host/mygo/tests/support"
	workbench "github.com/soksak-app/core/packages/workbench-mygo/src"
)

var (
	_ host.Framework = (*adapter.Framework)(nil)
	_ host.Frontend  = (*adapter.Frontend)(nil)
	// The workbench of the application draws in the windows of the adapter.
	_ workbench.Painted = (*adapter.Frontend)(nil)
)

// quitHelper names the child process of the quit test.
const quitHelper = "SOKSAK_MYGO_QUIT_HELPER"

// applicationHelper names the child process that runs the application; its value is the configuration directory.
const applicationHelper = "SOKSAK_MYGO_APPLICATION_HELPER"

// helpers holds the child processes of the tests, by the name of the variable that selects one.
var helpers = map[string]func(){quitHelper: runQuitHelper, applicationHelper: runApplicationHelper}

// TestMain runs the application of the framework on the main thread. The tests start when the application finished launching, and
// the process ends with their status.
func TestMain(m *testing.M) { support.Main(m, helpers, func() {}) }

// runQuitHelper quits through the framework adapter and reports that the application ended after its quit listeners ran.
func runQuitHelper() {
	adapter.ConfigureApplication()
	mygo.App.SetActivationPolicy(mygo.ActivationPolicyProhibited)
	mygo.App.OnQuit(func() { fmt.Println("quit listener") })
	mygo.App.WhenReady(func() { go adapter.NewFramework(&support.SceneWorkbench{}).Quit() })
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
	if err := adapter.Run(assets, host.Options{ConfigDir: os.Getenv(applicationHelper)}, &support.SceneWorkbench{}); err != nil {
		fmt.Fprintln(os.Stderr, "the application failed:", err)
		os.Exit(1)
	}
}

// contract: application.framework.names-the-application
func TestTheMygoFrameworkNamesTheApplicationOfTheEndpoint(t *testing.T) {
	framework := adapter.NewFramework(&support.SceneWorkbench{})
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

// The test application owns the same explicit provider startup boundary as the
// production host. A selected pure framework test must not bypass a broken
// native installation merely because its body does not invoke native code.
// contract: mygo.test-application.native-startup-failure-precedes-the-tests
func TestTheTestApplicationReportsNativeStartupFailureBeforeRunningSelectedTests(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	library := filepath.Join(t.TempDir(), "missing-native-library.dylib")
	if !filepath.IsAbs(library) {
		t.Fatalf("test library path is not absolute: %s", library)
	}
	// A child that does not end leaves the check to the limit of its runner, which ends the processes of the check.
	command := exec.Command(executable, "-test.run=^TestTheMygoFrameworkNamesTheApplicationOfTheEndpoint$", "-test.v")
	// A startup test must not accidentally enter a helper selected in its parent.
	for _, entry := range os.Environ() {
		name, _, _ := strings.Cut(entry, "=")
		if _, helper := helpers[name]; !helper && name != "SOKSAK_NATIVE_LIBRARY" {
			command.Env = append(command.Env, entry)
		}
	}
	command.Env = append(command.Env, "SOKSAK_NATIVE_LIBRARY="+library)
	output, err := command.CombinedOutput()
	if err == nil {
		t.Fatalf("selected framework test bypassed the invalid native provider:\n%s", output)
	}
	text := string(output)
	if !strings.Contains(text, "native library "+library) {
		t.Fatalf("native startup failure did not name its library: %v\n%s", err, output)
	}
	if strings.Contains(text, "panic:") || strings.Contains(text, "PASS: TestTheMygoFrameworkNamesTheApplicationOfTheEndpoint") {
		t.Fatalf("native startup failure panicked or ran the selected test:\n%s", output)
	}
}

// The adapter installs both main-thread functions, so the start of the library passes its check of them without a test function.
// contract: host.main-thread.start-requires-both-functions
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
// contract: application.framework.lengths-are-logical-pixels
func TestALogicalLengthOfThePortIsTheNearestIntegerOfTheFramework(t *testing.T) {
	for length, want := range map[float64]int{1200: 1200, 1200.4: 1200, 1200.5: 1201, -10.6: -11} {
		if got := adapter.Pixels(length); got != want {
			t.Errorf("%v is %d pixels of the framework, want %d", length, got, want)
		}
	}
}

// contract: mygo.framework.start-builds-the-workbench
func TestTheStartWithoutAWorkbenchFails(t *testing.T) {
	err := adapter.Run(nil, host.Options{}, nil)
	if !errors.Is(err, adapter.ErrNoWorkbench) || err.Error() != "no workbench is installed" {
		t.Fatalf("the start without a workbench returned %v", err)
	}
}

// contract: mygo.framework.steps-and-quit
func TestStepAndPostRunOnTheMainThreadInOrder(t *testing.T) {
	framework := adapter.NewFramework(&support.SceneWorkbench{})
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

// contract: mygo.framework.steps-and-quit
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

// contract: application.framework.names-the-application
func TestARunPublishesTheEndpointWritesItsLogAndQuitsOnASignal(t *testing.T) {
	config := t.TempDir()
	child := exec.Command(support.Bundled(t))
	child.Env = append(os.Environ(), applicationHelper+"="+config, support.ChildTemporary(t))
	var output bytes.Buffer
	child.Stdout, child.Stderr = &output, &output
	if err := child.Start(); err != nil {
		t.Fatal(err)
	}
	ended, exited := make(chan error, 1), make(chan struct{})
	go func() {
		ended <- child.Wait()
		close(exited)
	}()
	var endpoint host.EndpointInfo
	support.Wait(t, "endpoint.json or the end of the application", func() bool {
		data, err := os.ReadFile(filepath.Join(config, "endpoint.json"))
		if err == nil && json.Unmarshal(data, &endpoint) == nil {
			return true
		}
		select {
		case <-exited:
			return true
		default:
			return false
		}
	}, support.Changes(t, config), support.OnClosed(exited))
	select {
	case <-exited:
		if endpoint.PID == 0 {
			t.Fatalf("the application ended before it published its endpoint: %v\n%s%s", <-ended, output.String(), support.Logged(config))
		}
	default:
	}
	if endpoint.Application != "mygo" || endpoint.PID != child.Process.Pid {
		t.Fatalf("the endpoint names %+v", endpoint)
	}
	// The host owns the signal: one quit runs through the framework, and the process ends with the status of a normal quit.
	if err := child.Process.Signal(syscall.SIGTERM); err != nil {
		t.Fatal(err)
	}
	// An application that does not end leaves the check to the limit of its runner.
	failure := <-ended
	if failure != nil {
		t.Fatalf("the application ended with %v after the signal\n%s%s", failure, output.String(), support.Logged(config))
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

// contract: mygo.framework.window-operations
func TestDialogsAttachToTheWindow(t *testing.T) {
	_, _, window := support.Open(t, "dialogs")
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

// contract: mygo.framework.dock-menu-has-the-new-window-item
func TestTheDockMenuHasTheNewWindowItem(t *testing.T) {
	framework := adapter.NewFramework(&support.SceneWorkbench{})
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

// contract: mygo.framework.start-builds-the-workbench
func TestAWindowStartsHiddenWithItsWorkbench(t *testing.T) {
	framework, workbench, window := support.Open(t, "main")
	if window.Name() != "main" || window.ID() == 0 {
		t.Fatalf("window %q with the identifier %d", window.Name(), window.ID())
	}
	if window.Window().IsVisible() {
		t.Fatal("a new window is visible before the host shows it")
	}
	if window.NativeWindow() == 0 {
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
	if !slices.Contains(workbench.Received(), "build main") {
		t.Fatalf("the workbench received %v", workbench.Received())
	}
}

// contract: mygo.framework.window-operations
func TestTheTitleOfTheWindowChanges(t *testing.T) {
	_, _, window := support.Open(t, "title")
	window.SetTitle("next")
	if got := window.Window().Title(); got != "next" {
		t.Fatalf("title %q", got)
	}
}

// contract: mygo.framework.events-and-calls-reach-the-workbench
func TestEventsAndCallsReachTheWorkbenchOfTheWindow(t *testing.T) {
	_, workbench, window := support.Open(t, "events")
	window.Emit("theme", "dark", 1)
	window.CallWorkbench("window.__soksakBackground = true")
	received := workbench.Received()
	for _, want := range []string{"event events theme [dark 1]", "call events window.__soksakBackground = true"} {
		if !slices.Contains(received, want) {
			t.Fatalf("the workbench received %v, want %q", received, want)
		}
	}
}

// contract: mygo.framework.window-operations
func TestSizeAndPositionOfTheWindow(t *testing.T) {
	_, _, window := support.Open(t, "bounds")
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

// contract: mygo.framework.window-operations
func TestMaximizeAndItsState(t *testing.T) {
	_, _, window := support.Open(t, "maximise")
	if window.IsMaximized() || window.IsFullscreen() || window.IsMinimized() {
		t.Fatal("a new window is maximised, in full screen or minimised")
	}
	window.Maximize()
	support.Wait(t, "the maximize", window.IsMaximized, window.Window().OnMaximize)
	window.Unmaximize()
	support.Wait(t, "the restore", func() bool { return !window.IsMaximized() }, window.Window().OnUnmaximize)
}

// contract: application.framework.window-events-are-port-events
func TestEachWindowEventOfTheFrontendIsAnEventOfMygo(t *testing.T) {
	_, _, window := support.Open(t, "sources")
	for _, event := range []host.WindowEvent{host.WindowResize, host.WindowMove, host.WindowFocus, host.WindowFocusLost, host.WindowShow, host.WindowHide, host.WindowScaleChanged} {
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

// contract: mygo.framework.window-operations
func TestAClosingHookKeepsOrClosesTheWindow(t *testing.T) {
	framework, workbench, window := support.Open(t, "closing")
	keep := true
	window.OnClosing(func() bool { return keep })
	window.Close()
	if window.NativeWindow() == 0 {
		t.Fatal("a hook that keeps the window closed it")
	}
	keep = false
	window.Close()
	if window.NativeWindow() != 0 {
		t.Fatal("a hook that lets the window close kept it")
	}
	if got := framework.Windows(); len(got) != 0 {
		t.Fatalf("the open windows are %v", got)
	}
	if !slices.Contains(workbench.Received(), "close closing") {
		t.Fatalf("the workbench received %v", workbench.Received())
	}
}

// WebKit keeps the previous page of a reload on the screen until the new page renders its first screen, so a shown window keeps its last
// frame from the start of its new workbench until that workbench shows its first screen (docs/spec/native-host.md#page-start).
// contract: mygo.framework.start-builds-the-workbench
func TestARestartedWorkbenchDrawsNoFrameBeforeItsFirstScreen(t *testing.T) {
	_, workbench, window := support.Open(t, "restarted")
	window.Show()
	draws := func() int { return strings.Count(strings.Join(workbench.Received(), "\n"), "draw restarted") }
	support.Wait(t, "the start of the workbench", func() bool { return slices.Contains(workbench.Received(), "shown restarted") }, workbench.OnRecord)
	workbench.HoldFirstScreen()
	window.StartWorkbench()
	before := draws()
	window.Window().Invalidate()
	support.HoldsFrames(t, window)
	if drawn := draws() - before; drawn != 0 {
		t.Fatalf("the window drew %d frames of its new workbench before its first screen", drawn)
	}
	mygo.RunOnMain(window.FirstScreen)
	support.Wait(t, "the frame of the first screen", func() bool { return draws() > before }, workbench.OnRecord)
}

// The first visible frame of a new window is the first screen of its workbench (docs/spec/native-host.md#page-start), so the window
// goes on the screen once the frame of that screen is drawn, not with the first frame of the window.
// contract: mygo.framework.start-builds-the-workbench
func TestAWindowGoesOnTheScreenWithTheFirstScreenOfItsWorkbench(t *testing.T) {
	_, workbench, window := support.Open(t, "first")
	workbench.HoldFirstScreen()
	window.Show()
	support.Wait(t, "the start of the workbench", func() bool { return slices.Contains(workbench.Received(), "shown first") }, workbench.OnRecord)
	// The window draws its frames off the screen until the first screen of its workbench.
	window.Window().Invalidate()
	support.NextFrame(t, window)
	if window.Window().IsVisible() {
		t.Fatal("the window went on the screen before the first screen of its workbench")
	}
	before := len(workbench.Received())
	mygo.RunOnMain(window.FirstScreen)
	support.Wait(t, "the window on the screen", window.Window().IsVisible, window.Window().OnShow)
	if !slices.Contains(workbench.Received()[before:], "draw first") {
		t.Fatalf("the window went on the screen without a frame of its first screen: %v", workbench.Received()[before:])
	}
}

// contract: mygo.framework.start-builds-the-workbench
func TestStartWorkbenchClosesAndBuildsTheWorkbench(t *testing.T) {
	_, workbench, window := support.Open(t, "restart")
	window.StartWorkbench()
	received := workbench.Received()
	close, build := slices.Index(received, "close restart"), slices.Index(received[1:], "build restart")
	if close < 0 || build < 0 || build+1 < close {
		t.Fatalf("the workbench received %v, want a close before a second build", received)
	}
}

// contract: mygo.framework.frame-reports-reach-the-counters
func TestTheLayoutObserverReportsTheTransactionOfAWindow(t *testing.T) {
	_, _, window := support.Open(t, "layout")
	system, err := platform.Current()
	if err != nil {
		t.Fatal(err)
	}
	native := window.NativeWindow()
	reports := make(chan string, 8)
	report := func(what string) func(platform.Window) {
		return func(reported platform.Window) {
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

// A frame that presents with the transaction keeps its drawable until the commit, and the frames after it wait for the commit. So the
// preparation holds the frames of its window until it asks for the frame of the transaction, or a frame drawn meanwhile would take
// the drawable of the transaction and the frame of the transaction would wait for the commit that waits for it.
// contract: mygo.framework.frame-reports-reach-the-counters
func TestAPreparationHoldsTheFramesOfItsWindowUntilItAsksForItsFrame(t *testing.T) {
	framework, workbench, window := support.Open(t, "prepared")
	if err := framework.ObserveLayout(); err != nil {
		t.Fatal(err)
	}
	window.Show()
	draws := func() int { return strings.Count(strings.Join(workbench.Received(), "\n"), "draw prepared") }
	support.Wait(t, "the start of the workbench", func() bool { return slices.Contains(workbench.Received(), "shown prepared") }, workbench.OnRecord)
	system, err := platform.Current()
	if err != nil {
		t.Fatal(err)
	}
	native := window.NativeWindow()
	ready := make(chan bool, 1)
	mygo.RunOnMain(func() { err = system.BeginLayout(native, 1, func(allowed bool) { ready <- allowed }) })
	if err != nil {
		t.Fatal(err)
	}
	if !<-ready {
		t.Fatal("the transaction of the window did not start")
	}
	before := draws()
	window.Window().Invalidate()
	support.HoldsFrames(t, window)
	if drawn := draws() - before; drawn != 0 {
		t.Fatalf("the window drew %d frames in its preparation before it asked for the frame of the transaction", drawn)
	}
	var committed bool
	mygo.RunOnMain(func() { committed = system.CommitLayout(native, 1) })
	if !committed {
		t.Fatal("the transaction of the window did not commit")
	}
	support.Wait(t, "the frame after the transaction", func() bool { return draws() > before }, workbench.OnRecord)
}

// contract: mygo.framework.frame-reports-reach-the-counters
func TestTheFrameReportsOfAWindowReachItsCounters(t *testing.T) {
	frames := host.NewWindowFrames("main")
	recorder := adapter.FrameRecorder(frames)
	recorder.Frame(&ui.FrameRecord{Outcome: ui.FrameStashed, Nodes: 9, Timer: true})
	recorder.Commit(ui.CommitRecord{Kind: ui.CommitStashed})
	got := frames.Counters()
	if *got.Frames != 1 || *got.CommandBuffers != 1 || *got.Settled {
		t.Fatalf("after a stashed frame and its commit: %d frames, %d command buffers, settled %t", *got.Frames, *got.CommandBuffers, *got.Settled)
	}
	recorder.Frame(&ui.FrameRecord{Outcome: ui.FrameImmediate, CommandBuffer: true, Nodes: 9})
	got = frames.Counters()
	if *got.Frames != 2 || *got.CommandBuffers != 2 || !*got.Settled || frames.Nodes() != 9 {
		t.Fatalf("after a settled frame: %d frames, %d command buffers, settled %t, %d nodes", *got.Frames, *got.CommandBuffers, *got.Settled, frames.Nodes())
	}
}

// A window answers commands once its workbench started, and they read the elements of its last frame, so the start follows the
// first frame.
// contract: mygo.framework.start-builds-the-workbench
func TestAWorkbenchStartsAfterTheFirstFrameOfItsWindow(t *testing.T) {
	_, workbench, window := support.Open(t, "started")
	window.Show()
	support.Wait(t, "the start of the workbench", func() bool { return slices.Contains(workbench.Received(), "shown started") }, workbench.OnRecord)
	records := workbench.Received()
	drawn := slices.Index(records, "draw started")
	if drawn < 0 || drawn > slices.Index(records, "shown started") {
		t.Fatalf("the workbench started before the first frame: %v", records)
	}
}

// contract: mygo.framework.frame-reports-reach-the-counters
func TestAShownWindowCountsItsFramesAndThenDrawsNone(t *testing.T) {
	_, workbench, window := support.Open(t, "frames")
	frames := window.Frames()
	if frames == nil {
		t.Fatal("a mygo window counts no frame")
	}
	window.Show()
	// The window shows after its first frame, and showing asks for one more. Each frame that builds records its draw, and a step of
	// the main thread after it runs after the report of that frame; a settled window asked for no frame after its last one, so it
	// draws none until a request.
	support.Wait(t, "a window on the screen that settled after its frames", func() bool {
		mygo.RunOnMain(func() {})
		got := frames.Counters()
		return window.Window().IsVisible() && *got.Frames > 0 && *got.CommandBuffers > 0 && *got.Settled
	}, workbench.OnRecord, window.Window().OnShow)
	if frames.Nodes() == 0 {
		t.Fatal("a window that drew reports no nodes of its last build pass")
	}
}

// A step of the workbench can read the scale after its window closed, when the framework holds no native window. Native code
// receives no window then, because it records every such read as an error: the read gives the error of a closed window.
// contract: mygo.framework.window-operations
func TestAScaleOfAClosedWindowCallsNoNativeCode(t *testing.T) {
	const native = platform.Window(1)
	var read []platform.Window
	facts := func(handle platform.Window) (string, error) {
		read = append(read, handle)
		return `{"scale":2}`, nil
	}
	invoke := func(step func()) { step() }
	scale, err := adapter.WindowScale(invoke, "main", func() platform.Window { return native }, facts)
	if err != nil || scale != 2 {
		t.Fatalf("the open window has scale %v, error %v", scale, err)
	}
	_, err = adapter.WindowScale(invoke, "main", func() platform.Window { return 0 }, facts)
	if !host.WindowClosed(err) {
		t.Fatalf("the closed window gave %v", err)
	}
	if len(read) != 1 || read[0] != native {
		t.Fatalf("native code received %v, want only the open window", read)
	}
}
