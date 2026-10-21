package host_test

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	host "github.com/soksak-app/core/packages/host/wailsv3/src"
	"github.com/soksak-app/core/packages/host/wailsv3/tests/support"
)

type SidecarMessage = host.SidecarMessage
type SidecarDeclaration = host.SidecarDeclaration

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

// harnessDeclarations is the declaration of one persistent sidecar installed in folder.
func harnessDeclarations(folder string) []SidecarDeclaration {
	return []SidecarDeclaration{{Name: "fixture-service", Folder: folder,
		Data: []byte(`{"executable":"service","protocol":1,"transport":"persistent"}`)}}
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

// serveHarnessConnections accepts connections connections. For each connection, it returns the requests after authentication, and a connection that returned the open request is
// cut to reproduce a connection loss while running. The connection to cut is chosen by the request and not by the order received:
// a connection that one host connected again can arrive before the first connection of another host. It replies to close-owner with a failure.
func serveHarnessConnections(t *testing.T, listener net.Listener, connections int) <-chan error {
	t.Helper()
	done := make(chan error, 1)
	go func() {
		var wg sync.WaitGroup
		var mu sync.Mutex
		var firstErr error
		fail := func(err error) {
			mu.Lock()
			defer mu.Unlock()
			if firstErr == nil {
				firstErr = err
			}
		}
		for index := 0; index < connections; index++ {
			connection, err := listener.Accept()
			if err != nil {
				fail(err)
				break
			}
			wg.Add(1)
			go func() {
				defer wg.Done()
				defer connection.Close()
				reader := bufio.NewReader(connection)
				line, err := reader.ReadBytes('\n')
				if err != nil {
					fail(err)
					return
				}
				var hello map[string]any
				if err := json.Unmarshal(line, &hello); err != nil || hello["operation"] != "hello" || hello["protocol"] != float64(1) || hello["token"] != "harness-token" {
					_, _ = io.WriteString(connection, `{"operation":"hello","ok":false,"error":"authentication failed"}`+"\n")
					return
				}
				_, _ = io.WriteString(connection, `{"operation":"hello","protocol":1,"ok":true}`+"\n")
				for {
					line, err = reader.ReadBytes('\n')
					if err != nil {
						return
					}
					var request map[string]any
					if json.Unmarshal(line, &request) != nil {
						return
					}
					if request["operation"] == "close-owner" {
						requestID, _ := request["request"].(string)
						response, _ := json.Marshal(map[string]any{"operation": "closed-owner", "request": requestID, "ok": false, "error": "close failed"})
						_, _ = connection.Write(append(response, '\n'))
						return
					}
					_, _ = connection.Write(line)
					// The operation of a page request is inside the body. A reconnection uses the endpoint and
					// must keep the identity that the host declared.
					if body, ok := request["body"].(map[string]any); ok && body["operation"] == "open" {
						return
					}
				}
			}()
		}
		wg.Wait()
		mu.Lock()
		defer mu.Unlock()
		done <- firstErr
	}()
	return done
}

// contract: sidecars-transport.endpoint.concurrent-hosts-share-authenticated-service, sidecars-transport.hello.declares-protocol-one, sidecars-transport.reconnect.after-connection-loss-preserves-owner, sidecars-transport.stop.close-owner-failure-returns-promptly
func TestPersistentTransportHarnessEndpointAuthConcurrentReconnectAndCloseAck(t *testing.T) {
	// Two hosts open at the same time. The order in which a connection that one host connected again after a loss is made before the first connection of another host
	// is also checked. The service must cut the first connection of each host regardless of that order.
	t.Run("concurrent", func(t *testing.T) { runHarnessReconnect(t, false) })
	t.Run("second opens after the first reconnected", func(t *testing.T) { runHarnessReconnect(t, true) })
}

func runHarnessReconnect(t *testing.T, sequential bool) {
	root := t.TempDir()
	socketDirectory := socketParent(t)
	socket := filepath.Join(socketDirectory, "s.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	writeHarnessEndpoint(t, root, socket)
	serverDone := serveHarnessConnections(t, listener, 4)

	first, err := NewSidecars(harnessDeclarations(t.TempDir()), root)
	if err != nil {
		t.Fatal(err)
	}
	second, err := NewSidecars(harnessDeclarations(t.TempDir()), root)
	if err != nil {
		t.Fatal(err)
	}
	firstOwner := &harnessOwner{root: "/first", seen: make(chan SidecarMessage, 4)}
	secondOwner := &harnessOwner{root: "/second", seen: make(chan SidecarMessage, 4)}

	awaitInitial := func(owner *harnessOwner) {
		select {
		case <-owner.seen:
		case <-time.After(stall):
			t.Fatal("no initial event; the test stalled")
		}
	}
	// The host connects the cut socket again immediately and sends the connection event. A send after
	// it receives that event goes to the connection made again, so endpoint reuse and reconnection are verified.
	awaitConnection := func(owner *harnessOwner) {
		select {
		case event := <-owner.seen:
			if string(event.Body) != `{"connected":true,"event":"connection"}` {
				t.Fatalf("event after the connection loss = %s, want the connection event", event.Body)
			}
		case <-time.After(stall):
			t.Fatal("no connection event; the test stalled")
		}
	}
	if sequential {
		// The second host makes its first connection after the first host was cut and the service received the connection made again.
		if err := first.Send(firstOwner, "fixture-service", "surface-1", json.RawMessage(`{"operation":"open"}`)); err != nil {
			t.Fatal(err)
		}
		awaitInitial(firstOwner)
		awaitConnection(firstOwner)
		if err := second.Send(secondOwner, "fixture-service", "surface-2", json.RawMessage(`{"operation":"open"}`)); err != nil {
			t.Fatal(err)
		}
		awaitInitial(secondOwner)
		awaitConnection(secondOwner)
	} else {
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
			awaitInitial(owner)
		}
		for _, owner := range []*harnessOwner{firstOwner, secondOwner} {
			awaitConnection(owner)
		}
	}
	if err := first.Send(firstOwner, "fixture-service", "surface-1", json.RawMessage(`{"operation":"reconnect"}`)); err != nil {
		t.Fatal(err)
	}
	if err := second.Send(secondOwner, "fixture-service", "surface-2", json.RawMessage(`{"operation":"reconnect"}`)); err != nil {
		t.Fatal(err)
	}
	for _, owner := range []*harnessOwner{firstOwner, secondOwner} {
		select {
		case event := <-owner.seen:
			if string(event.Body) != `{"operation":"reconnect"}` {
				t.Fatalf("reconnect event = %s", event.Body)
			}
		case <-time.After(stall):
			t.Fatal("no reconnect event; the test stalled")
		}
	}

	startStop := time.Now()
	first.Stop()
	second.Stop()
	// A failed close-owner reply ends without waiting for the deadline of Stop. If it took until the deadline, it did not wait for the reply.
	if elapsed := time.Since(startStop); elapsed >= first.StopTimeout {
		t.Fatalf("close-owner failure was not reported before the %s stop deadline: %s", first.StopTimeout, elapsed)
	}
	if err := <-serverDone; err != nil {
		t.Fatal(err)
	}
}

// contract: sidecars-transport.stop.close-owner-then-shutdown
func TestPersistentStopClosesOwnerThenRequestsServiceShutdown(t *testing.T) {
	root := t.TempDir()
	socketDirectory := socketParent(t)
	socket := filepath.Join(socketDirectory, "s.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	writeHarnessEndpoint(t, root, socket)

	// The service must receive hello, open, close-owner and shutdown in this order.
	operations := make(chan []string, 1)
	serverDone := make(chan error, 1)
	go func() {
		connection, err := listener.Accept()
		if err != nil {
			serverDone <- err
			return
		}
		defer connection.Close()
		if err := connection.SetReadDeadline(time.Now().Add(stall)); err != nil {
			serverDone <- err
			return
		}
		reader := bufio.NewReader(connection)
		var seen []string
		defer func() { operations <- seen }()
		for {
			line, err := reader.ReadBytes('\n')
			if err != nil {
				serverDone <- fmt.Errorf("after %v: %w", seen, err)
				return
			}
			var request map[string]any
			if err := json.Unmarshal(line, &request); err != nil {
				serverDone <- err
				return
			}
			operation, _ := request["operation"].(string)
			if body, ok := request["body"].(map[string]any); ok {
				operation, _ = body["operation"].(string)
			}
			seen = append(seen, operation)
			var reply map[string]any
			switch operation {
			case "hello":
				reply = map[string]any{"operation": "hello", "protocol": 1, "ok": true}
			case "close-owner":
				reply = map[string]any{"operation": "closed-owner", "request": request["request"], "ok": true}
			case "shutdown":
				reply = map[string]any{"operation": "shutdown", "request": request["request"], "ok": true}
			}
			if reply != nil {
				encoded, _ := json.Marshal(reply)
				if _, err := connection.Write(append(encoded, '\n')); err != nil {
					serverDone <- err
					return
				}
			}
			if operation == "shutdown" {
				serverDone <- nil
				return
			}
		}
	}()

	sidecars, err := NewSidecars(harnessDeclarations(t.TempDir()), root)
	if err != nil {
		t.Fatal(err)
	}
	owner := &harnessOwner{root: "/shutdown", seen: make(chan SidecarMessage, 1)}
	if err := sidecars.Send(owner, "fixture-service", "surface", json.RawMessage(`{"operation":"open"}`)); err != nil {
		t.Fatal(err)
	}
	sidecars.Stop()
	if err := <-serverDone; err != nil {
		t.Fatalf("service did not receive shutdown: %v", err)
	}
	if got := strings.Join(<-operations, ","); got != "hello,open,close-owner,shutdown" {
		t.Fatalf("service operations = %s, want hello,open,close-owner,shutdown", got)
	}
}

// contract: sidecars-transport.stop.own-close-is-not-a-read-error
func TestPersistentStopDoesNotLogItsOwnCloseAsAReadError(t *testing.T) {
	root := t.TempDir()
	socketDirectory := socketParent(t)
	socket := filepath.Join(socketDirectory, "s.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	writeHarnessEndpoint(t, root, socket)
	var written strings.Builder
	var mu sync.Mutex
	log.SetOutput(writerFunc(func(p []byte) (int, error) {
		mu.Lock()
		defer mu.Unlock()
		return written.Write(p)
	}))
	t.Cleanup(func() { log.SetOutput(os.Stderr) })

	// The service does not close the connection even after it replied to shutdown. The host closes the connection.
	release := make(chan struct{})
	served := make(chan error, 1)
	go func() {
		connection, err := listener.Accept()
		if err != nil {
			served <- err
			return
		}
		defer connection.Close()
		reader := bufio.NewReader(connection)
		for {
			line, err := reader.ReadBytes('\n')
			if err != nil {
				served <- nil
				<-release
				return
			}
			var request map[string]any
			if err := json.Unmarshal(line, &request); err != nil {
				served <- err
				return
			}
			operation, _ := request["operation"].(string)
			var reply map[string]any
			switch operation {
			case "hello":
				reply = map[string]any{"operation": "hello", "protocol": 1, "ok": true}
			case "close-owner":
				reply = map[string]any{"operation": "closed-owner", "request": request["request"], "ok": true}
			case "shutdown":
				reply = map[string]any{"operation": "shutdown", "request": request["request"], "ok": true}
			}
			if reply != nil {
				encoded, _ := json.Marshal(reply)
				if _, err := connection.Write(append(encoded, '\n')); err != nil {
					served <- err
					return
				}
			}
		}
	}()

	sidecars, err := NewSidecars(harnessDeclarations(t.TempDir()), root)
	if err != nil {
		t.Fatal(err)
	}
	owner := &harnessOwner{root: "/stop", seen: make(chan SidecarMessage, 1)}
	if err := sidecars.Send(owner, "fixture-service", "surface", json.RawMessage(`{"operation":"open"}`)); err != nil {
		t.Fatal(err)
	}
	sidecars.Stop()
	if err := <-served; err != nil {
		t.Fatal(err)
	}
	close(release)
	mu.Lock()
	defer mu.Unlock()
	if strings.Contains(written.String(), "persistent read") {
		t.Fatalf("the stop logged its own close of the connection: %q", written.String())
	}
}

// contract: sidecars-transport.stop.accepts-close-answers-sent-before-stop
func TestPersistentStopAcceptsTheAnswerToACloseSentBeforeTheStop(t *testing.T) {
	root := t.TempDir()
	socketDirectory := socketParent(t)
	socket := filepath.Join(socketDirectory, "s.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	writeHarnessEndpoint(t, root, socket)

	// The service does not reply to closed at once and replies after it receives close-owner. That reply comes after the stop started.
	operations := make(chan []string, 1)
	go func() {
		var seen []string
		defer func() { operations <- seen }()
		connection, err := listener.Accept()
		if err != nil {
			return
		}
		defer connection.Close()
		if err := connection.SetReadDeadline(time.Now().Add(stall)); err != nil {
			return
		}
		reader := bufio.NewReader(connection)
		for {
			line, err := reader.ReadBytes('\n')
			if err != nil {
				return
			}
			var request map[string]any
			if err := json.Unmarshal(line, &request); err != nil {
				return
			}
			operation, _ := request["operation"].(string)
			if body, ok := request["body"].(map[string]any); ok {
				operation, _ = body["operation"].(string)
			}
			if closed, _ := request["closed"].(bool); closed {
				operation = "closed"
			}
			seen = append(seen, operation)
			var replies []map[string]any
			switch operation {
			case "hello":
				replies = []map[string]any{{"operation": "hello", "protocol": 1, "ok": true}}
			case "close-owner":
				replies = []map[string]any{
					{"surface": "surface", "closed": true},
					{"operation": "closed-owner", "request": request["request"], "ok": true},
				}
			case "shutdown":
				replies = []map[string]any{{"operation": "shutdown", "request": request["request"], "ok": true}}
			}
			for _, reply := range replies {
				encoded, _ := json.Marshal(reply)
				if _, err := connection.Write(append(encoded, '\n')); err != nil {
					return
				}
			}
			if operation == "shutdown" {
				return
			}
		}
	}()

	sidecars, err := NewSidecars(harnessDeclarations(t.TempDir()), root)
	if err != nil {
		t.Fatal(err)
	}
	owner := &harnessOwner{root: "/late", seen: make(chan SidecarMessage, 1)}
	if err := sidecars.Send(owner, "fixture-service", "surface", json.RawMessage(`{"operation":"open"}`)); err != nil {
		t.Fatal(err)
	}
	sidecars.Close("surface")
	sidecars.Stop()
	if got := strings.Join(<-operations, ","); got != "hello,open,closed,close-owner,shutdown" {
		t.Fatalf("service operations = %s, want hello,open,closed,close-owner,shutdown", got)
	}
	if closing := sidecars.Closing(); len(closing) != 0 {
		t.Fatalf("closing after stop = %v, want none", closing)
	}
}

// contract: sidecars-transport.hello.rejects-auth-failure
func TestPersistentTransportHarnessAuthFailure(t *testing.T) {
	root := t.TempDir()
	socketDirectory := socketParent(t)
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
	sidecars, err := NewSidecars(harnessDeclarations(t.TempDir()), root)
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
	socketDirectory := socketParent(t)
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

	sidecars, err := NewSidecars(harnessDeclarations(t.TempDir()), root)
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
	socketDir := socketParent(t)
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

	sidecars, err := NewSidecars(harnessDeclarations(executableDir), configDir)
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
	case <-time.After(stall):
		t.Fatal("no replacement event; the test stalled")
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
	socketDir := socketParent(t)
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
	sidecars, err := NewSidecars(harnessDeclarations(t.TempDir()), root)
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

// contract: sidecars.retain.sends-layout-and-known-surfaces, sidecars.retain.reports-service-failure
func TestPersistentRetainSendsLayoutAndKnownSurfaces(t *testing.T) {
	root := t.TempDir()
	socketDirectory := socketParent(t)
	socket := filepath.Join(socketDirectory, "s.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	writeHarnessEndpoint(t, root, socket)

	requests := make(chan map[string]any, 3)
	go func() {
		connection, err := listener.Accept()
		if err != nil {
			return
		}
		defer connection.Close()
		reader := bufio.NewReader(connection)
		answered := 0
		for {
			line, err := reader.ReadBytes('\n')
			if err != nil {
				return
			}
			var request map[string]any
			if json.Unmarshal(line, &request) != nil {
				return
			}
			var reply map[string]any
			switch request["operation"] {
			case "hello":
				reply = map[string]any{"operation": "hello", "protocol": 1, "ok": true}
			case "close-owner":
				reply = map[string]any{"operation": "closed-owner", "request": request["request"], "ok": true}
			case "shutdown":
				reply = map[string]any{"operation": "shutdown", "request": request["request"], "ok": true}
			case "retain":
				requests <- request
				answered++
				if answered <= 2 {
					reply = map[string]any{"operation": "retained", "request": request["request"], "ok": true, "closed": 2}
				} else {
					reply = map[string]any{"operation": "retained", "request": request["request"], "ok": false, "error": "retain failed in the service"}
				}
			}
			if reply != nil {
				encoded, _ := json.Marshal(reply)
				if _, err := connection.Write(append(encoded, '\n')); err != nil {
					return
				}
			}
		}
	}()

	sidecars, err := NewSidecars(harnessDeclarations(t.TempDir()), root)
	if err != nil {
		t.Fatal(err)
	}
	defer sidecars.Stop()
	// When the layout has no surface and this process sent no surface, it sends an empty array.
	if closed, err := sidecars.Retain([]host.RetainedSurface{}); err != nil || closed != 2 {
		t.Fatalf("retain with no surfaces = %d, %v; want the service's count 2", closed, err)
	}
	empty, _ := json.Marshal((<-requests)["surfaces"])
	if string(empty) != "[]" {
		t.Fatalf("retained surfaces = %s, want [] when no surface is kept", empty)
	}
	owner := &harnessOwner{root: "/live", seen: make(chan SidecarMessage, 4)}
	if err := sidecars.Send(owner, "fixture-service", "sent", json.RawMessage(`{"operation":"open"}`)); err != nil {
		t.Fatal(err)
	}
	closed, err := sidecars.Retain([]host.RetainedSurface{{Surface: "listed", Root: "/project"}})
	if err != nil {
		t.Fatal(err)
	}
	if closed != 2 {
		t.Fatalf("closed = %d, want the service's count 2", closed)
	}
	request := <-requests
	got, _ := json.Marshal(request["surfaces"])
	want := `[{"root":"/project","surface":"listed"},{"root":"/live","surface":"sent"}]`
	if string(got) != want {
		t.Fatalf("retained surfaces = %s, want %s: the layout surfaces and the surfaces this process sent", got, want)
	}
	if _, err := sidecars.Retain([]host.RetainedSurface{}); err == nil || !strings.Contains(err.Error(), "retain failed in the service") {
		t.Fatalf("a failed retain was not reported: %v", err)
	}
}

// TestPersistentRetainInterruptedByStopSendsNothing verifies that, when Stop ends after Retain prepared the service and before it sent, retain is
// not sent and it fails with the stop. The retain of a window and Stop can overlap when the application ends.
// contract: sidecars.retain.rejects-after-stop
func TestPersistentRetainInterruptedByStopSendsNothing(t *testing.T) {
	root := t.TempDir()
	socketDirectory := socketParent(t)
	socket := filepath.Join(socketDirectory, "s.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	writeHarnessEndpoint(t, root, socket)

	retains := make(chan map[string]any, 1)
	go func() {
		connection, err := listener.Accept()
		if err != nil {
			return
		}
		defer connection.Close()
		reader := bufio.NewReader(connection)
		for {
			line, err := reader.ReadBytes('\n')
			if err != nil {
				return
			}
			var request map[string]any
			if json.Unmarshal(line, &request) != nil {
				return
			}
			var reply map[string]any
			switch request["operation"] {
			case "hello":
				reply = map[string]any{"operation": "hello", "protocol": 1, "ok": true}
			case "close-owner":
				reply = map[string]any{"operation": "closed-owner", "request": request["request"], "ok": true}
			case "shutdown":
				reply = map[string]any{"operation": "shutdown", "request": request["request"], "ok": true}
			case "retain":
				retains <- request
				reply = map[string]any{"operation": "retained", "request": request["request"], "ok": true, "closed": 0}
			}
			if reply != nil {
				encoded, _ := json.Marshal(reply)
				if _, err := connection.Write(append(encoded, '\n')); err != nil {
					return
				}
			}
		}
	}()

	sidecars, err := NewSidecars(harnessDeclarations(t.TempDir()), root)
	if err != nil {
		t.Fatal(err)
	}
	sidecars.RetainSending = func(string) { sidecars.Stop() }
	_, err = sidecars.Retain([]host.RetainedSurface{})
	if err == nil || !strings.Contains(err.Error(), "sidecars are stopped") {
		t.Fatalf("retain interrupted by stop = %v, want the stopped error", err)
	}
	select {
	case request := <-retains:
		t.Fatalf("the service received a retain after stop: %v", request)
	default:
	}
}

// contract: sidecars.retain.skips-service-without-endpoint
func TestPersistentRetainSkipsAServiceWithoutEndpoint(t *testing.T) {
	sidecars, err := NewSidecars(harnessDeclarations(t.TempDir()), t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer sidecars.Stop()
	closed, err := sidecars.Retain([]host.RetainedSurface{})
	if err != nil || closed != 0 {
		t.Fatalf("retain without a service = %d, %v; want 0 and no error without starting a service", closed, err)
	}
	if _, err := sidecars.Retain(nil); err == nil {
		t.Fatal("retain without a surfaces list was accepted")
	}
}

// contract: sidecars-transport.persistent.revives-a-lost-connection
func TestPersistentTransportRevivesLostConnectionWithoutSend(t *testing.T) {
	root := t.TempDir()
	socketDirectory := socketParent(t)
	socket := filepath.Join(socketDirectory, "s.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	writeHarnessEndpoint(t, root, socket)

	// The first connection returns one request and then cuts itself. The connection made again is not closed:
	// the cut must happen only once so that the restart also happens only once.
	serverDone := make(chan struct{})
	go func() {
		defer close(serverDone)
		for index := 0; index < 2; index++ {
			connection, err := listener.Accept()
			if err != nil {
				return
			}
			keepOpen := index == 1
			go func() {
				defer connection.Close()
				reader := bufio.NewReader(connection)
				line, err := reader.ReadBytes('\n')
				if err != nil {
					return
				}
				if _, err := io.WriteString(connection, `{"operation":"hello","protocol":1,"ok":true}`+"\n"); err != nil {
					return
				}
				for {
					line, err = reader.ReadBytes('\n')
					if err != nil {
						return
					}
					var request map[string]any
					if keepOpen && json.Unmarshal(line, &request) == nil && request["operation"] == "close-owner" {
						reply, _ := json.Marshal(map[string]any{"operation": "closed-owner", "request": request["request"], "ok": false, "error": "test close"})
						_, _ = connection.Write(append(reply, '\n'))
						return
					}
					if _, err := connection.Write(line); err != nil {
						return
					}
					if !keepOpen {
						return
					}
				}
			}()
		}
	}()

	sidecars, err := NewSidecars(harnessDeclarations(t.TempDir()), root)
	if err != nil {
		t.Fatal(err)
	}
	owner := &harnessOwner{root: "/only", seen: make(chan SidecarMessage, 8)}
	if err := sidecars.Send(owner, "fixture-service", "surface-1", json.RawMessage(`{"operation":"open"}`)); err != nil {
		t.Fatal(err)
	}
	first := receiveSidecarMessage(t, owner.seen)
	if first.Surface != "surface-1" || string(first.Body) != `{"operation":"open"}` {
		t.Fatalf("the first message was not the open echo: %v %s", first.Surface, first.Body)
	}

	// When the connection is cut, it must be connected again without a send; the connection event is the evidence (V5-106).
	revived := receiveSidecarMessage(t, owner.seen)
	if revived.Surface != "surface-1" {
		t.Fatalf("the connection notice went to %q", revived.Surface)
	}
	var notice map[string]any
	if err := json.Unmarshal(revived.Body, &notice); err != nil {
		t.Fatalf("the connection notice is not JSON: %v", err)
	}
	if notice["event"] != "connection" || notice["connected"] != true {
		t.Fatalf("the connection notice is not a successful reconnection: %v", notice)
	}

	// The next send passes through the connection made again.
	if err := sidecars.Send(owner, "fixture-service", "surface-1", json.RawMessage(`{"operation":"input"}`)); err != nil {
		t.Fatal(err)
	}
	echoed := receiveSidecarMessage(t, owner.seen)
	if echoed.Surface != "surface-1" || string(echoed.Body) != `{"operation":"input"}` {
		t.Fatalf("the input did not ride the revived connection: %v %s", echoed.Surface, echoed.Body)
	}

	sidecars.Stop()
	listener.Close()
	<-serverDone
}

// contract: sidecars-transport.persistent.revive-failure-is-reported
func TestPersistentTransportReportsFailedReviveToOwner(t *testing.T) {
	root := t.TempDir()
	socketDirectory := socketParent(t)
	socket := filepath.Join(socketDirectory, "s.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	writeHarnessEndpoint(t, root, socket)

	// The first connection returns one request and cuts only after the receiver closed. The connection of the restart
	// must be refused instead of piling up in the queue so that the failure notification arrives deterministically.
	closed := make(chan struct{})
	serverDone := make(chan struct{})
	go func() {
		defer close(serverDone)
		connection, err := listener.Accept()
		if err != nil {
			return
		}
		defer connection.Close()
		reader := bufio.NewReader(connection)
		if _, err := reader.ReadBytes('\n'); err != nil {
			return
		}
		if _, err := io.WriteString(connection, `{"operation":"hello","protocol":1,"ok":true}`+"\n"); err != nil {
			return
		}
		line, err := reader.ReadBytes('\n')
		if err != nil {
			return
		}
		if _, err := connection.Write(line); err != nil {
			return
		}
		// Cuts the connection only after the receiver closed.
		<-closed
	}()

	sidecars, err := NewSidecars(harnessDeclarations(t.TempDir()), root)
	if err != nil {
		t.Fatal(err)
	}
	owner := &harnessOwner{root: "/only", seen: make(chan SidecarMessage, 8)}
	if err := sidecars.Send(owner, "fixture-service", "surface-1", json.RawMessage(`{"operation":"open"}`)); err != nil {
		t.Fatal(err)
	}
	first := receiveSidecarMessage(t, owner.seen)
	if first.Surface != "surface-1" || string(first.Body) != `{"operation":"open"}` {
		t.Fatalf("the first message was not the open echo: %v %s", first.Surface, first.Body)
	}

	// The connection is cut after the receiver closed first. The pid of the endpoint is this check process, so
	// it is alive, and the restart tries to connect to the same socket and is refused.
	listener.Close()
	close(closed)
	<-serverDone

	// When the restart fails, the connection loss and its reason are announced to the surface (V5-106).
	failure := receiveSidecarMessage(t, owner.seen)
	if failure.Surface != "surface-1" {
		t.Fatalf("the failure notice went to %q", failure.Surface)
	}
	var notice map[string]any
	if err := json.Unmarshal(failure.Body, &notice); err != nil {
		t.Fatalf("the failure notice is not JSON: %v", err)
	}
	if notice["event"] != "connection" || notice["connected"] != false {
		t.Fatalf("the failure notice is not a failed reconnection: %v", notice)
	}
	reason, _ := notice["reason"].(string)
	if reason == "" {
		t.Fatal("the failure notice carries no restart reason")
	}
	sidecars.Stop()
}

func receiveSidecarMessage(t *testing.T, seen <-chan SidecarMessage) SidecarMessage {
	t.Helper()
	select {
	case message := <-seen:
		return message
	case <-time.After(stall):
		t.Fatalf("no sidecar message arrived within %v; the test stalled", stall)
		return SidecarMessage{}
	}
}

// failureOwner is a window that collects sidecar messages and failures separately.
type failureOwner struct {
	root     string
	seen     chan SidecarMessage
	failures chan host.SidecarFailure
}

func (o *failureOwner) ProjectRoot() string { return o.root }
func (o *failureOwner) Emit(name string, data ...any) {
	switch name {
	case "sidecar-message":
		o.seen <- data[0].(SidecarMessage)
	case "sidecar-failure":
		o.failures <- data[0].(host.SidecarFailure)
	}
}

// serveOneBadLine replies to hello on one connection, receives one request line, and then writes payload. When the host closes the connection, it
// closes closed. If the host closes before payload is fully written, the write error is the expected result.
func serveOneBadLine(t *testing.T, payload []byte) (root string, closed <-chan struct{}) {
	t.Helper()
	root = t.TempDir()
	socketDirectory := socketParent(t)
	socket := filepath.Join(socketDirectory, "s.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { listener.Close() })
	writeHarnessEndpoint(t, root, socket)
	done := make(chan struct{})
	go func() {
		defer close(done)
		connection, err := listener.Accept()
		if err != nil {
			return
		}
		defer connection.Close()
		reader := bufio.NewReader(connection)
		if _, err := reader.ReadBytes('\n'); err != nil {
			return
		}
		if _, err := io.WriteString(connection, `{"operation":"hello","protocol":1,"ok":true}`+"\n"); err != nil {
			return
		}
		if _, err := reader.ReadBytes('\n'); err != nil {
			return
		}
		go connection.Write(payload)
		// When the host closes the connection, the read ends with EOF.
		io.Copy(io.Discard, reader)
	}()
	return root, done
}

func expectConnectionFailure(t *testing.T, payload []byte, reason string) {
	t.Helper()
	root, closed := serveOneBadLine(t, payload)
	sidecars, err := NewSidecars(harnessDeclarations(t.TempDir()), root)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(sidecars.Stop)
	owner := &failureOwner{root: "/only", seen: make(chan SidecarMessage, 8), failures: make(chan host.SidecarFailure, 8)}
	if err := sidecars.Send(owner, "fixture-service", "surface-1", json.RawMessage(`{"operation":"open"}`)); err != nil {
		t.Fatal(err)
	}
	select {
	case failure := <-owner.failures:
		if failure.Sidecar != "fixture-service" || failure.Surface != "surface-1" || !strings.HasPrefix(failure.Reason, reason) {
			t.Fatalf("failure = %+v, want reason %q", failure, reason)
		}
	case message := <-owner.seen:
		t.Fatalf("the bad line was delivered as a message: %+v", message)
	case <-time.After(stall):
		t.Fatal("no sidecar failure; the test stalled")
	}
	select {
	case <-closed:
	case <-time.After(stall):
		t.Fatal("the host kept the connection open; the test stalled")
	}
}

// contract: sidecars-transport.persistent.invalid-event-fails-the-connection
func TestPersistentTransportFailsTheConnectionOnAnInvalidEvent(t *testing.T) {
	expectConnectionFailure(t, []byte(`{"surface":5,"body":{}}`+"\n"), "invalid message: ")
	expectConnectionFailure(t, []byte("not json\n"), "invalid message: ")
}

// contract: sidecars-transport.persistent.oversize-line-fails-the-connection
func TestPersistentTransportFailsTheConnectionOnAnOversizeLine(t *testing.T) {
	expectConnectionFailure(t, bytes.Repeat([]byte("x"), messageLimit+2), fmt.Sprintf("message exceeds %d bytes", messageLimit))
}

// The start of a persistent sidecar (the service connection and hello) does not make the send to another sidecar wait. The service replies to hello
// 500 ms late, and meanwhile it sends to another sidecar that is already running.
// contract: sidecars.send.start-does-not-block-other-sidecars
func TestPersistentStartDoesNotDelayOtherSidecars(t *testing.T) {
	root := t.TempDir()
	socketDirectory := socketParent(t)
	socket := filepath.Join(socketDirectory, "s.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	writeHarnessEndpoint(t, root, socket)
	helloSeen := make(chan struct{})
	go func() {
		connection, err := listener.Accept()
		if err != nil {
			return
		}
		defer connection.Close()
		reader := bufio.NewReader(connection)
		if _, err := reader.ReadBytes('\n'); err != nil {
			return
		}
		close(helloSeen)
		time.Sleep(500 * time.Millisecond)
		_, _ = io.WriteString(connection, `{"operation":"hello","protocol":1,"ok":true}`+"\n")
		_, _ = io.Copy(io.Discard, reader)
	}()
	folder := t.TempDir()
	if err := os.WriteFile(filepath.Join(folder, "fast"), []byte("#!/bin/sh\ntee /dev/null\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	declarations := append(harnessDeclarations(folder), SidecarDeclaration{Name: "fixture-fast", Folder: folder,
		Data: []byte(`{"executable":"fast","protocol":1}`)})
	sidecars, err := NewSidecars(declarations, root)
	if err != nil {
		t.Fatal(err)
	}
	defer sidecars.Stop()
	owner := &harnessOwner{root: "/start", seen: make(chan SidecarMessage, 8)}
	if err := sidecars.Send(owner, "fixture-fast", "fast-surface", json.RawMessage(`{"data":"start"}`)); err != nil {
		t.Fatalf("fast start: %v", err)
	}
	started := make(chan error, 1)
	go func() {
		started <- sidecars.Send(owner, "fixture-service", "service-surface", json.RawMessage(`{"operation":"open"}`))
	}()
	<-helloSeen
	begin := time.Now()
	if err := sidecars.Send(owner, "fixture-fast", "fast-surface", json.RawMessage(`{"data":"during"}`)); err != nil {
		t.Fatalf("fast send during the service start: %v", err)
	}
	waited := time.Since(begin)
	if err := <-started; err != nil {
		t.Fatalf("service start: %v", err)
	}
	if waited > 50*time.Millisecond {
		t.Fatalf("a send to another sidecar waited %v for the service start, want < 50ms", waited)
	}
}

// A start to a service that received hello and does not reply fails after 5 seconds with a fixed sentence.
// contract: sidecars-transport.hello.times-out
func TestPersistentStartFailsWhenHelloIsNotAnswered(t *testing.T) {
	root := t.TempDir()
	socketDirectory := socketParent(t)
	socket := filepath.Join(socketDirectory, "s.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	writeHarnessEndpoint(t, root, socket)
	release := make(chan struct{})
	defer close(release)
	go func() {
		connection, err := listener.Accept()
		if err != nil {
			return
		}
		defer connection.Close()
		_, _ = bufio.NewReader(connection).ReadBytes('\n')
		<-release
	}()
	sidecars, err := NewSidecars(harnessDeclarations(t.TempDir()), root)
	if err != nil {
		t.Fatal(err)
	}
	owner := &harnessOwner{root: "/hello", seen: make(chan SidecarMessage, 1)}
	begin := time.Now()
	err = sendWithin(t, sidecars, owner, 30*time.Second)
	if want := "sidecar fixture-service: the service did not answer hello within 5s"; err == nil || err.Error() != want {
		t.Fatalf("unanswered hello = %v after %v, want %q", err, time.Since(begin), want)
	}
}

// When a newly started service does not print the endpoint, the start fails after ReadyTimeout with a fixed sentence, and the host ends and reaps
// that service. The check gives 1 second instead of the default 30 seconds. The service starts its work later than the bound, so it ends right at the start regardless of
// the load, and the check looks through that distinct path to see that no process remains running.
// contract: sidecars-transport.startup.times-out
func TestPersistentStartFailsWhenTheServicePrintsNoEndpoint(t *testing.T) {
	folder := t.TempDir()
	script := "#!/bin/sh\nsleep 2\nwhile :; do sleep 1; done\n"
	if err := os.WriteFile(filepath.Join(folder, "service"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	sidecars, err := NewSidecars(harnessDeclarations(folder), root)
	if err != nil {
		t.Fatal(err)
	}
	sidecars.ReadyTimeout = time.Second
	owner := &harnessOwner{root: "/startup", seen: make(chan SidecarMessage, 1)}
	begin := time.Now()
	err = sendWithin(t, sidecars, owner, 30*time.Second)
	if want := "sidecar fixture-service: the service did not print its endpoint within 1s"; err == nil || err.Error() != want {
		t.Fatalf("silent service = %v after %v, want %q", err, time.Since(begin), want)
	}
	if running, err := exec.Command("pgrep", "-f", filepath.Join(folder, "service")).Output(); err == nil {
		t.Fatalf("the silent service still runs: %s", running)
	}
}

// sendWithin sends to fixture-service and returns the result within limit. If it does not return, the check fails.
func sendWithin(t *testing.T, sidecars *host.Sidecars, owner *harnessOwner, limit time.Duration) error {
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

// The standard error of a newly started service accumulates in the log named after that executable in the configuration directory.
// contract: log.service.standard-error-goes-to-service-log
func TestPersistentServiceWritesItsStandardErrorToItsLog(t *testing.T) {
	folder := t.TempDir()
	if err := os.WriteFile(filepath.Join(folder, "service"), []byte("#!/bin/sh\necho service line >&2\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	config := t.TempDir()
	sidecars, err := NewSidecars(harnessDeclarations(folder), config)
	if err != nil {
		t.Fatal(err)
	}
	owner := &harnessOwner{root: "/exit", seen: make(chan SidecarMessage, 1)}
	if err := sendWithin(t, sidecars, owner, 30*time.Second); err == nil {
		t.Fatal("the service that exits started")
	}
	data, err := os.ReadFile(filepath.Join(config, "logs", "service.log"))
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "service line\n" {
		t.Fatalf("service log %q", data)
	}
}

// A service that the host started is the leader of a new session. So it does not receive the signals of the process group and the terminal of the application.
// The service writes its number to a file, prints the endpoint, and remains until the check ends it.
// contract: sidecars-transport.persistent.starts-in-new-session
func TestPersistentServiceStartsInANewSession(t *testing.T) {
	executableDir := t.TempDir()
	socketDir := socketParent(t)
	socket := filepath.Join(socketDir, "service.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	pidPath := filepath.Join(executableDir, "pid")
	script := fmt.Sprintf("#!/bin/sh\necho $$ > '%s'\nprintf '{\"protocol\":1,\"pid\":%%d,\"socket\":\"%s\",\"token\":\"harness-token\"}\\n' $$\nexec sleep 600\n", pidPath, socket)
	if err := os.WriteFile(filepath.Join(executableDir, "service"), []byte(script), 0o755); err != nil {
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
	sidecars, err := NewSidecars(harnessDeclarations(executableDir), t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	owner := &harnessOwner{root: "/session", seen: make(chan SidecarMessage, 4)}
	if err := sendWithin(t, sidecars, owner, 30*time.Second); err != nil {
		t.Fatal(err)
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

// When the service log cannot be opened, the service is not started and it fails with a fixed sentence.
// contract: log.service.open-failure-fails-start
func TestPersistentStartFailsWhenTheServiceLogCannotOpen(t *testing.T) {
	folder := t.TempDir()
	started := filepath.Join(folder, "started")
	if err := os.WriteFile(filepath.Join(folder, "service"), []byte("#!/bin/sh\ntouch "+started+"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	config := t.TempDir()
	// When logs is a file, the log directory cannot be created.
	if err := os.WriteFile(filepath.Join(config, "logs"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	sidecars, err := NewSidecars(harnessDeclarations(folder), config)
	if err != nil {
		t.Fatal(err)
	}
	owner := &harnessOwner{root: "/exit", seen: make(chan SidecarMessage, 1)}
	err = sendWithin(t, sidecars, owner, 30*time.Second)
	if want := "sidecar fixture-service: service log: create logs directory: "; err == nil || !strings.HasPrefix(err.Error(), want) {
		t.Fatalf("service log failure = %v, want prefix %q", err, want)
	}
	if _, err := os.Stat(started); !os.IsNotExist(err) {
		t.Fatalf("the service started: %v", err)
	}
}

// When a newly started service ends before it prints the endpoint, the start fails with a fixed sentence.
// contract: sidecars-transport.startup.exits-before-endpoint
func TestPersistentStartFailsWhenTheServiceExitsBeforeItsEndpoint(t *testing.T) {
	folder := t.TempDir()
	if err := os.WriteFile(filepath.Join(folder, "service"), []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	sidecars, err := NewSidecars(harnessDeclarations(folder), t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	owner := &harnessOwner{root: "/exit", seen: make(chan SidecarMessage, 1)}
	err = sendWithin(t, sidecars, owner, 30*time.Second)
	if want := "sidecar fixture-service: service exited before endpoint"; err == nil || err.Error() != want {
		t.Fatalf("exited service = %v, want %q", err, want)
	}
}

// serveHelloVersion answers the hello of one connection with version, or without a version when it is nil, and then
// echoes each surface request.
func serveHelloVersion(t *testing.T, listener net.Listener, version *string) {
	t.Helper()
	go func() {
		connection, err := listener.Accept()
		if err != nil {
			return
		}
		defer connection.Close()
		reader := bufio.NewReader(connection)
		for {
			line, err := reader.ReadBytes('\n')
			if err != nil {
				return
			}
			var request map[string]any
			if json.Unmarshal(line, &request) != nil {
				return
			}
			var reply []byte
			if request["operation"] == "hello" {
				answer := map[string]any{"operation": "hello", "protocol": 1, "ok": true}
				if version != nil {
					answer["version"] = *version
				}
				reply, _ = json.Marshal(answer)
			} else {
				reply = line[:len(line)-1]
			}
			if _, err := connection.Write(append(reply, '\n')); err != nil {
				return
			}
		}
	}()
}

// contract: sidecars-transport.hello.reports-a-service-of-another-version
func TestPersistentServiceOfAnotherVersionIsReportedOutdated(t *testing.T) {
	old := "0.0.6"
	cases := []struct {
		name    string
		version *string
		want    []host.OutdatedSidecar
	}{
		{"another version", &old, []host.OutdatedSidecar{{Sidecar: "fixture-service", Running: &old, Installed: "0.0.7", Sessions: 1}}},
		{"no version", nil, []host.OutdatedSidecar{{Sidecar: "fixture-service", Running: nil, Installed: "0.0.7", Sessions: 1}}},
		{"the installed version", text("0.0.7"), []host.OutdatedSidecar{}},
	}
	for _, item := range cases {
		t.Run(item.name, func(t *testing.T) {
			root := t.TempDir()
			socketDirectory := socketParent(t)
			socket := filepath.Join(socketDirectory, "s.sock")
			listener, err := net.Listen("unix", socket)
			if err != nil {
				t.Fatal(err)
			}
			defer listener.Close()
			writeHarnessEndpoint(t, root, socket)
			serveHelloVersion(t, listener, item.version)
			declarations := harnessDeclarations(t.TempDir())
			declarations[0].Version = "0.0.7"
			sidecars, err := NewSidecars(declarations, root)
			if err != nil {
				t.Fatal(err)
			}
			defer sidecars.Stop()
			owner := &harnessOwner{root: "/outdated", seen: make(chan SidecarMessage, 1)}
			if err := sidecars.Send(owner, "fixture-service", "surface", json.RawMessage(`{"operation":"open"}`)); err != nil {
				t.Fatal(err)
			}
			receiveSidecarMessage(t, owner.seen)
			got, _ := json.Marshal(sidecars.Outdated())
			want, _ := json.Marshal(item.want)
			if string(got) != string(want) {
				t.Fatalf("outdated = %s, want %s", got, want)
			}
		})
	}
}

// text is a pointer to value.
func text(value string) *string { return &value }

// recordText gives the records written so far as the text of a log.
type recordText func() string

func (r recordText) String() string { return r() }

// syncBuffer is a log writer that the test and the reader goroutines share.
type syncBuffer struct {
	mutex  sync.Mutex
	buffer bytes.Buffer
}

func (b *syncBuffer) Write(data []byte) (int, error) {
	b.mutex.Lock()
	defer b.mutex.Unlock()
	return b.buffer.Write(data)
}

func (b *syncBuffer) String() string {
	b.mutex.Lock()
	defer b.mutex.Unlock()
	return b.buffer.String()
}

// contract: sidecars-transport.persistent.lost-connection-writes-an-error-line
func TestPersistentTransportWritesAnErrorLineForALostConnection(t *testing.T) {
	logged := recordText(captureLog(t))
	root := t.TempDir()
	socketDirectory := socketParent(t)
	socket := filepath.Join(socketDirectory, "s.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	writeHarnessEndpoint(t, root, socket)
	// The first connection answers hello and one request and then ends; the second stays open until the host stops.
	go func() {
		for index := 0; index < 2; index++ {
			connection, err := listener.Accept()
			if err != nil {
				return
			}
			go func() {
				defer connection.Close()
				reader := bufio.NewReader(connection)
				if _, err := reader.ReadBytes('\n'); err != nil {
					return
				}
				if _, err := io.WriteString(connection, `{"operation":"hello","protocol":1,"ok":true}`+"\n"); err != nil {
					return
				}
				line, err := reader.ReadBytes('\n')
				if err != nil {
					return
				}
				if _, err := connection.Write(line); err != nil {
					return
				}
				if index == 0 {
					return
				}
				_, _ = reader.ReadBytes('\n')
			}()
		}
	}()
	sidecars, err := NewSidecars(harnessDeclarations(t.TempDir()), root)
	if err != nil {
		t.Fatal(err)
	}
	owner := &harnessOwner{root: "/only", seen: make(chan SidecarMessage, 8)}
	if err := sidecars.Send(owner, "fixture-service", "surface-1", json.RawMessage(`{"operation":"open"}`)); err != nil {
		t.Fatal(err)
	}
	receiveSidecarMessage(t, owner.seen) // the open echo
	receiveSidecarMessage(t, owner.seen) // the connection notice of the reconnection
	sidecars.Stop()
	listener.Close()
	count := strings.Count(logged.String(), "error host sidecar fixture-service: connection lost; restarted\n")
	if count != 1 {
		t.Fatalf("the log has %d lines of the lost connection: %q", count, logged.String())
	}
}

// replaceService is a fake persistent service (a message of a surface has no operation at its top level) that the host replaces: its first connection reports the old version,
// acknowledges close-owner and shutdown and then ends; its second connection reports the installed version.
type replaceService struct {
	listener   net.Listener
	mutex      sync.Mutex
	operations []string
	second     chan struct{}
	// afterShutdown runs after the service answered shutdown, while its process still runs.
	process *exec.Cmd
	// folder holds the executable that the host starts for the installed service: it announces the endpoint of this
	// fake service and keeps a process of its own.
	folder    string
	endsAfter time.Duration
	// hold, when set, keeps the first service from answering close-owner until it is closed; closeOwner receives a
	// signal for each close-owner that the first service read.
	hold       chan struct{}
	closeOwner chan struct{}
	// firstEnded, when set, is closed when the connection of the first service ends.
	firstEnded chan struct{}
	endedAt    time.Time
	ended      sync.WaitGroup
	secondAt   time.Time
}

func serveReplaceService(t *testing.T, root, oldVersion, installedVersion string) *replaceService {
	t.Helper()
	socketDirectory := socketParent(t)
	socket := filepath.Join(socketDirectory, "s.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { listener.Close() })
	writeHarnessEndpoint(t, root, socket)
	// The endpoint names a process that stands for the service and ends when the service shuts down.
	process := exec.Command("sleep", "60")
	if err := process.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { process.Process.Kill(); process.Wait() })
	endpoint, err := os.ReadFile(filepath.Join(root, "services", "service", "endpoint.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fields map[string]any
	if err := json.Unmarshal(endpoint, &fields); err != nil {
		t.Fatal(err)
	}
	fields["pid"] = process.Process.Pid
	if endpoint, err = json.Marshal(fields); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "services", "service", "endpoint.json"), endpoint, 0o600); err != nil {
		t.Fatal(err)
	}
	folder := t.TempDir()
	script := "#!/bin/sh\nprintf '{\"protocol\":1,\"pid\":%s,\"socket\":\"" + socket + "\",\"token\":\"harness-token\"}\\n' \"$$\"\nexec sleep 20\n"
	if err := os.WriteFile(filepath.Join(folder, "service"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	service := &replaceService{listener: listener, second: make(chan struct{}), process: process, folder: folder}
	go func() {
		for index := 0; ; index++ {
			connection, err := listener.Accept()
			if err != nil {
				return
			}
			version := oldVersion
			if index > 0 {
				version = installedVersion
				select {
				case <-service.second:
				default:
					service.secondAt = time.Now()
					close(service.second)
				}
			}
			go func(first bool) {
				defer connection.Close()
				if first && service.firstEnded != nil {
					defer close(service.firstEnded)
				}
				reader := bufio.NewReader(connection)
				for {
					line, err := reader.ReadBytes('\n')
					if err != nil {
						return
					}
					var request map[string]any
					if json.Unmarshal(line, &request) != nil {
						return
					}
					operation, _ := request["operation"].(string)
					if first {
						service.mutex.Lock()
						service.operations = append(service.operations, operation)
						service.mutex.Unlock()
					}
					var reply []byte
					switch operation {
					case "hello":
						reply, _ = json.Marshal(map[string]any{"operation": "hello", "protocol": 1, "ok": true, "version": version})
					case "close-owner":
						if first && service.closeOwner != nil {
							service.closeOwner <- struct{}{}
						}
						if first && service.hold != nil {
							<-service.hold
						}
						reply, _ = json.Marshal(map[string]any{"operation": "closed-owner", "request": request["request"], "ok": true})
					case "shutdown":
						reply, _ = json.Marshal(map[string]any{"operation": "shutdown", "request": request["request"], "ok": true})
					default:
						reply = line[:len(line)-1]
					}
					if _, err := connection.Write(append(reply, '\n')); err != nil {
						return
					}
					if operation == "shutdown" {
						// The process of the service ends after the answer, as that of a real service does.
						service.ended.Add(1)
						time.AfterFunc(service.endsAfter, func() {
							defer service.ended.Done()
							service.endedAt = time.Now()
							service.process.Process.Kill()
						})
						return
					}
				}
			}(index == 0)
		}
	}()
	return service
}

func (s *replaceService) received() []string {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	return append([]string{}, s.operations...)
}

func replaceSidecars(t *testing.T, root string, service *replaceService) *host.Sidecars {
	t.Helper()
	declarations := harnessDeclarations(service.folder)
	declarations[0].Version = "0.0.7"
	sidecars, err := NewSidecars(declarations, root)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(sidecars.Stop)
	return sidecars
}

// contract: sidecars-transport.replace.replaces-an-outdated-service
func TestAnOutdatedServiceIsReplaced(t *testing.T) {
	logged := recordText(captureLog(t))
	root := t.TempDir()
	service := serveReplaceService(t, root, "0.0.6", "0.0.7")
	sidecars := replaceSidecars(t, root, service)
	owner := &harnessOwner{root: "/replace", seen: make(chan SidecarMessage, 8)}
	if err := sidecars.Send(owner, "fixture-service", "surface-1", json.RawMessage(`{"operation":"open"}`)); err != nil {
		t.Fatal(err)
	}
	receiveSidecarMessage(t, owner.seen)
	if got := sidecars.Outdated(); len(got) != 1 || got[0].Installed != "0.0.7" || got[0].Running == nil || *got[0].Running != "0.0.6" {
		t.Fatalf("outdated before the replacement: %+v", got)
	}
	if err := sidecars.Replace(context.Background(), "fixture-service"); err != nil {
		t.Fatal(err)
	}
	// The surface that sent to the sidecar receives the connection notice of the new service.
	notice := receiveSidecarMessage(t, owner.seen)
	var event map[string]any
	if err := json.Unmarshal(notice.Body, &event); err != nil || event["event"] != "connection" || event["connected"] != true {
		t.Fatalf("the notice after the replacement is %s (%v)", notice.Body, err)
	}
	<-service.second
	if got := sidecars.Outdated(); len(got) != 0 {
		t.Fatalf("outdated after the replacement: %+v", got)
	}
	if got := service.received(); !slices.Equal(got, []string{"hello", "", "close-owner", "shutdown"}) {
		t.Fatalf("the old service received %v", got)
	}
	if want := "sidecar fixture-service: service 0.0.6 replaced by 0.0.7"; !strings.Contains(logged.String(), want) {
		t.Fatalf("the log has no %q: %q", want, logged.String())
	}
}

// contract: sidecars-transport.replace.refuses-a-service-that-is-not-outdated
func TestAServiceThatIsNotOutdatedIsNotReplaced(t *testing.T) {
	root := t.TempDir()
	service := serveReplaceService(t, root, "0.0.7", "0.0.7")
	sidecars := replaceSidecars(t, root, service)
	if err := sidecars.Replace(context.Background(), "fixture-service"); err == nil || !strings.Contains(err.Error(), "fixture-service") {
		t.Fatalf("replace without a running service: %v", err)
	}
	owner := &harnessOwner{root: "/replace", seen: make(chan SidecarMessage, 8)}
	if err := sidecars.Send(owner, "fixture-service", "surface-1", json.RawMessage(`{"operation":"open"}`)); err != nil {
		t.Fatal(err)
	}
	receiveSidecarMessage(t, owner.seen)
	if err := sidecars.Replace(context.Background(), "fixture-service"); err == nil || !strings.Contains(err.Error(), "fixture-service") {
		t.Fatalf("replace of the installed version: %v", err)
	}
	if got := service.received(); !slices.Equal(got, []string{"hello", ""}) {
		t.Fatalf("the service received %v after the refused replacements", got)
	}
}

// contract: sidecars-transport.replace.runs-when-sessions-reach-zero
func TestAnOutdatedServiceIsReplacedWhenItsSessionsEnd(t *testing.T) {
	root := t.TempDir()
	service := serveReplaceService(t, root, "0.0.6", "0.0.7")
	sidecars := replaceSidecars(t, root, service)
	owner := &harnessOwner{root: "/replace", seen: make(chan SidecarMessage, 8)}
	if err := sidecars.Send(owner, "fixture-service", "surface-1", json.RawMessage(`{"operation":"open"}`)); err != nil {
		t.Fatal(err)
	}
	receiveSidecarMessage(t, owner.seen)
	sidecars.Close("surface-1")
	<-service.second
	if got := service.received(); len(got) < 4 || got[len(got)-2] != "close-owner" || got[len(got)-1] != "shutdown" {
		t.Fatalf("the old service received %v", got)
	}
}

// contract: sidecars-transport.replace.waits-for-the-end-of-the-service-process
func TestAReplacedServiceStartsAfterTheEndOfItsProcess(t *testing.T) {
	root := t.TempDir()
	service := serveReplaceService(t, root, "0.0.6", "0.0.7")
	service.endsAfter = 300 * time.Millisecond
	sidecars := replaceSidecars(t, root, service)
	owner := &harnessOwner{root: "/replace", seen: make(chan SidecarMessage, 8)}
	if err := sidecars.Send(owner, "fixture-service", "surface-1", json.RawMessage(`{"operation":"open"}`)); err != nil {
		t.Fatal(err)
	}
	receiveSidecarMessage(t, owner.seen)
	if err := sidecars.Replace(context.Background(), "fixture-service"); err != nil {
		t.Fatal(err)
	}
	<-service.second
	service.ended.Wait()
	if !service.secondAt.After(service.endedAt) {
		t.Fatalf("the installed service started %v before its predecessor was ended at %v", service.endedAt.Sub(service.secondAt), service.endedAt)
	}
}

// contract: sidecars-transport.hello.client-is-the-configuration-directory
func TestTheHelloCarriesTheConfigurationDirectoryAsClient(t *testing.T) {
	root := t.TempDir()
	socketDirectory := socketParent(t)
	socket := filepath.Join(socketDirectory, "s.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	writeHarnessEndpoint(t, root, socket)
	hello := make(chan map[string]any, 1)
	go func() {
		connection, err := listener.Accept()
		if err != nil {
			return
		}
		defer connection.Close()
		reader := bufio.NewReader(connection)
		for {
			line, err := reader.ReadBytes('\n')
			if err != nil {
				return
			}
			var request map[string]any
			if json.Unmarshal(line, &request) != nil {
				return
			}
			if request["operation"] == "hello" {
				hello <- request
				io.WriteString(connection, `{"operation":"hello","protocol":1,"ok":true}`+"\n")
				continue
			}
			connection.Write(line)
		}
	}()
	sidecars, err := NewSidecars(harnessDeclarations(t.TempDir()), root)
	if err != nil {
		t.Fatal(err)
	}
	defer sidecars.Stop()
	owner := &harnessOwner{root: "/client", seen: make(chan SidecarMessage, 1)}
	if err := sidecars.Send(owner, "fixture-service", "surface-1", json.RawMessage(`{"operation":"open"}`)); err != nil {
		t.Fatal(err)
	}
	// The configuration directory is the host-resolved one, with symlinks resolved (docs/spec/performance-trace.md).
	resolved, err := filepath.EvalSymlinks(root)
	if err != nil {
		t.Fatal(err)
	}
	if got := (<-hello)["client"]; got != resolved {
		t.Fatalf("client %v, want the configuration directory %s", got, resolved)
	}
}

// contract: sidecars-transport.stop.leaves-the-close-of-a-replacement-to-the-replacement
func TestAStopLeavesTheCloseOfAReplacementToTheReplacement(t *testing.T) {
	root := t.TempDir()
	service := serveReplaceService(t, root, "0.0.6", "0.0.7")
	service.hold = make(chan struct{})
	service.closeOwner = make(chan struct{}, 4)
	sidecars := replaceSidecars(t, root, service)
	owner := &harnessOwner{root: "/replace", seen: make(chan SidecarMessage, 8)}
	if err := sidecars.Send(owner, "fixture-service", "surface-1", json.RawMessage(`{"operation":"open"}`)); err != nil {
		t.Fatal(err)
	}
	receiveSidecarMessage(t, owner.seen)
	replaced := make(chan error, 1)
	go func() { replaced <- sidecars.Replace(context.Background(), "fixture-service") }()
	// The replacement has sent its close-owner when the service has read it, and the service holds the answer.
	<-service.closeOwner
	stopped := make(chan struct{})
	go func() {
		sidecars.Stop()
		close(stopped)
	}()
	// The stop has begun when the host refuses a send; give its close time to reach the service.
	for sidecars.Send(owner, "fixture-service", "surface-2", json.RawMessage(`{"operation":"open"}`)) == nil {
		runtime.Gosched()
	}
	time.Sleep(200 * time.Millisecond)
	close(service.hold)
	<-stopped
	if err := <-replaced; err != nil {
		t.Fatalf("the replacement failed: %v", err)
	}
	closes := 0
	for _, operation := range service.received() {
		if operation == "close-owner" {
			closes++
		}
	}
	if closes != 1 {
		t.Fatalf("the service received %d close-owner requests: %v", closes, service.received())
	}
}

// contract: sidecars-transport.detach.closes-the-connection-without-closing-the-owner
func TestDetachClosesTheConnectionOfAPersistentServiceWithoutClosingTheOwner(t *testing.T) {
	root := t.TempDir()
	service := serveReplaceService(t, root, "0.0.7", "0.0.7")
	service.firstEnded = make(chan struct{})
	sidecars := replaceSidecars(t, root, service)
	owner := &harnessOwner{root: "/replace", seen: make(chan SidecarMessage, 8)}
	if err := sidecars.Send(owner, "fixture-service", "surface-1", json.RawMessage(`{"operation":"open"}`)); err != nil {
		t.Fatal(err)
	}
	receiveSidecarMessage(t, owner.seen)
	sidecars.Detach()
	// The connection ends, which is the only thing that the service learns, and the sessions of the service stay.
	select {
	case <-service.firstEnded:
	case <-time.After(10 * time.Second):
		t.Fatal("the connection of the service did not end")
	}
	for _, operation := range service.received() {
		if operation == "close-owner" || operation == "shutdown" {
			t.Fatalf("the service received %v", service.received())
		}
	}
	// Stopping after a detach does nothing more to the service.
	sidecars.Stop()
	for _, operation := range service.received() {
		if operation == "close-owner" || operation == "shutdown" {
			t.Fatalf("the stop after the detach sent to the service: %v", service.received())
		}
	}
}

// eventsService is the name of the service of the event check; the process shares the writer of the records, so the events of the
// services of the other checks are told apart by the name.
const eventsService = "fixture-events-service"

// contract: sidecars-transport.persistent.connection-events
func TestPersistentConnectionsAreRecordedAsEvents(t *testing.T) {
	root := t.TempDir()
	socketDirectory := socketParent(t)
	socket := filepath.Join(socketDirectory, "s.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	writeHarnessEndpoint(t, root, socket)
	config := t.TempDir()
	log := support.StartWriter(t, config)

	// The first connection answers one request and closes; the second stays open.
	serverDone := make(chan struct{})
	go func() {
		defer close(serverDone)
		for index := 0; index < 2; index++ {
			connection, err := listener.Accept()
			if err != nil {
				return
			}
			keepOpen := index == 1
			go func() {
				defer connection.Close()
				reader := bufio.NewReader(connection)
				if _, err := reader.ReadBytes('\n'); err != nil {
					return
				}
				if _, err := io.WriteString(connection, `{"operation":"hello","protocol":1,"ok":true}`+"\n"); err != nil {
					return
				}
				for {
					line, err := reader.ReadBytes('\n')
					if err != nil {
						return
					}
					if _, err := connection.Write(line); err != nil {
						return
					}
					if !keepOpen {
						return
					}
				}
			}()
		}
	}()

	sidecars, err := NewSidecars([]SidecarDeclaration{{Name: eventsService, Folder: t.TempDir(),
		Data: []byte(`{"executable":"service","protocol":1,"transport":"persistent"}`)}}, root)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = host.PerformanceCommand(map[string]any{"action": "off"}) })
	if _, err := host.PerformanceCommand(map[string]any{"action": "on"}); err != nil {
		t.Fatal(err)
	}
	owner := &harnessOwner{root: "/only", seen: make(chan SidecarMessage, 8)}
	if err := sidecars.Send(owner, eventsService, "surface-1", json.RawMessage(`{"operation":"open"}`)); err != nil {
		t.Fatal(err)
	}
	receiveSidecarMessage(t, owner.seen) // the echo
	receiveSidecarMessage(t, owner.seen) // the notice of the reconnection
	// The sampler names the service while it is connected and not after the connection ended.
	sampledService := func() int {
		host.PerformanceSample()
		if err := log.Flush(5 * time.Second); err != nil {
			t.Fatal(err)
		}
		count := 0
		for _, event := range support.ReadEvents(t, support.EventLogPath(t, config)) {
			if event["event"] == "host.sampler.memory" && event["fields"].(map[string]any)["name"] == eventsService {
				count++
			}
		}
		return count
	}
	connected := sampledService()
	sidecars.Stop()
	if ended := sampledService(); connected == 0 || ended != connected {
		t.Fatalf("samples of the service: %d while connected, %d after the connection ended", connected, ended)
	}
	listener.Close()
	<-serverDone
	if err := log.Flush(5 * time.Second); err != nil {
		t.Fatal(err)
	}
	var seen []string
	for _, event := range support.ReadEvents(t, support.EventLogPath(t, config)) {
		name, _ := event["event"].(string)
		if name != "host.sidecar.connect" && name != "host.sidecar.disconnect" {
			continue
		}
		fields := event["fields"].(map[string]any)
		if fields["name"] != eventsService {
			continue
		}
		seen = append(seen, fmt.Sprintf("%s %v", name, fields["stopping"]))
	}
	want := []string{"host.sidecar.connect <nil>", "host.sidecar.disconnect false", "host.sidecar.connect <nil>", "host.sidecar.disconnect true"}
	if strings.Join(seen, "|") != strings.Join(want, "|") {
		t.Fatalf("connection events = %q, want %q", seen, want)
	}
}

// contract: sidecars.trace.first-answer-after-spawn-is-recorded
func TestPersistentSpawnedServiceFirstAnswerAfterSpawnIsRecorded(t *testing.T) {
	config := t.TempDir()
	folder := t.TempDir()
	socket := filepath.Join(socketParent(t), "s.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	// The service that the host spawns prints its endpoint and records its process id; the listener of this check serves it.
	// It stays alive until the check ends, so the host does not treat it as a stale endpoint (ServiceProcessExists).
	pidPath := filepath.Join(folder, "pid")
	script := fmt.Sprintf("#!/bin/sh\necho $$ > %s\necho '{\"protocol\":1,\"pid\":'$$',\"socket\":\"%s\",\"token\":\"harness-token\"}'\nexec sleep 600\n",
		pidPath, socket)
	if err := os.WriteFile(filepath.Join(folder, "service"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	// The spawned service is ended by this check when the check ends, whatever its result.
	t.Cleanup(func() {
		data, err := os.ReadFile(pidPath)
		if err != nil {
			return
		}
		if pid, err := strconv.Atoi(strings.TrimSpace(string(data))); err == nil {
			_ = syscall.Kill(pid, syscall.SIGKILL)
		}
	})
	served := make(chan struct{})
	go func() {
		defer close(served)
		connection, err := listener.Accept()
		if err != nil {
			return
		}
		defer connection.Close()
		reader := bufio.NewReader(connection)
		if _, err := reader.ReadBytes('\n'); err != nil {
			return
		}
		if _, err := io.WriteString(connection, `{"operation":"hello","protocol":1,"ok":true}`+"\n"); err != nil {
			return
		}
		for {
			line, err := reader.ReadBytes('\n')
			if err != nil {
				return
			}
			if _, err := connection.Write(line); err != nil {
				return
			}
		}
	}()
	log := support.StartWriter(t, config)
	sidecars, err := NewSidecars(harnessDeclarations(folder), config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = host.PerformanceCommand(map[string]any{"action": "off"}) })
	if _, err := host.PerformanceCommand(map[string]any{"action": "on"}); err != nil {
		t.Fatal(err)
	}
	owner := &harnessOwner{root: "/only", seen: make(chan SidecarMessage, 8)}
	if err := sidecars.Send(owner, "fixture-service", "s1", json.RawMessage(`{"operation":"open"}`)); err != nil {
		t.Fatal(err)
	}
	receiveSidecarMessage(t, owner.seen)
	sidecars.Stop()
	listener.Close()
	<-served
	if err := log.Flush(5 * time.Second); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(folder, "pid"))
	if err != nil {
		t.Fatal(err)
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(data)))
	if err != nil {
		t.Fatal(err)
	}
	var ready map[string]any
	for _, event := range support.ReadEvents(t, support.EventLogPath(t, config)) {
		if event["event"] == "host.trace.sidecar.ready" {
			ready = event
		}
	}
	if ready == nil {
		t.Fatal("the first answer after the spawn of the service was not recorded")
	}
	fields, _ := ready["fields"].(map[string]any)
	if ready["level"] != "debug" || fields["sidecar"] != "fixture-service" || fields["pid"] != float64(pid) {
		t.Fatalf("ready event = %v", ready)
	}
	if ms, ok := fields["ms"].(float64); !ok || ms < 0 {
		t.Fatalf("ms = %v, want a number of milliseconds from the spawn", fields["ms"])
	}
}

// requireConnectionNotice waits for the next sidecar message of owner and checks that it is the connection notice of surface
// with connected and, for a failed connection, reason.
func requireConnectionNotice(t *testing.T, owner *failureOwner, surface string, connected bool, reason string) {
	t.Helper()
	message := receiveSidecarMessage(t, owner.seen)
	var notice map[string]any
	if err := json.Unmarshal(message.Body, &notice); err != nil {
		t.Fatalf("the notice of %s is not JSON: %v", message.Surface, err)
	}
	got, _ := notice["reason"].(string)
	if message.Surface != surface || notice["event"] != "connection" || notice["connected"] != connected || got != reason {
		t.Fatalf("notice of %s = %v, want the connection notice of %s with connected %v and reason %q", message.Surface, notice, surface, connected, reason)
	}
}

// deadProcessID is the process id of a process that has ended and has been reaped.
func deadProcessID(t *testing.T) int {
	t.Helper()
	command := exec.Command("/usr/bin/true")
	if err := command.Run(); err != nil {
		t.Fatal(err)
	}
	return command.Process.Pid
}

// The restart limit counts the failures of a persistent service (docs/spec/terminal-runtime.md#service-transport): three
// failed starts that sends ran and the end of the service process that a revival finds are four failures, and a revival
// that reattaches the live service counts none. The fourth failure stops the restarts before the revival spawns; a
// refused send gets the connection notice, and the open of a surface of a dependent plugin clears the stop.
// contract: sidecars.restart.persistent-service-end-stops-before-the-spawn, sidecars.restart.persistent-refused-send-gets-the-connection-notice
func TestPersistentServiceEndStopsTheRestartsBeforeTheSpawn(t *testing.T) {
	log := useEventLog(t)
	root := t.TempDir()
	folder := t.TempDir()
	runs := filepath.Join(folder, "runs")
	if err := os.WriteFile(filepath.Join(folder, "service"), []byte("#!/bin/sh\necho run >> '"+runs+"'\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	declarations := harnessDeclarations(folder)
	declarations[0].Dependents = []string{"plugin-a"}
	sidecars, err := NewSidecars(declarations, root)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(sidecars.Stop)
	clock := &restartClock{}
	sidecars.Now = clock.read
	owner := &failureOwner{root: "/only", seen: make(chan SidecarMessage, 16), failures: make(chan host.SidecarFailure, 16)}
	send := func(surface string, offset time.Duration) error {
		clock.set(offset)
		return sidecars.Send(owner, "fixture-service", surface, json.RawMessage(`{"operation":"open"}`))
	}
	countRuns := func() int {
		data, err := os.ReadFile(runs)
		if err != nil && !os.IsNotExist(err) {
			t.Fatal(err)
		}
		return strings.Count(string(data), "run\n")
	}
	exited := "sidecar fixture-service: service exited before endpoint"
	for _, offset := range []time.Duration{0, 10 * time.Second, 20 * time.Second} {
		if err := send("surface-1", offset); err == nil || err.Error() != exited {
			t.Fatalf("send at %v = %v, want %q", offset, err, exited)
		}
	}

	// A live service: its first connection echoes one request and ends, and the second ends when cut is closed.
	socket := filepath.Join(socketParent(t), "s.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { listener.Close() })
	writeHarnessEndpoint(t, root, socket)
	cut := make(chan struct{})
	go func() {
		for index := 0; index < 2; index++ {
			connection, err := listener.Accept()
			if err != nil {
				return
			}
			go func() {
				defer connection.Close()
				reader := bufio.NewReader(connection)
				if _, err := reader.ReadBytes('\n'); err != nil {
					return
				}
				if _, err := io.WriteString(connection, `{"operation":"hello","protocol":1,"ok":true}`+"\n"); err != nil {
					return
				}
				if index == 1 {
					<-cut
					return
				}
				line, err := reader.ReadBytes('\n')
				if err != nil {
					return
				}
				_, _ = connection.Write(line)
			}()
		}
	}()
	if err := send("surface-1", 30*time.Second); err != nil {
		t.Fatalf("send to the live service: %v", err)
	}
	receiveSidecarMessage(t, owner.seen) // the echo of the open request
	// The first connection ended and the revival reattached the live service: no failure is counted.
	requireConnectionNotice(t, owner, "surface-1", true, "")

	// The service process ends: its endpoint names a process that no longer exists. The revival counts the fourth failure
	// and stops before it spawns the service.
	service := filepath.Join(root, "services", "service")
	endpoint, err := json.Marshal(map[string]any{"protocol": 1, "pid": deadProcessID(t), "socket": socket, "token": "harness-token"})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(service, "endpoint.json"), endpoint, 0o600); err != nil {
		t.Fatal(err)
	}
	clock.set(40 * time.Second)
	close(cut)
	requireConnectionNotice(t, owner, "surface-1", false, "restart limit")
	if got := countRuns(); got != 3 {
		t.Fatalf("the service was spawned %d times, want 3: the stopped revival spawned it", got)
	}

	// While the service is stopped, a send is refused with the connection notice and no sidecar-failure.
	if err := send("surface-1", 50*time.Second); err == nil || err.Error() != "sidecar fixture-service: restart limit" {
		t.Fatalf("send while stopped = %v, want the restart limit refusal", err)
	}
	requireConnectionNotice(t, owner, "surface-1", false, "restart limit")
	select {
	case failure := <-owner.failures:
		t.Fatalf("the refused send delivered a sidecar failure: %+v", failure)
	default:
	}
	if got := countRuns(); got != 3 {
		t.Fatalf("the refused send spawned the service: %d runs", got)
	}

	// The open of a surface of a plugin that lists the sidecar clears the stop: the next send runs the creation path.
	sidecars.SurfaceOpened("plugin-a", "surface-2")
	if err := send("surface-2", 60*time.Second); err == nil || err.Error() != exited {
		t.Fatalf("send after the reset = %v, want %q", err, exited)
	}
	if got := countRuns(); got != 4 {
		t.Fatalf("the send after the reset spawned the service %d times in all, want 4", got)
	}

	sidecars.Stop()
	if err := log.Flush(5 * time.Second); err != nil {
		t.Fatal(err)
	}
	events := readEventLog(t, log.Path())
	text := support.TextOf(events)
	if count := strings.Count(text, "error host sidecar fixture-service: restart limit: 4 failures within 300 s\n"); count != 1 {
		t.Fatalf("the log has %d restart-limit lines: %q", count, text)
	}
	if !strings.Contains(text, "error host sidecar fixture-service: restart limit: request for surface-1 refused\n") {
		t.Fatalf("the log has no refusal line: %q", text)
	}
	stops, resets := 0, 0
	for _, event := range events {
		switch event["event"] {
		case "host.sidecar.restart-limit":
			stops++
			if event["level"] != "error" || event["fields"].(map[string]any)["sidecar"] != "fixture-service" {
				t.Fatalf("restart-limit event = %v", event)
			}
		case "host.trace.sidecar.restart-reset":
			resets++
			if fields := event["fields"].(map[string]any); fields["sidecar"] != "fixture-service" || fields["surface"] != "surface-2" {
				t.Fatalf("restart-reset event = %v", event)
			}
		}
	}
	if stops != 1 || resets != 1 {
		t.Fatalf("restart-limit events = %d, restart-reset events = %d; want 1 and 1", stops, resets)
	}
}

// A connection that the reader ends for a protocol violation is a failure of the persistent service, so the fourth
// violation within 300 seconds stops the restarts (docs/spec/terminal-runtime.md#service-transport).
// contract: sidecars.restart.persistent-violation-counts
func TestPersistentProtocolViolationsStopTheRestarts(t *testing.T) {
	root := t.TempDir()
	socket := filepath.Join(socketParent(t), "s.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { listener.Close() })
	writeHarnessEndpoint(t, root, socket)
	var connections sync.WaitGroup
	t.Cleanup(connections.Wait)
	accepted := make(chan struct{}, 8)
	go func() {
		for {
			connection, err := listener.Accept()
			if err != nil {
				return
			}
			accepted <- struct{}{}
			connections.Add(1)
			go func() {
				defer connections.Done()
				defer connection.Close()
				reader := bufio.NewReader(connection)
				if _, err := reader.ReadBytes('\n'); err != nil {
					return
				}
				if _, err := io.WriteString(connection, `{"operation":"hello","protocol":1,"ok":true}`+"\n"); err != nil {
					return
				}
				if _, err := reader.ReadBytes('\n'); err != nil {
					return
				}
				if _, err := io.WriteString(connection, "not json\n"); err != nil {
					return
				}
				_, _ = io.Copy(io.Discard, reader)
			}()
		}
	}()
	sidecars, err := NewSidecars(harnessDeclarations(t.TempDir()), root)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(sidecars.Stop)
	clock := &restartClock{}
	sidecars.Now = clock.read
	owner := &failureOwner{root: "/only", seen: make(chan SidecarMessage, 16), failures: make(chan host.SidecarFailure, 16)}
	for _, offset := range []time.Duration{0, 10 * time.Second, 20 * time.Second, 30 * time.Second} {
		clock.set(offset)
		if err := sidecars.Send(owner, "fixture-service", "surface-1", json.RawMessage(`{"operation":"open"}`)); err != nil {
			t.Fatalf("send at %v: %v", offset, err)
		}
		select {
		case failure := <-owner.failures:
			if !strings.HasPrefix(failure.Reason, "invalid message: ") {
				t.Fatalf("failure at %v = %+v", offset, failure)
			}
		case <-time.After(stall):
			t.Fatalf("no sidecar failure at %v; the test stalled", offset)
		}
	}
	clock.set(40 * time.Second)
	err = sidecars.Send(owner, "fixture-service", "surface-1", json.RawMessage(`{"operation":"open"}`))
	if err == nil || err.Error() != "sidecar fixture-service: restart limit" {
		t.Fatalf("send at 40s = %v, want the restart limit refusal", err)
	}
	if got := len(accepted); got != 4 {
		t.Fatalf("the host connected %d times, want 4", got)
	}
}
