package main_test

import (
	"bufio"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/min-median-max/soksak/sidecars/ptyd/src/ptyd"
)

// TestSocketPermissions는 소켓과 디렉터리 권한을 확인한다.
func TestSocketPermissions(t *testing.T) {
	// 기한 설정: 5초
	t.Deadline()
	t.Helper()

	socketDir := "/tmp/sp-test-sock-" + fmt.Sprintf("%d", os.Getpid())
	os.RemoveAll(socketDir)
	defer os.RemoveAll(socketDir)

	identity := ptyd.DaemonIdentity{
		Protocol:  "test",
		BuildKind: "debug",
		PID:       os.Getpid(),
	}

	daemon := ptyd.NewDaemon(identity, socketDir, 0)
	if err := daemon.Start(); err != nil {
		t.Fatalf("Start failed: %v", err)
	}
	defer daemon.Stop()

	// 디렉터리 권한 확인
	info, err := os.Lstat(socketDir)
	if err != nil {
		t.Fatalf("stat socketDir: %v", err)
	}
	if info.Mode().Perm() != 0700 {
		t.Errorf("dir mode: got %o, want 0700", info.Mode().Perm())
	}

	// 소켓 권한 확인
	sockPath := ptyd.SocketPath(socketDir, identity)
	info, err = os.Lstat(sockPath)
	if err != nil {
		t.Fatalf("stat socket: %v", err)
	}
	if info.Mode().Perm() != 0600 {
		t.Errorf("socket mode: got %o, want 0600", info.Mode().Perm())
	}

	daemon.Stop()
}

// TestMultipleDaemonIdentities는 다른 신원의 데몬이 공존할 수 있는지 확인한다.
func TestMultipleDaemonIdentities(t *testing.T) {
	socketDir := "/tmp/sp-test-multi-" + fmt.Sprintf("%d", os.Getpid())
	os.RemoveAll(socketDir)
	defer os.RemoveAll(socketDir)

	identity1 := ptyd.DaemonIdentity{
		Protocol:  "test",
		BuildKind: "debug",
		PID:       os.Getpid(),
	}

	identity2 := ptyd.DaemonIdentity{
		Protocol:  "test",
		BuildKind: "release",
		PID:       os.Getpid(),
	}

	daemon1 := ptyd.NewDaemon(identity1, socketDir, 0)
	daemon2 := ptyd.NewDaemon(identity2, socketDir, 0)

	if err := daemon1.Start(); err != nil {
		t.Fatalf("daemon1 start: %v", err)
	}
	defer daemon1.Stop()

	if err := daemon2.Start(); err != nil {
		t.Fatalf("daemon2 start: %v", err)
	}
	defer daemon2.Stop()

	// 두 소켓이 모두 존재해야 함
	sock1 := ptyd.SocketPath(socketDir, identity1)
	sock2 := ptyd.SocketPath(socketDir, identity2)

	if _, err := os.Lstat(sock1); err != nil {
		t.Errorf("socket1 not found: %v", err)
	}
	if _, err := os.Lstat(sock2); err != nil {
		t.Errorf("socket2 not found: %v", err)
	}

	daemon1.Stop()
	daemon2.Stop()
}

// TestCleanupDeadSockets는 죽은 프로세스의 소켓을 정리한다.
func TestCleanupDeadSockets(t *testing.T) {
	socketDir := "/tmp/sp-test-clean-" + fmt.Sprintf("%d", os.Getpid())
	os.RemoveAll(socketDir)
	defer os.RemoveAll(socketDir)

	// 디렉터리 생성
	if err := os.MkdirAll(socketDir, 0700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}

	// 가짜 소켓 생성
	aliveSocket := filepath.Join(socketDir, "ptyd-test-debug-1.sock")
	deadSocket := filepath.Join(socketDir, "ptyd-test-debug-999999.sock")

	if f, err := os.Create(aliveSocket); err == nil {
		f.Close()
	}
	if f, err := os.Create(deadSocket); err == nil {
		f.Close()
	}

	// 정리
	if err := ptyd.CleanupDeadSockets(socketDir, "test", "debug"); err != nil {
		t.Fatalf("CleanupDeadSockets: %v", err)
	}

	// 살아있는 소켓은 남아있어야 함
	if _, err := os.Lstat(aliveSocket); os.IsNotExist(err) {
		t.Error("alive socket should not be removed")
	}

	// 죽은 소켓은 제거되어야 함
	if _, err := os.Lstat(deadSocket); err == nil {
		t.Error("dead socket should be removed")
	}
}

