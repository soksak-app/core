package host

import (
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"

	"github.com/soksak-app/core/packages/host/wailsv3/src/platform"
)

// logRotateBytes 는 로그 파일을 열 때 이전 세대로 넘기는 크기다(docs/spec/hosts.md#application-log).
const logRotateBytes = 10 * 1024 * 1024

// ErrorLine 은 오류 한 줄 `error: <where>: <text>` 다. 페이지의 오류 줄과 같은 형식이므로 창 검사가 호스트의 실패도
// 오류로 읽는다(docs/spec/hosts.md#application-log). where 는 실패한 연산이나 대상이고 text 는 실패 내용이다.
func ErrorLine(where string, text any) string {
	return fmt.Sprintf("error: %s: %v", where, text)
}

// LogError 는 오류 줄 하나를 표준 logger 의 출력에 한 번의 write 로 쓴다. 그 출력은 표준 오류이고 표준 오류는
// StartApplicationLog 뒤에 애플리케이션 로그다. logger 의 시각 접두사 설정과 관계없이 줄은 `error: ` 로 시작한다. 쓰지
// 못하면 그 실패를 알릴 곳이 없으므로 panic 한다.
func LogError(where string, text any) {
	if _, err := fmt.Fprintln(log.Writer(), ErrorLine(where, text)); err != nil {
		panic(fmt.Sprintf("write the application log: %v", err))
	}
}

// fatalError 는 오류 줄을 쓰고 프로세스를 상태 1 로 끝낸다. 로그를 연 뒤의 치명적 실패가 쓴다.
func fatalError(where string, text any) {
	LogError(where, text)
	os.Exit(1)
}

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
	system, err := platform.Current()
	if err != nil {
		return nil, err
	}
	if err := system.CreatePrivateDirectories(filepath.Dir(path)); err != nil {
		return nil, fmt.Errorf("create logs directory: %w", err)
	}
	if info, err := os.Stat(path); err == nil && info.Size() >= logRotateBytes {
		if err := os.Rename(path, path+".1"); err != nil {
			return nil, fmt.Errorf("rotate %s: %w", path, err)
		}
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, fmt.Errorf("inspect %s: %w", path, err)
	}
	file, err := system.AppendPrivateFile(path)
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
