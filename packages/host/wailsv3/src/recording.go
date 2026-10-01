//go:build diagnostics

// 진단 녹화의 상태. diagnostics 빌드 태그로만 컴파일한다.
//
// 녹화는 한 번에 하나다. 시작이 어느 단계에서 실패하든, 그리고 요청이 녹화 폴더를 요청자에게
// 돌려주기 전에 실패하든 녹화를 멈추고 폴더를 지운다. 남은 녹화는 다음 녹화를 막고, 남은 폴더는
// 요청자가 지울 수 없다.

package host

import (
	"errors"
	"fmt"
	"os"
	"sync"
)

// CaptureTarget 은 녹화 대상이다. Display 이면 창이 있는 디스플레이에서 이 앱의 창을 녹화한다.
// 창 녹화는 창이 다른 Space(전체 화면)로 옮겨지면 멈춘다.
type CaptureTarget struct {
	Window  int
	Display bool
}

// Capture 는 녹화 장치다. 플랫폼 구현이나 검사의 가짜가 제공한다.
type Capture interface {
	// Open 은 윈도 서버 번호 target.Window 의 창을 녹화 대상으로 정한다.
	Open(target CaptureTarget) error
	// Start 는 directory 에 프레임 기록을 시작한다.
	Start(directory string) error
	// Wait 는 첫 프레임이 기록되었는지 반환한다.
	Wait() (bool, error)
	// Stop 은 기록을 끝내고 기록한 프레임 수를 반환한다.
	Stop() (int, error)
}

// Recording 은 진행 중인 녹화의 폴더다. 영값을 사용한다.
type Recording struct {
	mu        sync.Mutex
	directory string
}

// Start 는 directory 를 만들고 target 을 그 폴더에 녹화하기 시작한다. 첫 프레임이 기록된 뒤
// 반환한다. 실패하면 녹화를 멈추고 폴더를 지운다.
func (r *Recording) Start(capture Capture, target CaptureTarget, directory string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.directory != "" {
		return fmt.Errorf("a capture into %s is running", r.directory)
	}
	if err := os.MkdirAll(directory, 0700); err != nil {
		return err
	}
	if err := r.begin(capture, target, directory); err != nil {
		if removeErr := os.RemoveAll(directory); removeErr != nil {
			return fmt.Errorf("%w; remove failed capture directory: %v", err, removeErr)
		}
		return err
	}
	r.directory = directory
	return nil
}

func (r *Recording) begin(capture Capture, target CaptureTarget, directory string) error {
	// 준비는 그때의 창 크기로 출력 크기를 정하므로 같은 대상도 녹화마다 다시 준비한다.
	if err := capture.Open(target); err != nil {
		return err
	}
	if err := capture.Start(directory); err != nil {
		return err
	}
	ready, err := capture.Wait()
	if err == nil && !ready {
		err = errors.New("capture did not produce an initial frame")
	}
	if err != nil {
		if _, stopErr := capture.Stop(); stopErr != nil {
			return fmt.Errorf("%w; stop failed recording: %v", err, stopErr)
		}
		return err
	}
	return nil
}

// Abort 는 진행 중인 녹화를 멈추고 폴더를 지운다. 녹화가 없으면 아무 일도 하지 않는다.
func (r *Recording) Abort(capture Capture) error {
	r.mu.Lock()
	directory := r.directory
	r.directory = ""
	r.mu.Unlock()
	if directory == "" {
		return nil
	}
	var errs []error
	if _, err := capture.Stop(); err != nil {
		errs = append(errs, fmt.Errorf("stop capture: %w", err))
	}
	if err := os.RemoveAll(directory); err != nil {
		errs = append(errs, fmt.Errorf("remove capture directory: %w", err))
	}
	return errors.Join(errs...)
}

// Finish 는 진행 중인 녹화를 끝내고 폴더와 프레임 수를 반환한다. 폴더는 요청자가 지운다.
func (r *Recording) Finish(capture Capture) (string, int, error) {
	r.mu.Lock()
	directory := r.directory
	r.directory = ""
	r.mu.Unlock()
	if directory == "" {
		return "", 0, errors.New("no capture is running")
	}
	count, err := capture.Stop()
	return directory, count, err
}

// Running 은 진행 중인 녹화의 폴더다. 녹화가 없으면 빈 문자열이다.
func (r *Recording) Running() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.directory
}