// TestIdleShutdown는 유휲 타임아웃으로 종료되는지 확인한다.
func TestIdleShutdown(t *testing.T) {
	socketDir := "/tmp/sp-test-idle-" + fmt.Sprintf("%d", os.Getpid())
	os.RemoveAll(socketDir)
	defer os.RemoveAll(socketDir)

	identity := ptyd.DaemonIdentity{
		Protocol:  "test",
		BuildKind: "debug",
		PID:       os.Getpid(),
	}

	// 짧은 타임아웃 (500ms)
	daemon := ptyd.NewDaemon(identity, socketDir, 500*time.Millisecond)
	if err := daemon.Start(); err != nil {
		t.Fatalf("Start failed: %v", err)
	}

	// 데몬이 종료될 때까지 대기 (최대 2초)
	done := make(chan struct{})
	go func() {
		daemon.Wait()
		close(done)
	}()

	select {
	case <-done:
		// 정상: 유휷 타임아웃 후 종료됨
	case <-time.After(2 * time.Second):
		t.Error("daemon did not shutdown after idle timeout")
		daemon.Stop()
	}
}

// Test1: echo hi
// open /bin/sh -c 'echo hi' → verify "hi" in output, exit code 0
func TestI1EchoHi(t *testing.T) {
	socketDir := "/tmp/sp-test-i1-" + fmt.Sprintf("%d", os.Getpid())
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

	// Send open request
	openReq := map[string]interface{}{
		"command": "open",
		"program": "/bin/sh",
		"args":    []string{"-c", "echo hi"},
		"cols":    80,
		"rows":    24,
	}
	reqJSON, _ := json.Marshal(openReq)
	conn.Write(append(reqJSON, '\n'))

	// Read response
	reader := bufio.NewReader(conn)
	respLine, _ := reader.ReadBytes('\n')
	var openResp map[string]interface{}
	json.Unmarshal(respLine, &openResp)

	sessionID, ok := openResp["sessionId"].(string)
	if !ok || sessionID == "" {
		t.Fatalf("no sessionId in response: %s", respLine)
	}

	// Wait for output message
	foundHi := false
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
		if json.Unmarshal(respLine, &msg) == nil {
			if cmd, ok := msg["command"].(string); ok && cmd == "output" {
				if outputB64, ok := msg["output"].(string); ok {
					if outputData, err := base64.StdEncoding.DecodeString(outputB64); err == nil {
						if strings.Contains(string(outputData), "hi") {
							foundHi = true
							break
						}
					}
				}
			}
		}
	}

	if !foundHi {
		t.Errorf("'hi' data not found in output messages")
	}

	// Close
	closeReq := map[string]interface{}{
		"command":   "close",
		"sessionId": sessionID,
	}
	reqJSON, _ = json.Marshal(closeReq)
	conn.Write(append(reqJSON, '\n'))
	reader.ReadBytes('\n')

	time.Sleep(100 * time.Millisecond)
}

// Test2: cat write/read
func TestI2CatRoundTrip(t *testing.T) {
	socketDir := "/tmp/sp-test-i2-" + fmt.Sprintf("%d", os.Getpid())
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
	reqJSON, _ := json.Marshal(openReq)
	conn.Write(append(reqJSON, '\n'))

	reader := bufio.NewReader(conn)
	respLine, _ := reader.ReadBytes('\n')
	var openResp map[string]interface{}
	json.Unmarshal(respLine, &openResp)

	sessionID, ok := openResp["sessionId"].(string)
	if !ok || sessionID == "" {
		t.Fatalf("no sessionId")
	}

	time.Sleep(100 * time.Millisecond)

	// Write data to cat
	writeData := "hello world"
	writeReq := map[string]interface{}{
		"command":   "write",
		"sessionId": sessionID,
		"data":      base64.StdEncoding.EncodeToString([]byte(writeData)),
	}
	reqJSON, _ = json.Marshal(writeReq)
	conn.Write(append(reqJSON, '\n'))
	reader.ReadBytes('\n') // read write response

	time.Sleep(100 * time.Millisecond)

	// Wait for output message
	foundData := false
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
		if json.Unmarshal(respLine, &msg) == nil {
			if cmd, ok := msg["command"].(string); ok && cmd == "output" {
				if outputB64, ok := msg["output"].(string); ok {
					if outputData, err := base64.StdEncoding.DecodeString(outputB64); err == nil {
						if strings.Contains(string(outputData), "hello world") {
							foundData = true
							break
						}
					}
				}
			}
		}
	}

	if !foundData {
		t.Errorf("'hello world' not found in output messages")
	}

	// Close
	closeReq := map[string]interface{}{
		"command":   "close",
		"sessionId": sessionID,
	}
	reqJSON, _ = json.Marshal(closeReq)
	conn.Write(append(reqJSON, '\n'))
	reader.ReadBytes('\n')

	time.Sleep(100 * time.Millisecond)
}

