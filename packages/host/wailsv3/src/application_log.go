package host

import (
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"

	"github.com/soksak-app/core/packages/host/wailsv3/src/platform"
)

// logRotateBytes 는 로그 파일이 이전 세대로 넘어가는 크기이고, logGenerations 는 남기는 이전 세대의 수다
// (docs/spec/diagnostics.md#files). 기록은 많을수록 좋으므로 한 세션을 덮을 만큼 크게 둔다.
const (
	logRotateBytes = 100 * 1024 * 1024
	logGenerations = 5
)

// rotateGenerations 는 path 를 이전 세대 path.1 로 넘기고, 이전 세대는 하나씩 뒤로 옮기며, 마지막 세대는 지운다.
func rotateGenerations(path string) error {
	last := fmt.Sprintf("%s.%d", path, logGenerations)
	if err := os.Remove(last); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("remove %s: %w", last, err)
	}
	for generation := logGenerations - 1; generation >= 1; generation-- {
		from := fmt.Sprintf("%s.%d", path, generation)
		if err := os.Rename(from, fmt.Sprintf("%s.%d", path, generation+1)); err != nil && !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("rotate %s: %w", from, err)
		}
	}
	if err := os.Rename(path, path+".1"); err != nil {
		return fmt.Errorf("rotate %s: %w", path, err)
	}
	return nil
}

// Entry 는 시각이 없는 글 기록 하나다: level(error 또는 info), layer(page, host, native, sidecar), where(연산이나 대상의
// 이름), text(내용). 한 기록은 한 줄이다(docs/spec/diagnostics.md#forms).
type Entry struct {
	Level, Layer, Where string
	Text                any
}

// Line 은 시각을 뺀 기록 `<level> <layer> <where>: <text>` 다. text 의 줄바꿈은 두 글자 `\n` 으로 쓴다.
func (e Entry) Line() string {
	return fmt.Sprintf("%s %s %s: %s", e.Level, e.Layer, e.Where, strings.ReplaceAll(fmt.Sprint(e.Text), "\n", `\n`))
}

// RecordLine 은 쓰는 시각을 맨 앞에 둔 기록 한 줄이다.
func RecordLine(e Entry) string {
	return performanceNow() + " " + e.Line()
}

// Log 는 기록 하나를 표준 logger 의 출력에 한 번의 write 로 쓴다. 그 출력은 표준 오류이고 표준 오류는
// StartApplicationLog 뒤에 애플리케이션 로그다. 쓰지 못하면 그 실패를 알릴 곳이 없으므로 panic 한다.
func Log(e Entry) {
	if _, err := fmt.Fprintln(log.Writer(), RecordLine(e)); err != nil {
		panic(fmt.Sprintf("write the application log: %v", err))
	}
}

// ErrorLine 은 호스트의 오류 기록에서 시각을 뺀 줄이다. where 는 실패한 연산이나 대상이고 text 는 실패 내용이다.
func ErrorLine(where string, text any) string {
	return Entry{"error", "host", where, text}.Line()
}

// LogError 는 호스트의 오류 기록 하나를 쓴다.
func LogError(where string, text any) {
	Log(Entry{"error", "host", where, text})
}

// LogInfo 는 호스트의 관측 기록 하나를 쓴다. 관측은 예상된 상태를 기록하며 실패가 아니다.
func LogInfo(where string, text any) {
	Log(Entry{"info", "host", where, text})
}

// fatalError 는 오류 기록을 쓰고 프로세스를 상태 1 로 끝낸다. 로그를 연 뒤의 치명적 실패가 쓴다.
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
		if err := rotateGenerations(path); err != nil {
			return nil, err
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
	_, writeErr := fmt.Fprintln(file, RecordLine(Entry{"info", "host", "run", fmt.Sprintf("%s pid %d", identifier, os.Getpid())}))
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
