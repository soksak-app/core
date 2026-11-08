package support

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	host "github.com/soksak-app/core/packages/host/go/src"
)

// EchoSidecar is the name of the sidecar that Declare declares.
const EchoSidecar = "@fixture/sidecar-echo"

// Stall is the upper bound that ends a hung check. Success is decided by the received events and the ended processes and not by this time.
// Even on a heavily loaded machine, the reply and the exit of the sidecar arrive within it.
const Stall = 120 * time.Second

// MessageLimit is the maximum size before the line break in one line of a sidecar message (docs/spec/sidecars.md#messages).
const MessageLimit = 64 << 20

// Declare is the declaration of one sidecar installed in directory.
func Declare(directory, sidecar string) []host.SidecarDeclaration {
	return []host.SidecarDeclaration{{Name: EchoSidecar, Folder: directory, Data: []byte(sidecar)}}
}

// FakeOwner is a window that records the sidecar events and the failure events it received.
type FakeOwner struct {
	Root     string
	Mu       sync.Mutex
	Events   []host.SidecarMessage
	Seen     chan struct{}
	Failures chan any
}

// NewFakeOwner is a FakeOwner of the project root root.
func NewFakeOwner(root string) *FakeOwner {
	return &FakeOwner{Root: root, Seen: make(chan struct{}, 16), Failures: make(chan any, 16)}
}

func (o *FakeOwner) ProjectRoot() string { return o.Root }

func (o *FakeOwner) Emit(name string, data ...any) {
	if name == "sidecar-failure" && len(data) == 1 {
		o.Failures <- data[0]
	}
}

func (o *FakeOwner) DeliverSidecarMessage(message host.SidecarMessage) {
	o.Mu.Lock()
	o.Events = append(o.Events, message)
	o.Mu.Unlock()
	o.Seen <- struct{}{}
}

// Next waits for the next sidecar event and returns it.
func (o *FakeOwner) Next(t *testing.T) host.SidecarMessage {
	t.Helper()
	select {
	case <-o.Seen:
	case <-time.After(Stall):
		t.Fatalf("no sidecar event within %v; the test stalled", Stall)
	}
	o.Mu.Lock()
	defer o.Mu.Unlock()
	return o.Events[len(o.Events)-1]
}

// SidecarFailure is the JSON form of the sidecar-failure event value (docs/spec/sidecars.md#failure).
type SidecarFailure struct {
	Sidecar string `json:"sidecar"`
	Surface string `json:"surface"`
	Reason  string `json:"reason"`
}

// Failure waits for the next failure event and returns it in the JSON form.
func (o *FakeOwner) Failure(t *testing.T) SidecarFailure {
	t.Helper()
	var value any
	select {
	case value = <-o.Failures:
	case <-time.After(Stall):
		t.Fatalf("no sidecar failure within %v; the test stalled", Stall)
	}
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	var failure SidecarFailure
	if err := json.Unmarshal(data, &failure); err != nil {
		t.Fatal(err)
	}
	return failure
}

// ScriptSidecars creates a channel that declares a fake sidecar that runs script, and its directory.
// DIR in script is replaced by that directory.
func ScriptSidecars(t *testing.T, script string) (*host.Sidecars, string) {
	t.Helper()
	directory := t.TempDir()
	script = strings.ReplaceAll(script, "DIR", directory)
	if err := os.WriteFile(filepath.Join(directory, "fake"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	sidecars, err := host.NewSidecars(Declare(directory, `{"executable":"fake","displayName":"soksak://sidecar/probe","protocol":1}`), directory)
	if err != nil {
		t.Fatal(err)
	}
	// Even when the check fails, no fake sidecar process is left.
	t.Cleanup(sidecars.Stop)
	return sidecars, directory
}

// PaddedMessageScript is a script that reads one request, sends an s1 message of size bytes before the line break, and then runs then.
// The body is one string and a shell pipeline writes it, so the script process waits until the write ends.
func PaddedMessageScript(size int, then string) (string, int) {
	prefix, suffix := `{"surface":"s1","body":"`, `"}`
	padding := size - len(prefix) - len(suffix)
	return fmt.Sprintf("#!/bin/sh\necho $$ > DIR/pid\nread request\nprintf '%%s' '%s'\nhead -c %d /dev/zero | tr '\\0' x\nprintf '%%s\\n' '%s'\n%s\n",
		prefix, padding, suffix, then), padding
}

// ProcessID is the process id that the fake sidecar recorded.
func ProcessID(t *testing.T, directory string) int {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(directory, "pid"))
	if err != nil {
		t.Fatal(err)
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(data)))
	if err != nil {
		t.Fatal(err)
	}
	return pid
}

// HarnessOwner is a window of the persistent transport tests that passes each sidecar message to Seen.
type HarnessOwner struct {
	Root string
	Seen chan host.SidecarMessage
}

func (o *HarnessOwner) ProjectRoot() string { return o.Root }
func (o *HarnessOwner) Emit(string, ...any) {}

func (o *HarnessOwner) DeliverSidecarMessage(message host.SidecarMessage) { o.Seen <- message }

// HarnessDeclarations is the declaration of one persistent sidecar installed in folder.
func HarnessDeclarations(folder string) []host.SidecarDeclaration {
	return []host.SidecarDeclaration{{Name: "fixture-service", Folder: folder,
		Data: []byte(`{"executable":"service","displayName":"soksak://sidecar/probe","protocol":1,"transport":"persistent"}`)}}
}

// SendWithin sends to fixture-service and returns the result within limit. If it does not return, the check fails.
func SendWithin(t *testing.T, sidecars *host.Sidecars, owner *HarnessOwner, limit time.Duration) error {
	t.Helper()
	result := make(chan error, 1)
	go func() {
		result <- sidecars.Send(owner, "fixture-service", "surface", json.RawMessage(`{"operation":"open"}`))
	}()
	select {
	case err := <-result:
		return err
	case <-time.After(limit):
		t.Fatalf("the send did not return within %v", limit)
		return nil
	}
}

// SocketParent is a short temporary directory that fits within the socket path length limit.
func SocketParent(t *testing.T) string {
	t.Helper()
	parent, err := os.MkdirTemp("", "sp")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.RemoveAll(parent); err != nil {
			t.Errorf("cannot remove %s: %v", parent, err)
		}
	})
	return parent
}