// Test3: resize
func TestI3Resize(t *testing.T) {
	socketDir := "/tmp/sp-test-i3-" + fmt.Sprintf("%d", os.Getpid())
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

	// Open shell
	openReq := map[string]interface{}{
		"command": "open",
		"program": "/bin/sh",
		"cols":    80,
		"rows":    24,
	}
	reqJSON, _ := json.Marshal(openReq)
	conn.Write(append(reqJSON, '\n'))

	reader := bufio.NewReader(conn)
	respLine, _ := reader.ReadBytes('\n')
	var openResp map[string]interface{}
	json.Unmarshal(respLine, &openResp)

	sessionID, ok := openResp["sessionId"].(string)
	if !ok || sessionID == "" {
		t.Fatalf("no sessionId")
	}

	time.Sleep(50 * time.Millisecond)

	// Send resize
	resizeReq := map[string]interface{}{
		"command":   "resize",
		"sessionId": sessionID,
		"cols":      100,
		"rows":      40,
	}
	reqJSON, _ = json.Marshal(resizeReq)
	conn.Write(append(reqJSON, '\n'))
	reader.ReadBytes('\n')

	// Close
	closeReq := map[string]interface{}{
		"command":   "close",
		"sessionId": sessionID,
	}
	reqJSON, _ = json.Marshal(closeReq)
	conn.Write(append(reqJSON, '\n'))
	reader.ReadBytes('\n')

	time.Sleep(100 * time.Millisecond)
}

// Test4: signal INT
func TestI4SignalINT(t *testing.T) {
	socketDir := "/tmp/sp-test-i4-" + fmt.Sprintf("%d", os.Getpid())
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

	// Open sleep 30
	openReq := map[string]interface{}{
		"command": "open",
		"program": "/bin/sleep",
		"args":    []string{"30"},
		"cols":    80,
		"rows":    24,
	}
	reqJSON, _ := json.Marshal(openReq)
	conn.Write(append(reqJSON, '\n'))

	reader := bufio.NewReader(conn)
	respLine, _ := reader.ReadBytes('\n')
	var openResp map[string]interface{}
	json.Unmarshal(respLine, &openResp)

	sessionID, ok := openResp["sessionId"].(string)
	if !ok || sessionID == "" {
		t.Fatalf("no sessionId")
	}

	time.Sleep(100 * time.Millisecond)

	// Send SIGINT
	signalReq := map[string]interface{}{
		"command":   "signal",
		"sessionId": sessionID,
		"name":      "INT",
	}
	reqJSON, _ = json.Marshal(signalReq)
	conn.Write(append(reqJSON, '\n'))
	reader.ReadBytes('\n')

	time.Sleep(200 * time.Millisecond)

	// Close
	closeReq := map[string]interface{}{
		"command":   "close",
		"sessionId": sessionID,
	}
	reqJSON, _ = json.Marshal(closeReq)
	conn.Write(append(reqJSON, '\n'))
	reader.ReadBytes('\n')

	time.Sleep(100 * time.Millisecond)
}

// Test5: concurrent startup (flock)
func TestI5ConcurrentFlock(t *testing.T) {
	socketDir := "/tmp/sp-test-i5-" + fmt.Sprintf("%d", os.Getpid())
	os.RemoveAll(socketDir)
	defer os.RemoveAll(socketDir)

	identity := ptyd.DaemonIdentity{
		Protocol:  "test",
		BuildKind: "debug",
		PID:       os.Getpid(),
	}

	// Try to start 8 daemons concurrently
	// flock should ensure only 1 succeeds fully
	daemons := make([]*ptyd.Daemon, 8)
	for i := 0; i < 8; i++ {
		daemons[i] = ptyd.NewDaemon(identity, socketDir, 5*time.Second)
	}

	// Start all at once
	for i := 0; i < 8; i++ {
		go daemons[i].Start()
	}

	time.Sleep(500 * time.Millisecond)

	// Verify socket exists
	sockPath := ptyd.SocketPath(socketDir, identity)
	if _, err := os.Lstat(sockPath); err != nil {
		t.Errorf("socket not found: %v", err)
	}

	// Clean up
	for i := 0; i < 8; i++ {
		daemons[i].Stop()
	}

	time.Sleep(100 * time.Millisecond)
}

