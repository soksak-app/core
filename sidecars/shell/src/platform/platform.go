// Package platform 은 셸 사이드카의 운영체제별 동작을 선택한다.
//
// 운영체제별 구현은 platform/<os>/ 패키지가 init 에서 Register 로 등록한다. shell
// 패키지가 모든 운영체제 패키지를 가져오므로 현재 운영체제의 구현만 등록된다.
package platform

import (
	"errors"
	"os/exec"
	"sync"
)

// Platform 은 운영체제마다 다른 동작이다.
type Platform interface {
	// Session 은 표면의 셸 명령을 만든다. 셸은 자기 프로세스 그룹에서 실행되고, 세 번째 파일
	// 기술자(ExtraFiles[0])에서 명령을 한 줄씩 읽어 실행한다. 표준 입력은 실행 중인 명령이 읽는다.
	// 시작할 때와 각 명령이 끝날 때 현재 디렉터리를 DirectoryMarker 로 시작하는 한 줄로 출력한다.
	// 중단 신호를 받아도 셸은 종료하지 않는다.
	Session() (*exec.Cmd, error)
	// Run 은 command 를 한 번 실행하는 명령을 만든다. 명령은 자기 프로세스 그룹에서 실행된다.
	Run(command string) (*exec.Cmd, error)
	// Interrupt 는 pid 가 이끄는 프로세스 그룹에 중단 신호를 보낸다.
	Interrupt(pid int) error
	// Terminate 는 pid 가 이끄는 프로세스 그룹을 종료한다.
	Terminate(pid int) error
	// Children 은 pid 의 자식 프로세스 수를 반환한다.
	Children(pid int) (int, error)
}

// DirectoryMarker 는 셸 출력에서 현재 디렉터리 보고 줄을 구분하는 접두어다. 레코드 구분 문자로
// 시작하므로 일반 출력과 겹치지 않는다.
const DirectoryMarker = "\x1ecwd "

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
