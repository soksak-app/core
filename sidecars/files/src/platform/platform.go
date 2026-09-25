// Package platform 은 파일 사이드카의 운영체제별 동작을 선택한다.
//
// 운영체제별 구현은 platform/<os>/ 패키지가 init 에서 Register 로 등록한다. files
// 패키지가 모든 운영체제 패키지를 가져오므로 현재 운영체제의 구현만 등록된다.
package platform

import (
	"errors"
	"sync"
)

// Platform 은 운영체제마다 다른 동작이다.
type Platform interface {
	// Watch 는 디렉터리 dir 의 항목이 생기거나 지워지거나 이름이 바뀔 때마다 changed 를 호출한다.
	// 감시가 도중에 실패하면 failed 를 한 번 호출하고 멈춘다. 반환한 stop 은 감시를 끝낸다.
	Watch(dir string, changed func(), failed func(error)) (stop func() error, err error)
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
