//go:build diagnostics

// The state of the diagnostic recording. It is compiled only with the diagnostics build tag.
//
// There is one recording at a time. Whichever stage the start fails at, and also when the request fails before it returns the recording folder to the requester,
// the recording stops and the folder is deleted. A remaining recording blocks the next recording, and a remaining folder cannot be deleted by the
// requester.

package host

import (
	"errors"
	"fmt"
	"os"
	"sync"

	"github.com/soksak-app/core/packages/host/wailsv3/src/platform"
)

// CaptureTarget is the recording target. With Display, the windows of this app on the display that holds the window are recorded.
// A window recording stops when the window is moved to another Space (full screen).
type CaptureTarget struct {
	Window  int
	Display bool
}

// Capture is the recording device. The platform implementation or a fake of a check provides it.
type Capture interface {
	// Open makes the window with the window server number target.Window the recording target.
	Open(target CaptureTarget) error
	// Start starts the frame recording in directory.
	Start(directory string, frameIdentity bool) error
	// Wait returns whether the first frame was recorded.
	Wait() (bool, error)
	// Stop ends the recording and returns the number of recorded frames.
	Stop() (int, error)
}

// Recording is the folder of the recording in progress. The zero value is used.
type Recording struct {
	mu        sync.Mutex
	directory string
}

// Start creates directory and starts recording target into that folder. It returns after the first frame is recorded.
// When it fails, the recording stops and the folder is deleted.
func (r *Recording) Start(capture Capture, target CaptureTarget, directory string, frameIdentity bool) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.directory != "" {
		return fmt.Errorf("a capture into %s is running", r.directory)
	}
	system, err := platform.Current()
	if err != nil {
		return err
	}
	if err := system.PrivateDirectory(directory); err != nil {
		return err
	}
	if err := r.begin(capture, target, directory, frameIdentity); err != nil {
		if removeErr := os.RemoveAll(directory); removeErr != nil {
			return fmt.Errorf("%w; remove failed capture directory: %v", err, removeErr)
		}
		return err
	}
	r.directory = directory
	return nil
}

func (r *Recording) begin(capture Capture, target CaptureTarget, directory string, frameIdentity bool) error {
	// The preparation decides the output size from the window size at that time, so the same target is prepared again for each recording.
	if err := capture.Open(target); err != nil {
		return err
	}
	if err := capture.Start(directory, frameIdentity); err != nil {
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

// Abort stops the recording in progress and deletes the folder. It does nothing when there is no recording.
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

// Finish ends the recording in progress and returns the folder and the number of frames. The requester deletes the folder.
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

// Running is the folder of the recording in progress. It is an empty string when there is no recording.
func (r *Recording) Running() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.directory
}
