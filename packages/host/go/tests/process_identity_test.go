package host_test

// The surface of a process (docs/spec/sidecars.md#process-identity), checked with real processes: the process sidecar below is
// this test binary run under the name processSidecarName, and it starts real shells for surfaces.

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	host "github.com/soksak-app/core/packages/host/go/src"
	"github.com/soksak-app/core/packages/host/go/tests/support"
	"golang.org/x/sys/unix"
)

// processSidecarName is the name of the link of this test binary that runs it as the process sidecar.
const processSidecarName = "process-sidecar"

// processIdentityTimeout bounds each wait of these tests.
const processIdentityTimeout = 20 * time.Second

// processStarted is the start time of pid in milliseconds since the Unix epoch, as the process sidecar records it.
func processStarted(pid int) (int64, error) {
	processes, err := unix.SysctlKinfoProcSlice("kern.proc.pid", pid)
	if err != nil {
		return 0, err
	}
	if len(processes) == 0 {
		return 0, fmt.Errorf("process %d is not in the process table", pid)
	}
	started := processes[0].Proc.P_starttime
	return started.Sec*1000 + int64(started.Usec)/1000, nil
}

// runProcessSidecar is the process sidecar: a body {"start": "surface"} starts a shell for the surface whose child sleeps and
// answers {"root", "child"}; {"start": "helper"} starts a sleep for no surface and answers {"helper"}; a process query is answered
// from the processes that it started, which it records before it reads its next line and removes when it reaps them.
func runProcessSidecar() int {
	type started struct {
		surface *string
		time    int64
	}
	var mu sync.Mutex
	records := map[int]started{}
	var out sync.Mutex
	write := func(value any) {
		line, err := json.Marshal(value)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(2)
		}
		out.Lock()
		defer out.Unlock()
		if _, err := os.Stdout.Write(append(line, '\n')); err != nil {
			os.Exit(2)
		}
	}
	reap := func(cmd *exec.Cmd) {
		go func() {
			_ = cmd.Wait() // The end of a sleep that the stop of the sidecar ends is not a failure of this fixture.
			mu.Lock()
			delete(records, cmd.Process.Pid)
			mu.Unlock()
		}()
	}
	scanner := bufio.NewScanner(os.Stdin)
	for scanner.Scan() {
		var line struct {
			Surface *string `json:"surface"`
			Closed  bool    `json:"closed"`
			Process *int    `json:"process"`
			Request *int64  `json:"request"`
			Body    struct {
				Start string `json:"start"`
			} `json:"body"`
		}
		if err := json.Unmarshal(scanner.Bytes(), &line); err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 2
		}
		switch {
		case line.Process != nil:
			mu.Lock()
			record, ok := records[*line.Process]
			mu.Unlock()
			if ok && record.surface != nil {
				write(map[string]any{"process": *line.Process, "request": *line.Request, "surface": *record.surface, "started": record.time})
			} else {
				write(map[string]any{"process": *line.Process, "request": *line.Request, "surface": nil})
			}
		case line.Closed:
			write(map[string]any{"surface": *line.Surface, "closed": true})
		case line.Body.Start == "surface":
			cmd := exec.Command("/bin/sh", "-c", "/bin/sleep 600 & echo $!; wait")
			stdout, err := cmd.StdoutPipe()
			if err != nil {
				fmt.Fprintln(os.Stderr, err)
				return 2
			}
			if err := cmd.Start(); err != nil {
				fmt.Fprintln(os.Stderr, err)
				return 2
			}
			at, err := processStarted(cmd.Process.Pid)
			if err != nil {
				fmt.Fprintln(os.Stderr, err)
				return 2
			}
			surface := *line.Surface
			mu.Lock()
			records[cmd.Process.Pid] = started{surface: &surface, time: at}
			mu.Unlock()
			reap(cmd)
			first, err := bufio.NewReader(stdout).ReadString('\n')
			if err != nil {
				fmt.Fprintln(os.Stderr, err)
				return 2
			}
			child, err := strconv.Atoi(strings.TrimSpace(first))
			if err != nil {
				fmt.Fprintln(os.Stderr, err)
				return 2
			}
			write(map[string]any{"surface": surface, "body": map[string]int{"root": cmd.Process.Pid, "child": child}})
		case line.Body.Start == "helper":
			cmd := exec.Command("/bin/sleep", "600")
			if err := cmd.Start(); err != nil {
				fmt.Fprintln(os.Stderr, err)
				return 2
			}
			mu.Lock()
			records[cmd.Process.Pid] = started{}
			mu.Unlock()
			reap(cmd)
			write(map[string]any{"surface": *line.Surface, "body": map[string]int{"helper": cmd.Process.Pid}})
		default:
			fmt.Fprintf(os.Stderr, "unknown line %s\n", scanner.Bytes())
			return 2
		}
	}
	if err := scanner.Err(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 2
	}
	return 0
}

// processSidecars declares the process sidecar in a new folder with manifest, a sidecar.json whose executable is
// processSidecarName.
func processSidecars(t *testing.T, manifest string) *host.Sidecars {
	t.Helper()
	directory := t.TempDir()
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(self, filepath.Join(directory, processSidecarName)); err != nil {
		t.Fatal(err)
	}
	sidecars, err := host.NewSidecars(support.Declare(directory, manifest), directory)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(sidecars.Stop)
	return sidecars
}

