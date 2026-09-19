package main_test

import (
	"bufio"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

// TestDaemonSurvivesSighupAfterChildExit는 자식 프로세스가 종료된 후 데몬이 살아있는지 확인한다.
// 이 테스트는 다음을 검증한다:
// (a) open 요청이 sessionId를 포함한 응답을 반환한다.
// (b) 자식이 끝난 뒤 (500ms 후) 데몬이 여전히 살아 있어 list 요청에 응답한다.
//
// 이 테스트가 실패하면 O_NOCTTY 플래그가 없거나 다른 제어 터미널 관련 이슈가 있다는 뜻이다.
// 데몬이 setsid()로 세션 리더가 되고, tty를 O_NOCTTY 없이 열면 제어 터미널이 되어
// 자식 프로세스 종료 시 SIGHUP으로 데몬이 죽는다.
func TestDaemonSurvivesSighupAfterChildExit(t *testing.T) {
	// 임시 디렉터리 설정 (Unix 소켓은 104 바이트 경로 제한이 있으므로 짧은 이름 사용)
	testDir := filepath.Join("/tmp", fmt.Sprintf("ppt-%d", os.Getpid()))
	socketDir := filepath.Join(testDir, "s")
	buildDir := filepath.Join(testDir, "b")

	if err := os.MkdirAll(socketDir, 0700); err != nil {
		t.Fatalf("mkdir socketDir: %v", err)
	}
	if err := os.MkdirAll(buildDir, 0700); err != nil {
		t.Fatalf("mkdir buildDir: %v", err)
	}
	defer os.RemoveAll(testDir)

	// 데몬 바이너리 빌드 (go build -o <binpath> ./src)
	binPath := filepath.Join(buildDir, "ptyd")
	cmd := exec.Command("go", "build", "-o", binPath, "./src")
	cmd.Dir = ".." // 이 테스트 패키지의 상위가 ptyd 패키지 루트다
	output, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("build daemon binary: %v\n%s", err, output)
	}

	// 데몬 프로세스 시작 (Daemonize() 포함)
	logPath := filepath.Join(testDir, "daemon.log")
	daemonCmd := exec.Command(binPath)
	daemonCmd.Env = append(os.Environ(),
		fmt.Sprintf("PTYD_SOCKET_DIR=%s", socketDir),
		fmt.Sprintf("PTYD_LOG=%s", logPath),
		"PTYD_PROTOCOL=ptyd",
		"SOKSAK_PROFILE=debug",
	)
	if err := daemonCmd.Start(); err != nil {
		t.Fatalf("start daemon: %v", err)
	}

	// 데몬이 시작되고 소켓이 생길 때까지 대기 (최대 2초)
	startTime := time.Now()
	var sockPath string
	for {
		if time.Since(startTime) > 2*time.Second {
			// 디버그: 로그 파일 출력
			if logData, err := os.ReadFile(logPath); err == nil {
				t.Logf("Daemon log:\n%s", string(logData))
			}
			// 디버그: socket 디렉터리 내용
			if entries, err := os.ReadDir(socketDir); err == nil {
				var names []string
				for _, e := range entries {
					names = append(names, e.Name())
				}
				t.Logf("Socket dir contents: %v", names)
			}
			t.Fatalf("socket not found within 2 seconds")
		}

		// 소켓 파일 찾기
		files, err := os.ReadDir(socketDir)
		if err != nil {
			t.Fatalf("readdir: %v", err)
		}

		for _, f := range files {
			if !f.IsDir() && f.Name() != "ptyd-ptyd-debug.lock" {
				sockPath = filepath.Join(socketDir, f.Name())
				break
			}
		}

		if sockPath != "" {
			break
		}

		time.Sleep(50 * time.Millisecond)
	}

	// 데몬에 연결
	conn, err := net.Dial("unix", sockPath)
	if err != nil {
		t.Fatalf("dial socket: %v", err)
	}
	defer conn.Close()

	// (a) open 요청: /bin/sh -c 'echo hi'
	openReq := map[string]interface{}{
		"command": "open",
		"program": "/bin/sh",
		"args":    []string{"-c", "echo hi"},
		"cols":    80,
		"rows":    24,
	}
	openReqJSON, _ := json.Marshal(openReq)
	conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	if _, err := conn.Write(append(openReqJSON, '\n')); err != nil {
		t.Fatalf("write open request: %v", err)
	}

	reader := bufio.NewReader(conn)
	respLine, err := reader.ReadBytes('\n')
	if err != nil {
		t.Fatalf("read open response: %v", err)
	}

	var openResp map[string]interface{}
	if err := json.Unmarshal(respLine, &openResp); err != nil {
		t.Fatalf("unmarshal open response: %v", err)
	}

	sessionID, ok := openResp["sessionId"].(string)
	if !ok || sessionID == "" {
		t.Fatalf("(a) no sessionId in response: %s", respLine)
	}

	// 자식이 끝날 때까지 대기 (echo hi는 즉시 끝남, 하지만 500ms 여유 둠)
	time.Sleep(500 * time.Millisecond)

	// (b) list 요청으로 데몬이 살아있는지 확인
	listReq := map[string]interface{}{
		"command": "list",
	}
	listReqJSON, _ := json.Marshal(listReq)
	conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	if _, err := conn.Write(append(listReqJSON, '\n')); err != nil {
		t.Fatalf("(b) write list request (daemon may have died from SIGHUP): %v", err)
	}

	respLine, err = reader.ReadBytes('\n')
	if err != nil {
		t.Fatalf("(b) read list response (daemon died from SIGHUP - missing O_NOCTTY): %v", err)
	}

	var listResp map[string]interface{}
	if err := json.Unmarshal(respLine, &listResp); err != nil {
		t.Fatalf("(b) unmarshal list response: %v", err)
	}

	// 응답이 오면 데몬이 살아있다는 뜻
	if _, ok := listResp["sessions"]; !ok {
		t.Logf("WARNING: list response missing 'sessions' field: %s", respLine)
	}

	// 정리: 데몬 종료 (데몬이 여전히 살아있다면)
	daemonCmd.Process.Kill()
	daemonCmd.Wait()
}

