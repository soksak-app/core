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
		"args":    []string{"-c", "echo hi; sleep 5"},
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

	// 살아있는 세션 정리
	closeReq := map[string]interface{}{
		"command":   "close",
		"sessionId": sessionID,
	}
	closeJSON, _ := json.Marshal(closeReq)
	connB.Write(append(closeJSON, '\n'))
	readerB.ReadBytes('\n')
}

// TestSlowConsumerLosesNothing tests that a slow consumer that reads slowly
// still receives all output without loss, even if ring fills up.
func TestSlowConsumerLosesNothing(t *testing.T) {
	socketDir := "/tmp/sp-test-slow-consumer-" + fmt.Sprintf("%d", os.Getpid())
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

	// Open a connection that generates lots of output
	openReq := map[string]interface{}{
		"command": "open",
		"program": "/bin/sh",
		"args":    []string{"-c", "for i in $(seq 1 500); do echo line$i; sleep 0.001; done"},
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

	// Read output continuously with small delays to let ring fill up
	outputLines := make(map[int]bool)
	deadline := time.Now().Add(10 * time.Second)
	truncatedSeen := false

	for time.Now().Before(deadline) {
		conn.SetReadDeadline(time.Now().Add(50 * time.Millisecond))
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

		if cmd, ok := msg["command"].(string); ok && cmd == "output" {
			if outputB64, ok := msg["output"].(string); ok {
				if outputData, err := base64.StdEncoding.DecodeString(outputB64); err == nil {
					str := string(outputData)
					// Parse line number if it matches "line<N>\n"
					if strings.HasPrefix(str, "line") && strings.HasSuffix(str, "\n") {
						numStr := strings.TrimPrefix(strings.TrimSuffix(str, "\n"), "line")
						var lineNum int
						if _, err := fmt.Sscanf(numStr, "%d", &lineNum); err == nil {
							outputLines[lineNum] = true
						}
					}
				}
			}
			if trunc, ok := msg["truncated"].(bool); ok && trunc {
				truncatedSeen = true
			}
		} else if cmd, ok := msg["command"].(string); ok && cmd == "exit" {
			break
		}
	}

	// Verify: all lines 1-500 should be present
	// We shouldn't see truncated because the consumer never fell behind
	for i := 1; i <= 500; i++ {
		if !outputLines[i] {
			t.Errorf("line %d missing from output", i)
		}
	}

	if truncatedSeen {
		t.Error("unexpected truncated flag for slow consumer that kept up after delay")
	}
}

// TestConsumerBeyondRingIsTruncated tests that a consumer attaching to an old sequence
// (within ring range but before oldest available) receives truncated flag.
func TestConsumerBeyondRingIsTruncated(t *testing.T) {
	socketDir := "/tmp/sp-test-truncated-" + fmt.Sprintf("%d", os.Getpid())
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

	// Connection A: open and generate output (more than ring size to cause truncation)
	connA, err := net.Dial("unix", sockPath)
	if err != nil {
		t.Fatalf("dial A: %v", err)
	}

	// Ring entries are PTY read chunks, not lines. Drain the first consumer so the
	// child cannot block on its socket, and generate more than 10000 read chunks.
	openReq := map[string]interface{}{
		"command": "open",
		"program": "/bin/sh",
		"args":    []string{"-c", "yes x | head -c 50000000"},
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
	drainDone := make(chan struct{})
	go func() {
		defer close(drainDone)
		for {
			if _, err := readerA.ReadBytes('\n'); err != nil {
				return
			}
		}
	}()
	defer func() {
		connA.Close()
		<-drainDone
	}()

	// Wait for output to exceed ring capacity
	time.Sleep(3 * time.Second)

	// Connection B: attach at sequence 0 (oldest was discarded, so this should be truncated)
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
	respLine, _ = readerB.ReadBytes('\n')
	var attachResp map[string]interface{}
	json.Unmarshal(respLine, &attachResp)

	truncatedInResp := false
	if trunc, ok := attachResp["truncated"].(bool); ok && trunc {
		truncatedInResp = true
	}

	// Receive first output message and check for truncated flag
	foundTruncated := truncatedInResp
	deadline := time.Now().Add(2 * time.Second)

	for time.Now().Before(deadline) && !foundTruncated {
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
			if trunc, ok := msg["truncated"].(bool); ok && trunc {
				foundTruncated = true
				break
			}
		}
	}

	if !foundTruncated {
		t.Error("expected truncated flag for consumer attaching to old sequence")
	}
}

// TestAttachBeyondNextSequenceIsRejected tests that attaching with from > next is rejected.
func TestAttachBeyondNextSequenceIsRejected(t *testing.T) {
	socketDir := "/tmp/sp-test-attach-beyond-" + fmt.Sprintf("%d", os.Getpid())
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
		"args":    []string{"-c", "echo hi; sleep 2"},
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

	// Wait for at least one output message on A
	time.Sleep(500 * time.Millisecond)
	for {
		connA.SetReadDeadline(time.Now().Add(50 * time.Millisecond))
		respLine, err := readerA.ReadBytes('\n')
		connA.SetReadDeadline(time.Time{})
		if err != nil {
			break
		}
		var msg map[string]interface{}
		if json.Unmarshal(respLine, &msg) == nil {
			if cmd, ok := msg["command"].(string); ok && cmd == "output" {
				break
			}
		}
	}

	// Connection B: try to attach with from = 99999 (way beyond)
	connB, err := net.Dial("unix", sockPath)
	if err != nil {
		t.Fatalf("dial B: %v", err)
	}
	defer connB.Close()

	attachReq := map[string]interface{}{
		"command":   "attach",
		"sessionId": sessionID,
		"from":      99999,
	}
	attachJSON, _ := json.Marshal(attachReq)
	connB.Write(append(attachJSON, '\n'))

	readerB := bufio.NewReader(connB)
	respLine, _ = readerB.ReadBytes('\n')
	var attachResp map[string]interface{}
	json.Unmarshal(respLine, &attachResp)

	// Should have an error response with "invalidParams"
	if errMsg, ok := attachResp["error"].(string); ok {
		if !strings.Contains(errMsg, "invalidParams") {
			t.Errorf("expected invalidParams error, got: %s", errMsg)
		}
	} else {
		t.Error("expected error response for attach beyond next sequence, but got success")
	}
}

// TestAttachReplayHasNoDuplicates tests that replay has no duplicates and attach response precedes output.
func TestAttachReplayHasNoDuplicates(t *testing.T) {
	socketDir := "/tmp/sp-test-no-dup-" + fmt.Sprintf("%d", os.Getpid())
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

	// Connection A: open and generate output
	connA, err := net.Dial("unix", sockPath)
	if err != nil {
		t.Fatalf("dial A: %v", err)
	}
	defer connA.Close()

	openReq := map[string]interface{}{
		"command": "open",
		"program": "/bin/sh",
		"args":    []string{"-c", "for i in $(seq 1 200); do echo line$i; done; exec cat"},
		"cols":    80,
		"rows":    24,
	}
	openJSON, err := json.Marshal(openReq)
	if err != nil {
		t.Fatalf("marshal open request: %v", err)
	}
	connA.Write(append(openJSON, '\n'))

	readerA := bufio.NewReader(connA)
	respLine, _ := readerA.ReadBytes('\n')
	var openResp map[string]interface{}
	if err := json.Unmarshal(respLine, &openResp); err != nil {
		t.Fatalf("unmarshal open response: %v", err)
	}

	sessionID, ok := openResp["sessionId"].(string)
	if !ok || sessionID == "" {
		t.Fatalf("no sessionId from A")
	}

	// Read output on A until we see line200 (content-based wait, 10s total deadline)
	outputContent := ""
	deadline := time.Now().Add(10 * time.Second)
	maxSeqA := int64(-1)
	sequencesA := make([]int64, 0)
	foundLine200 := false

	for time.Now().Before(deadline) && !foundLine200 {
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
			t.Fatalf("unmarshal output message from A: %v", err)
		}

		if cmd, ok := msg["command"].(string); ok && cmd == "output" {
			if outputB64, ok := msg["output"].(string); ok {
				outputData, err := base64.StdEncoding.DecodeString(outputB64)
				if err != nil {
					t.Fatalf("decode base64 output: %v", err)
				}
				outputContent += string(outputData)
				if strings.Contains(outputContent, "line200") {
					foundLine200 = true
				}
			}
			if seq, ok := msg["sequence"].(float64); ok {
				seqInt := int64(seq)
				sequencesA = append(sequencesA, seqInt)
				if seqInt > maxSeqA {
					maxSeqA = seqInt
				}
			}
		}
	}

	if !foundLine200 {
		t.Fatalf("did not receive line200 from connection A within 10 seconds (got %d output messages, max seq %d)", len(sequencesA), maxSeqA)
	}
	// Log sequences from A for debugging
	if len(sequencesA) > 0 {
		t.Logf("Connection A: first seq=%d, last seq=%d, count=%d", sequencesA[0], sequencesA[len(sequencesA)-1], len(sequencesA))
	}
	t.Logf("Connection A received %d output messages, max sequence %d", len(sequencesA), maxSeqA)

	// Connection B: attach from sequence 0 to replay
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
	attachJSON, err := json.Marshal(attachReq)
	if err != nil {
		t.Fatalf("marshal attach request: %v", err)
	}
	connB.Write(append(attachJSON, '\n'))

	readerB := bufio.NewReader(connB)

	// Read first message from B: must be attach response with no error
	respLine, err = readerB.ReadBytes('\n')
	if err != nil {
		t.Fatalf("read first message from B: %v", err)
	}
	var attachResp map[string]interface{}
	if err := json.Unmarshal(respLine, &attachResp); err != nil {
		t.Fatalf("unmarshal first message from B: %v", err)
	}
	if cmd, ok := attachResp["command"].(string); !ok || cmd != "attach" {
		t.Fatalf("first message from B is not attach response: %v", attachResp)
	}
	if errMsg, ok := attachResp["error"].(string); ok && errMsg != "" {
		t.Fatalf("attach response has error: %s", errMsg)
	}

	// Collect all sequences from output messages
	sequences := make([]int64, 0)
	deadlineB := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadlineB) {
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
			t.Fatalf("unmarshal output message from B: %v", err)
		}

		if cmd, ok := msg["command"].(string); ok && cmd == "output" {
			if seq, ok := msg["sequence"].(float64); ok {
				sequences = append(sequences, int64(seq))
				// Stop when we reach maxSeqA
				if int64(seq) >= maxSeqA {
					break
				}
			}
		} else if cmd, ok := msg["command"].(string); ok && cmd == "exit" {
			break
		}
	}

	// Verify: sequences should cover 0..maxSeqA with no gaps or duplicates
	if len(sequences) == 0 {
		t.Error("no sequences received")
	} else {
		t.Logf("maxSeqA=%d, received %d sequences from B, first=%d, last=%d", maxSeqA, len(sequences), sequences[0], sequences[len(sequences)-1])

		// Check ring size: 200 lines fit in default ring (10000), so first sequence must be 0
		if sequences[0] != 0 {
			t.Errorf("first sequence is %d, expected 0 (200 lines should fit in ring of 10000)", sequences[0])
		}

		// Verify we got exactly maxSeqA + 1 sequences
		expectedCount := maxSeqA + 1
		if int64(len(sequences)) != expectedCount {
			t.Errorf("expected %d sequences (0..%d), got %d", expectedCount, maxSeqA, len(sequences))
		}

		// Verify sequences are 0, 1, 2, ... with no gaps or duplicates
		for i, seq := range sequences {
			if seq != int64(i) {
				t.Errorf("sequence index %d: expected %d, got %d (gap or duplicate detected)", i, i, seq)
			}
		}

		// Verify last sequence is maxSeqA
		if int64(sequences[len(sequences)-1]) != maxSeqA {
			t.Errorf("last sequence is %d, expected %d", sequences[len(sequences)-1], maxSeqA)
		}
	}
}

