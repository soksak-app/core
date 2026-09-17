// Package platform 은 셸 사이드카의 운영체제별 동작을 선택한다.
//
// 운영체제별 구현은 platform/<os>/ 패키지가 init 에서 Register 로 등록한다. shell
// 패키지가 모든 운영체제 패키지를 가져오므로 현재 운영체제의 구현만 등록된다.
package platform

import (
	"errors"
	"sync"
)

// Platform 은 운영체제마다 다른 동작이다.
type Platform interface {
	// Shell 은 실행할 셸 프로그램을 반환한다.
	Shell() string
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