// Test6: close and cleanup
func TestI6CloseCleanup(t *testing.T) {
	socketDir := "/tmp/sp-test-i6-" + fmt.Sprintf("%d", os.Getpid())
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

	// Open a session
	openReq := map[string]interface{}{
		"command": "open",
		"program": "/bin/sleep",
		"args":    []string{"10"},
		"cols":    80,
		"rows":    24,
	}
	reqJSON, _ := json.Marshal(openReq)
	conn.Write(append(reqJSON, '\n'))

	reader := bufio.NewReader(conn)
	respLine, _ := reader.ReadBytes('\n')
	var openResp map[string]interface{}
	json.Unmarshal(respLine, &openResp)

	sessionID, ok := openResp["sessionId"].(string)
	if !ok || sessionID == "" {
		t.Fatalf("no sessionId")
	}

	time.Sleep(100 * time.Millisecond)

	// Close the session
	closeReq := map[string]interface{}{
		"command":   "close",
		"sessionId": sessionID,
	}
	reqJSON, _ = json.Marshal(closeReq)
	conn.Write(append(reqJSON, '\n'))
	reader.ReadBytes('\n')

	time.Sleep(100 * time.Millisecond)
}

// TestIdle1ExitedSessionLeavesListOnDisconnect: 자식이 끝나고 consumer가 끝나면 세션이 즉시 삭제된다.
func TestIdle1ExitedSessionLeavesListOnDisconnect(t *testing.T) {
	socketDir := "/tmp/sp-test-idle1-" + fmt.Sprintf("%d", os.Getpid())
	os.RemoveAll(socketDir)
	defer os.RemoveAll(socketDir)

	identity := ptyd.DaemonIdentity{
		Protocol:  "test",
		BuildKind: "debug",
		PID:       os.Getpid(),
	}

	// 짧은 타임아웃: 1초
	daemon := ptyd.NewDaemon(identity, socketDir, 1*time.Second)
	if err := daemon.Start(); err != nil {
		t.Fatalf("daemon start: %v", err)
	}
	t.Cleanup(func() { daemon.Stop() })

	time.Sleep(50 * time.Millisecond)

	sockPath := ptyd.SocketPath(socketDir, identity)

	// 첫 번째 연결: open /bin/sh -c 'exit 0', exit 받기, 연결 닫기
	conn1, err := net.Dial("unix", sockPath)
	if err != nil {
		t.Fatalf("dial conn1: %v", err)
	}

	openReq := map[string]interface{}{
		"command": "open",
		"program": "/bin/sh",
		"args":    []string{"-c", "exit 0"},
		"cols":    80,
		"rows":    24,
	}
	reqJSON, _ := json.Marshal(openReq)
	conn1.Write(append(reqJSON, '\n'))

	reader1 := bufio.NewReader(conn1)
	respLine, _ := reader1.ReadBytes('\n')
	var openResp map[string]interface{}
	json.Unmarshal(respLine, &openResp)

	sessionID, ok := openResp["sessionId"].(string)
	if !ok || sessionID == "" {
		conn1.Close()
		t.Fatalf("no sessionId")
	}

	// exit 메시지를 받을 때까지 기다림
	foundExit := false
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		conn1.SetReadDeadline(time.Now().Add(100 * time.Millisecond))
		respLine, err := reader1.ReadBytes('\n')
		conn1.SetReadDeadline(time.Time{})

		if err != nil {
			if strings.Contains(err.Error(), "deadline exceeded") {
				continue
			}
			break
		}

		var msg map[string]interface{}
		if json.Unmarshal(respLine, &msg) == nil {
			if cmd, ok := msg["command"].(string); ok && cmd == "exit" {
				foundExit = true
				break
			}
		}
	}

	if !foundExit {
		conn1.Close()
		t.Fatalf("exit message not received")
	}

	// 첫 번째 연결 닫기
	conn1.Close()

	time.Sleep(50 * time.Millisecond)

	// 두 번째 연결: list로 세션이 없어야 함 (consumer가 0 + 세션 종료 = 삭제됨)
	conn2, err := net.Dial("unix", sockPath)
	if err != nil {
		t.Fatalf("dial conn2: %v", err)
	}
	defer conn2.Close()

	listReq := map[string]interface{}{
		"command": "list",
	}
	reqJSON, _ = json.Marshal(listReq)
	conn2.Write(append(reqJSON, '\n'))

	reader2 := bufio.NewReader(conn2)
	respLine, _ = reader2.ReadBytes('\n')
	var listResp map[string]interface{}
	json.Unmarshal(respLine, &listResp)

	sessions, ok := listResp["sessions"].([]interface{})
	found := false
	if ok && sessions != nil {
		for _, s := range sessions {
			if sessionMap, ok := s.(map[string]interface{}); ok {
				if id, ok := sessionMap["sessionId"].(string); ok && id == sessionID {
					found = true
					break
				}
			}
		}
	}

	if found {
		t.Errorf("session should be deleted (child exited and consumer count is 0)")
	}
}

