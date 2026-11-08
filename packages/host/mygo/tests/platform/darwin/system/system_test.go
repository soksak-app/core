//go:build darwin

// Package system_test holds the tests of the mygo framework adapter that hold only on macOS: they send AppKit messages of the system
// to the application and run it in a bundle.
package system_test

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net/url"
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

	"github.com/ebitengine/purego/objc"
	"github.com/egoist/mygo"

	host "github.com/soksak-app/core/packages/host/go/src"
	adapter "github.com/soksak-app/core/packages/host/mygo/src"
	"github.com/soksak-app/core/packages/host/mygo/tests/support"
	sok "github.com/soksak-app/core/packages/sok/go/src"
)

// systemHelper names the child process that runs the application with a workbench that acts on its window as the step of
// systemStep says; its value is the configuration directory.
const systemHelper = "SOKSAK_MYGO_SYSTEM_HELPER"

// systemStep names the step of the child process of systemHelper.
const systemStep = "SOKSAK_MYGO_SYSTEM_STEP"

// updateBundle is the environment variable of the child process that names the staged bundle of the update step.
const updateBundle = "SOKSAK_MYGO_UPDATE_BUNDLE"

// refusedLink has a scheme that the host refuses, and declaredLink runs the command core.fixture.
const (
	refusedLink  = "other://core/fixture"
	declaredLink = "soksak://core/fixture?value=1"
)

// steps holds what the workbench of the child process does with its first window, by the value of systemStep.
var steps = map[string]func(w *systemWorkbench, window host.Frontend){
	"deep-links": func(w *systemWorkbench, window host.Frontend) {
		openURLs(refusedLink, declaredLink)
		w.windowReady(window)
	},
	"notifications": func(w *systemWorkbench, window host.Frontend) {
		w.windowReady(window)
		// The event of the notification center for a click on the notification of a surface of the window.
		host.HandleNotificationEvent(w.host, `{"type":"activated","identifier":"[\"main\",\"surface\"]"}`)
	},
	"update": func(w *systemWorkbench, window host.Frontend) {
		w.windowReady(window)
		// The application takes a quit once it published its endpoint.
		endpoint := filepath.Join(os.Getenv(systemHelper), "endpoint.json")
		for _, err := os.Stat(endpoint); err != nil; _, err = os.Stat(endpoint) {
			time.Sleep(10 * time.Millisecond)
		}
		context := host.WithFrontend(context.Background(), window)
		state, err := w.host.AppUpdateState(context)
		if err != nil || state.Available == nil {
			fmt.Println("no candidate:", state, err)
			return
		}
		fmt.Println("candidate", state.Available.Version)
		request, err := json.Marshal(host.AppUpdateApplyRequest{Bundle: os.Getenv(updateBundle)})
		if err == nil {
			err = w.host.AppUpdateApply(context, request)
		}
		if err != nil {
			fmt.Println("the update failed:", err)
		}
	},
}

// cleanup runs after the tests of the process, for what the tests share.
var cleanup = func() {}

// TestMain runs the application of the framework on the main thread and the tests in it; the child process of systemHelper runs
// runSystemHelper instead. A test may replace cleanup while the tests run, so the call reads it after them.
func TestMain(m *testing.M) {
	support.Main(m, map[string]func(){systemHelper: runSystemHelper}, func() { cleanup() })
}

// runSystemHelper runs the application of the framework adapter with the workbench of the step.
func runSystemHelper() {
	assets := fstest.MapFS{
		"frontend/core-root.json":                           {Data: []byte("[]")},
		"frontend/view-imports.json":                        {Data: []byte(`{"imports":{}}`)},
		"frontend/modules/@soksak/plugin-api/view-start.js": {Data: []byte("")},
	}
	mygo.App.SetActivationPolicy(mygo.ActivationPolicyProhibited)
	workbench := &systemWorkbench{step: steps[os.Getenv(systemStep)]}
	if err := adapter.Run(assets, host.Options{ConfigDir: os.Getenv(systemHelper)}, workbench); err != nil {
		fmt.Fprintln(os.Stderr, "the application failed:", err)
		os.Exit(1)
	}
}

