//go:build diagnostics

// The state of the diagnostic recording. It is compiled only with the diagnostics build tag.
//
// There is one recording at a time. A failed start removes its folder: the native start ends its recording when it fails. A stop
// ends the native recording also when it fails, so a stop error releases the recording. A remaining recording or cleanup folder
// blocks the next recording.

package host

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"

	"github.com/soksak-app/core/packages/host/go/src/platform"
	"github.com/soksak-app/core/packages/host/go/src/routine"
)

// CaptureTarget is the recording target. With Display, the windows of this app on the display that holds the window are recorded.
// A window recording stops when the window is moved to another Space (full screen).
type CaptureTarget struct {
	Window  int
	Display bool
}

// CapturePlan is the plan of the stills of a recording: Gap is the time in ms from the request of one still to the request of
// the next, and the length is Seconds or Frames, the other 0.
type CapturePlan struct {
	Gap     float64
	Seconds float64
	Frames  int
}

// Capture is the recording device. The platform implementation or a fake of a check provides it.
type Capture interface {
	// Open makes the window with the window server number target.Window the recording target. An error leaves no new
	// active recording and leaves any existing active recording unchanged.
	Open(target CaptureTarget) error
	// Start starts the recording of plan in directory and returns once still 0 is written. A failed start ends its recording.
	Start(directory string, plan CapturePlan, frameIdentity bool) error
	// Stop ends the recording and returns the number of written frames. The recording ends also when Stop fails.
	Stop() (int, error)
}

// NewWindowCapture is a recording device that also records a new window from its first still: it holds the next show of a window
// that is not on screen, and the start of the recording of that window puts it on screen.
type NewWindowCapture interface {
	Capture
	// HoldNewWindow holds the next show of a window that is not on screen.
	HoldNewWindow() error
	// WaitNewWindow waits until a show was held and returns the window server number of that window. It gives registerEnd the
	// end of its wait; an ended wait shows a held window and fails with `no new window was shown before <reason>`.
	WaitNewWindow(registerEnd func(end func(reason string))) (int, error)
	// ReleaseNewWindow ends the hold at once and shows a held window.
	ReleaseNewWindow()
}

// Recording is the folder of the recording in progress. The zero value is used.
type Recording struct {
	mu                      sync.Mutex
	directory               string
	captureStopped          bool
	frameIdentity           bool
	documentIdentityAllowed bool
	identitySource          *documentFrameIdentitySource
	// window is the window server number of the recorded window, nil for a display recording and for a new window that no
	// show has given yet.
	window *int
	// pending is the start of the recording of a new window that runs after StartNewWindow returned (newWindowStart).
	pending *newWindowStart
}

// newWindowStart is the start of the recording of a new window: the wait for the held window, then the open and the start of its
// recording, which returns once still 0 is written. done receives its failure once, nil for a start that succeeded.
type newWindowStart struct {
	done chan error
	// window is the number of the held window, written before done receives nil.
	window int
	mu     sync.Mutex
	end    func(reason string)
	// ended is the reason of an end that came before the wait gave its end.
	ended string
}

// stop ends the wait for the held window; a wait that has already returned is not changed by it.
func (p *newWindowStart) stop(reason string) {
	p.mu.Lock()
	end := p.end
	if end == nil {
		p.ended = reason
	}
	p.mu.Unlock()
	if end != nil {
		end(reason)
	}
}

func (p *newWindowStart) registerEnd(end func(reason string)) {
	p.mu.Lock()
	p.end = end
	ended := p.ended
	p.mu.Unlock()
	if ended != "" {
		end(ended)
	}
}

// newWindowStopReason is the end of the wait for a held window that the stop of the recording gives.
const newWindowStopReason = "the stop of the recording"

type documentFrameIdentitySource struct {
	surface    string
	generation uint64
}

// Start creates directory and starts recording target into that folder with plan. It returns after still 0 is written.
// When cleanup after a failure is incomplete, the owned folder and stop state remain until Abort completes cleanup.
func (r *Recording) Start(capture Capture, target CaptureTarget, directory string, plan CapturePlan, frameIdentity bool) error {
	return r.StartWithDocumentIdentity(capture, target, directory, plan, frameIdentity, false)
}

// StartWithDocumentIdentity marks diagnostics.capture.start recordings as eligible for one document source.
func (r *Recording) StartWithDocumentIdentity(capture Capture, target CaptureTarget, directory string, plan CapturePlan, frameIdentity, documentIdentityAllowed bool) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if err := r.createDirectory(directory); err != nil {
		return err
	}
	if err := begin(capture, target, directory, plan, frameIdentity); err != nil {
		return r.removeFailedStartDirectory(directory, err)
	}
	r.directory = directory
	r.captureStopped = false
	r.frameIdentity = frameIdentity
	r.documentIdentityAllowed = documentIdentityAllowed
	r.identitySource = nil
	r.window = nil
	if !target.Display {
		window := target.Window
		r.window = &window
	}
	return nil
}

