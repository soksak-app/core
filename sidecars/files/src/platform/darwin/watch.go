//go:build darwin

package darwin

import (
	"errors"
	"fmt"
	"syscall"

	"github.com/min-median-max/soksak/sidecars/files/src/platform"
)

type implementation struct{}

func init() { platform.Register(implementation{}) }

// oEvtOnly 는 감시만을 위해 여는 플래그(O_EVTONLY)다. 연 디렉터리가 있는 볼륨의 꺼내기를 막지 않는다.
const oEvtOnly = 0x8000

// Watch 는 디렉터리의 기술자에 EVFILT_VNODE 를 걸고, 멈춤 신호를 받을 파이프를 같은 kqueue 에 건다.
func (implementation) Watch(dir string, changed func(), failed func(error)) (func() error, error) {
	fd, err := syscall.Open(dir, oEvtOnly|syscall.O_DIRECTORY, 0)
	if err != nil {
		return nil, fmt.Errorf("open %s: %w", dir, err)
	}
	kq, err := syscall.Kqueue()
	if err != nil {
		return nil, errors.Join(fmt.Errorf("kqueue: %w", err), syscall.Close(fd))
	}
	var pipe [2]int
	if err := syscall.Pipe(pipe[:]); err != nil {
		return nil, errors.Join(fmt.Errorf("pipe: %w", err), syscall.Close(fd), syscall.Close(kq))
	}
	closeAll := func() error {
		var first error
		for _, each := range []int{fd, kq, pipe[0]} {
			if err := syscall.Close(each); err != nil && first == nil {
				first = fmt.Errorf("close watch of %s: %w", dir, err)
			}
		}
		return first
	}
	var events [2]syscall.Kevent_t
	syscall.SetKevent(&events[0], fd, syscall.EVFILT_VNODE, syscall.EV_ADD|syscall.EV_CLEAR)
	events[0].Fflags = syscall.NOTE_WRITE | syscall.NOTE_DELETE | syscall.NOTE_RENAME | syscall.NOTE_EXTEND
	syscall.SetKevent(&events[1], pipe[0], syscall.EVFILT_READ, syscall.EV_ADD)
	if _, err := syscall.Kevent(kq, events[:], nil, nil); err != nil {
		return nil, errors.Join(fmt.Errorf("kevent %s: %w", dir, err), closeAll(), syscall.Close(pipe[1]))
	}
	go func() {
		defer func() {
			if err := closeAll(); err != nil {
				failed(err)
			}
		}()
		received := make([]syscall.Kevent_t, 4)
		for {
			n, err := syscall.Kevent(kq, nil, received, nil)
			if err == syscall.EINTR {
				continue
			}
			if err != nil {
				failed(fmt.Errorf("kevent %s: %w", dir, err))
				return
			}
			for _, event := range received[:n] {
				if int(event.Ident) == pipe[0] {
					return
				}
			}
			changed()
		}
	}()
	// 쓰는 끝을 닫으면 읽는 끝에 EOF 가 생기고, 감시 고루틴이 그 이벤트를 받아 끝난다.
	return func() error { return syscall.Close(pipe[1]) }, nil
}