// systemWorkbench is the fixture workbench of the child process: it runs its step once and writes each event it receives to the
// standard output.
type systemWorkbench struct {
	support.SceneWorkbench
	host    *host.Host
	step    func(w *systemWorkbench, window host.Frontend)
	stepped sync.Once
}

func (w *systemWorkbench) Prepared(h *host.Host) { w.host = h }

func (w *systemWorkbench) Shown(window host.Frontend) {
	w.stepped.Do(func() { go w.step(w, window) })
}

func (w *systemWorkbench) Emit(window host.Frontend, name string, data ...any) {
	text, err := json.Marshal(data)
	if err != nil {
		text = []byte(err.Error())
	}
	fmt.Println("event", window.Name(), name, string(text))
	// A ready workbench closes its window on the close request, and the quit waits for that.
	if name == "project-close-request" {
		go w.host.WindowClose(host.WithFrontend(context.Background(), window))
	}
}

// windowReady says that the workbench of window declared its commands.
func (w *systemWorkbench) windowReady(window host.Frontend) {
	if err := w.host.WindowReady(host.WithFrontend(context.Background(), window)); err != nil {
		fmt.Println("the window is not ready:", err)
	}
}

// openURLs sends the application delegate the message of macOS for URLs that the application is asked to open.
func openURLs(values ...string) {
	mygo.RunOnMain(func() {
		list := objc.ID(objc.GetClass("NSMutableArray")).Send(objc.RegisterName("array"))
		for _, value := range values {
			text := objc.ID(objc.GetClass("NSString")).Send(objc.RegisterName("stringWithUTF8String:"), value+"\x00")
			list.Send(objc.RegisterName("addObject:"), objc.ID(objc.GetClass("NSURL")).Send(objc.RegisterName("URLWithString:"), text))
		}
		application := objc.ID(objc.GetClass("NSApplication")).Send(objc.RegisterName("sharedApplication"))
		application.Send(objc.RegisterName("delegate")).Send(objc.RegisterName("application:openURLs:"), application, list)
	})
}

// running is a child process of systemHelper and the lines of its standard output.
type running struct {
	child  *exec.Cmd
	config string
	lines  chan string
	seen   []string
	ended  chan error
}

// runStep starts the application in its bundle with the workbench of step.
func runStep(t *testing.T, step string) *running {
	t.Helper()
	return startStep(t, step, t.TempDir(), support.Bundled(t))
}

// startStep starts executable with the workbench of step, the configuration directory config and the environment of env.
func startStep(t *testing.T, step, config, executable string, env ...string) *running {
	t.Helper()
	child := exec.Command(executable)
	child.Env = append(append(os.Environ(), systemHelper+"="+config, systemStep+"="+step), env...)
	child.Stderr = os.Stderr
	output, err := child.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := child.Start(); err != nil {
		t.Fatal(err)
	}
	run := &running{child: child, config: config, lines: make(chan string, 64), ended: make(chan error, 1)}
	go func() {
		for scanner := bufio.NewScanner(output); scanner.Scan(); {
			run.lines <- scanner.Text()
		}
		run.ended <- child.Wait()
		close(run.lines)
	}()
	t.Cleanup(func() { child.Process.Kill() })
	return run
}

// expect returns the first line of the standard output that holds text, within the limit of a test. The lines arrive in the order of
// the goroutines of the host, so a line that an earlier expect passed still counts.
func (r *running) expect(t *testing.T, text string) string {
	t.Helper()
	if index := slices.IndexFunc(r.seen, func(line string) bool { return strings.Contains(line, text) }); index >= 0 {
		return r.seen[index]
	}
	limit := time.After(10 * time.Second)
	for {
		select {
		case line, open := <-r.lines:
			if !open {
				t.Fatalf("the application ended before it wrote %q, after %q\n%s", text, r.seen, support.Logged(r.config))
			}
			r.seen = append(r.seen, line)
			if strings.Contains(line, text) {
				return line
			}
		case <-limit:
			t.Fatalf("the application did not write %q within 10 s, after %q\n%s", text, r.seen, support.Logged(r.config))
		}
	}
}