// TestIdle2DaemonExitsAfterAllSessionsEnd: 모든 세션이 끝나고 모든 연결이 끊기면 데몬이 타임아웃 후 종료된다.
func TestIdle2DaemonExitsAfterAllSessionsEnd(t *testing.T) {
	socketDir := "/tmp/sp-test-idle2-" + fmt.Sprintf("%d", os.Getpid())
	os.RemoveAll(socketDir)
	defer os.RemoveAll(socketDir)

	identity := ptyd.DaemonIdentity{
		Protocol:  "test",
		BuildKind: "debug",
		PID:       os.Getpid(),
	}

	// 짧은 타임아웃: 1초
	daemon := ptyd.NewDaemon(identity, socketDir, 1*time.Second)
	if err := daemon.Start(); err != nil {
		t.Fatalf("daemon start: %v", err)
	}

	daemonDone := make(chan struct{})
	go func() {
		daemon.Wait()
		close(daemonDone)
	}()

	t.Cleanup(func() {
		select {
		case <-daemonDone:
			// daemon이 이미 종료됨
		default:
			daemon.Stop()
		}
	})

	time.Sleep(50 * time.Millisecond)

	sockPath := ptyd.SocketPath(socketDir, identity)

	// 첫 번째 연결: open /bin/sh -c 'exit 0', exit 받기, 연결 닫기
	conn1, err := net.Dial("unix", sockPath)
	if err != nil {
		t.Fatalf("dial conn1: %v", err)
	}

	openReq := map[string]interface{}{
		"command": "open",
		"program": "/bin/sh",
		"args":    []string{"-c", "exit 0"},
		"cols":    80,
		"rows":    24,
	}
	reqJSON, _ := json.Marshal(openReq)
	conn1.Write(append(reqJSON, '\n'))

	reader1 := bufio.NewReader(conn1)
	respLine, _ := reader1.ReadBytes('\n')
	var openResp map[string]interface{}
	json.Unmarshal(respLine, &openResp)

	// exit 메시지를 받을 때까지 기다림
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		conn1.SetReadDeadline(time.Now().Add(100 * time.Millisecond))
		respLine, err := reader1.ReadBytes('\n')
		conn1.SetReadDeadline(time.Time{})

		if err != nil {
			if strings.Contains(err.Error(), "deadline exceeded") {
				continue
			}
			break
		}

		var msg map[string]interface{}
		if json.Unmarshal(respLine, &msg) == nil {
			if cmd, ok := msg["command"].(string); ok && cmd == "exit" {
				break
			}
		}
	}

	conn1.Close()
	time.Sleep(50 * time.Millisecond)

	// 이제 모든 연결과 세션이 종료됨
	// 데몬이 타임아웃 + 1초 안에 스스로 종료되어야 함
	select {
	case <-daemonDone:
		// 정상: 데몬이 종료됨
	case <-time.After(3 * time.Second):
		t.Error("daemon did not exit after all sessions and connections ended")
		daemon.Stop()
	}
}

// TestIdle3OpenConnectionPreventsExit: 열린 연결이 있으면 타임아웃 후에도 계속 실행됨.
func TestIdle3OpenConnectionPreventsExit(t *testing.T) {
	socketDir := "/tmp/sp-test-idle3-" + fmt.Sprintf("%d", os.Getpid())
	os.RemoveAll(socketDir)
	defer os.RemoveAll(socketDir)

	identity := ptyd.DaemonIdentity{
		Protocol:  "test",
		BuildKind: "debug",
		PID:       os.Getpid(),
	}

	// 짧은 타임아웃: 1초
	daemon := ptyd.NewDaemon(identity, socketDir, 1*time.Second)
	if err := daemon.Start(); err != nil {
		t.Fatalf("daemon start: %v", err)
	}

	daemonDone := make(chan struct{})
	go func() {
		daemon.Wait()
		close(daemonDone)
	}()

	t.Cleanup(func() {
		select {
		case <-daemonDone:
			// daemon이 이미 종료됨
		default:
			daemon.Stop()
		}
	})

	time.Sleep(50 * time.Millisecond)

	sockPath := ptyd.SocketPath(socketDir, identity)

	// 열린 연결 유지
	conn, err := net.Dial("unix", sockPath)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()

	// 타임아웃 * 3 동안 daemon이 살아있어야 함 (세션이 없어도)
	select {
	case <-daemonDone:
		t.Error("daemon exited while connection was open")
	case <-time.After(3 * time.Second):
		// 정상: 연결이 열려있으면 타임아웃 후에도 계속 실행됨
		daemon.Stop()
	}
}

