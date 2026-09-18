package main_test

import (
	"bufio"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/min-median-max/soksak/sidecars/ptyd/src/ptyd"
)

// TestOutputEchoHi tests that output from echo hi arrives via subscription.
func TestOutputEchoHi(t *testing.T) {
	socketDir := "/tmp/sp-test-output-echo-" + fmt.Sprintf("%d", os.Getpid())
	os.RemoveAll(socketDir)
	defer os.RemoveAll(socketDir)

	identity := ptyd.DaemonIdentity{
		Protocol:  "test",
		BuildKind: "debug",
		PID:       os.Getpid(),
	}

	daemon := ptyd.NewDaemon(identity, socketDir, 10*time.Second)
	if err := daemon.Start(); err != nil {
		t.Fatalf("daemon start: %v", err)
	}
	defer daemon.Stop()

	time.Sleep(50 * time.Millisecond)

	sockPath := ptyd.SocketPath(socketDir, identity)
	conn, err := net.Dial("unix", sockPath)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()

	// Send open request for /bin/sh -c 'echo hi'
	openReq := map[string]interface{}{
		"command": "open",
		"program": "/bin/sh",
		"args":    []string{"-c", "echo hi"},
		"cols":    80,
		"rows":    24,
	}
	openJSON, _ := json.Marshal(openReq)
	conn.Write(append(openJSON, '\n'))

	reader := bufio.NewReader(conn)

	// Read open response
	respLine, _ := reader.ReadBytes('\n')
	var openResp map[string]interface{}
	json.Unmarshal(respLine, &openResp)

	sessionID, ok := openResp["sessionId"].(string)
	if !ok || sessionID == "" {
		t.Fatalf("no sessionId in open response: %s", respLine)
	}

	// Now we should receive output messages
	// Wait up to 2 seconds for output
	outreceived := false
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		conn.SetReadDeadline(time.Now().Add(100 * time.Millisecond))
		respLine, err := reader.ReadBytes('\n')
		conn.SetReadDeadline(time.Time{})

		if err != nil {
			if strings.Contains(err.Error(), "deadline exceeded") {
				continue
			}
			break
		}

		var msg map[string]interface{}
		if err := json.Unmarshal(respLine, &msg); err != nil {
			continue
		}

		cmd, ok := msg["command"].(string)
		if !ok {
			continue
		}

		if cmd == "output" {
			outputB64, ok := msg["output"].(string)
			if !ok {
				continue
			}

			outputData, err := base64.StdEncoding.DecodeString(outputB64)
			if err != nil {
				continue
			}

			if strings.Contains(string(outputData), "hi") {
				outreceived = true
				break
			}
		} else if cmd == "exit" {
			break
		}
	}

	if !outreceived {
		t.Error("did not receive 'hi' in output")
	}
}