// finished waits for the end of an application that quits by itself and returns its event log.
func (r *running) finished(t *testing.T) string {
	t.Helper()
	limit := time.After(10 * time.Second)
	for open := true; open; {
		select {
		case line, more := <-r.lines:
			if open = more; open {
				r.seen = append(r.seen, line)
			}
		case <-limit:
			t.Fatalf("the application did not end within 10 s, after %q\n%s", r.seen, support.Logged(r.config))
		}
	}
	if failure := <-r.ended; failure != nil {
		t.Fatalf("the application ended with %v, after %q\n%s", failure, r.seen, support.Logged(r.config))
	}
	return r.events(t)
}

// quit ends the application with a signal and returns its event log.
func (r *running) quit(t *testing.T) string {
	t.Helper()
	// The application takes a quit once it published its endpoint.
	support.Wait(t, "endpoint.json", func() bool {
		_, err := os.Stat(filepath.Join(r.config, "endpoint.json"))
		return err == nil
	})
	if err := r.child.Process.Signal(syscall.SIGTERM); err != nil {
		t.Fatal(err)
	}
	return r.finished(t)
}

// events returns the event log of the application.
func (r *running) events(t *testing.T) string {
	t.Helper()
	records, err := filepath.Glob(filepath.Join(r.config, "logs", "host-*.jsonl"))
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
	return log.String()
}

// contract: deep-link.launch.kept-links-run-in-order-when-window-ready
func TestALinkThatTheApplicationIsAskedToOpenRunsOnceTheWindowIsReady(t *testing.T) {
	run := runStep(t, "deep-links")
	request := run.expect(t, "exposure-request")
	if !strings.Contains(request, "command.run") || !strings.Contains(request, "core.fixture") {
		t.Fatalf("the workbench received %s", request)
	}
	log := run.quit(t)
	if !strings.Contains(log, refusedLink) || !strings.Contains(log, "is not soksak") {
		t.Fatalf("the refused link wrote no record:\n%s", log)
	}
}

// nsPoint and nsRect are the structures of AppKit.
type nsPoint struct{ X, Y float64 }
type nsRect struct {
	Origin nsPoint
	Width  float64
	Height float64
}

// The dragging info of the test: one object that answers for the drag of the moment. It belongs to the main thread.
var (
	draggingClass sync.Once
	dragging      objc.ID
	dragLocation  nsPoint
	dragBoard     objc.ID
)

// sel is the selector of name.
func sel(name string) objc.SEL { return objc.RegisterName(name) }

// surfaceView is the view of the framework under view that draws the native UI of a window.
func surfaceView(view objc.ID) objc.ID {
	if objc.Send[bool](view, sel("isKindOfClass:"), objc.GetClass("MyGoSurfaceView")) {
		return view
	}
	children := view.Send(sel("subviews"))
	for index := range objc.Send[uint](children, sel("count")) {
		if found := surfaceView(children.Send(sel("objectAtIndex:"), index)); found != 0 {
			return found
		}
	}
	return 0
}

