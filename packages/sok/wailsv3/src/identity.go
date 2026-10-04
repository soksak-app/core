package sok

// 애플리케이션 식별자와 이전 설정 폴더(docs/spec/projects.md#persistence). 식별자는 기본 설정 폴더의 이름이고
// 경로 항목의 파일 이름이다. 진단 build 는 release 애플리케이션의 데이터를 쓰지 않도록 .dev 를 붙인다.

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/soksak-app/core/packages/sok/wailsv3/src/platform"
)

const (
	// ReleaseIdentifier 는 release build 의 식별자이며 번들 식별자다.
	ReleaseIdentifier = "app.soksak.wails"
	// FormerIdentifier 는 0.0.2 까지의 release 설정 폴더 이름이다.
	FormerIdentifier = "com.soksak.wails"
)

// diagnosticBuild 는 진단 build 의 init 이 true 로 정한다.
var diagnosticBuild bool

// Identity 는 이 build 의 식별자와, release host 가 시작할 때 옮기는 이전 식별자다. 진단 build 는 이전 식별자가
// 없다("").
func Identity() (identifier, former string) {
	if diagnosticBuild {
		return ReleaseIdentifier + ".dev", ""
	}
	return ReleaseIdentifier, FormerIdentifier
}

// MoveFormerConfigDir 는 base 아래 former 폴더만 있으면 그것을 identifier 폴더로 이름을 바꾸고 이전 경로를
// 돌려준다. 옮길 것이 없으면 "" 이고, 두 폴더가 모두 있으면 오류다. former 가 "" 이면 아무것도 하지 않는다.
func MoveFormerConfigDir(base, former, identifier string) (string, error) {
	if former == "" {
		return "", nil
	}
	from, to := filepath.Join(base, former), filepath.Join(base, identifier)
	exists, err := formerExists(from, to)
	if err != nil || !exists {
		return "", err
	}
	if err := formerInUse(from); err != nil {
		return "", err
	}
	if err := os.Rename(from, to); err != nil {
		return "", fmt.Errorf("cannot move %s to %s: %s", from, to, osReason(err))
	}
	return from, nil
}

// checkFormerConfigDir 는 sok 이 기본 설정 폴더를 쓰기 전에 옮기지 않은 이전 폴더가 없는지 확인한다. sok 은
// 폴더를 옮기거나 만들지 않는다.
func checkFormerConfigDir(base, former, identifier string) error {
	if former == "" {
		return nil
	}
	from, to := filepath.Join(base, former), filepath.Join(base, identifier)
	exists, err := formerExists(from, to)
	if err != nil {
		return err
	}
	if exists {
		return fmt.Errorf("%s has not been moved; start the application once to move it to %s", from, to)
	}
	return nil
}

// formerExists 는 이전 폴더만 있는지 알려 준다. 두 폴더가 모두 있으면 오류다.
func formerExists(from, to string) (bool, error) {
	fromExists, err := pathExists(from)
	if err != nil || !fromExists {
		return false, err
	}
	toExists, err := pathExists(to)
	if err != nil {
		return false, err
	}
	if toExists {
		return false, fmt.Errorf("%s and %s both exist; move or remove %s", from, to, from)
	}
	return true, nil
}

// formerInUse 는 이전 폴더의 process.lock 이 실행 중인 프로세스를 가리키면 오류다. 끝난 프로세스의 lock 은 폴더와
// 함께 옮겨지고 엔드포인트가 교체한다(docs/spec/endpoint.md).
func formerInUse(from string) error {
	lock := filepath.Join(from, "process.lock")
	contents, err := os.ReadFile(lock)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fileError(lock, err)
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(contents)))
	if err != nil || pid <= 0 {
		return fmt.Errorf("%s: invalid process lock", lock)
	}
	current, err := platform.Current()
	if err != nil {
		return err
	}
	if current.ProcessRunning(pid) == nil {
		return fmt.Errorf("%s is in use by process %d; quit that application first", from, pid)
	}
	return nil
}

func pathExists(path string) (bool, error) {
	_, err := os.Lstat(path)
	if errors.Is(err, fs.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, fileError(path, err)
	}
	return true, nil
}
