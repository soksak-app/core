package support

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	host "github.com/soksak-app/core/packages/host/go/src"
)

// EchoSidecar is the name of the sidecar that Declare declares.
const EchoSidecar = "@fixture/sidecar-echo"

// Stall bounds a read of a fixture connection, as a fixture read timeout does; it decides no outcome, and a check sets no
// bound of its own on a wait for an event, which its runner ends.
const Stall = 120 * time.Second

// MessageLimit is the maximum size before the line break in one line of a sidecar message (docs/spec/sidecars.md#messages).
const MessageLimit = 64 << 20

// Declare is the declaration of one sidecar installed in directory.
func Declare(directory, sidecar string) []host.SidecarDeclaration {
	return []host.SidecarDeclaration{{Name: EchoSidecar, Folder: directory, Data: []byte(sidecar)}}
}

// Fixture installs the sidecar fixture program (docs/spec/cases/sidecars/fixture.sh) in directory as the executable named
// executable: a symbolic link of that name points to the program, and the file control of the folder holds the control text
// that the program reads beside its link. It fails the test on any error.
func Fixture(t *testing.T, directory, executable, control string) {
	t.Helper()
	// The program is found from this file: support, tests, go, host, packages and the repository root.
	_, here, _, _ := runtime.Caller(0)
	program, err := filepath.Abs(filepath.Join(filepath.Dir(here), "..", "..", "..", "..", "..", "docs", "spec", "cases", "sidecars", "fixture.sh"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(program); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(program, filepath.Join(directory, executable)); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, "control"), []byte(control), 0o644); err != nil {
		t.Fatal(err)
	}
}

// FixtureSidecars declares the sidecar fixture installed in directory with the control text control, and returns its sidecars.
// The sidecars are stopped when the test ends, also when the test fails.
func FixtureSidecars(t *testing.T, directory, control string) *host.Sidecars {
	t.Helper()
	Fixture(t, directory, "sidecar", control)
	sidecars, err := host.NewSidecars(Declare(directory, `{"executable":"sidecar","displayName":"soksak://sidecar/probe","protocol":1}`), directory)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(sidecars.Stop)
	return sidecars
}

// FakeOwner is a window that records the sidecar events and the failure events it received.
type FakeOwner struct {
	Root     string
	Mu       sync.Mutex
	Events   []host.SidecarMessage
	Seen     chan struct{}
	Failures chan any
	// next is the index in Events of the event that the next call of Next returns.
	next int
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

// Next waits for the next sidecar event and returns it, in the order of delivery: each delivery adds one notice to Seen, so the
// event of a notice is the one after the event of the notice before it, whether or not later events arrived meanwhile. The runner
// ends a check whose event does not come.
func (o *FakeOwner) Next(t *testing.T) host.SidecarMessage {
	t.Helper()
	<-o.Seen
	o.Mu.Lock()
	defer o.Mu.Unlock()
	event := o.Events[o.next]
	o.next++
	return event
}

// SidecarFailure is the JSON form of the sidecar-failure event value (docs/spec/sidecars.md#failure).
type SidecarFailure struct {
	Sidecar string `json:"sidecar"`
	Surface string `json:"surface"`
	Reason  string `json:"reason"`
}

// Failure waits for the next failure event and returns it in the JSON form. The runner ends a check whose failure does not come.
func (o *FakeOwner) Failure(t *testing.T) SidecarFailure {
	t.Helper()
	value := <-o.Failures
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

// SendOpen sends the open request to fixture-service and returns its result. The runner ends a check whose send does not return.
func SendOpen(sidecars *host.Sidecars, owner *HarnessOwner) error {
	return sidecars.Send(owner, "fixture-service", "surface", json.RawMessage(`{"operation":"open"}`))
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