// TestFirstOutputCarriesSequenceZero tests that the first output message has sequence 0 in raw JSON.
func TestFirstOutputCarriesSequenceZero(t *testing.T) {
	socketDir := "/tmp/sp-test-first-seq-zero-" + fmt.Sprintf("%d", os.Getpid())
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

	// Wait for output message and check raw JSON for "sequence":0
	foundSequenceZero := false
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
			// Check raw JSON for "sequence":0
			if strings.Contains(string(respLine), `"sequence":0`) {
				foundSequenceZero = true
				break
			}
			// Also accept sequence as float in JSON
			if seq, ok := msg["sequence"].(float64); ok && seq == 0 {
				foundSequenceZero = true
				break
			}
		} else if cmd == "exit" {
			break
		}
	}

	if !foundSequenceZero {
		t.Error("first output message does not have sequence 0")
	}
}

// TestResizeIsForwardedAsResize tests that resize requests result in resize command messages.
func TestResizeIsForwardedAsResize(t *testing.T) {
	socketDir := "/tmp/sp-test-resize-forward-" + fmt.Sprintf("%d", os.Getpid())
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

	// Connection A: open a session
	connA, err := net.Dial("unix", sockPath)
	if err != nil {
		t.Fatalf("dial A: %v", err)
	}
	defer connA.Close()

	openReq := map[string]interface{}{
		"command": "open",
		"program": "/bin/cat",
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

	time.Sleep(100 * time.Millisecond)

	// Connection B: attach to the same session to see resize messages
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
	respLine, _ = readerB.ReadBytes('\n')
	var attachResp map[string]interface{}
	json.Unmarshal(respLine, &attachResp)

	// Connection A: send resize request
	time.Sleep(100 * time.Millisecond)
	resizeReq := map[string]interface{}{
		"command":   "resize",
		"sessionId": sessionID,
		"cols":      120,
		"rows":      40,
	}
	resizeJSON, _ := json.Marshal(resizeReq)
	connA.Write(append(resizeJSON, '\n'))

	// Read the resize response from A
	respLine, _ = readerA.ReadBytes('\n')
	var resizeResp map[string]interface{}
	json.Unmarshal(respLine, &resizeResp)

	// Connection B: wait for resize message (command:"resize", cols:120, rows:40)
	foundResize := false
	deadline := time.Now().Add(2 * time.Second)
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

		if cmd, ok := msg["command"].(string); ok && cmd == "resized" {
			cols, ok1 := msg["cols"].(float64)
			rows, ok2 := msg["rows"].(float64)
			if ok1 && ok2 && int(cols) == 120 && int(rows) == 40 {
				foundResize = true
				break
			}
		}
	}

	if !foundResize {
		t.Error("did not receive resize message with cols:120 and rows:40")
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

// TestErrorResponseCarriesCommand tests that error responses carry the command field.
func TestErrorResponseCarriesCommand(t *testing.T) {
	socketDir := "/tmp/sp-test-error-cmd-" + fmt.Sprintf("%d", os.Getpid())
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

	reader := bufio.NewReader(conn)

	// Send write request with invalid sessionId (should fail)
	writeReq := map[string]interface{}{
		"command":   "write",
		"sessionId": "nonexistent-session",
		"data":      base64.StdEncoding.EncodeToString([]byte("test")),
	}
	writeJSON, _ := json.Marshal(writeReq)
	conn.Write(append(writeJSON, '\n'))

	// Read error response
	respLine, _ := reader.ReadBytes('\n')
	var writeResp map[string]interface{}
	json.Unmarshal(respLine, &writeResp)

	// Verify: error response should have command:"write"
	cmd, ok := writeResp["command"].(string)
	if !ok || cmd != "write" {
		t.Errorf("error response missing command:write; got: %v", writeResp)
	}

	errMsg, ok := writeResp["error"].(string)
	if !ok || errMsg == "" {
		t.Errorf("error response missing error field; got: %v", writeResp)
	}
}
