//go:build diagnostics

package host_test

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	host "github.com/soksak-app/core/packages/host/go/src"
	"github.com/soksak-app/core/packages/host/go/tests/support"
)

// contract: diagnostics.stall-dump.params-validate
func TestAStallDumpNamesAnExistingFileByItsAbsolutePath(t *testing.T) {
	dump := filepath.Join(t.TempDir(), "stall-10-7.txt")
	if err := os.WriteFile(dump, []byte("Sampling process 10"), 0o600); err != nil {
		t.Fatal(err)
	}
	path, err := host.ParseStallDump(json.RawMessage(`{"window":"w","path":` + string(mustJSON(t, dump)) + `}`))
	if err != nil || path != dump {
		t.Fatalf("got %q, %v; want %q", path, err, dump)
	}
	bad := map[string]string{
		`{"window":"w"}`:                         "path must be a non-empty string",
		`{"window":"w","path":""}`:               "path must be a non-empty string",
		`{"window":"w","path":7}`:                "path must be a non-empty string",
		`{"window":"w","path":"stall-10-7.txt"}`: "path must be absolute",
		`{"window":"w","path":"` + filepath.Join(t.TempDir(), "absent.txt") + `"}`: "path does not name a file",
	}
	for raw, message := range bad {
		_, err := host.ParseStallDump(json.RawMessage(raw))
		var rpc *host.RPCError
		if !errors.As(err, &rpc) || rpc.Code != -32602 || (rpc.Message != message && message != "path does not name a file") {
			t.Fatalf("%s: got %v, want invalid params %q", raw, err, message)
		}
	}
}

// contract: diagnostics.stall-dump.event-carries-path, diagnostics.stall-dump.names-running-calls
func TestAStallDumpIsAnEventThatNamesTheRunningCallsAndTheReplyNamesItsPosition(t *testing.T) {
	log := support.UseEventLog(t)
	dump := filepath.Join(t.TempDir(), "stall-10-7.txt")
	if err := os.WriteFile(dump, []byte("Sampling process 10"), 0o600); err != nil {
		t.Fatal(err)
	}
	calls := host.NewRunningCalls()
	at := time.Date(2026, 11, 12, 2, 55, 25, 0, time.UTC)
	calls.Begin("main", "wait_presented", at)
	calls.Begin("main", "surface_focus", at.Add(time.Second))
	calls.Begin("project-window-1", "workspace", at.Add(2*time.Second))
	now := at.Add(3500 * time.Millisecond)
	reply, err := host.StallDump(dump, "main", calls, now)
	if err != nil {
		t.Fatal(err)
	}
	if err := log.Flush(); err != nil {
		t.Fatal(err)
	}
	var found []map[string]any
	for _, event := range readEventLog(t, log.Path()) {
		if event["event"] == "host.stall.dump" {
			found = append(found, event)
		}
	}
	running := map[string]any{"main": "wait_presented 3.5s, surface_focus 2.5s", "project-window-1": "workspace 1.5s"}
	if len(found) != 1 || found[0]["level"] != "warn" {
		t.Fatalf("events %v", found)
	}
	fields := found[0]["fields"].(map[string]any)
	if fields["path"] != dump || !reflect.DeepEqual(fields["running"], running) || fields["goroutines"] != dump+".goroutines.txt" {
		t.Fatalf("fields %v, want the path, the running calls %v and the goroutine stacks", fields, running)
	}
	want := map[string]any{"boot": "b1", "seq": found[0]["seq"], "running": "wait_presented 3.5s, surface_focus 2.5s"}
	if got := mustRoundTrip(t, reply); !reflect.DeepEqual(got, want) {
		t.Fatalf("reply %v, want %v", got, want)
	}
	calls = host.NewRunningCalls()
	reply, err = host.StallDump(dump, "main", calls, now)
	if err != nil {
		t.Fatal(err)
	}
	if got := mustRoundTrip(t, reply)["running"]; got != "none" {
		t.Fatalf("a window without running calls replies %v, want none", got)
	}
}

// parkedInAStallDump is the function of a goroutine that a stall dump finds parked on its channel.
func parkedInAStallDump(release <-chan struct{}, parked chan<- struct{}) {
	close(parked)
	<-release
}

// contract: diagnostics.stall-dump.goroutine-stacks
func TestAStallDumpWritesTheStacksOfEveryGoroutineBesideTheDump(t *testing.T) {
	support.UseEventLog(t)
	dump := filepath.Join(t.TempDir(), "stall-10-7.txt")
	if err := os.WriteFile(dump, []byte("Sampling process 10"), 0o600); err != nil {
		t.Fatal(err)
	}
	release, parked := make(chan struct{}), make(chan struct{})
	go parkedInAStallDump(release, parked)
	defer close(release)
	<-parked
	if _, err := host.StallDump(dump, "main", host.NewRunningCalls(), time.Now()); err != nil {
		t.Fatal(err)
	}
	stacks, err := os.ReadFile(dump + ".goroutines.txt")
	if err != nil {
		t.Fatal(err)
	}
	text := string(stacks)
	if !strings.Contains(text, "[chan receive") || !strings.Contains(text, "parkedInAStallDump") {
		t.Fatalf("the goroutine stacks do not show the goroutine parked on its channel:\n%s", text)
	}
}

func mustRoundTrip(t *testing.T, value any) map[string]any {
	t.Helper()
	var got map[string]any
	if err := json.Unmarshal(mustJSON(t, value), &got); err != nil {
		t.Fatal(err)
	}
	return got
}

func mustJSON(t *testing.T, value any) []byte {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return data
}
