// Package platform 은 command line 의 운영체제별 동작을 선언하고 현재 운영체제의 구현을 고른다. 운영체제별 구현은
// platform/<os>/ 패키지가 init 에서 Register 로 등록하며, 명령은 모든 운영체제 패키지를 가져오므로 현재 운영체제의
// 구현만 등록된다.
package platform

import (
	"errors"
	"time"
)

// Platform 은 운영체제별 동작이다.
type Platform interface {
	// ProcessRunning 은 pid 프로세스가 실행 중이면 nil 을 돌려준다.
	ProcessRunning(pid int) error
	// Key is the release key (`<os>-<arch>`) of this platform; an architecture without a key is an error.
	Key() (string, error)
	// PathsDir 는 경로 항목을 두는 폴더다. 이 운영체제에 그런 폴더가 없으면 오류다(docs/spec/cli.md).
	PathsDir() (string, error)
	// ExtractBundle extracts the zip of an application bundle into the folder.
	ExtractBundle(zipped, folder string) error
	// BundleVersion is the version that the application bundle at the path declares.
	BundleVersion(bundle string) (string, error)
	// WaitProcessEnd waits until the process pid has ended, and reports false when it still runs after timeout.
	WaitProcessEnd(pid int, timeout time.Duration) (bool, error)
	// CopyBundle copies an application bundle, also across volumes, keeping its modes and signature.
	CopyBundle(source, destination string) error
	// OpenApplication starts a new instance of the application bundle with the arguments.
	OpenApplication(bundle string, arguments []string) error
}

var current Platform

// Register 는 현재 운영체제의 구현을 등록한다.
func Register(platform Platform) { current = platform }

// Current 는 등록된 구현이다. 이 운영체제의 구현이 없으면 오류다.
func Current() (Platform, error) {
	if current == nil {
		return nil, errors.New("no platform implementation is registered for this operating system")
	}
	return current, nil
}
