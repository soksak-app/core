package host

import (
	"encoding/binary"
	"encoding/json"
	"io"
	"net"
	"os"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/soksak-app/core/packages/host/go/src/platform"
)

// activityPlatform records each state of the connection activity that the endpoint requests.
type activityPlatform struct {
	platform.Platform
	mu       sync.Mutex
	requests []bool
	released chan struct{}
}

func (p *activityPlatform) HoldConnectionActivity(held bool) error {
	p.mu.Lock()
	p.requests = append(p.requests, held)
	p.mu.Unlock()
	if !held {
		p.released <- struct{}{}
	}
	return nil
}

func (p *activityPlatform) requested() []bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return slices.Clone(p.requests)
}

// listWindows sends windows.list on conn and reads its response, which the endpoint sends after it registered the connection.
func listWindows(t *testing.T, conn net.Conn, id int) {
	t.Helper()
	body, err := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": id, "method": "windows.list"})
	if err != nil {
		t.Fatalf("encode windows.list: %v", err)
	}
	if _, err := conn.Write(append(binary.BigEndian.AppendUint32(nil, uint32(len(body))), body...)); err != nil {
		t.Fatalf("write windows.list %d: %v", id, err)
	}
	var size [4]byte
	if _, err := io.ReadFull(conn, size[:]); err != nil {
		t.Fatalf("read windows.list response %d: %v", id, err)
	}
	if _, err := io.ReadFull(conn, make([]byte, binary.BigEndian.Uint32(size[:]))); err != nil {
		t.Fatalf("read windows.list response body %d: %v", id, err)
	}
}

// The host holds the connection activity while a connection of its endpoint is open, so the system does not run it in the
// background while a client waits for its answers, and releases it when the last connection closes.
// contract: endpoint.connection.holds-activity
func TestTheEndpointHoldsTheActivityWhileAConnectionIsOpen(t *testing.T) {
	registered, err := platform.Current()
	if err != nil {
		t.Fatal(err)
	}
	fake := &activityPlatform{Platform: registered, released: make(chan struct{}, 4)}
	t.Cleanup(platform.Substitute(fake))
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	endpoint := NewEndpoint(diagnosticsClockBackend{})
	info := EndpointInfo{Transport: "unix", Address: listener.Addr().String(), PID: os.Getpid(), Application: "fixture",
		Version: "0.0.2", Started: time.Now()}
	if err := endpoint.Serve(listener, info, t.TempDir()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := endpoint.Close(); err != nil {
			t.Errorf("close the endpoint: %v", err)
		}
	})
	if got := fake.requested(); len(got) != 0 {
		t.Fatalf("activity requests before a connection %v, want none", got)
	}
	first, err := net.Dial("tcp", listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	listWindows(t, first, 1)
	second, err := net.Dial("tcp", listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	listWindows(t, second, 2)
	if got := fake.requested(); !slices.Equal(got, []bool{true}) {
		t.Fatalf("activity requests with two open connections %v, want [true]", got)
	}
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
	if err := second.Close(); err != nil {
		t.Fatal(err)
	}
	<-fake.released
	if got := fake.requested(); !slices.Equal(got, []bool{true, false}) {
		t.Fatalf("activity requests after both connections closed %v, want [true false]", got)
	}
}