// createDirectory creates the private folder of a new recording; it fails while a recording or its cleanup owns a folder.
func (r *Recording) createDirectory(directory string) error {
	if r.directory != "" {
		return fmt.Errorf("a capture into %s is running", r.directory)
	}
	if r.identitySource != nil {
		return fmt.Errorf("document frame identity cleanup for surface %q generation %d is incomplete", r.identitySource.surface, r.identitySource.generation)
	}
	if err := os.MkdirAll(filepath.Dir(directory), 0o700); err != nil {
		return err
	}
	if err := os.Mkdir(directory, 0o700); err != nil {
		return fmt.Errorf("create capture directory: %w", err)
	}
	system, err := platform.Current()
	if err == nil {
		err = system.PrivateDirectory(directory)
	}
	if err != nil {
		return r.removeFailedStartDirectory(directory, err)
	}
	return nil
}

// StartNewWindow holds the next show of a window that is not on screen and returns once the hold is set, owning directory. The
// recording of that window then starts without this call: once the application shows a window, the recording opens on it and
// starts with plan, and the start puts the window on screen, so still 0 of the recording holds the first content of the window.
// A failure after the hold took a window shows that window. Finish and Abort end a hold that no show took and report the result
// of the start.
func (r *Recording) StartNewWindow(capture NewWindowCapture, directory string, plan CapturePlan, frameIdentity bool) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if err := r.createDirectory(directory); err != nil {
		return err
	}
	if err := capture.HoldNewWindow(); err != nil {
		return r.removeFailedStartDirectory(directory, err)
	}
	pending := &newWindowStart{done: make(chan error, 1)}
	r.directory = directory
	r.captureStopped = false
	r.frameIdentity = frameIdentity
	r.documentIdentityAllowed = false
	r.identitySource = nil
	r.window = nil
	r.pending = pending
	routine.Go("new-window-recording", func() {
		number, err := capture.WaitNewWindow(pending.registerEnd)
		if err != nil {
			pending.done <- err
			return
		}
		err = begin(capture, CaptureTarget{Window: number}, directory, plan, frameIdentity)
		if err != nil {
			capture.ReleaseNewWindow()
		}
		pending.window = number
		pending.done <- err
	})
	return nil
}

// settleNewWindow waits for the start of the recording of a new window, ending a hold that no show took, and returns the failure
// of that start. A failed start leaves no native recording, so the recording then owns only its folder. Call it with mu held.
func (r *Recording) settleNewWindow() error {
	pending := r.pending
	if pending == nil {
		return nil
	}
	pending.stop(newWindowStopReason)
	err := <-pending.done
	r.pending = nil
	if err == nil {
		window := pending.window
		r.window = &window
		return nil
	}
	r.captureStopped = true
	return err
}

// removeFailedStartDirectory removes the folder of a start that failed with cause, which left no native recording. A folder that
// cannot be removed stays owned until Abort removes it.
func (r *Recording) removeFailedStartDirectory(directory string, cause error) error {
	if removeErr := os.RemoveAll(directory); removeErr != nil {
		r.directory = directory
		r.captureStopped = true
		r.frameIdentity = false
		r.documentIdentityAllowed = false
		r.identitySource = nil
		r.window = nil
		return fmt.Errorf("%w; remove failed capture directory: %v", cause, removeErr)
	}
	return cause
}

// begin opens target and starts its recording with plan in directory. It returns once still 0 is written; a failure leaves no
// native recording.
func begin(capture Capture, target CaptureTarget, directory string, plan CapturePlan, frameIdentity bool) error {
	// The preparation reads the windows of the target at that time, so the same target is prepared again for each recording.
	if err := capture.Open(target); err != nil {
		return err
	}
	return capture.Start(directory, plan, frameIdentity)
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

// Abort stops the recording in progress and deletes the folder. It reports a stop error, after which the native recording has
// ended. It does nothing when there is no recording.
func (r *Recording) Abort(capture Capture) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.directory == "" {
		return nil
	}
	var stopErr error
	if err := r.settleNewWindow(); err != nil && r.captureStopped {
		stopErr = err
	}
	if !r.captureStopped {
		if _, err := capture.Stop(); err != nil {
			stopErr = fmt.Errorf("stop capture: %w", err)
		}
		r.captureStopped = true
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
	r.window = nil
	return stopErr
}

// Finish ends the recording in progress and returns the folder, the number of frames, whether it has frame identity and the
// window server number of its window, nil for a display recording. The requester deletes the folder. A stop error ends the
// native recording too: Finish then preserves the folder, releases the recording, and returns the error.
func (r *Recording) Finish(capture Capture) (string, int, bool, *int, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.captureStopped {
		return "", 0, false, nil, errors.New("capture has stopped but its directory cleanup is incomplete; abort is required")
	}
	directory := r.directory
	if directory == "" {
		return "", 0, false, nil, errors.New("no capture is running")
	}
	frameIdentity := r.frameIdentity
	if err := r.settleNewWindow(); err != nil {
		// The start failed before a recording ran: the requester owns the folder, which keeps what was written.
		if r.captureStopped {
			r.directory = ""
			r.captureStopped = false
			r.frameIdentity = false
			r.window = nil
		}
		return directory, 0, frameIdentity, nil, err
	}
	window := r.window
	count, err := capture.Stop()
	r.directory = ""
	r.captureStopped = false
	r.frameIdentity = false
	r.window = nil
	if r.identitySource == nil {
		r.documentIdentityAllowed = false
	}
	return directory, count, frameIdentity, window, err
}

// Running is the owned folder of the active recording or pending cleanup. It is empty when there is no owned folder.
func (r *Recording) Running() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.directory
}
