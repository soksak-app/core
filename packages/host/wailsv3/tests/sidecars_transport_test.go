package host_test

import (
	"bufio"
	"bytes"
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
	"time"

	host "github.com/min-median-max/soksak/packages/host/wailsv3/src"
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

// harnessDeclarations 는 folder 에 설치된 영속 사이드카 하나의 선언이다.
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
				if err := json.Unmarshal(line, &hello); err != nil || hello["operation"] != "hello" || hello["protocol"] != float64(1) || hello["token"] != "harness-token" {
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
				// 처음 두 연결은 실행 중 연결 끊김을 재현한다. 재연결은
				// endpoint 를 사용하고 host 가 선언한 identity 를 유지해야 한다.
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

// contract: sidecars-transport.endpoint.concurrent-hosts-share-authenticated-service, sidecars-transport.hello.declares-protocol-one, sidecars-transport.reconnect.after-connection-loss-preserves-owner, sidecars-transport.stop.close-owner-failure-returns-promptly
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
		case <-time.After(stall):
			t.Fatal("no initial event; the test stalled")
		}
	}
	// 처음 두 socket 이 모두 끊긴다. host 는 곧바로 다시 맺고 연결 이벤트를 보낸다. 그 이벤트를 받은 뒤의
	// send 는 다시 맺은 연결로 가므로 endpoint 재사용과 재연결을 검증한다.
	for _, owner := range []*harnessOwner{firstOwner, secondOwner} {
		select {
		case event := <-owner.seen:
			if string(event.Body) != `{"connected":true,"event":"connection"}` {
				t.Fatalf("event after the connection loss = %s, want the connection event", event.Body)
			}
		case <-time.After(stall):
			t.Fatal("no connection event; the test stalled")
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
	// 실패한 close-owner 답은 Stop 의 기한을 기다리지 않고 끝난다. 기한까지 걸렸으면 답을 기다리지 않은 것이다.
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

	// 서비스는 hello, open, close-owner, shutdown 을 이 순서로 받아야 한다.
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
	socketDirectory, err := os.MkdirTemp("", "sp-r")
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
	// 레이아웃에 표면이 없고 이 프로세스가 보낸 표면도 없으면 빈 배열을 보낸다.
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
	socketDirectory, err := os.MkdirTemp("", "sp-revive")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(socketDirectory)
	socket := filepath.Join(socketDirectory, "s.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	writeHarnessEndpoint(t, root, socket)

	// 첫 연결은 요청 하나를 되돌린 뒤 스스로 끊는다. 다시 맺은 연결은 닫지 않는다 —
	// 끊김이 한 번만 일어나야 재시작도 한 번만 일어난다.
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

	// 연결이 끊기면 전송 없이 다시 맞아야 한다 — 연결 이벤트가 그 증거다(V5-106).
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

	// 다음 전송은 다시 맺은 연결로 지나간다.
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
	socketDirectory, err := os.MkdirTemp("", "sp-failed-revive")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(socketDirectory)
	socket := filepath.Join(socketDirectory, "s.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	writeHarnessEndpoint(t, root, socket)

	// 첫 연결은 요청 하나를 되돌린 뒤, 수신기가 닫힌 뒤에야 끊는다 — 재시작의 연결이
	// 큐에 쌓이는 대신 거절되어야 실패 알림이 결정적으로 도착한다.
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
		// 수신기가 닫힌 뒤에야 연결을 끊는다.
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

	// 수신기를 먼저 닫은 뒤 연결이 끊긴다. 엔드포인트의 pid 는 이 검사 프로세스이므로
	// 살아 있고, 재시작은 같은 소켓에 연결을 시도해 거절된다.
	listener.Close()
	close(closed)
	<-serverDone

	// 재시작이 실패하면 연결 끊김과 그 까닭이 표면에 알려진다(V5-106).
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

// failureOwner 는 사이드카 메시지와 실패를 따로 모으는 창이다.
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

// serveOneBadLine 은 연결 하나에 hello 로 답하고 요청 한 줄을 받은 뒤 payload 를 쓴다. host 가 연결을 닫으면
// closed 를 닫는다. payload 를 다 쓰기 전에 host 가 닫으면 쓰기 오류는 기대한 결과다.
func serveOneBadLine(t *testing.T, payload []byte) (root string, closed <-chan struct{}) {
	t.Helper()
	root = t.TempDir()
	socketDirectory, err := os.MkdirTemp("", "sp-bad-line")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(socketDirectory) })
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
		// host 가 연결을 닫으면 읽기가 EOF 로 끝난다.
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

// 영속 사이드카의 시작(service 연결과 hello)은 다른 사이드카로의 전송을 기다리게 하지 않는다. service 는 hello 에
// 500 ms 늦게 답하고, 그동안 이미 실행 중인 다른 사이드카로 보낸다.
// contract: sidecars.send.start-does-not-block-other-sidecars
func TestPersistentStartDoesNotDelayOtherSidecars(t *testing.T) {
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

// hello 를 받고 답하지 않는 service 로의 시작은 5초 뒤 정해진 문장으로 실패한다.
// contract: sidecars-transport.hello.times-out
func TestPersistentStartFailsWhenHelloIsNotAnswered(t *testing.T) {
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

// 새로 시작한 service 가 endpoint 를 출력하지 않으면 시작은 ReadyTimeout 뒤 정해진 문장으로 실패하고, 호스트는 그
// service 를 끝내고 회수한다. 검사는 기본 30초 대신 1초를 준다.
// contract: sidecars-transport.startup.times-out
func TestPersistentStartFailsWhenTheServicePrintsNoEndpoint(t *testing.T) {
	folder := t.TempDir()
	script := "#!/bin/sh\necho $$ > \"$2/pid\"\nexec sleep 60\n"
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
	text, err := os.ReadFile(filepath.Join(root, "services", "service", "pid"))
	if err != nil {
		t.Fatal(err)
	}
	var pid int
	if _, err := fmt.Sscanf(string(text), "%d", &pid); err != nil {
		t.Fatalf("service pid %q: %v", text, err)
	}
	if exists, err := exec.Command("kill", "-0", fmt.Sprint(pid)).CombinedOutput(); err == nil {
		t.Fatalf("the silent service %d still runs: %s", pid, exists)
	}
}

// sendWithin 은 fixture-service 로 보내고 그 결과를 limit 안에 돌려준다. 돌아오지 않으면 검사가 실패한다.
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

// 새로 시작한 service 의 표준 오류는 설정 디렉터리의 그 실행 파일 이름 로그에 쌓인다.
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

// 서비스 로그를 열 수 없으면 서비스를 시작하지 않고 정해진 문장으로 실패한다.
// contract: log.service.open-failure-fails-start
func TestPersistentStartFailsWhenTheServiceLogCannotOpen(t *testing.T) {
	folder := t.TempDir()
	started := filepath.Join(folder, "started")
	if err := os.WriteFile(filepath.Join(folder, "service"), []byte("#!/bin/sh\ntouch "+started+"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	config := t.TempDir()
	// logs 가 파일이면 로그 디렉터리를 만들 수 없다.
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

// 새로 시작한 service 가 endpoint 를 출력하기 전에 끝나면 시작은 정해진 문장으로 실패한다.
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
