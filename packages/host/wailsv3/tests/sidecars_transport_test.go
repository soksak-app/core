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
		case <-time.After(time.Second):
			t.Fatal("no initial event")
		}
	}
	time.Sleep(20 * time.Millisecond)

	// 처음 두 socket 이 모두 끊긴다. 다음 send 는 endpoint 재사용과 재연결을 검증한다.
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
		if err := connection.SetReadDeadline(time.Now().Add(10 * time.Second)); err != nil {
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
	case <-time.After(10 * time.Second):
		t.Fatal("no sidecar message arrived within 10s")
		return SidecarMessage{}
	}
}
