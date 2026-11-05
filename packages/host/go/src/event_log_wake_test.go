//go:build !windows

package host

import (
	"os"
	"syscall"
	"testing"
	"time"

	"github.com/soksak-app/core/packages/host/go/src/platform"
)

type pipeWake struct {
	platform.Platform
	descriptor int
}

func (p pipeWake) NativeEventWake() (int, error) { return p.descriptor, nil }

// A byte in the pipe of the native ring reaches the Wake of the writer, again after the first.
func TestNativeWakeTurnsThePipeIntoTheWakeOfTheWriter(t *testing.T) {
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Close()
	descriptor, err := syscall.Dup(int(reader.Fd()))
	if err != nil {
		t.Fatal(err)
	}
	if err := syscall.SetNonblock(descriptor, true); err != nil {
		t.Fatal(err)
	}
	reader.Close()
	wake, err := nativeWake(pipeWake{descriptor: descriptor})
	if err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if _, err := writer.Write([]byte{0}); err != nil {
			t.Fatal(err)
		}
		select {
		case <-wake:
		case <-time.After(5 * time.Second):
			t.Fatal("a byte in the pipe did not reach the wake")
		}
	}
}
