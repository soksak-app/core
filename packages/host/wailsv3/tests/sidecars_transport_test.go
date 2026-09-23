package host_test

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"testing/fstest"
	"time"

	host "github.com/min-median-max/soksak/packages/host/wailsv3/src"
)

type SidecarMessage = host.SidecarMessage

var NewSidecars = host.NewSidecars

type harnessOwner struct {
	root string
	seen chan SidecarMessage
}

func (o *harnessOwner) ProjectRoot() string { return o.root }
func (o *harnessOwner) Emit(name string, data ...any) {
	if name == "sidecar-message" && len(data) == 1 {
		o.seen <- data[0].(SidecarMessage)
	}
}

func harnessFrontend() fstest.MapFS {
	return fstest.MapFS{
		"environment.json":                     {Data: []byte(`{"plugins":["fixture"]}`)},
		"modules/fixture/plugin.json":          {Data: []byte(`{"sidecars":["fixture-service"]}`)},
		"modules/fixture-service/sidecar.json": {Data: []byte(`{"executable":"build/service","protocol":1,"transport":"persistent"}`)},
	}
}

func writeHarnessEndpoint(t *testing.T, directory, socket string) {
	t.Helper()
	service := filepath.Join(directory, "services", "service")
	if err := os.MkdirAll(service, 0o700); err != nil {
		t.Fatal(err)
	}
	endpoint, err := json.Marshal(map[string]any{
		"protocol": 1, "pid": os.Getpid(), "socket": socket, "token": "harness-token",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(service, "endpoint.json"), endpoint, 0o600); err != nil {
		t.Fatal(err)
	}
}

func serveHarnessConnections(t *testing.T, listener net.Listener, connections int, rejectClose bool) <-chan error {
	t.Helper()
	done := make(chan error, 1)
	go func() {
		var wg sync.WaitGroup
		var firstErr error
		for index := 0; index < connections; index++ {
			connection, err := listener.Accept()
			if err != nil {
				firstErr = err
				break
			}
			connectionIndex := index
			wg.Add(1)
			go func() {
				defer wg.Done()
				defer connection.Close()
				reader := bufio.NewReader(connection)
				line, err := reader.ReadBytes('\n')
				if err != nil {
					if firstErr == nil {
						firstErr = err
					}
					return
				}
				var hello map[string]any
				if err := json.Unmarshal(line, &hello); err != nil || hello["operation"] != "hello" || hello["token"] != "harness-token" {
					_, _ = io.WriteString(connection, `{"operation":"hello","ok":false,"error":"authentication failed"}`+"\n")
					return
				}
				_, _ = io.WriteString(connection, `{"operation":"hello","protocol":1,"ok":true}`+"\n")
				line, err = reader.ReadBytes('\n')
				if err != nil {
					return
				}
				var request map[string]any
				if json.Unmarshal(line, &request) != nil {
					return
				}
				if request["operation"] == "close-owner" {
					if rejectClose {
						_, _ = io.WriteString(connection, `{"operation":"closed-owner","request":"1","ok":false,"error":"close failed"}`+"\n")
					}
					return
				}
				_, _ = connection.Write(line)
				// The first two connections model a runtime disconnect. Reconnect
				// must use the endpoint and preserve the host's declared identity.
				if connectionIndex < 2 {
					return
				}
				for {
					line, err = reader.ReadBytes('\n')
					if err != nil {
						return
					}
					var next map[string]any
					if json.Unmarshal(line, &next) != nil {
						return
					}
					if next["operation"] == "close-owner" {
						requestID, _ := next["request"].(string)
						response, _ := json.Marshal(map[string]any{"operation": "closed-owner", "request": requestID, "ok": false, "error": "close failed"})
						_, _ = connection.Write(append(response, '\n'))
						return
					}
					_, _ = connection.Write(line)
				}
			}()
		}
		wg.Wait()
		done <- firstErr
	}()
	return done
}

// contract: sidecars-transport.endpoint.concurrent-hosts-share-authenticated-service, sidecars-transport.reconnect.after-connection-loss-preserves-owner, sidecars-transport.stop.close-owner-failure-returns-promptly
func TestPersistentTransportHarnessEndpointAuthConcurrentReconnectAndCloseAck(t *testing.T) {
	root := t.TempDir()
	socketDirectory, err := os.MkdirTemp("", "sp-h")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(socketDirectory)
	socket := filepath.Join(socketDirectory, "s.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	writeHarnessEndpoint(t, root, socket)
	serverDone := serveHarnessConnections(t, listener, 4, true)

	first, err := NewSidecars(harnessFrontend(), t.TempDir(), root)
	if err != nil {
		t.Fatal(err)
	}
	second, err := NewSidecars(harnessFrontend(), t.TempDir(), root)
	if err != nil {
		t.Fatal(err)
	}
	firstOwner := &harnessOwner{root: "/first", seen: make(chan SidecarMessage, 4)}
	secondOwner := &harnessOwner{root: "/second", seen: make(chan SidecarMessage, 4)}

	start := make(chan struct{})
	var group sync.WaitGroup
	for _, send := range []func() error{
		func() error {
			<-start
			return first.Send(firstOwner, "fixture-service", "surface-1", json.RawMessage(`{"operation":"open"}`))
		},
		func() error {
			<-start
			return second.Send(secondOwner, "fixture-service", "surface-2", json.RawMessage(`{"operation":"open"}`))
		},
	} {
		group.Add(1)
		go func(send func() error) {
			defer group.Done()
			if err := send(); err != nil {
				t.Error(err)
			}
		}(send)
	}
	close(start)
	group.Wait()
	for _, owner := range []*harnessOwner{firstOwner, secondOwner} {
		select {
		case <-owner.seen:
		case <-time.After(time.Second):
			t.Fatal("no initial event")
		}
	}
	time.Sleep(20 * time.Millisecond)

	// Both initial sockets disconnect. The next send exercises endpoint reuse and reconnect.
	if err := first.Send(firstOwner, "fixture-service", "surface-1", json.RawMessage(`{"operation":"reconnect"}`)); err != nil {
		t.Fatal(err)
	}
	if err := second.Send(secondOwner, "fixture-service", "surface-2", json.RawMessage(`{"operation":"reconnect"}`)); err != nil {
		t.Fatal(err)
	}
	for _, owner := range []*harnessOwner{firstOwner, secondOwner} {
		select {
		case <-owner.seen:
		case <-time.After(time.Second):
			t.Fatal("no reconnect event")
		}
	}

	startStop := time.Now()
	first.Stop()
	second.Stop()
	if elapsed := time.Since(startStop); elapsed > time.Second {
		t.Fatalf("close-owner failure was not reported promptly: %s", elapsed)
	}
	if err := <-serverDone; err != nil {
		t.Fatal(err)
	}
}

// contract: sidecars-transport.hello.rejects-auth-failure
func TestPersistentTransportHarnessAuthFailure(t *testing.T) {
	root := t.TempDir()
	socketDirectory, err := os.MkdirTemp("", "sp-h")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(socketDirectory)
	socket := filepath.Join(socketDirectory, "s.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	writeHarnessEndpoint(t, root, socket)
	go func() {
		connection, err := listener.Accept()
		if err != nil {
			return
		}
		defer connection.Close()
		_, _ = bufio.NewReader(connection).ReadBytes('\n')
		_, _ = io.WriteString(connection, `{"operation":"hello","ok":false,"error":"authentication or protocol mismatch"}`+"\n")
	}()
	sidecars, err := NewSidecars(harnessFrontend(), t.TempDir(), root)
	if err != nil {
		t.Fatal(err)
	}
	owner := &harnessOwner{root: "/auth", seen: make(chan SidecarMessage, 1)}
	err = sidecars.Send(owner, "fixture-service", "surface", json.RawMessage(`{"operation":"open"}`))
	if err == nil || !strings.Contains(err.Error(), "authentication handshake failed") {
		t.Fatalf("auth error = %v", err)
	}
}

// contract: sidecars-transport.hello.rejects-unsupported-protocol-without-replacing-endpoint
func TestPersistentTransportRejectsUnsupportedHelloProtocolWithoutReplacingEndpoint(t *testing.T) {
	root := t.TempDir()
	socketDirectory, err := os.MkdirTemp("", "sp-h-protocol-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(socketDirectory)
	socket := filepath.Join(socketDirectory, "s.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	writeHarnessEndpoint(t, root, socket)
	endpointPath := filepath.Join(root, "services", "service", "endpoint.json")
	endpointBefore, err := os.ReadFile(endpointPath)
	if err != nil {
		t.Fatal(err)
	}
	serverDone := make(chan error, 1)
	go func() {
		connection, acceptErr := listener.Accept()
		if acceptErr != nil {
			serverDone <- acceptErr
			return
		}
		defer connection.Close()
		if _, readErr := bufio.NewReader(connection).ReadBytes('\n'); readErr != nil {
			serverDone <- readErr
			return
		}
		_, writeErr := io.WriteString(connection, `{"operation":"hello","protocol":2,"ok":true}`+"\n")
		serverDone <- writeErr
	}()

	sidecars, err := NewSidecars(harnessFrontend(), t.TempDir(), root)
	if err != nil {
		t.Fatal(err)
	}
	owner := &harnessOwner{root: "/protocol", seen: make(chan SidecarMessage, 1)}
	err = sidecars.Send(owner, "fixture-service", "surface", json.RawMessage(`{"operation":"open"}`))
	if err == nil || !strings.Contains(err.Error(), "protocol mismatch in hello response") {
		t.Fatalf("protocol mismatch error = %v", err)
	}
	endpointAfter, err := os.ReadFile(endpointPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(endpointAfter) != string(endpointBefore) {
		t.Fatalf("endpoint was replaced after protocol mismatch: before=%s after=%s", endpointBefore, endpointAfter)
	}
	if err := <-serverDone; err != nil {
		t.Fatal(err)
	}
}

// contract: sidecars-transport.endpoint.replaces-dead-service-endpoint
func TestPersistentTransportReplacesEndpointLeftByDeadService(t *testing.T) {
	executableDir := t.TempDir()
	configDir := t.TempDir()
	serviceDir := filepath.Join(configDir, "services", "service")
	if err := os.MkdirAll(serviceDir, 0o700); err != nil {
		t.Fatal(err)
	}
	socketDir, err := os.MkdirTemp("", "sp-r")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(socketDir)
	socket := filepath.Join(socketDir, "service.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	stale := exec.Command("/bin/sh", "-c", "exit 0")
	if err := stale.Start(); err != nil {
		t.Fatal(err)
	}
	stalePID := stale.Process.Pid
	if err := stale.Wait(); err != nil {
		t.Fatal(err)
	}
	writeHarnessEndpoint(t, configDir, socket)
	staleEndpoint := map[string]any{
		"protocol": 1, "pid": stalePID, "socket": socket, "token": "stale-token",
	}
	encoded, err := json.Marshal(staleEndpoint)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(serviceDir, "endpoint.json"), encoded, 0o600); err != nil {
		t.Fatal(err)
	}

	replacement := map[string]any{
		"protocol": 1, "pid": 1, "socket": socket, "token": "replacement-token",
	}
	replacementJSON, err := json.Marshal(replacement)
	if err != nil {
		t.Fatal(err)
	}
	program := filepath.Join(executableDir, "service")
	if err := os.WriteFile(program, []byte(fmt.Sprintf("#!/bin/sh\nprintf '%%s\\n' '%s'\n", replacementJSON)), 0o755); err != nil {
		t.Fatal(err)
	}

	serverDone := make(chan error, 1)
	go func() {
		connection, err := listener.Accept()
		if err != nil {
			serverDone <- err
			return
		}
		defer connection.Close()
		reader := bufio.NewReader(connection)
		line, err := reader.ReadBytes('\n')
		if err != nil {
			serverDone <- err
			return
		}
		var hello map[string]any
		if err := json.Unmarshal(line, &hello); err != nil || hello["token"] != "replacement-token" {
			serverDone <- fmt.Errorf("unexpected replacement hello: %s", line)
			return
		}
		if _, err := io.WriteString(connection, `{"operation":"hello","protocol":1,"ok":true}`+"\n"); err != nil {
			serverDone <- err
			return
		}
		line, err = reader.ReadBytes('\n')
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

	sidecars, err := NewSidecars(harnessFrontend(), executableDir, configDir)
	if err != nil {
		t.Fatal(err)
	}
	owner := &harnessOwner{root: "/replacement", seen: make(chan SidecarMessage, 1)}
	if err := sidecars.Send(owner, "fixture-service", "surface", json.RawMessage(`{"operation":"open"}`)); err != nil {
		t.Fatal(err)
	}
	select {
	case event := <-owner.seen:
		if event.Surface != "surface" {
			t.Fatalf("unexpected surface: %s", event.Surface)
		}
	case <-time.After(time.Second):
		t.Fatal("no replacement event")
	}
	if _, err := os.Stat(filepath.Join(serviceDir, "endpoint.json")); !os.IsNotExist(err) {
		t.Fatalf("stale endpoint was not removed: %v", err)
	}
	sidecars.Stop()
	if err := <-serverDone; err != nil {
		t.Fatal(err)
	}
}

// contract: sidecars-transport.endpoint.live-unreachable-reported-without-replacement
func TestPersistentTransportReportsLiveButUnreachableEndpointWithoutReplacement(t *testing.T) {
	root := t.TempDir()
	socketDir, err := os.MkdirTemp("", "sp-u")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(socketDir)
	missingSocket := filepath.Join(socketDir, "missing.sock")
	serviceDir := filepath.Join(root, "services", "service")
	if err := os.MkdirAll(serviceDir, 0o700); err != nil {
		t.Fatal(err)
	}
	endpointPath := filepath.Join(serviceDir, "endpoint.json")
	endpoint := map[string]any{
		"protocol": 1, "pid": os.Getpid(), "socket": missingSocket, "token": "live-token",
	}
	encoded, err := json.Marshal(endpoint)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(endpointPath, encoded, 0o600); err != nil {
		t.Fatal(err)
	}
	original, err := os.ReadFile(endpointPath)
	if err != nil {
		t.Fatal(err)
	}
	sidecars, err := NewSidecars(harnessFrontend(), t.TempDir(), root)
	if err != nil {
		t.Fatal(err)
	}
	owner := &harnessOwner{root: "/unreachable", seen: make(chan SidecarMessage, 1)}
	err = sidecars.Send(owner, "fixture-service", "surface", json.RawMessage(`{"operation":"open"}`))
	if err == nil || !strings.Contains(err.Error(), "connect authenticated service") {
		t.Fatalf("connection error = %v", err)
	}
	current, err := os.ReadFile(endpointPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(current) != string(original) {
		t.Fatalf("unreachable endpoint was replaced: %s", current)
	}
	sidecars.Stop()
}