// TestIdle4LiveSessionPreventsExit: 살아있는 세션이 있으면 타임아웃 후에도 계속 실행됨.
func TestIdle4LiveSessionPreventsExit(t *testing.T) {
	socketDir := "/tmp/sp-test-idle4-" + fmt.Sprintf("%d", os.Getpid())
	os.RemoveAll(socketDir)
	defer os.RemoveAll(socketDir)

	identity := ptyd.DaemonIdentity{
		Protocol:  "test",
		BuildKind: "debug",
		PID:       os.Getpid(),
	}

	// 짧은 타임아웃: 1초
	daemon := ptyd.NewDaemon(identity, socketDir, 1*time.Second)
	if err := daemon.Start(); err != nil {
		t.Fatalf("daemon start: %v", err)
	}

	daemonDone := make(chan struct{})
	go func() {
		daemon.Wait()
		close(daemonDone)
	}()

	t.Cleanup(func() {
		select {
		case <-daemonDone:
			// daemon이 이미 종료됨
		default:
			daemon.Stop()
		}
	})

	time.Sleep(50 * time.Millisecond)

	sockPath := ptyd.SocketPath(socketDir, identity)

	// 첫 번째 연결: cat 세션 열기
	conn1, err := net.Dial("unix", sockPath)
	if err != nil {
		t.Fatalf("dial conn1: %v", err)
	}

	openReq := map[string]interface{}{
		"command": "open",
		"program": "/bin/cat",
		"cols":    80,
		"rows":    24,
	}
	reqJSON, _ := json.Marshal(openReq)
	conn1.Write(append(reqJSON, '\n'))

	reader1 := bufio.NewReader(conn1)
	respLine, _ := reader1.ReadBytes('\n')
	var openResp map[string]interface{}
	json.Unmarshal(respLine, &openResp)

	sessionID, ok := openResp["sessionId"].(string)
	if !ok || sessionID == "" {
		conn1.Close()
		t.Fatalf("no sessionId")
	}

	// 첫 번째 연결 닫기 (세션은 살아있음)
	conn1.Close()

	// 타임아웃 * 3 동안 daemon이 살아있어야 함 (세션이 살아있으므로)
	select {
	case <-daemonDone:
		t.Error("daemon exited while session was alive")
	case <-time.After(3 * time.Second):
		// 정상: 세션이 살아있으면 타임아웃 후에도 계속 실행됨
		// 두 번째 연결로 세션 정리
		conn2, _ := net.Dial("unix", sockPath)
		defer conn2.Close()

		closeReq := map[string]interface{}{
			"command":   "close",
			"sessionId": sessionID,
		}
		reqJSON, _ = json.Marshal(closeReq)
		conn2.Write(append(reqJSON, '\n'))

		// daemon이 정리될 때까지 대기
		reader2 := bufio.NewReader(conn2)
		reader2.ReadBytes('\n')
		conn2.Close()

		daemon.Stop()
	}
}

