//go:build darwin

package system_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"

	host "github.com/soksak-app/core/packages/host/go/src"
	"github.com/soksak-app/core/packages/host/go/tests/support"
)

// closedSurfaces are the surfaces that the flush scenario closes while the queue is full. The writer is inside a line larger than
// any pipe of the sidecar from before the queue fills until the release, so it takes no line out of the queue and every close
// waits.
var closedSurfaces = []string{"s2", "s3", "s4", "s5", "s6", "s7", "s8", "s9"}

// sendUntilFull sends big on s1 until the queue refuses it.
func sendUntilFull(t *testing.T, sidecars *host.Sidecars, owner *support.SidecarRecorder, big json.RawMessage) {
	t.Helper()
	for i := 0; i < 4000; i++ {
		if err := owner.Send(sidecars, support.EchoSidecar, "s1", big); err != nil {
			if !strings.Contains(err.Error(), "is not keeping up") {
				t.Fatal(err)
			}
			return
		}
	}
	t.Fatal("the queue never filled")
}

// readFIFO reads the FIFO at path until its writer closes it, so it ends by that event.
func readFIFO(t *testing.T, path string) {
	t.Helper()
	if _, err := os.ReadFile(path); err != nil {
		t.Fatal(err)
	}
}

// writeFIFO writes one line to the FIFO at path, which ends a `read _ < path` of the sidecar.
func writeFIFO(t *testing.T, path string) {
	t.Helper()
	file, err := os.OpenFile(path, os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	if _, err := file.Write([]byte("go\n")); err != nil {
		t.Fatal(err)
	}
}

// A reply held for the full queue reaches the sidecar before a close that the queue accepts after it. The sidecar reads one
// byte of a line larger than its pipe, so the writer is inside that line while the bodies fill the queue and the reply waits.
// Then the sidecar reads that line, the next one and one byte of the third: the writer has taken two lines out of the queue, so
// the close finds room while the queue still holds bodies.
// contract: flush.buffer.written-in-the-order-of-sending
func TestAReplyHeldForTheQueueIsWrittenBeforeALaterLine(t *testing.T) {
	written := support.CaptureLog(t)
	directory := t.TempDir()
	taken, room, release := filepath.Join(directory, "taken"), filepath.Join(directory, "room"), filepath.Join(directory, "go")
	for _, fifo := range []string{taken, room, release} {
		if err := syscall.Mkfifo(fifo, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	received := filepath.Join(directory, "received")
	// The sidecar writes on its way out, so it ignores the terminate signal of the stop and ends with its input.
	support.Fixture(t, directory, "echo", "ignore-term\n"+
		"read-byte "+received+"\n"+
		"append "+taken+"\n"+
		"wait "+release+"\n"+
		"keep-line "+received+"\n"+
		"keep-line "+received+"\n"+
		"read-byte "+received+"\n"+
		"append "+room+"\n"+
		"wait "+release+"\n"+
		"drain "+received+"\n")
	sidecars, err := host.NewSidecars(support.Declare(directory, `{"executable":"echo","displayName":"soksak://sidecar/probe","protocol":1}`), directory)
	if err != nil {
		t.Fatal(err)
	}
	owner := support.NewSidecarRecorder(t, "/p")
	// A line larger than any pipe of the sidecar keeps the writer inside it.
	huge := json.RawMessage(`{"data":"` + strings.Repeat("y", 512*1024) + `"}`)
	if err := owner.Send(sidecars, support.EchoSidecar, "s1", huge); err != nil {
		t.Fatal(err)
	}
	readFIFO(t, taken)
	sendUntilFull(t, sidecars, owner, json.RawMessage(`{"data":"`+strings.Repeat("x", 20*1024)+`"}`))
	reply, _ := json.Marshal(host.AfterPresent(true, "", "a", 1, 1, 1))
	if err := sidecars.SendResponse(support.EchoSidecar, "s1", "a", reply); err != nil {
		t.Fatal(err)
	}
	if want := " info host sidecar @fixture/sidecar-echo: response queue full, buffering "; !strings.Contains(written(), want) {
		t.Fatalf("the reply did not wait for the full queue:\n%s", written())
	}
	writeFIFO(t, release)
	readFIFO(t, room)
	sidecars.Close("s1")
	if held := " info host sidecar @fixture/sidecar-echo: close s1: outbox full, buffered"; strings.Contains(written(), held) {
		t.Fatalf("the close found no room:\n%s", written())
	}
	writeFIFO(t, release)
	sidecars.Stop()
	data, err := os.ReadFile(received)
	if err != nil {
		t.Fatal(err)
	}
	text := string(data)
	replied := strings.Index(text, `"name":"a"`)
	closed := strings.Index(text, `"surface":"s1","root":"/p","closed":true`)
	if replied < 0 || closed < 0 {
		t.Fatalf("the reply at %d or the close at %d did not arrive", replied, closed)
	}
	if last := strings.LastIndex(text, `"data":"`); replied < last {
		t.Errorf("the reply arrived before a body that the queue accepted before it")
	}
	if closed < replied {
		t.Errorf("the close arrived before the reply that was held before it")
	}
}

// TestEveryPendingReplyIsFlushedAfterTheQueueDrains verifies that, when the write queue is full, all
// buffered replies and closes are written in the correct order after the queue is emptied.
// contract: flush.queue.rejects-send-when-full, flush.queue.full-error-says-not-keeping-up, flush.buffer.replies-delivered-after-drain, flush.buffer.closes-delivered-after-drain, flush.buffer.consumed-acks-not-coalesced, flush.buffer.delivered-after-queued-bodies, sidecars.close.buffered-close-is-recorded
func TestEveryPendingReplyIsFlushedAfterTheQueueDrains(t *testing.T) {
	written := support.CaptureLog(t)
	directory := t.TempDir()
	fifo := filepath.Join(directory, "go")
	taken := filepath.Join(directory, "taken")
	for _, path := range []string{fifo, taken} {
		if err := syscall.Mkfifo(path, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	received := filepath.Join(directory, "received")
	// The first line is larger than any pipe of the sidecar. The sidecar reads one byte of it and then waits for the release, so
	// the writer is inside that line and takes no line out of the queue until the release: the queue stays full for every reply
	// and close that follows. After the release the sidecar drops the rest of that line and keeps every line after it.
	support.Fixture(t, directory, "echo", "ignore-term\n"+
		"read-byte /dev/null\n"+
		"append "+taken+"\n"+
		"wait "+fifo+"\n"+
		"skip-line\n"+
		"drain "+received+"\n")
	sidecars, err := host.NewSidecars(support.Declare(directory, `{"executable":"echo","displayName":"soksak://sidecar/probe","protocol":1}`), directory)
	if err != nil {
		t.Fatal(err)
	}
	owner := support.NewSidecarRecorder(t, "/p")
	// The first line registers s1 and holds the writer; the next lines register the surfaces to close (Close notifies only
	// registered surfaces).
	if err := owner.Send(sidecars, support.EchoSidecar, "s1", json.RawMessage(`{"hold":"`+strings.Repeat("y", 512*1024)+`"}`)); err != nil {
		t.Fatal(err)
	}
	readFIFO(t, taken)
	for _, s := range closedSurfaces {
		if err := owner.Send(sidecars, support.EchoSidecar, s, json.RawMessage(`{}`)); err != nil {
			t.Fatal(err)
		}
	}
	// Fills the queue.
	sendUntilFull(t, sidecars, owner, json.RawMessage(`{"data":"`+strings.Repeat("x", 20*1024)+`"}`))
	// Three returns and two closes with different surfaces and names in the full state.
	for i, name := range []string{"a", "b", "c"} {
		bodyMap := host.AfterPresent(true, "", name, 1, 1, i+1)
		bodyBytes, _ := json.Marshal(bodyMap)
		if err := sidecars.SendResponse(support.EchoSidecar, "s1", name, json.RawMessage(bodyBytes)); err != nil {
			t.Fatal(err)
		}
	}
	// Sends again to the same picture a with a different sequence. All immutable frame acks must arrive.
	bodyMap := host.AfterPresent(true, "", "a", 1, 1, 4)
	bodyBytes, _ := json.Marshal(bodyMap)
	if err := sidecars.SendResponse(support.EchoSidecar, "s1", "a", json.RawMessage(bodyBytes)); err != nil {
		t.Fatal(err)
	}
	for _, surface := range closedSurfaces {
		sidecars.Close(surface)
	}
	// A close that waits for the full queue is recorded with its surface.
	for _, surface := range closedSurfaces {
		if buffered := " info host sidecar @fixture/sidecar-echo: close " + surface + ": outbox full, buffered"; !strings.Contains(written(), buffered) {
			t.Errorf("the log does not record %q:\n%s", buffered, written())
		}
	}
	// Releases the sidecar. Nothing more is sent after that.
	f, err := os.OpenFile(fifo, os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	f.Write([]byte("go\n"))
	f.Close()
	sidecars.Stop() // Writes the queue and all held messages and then closes stdin. cat ends.
	data, err := os.ReadFile(received)
	if err != nil {
		t.Fatal(err)
	}
	text := string(data)
	for _, want := range []string{`"name":"a"`, `"name":"b"`, `"name":"c"`} {
		if !strings.Contains(text, want) {
			t.Errorf("reply %s never reached the sidecar", want)
		}
	}
	for _, surface := range closedSurfaces {
		if s := `"surface":"` + surface + `","root":"/p","closed":true`; !strings.Contains(text, s) {
			t.Errorf("close %s never reached the sidecar", s)
		}
	}
	// The actual JSON field order is based on the Marshal result. Each immutable frame ack
	// must arrive exactly once, and a new sequence of the same image does not overwrite the previous frame.
	for _, pattern := range []string{
		`"name":"a","raster":1,"sequence":1`,
		`"name":"b","raster":1,"sequence":2`,
		`"name":"c","raster":1,"sequence":3`,
		`"name":"a","raster":1,"sequence":4`,
	} {
		if count := strings.Count(text, pattern); count != 1 {
			t.Errorf("image frame %s should appear exactly once, appeared %d times", pattern, count)
		}
	}

	// Order: the closes and the returns come after the large bodies that entered the queue first.
	last := strings.LastIndex(text, `"data":"`)
	if last < 0 {
		t.Fatal("no queued body arrived")
	}
	for _, want := range []string{`"name":"a"`, `"surface":"s2","root":"/p","closed":true`} {
		switch i := strings.Index(text, want); {
		case i < 0:
			t.Errorf("%s did not arrive", want)
		case i < last:
			t.Errorf("%s arrived before the queued bodies", want)
		}
	}
}

// TestACloseThatFindsRoomWritesNoBufferedRecord fills the queue and lets the sidecar read after that. The receipts of the
// sidecar show that the writer has taken lines out of the queue, so the close finds room, as a close does when the writer
// takes a line just after the queue was full.
// contract: sidecars.close.room-has-no-buffered-record
func TestACloseThatFindsRoomWritesNoBufferedRecord(t *testing.T) {
	written := support.CaptureLog(t)
	directory := t.TempDir()
	fifo := filepath.Join(directory, "go")
	if err := syscall.Mkfifo(fifo, 0o600); err != nil {
		t.Fatal(err)
	}
	support.Fixture(t, directory, "echo", "wait "+fifo+"\n"+
		"on any reply {\"surface\":\"s1\",\"body\":\"received\"}\n")
	sidecars, err := host.NewSidecars(support.Declare(directory, `{"executable":"echo","displayName":"soksak://sidecar/probe","protocol":1}`), directory)
	if err != nil {
		t.Fatal(err)
	}
	owner := support.NewSidecarRecorder(t, "/p")
	for _, s := range []string{"s1", "s2"} {
		if err := owner.Send(sidecars, support.EchoSidecar, s, json.RawMessage(`{}`)); err != nil {
			t.Fatal(err)
		}
	}
	big := json.RawMessage(`{"data":"` + strings.Repeat("x", 20*1024) + `"}`)
	full := false
	for i := 0; i < 4000 && !full; i++ {
		if err := owner.Send(sidecars, support.EchoSidecar, "s1", big); err != nil {
			if !strings.Contains(err.Error(), "is not keeping up") {
				t.Fatal(err)
			}
			full = true
		}
	}
	if !full {
		t.Fatal("the queue never filled")
	}
	f, err := os.OpenFile(fifo, os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	f.Write([]byte("go\n"))
	f.Close()
	// The receipts of the sidecar show that the writer has taken lines out of the queue.
	for range 10 {
		owner.Next(t)
	}
	sidecars.Close("s2")
	sidecars.Stop()
	if refused := " info host sidecar @fixture/sidecar-echo: close s2: outbox full, buffered"; strings.Contains(written(), refused) {
		t.Errorf("the log has %q:\n%s", refused, written())
	}
}

// TestOrderIsCorrectWhenStopFlushesBufferedMessages verifies that Stop() writes all
// buffered messages before it closes stdin, so no message is lost.
// contract: flush.queue.rejects-send-when-full, flush.queue.full-error-says-not-keeping-up, flush.buffer.replies-delivered-after-drain, flush.buffer.closes-delivered-after-drain
func TestOrderIsCorrectWhenStopFlushesBufferedMessages(t *testing.T) {
	directory := t.TempDir()
	fifo := filepath.Join(directory, "go")
	if err := syscall.Mkfifo(fifo, 0o600); err != nil {
		t.Fatal(err)
	}
	received := filepath.Join(directory, "received")
	support.Fixture(t, directory, "echo", "ignore-term\n"+
		"wait "+fifo+"\n"+
		"drain "+received+"\n")
	sidecars, err := host.NewSidecars(support.Declare(directory, `{"executable":"echo","displayName":"soksak://sidecar/probe","protocol":1}`), directory)
	if err != nil {
		t.Fatal(err)
	}
	owner := support.NewSidecarRecorder(t, "/p")

	// Surface registration
	for _, s := range []string{"s1", "s2"} {
		if err := owner.Send(sidecars, support.EchoSidecar, s, json.RawMessage(`{}`)); err != nil {
			t.Fatal(err)
		}
	}

	// Fills the queue.
	big := json.RawMessage(`{"data":"` + strings.Repeat("x", 20*1024) + `"}`)
	full := false
	for i := 0; i < 4000 && !full; i++ {
		if err := owner.Send(sidecars, support.EchoSidecar, "s1", big); err != nil {
			if !strings.Contains(err.Error(), "is not keeping up") {
				t.Fatal(err)
			}
			full = true
		}
	}
	if !full {
		t.Fatal("the queue never filled")
	}

	// The messages to hold in the full state
	for i, name := range []string{"x", "y", "z"} {
		bodyMap := host.AfterPresent(true, "", name, 1, 1, i+1)
		bodyBytes, _ := json.Marshal(bodyMap)
		if err := sidecars.SendResponse(support.EchoSidecar, "s1", name, json.RawMessage(bodyBytes)); err != nil {
			t.Fatal(err)
		}
	}
	sidecars.Close("s2")

	// Releases the sidecar.
	f, err := os.OpenFile(fifo, os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	f.Write([]byte("go\n"))
	f.Close()

	// Calling Stop() must write all held messages and then close stdin.
	sidecars.Stop()

	data, err := os.ReadFile(received)
	if err != nil {
		t.Fatal(err)
	}
	text := string(data)

	// Checks that all held messages arrived
	for _, want := range []string{`"name":"x"`, `"name":"y"`, `"name":"z"`, `"surface":"s2","root":"/p","closed":true`} {
		if !strings.Contains(text, want) {
			t.Errorf("buffered message %s was lost", want)
		}
	}
}
