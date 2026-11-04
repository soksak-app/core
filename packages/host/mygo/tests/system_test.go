package adapter_test

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
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
)

// systemHelper names the child process that runs the application with a workbench that acts on its window as the step of
// systemStep says; its value is the configuration directory.
const systemHelper = "SOKSAK_MYGO_SYSTEM_HELPER"

// systemStep names the step of the child process of systemHelper.
const systemStep = "SOKSAK_MYGO_SYSTEM_STEP"

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
}

func init() { helpers[systemHelper] = runSystemHelper }

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
	sceneWorkbench
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
	ended  chan error
}

// runStep starts the application in its bundle with the workbench of step.
func runStep(t *testing.T, step string) *running {
	t.Helper()
	config := t.TempDir()
	child := exec.Command(bundled(t))
	child.Env = append(os.Environ(), systemHelper+"="+config, systemStep+"="+step)
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

// expect returns the first line of the standard output that holds text, within the limit of a test.
func (r *running) expect(t *testing.T, text string) string {
	t.Helper()
	limit := time.After(10 * time.Second)
	for {
		select {
		case line, open := <-r.lines:
			if !open {
				t.Fatalf("the application ended before it wrote %q\n%s", text, logged(r.config))
			}
			if strings.Contains(line, text) {
				return line
			}
		case <-limit:
			t.Fatalf("the application did not write %q within 10 s\n%s", text, logged(r.config))
		}
	}
}

// quit ends the application with a signal and returns its event log.
func (r *running) quit(t *testing.T) string {
	t.Helper()
	// The application takes a quit once it published its endpoint.
	wait(t, "endpoint.json", func() bool {
		_, err := os.Stat(filepath.Join(r.config, "endpoint.json"))
		return err == nil
	})
	if err := r.child.Process.Signal(syscall.SIGTERM); err != nil {
		t.Fatal(err)
	}
	var after []string
	limit := time.After(10 * time.Second)
	for open := true; open; {
		select {
		case line, more := <-r.lines:
			if open = more; open {
				after = append(after, line)
			}
		case <-limit:
			t.Fatalf("the application did not end within 10 s of the signal, after %q\n%s", after, logged(r.config))
		}
	}
	if failure := <-r.ended; failure != nil {
		t.Fatalf("the application ended with %v after the signal, after %q\n%s", failure, after, logged(r.config))
	}
	return r.events(t)
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