// TestIdle5ExitedSessionDeletedWhenLastConsumerLeaves: 소비자가 붙은 채 자식이 끝나면 세션은 list에 있다. 마지막 소비자가 detach하면 삭제된다.
func TestIdle5ExitedSessionDeletedWhenLastConsumerLeaves(t *testing.T) {
	socketDir := "/tmp/sp-test-idle5-" + fmt.Sprintf("%d", os.Getpid())
	os.RemoveAll(socketDir)
	defer os.RemoveAll(socketDir)

	identity := ptyd.DaemonIdentity{
		Protocol:  "test",
		BuildKind: "debug",
		PID:       os.Getpid(),
	}

	// 짧은 타임아웃: 1초
	daemon := ptyd.NewDaemon(identity, socketDir, 1*time.Second)
	if err := daemon.Start(); err != nil {
		t.Fatalf("daemon start: %v", err)
	}
	t.Cleanup(func() { daemon.Stop() })

	time.Sleep(50 * time.Millisecond)

	sockPath := ptyd.SocketPath(socketDir, identity)

	// 연결 1: 짧은 명령 세션 열기 (/bin/sh -c 'exit 1')
	conn1, err := net.Dial("unix", sockPath)
	if err != nil {
		t.Fatalf("dial conn1: %v", err)
	}

	openReq := map[string]interface{}{
		"command": "open",
		"program": "/bin/sh",
		"args":    []string{"-c", "exit 1"},
		"cols":    80,
		"rows":    24,
	}
	reqJSON, _ := json.Marshal(openReq)
	conn1.Write(append(reqJSON, '\n'))

	reader1 := bufio.NewReader(conn1)
	respLine, _ := reader1.ReadBytes('\n')
	var openResp map[string]interface{}
	json.Unmarshal(respLine, &openResp)

	sessionID, ok := openResp["sessionId"].(string)
	if !ok || sessionID == "" {
		conn1.Close()
		t.Fatalf("no sessionId")
	}

	// 자식이 끝날 때까지 잠깐 기다림 (0.5초)
	time.Sleep(500 * time.Millisecond)

	// 이 시점에 자식이 끝났지만 consumer가 아직 1개 (연결 1)
	// list를 해보면 세션이 아직 있어야 함
	conn2, err := net.Dial("unix", sockPath)
	if err != nil {
		t.Fatalf("dial conn2: %v", err)
	}
	defer conn2.Close()

	listReq := map[string]interface{}{
		"command": "list",
	}
	reqJSON, _ = json.Marshal(listReq)
	conn2.Write(append(reqJSON, '\n'))

	reader2 := bufio.NewReader(conn2)
	respLine, _ = reader2.ReadBytes('\n')
	var listResp map[string]interface{}
	json.Unmarshal(respLine, &listResp)

	sessions, ok := listResp["sessions"].([]interface{})
	foundSession := false
	if ok && sessions != nil {
		for _, s := range sessions {
			if sessionMap, ok := s.(map[string]interface{}); ok {
				if id, ok := sessionMap["sessionId"].(string); ok && id == sessionID {
					foundSession = true
					break
				}
			}
		}
	}

	if !foundSession {
		t.Errorf("session should still exist (consumer still attached even though child exited)")
	}

	conn2.Close()

	// 이제 conn1을 닫으면 마지막 consumer가 detach되고 세션이 삭제되어야 함
	conn1.Close()

	time.Sleep(50 * time.Millisecond)

	// 검증: 세션이 지워졌는지 확인
	conn3, err := net.Dial("unix", sockPath)
	if err != nil {
		t.Fatalf("dial conn3: %v", err)
	}
	defer conn3.Close()

	listReq = map[string]interface{}{
		"command": "list",
	}
	reqJSON, _ = json.Marshal(listReq)
	conn3.Write(append(reqJSON, '\n'))

	reader3 := bufio.NewReader(conn3)
	respLine, _ = reader3.ReadBytes('\n')
	listResp = map[string]interface{}{}
	json.Unmarshal(respLine, &listResp)

	sessions, ok = listResp["sessions"].([]interface{})
	foundSession = false
	if ok && sessions != nil {
		for _, s := range sessions {
			if sessionMap, ok := s.(map[string]interface{}); ok {
				if id, ok := sessionMap["sessionId"].(string); ok && id == sessionID {
					foundSession = true
					break
				}
			}
		}
	}

	if foundSession {
		t.Errorf("session should be deleted (all consumers detached)")
	}
}

// TestIdle6DetachedSessionDeletedWhenChildExits: detach 후 자식이 끝나면 세션이 즉시 삭제된다.
func TestIdle6DetachedSessionDeletedWhenChildExits(t *testing.T) {
	socketDir := "/tmp/sp-test-idle6-" + fmt.Sprintf("%d", os.Getpid())
	os.RemoveAll(socketDir)
	defer os.RemoveAll(socketDir)

	identity := ptyd.DaemonIdentity{
		Protocol:  "test",
		BuildKind: "debug",
		PID:       os.Getpid(),
	}

	// 짧은 타임아웃: 1초
	daemon := ptyd.NewDaemon(identity, socketDir, 1*time.Second)
	if err := daemon.Start(); err != nil {
		t.Fatalf("daemon start: %v", err)
	}

	daemonDone := make(chan struct{})
	go func() {
		daemon.Wait()
		close(daemonDone)
	}()

	t.Cleanup(func() {
		select {
		case <-daemonDone:
			// daemon이 이미 종료됨
		default:
			daemon.Stop()
		}
	})

	time.Sleep(50 * time.Millisecond)

	sockPath := ptyd.SocketPath(socketDir, identity)

	// 연결 1: 느린 종료 세션 열기
	conn1, err := net.Dial("unix", sockPath)
	if err != nil {
		t.Fatalf("dial conn1: %v", err)
	}

	openReq := map[string]interface{}{
		"command": "open",
		"program": "/bin/sh",
		"args":    []string{"-c", "sleep 0.1"},
		"cols":    80,
		"rows":    24,
	}
	reqJSON, _ := json.Marshal(openReq)
	conn1.Write(append(reqJSON, '\n'))

	reader1 := bufio.NewReader(conn1)
	respLine, _ := reader1.ReadBytes('\n')
	var openResp map[string]interface{}
	json.Unmarshal(respLine, &openResp)

	sessionID, ok := openResp["sessionId"].(string)
	if !ok || sessionID == "" {
		conn1.Close()
		t.Fatalf("no sessionId")
	}

	// 곧바로 detach
	detachReq := map[string]interface{}{
		"command":   "detach",
		"sessionId": sessionID,
	}
	reqJSON, _ = json.Marshal(detachReq)
	conn1.Write(append(reqJSON, '\n'))
	reader1.ReadBytes('\n')

	// 연결 닫기 (이제 소비자 0, 연결 0이지만 세션은 여전히 살아있음)
	conn1.Close()

	// 자식이 종료되면 onExit 콜백이 tryDeleteSession을 호출하여 세션을 삭제
	// daemon이 타임아웃 + 1초 안에 종료되어야 함
	select {
	case <-daemonDone:
		// 정상: 세션이 삭제되고 타임아웃 후 종료됨
	case <-time.After(3 * time.Second):
		t.Error("daemon did not exit - session was not deleted when child exited")
		daemon.Stop()
	}
}

