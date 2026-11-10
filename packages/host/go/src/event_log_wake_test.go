package host

import (
	"os"
	"testing"

	"github.com/soksak-app/core/packages/host/go/src/platform"
)

type pipeWake struct {
	platform.Platform
	descriptor int
}

func (p pipeWake) NativeEventWake() (int, error) { return p.descriptor, nil }

// wakeReaders keeps the file of each pipe reachable: the wake owns the descriptor, and a file that is collected would close it as well.
var wakeReaders []*os.File

// A byte in the pipe of the native ring reaches the Wake of the writer, again after the first.
// contract: log.native.wake-stores-a-record-at-once
func TestNativeWakeTurnsThePipeIntoTheWakeOfTheWriter(t *testing.T) {
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Close()
	wakeReaders = append(wakeReaders, reader)
	descriptor := int(reader.Fd())
	wake, err := nativeWake(pipeWake{descriptor: descriptor})
	if err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if _, err := writer.Write([]byte{0}); err != nil {
			t.Fatal(err)
		}
		<-wake
	}
}
