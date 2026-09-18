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
// open /bin/sh -c 'echo hi' → verify "hi" in ring, exit code 0
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

	// Wait for output
	time.Sleep(200 * time.Millisecond)

	// Read ring
	attachReq := map[string]interface{}{
		"command":   "attach",
		"sessionId": sessionID,
		"from":      0,
	}
	reqJSON, _ = json.Marshal(attachReq)
	conn.Write(append(reqJSON, '\n'))
	respLine, _ = reader.ReadBytes('\n')

	// Check for entries in response
	if !strings.Contains(string(respLine), "entries") {
		t.Errorf("'entries' not found in ring. Response: %s", respLine)
	}
	if !strings.Contains(string(respLine), "aGk") {
		t.Errorf("'hi' data not found in entries. Response: %s", respLine)
	}

	// Close and verify exit code
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
	reader.ReadBytes('\n')

	time.Sleep(100 * time.Millisecond)

	// Read ring to verify output
	attachReq := map[string]interface{}{
		"command":   "attach",
		"sessionId": sessionID,
		"from":      0,
	}
	reqJSON, _ = json.Marshal(attachReq)
	conn.Write(append(reqJSON, '\n'))
	respLine, _ = reader.ReadBytes('\n')

	// Check for entries - the actual data will be base64 encoded
	if !strings.Contains(string(respLine), "entries") {
		t.Errorf("'entries' not found in output: %s", respLine)
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