// startedPids sends {"start": kind} for surface and returns the pids of the answer.
func startedPids(t *testing.T, sidecars *host.Sidecars, owner *support.SidecarRecorder, surface, kind string) map[string]int {
	t.Helper()
	if err := owner.Send(sidecars, support.EchoSidecar, surface, json.RawMessage(`{"start":"`+kind+`"}`)); err != nil {
		t.Fatal(err)
	}
	event := owner.Next(t)
	pids := map[string]int{}
	if event.Surface != surface || json.Unmarshal(event.Body, &pids) != nil {
		t.Fatalf("sidecar answer = %+v, want the pids of %s", event, surface)
	}
	return pids
}

// processSurface asks sidecars for the surface of pid within processIdentityTimeout.
func processSurface(t *testing.T, sidecars *host.Sidecars, pid int) (string, error) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), processIdentityTimeout)
	defer cancel()
	return sidecars.ProcessSurface(ctx, pid)
}

// refusal returns the text of a refusal of ProcessSurface, and fails the test for another result.
func refusal(t *testing.T, surface string, err error) string {
	t.Helper()
	var refused *host.ProcessIdentityError
	if !errors.As(err, &refused) {
		t.Fatalf("ProcessSurface = %q, %v; want a refusal", surface, err)
	}
	return refused.Text
}

// contract: sidecars.process-identity.answers-the-surface-of-the-process-chain
func TestProcessSurfaceIsTheSurfaceOfTheNearestSidecarChild(t *testing.T) {
	sidecars := processSidecars(t, `{"executable":"`+processSidecarName+`","displayName":"soksak://sidecar/probe","protocol":1,"processes":true}`)
	owner := support.NewSidecarRecorder(t, "/projects/a")
	first := startedPids(t, sidecars, owner, "tab-a", "surface")
	second := startedPids(t, sidecars, owner, "tab-b", "surface")
	for _, check := range []struct {
		pid  int
		want string
	}{{first["root"], "tab-a"}, {first["child"], "tab-a"}, {second["child"], "tab-b"}} {
		surface, err := processSurface(t, sidecars, check.pid)
		if err != nil || surface != check.want {
			t.Fatalf("ProcessSurface(%d) = %q, %v; want %q", check.pid, surface, err, check.want)
		}
	}
}

// contract: sidecars.process-identity.refuses-a-process-outside-every-surface
func TestProcessSurfaceRefusesAProcessOutsideEverySurface(t *testing.T) {
	sidecars := processSidecars(t, `{"executable":"`+processSidecarName+`","displayName":"soksak://sidecar/probe","protocol":1,"processes":true}`)
	owner := support.NewSidecarRecorder(t, "/projects/a")
	startedPids(t, sidecars, owner, "tab-a", "surface")
	outside := exec.Command("/bin/sleep", "600")
	if err := outside.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := outside.Process.Kill(); err != nil {
			t.Error(err)
		}
		_ = outside.Wait() // The killed sleep ends with its signal.
	})
	surface, err := processSurface(t, sidecars, outside.Process.Pid)
	want := fmt.Sprintf("process %d is not a process of a surface: no parent process of it is a running sidecar of the application that started it for a surface", outside.Process.Pid)
	if text := refusal(t, surface, err); text != want {
		t.Fatalf("refusal = %q, want %q", text, want)
	}
}

// contract: sidecars.process-identity.refuses-a-helper-of-the-sidecar
func TestProcessSurfaceRefusesAProcessThatTheSidecarStartedForNoSurface(t *testing.T) {
	sidecars := processSidecars(t, `{"executable":"`+processSidecarName+`","displayName":"soksak://sidecar/probe","protocol":1,"processes":true}`)
	owner := support.NewSidecarRecorder(t, "/projects/a")
	helper := startedPids(t, sidecars, owner, "tab-a", "helper")["helper"]
	surface, err := processSurface(t, sidecars, helper)
	want := fmt.Sprintf("process %d is not a process of a surface: sidecar %s did not start process %d for a surface", helper, support.EchoSidecar, helper)
	if text := refusal(t, surface, err); text != want {
		t.Fatalf("refusal = %q, want %q", text, want)
	}
}

// contract: sidecars.process-identity.asks-only-a-sidecar-that-declares-processes
func TestProcessSurfaceRefusesAProcessOfASidecarWithoutProcesses(t *testing.T) {
	sidecars := processSidecars(t, `{"executable":"`+processSidecarName+`","displayName":"soksak://sidecar/probe","protocol":1}`)
	owner := support.NewSidecarRecorder(t, "/projects/a")
	child := startedPids(t, sidecars, owner, "tab-a", "surface")["child"]
	surface, err := processSurface(t, sidecars, child)
	want := fmt.Sprintf("process %d is a process of sidecar %s, which declares no processes of surfaces", child, support.EchoSidecar)
	if text := refusal(t, surface, err); text != want {
		t.Fatalf("refusal = %q, want %q", text, want)
	}
}
