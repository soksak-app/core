package ptyd

import (
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
)

// DaemonIdentity는 데몬의 신원을 정의한다.
type DaemonIdentity struct {
	Protocol  string // "ptyd"
	BuildKind string // "debug" 또는 "release"
	PID       int
}

// SocketPath는 소켓 경로를 구성한다.
func SocketPath(baseDir string, identity DaemonIdentity) string {
	socketName := fmt.Sprintf("ptyd-%s-%s-%d.sock", identity.Protocol, identity.BuildKind, identity.PID)
	return filepath.Join(baseDir, socketName)
}

// LockPath는 잠금 파일 경로를 구성한다.
func LockPath(baseDir string, identity DaemonIdentity) string {
	lockName := fmt.Sprintf("ptyd-%s-%s.lock", identity.Protocol, identity.BuildKind)
	return filepath.Join(baseDir, lockName)
}

// EnsurePrivateDirectory는 path 를 현재 사용자만 접근할 수 있는 디렉터리로 만든다.
func EnsurePrivateDirectory(path string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	if err := os.Mkdir(path, 0700); err != nil && !os.IsExist(err) {
		return err
	}
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.IsDir() {
		return fmt.Errorf("%s is not a directory", path)
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || int(stat.Uid) != os.Geteuid() {
		return fmt.Errorf("%s belongs to another user", path)
	}
	if info.Mode().Perm() != 0700 {
		return fmt.Errorf("%s has mode %o, want 700", path, info.Mode().Perm())
	}
	return nil
}

// CleanupDeadSockets은 죽은 프로세스가 남긴 소켓을 제거한다.
func CleanupDeadSockets(directory, protocol, buildKind string) error {
	entries, err := os.ReadDir(directory)
	if err != nil {
		return err
	}
	prefix := fmt.Sprintf("ptyd-%s-%s-", protocol, buildKind)
	for _, entry := range entries {
		if !strings.HasPrefix(entry.Name(), prefix) || !strings.HasSuffix(entry.Name(), ".sock") {
			continue
		}
		numPart := strings.TrimPrefix(entry.Name(), prefix)
		numPart = strings.TrimSuffix(numPart, ".sock")
		pid, err := strconv.Atoi(numPart)
		if err != nil || pid <= 0 {
			continue
		}
		if syscall.Kill(pid, 0) != syscall.ESRCH {
			continue
		}
		sockPath := filepath.Join(directory, entry.Name())
		if err := os.Remove(sockPath); err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	return nil
}

// PrepareListener는 소켓을 설정하고 리스너를 만든다.
// flock을 사용해 기동을 직렬화한다.
func PrepareListener(baseDir string, identity DaemonIdentity) (net.Listener, string, error) {
	if err := EnsurePrivateDirectory(baseDir); err != nil {
		return nil, "", err
	}

	// 잠금 파일 열기 (flock으로 직렬화)
	lockPath := LockPath(baseDir, identity)
	lockFile, err := os.OpenFile(lockPath, os.O_WRONLY|os.O_CREATE, 0600)
	if err != nil {
		return nil, "", fmt.Errorf("open lock file: %w", err)
	}
	defer lockFile.Close()

	// flock(LOCK_EX) - 배타적 잠금
	if err := syscall.Flock(int(lockFile.Fd()), syscall.LOCK_EX); err != nil {
		return nil, "", fmt.Errorf("flock: %w", err)
	}
	defer syscall.Flock(int(lockFile.Fd()), syscall.LOCK_UN)

	// 잠금을 얻은 후 소켓을 다시 확인
	address := SocketPath(baseDir, identity)
	if _, err := os.Lstat(address); err == nil {
		// 소켓이 존재하고 프로세스가 살아있으면 재사용
		listener, tmpErr := net.Listen("unix", address+"_tmp")
		if tmpErr == nil {
			if err := listener.Close(); err != nil {
				// 임시 리스너 닫기 실패: 로그하고 계속 진행
				fmt.Fprintf(os.Stderr, "warning: close temp listener failed: %v\n", err)
			}
			if err := os.Remove(address + "_tmp"); err != nil && !os.IsNotExist(err) {
				// 임시 소켓 파일 제거 실패: 로그하고 계속 진행
				fmt.Fprintf(os.Stderr, "warning: remove temp socket failed: %v\n", err)
			}
			// 소켓 재사용
			listener2, err := net.Listen("unix", address)
			if err != nil {
				return nil, "", err
			}
			if err := os.Chmod(address, 0600); err != nil {
				listener2.Close()
				return nil, "", err
			}
			return listener2, address, nil
		}
		// 프로세스가 죽었으면 지우고 계속
		if err := os.Remove(address); err != nil && !os.IsNotExist(err) {
			// 죽은 소켓 파일 제거 실패: 로그하고 계속 진행
			fmt.Fprintf(os.Stderr, "warning: remove dead socket failed: %v\n", err)
		}
	}

	// 죽은 소켓 정리
	if err := CleanupDeadSockets(baseDir, identity.Protocol, identity.BuildKind); err != nil {
		return nil, "", err
	}

	// 경로 길이 확인 (Unix 소켓은 104 바이트 제한)
	if len(address) > 104 {
		return nil, "", fmt.Errorf("socket path too long: %d > 104 bytes", len(address))
	}

	// 이전 소켓 제거
	if err := os.Remove(address); err != nil && !os.IsNotExist(err) {
		return nil, "", err
	}

	// 리스너 생성
	listener, err := net.Listen("unix", address)
	if err != nil {
		return nil, "", err
	}

	// 소켓 권한 설정 (0600)
	if err := os.Chmod(address, 0600); err != nil {
		listener.Close()
		return nil, "", err
	}

	return listener, address, nil
}
