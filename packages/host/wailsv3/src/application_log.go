package host

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/min-median-max/soksak/packages/host/wailsv3/src/platform"
)

// logRotateBytes 는 로그 파일을 열 때 이전 세대로 넘기는 크기다(docs/spec/hosts.md#application-log).
const logRotateBytes = 10 * 1024 * 1024

// ApplicationLogPath 는 설정 디렉터리 config 의 애플리케이션 로그 경로다.
func ApplicationLogPath(config string) string {
	return filepath.Join(config, "logs", "application.log")
}

// ServiceLogPath 는 영속 서비스 program 의 표준 오류를 받는 로그 경로다.
func ServiceLogPath(config, program string) string {
	return filepath.Join(config, "logs", filepath.Base(program)+".log")
}

// OpenLog 는 로그 파일 path 를 mode 0600 의 덧붙이기로 연다. 10 MB 이상인 파일은 먼저 path.1 로
// 옮겨 이전 세대를 대체한다. 그 파일에 쓰는 다른 프로세스가 없을 때만 부른다.
func OpenLog(path string) (*os.File, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, fmt.Errorf("create logs directory: %w", err)
	}
	if info, err := os.Stat(path); err == nil && info.Size() >= logRotateBytes {
		if err := os.Rename(path, path+".1"); err != nil {
			return nil, fmt.Errorf("rotate %s: %w", path, err)
		}
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, fmt.Errorf("inspect %s: %w", path, err)
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return nil, fmt.Errorf("open %s: %w", path, err)
	}
	return file, nil
}

// StartApplicationLog 는 설정 디렉터리 config 의 애플리케이션 로그를 열고 실행의 첫 줄을 쓴 뒤 그 파일을
// 프로세스의 표준 오류로 만든다. 설정 디렉터리의 process lock 을 잡은 뒤 한 번 부른다.
func StartApplicationLog(config, identifier string) error {
	system, err := platform.Current()
	if err != nil {
		return err
	}
	file, err := OpenLog(ApplicationLogPath(config))
	if err != nil {
		return fmt.Errorf("application log: %w", err)
	}
	_, writeErr := fmt.Fprintf(file, "%s application log: %s pid %d\n", performanceNow(), identifier, os.Getpid())
	var replaceErr error
	if writeErr == nil {
		replaceErr = system.ReplaceStandardError(file)
	}
	// 표준 오류는 복제한 descriptor 를 가지므로 연 파일은 닫는다.
	closeErr := file.Close()
	if err := errors.Join(writeErr, replaceErr, closeErr); err != nil {
		return fmt.Errorf("application log: %w", err)
	}
	return nil
}
