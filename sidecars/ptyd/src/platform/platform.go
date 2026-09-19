// Package platform 은 PTY 데몬 헬퍼의 운영체제별 동작을 선택한다.
package platform

import (
	"errors"
	"sync"
)

// Platform 은 운영체제마다 다른 동작이다.
type Platform interface {
	// Setsid는 새 세션과 프로세스 그룹을 생성한다.
	Setsid() error

	// Detach는 stdin, stdout, stderr를 /dev/null로 리다이렉트한다.
	// (PTYD_LOG 환경변수가 설정되면 stderr을 그 파일로 리다이렉트한다.)
	Detach() error
}

var (
	mu      sync.Mutex
	current Platform
)

// Register 는 현재 운영체제의 구현을 등록한다. 두 번 등록하면 실패한다.
func Register(p Platform) {
	mu.Lock()
	defer mu.Unlock()
	if current != nil {
		panic("platform: implementation registered twice")
	}
	current = p
}

// Current 는 등록된 구현을 반환한다. 등록된 구현이 없으면 오류를 반환한다.
func Current() (Platform, error) {
	mu.Lock()
	defer mu.Unlock()
	if current == nil {
		return nil, errors.New("no platform implementation is registered")
	}
	return current, nil
}