// TestOutputCatRoundTrip tests that input echoed by cat arrives via subscription.
func TestOutputCatRoundTrip(t *testing.T) {
	socketDir := "/tmp/sp-test-output-cat-" + fmt.Sprintf("%d", os.Getpid())
	os.RemoveAll(socketDir)
	defer os.RemoveAll(socketDir)

	identity := ptyd.DaemonIdentity{
		Protocol:  "test",
		BuildKind: "debug",
		PID:       os.Getpid(),
	}

	daemon := ptyd.NewDaemon(identity, socketDir, 10*time.Second)
	if err := daemon.Start(); err != nil {
		t.Fatalf("daemon start: %v", err)
	}
	defer daemon.Stop()

	time.Sleep(50 * time.Millisecond)

	sockPath := ptyd.SocketPath(socketDir, identity)
	conn, err := net.Dial("unix", sockPath)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()

	// Open cat
	openReq := map[string]interface{}{
		"command": "open",
		"program": "/bin/cat",
		"cols":    80,
		"rows":    24,
	}
	openJSON, _ := json.Marshal(openReq)
	conn.Write(append(openJSON, '\n'))

	reader := bufio.NewReader(conn)

	// Read open response
	respLine, _ := reader.ReadBytes('\n')
	var openResp map[string]interface{}
	json.Unmarshal(respLine, &openResp)

	sessionID, ok := openResp["sessionId"].(string)
	if !ok || sessionID == "" {
		t.Fatalf("no sessionId")
	}

	time.Sleep(100 * time.Millisecond)

	// Write data to cat
	writeData := "test input"
	writeReq := map[string]interface{}{
		"command":   "write",
		"sessionId": sessionID,
		"data":      base64.StdEncoding.EncodeToString([]byte(writeData)),
	}
	writeJSON, _ := json.Marshal(writeReq)
	conn.Write(append(writeJSON, '\n'))
	reader.ReadBytes('\n') // read write response

	time.Sleep(100 * time.Millisecond)

	// Wait for output messages
	outreceived := false
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		conn.SetReadDeadline(time.Now().Add(100 * time.Millisecond))
		respLine, err := reader.ReadBytes('\n')
		conn.SetReadDeadline(time.Time{})

		if err != nil {
			if strings.Contains(err.Error(), "deadline exceeded") {
				continue
			}
			break
		}

		var msg map[string]interface{}
		if err := json.Unmarshal(respLine, &msg); err != nil {
			continue
		}

		cmd, ok := msg["command"].(string)
		if !ok {
			continue
		}

		if cmd == "output" {
			outputB64, ok := msg["output"].(string)
			if !ok {
				continue
			}

			outputData, err := base64.StdEncoding.DecodeString(outputB64)
			if err != nil {
				continue
			}

			if strings.Contains(string(outputData), "test input") {
				outreceived = true
				break
			}
		}
	}

	if !outreceived {
		t.Error("did not receive echoed input from cat")
	}
}

// TestOutputMultiConsumer tests that two connections both receive the same output.
func TestOutputMultiConsumer(t *testing.T) {
	socketDir := "/tmp/sp-test-output-multi-" + fmt.Sprintf("%d", os.Getpid())
	os.RemoveAll(socketDir)
	defer os.RemoveAll(socketDir)

	identity := ptyd.DaemonIdentity{
		Protocol:  "test",
		BuildKind: "debug",
		PID:       os.Getpid(),
	}

	daemon := ptyd.NewDaemon(identity, socketDir, 10*time.Second)
	if err := daemon.Start(); err != nil {
		t.Fatalf("daemon start: %v", err)
	}
	defer daemon.Stop()

	time.Sleep(50 * time.Millisecond)

	sockPath := ptyd.SocketPath(socketDir, identity)

	// Connection A: open and get sessionID
	connA, err := net.Dial("unix", sockPath)
	if err != nil {
		t.Fatalf("dial A: %v", err)
	}
	defer connA.Close()

	openReq := map[string]interface{}{
		"command": "open",
		"program": "/bin/sh",
		"args":    []string{"-c", "echo hi"},
		"cols":    80,
		"rows":    24,
	}
	openJSON, _ := json.Marshal(openReq)
	connA.Write(append(openJSON, '\n'))

	readerA := bufio.NewReader(connA)
	respLine, _ := readerA.ReadBytes('\n')
	var openResp map[string]interface{}
	json.Unmarshal(respLine, &openResp)

	sessionID, ok := openResp["sessionId"].(string)
	if !ok || sessionID == "" {
		t.Fatalf("no sessionId from A")
	}

	// Connection B: attach to the same session
	connB, err := net.Dial("unix", sockPath)
	if err != nil {
		t.Fatalf("dial B: %v", err)
	}
	defer connB.Close()

	attachReq := map[string]interface{}{
		"command":   "attach",
		"sessionId": sessionID,
		"from":      0,
	}
	attachJSON, _ := json.Marshal(attachReq)
	connB.Write(append(attachJSON, '\n'))

	readerB := bufio.NewReader(connB)

	// Wait for both connections to receive "hi"
	receivedA := false
	receivedB := false
	deadline := time.Now().Add(2 * time.Second)

	for time.Now().Before(deadline) && (!receivedA || !receivedB) {
		// Try to read from A
		if !receivedA {
			connA.SetReadDeadline(time.Now().Add(50 * time.Millisecond))
			respLine, err := readerA.ReadBytes('\n')
			connA.SetReadDeadline(time.Time{})

			if err == nil {
				var msg map[string]interface{}
				if json.Unmarshal(respLine, &msg) == nil {
					if cmd, ok := msg["command"].(string); ok && cmd == "output" {
						if outputB64, ok := msg["output"].(string); ok {
							if outputData, err := base64.StdEncoding.DecodeString(outputB64); err == nil {
								if strings.Contains(string(outputData), "hi") {
									receivedA = true
								}
							}
						}
					}
				}
			}
		}

		// Try to read from B
		if !receivedB {
			connB.SetReadDeadline(time.Now().Add(50 * time.Millisecond))
			respLine, err := readerB.ReadBytes('\n')
			connB.SetReadDeadline(time.Time{})

			if err == nil {
				var msg map[string]interface{}
				if json.Unmarshal(respLine, &msg) == nil {
					if cmd, ok := msg["command"].(string); ok && cmd == "output" {
						if outputB64, ok := msg["output"].(string); ok {
							if outputData, err := base64.StdEncoding.DecodeString(outputB64); err == nil {
								if strings.Contains(string(outputData), "hi") {
									receivedB = true
								}
							}
						}
					}
				}
			}
		}
	}

	if !receivedA {
		t.Error("connection A did not receive output")
	}
	if !receivedB {
		t.Error("connection B did not receive output")
	}
}

