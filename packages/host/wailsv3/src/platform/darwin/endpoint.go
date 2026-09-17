//go:build darwin

package darwin

import (
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"

	"github.com/min-median-max/soksak/packages/host/wailsv3/src/platform"
)

// privateDirectory 는 path 를 현재 사용자만 접근할 수 있는 디렉터리로 만든다. 이미 있으면
// 종류, 소유자, 권한을 차례로 확인한다. 다른 사용자가 소켓에 접근할 수 있으면 실패한다.
func privateDirectory(path string) error {
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

// removeEnded 는 directory 에서 끝난 프로세스가 남긴 application 의 소켓을 제거한다. 강제 종료된
// 프로세스는 자기 소켓을 지우지 못한다. 번호의 프로세스가 있으면 다른 프로그램이어도 남긴다.
func removeEnded(directory, application string) error {
	entries, err := os.ReadDir(directory)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		number, found := strings.CutPrefix(entry.Name(), application+"-")
		number, suffixed := strings.CutSuffix(number, ".sock")
		pid, err := strconv.Atoi(number)
		if !found || !suffixed || err != nil || pid <= 0 {
			continue
		}
		if syscall.Kill(pid, 0) != syscall.ESRCH {
			continue
		}
		if err := os.Remove(filepath.Join(directory, entry.Name())); err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	return nil
}

// Listen 은 directory 에 Unix 도메인 소켓을 만든다. directory 는 이 사용자만 접근하는 0700
// 디렉터리여야 한다. 끝난 프로세스가 남긴 소켓을 먼저 제거한다. 소켓 경로는 104 바이트로 제한되므로 애플리케이션은 설정 디렉터리가 아니라
// 임시 디렉터리를 사용한다.
func (implementation) Listen(directory, application string) (net.Listener, platform.Endpoint, error) {
	if err := privateDirectory(directory); err != nil {
		return nil, platform.Endpoint{}, err
	}
	if err := removeEnded(directory, application); err != nil {
		return nil, platform.Endpoint{}, err
	}
	address := filepath.Join(directory, fmt.Sprintf("%s-%d.sock", application, os.Getpid()))
	// 같은 프로세스 번호를 사용한 이전 프로세스가 남긴 소켓이다.
	if err := os.Remove(address); err != nil && !os.IsNotExist(err) {
		return nil, platform.Endpoint{}, err
	}
	listener, err := net.Listen("unix", address)
	if err != nil {
		return nil, platform.Endpoint{}, err
	}
	if err := os.Chmod(address, 0600); err != nil {
		listener.Close()
		return nil, platform.Endpoint{}, err
	}
	return listener, platform.Endpoint{Transport: "unix", Address: address}, nil
}