// dropFiles drags the paths to (x, y), in points from the top-left corner of the content of window, and drops them there as Finder
// does: it sends the surface view its dragging messages, with the file reference URLs on the pasteboard. It reports whether the view
// took the drag and the drop.
func dropFiles(t *testing.T, window *adapter.Frontend, x, y float64, paths ...string) (over, dropped bool) {
	t.Helper()
	mygo.RunOnMain(func() {
		draggingClass.Do(func() {
			class, err := objc.RegisterClass("SoksakTestDraggingInfo", objc.GetClass("NSObject"), nil, nil, []objc.MethodDef{
				{Cmd: sel("draggingLocation"), Fn: func(objc.ID, objc.SEL) nsPoint { return dragLocation }},
				{Cmd: sel("draggingPasteboard"), Fn: func(objc.ID, objc.SEL) objc.ID { return dragBoard }},
				{Cmd: sel("draggingSourceOperationMask"), Fn: func(objc.ID, objc.SEL) uint { return 1 }},
			})
			if err != nil {
				t.Error(err)
				return
			}
			dragging = objc.ID(class).Send(sel("alloc")).Send(sel("init"))
			dragBoard = objc.ID(objc.GetClass("NSPasteboard")).Send(sel("pasteboardWithUniqueName")).Send(sel("retain"))
		})
		native := objc.ID(uintptr(window.NativeWindow()))
		content := native.Send(sel("contentView"))
		dragLocation = nsPoint{x, objc.Send[nsRect](content, sel("frame")).Height - y}
		list := objc.ID(objc.GetClass("NSMutableArray")).Send(sel("array"))
		for _, path := range paths {
			text := objc.ID(objc.GetClass("NSString")).Send(sel("stringWithUTF8String:"), path+"\x00")
			file := objc.ID(objc.GetClass("NSURL")).Send(sel("fileURLWithPath:"), text)
			list.Send(sel("addObject:"), file.Send(sel("fileReferenceURL")))
		}
		dragBoard.Send(sel("clearContents"))
		dragBoard.Send(sel("writeObjects:"), list)
		view := surfaceView(content)
		if view == 0 {
			t.Error("the window has no surface view")
			return
		}
		over = objc.Send[uint](view, sel("draggingEntered:"), dragging) != 0
		over = objc.Send[uint](view, sel("draggingUpdated:"), dragging) != 0 && over
		if over {
			dropped = objc.Send[bool](view, sel("prepareForDragOperation:"), dragging) &&
				objc.Send[bool](view, sel("performDragOperation:"), dragging)
		} else {
			view.Send(sel("draggingExited:"), dragging)
		}
	})
	return over, dropped
}

// contract: mygo.system.file-drop-reaches-the-workbench
func TestAFileDroppedOnAWindowReachesItsWorkbenchAsTheTextOfTheFileDropView(t *testing.T) {
	_, workbench, window := support.Open(t, "drop")
	folder, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(folder, "a b.txt")
	if err := os.WriteFile(file, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	inner := filepath.Join(folder, "inner")
	if err := os.Mkdir(inner, 0o755); err != nil {
		t.Fatal(err)
	}
	if over, dropped := dropFiles(t, window, 40, 30, file, inner); !over || !dropped {
		t.Fatalf("the view took the drag: %v, and the drop: %v", over, dropped)
	}
	const event = "event drop files-dropped "
	var received string
	support.Wait(t, "files-dropped", func() bool {
		index := slices.IndexFunc(workbench.Received(), func(record string) bool { return strings.HasPrefix(record, event) })
		if index >= 0 {
			received = workbench.Received()[index]
		}
		return index >= 0
	})
	// The port delivers the JSON text of the drop as its one value, and the workbench parses it, as the page does.
	var drop struct {
		URLs []string `json:"urls"`
		X    float64  `json:"x"`
		Y    float64  `json:"y"`
	}
	text := strings.TrimSuffix(strings.TrimPrefix(received, event+"["), "]")
	if err := json.Unmarshal([]byte(text), &drop); err != nil {
		t.Fatalf("the event holds %s: %v", received, err)
	}
	spaced := url.URL{Scheme: "file", Path: file}
	directory := url.URL{Scheme: "file", Path: inner + "/"}
	if !slices.Equal(drop.URLs, []string{spaced.String(), directory.String()}) || drop.X != 40 || drop.Y != 30 {
		t.Fatalf("the workbench received %s", text)
	}
	if !strings.Contains(text, "a%20b.txt") {
		t.Fatalf("the URL of the file is not encoded: %s", text)
	}
}

// contract: mygo.system.file-drop-reaches-the-workbench
func TestADropOfAPathThatNoLongerResolvesIsRefused(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "missing")
	if text, err := adapter.FileDropText(&mygo.FileDropEvent{Paths: []string{missing}}); err == nil || !strings.Contains(err.Error(), missing) {
		t.Fatalf("the drop gave %q, %v", text, err)
	}
}

