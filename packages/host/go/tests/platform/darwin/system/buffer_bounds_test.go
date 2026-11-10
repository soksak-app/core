//go:build darwin

package system_test

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	host "github.com/soksak-app/core/packages/host/go/src"
	"github.com/soksak-app/core/packages/host/go/tests/support"
)

// blockedSidecar starts a sidecar that reads nothing until the returned function releases it, fills its write queue, and
// returns the sidecars with the registered surfaces s1 to s<surfaces>. The owner has the project root `root`.
func blockedSidecar(t *testing.T, root string, surfaces int) (*host.Sidecars, func()) {
	t.Helper()
	directory := t.TempDir()
	fifo := filepath.Join(directory, "go")
	if err := syscall.Mkfifo(fifo, 0o600); err != nil {
		t.Fatal(err)
	}
	received := filepath.Join(directory, "received")
	script := "#!/bin/sh\ntrap '' TERM\nread _ < " + fifo + "\nexec cat > " + received + "\n"
	if err := os.WriteFile(filepath.Join(directory, "echo"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	sidecars, err := host.NewSidecars(support.Declare(directory, `{"executable":"echo","displayName":"soksak://sidecar/probe","protocol":1}`), directory)
	if err != nil {
		t.Fatal(err)
	}
	owner := support.NewFakeOwner(root)
	for i := 1; i <= surfaces; i++ {
		if err := sidecars.Send(owner, support.EchoSidecar, fmt.Sprintf("s%d", i), json.RawMessage(`{}`)); err != nil {
			t.Fatal(err)
		}
	}
	// A line larger than the pipe of the sidecar (64 KiB at most on macOS) keeps the writer inside its write, so it takes no more
	// lines from the queue; a surface line of a long root does the same. No event reports the start of a write, so the
	// fixture waits on the state of the writer.
	blocker := json.RawMessage(`{"data":"` + strings.Repeat("b", 2<<20) + `"}`)
	if err := sidecars.Send(owner, support.EchoSidecar, "s1", blocker); err != nil {
		t.Fatal(err)
	}
	for wait := 0; ; wait++ {
		writing, err := sidecars.Writing(support.EchoSidecar)
		if err != nil {
			t.Fatal(err)
		}
		if writing > 64<<10 {
			break
		}
		if wait == 10000 {
			t.Fatalf("the writer did not start the line of %d bytes within 10 s (writing %d)", len(blocker), writing)
		}
		time.Sleep(time.Millisecond)
	}
	big := json.RawMessage(`{"data":"` + strings.Repeat("x", 20*1024) + `"}`)
	full := false
	for i := 0; i < 4000 && !full; i++ {
		if err := sidecars.Send(owner, support.EchoSidecar, "s1", big); err != nil {
			if !strings.Contains(err.Error(), "is not keeping up") {
				t.Fatal(err)
			}
			full = true
		}
	}
	if !full {
		t.Fatal("the queue never filled")
	}
	var once sync.Once
	release := func() {
		once.Do(func() {
			file, err := os.OpenFile(fifo, os.O_WRONLY, 0)
			if err != nil {
				t.Error(err)
				return
			}
			file.Write([]byte("go\n"))
			file.Close()
			sidecars.Stop()
		})
	}
	// A test that ends early releases the sidecar too, so Stop does not wait for a process that reads nothing.
	t.Cleanup(release)
	return sidecars, release
}

func response(name string, padding int) json.RawMessage {
	return json.RawMessage(`{"image":{"consumed":{"name":"` + name + `","pad":"` + strings.Repeat("p", padding) + `"}}}`)
}

// contract: buffers.sidecar-replies.bounded-by-messages
func TestThePendingRepliesOfASidecarHoldAtMostOneThousandAndTwentyFourMessages(t *testing.T) {
	log := support.UseRoomyEventLog(t)
	sidecars, release := blockedSidecar(t, "/p", 1)
	var refused []string
	for i := 0; i < 1024+10; i++ {
		if err := sidecars.SendResponse(support.EchoSidecar, "s1", "a", response("a", 0)); err != nil {
			refused = append(refused, err.Error())
		}
	}
	want := "sidecar " + support.EchoSidecar + ": the pending replies reached 1024 messages, so a reply of surface s1 is dropped"
	if len(refused) != 10 || refused[0] != want {
		t.Fatalf("%d replies refused, first %q; want 10 and %q", len(refused), first(refused), want)
	}
	drops := support.BufferDrops(t, log)
	if len(drops) != 10 {
		t.Fatalf("%d events host.buffer.dropped, want 10: %v", len(drops), drops)
	}
	for _, drop := range drops {
		if drop["buffer"] != "sidecar "+support.EchoSidecar+" pending replies" || drop["count"] != float64(1) || drop["reason"] != "the buffer holds 1024 messages" || drop["bytes"].(float64) <= 0 {
			t.Fatalf("drop %v", drop)
		}
	}
	release()
}

// contract: buffers.sidecar-replies.bounded-by-bytes
func TestThePendingRepliesOfASidecarHoldAtMostFourMebibytes(t *testing.T) {
	log := support.UseRoomyEventLog(t)
	sidecars, release := blockedSidecar(t, "/p", 1)
	var refused []string
	for i := 0; i < 4; i++ {
		if err := sidecars.SendResponse(support.EchoSidecar, "s1", "a", response("a", 3<<19)); err != nil {
			refused = append(refused, err.Error())
		}
	}
	if len(refused) != 2 || !strings.HasSuffix(refused[0], "the pending replies reached 4194304 bytes, so a reply of surface s1 is dropped") {
		t.Fatalf("refused %q; want two refusals that name 4194304 bytes", refused)
	}
	drops := support.BufferDrops(t, log)
	if len(drops) != 2 || drops[0]["reason"] != "the buffer holds 4194304 bytes" || drops[0]["count"] != float64(1) || drops[0]["bytes"].(float64) < 3<<19 {
		t.Fatalf("drops %v", drops)
	}
	release()
}

// contract: buffers.sidecar-closes.bounded-and-forgotten
func TestAPendingCloseBeyondTheBoundIsDroppedAndTheSurfaceIsNotWaitedFor(t *testing.T) {
	log := support.UseRoomyEventLog(t)
	// A long project root makes each close message large, so the bound in bytes is reached with few surfaces.
	root := "/" + strings.Repeat("r", 200<<10)
	sidecars, release := blockedSidecar(t, root, 30)
	for i := 1; i <= 30; i++ {
		sidecars.Close(fmt.Sprintf("s%d", i))
	}
	drops := support.BufferDrops(t, log)
	if len(drops) == 0 {
		t.Fatal("no close was dropped")
	}
	for _, drop := range drops {
		if drop["buffer"] != "sidecar "+support.EchoSidecar+" pending closes" || drop["count"] != float64(1) || drop["reason"] != "the buffer holds 4194304 bytes" {
			t.Fatalf("drop %v", drop)
		}
	}
	// A dropped close is not awaited: the surfaces that wait for a reply are those whose close message was buffered.
	if waiting := len(sidecars.Closing()); waiting != 30-len(drops) {
		t.Fatalf("%d surfaces wait for a reply and %d closes were dropped; want 30 in all", waiting, len(drops))
	}
	release()
}

// contract: sidecars.write.wait-is-recorded
func TestALineThatWaitsInTheWriteQueueOfASidecarIsRecorded(t *testing.T) {
	log := support.UseRoomyEventLog(t)
	_, release := blockedSidecar(t, "/p", 1)
	// The sidecar reads nothing, so the queued lines wait at least this long before the release lets the writer go on.
	time.Sleep(1100 * time.Millisecond)
	release()
	waits := support.WriteWaits(t, log)
	queued, blocked := 0, 0
	for _, wait := range waits {
		if wait["name"] != support.EchoSidecar || wait["bytes"].(float64) <= 0 {
			t.Fatalf("write wait %v does not name %s with the bytes of the line", wait, support.EchoSidecar)
		}
		if wait["queued_us"].(float64) >= 1e6 {
			queued++
		}
		if wait["write_us"].(float64) >= 1e6 {
			blocked++
		}
	}
	if queued == 0 || blocked != 1 {
		t.Fatalf("%d waits of a second in the queue and %d blocked writes, want some and 1: %v", queued, blocked, waits)
	}
}

func first(list []string) string {
	if len(list) == 0 {
		return ""
	}
	return list[0]
}
