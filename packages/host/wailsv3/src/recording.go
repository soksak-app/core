//go:build diagnostics

// The state of the diagnostic recording. It is compiled only with the diagnostics build tag.
//
// There is one recording at a time. A failed start removes its folder after capture cleanup. A stop error retains
// ownership only while the capture module still owns its stream and writer transaction. A remaining recording or cleanup folder blocks the next recording.

package host

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
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
	// Open makes the window with the window server number target.Window the recording target. An error leaves no new
	// active recording and leaves any existing active recording unchanged.
	Open(target CaptureTarget) error
	// Start starts the frame recording in directory. An error rolls back resources created by this attempt.
	Start(directory string, frameIdentity bool) error
	// Wait returns whether the first frame was recorded.
	Wait() (bool, error)
	// Stop ends the recording and returns the number of recorded frames. An error may occur after native ownership retires.
	Stop() (int, error)
	// HasStream reports whether the native capture module still owns the current stream and its writer transaction.
	// It does not report whether the operating system's asynchronous stop callback has completed.
	HasStream() (bool, error)
}

// Recording is the folder of the recording in progress. The zero value is used.
type Recording struct {
	mu                      sync.Mutex
	directory               string
	captureStopped          bool
	frameIdentity           bool
	documentIdentityAllowed bool
	identitySource          *documentFrameIdentitySource
}

type documentFrameIdentitySource struct {
	surface    string
	generation uint64
}

// Start creates directory and starts recording target into that folder. It returns after the first frame is recorded.
// When cleanup after a failure is incomplete, the owned folder and stop state remain until Abort completes cleanup.
func (r *Recording) Start(capture Capture, target CaptureTarget, directory string, frameIdentity bool) error {
	return r.StartWithDocumentIdentity(capture, target, directory, frameIdentity, false)
}

// StartWithDocumentIdentity marks diagnostics.capture.start recordings as eligible for one document source.
func (r *Recording) StartWithDocumentIdentity(capture Capture, target CaptureTarget, directory string, frameIdentity, documentIdentityAllowed bool) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.directory != "" {
		return fmt.Errorf("a capture into %s is running", r.directory)
	}
	if r.identitySource != nil {
		return fmt.Errorf("document frame identity cleanup for surface %q generation %d is incomplete", r.identitySource.surface, r.identitySource.generation)
	}
	system, err := platform.Current()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(directory), 0o700); err != nil {
		return err
	}
	if err := os.Mkdir(directory, 0o700); err != nil {
		return fmt.Errorf("create capture directory: %w", err)
	}
	if err := system.PrivateDirectory(directory); err != nil {
		return r.removeFailedStartDirectory(directory, true, err)
	}
	captureStopped, err := r.begin(capture, target, directory, frameIdentity)
	if err != nil {
		return r.removeFailedStartDirectory(directory, captureStopped, err)
	}
	r.directory = directory
	r.captureStopped = false
	r.frameIdentity = frameIdentity
	r.documentIdentityAllowed = documentIdentityAllowed
	r.identitySource = nil
	return nil
}

func (r *Recording) removeFailedStartDirectory(directory string, captureStopped bool, cause error) error {
	if !captureStopped {
		r.directory = directory
		r.captureStopped = false
		r.frameIdentity = false
		r.documentIdentityAllowed = false
		r.identitySource = nil
		return cause
	}
	if removeErr := os.RemoveAll(directory); removeErr != nil {
		r.directory = directory
		r.captureStopped = captureStopped
		r.frameIdentity = false
		r.documentIdentityAllowed = false
		r.identitySource = nil
		return fmt.Errorf("%w; remove failed capture directory: %v", cause, removeErr)
	}
	return cause
}

func (r *Recording) begin(capture Capture, target CaptureTarget, directory string, frameIdentity bool) (bool, error) {
	// The preparation decides the output size from the window size at that time, so the same target is prepared again for each recording.
	if err := capture.Open(target); err != nil {
		return true, err
	}
	if err := capture.Start(directory, frameIdentity); err != nil {
		return true, err
	}
	ready, err := capture.Wait()
	if err == nil && !ready {
		err = errors.New("capture did not produce an initial frame")
	}
	if err != nil {
		if _, stopErr := capture.Stop(); stopErr != nil {
			owned, queryErr := capture.HasStream()
			if queryErr != nil {
				return false, fmt.Errorf("%w; stop failed recording: %v; query capture ownership: %v", err, stopErr, queryErr)
			}
			if owned {
				return false, fmt.Errorf("%w; stop failed recording: %v", err, stopErr)
			}
			return true, fmt.Errorf("%w; stop failed recording: %v", err, stopErr)
		}
		return true, err
	}
	return false, nil
}