// contract: mygo.system.notification-events-reach-the-workbench
func TestTheEventsOfTheNotificationCenterReachTheWorkbench(t *testing.T) {
	run := runStep(t, "notifications")
	run.expect(t, "event main notification-state")
	if activated := run.expect(t, "event main notification-activated"); !strings.Contains(activated, `"surface":"surface"`) {
		t.Fatalf("the workbench received %s", activated)
	}
	run.quit(t)
}

// stagedUpdate gives the registry of config a core release for the application of the mygo host and stages its bundle under config.
// It returns the staged bundle.
func stagedUpdate(t *testing.T, config string) string {
	t.Helper()
	platform, err := sok.CurrentPlatform()
	if err != nil {
		t.Fatal(err)
	}
	folder := t.TempDir()
	index := filepath.Join(folder, "index.json")
	text := fmt.Sprintf(`{"format": 1, "plugins": [], "sidecars": [], "packs": [], "revoked": {"plugins": [], "sidecars": []}, "core": {"versions": [{"version": "99.0.0", "releases": {"%s-mygo": {"url": "file:///release.zip", "sha256": "%s"}}}]}}`,
		platform, strings.Repeat("0", 64))
	if err := os.WriteFile(index, []byte(text), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := sok.UseRegistry(config, index, sok.DefaultFetcher); err != nil {
		t.Fatal(err)
	}
	bundle := filepath.Join(config, "updates", "99.0.0", "soksak.app")
	if err := os.MkdirAll(filepath.Join(bundle, "Contents"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(bundle, "Contents", "Info.plist"), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	return bundle
}

// contract: mygo.system.update-replaces-the-bundle
func TestAnUpdateQuitsTheApplicationAndStartsTheCommandThatReplacesItsBundle(t *testing.T) {
	// The host holds the configuration directory and the bundle with their symbolic links resolved.
	config, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	executable, err := filepath.EvalSymlinks(support.Bundled(t))
	if err != nil {
		t.Fatal(err)
	}
	bundle := stagedUpdate(t, config)
	// The sok of the bundle writes the arguments of the command that replaces the bundle.
	arguments := filepath.Join(t.TempDir(), "arguments")
	script := fmt.Sprintf("#!/bin/sh\nprintf '%%s\\n' \"$@\" > '%s.part'\nmv '%s.part' '%s'\n", arguments, arguments, arguments)
	if err := os.WriteFile(filepath.Join(filepath.Dir(executable), "sok"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	run := startStep(t, "update", config, executable, updateBundle+"="+bundle)
	run.expect(t, "candidate 99.0.0")
	log := run.finished(t)
	if !strings.Contains(log, `"cause":"update"`) {
		t.Fatalf("the application log holds no update:\n%s", log)
	}
	support.Wait(t, "the command of the update", func() bool {
		_, err := os.Stat(arguments)
		return err == nil
	})
	data, err := os.ReadFile(arguments)
	if err != nil {
		t.Fatal(err)
	}
	target := filepath.Dir(filepath.Dir(filepath.Dir(executable)))
	want := []string{"app", "update", "--wait", fmt.Sprint(run.child.Process.Pid), "--bundle", bundle, "--target", target}
	if got := strings.Fields(string(data)); !slices.Equal(got, want) {
		t.Fatalf("the command got %v, expected %v", got, want)
	}
}
