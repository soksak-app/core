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

// SidecarFailure is the sidecar-failure event value (docs/spec/sidecars.md#failure).
type SidecarFailure = host.SidecarFailure

// SidecarRecorder is the owner of the sidecar sends of a test. It records each message and each failure that the real
// sidecar code delivers to it, in the order of delivery, and answers nothing: the project root that a send uses is data that
// Send passes to the sidecars. A delivery never waits for the test, so the reader of a sidecar is never blocked by it.
type SidecarRecorder struct {
	// Root is the project root that Send passes to the sidecars; a test changes it between sends.
	Root string
	t    *testing.T

	mu       sync.Mutex
	messages []host.SidecarMessage
	failures []SidecarFailure
	// nextMessage and nextFailure are the indexes of the record that the next wait returns.
	nextMessage, nextFailure int
	// changed is closed and replaced at each record, so a waiting call wakes without the recorder waiting for anyone.
	changed chan struct{}
}

// NewSidecarRecorder is a recorder that sends with the project root root. At the end of the test it reports each failure
// that the test did not take.
func NewSidecarRecorder(t *testing.T, root string) *SidecarRecorder {
	t.Helper()
	recorder := &SidecarRecorder{Root: root, t: t, changed: make(chan struct{})}
	t.Cleanup(func() {
		recorder.mu.Lock()
		defer recorder.mu.Unlock()
		for _, failure := range recorder.failures[recorder.nextFailure:] {
			t.Errorf("sidecar failure that the test did not take: %+v", failure)
		}
	})
	return recorder
}

// Send sends body of surface to the sidecar name with the root of the recorder.
func (o *SidecarRecorder) Send(sidecars *host.Sidecars, name, surface string, body json.RawMessage) error {
	return o.SendWithCids(sidecars, name, surface, body, nil)
}

// SendWithCids is Send of a request that continues the inputs named by cids.
func (o *SidecarRecorder) SendWithCids(sidecars *host.Sidecars, name, surface string, body json.RawMessage, cids []string) error {
	return sidecars.SendAtRoot(o, name, surface, o.Root, body, cids)
}

// ProjectRoot is the project root of the window, which a send of the host that names no root, such as the image detach of a
// reload, reads.
func (o *SidecarRecorder) ProjectRoot() string {
	return o.Root
}

// record appends add to the records under the mutex and wakes the waiting calls.
func (o *SidecarRecorder) record(add func()) {
	o.mu.Lock()
	defer o.mu.Unlock()
	add()
	close(o.changed)
	o.changed = make(chan struct{})
}

func (o *SidecarRecorder) Emit(name string, data ...any) {
	if failure, ok := failureOf(name, data); ok {
		o.record(func() { o.failures = append(o.failures, failure) })
		return
	}
	o.t.Errorf("unexpected event %q with %d values", name, len(data))
}

// failureOf is the failure that the event name with data carries.
func failureOf(name string, data []any) (SidecarFailure, bool) {
	if name != "sidecar-failure" || len(data) != 1 {
		return SidecarFailure{}, false
	}
	failure, ok := data[0].(SidecarFailure)
	return failure, ok
}

func (o *SidecarRecorder) DeliverSidecarMessage(message host.SidecarMessage) {
	o.record(func() { o.messages = append(o.messages, message) })
}

// Next waits for the next sidecar message and returns it, in the order of delivery. The runner ends a check whose message does
// not come.
func (o *SidecarRecorder) Next(t *testing.T) host.SidecarMessage {
	t.Helper()
	for {
		o.mu.Lock()
		if o.nextMessage < len(o.messages) {
			message := o.messages[o.nextMessage]
			o.nextMessage++
			o.mu.Unlock()
			return message
		}
		changed := o.changed
		o.mu.Unlock()
		<-changed
	}
}

// Pending returns the next sidecar message that arrived and was not taken, without waiting; ok is false when none arrived.
func (o *SidecarRecorder) Pending() (message host.SidecarMessage, ok bool) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.nextMessage == len(o.messages) {
		return host.SidecarMessage{}, false
	}
	message = o.messages[o.nextMessage]
	o.nextMessage++
	return message, true
}

// Delivered returns every message that arrived, taken or not, in the order of delivery.
func (o *SidecarRecorder) Delivered() []host.SidecarMessage {
	o.mu.Lock()
	defer o.mu.Unlock()
	return append([]host.SidecarMessage(nil), o.messages...)
}

// Failure waits for the next failure event and returns it. The runner ends a check whose failure does not come.
func (o *SidecarRecorder) Failure(t *testing.T) SidecarFailure {
	t.Helper()
	for {
		o.mu.Lock()
		if o.nextFailure < len(o.failures) {
			failure := o.failures[o.nextFailure]
			o.nextFailure++
			o.mu.Unlock()
			return failure
		}
		changed := o.changed
		o.mu.Unlock()
		<-changed
	}
}

// PendingFailure returns the next failure that arrived and was not taken, without waiting; ok is false when none arrived.
func (o *SidecarRecorder) PendingFailure() (failure SidecarFailure, ok bool) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.nextFailure == len(o.failures) {
		return SidecarFailure{}, false
	}
	failure = o.failures[o.nextFailure]
	o.nextFailure++
	return failure, true
}

// ProcessID is the process id that the fixture sidecar recorded.
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

// HarnessDeclarations is the declaration of one persistent sidecar installed in folder.
func HarnessDeclarations(folder string) []host.SidecarDeclaration {
	return []host.SidecarDeclaration{{Name: "fixture-service", Folder: folder,
		Data: []byte(`{"executable":"service","displayName":"soksak://sidecar/probe","protocol":1,"transport":"persistent"}`)}}
}

// SendOpen sends the open request to fixture-service and returns its result. The runner ends a check whose send does not return.
func SendOpen(sidecars *host.Sidecars, owner *SidecarRecorder) error {
	return owner.Send(sidecars, "fixture-service", "surface", json.RawMessage(`{"operation":"open"}`))
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