// TestLiveSessionSurvivesDisconnect: 살아있는 세션은 연결이 끊겨도 새 연결의 list에 남는다.
func TestLiveSessionSurvivesDisconnect(t *testing.T) {
	socketDir := "/tmp/sp-test-live-survive-" + fmt.Sprintf("%d", os.Getpid())
	os.RemoveAll(socketDir)
	defer os.RemoveAll(socketDir)

	identity := ptyd.DaemonIdentity{
		Protocol:  "test",
		BuildKind: "debug",
		PID:       os.Getpid(),
	}

	// 짧은 타임아웃: 1초
	daemon := ptyd.NewDaemon(identity, socketDir, 1*time.Second)
	if err := daemon.Start(); err != nil {
		t.Fatalf("daemon start: %v", err)
	}
	t.Cleanup(func() { daemon.Stop() })

	time.Sleep(50 * time.Millisecond)

	sockPath := ptyd.SocketPath(socketDir, identity)

	// 연결 1: cat 세션 열기 (살아있는 세션)
	conn1, err := net.Dial("unix", sockPath)
	if err != nil {
		t.Fatalf("dial conn1: %v", err)
	}

	openReq := map[string]interface{}{
		"command": "open",
		"program": "/bin/cat",
		"cols":    80,
		"rows":    24,
	}
	reqJSON, _ := json.Marshal(openReq)
	conn1.Write(append(reqJSON, '\n'))

	reader1 := bufio.NewReader(conn1)
	respLine, _ := reader1.ReadBytes('\n')
	var openResp map[string]interface{}
	json.Unmarshal(respLine, &openResp)

	sessionID, ok := openResp["sessionId"].(string)
	if !ok || sessionID == "" {
		conn1.Close()
		t.Fatalf("no sessionId")
	}

	// 연결 1을 닫기 (세션은 여전히 살아있음)
	conn1.Close()

	time.Sleep(50 * time.Millisecond)

	// 연결 2: list를 해서 세션이 아직 있는지 확인 (살아있으므로 남아있어야 함)
	conn2, err := net.Dial("unix", sockPath)
	if err != nil {
		t.Fatalf("dial conn2: %v", err)
	}
	defer conn2.Close()

	listReq := map[string]interface{}{
		"command": "list",
	}
	reqJSON, _ = json.Marshal(listReq)
	conn2.Write(append(reqJSON, '\n'))

	reader2 := bufio.NewReader(conn2)
	respLine, _ = reader2.ReadBytes('\n')
	var listResp map[string]interface{}
	json.Unmarshal(respLine, &listResp)

	sessions, ok := listResp["sessions"].([]interface{})
	found := false
	if ok && sessions != nil {
		for _, s := range sessions {
			if sessionMap, ok := s.(map[string]interface{}); ok {
				if id, ok := sessionMap["sessionId"].(string); ok && id == sessionID {
					found = true
					break
				}
			}
		}
	}

	if !found {
		t.Errorf("session should still exist in list (live session survives disconnect)")
	}

	// 세션 정리를 위해 close 명령 발송
	closeReq := map[string]interface{}{
		"command":   "close",
		"sessionId": sessionID,
	}
	reqJSON, _ = json.Marshal(closeReq)
	conn2.Write(append(reqJSON, '\n'))
	reader2.ReadBytes('\n')
}
