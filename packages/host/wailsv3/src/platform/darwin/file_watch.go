//go:build darwin

package darwin

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"syscall"

	"github.com/soksak-app/core/packages/host/wailsv3/src/routine"
)

// openEventOnly is O_EVTONLY: the descriptor is only for the notifications of the kernel and keeps neither the file's volume busy
// nor the file open for reading.
const openEventOnly = 0x8000

// vnodeEvents are the changes of a file or a folder that the watch reports: a write or an extension, a change of the attributes
// (a truncation, a mode), and the removal, the rename or the revocation of the entry.
const vnodeEvents = syscall.NOTE_WRITE | syscall.NOTE_EXTEND | syscall.NOTE_ATTRIB | syscall.NOTE_DELETE | syscall.NOTE_RENAME | syscall.NOTE_REVOKE

// stopIdent is the identifier of the user event that ends the watch.
const stopIdent = 1

// WatchFile calls changed on a goroutine of the watch after the file at path was created, written, replaced, renamed or removed. The
// kqueue of the kernel is the event source: the folder of the file is watched for the creation and the replacement of the entry, and the
// file for the writes in place, so no timer reads the file. A notification can follow another that already led to a read, so the
// reader of changed compares what it reads with what it holds. The result stops the watch and waits until its goroutine ended.
func (implementation) WatchFile(path string, changed func()) (func(), error) {
	queue, err := syscall.Kqueue()
	if err != nil {
		return nil, fmt.Errorf("watch %s: kqueue: %w", path, err)
	}
	register := func(change syscall.Kevent_t) error {
		_, err := syscall.Kevent(queue, []syscall.Kevent_t{change}, nil, nil)
		return err
	}
	fail := func(err error, descriptors ...int) (func(), error) {
		for _, descriptor := range descriptors {
			if descriptor >= 0 {
				syscall.Close(descriptor)
			}
		}
		syscall.Close(queue)
		return nil, fmt.Errorf("watch %s: %w", path, err)
	}
	vnode := func(descriptor int) syscall.Kevent_t {
		return syscall.Kevent_t{Ident: uint64(descriptor), Filter: syscall.EVFILT_VNODE, Flags: syscall.EV_ADD | syscall.EV_CLEAR, Fflags: vnodeEvents}
	}
	if err := register(syscall.Kevent_t{Ident: stopIdent, Filter: syscall.EVFILT_USER, Flags: syscall.EV_ADD | syscall.EV_CLEAR}); err != nil {
		return fail(err)
	}
	directory, err := syscall.Open(filepath.Dir(path), openEventOnly|syscall.O_CLOEXEC, 0)
	if err != nil {
		return fail(err)
	}
	if err := register(vnode(directory)); err != nil {
		return fail(err, directory)
	}
	// file is the descriptor of the file at the path, or -1 while there is none.
	file := -1
	openFile := func() error {
		descriptor, err := syscall.Open(path, openEventOnly|syscall.O_CLOEXEC, 0)
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		if err != nil {
			return err
		}
		if err := register(vnode(descriptor)); err != nil {
			syscall.Close(descriptor)
			return err
		}
		file = descriptor
		return nil
	}
	if err := openFile(); err != nil {
		return fail(err, directory)
	}
	done := make(chan struct{})
	routine.Go("file-watch", func() {
		defer close(done)
		events := make([]syscall.Kevent_t, 8)
		for {
			count, err := syscall.Kevent(queue, nil, events, nil)
			if errors.Is(err, syscall.EINTR) {
				continue
			}
			if err != nil {
				fmt.Fprintf(os.Stderr, "watch %s: %v\n", path, err)
				return
			}
			replaced := false
			for _, event := range events[:count] {
				switch {
				case event.Filter == syscall.EVFILT_USER:
					return
				case event.Filter == syscall.EVFILT_VNODE && int(event.Ident) == file && event.Fflags&(syscall.NOTE_DELETE|syscall.NOTE_RENAME|syscall.NOTE_REVOKE) != 0:
					replaced = true
				}
			}
			// The file at the path is another file after a replacement, and a removed file has none: the descriptor is renewed.
			if replaced || file < 0 {
				if file >= 0 {
					syscall.Close(file)
					file = -1
				}
				if err := openFile(); err != nil {
					fmt.Fprintf(os.Stderr, "watch %s: %v\n", path, err)
				}
			}
			changed()
		}
	})
	return func() {
		trigger := syscall.Kevent_t{Ident: stopIdent, Filter: syscall.EVFILT_USER, Fflags: syscall.NOTE_TRIGGER}
		if err := register(trigger); err != nil {
			fmt.Fprintf(os.Stderr, "watch %s: the stop was not delivered: %v\n", path, err)
			return
		}
		<-done
		if file >= 0 {
			syscall.Close(file)
		}
		syscall.Close(directory)
		syscall.Close(queue)
	}, nil
}
