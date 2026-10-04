// Package platform 은 command line 의 운영체제별 동작을 선언하고 현재 운영체제의 구현을 고른다. 운영체제별 구현은
// platform/<os>/ 패키지가 init 에서 Register 로 등록하며, 명령은 모든 운영체제 패키지를 가져오므로 현재 운영체제의
// 구현만 등록된다.
package platform

import "errors"

// Platform 은 운영체제별 동작이다.
type Platform interface {
	// ProcessRunning 은 pid 프로세스가 실행 중이면 nil 을 돌려준다.
	ProcessRunning(pid int) error
	// Key 는 이 플랫폼의 release asset key(`<os>-<arch>`)다. 이 architecture 의 key 가 없으면 오류다.
	Key() (string, error)
	// PathsDir 는 경로 항목을 두는 폴더다. 이 운영체제에 그런 폴더가 없으면 오류다(docs/spec/cli.md).
	PathsDir() (string, error)
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
