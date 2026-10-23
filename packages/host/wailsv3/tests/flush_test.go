package host_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"

	host "github.com/soksak-app/core/packages/host/wailsv3/src"
)

// TestEveryPendingReplyIsFlushedAfterTheQueueDrains verifies that, when the write queue is full, all
// buffered replies and closes are written in the correct order after the queue is emptied.
// contract: flush.queue.rejects-send-when-full, flush.queue.full-error-says-not-keeping-up, flush.buffer.replies-delivered-after-drain, flush.buffer.closes-delivered-after-drain, flush.buffer.consumed-acks-not-coalesced, flush.buffer.delivered-after-queued-bodies, sidecars.close.buffered-close-is-recorded
func TestEveryPendingReplyIsFlushedAfterTheQueueDrains(t *testing.T) {
	written := captureLog(t)
	directory := t.TempDir()
	fifo := filepath.Join(directory, "go")
	if err := syscall.Mkfifo(fifo, 0o600); err != nil {
		t.Fatal(err)
	}
	received := filepath.Join(directory, "received")
	// The sidecar blocks the moment it opens the FIFO for reading. Meanwhile it does not read stdin. This is not polling.
	script := "#!/bin/sh\nread _ < " + fifo + "\nexec cat > " + received + "\n"
	if err := os.WriteFile(filepath.Join(directory, "echo"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	sidecars, err := host.NewSidecars(declare(directory, `{"executable":"echo","displayName":"soksak://sidecar/probe","protocol":1}`), directory)
	if err != nil {
		t.Fatal(err)
	}
	owner := newFakeOwner("/p")
	// Registers the surfaces to close first (Close notifies only registered surfaces).
	for _, s := range []string{"s1", "s2", "s3"} {
		if err := sidecars.Send(owner, echoSidecar, s, json.RawMessage(`{}`)); err != nil {
			t.Fatal(err)
		}
	}
	// Fills the queue and the pipe buffer.
	big := json.RawMessage(`{"data":"` + strings.Repeat("x", 20*1024) + `"}`)
	full := false
	for i := 0; i < 4000 && !full; i++ {
		if err := sidecars.Send(owner, echoSidecar, "s1", big); err != nil {
			if !strings.Contains(err.Error(), "is not keeping up") {
				t.Fatal(err)
			}
			full = true
		}
	}
	if !full {
		t.Fatal("the queue never filled")
	}
	// Three returns and two closes with different surfaces and names in the full state.
	for i, name := range []string{"a", "b", "c"} {
		bodyMap := host.AfterPresent(true, "", name, 1, 1, i+1)
		bodyBytes, _ := json.Marshal(bodyMap)
		if err := sidecars.SendResponse(echoSidecar, "s1", name, json.RawMessage(bodyBytes)); err != nil {
			t.Fatal(err)
		}
	}
	// Sends again to the same picture a with a different sequence. All immutable frame acks must arrive.
	bodyMap := host.AfterPresent(true, "", "a", 1, 1, 4)
	bodyBytes, _ := json.Marshal(bodyMap)
	if err := sidecars.SendResponse(echoSidecar, "s1", "a", json.RawMessage(bodyBytes)); err != nil {
		t.Fatal(err)
	}
	sidecars.Close("s2")
	sidecars.Close("s3")
	// A close that waits for the full queue is recorded with its surface.
	for _, surface := range []string{"s2", "s3"} {
		if want := " info host sidecar @fixture/sidecar-echo: close " + surface + ": outbox full, buffered"; !strings.Contains(written(), want) {
			t.Errorf("the log has no %q:\n%s", want, written())
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
	for _, s := range []string{`"surface":"s2","root":"/p","closed":true`, `"surface":"s3","root":"/p","closed":true`} {
		if !strings.Contains(text, s) {
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
	script := "#!/bin/sh\nread _ < " + fifo + "\nexec cat > " + received + "\n"
	if err := os.WriteFile(filepath.Join(directory, "echo"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	sidecars, err := host.NewSidecars(declare(directory, `{"executable":"echo","displayName":"soksak://sidecar/probe","protocol":1}`), directory)
	if err != nil {
		t.Fatal(err)
	}
	sidecars.StopTimeout = stall // Makes Stop() wait until cat receives 5MB and ends. The deadline catches only a hang
	owner := newFakeOwner("/p")

	// Surface registration
	for _, s := range []string{"s1", "s2"} {
		if err := sidecars.Send(owner, echoSidecar, s, json.RawMessage(`{}`)); err != nil {
			t.Fatal(err)
		}
	}

	// Fills the queue.
	big := json.RawMessage(`{"data":"` + strings.Repeat("x", 20*1024) + `"}`)
	full := false
	for i := 0; i < 4000 && !full; i++ {
		if err := sidecars.Send(owner, echoSidecar, "s1", big); err != nil {
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
		if err := sidecars.SendResponse(echoSidecar, "s1", name, json.RawMessage(bodyBytes)); err != nil {
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