// TestOutputReconnectionReplay tests that after disconnect, a new connection replays the ring.
func TestOutputReconnectionReplay(t *testing.T) {
	socketDir := "/tmp/sp-test-output-replay-" + fmt.Sprintf("%d", os.Getpid())
	os.RemoveAll(socketDir)
	defer os.RemoveAll(socketDir)

	identity := ptyd.DaemonIdentity{
		Protocol:  "test",
		BuildKind: "debug",
		PID:       os.Getpid(),
	}

	daemon := ptyd.NewDaemon(identity, socketDir, 10*time.Second)
	if err := daemon.Start(); err != nil {
		t.Fatalf("daemon start: %v", err)
	}
	defer daemon.Stop()

	time.Sleep(50 * time.Millisecond)

	sockPath := ptyd.SocketPath(socketDir, identity)

	// Connection A: open and get output
	connA, err := net.Dial("unix", sockPath)
	if err != nil {
		t.Fatalf("dial A: %v", err)
	}

	openReq := map[string]interface{}{
		"command": "open",
		"program": "/bin/sh",
		"args":    []string{"-c", "echo hi"},
		"cols":    80,
		"rows":    24,
	}
	openJSON, _ := json.Marshal(openReq)
	connA.Write(append(openJSON, '\n'))

	readerA := bufio.NewReader(connA)
	respLine, _ := readerA.ReadBytes('\n')
	var openResp map[string]interface{}
	json.Unmarshal(respLine, &openResp)

	sessionID, ok := openResp["sessionId"].(string)
	if !ok || sessionID == "" {
		t.Fatalf("no sessionId")
	}

	// Wait for output on connection A
	receivedOnA := false
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		connA.SetReadDeadline(time.Now().Add(100 * time.Millisecond))
		respLine, err := readerA.ReadBytes('\n')
		connA.SetReadDeadline(time.Time{})

		if err != nil {
			if strings.Contains(err.Error(), "deadline exceeded") {
				continue
			}
			break
		}

		var msg map[string]interface{}
		if err := json.Unmarshal(respLine, &msg); err != nil {
			continue
		}

		if cmd, ok := msg["command"].(string); ok && cmd == "output" {
			if outputB64, ok := msg["output"].(string); ok {
				if outputData, err := base64.StdEncoding.DecodeString(outputB64); err == nil {
					if strings.Contains(string(outputData), "hi") {
						receivedOnA = true
						break
					}
				}
			}
		}
	}

	if !receivedOnA {
		t.Fatal("connection A did not receive output")
	}

	// Disconnect A
	connA.Close()

	time.Sleep(100 * time.Millisecond)

	// Connection B: attach to the same session and replay from start
	connB, err := net.Dial("unix", sockPath)
	if err != nil {
		t.Fatalf("dial B: %v", err)
	}
	defer connB.Close()

	attachReq := map[string]interface{}{
		"command":   "attach",
		"sessionId": sessionID,
		"from":      0,
	}
	attachJSON, _ := json.Marshal(attachReq)
	connB.Write(append(attachJSON, '\n'))

	readerB := bufio.NewReader(connB)

	// Wait for replay on connection B
	receivedOnB := false
	deadline = time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		connB.SetReadDeadline(time.Now().Add(100 * time.Millisecond))
		respLine, err := readerB.ReadBytes('\n')
		connB.SetReadDeadline(time.Time{})

		if err != nil {
			if strings.Contains(err.Error(), "deadline exceeded") {
				continue
			}
			break
		}

		var msg map[string]interface{}
		if err := json.Unmarshal(respLine, &msg); err != nil {
			continue
		}

		if cmd, ok := msg["command"].(string); ok && cmd == "output" {
			if outputB64, ok := msg["output"].(string); ok {
				if outputData, err := base64.StdEncoding.DecodeString(outputB64); err == nil {
					if strings.Contains(string(outputData), "hi") {
						receivedOnB = true
						break
					}
				}
			}
		}
	}

	if !receivedOnB {
		t.Error("connection B did not receive replayed output")
	}
}

