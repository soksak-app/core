//go:build diagnostics

package host_test

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	host "github.com/soksak-app/core/packages/host/wailsv3/src"
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

// contract: diagnostics.stall-dump.event-carries-path
func TestAStallDumpIsAnEventAndTheReplyNamesItsPosition(t *testing.T) {
	log := useEventLog(t)
	dump := filepath.Join(t.TempDir(), "stall-10-7.txt")
	boot, seq, err := host.EmitStallDump(dump, 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if err := log.Flush(5 * time.Second); err != nil {
		t.Fatal(err)
	}
	var found []map[string]any
	for _, event := range readEventLog(t, log.Path()) {
		if event["event"] == "host.stall.dump" {
			found = append(found, event)
		}
	}
	if len(found) != 1 || found[0]["level"] != "warn" || found[0]["fields"].(map[string]any)["path"] != dump || found[0]["seq"] != float64(seq) || boot != "b1" {
		t.Fatalf("events %v, position (%s, %d)", found, boot, seq)
	}
}

func mustJSON(t *testing.T, value any) []byte {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return data
}
