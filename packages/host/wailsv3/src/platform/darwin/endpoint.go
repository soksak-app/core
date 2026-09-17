//go:build darwin

package darwin

import (
	"fmt"
	"net"
	"os"
	"path/filepath"
	"syscall"

	"github.com/min-median-max/soksak/packages/host/wailsv3/src/platform"
)

// Listen 은 사용자 임시 디렉터리의 soksak/ 에 Unix 도메인 소켓을 만든다.
//
// 디렉터리는 이 사용자만 접근하는 0700 디렉터리여야 한다. 이미 있는 디렉터리의 권한이나
// 소유자가 다르면 다른 사용자가 소켓에 접근할 수 있으므로 실패한다. 소켓 경로는 104 바이트로
// 제한되므로 설정 디렉터리가 아니라 임시 디렉터리를 사용한다.
func (implementation) Listen(application string) (net.Listener, platform.Endpoint, error) {
	directory := filepath.Join(os.TempDir(), "soksak")
	if err := os.Mkdir(directory, 0700); err != nil && !os.IsExist(err) {
		return nil, platform.Endpoint{}, err
	}
	info, err := os.Lstat(directory)
	if err != nil {
		return nil, platform.Endpoint{}, err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !info.IsDir() || info.Mode().Perm() != 0700 || !ok || int(stat.Uid) != os.Getuid() {
		return nil, platform.Endpoint{}, fmt.Errorf("endpoint directory %s must be a directory with mode 0700 owned by the current user", directory)
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