// TestOutputExit tests that exit message arrives when process exits.
func TestOutputExit(t *testing.T) {
	socketDir := "/tmp/sp-test-output-exit-" + fmt.Sprintf("%d", os.Getpid())
	os.RemoveAll(socketDir)
	defer os.RemoveAll(socketDir)

	identity := ptyd.DaemonIdentity{
		Protocol:  "test",
		BuildKind: "debug",
		PID:       os.Getpid(),
	}

	daemon := ptyd.NewDaemon(identity, socketDir, 10*time.Second)
	if err := daemon.Start(); err != nil {
		t.Fatalf("daemon start: %v", err)
	}
	defer daemon.Stop()

	time.Sleep(50 * time.Millisecond)

	sockPath := ptyd.SocketPath(socketDir, identity)
	conn, err := net.Dial("unix", sockPath)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()

	// Open a quick command that exits immediately
	openReq := map[string]interface{}{
		"command": "open",
		"program": "/bin/sh",
		"args":    []string{"-c", "echo bye"},
		"cols":    80,
		"rows":    24,
	}
	openJSON, _ := json.Marshal(openReq)
	conn.Write(append(openJSON, '\n'))

	reader := bufio.NewReader(conn)

	// Read open response
	respLine, _ := reader.ReadBytes('\n')
	var openResp map[string]interface{}
	json.Unmarshal(respLine, &openResp)

	sessionID, ok := openResp["sessionId"].(string)
	if !ok || sessionID == "" {
		t.Fatalf("no sessionId")
	}

	// Wait for exit message
	exitReceived := false
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		conn.SetReadDeadline(time.Now().Add(100 * time.Millisecond))
		respLine, err := reader.ReadBytes('\n')
		conn.SetReadDeadline(time.Time{})

		if err != nil {
			if strings.Contains(err.Error(), "deadline exceeded") {
				continue
			}
			break
		}

		var msg map[string]interface{}
		if err := json.Unmarshal(respLine, &msg); err != nil {
			continue
		}

		if cmd, ok := msg["command"].(string); ok && cmd == "exit" {
			if sid, ok := msg["sessionId"].(string); ok && sid == sessionID {
				exitReceived = true
				break
			}
		}
	}

	if !exitReceived {
		t.Error("did not receive exit message")
	}
}
