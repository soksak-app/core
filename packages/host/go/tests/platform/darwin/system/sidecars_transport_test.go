//go:build darwin

package system_test

import (
	"bufio"
	"encoding/json"
	"io"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"

	host "github.com/soksak-app/core/packages/host/go/src"
	"github.com/soksak-app/core/packages/host/go/tests/support"
)

// A service that the host started is the leader of a new session. So it does not receive the signals of the process group and the terminal of the application.
// The service writes its number to a file, prints the endpoint, and remains until the check ends it.
// contract: sidecars-transport.persistent.starts-in-new-session
func TestPersistentServiceStartsInANewSession(t *testing.T) {
	t.Setenv("SOKSAK_SIDECAR_DISPLAY_NAME", "inherited-value")
	executableDir := t.TempDir()
	socketDir := support.SocketParent(t)
	socket := filepath.Join(socketDir, "service.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	pidPath := filepath.Join(executableDir, "pid")
	environmentPath := filepath.Join(executableDir, "display-name")
	support.Fixture(t, executableDir, "service", "record-pid "+pidPath+"\nrecord-env SOKSAK_SIDECAR_DISPLAY_NAME "+environmentPath+"\nendpoint "+socket+" harness-token\nsleep 600\n")
	serverDone := make(chan error, 1)
	go func() {
		connection, err := listener.Accept()
		if err != nil {
			serverDone <- err
			return
		}
		defer connection.Close()
		reader := bufio.NewReader(connection)
		if _, err := reader.ReadBytes('\n'); err != nil {
			serverDone <- err
			return
		}
		if _, err := io.WriteString(connection, `{"operation":"hello","protocol":1,"ok":true}`+"\n"); err != nil {
			serverDone <- err
			return
		}
		line, err := reader.ReadBytes('\n')
		if err != nil {
			serverDone <- err
			return
		}
		if _, err := connection.Write(line); err != nil {
			serverDone <- err
			return
		}
		line, err = reader.ReadBytes('\n')
		if err != nil {
			serverDone <- err
			return
		}
		var closeRequest map[string]any
		if err := json.Unmarshal(line, &closeRequest); err != nil {
			serverDone <- err
			return
		}
		response, _ := json.Marshal(map[string]any{
			"operation": "closed-owner", "request": closeRequest["request"], "ok": false, "error": "test close",
		})
		_, err = connection.Write(append(response, '\n'))
		serverDone <- err
	}()
	sidecars, err := host.NewSidecars(support.HarnessDeclarations(executableDir), t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	owner := &support.HarnessOwner{Root: "/session", Seen: make(chan host.SidecarMessage, 4)}
	if err := support.SendOpen(sidecars, owner); err != nil {
		t.Fatal(err)
	}
	if data, err := os.ReadFile(environmentPath); err != nil {
		t.Fatal(err)
	} else if string(data) != "inherited-value" {
		t.Fatalf("persistent child display-name environment = %q, want inherited value unchanged", data)
	}
	// The service wrote its number before it printed the endpoint.
	data, err := os.ReadFile(pidPath)
	if err != nil {
		t.Fatal(err)
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(data)))
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := syscall.Kill(pid, syscall.SIGKILL); err != nil {
			t.Errorf("end the service %d: %v", pid, err)
		}
	}()
	session, err := syscall.Getsid(pid)
	if err != nil {
		t.Fatalf("session of the service %d: %v", pid, err)
	}
	if session != pid {
		own, _ := syscall.Getsid(0)
		t.Fatalf("the service %d is in session %d (the test is in session %d), want its own session", pid, session, own)
	}
	sidecars.Stop()
	if err := <-serverDone; err != nil {
		t.Fatal(err)
	}
}
