package darwin

import (
	"net"
	"os"
	"path/filepath"
	"testing"
)

// contract: sidecars.process-identity.reads-the-peer-process-from-the-socket
func TestPeerProcessIsTheProcessThatConnected(t *testing.T) {
	// The socket path must fit the sun_path limit of darwin, 104 bytes; t.TempDir holds the test name and exceeds it.
	dir, err := os.MkdirTemp("", "peer")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.RemoveAll(dir); err != nil {
			t.Error(err)
		}
	})
	address := filepath.Join(dir, "s")
	listener, err := net.Listen("unix", address)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	client, err := net.Dial("unix", address)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	conn, err := listener.Accept()
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	pid, err := implementation{}.PeerProcess(conn)
	if err != nil || pid != os.Getpid() {
		t.Fatalf("PeerProcess = %d, %v; want %d", pid, err, os.Getpid())
	}
}

// contract: sidecars.process-identity.reads-the-parent-and-the-start-time
func TestProcessEntryReadsTheParentOfAProcess(t *testing.T) {
	entry, found, err := implementation{}.ProcessEntry(os.Getpid())
	if err != nil || !found || entry.Parent != os.Getppid() || entry.Started <= 0 {
		t.Fatalf("ProcessEntry = %+v, %v, %v; want the parent %d", entry, found, err, os.Getppid())
	}
	if _, found, err := (implementation{}).ProcessEntry(0); err != nil || found {
		t.Fatalf("ProcessEntry(0) = %v, %v; want not found", found, err)
	}
}