// FrameIdentityState reports whether the running capture requested identity matching and its selected view root.
func (r *Recording) FrameIdentityState() (bool, *documentFrameIdentitySource) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.identitySource == nil {
		return r.directory != "" && !r.captureStopped && r.frameIdentity && r.documentIdentityAllowed, nil
	}
	source := *r.identitySource
	return r.directory != "" && !r.captureStopped && r.frameIdentity && r.documentIdentityAllowed, &source
}

// SelectFrameIdentitySource binds one current view root to the running identity capture.
func (r *Recording) SelectFrameIdentitySource(surface string, generation uint64) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.directory == "" || r.captureStopped || !r.frameIdentity || !r.documentIdentityAllowed {
		return errors.New("document frame identity requires an active identity capture")
	}
	if surface == "" || generation == 0 {
		return errors.New("document frame identity source requires a surface and generation")
	}
	if r.identitySource != nil {
		return fmt.Errorf("identity capture already selected surface %q generation %d", r.identitySource.surface, r.identitySource.generation)
	}
	r.identitySource = &documentFrameIdentitySource{surface: surface, generation: generation}
	return nil
}

// ClearFrameIdentitySource clears the selected view after its native marker has been removed.
func (r *Recording) ClearFrameIdentitySource(surface string, generation uint64) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.identitySource == nil || r.identitySource.surface != surface || r.identitySource.generation != generation {
		return false
	}
	r.identitySource = nil
	r.documentIdentityAllowed = false
	return true
}

// Abort stops the recording in progress and deletes the folder. It reports a stop error even after native ownership retires.
// It does nothing when there is no recording.
func (r *Recording) Abort(capture Capture) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.directory == "" {
		return nil
	}
	var stopErr error
	if !r.captureStopped {
		if _, err := capture.Stop(); err != nil {
			owned, queryErr := capture.HasStream()
			if queryErr != nil {
				return fmt.Errorf("stop capture: %w; query capture ownership: %v", err, queryErr)
			}
			if owned {
				return fmt.Errorf("stop capture: %w", err)
			}
			r.captureStopped = true
			stopErr = fmt.Errorf("stop capture: %w", err)
		} else {
			r.captureStopped = true
		}
	}
	if err := os.RemoveAll(r.directory); err != nil {
		if stopErr != nil {
			return fmt.Errorf("%w; remove capture directory: %v", stopErr, err)
		}
		return fmt.Errorf("remove capture directory: %w", err)
	}
	r.directory = ""
	r.captureStopped = false
	r.frameIdentity = false
	r.documentIdentityAllowed = false
	r.identitySource = nil
	return stopErr
}

// Finish ends the recording in progress and returns the folder and the number of frames. The requester deletes the folder.
// When stop errors after native ownership retires, it preserves the folder, releases recording ownership, and returns the error.
func (r *Recording) Finish(capture Capture) (string, int, bool, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.captureStopped {
		return "", 0, false, errors.New("capture has stopped but its directory cleanup is incomplete; abort is required")
	}
	directory := r.directory
	if directory == "" {
		return "", 0, false, errors.New("no capture is running")
	}
	frameIdentity := r.frameIdentity
	count, err := capture.Stop()
	if err != nil {
		owned, queryErr := capture.HasStream()
		if queryErr != nil {
			return directory, count, frameIdentity, fmt.Errorf("%w; query capture ownership: %v", err, queryErr)
		}
		if owned {
			return directory, count, frameIdentity, err
		}
	}
	r.directory = ""
	r.captureStopped = false
	r.frameIdentity = false
	if r.identitySource == nil {
		r.documentIdentityAllowed = false
	}
	return directory, count, frameIdentity, err
}

// Running is the owned folder of the active recording or pending cleanup. It is empty when there is no owned folder.
func (r *Recording) Running() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.directory
}