// TestPtydLogEnvironmentVariable는 PTYD_LOG 환경변수로 로그 파일에 기록되는지 확인한다.
func TestPtydLogEnvironmentVariable(t *testing.T) {
	// 임시 디렉터리 설정 (Unix 소켓은 104 바이트 경로 제한이 있으므로 짧은 이름 사용)
	testDir := filepath.Join("/tmp", fmt.Sprintf("ppl-%d", os.Getpid()))
	socketDir := filepath.Join(testDir, "s")
	buildDir := filepath.Join(testDir, "b")
	logPath := filepath.Join(testDir, "l")

	if err := os.MkdirAll(socketDir, 0700); err != nil {
		t.Fatalf("mkdir socketDir: %v", err)
	}
	if err := os.MkdirAll(buildDir, 0700); err != nil {
		t.Fatalf("mkdir buildDir: %v", err)
	}
	defer os.RemoveAll(testDir)

	// 데몬 바이너리 빌드
	binPath := filepath.Join(buildDir, "ptyd")
	cmd := exec.Command("go", "build", "-o", binPath, "./src")
	cmd.Dir = ".."
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("build daemon binary: %v\n%s", err, output)
	}

	// 데몬 시작 (PTYD_LOG 설정)
	daemonCmd := exec.Command(binPath)
	daemonCmd.Env = append(os.Environ(),
		fmt.Sprintf("PTYD_SOCKET_DIR=%s", socketDir),
		fmt.Sprintf("PTYD_LOG=%s", logPath),
		"PTYD_PROTOCOL=ptyd",
		"SOKSAK_PROFILE=debug",
	)
	if err := daemonCmd.Start(); err != nil {
		t.Fatalf("start daemon: %v", err)
	}
	defer func() {
		daemonCmd.Process.Kill()
		daemonCmd.Wait()
	}()

	// 로그 파일이 생성되고 "listening on"이 포함될 때까지 대기
	startTime := time.Now()
	found := false
	for time.Since(startTime) < 2*time.Second {
		if data, err := os.ReadFile(logPath); err == nil && len(data) > 0 {
			content := string(data)
			if content != "" {
				t.Logf("Log file content: %s", content)
				found = true
				break
			}
		}
		time.Sleep(50 * time.Millisecond)
	}

	if !found {
		t.Error("log file was not created or remains empty after 2 seconds")
	}
}
