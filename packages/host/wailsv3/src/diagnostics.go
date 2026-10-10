//go:build diagnostics

// Endpoint methods of the diagnostic build.
//
// This file is compiled only with the diagnostics build tag and adds methods to diagnosticMethods in init.
// Other builds do not declare these methods, so the endpoint closes the connection. The form is
// defined in the diagnostic build section of docs/spec/endpoint.md.
//
// The page cannot read the composited result on the screen. Surfaces and modals are OS views that this application created, and the window server
// performs the composition, so a recording names a window number instead of a screen region.

package host

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sync"
	"time"
	"unsafe"

	"github.com/soksak-app/core/packages/host/wailsv3/src/platform"
	sok "github.com/soksak-app/core/packages/sok/wailsv3/src"
	"github.com/wailsapp/wails/v3/pkg/application"
)

func init() {
	// --registry-ca is the certificate authority that the registry download trusts (docs/spec/hosts.md#application-arguments).
	declaredArguments["registry-ca"] = func(options *Options) *string { return &options.RegistryCA }
	argumentEffects = append(argumentEffects, func(options Options) error {
		if options.RegistryCA == "" {
			return nil
		}
		if err := sok.UseRegistryAuthorities(options.RegistryCA); err != nil {
			return fmt.Errorf("--registry-ca %w", err)
		}
		return nil
	})
	diagnosticPlugins = true
	diagnosticMethods["diagnostics.fixture"] = diagnosticFixture
	diagnosticMethods["diagnostics.drag"] = diagnosticDrag
	diagnosticMethods["diagnostics.capture.start"] = diagnosticCaptureStart
	diagnosticMethods["diagnostics.capture.stop"] = diagnosticCaptureStop
	diagnosticMethods["diagnostics.modal.hold"] = diagnosticModalHold
	diagnosticMethods["diagnostics.modal.held"] = diagnosticModalHeld
	diagnosticMethods["diagnostics.presentation.failure"] = diagnosticPresentationFailure
	diagnosticMethods["diagnostics.input.source"] = diagnosticInputSource
	diagnosticMethods["diagnostics.log.flush"] = diagnosticLogFlush
	diagnosticMethods["diagnostics.capture.still"] = diagnosticCaptureStill
	debugCaptures = debugCaptureWindows
	diagnosticMethods["diagnostics.notifications"] = diagnosticNotifications
	holdModalContent = modalHolds.wait
	diagnosticMethods["diagnostics.navigation.delay"] = diagnosticNavigationDelay
	diagnosticMethods["diagnostics.page.collect"] = diagnosticPageCollect
	diagnosticMethods["diagnostics.native.objects"] = diagnosticNativeObjects
	diagnosticMethods["diagnostics.process.exit"] = diagnosticProcessExit
	diagnosticMethods["diagnostics.page.request"] = diagnosticPageMethod("diagnostics.page.request")
	diagnosticMethods["diagnostics.surface.hold"] = diagnosticPageMethod("diagnostics.surface.hold")
	diagnosticMethods["diagnostics.surface.held"] = diagnosticPageMethod("diagnostics.surface.held")
	handleNavigation = navigationDelays.handle
	diagnosticSubscriptions["diagnostics.transcript"] = transcriptTopic
	diagnosticTopics[logTopic] = func(on bool) (string, any) {
		return "diagnostics.transcript", map[string]bool{"on": on}
	}
	transcribe = func(e *Endpoint, window, line string) {
		e.publish(topic{window, logTopic, ""}, "diagnostics.log", map[string]any{"window": window, "line": line})
	}
}

// logTopic is the topic name of a connection that receives diagnostics.log notifications. Status names are lowercase
// and separated by dots, so they do not collide with this value.
const logTopic = "#diagnostics.log"

// frameStep is the length of one step of a drag. The page counts the steps with the same value.
const frameStep = 16 * time.Millisecond

// diagnosticHost returns the host of the endpoint.
func diagnosticHost(e *Endpoint, params json.RawMessage) (*Host, *Surfaces, error) {
	window, err := e.window(params)
	if err != nil {
		return nil, nil, err
	}
	backend, ok := e.backend.(hostBackend)
	if !ok {
		return nil, nil, errors.New("diagnostic methods need the application host")
	}
	s := backend.h.byName(window)
	if s == nil {
		return nil, nil, errMissingWindow(window)
	}
	return backend.h, s, nil
}

// diagnosticPageMethod sends a diagnostic method that the main page handles to that page. The exposure reply of a surface must be held
// before it leaves the page so that it arrives after the request ends, so the page handles diagnostics.surface.hold and diagnostics.surface.held
// (docs/spec/endpoint.md).
func diagnosticPageMethod(method string) endpointMethod {
	return func(e *Endpoint, _ *endpointConn, params json.RawMessage) (any, error) {
		h, s, err := diagnosticHost(e, params)
		if err != nil {
			return nil, err
		}
		return h.ask(s, method, params, pageTimeout)
	}
}

func diagnosticPresentationFailure(e *Endpoint, _ *endpointConn, params json.RawMessage) (any, error) {
	_, s, err := diagnosticHost(e, params)
	if err != nil {
		return nil, err
	}
	var injectErr error
	application.InvokeSync(func() { injectErr = system.InjectSettledFailure(s.window.NativeWindow()) })
	if injectErr != nil {
		return nil, injectErr
	}
	return nil, nil
}

// diagnosticFixture creates <config-dir>/test-project as an empty folder configuration and makes the page close other
// projects, reset the common settings to their defaults, and open that project with a new layout.
func diagnosticFixture(e *Endpoint, _ *endpointConn, params json.RawMessage) (any, error) {
	h, s, err := diagnosticHost(e, params)
	if err != nil {
		return nil, err
	}
	root := filepath.Join(h.workspace.directory, "test-project")
	system, err := platform.Current()
	if err != nil {
		return nil, err
	}
	if err := system.PrivateDirectory(filepath.Join(root, ".soksak")); err != nil {
		return nil, err
	}
	if err := writeJSON(filepath.Join(root, ".soksak", "settings.json"), Record{}); err != nil {
		return nil, err
	}
	// settings are the common settings applied over the defaults. When given, it must be an object.
	var request struct {
		Settings json.RawMessage `json:"settings"`
	}
	if err := json.Unmarshal(params, &request); err != nil {
		return nil, err
	}
	page := map[string]any{"root": root}
	if len(request.Settings) > 0 {
		var settings map[string]any
		if err := json.Unmarshal(request.Settings, &settings); err != nil || settings == nil {
			return nil, fmt.Errorf("diagnostics.fixture settings must be an object")
		}
		page["settings"] = settings
	}
	return h.ask(s, "diagnostics.fixture", page, pageTimeout)
}

// dragPlan is a drag that goes to a boundary and back. Each iteration is a round trip, so the boundary returns to its place.
type dragPlan struct {
	Axis  string  `json:"axis"`
	Line  int     `json:"line"`
	DX    float64 `json:"dx"`
	DY    float64 `json:"dy"`
	MS    int     `json:"ms"`
	Times int     `json:"times"`
}

// steps is the number of steps of a one-way move. The page counts them in the same way.
func (p dragPlan) steps() int {
	if n := int(math.Round(float64(p.MS) / float64(frameStep/time.Millisecond))); n > 1 {
		return n
	}
	return 1
}

// recording is a recording in progress.
var recording Recording

// platformCapture is the window recording operation of the platform. after is the last display time to include in the recording when it stops.
type platformCapture struct {
	platform.Capturer
	after float64
}

func (c platformCapture) Open(target CaptureTarget) error {
	return c.CaptureOpen(target.Window, target.Display)
}
func (c platformCapture) Start(directory string) error { return c.CaptureStart(directory) }
func (c platformCapture) Wait() (bool, error)          { return c.CaptureWait() }
func (c platformCapture) Stop() (int, error)           { return c.CaptureStop(c.after) }

func (c platformCapture) Limited() bool { return c.CaptureLimited() }

type captureStatus interface {
	Limited() bool
	LongestGap() float64
}

func captureStopPayload(c captureStatus, directory string, count int, records [][5]float64) map[string]any {
	return map[string]any{
		"frames":     directory,
		"count":      count,
		"limited":    c.Limited(),
		"longestGap": c.LongestGap(),
		"layouts":    layoutTrace(records),
	}
}

// recorder returns the recording device of this platform.
func recorder() (platformCapture, error) {
	capturer, ok := system.(platform.Capturer)
	if !ok {
		return platformCapture{}, errors.New("window capture is not implemented on this platform")
	}
	return platformCapture{Capturer: capturer}, nil
}

// diagnosticDrag requests a drag from the page and sends the time of each step.
//
// The page finds the boundary and applies the input at each step. When the window is not in front, the browser
// slows the clock of the document, so the host sends the time of each step as a diagnostics-tick event. When the page finishes the drag and
// replies, the host waits until the last layout is displayed and then replies.
func diagnosticDrag(e *Endpoint, _ *endpointConn, params json.RawMessage) (any, error) {
	h, s, err := diagnosticHost(e, params)
	if err != nil {
		return nil, err
	}
	var p struct {
		dragPlan
		Capture bool `json:"capture"`
	}
	if err := decode(params, &p); err != nil {
		return nil, err
	}
	plan := p.dragPlan
	if plan.Axis != "x" && plan.Axis != "y" {
		return nil, rpcError(codeInvalidParams, "axis must be x or y")
	}
	if plan.MS <= 0 || plan.Times < 1 {
		return nil, rpcError(codeInvalidParams, "ms must be positive and times must be at least 1")
	}
	var frames string
	// When recording, the time at which the step was sent is recorded on the same clock as the frames. This allows measuring the delay from a step to the screen.
	var clock func() float64
	if p.Capture {
		frames, err = startCapture(h, s, false)
		if err != nil {
			return nil, err
		}
		capture, err := recorder()
		if err != nil {
			return nil, err
		}
		clock = capture.CaptureClock
		application.InvokeSync(capture.LayoutTraceStart)
	}
	var tickMu sync.Mutex
	sent := []float64{}
	ticks := plan.steps() * 2 * plan.Times
	s.note(fmt.Sprintf("diagnostics: drag %s:%d by %g,%g in %d steps, %d times", plan.Axis, plan.Line, plan.DX, plan.DY, plan.steps(), plan.Times))
	stop := make(chan struct{})
	// The tick starts after the request is sent so that the first tick arrives after the page received the drag request.
	reply := h.relay.Request(relayTarget{owner: s}, time.Duration(ticks)*frameStep+pageTimeout, func(id uint64) error {
		s.window.EmitEvent("exposure-request", map[string]any{"id": id, "method": "diagnostics.drag", "params": plan})
		go func() {
			tick := time.NewTicker(frameStep)
			defer tick.Stop()
			for left := ticks; left > 0; left-- {
				select {
				case <-tick.C:
					if clock != nil {
						tickMu.Lock()
						sent = append(sent, clock())
						tickMu.Unlock()
					}
					s.window.EmitEvent("diagnostics-tick")
				case <-stop:
					return
				}
			}
		}()
		return nil
	})
	close(stop)
	result, err := dragResult(s, reply)
	var layouts []map[string]any
	if p.Capture {
		if capture, captureErr := recorder(); captureErr == nil {
			var records [][5]float64
			var traceErr error
			application.InvokeSync(func() { records, traceErr = capture.LayoutTraceStop() })
			err = errors.Join(err, traceErr)
			layouts = layoutTrace(records)
		} else {
			err = errors.Join(err, captureErr)
		}
	}
	if err != nil {
		// When the requester does not receive the frame folder, the recording stops and the folder is deleted.
		if p.Capture {
			if capture, captureErr := recorder(); captureErr == nil {
				if abortErr := recording.Abort(capture); abortErr != nil {
					err = fmt.Errorf("%w; abort capture: %v", err, abortErr)
				}
			} else {
				err = errors.Join(err, captureErr)
			}
		}
		return nil, err
	}
	if p.Capture {
		result["frames"] = frames
		tickMu.Lock()
		result["ticks"] = append([]float64(nil), sent...)
		tickMu.Unlock()
		result["layouts"] = layouts
	}
	return result, nil
}

// layoutTrace converts the layout transaction record to {ticket, begun, presented, committed}. A stage that did not happen is null.
func layoutTrace(records [][5]float64) []map[string]any {
	layouts := make([]map[string]any, 0, len(records))
	stage := func(value float64) any {
		if math.IsNaN(value) {
			return nil
		}
		return value
	}
	for _, record := range records {
		layouts = append(layouts, map[string]any{
			"ticket": uint64(record[0]), "begun": stage(record[1]), "requested": stage(record[4]), "presented": stage(record[2]), "committed": stage(record[3]),
		})
	}
	return layouts
}

// dragResult checks the drag reply of the page, waits until the last layout is displayed, and returns the result.
func dragResult(s *Surfaces, reply ExposureResult) (map[string]any, error) {
	if reply.Error != nil {
		return nil, reply.Error
	}
	select {
	case <-s.whenSettled():
	case <-time.After(pageTimeout):
		return nil, rpcError(codeTimeout, "the drag was not presented within %s", pageTimeout)
	}
	s.note("diagnostics: drag presented")
	result := map[string]any{}
	if len(reply.Result) > 0 && string(reply.Result) != "null" {
		if err := json.Unmarshal(reply.Result, &result); err != nil {
			return nil, fmt.Errorf("the page drag result is not an object: %w", err)
		}
	}
	return result, nil
}

// startCapture starts the recording of window s in a new folder under the configuration directory and waits for the first frame.
// With display, it records the windows of this application on the display that holds the window.
func startCapture(h *Host, s *Surfaces, display bool) (string, error) {
	capture, err := recorder()
	if err != nil {
		return "", err
	}
	// The window list query of the window server waits for a reply, so only the window number is read on the main thread.
	var numbers []int
	application.InvokeSync(func() { numbers, err = capture.WindowNumbers(s.window.NativeWindow()) })
	if err != nil {
		return "", err
	}
	if len(numbers) == 0 {
		return "", errors.New("the window has no window server number")
	}
	directory := filepath.Join(h.workspace.directory, "logs", "captures", fmt.Sprintf("%s-%d", s.name, time.Now().UnixNano()))
	if err := recording.Start(capture, CaptureTarget{Window: numbers[0], Display: display}, directory); err != nil {
		return "", err
	}
	return directory, nil
}

// diagnosticCaptureStill takes one picture of a window without giving it focus, writes it to <config-dir>/captures/still-*/window.png, and returns
// the path. It is observation material for visual checks during development, and the requester deletes that directory after checking.
func diagnosticCaptureStill(e *Endpoint, _ *endpointConn, params json.RawMessage) (any, error) {
	h, s, err := diagnosticHost(e, params)
	if err != nil {
		return nil, err
	}
	path, err := captureStill(h, s)
	if err != nil {
		return nil, err
	}
	return map[string]string{"path": path}, nil
}

// captureStill writes a still PNG of the window of s into a private folder under <config-dir>/logs/captures and
// returns its path.
func captureStill(h *Host, s *Surfaces) (string, error) {
	capture, err := recorder()
	if err != nil {
		return "", err
	}
	var numbers []int
	application.InvokeSync(func() { numbers, err = capture.WindowNumbers(s.window.NativeWindow()) })
	if err != nil {
		return "", err
	}
	if len(numbers) == 0 {
		return "", errors.New("the window has no window server number")
	}
	// As with a recording, each capture creates a private directory.
	directory := filepath.Join(h.workspace.directory, "logs", "captures", fmt.Sprintf("still-%s-%d", s.name, time.Now().UnixNano()))
	system, err := platform.Current()
	if err != nil {
		return "", err
	}
	if err := system.PrivateDirectory(directory); err != nil {
		return "", err
	}
	path := filepath.Join(directory, "window.png")
	if err := capture.CaptureStill(numbers[0], path); err != nil {
		return "", err
	}
	return path, nil
}

// debugCaptureWindows writes a still capture of each window for the debug view (docs/spec/debug.md).
func debugCaptureWindows(h *Host) ([]string, error) {
	h.mu.Lock()
	windows := make([]*Surfaces, 0, len(h.windows))
	for _, s := range h.windows {
		windows = append(windows, s)
	}
	h.mu.Unlock()
	paths := []string{}
	for _, s := range windows {
		path, err := captureStill(h, s)
		if err != nil {
			return paths, fmt.Errorf("window %s: %w", s.name, err)
		}
		paths = append(paths, path)
	}
	return paths, nil
}

// diagnosticCaptureStart starts the window recording and returns the frame folder.
func diagnosticCaptureStart(e *Endpoint, _ *endpointConn, params json.RawMessage) (any, error) {
	h, s, err := diagnosticHost(e, params)
	if err != nil {
		return nil, err
	}
	var p struct {
		Display bool `json:"display"`
	}
	if err := decode(params, &p); err != nil {
		return nil, err
	}
	capture, err := recorder()
	if err != nil {
		return nil, err
	}
	directory, err := startCapture(h, s, p.Display)
	if err != nil {
		return nil, err
	}
	application.InvokeSync(capture.LayoutTraceStart)
	return map[string]any{"frames": directory}, nil
}

// diagnosticCaptureStop records up to the display time of after, ends the recording, and returns the frame folder and the number of
// frames.
func diagnosticCaptureStop(e *Endpoint, _ *endpointConn, params json.RawMessage) (any, error) {
	if _, _, err := diagnosticHost(e, params); err != nil {
		return nil, err
	}
	var p struct {
		After *float64 `json:"after"`
	}
	if err := decode(params, &p); err != nil {
		return nil, err
	}
	capture, err := recorder()
	if err != nil {
		return nil, err
	}
	if p.After != nil {
		if *p.After < 0 {
			return nil, rpcError(codeInvalidParams, "after must not be negative")
		}
		capture.after = *p.After
	}
	directory, count, err := recording.Finish(capture)
	if err != nil {
		return nil, err
	}
	var records [][5]float64
	application.InvokeSync(func() { records, err = capture.LayoutTraceStop() })
	if err != nil {
		return nil, errors.Join(err, os.RemoveAll(directory))
	}
	return captureStopPayload(captureStatusAdapter{capture}, directory, count, records), nil
}

type captureStatusAdapter struct{ platformCapture }

func (c captureStatusAdapter) Limited() bool       { return c.CaptureLimited() }
func (c captureStatusAdapter) LongestGap() float64 { return c.CaptureLongestGap() }

// diagnosticInputSource selects that input source when select is given, and returns the currently selected keyboard input source.
// diagnosticLogFlush waits until the records written so far are in the event log of the host.
func diagnosticLogFlush(e *Endpoint, _ *endpointConn, params json.RawMessage) (any, error) {
	if _, err := e.window(params); err != nil {
		return nil, err
	}
	return nil, FlushRecords(10 * time.Second)
}

func diagnosticInputSource(e *Endpoint, _ *endpointConn, params json.RawMessage) (any, error) {
	if _, err := e.window(params); err != nil {
		return nil, err
	}
	var p struct {
		Select *string `json:"select"`
	}
	if err := decode(params, &p); err != nil {
		return nil, err
	}
	if p.Select != nil && *p.Select == "" {
		return nil, rpcError(codeInvalidParams, "select must be a non-empty string")
	}
	sources, ok := system.(platform.InputSources)
	if !ok {
		return nil, errors.New("keyboard input sources are not implemented on this platform")
	}
	var current string
	var err error
	application.InvokeSync(func() {
		if p.Select != nil {
			if err = sources.SelectInputSource(*p.Select); err != nil {
				return
			}
		}
		current, err = sources.InputSource()
	})
	if err != nil {
		return nil, err
	}
	return map[string]string{"current": current}, nil
}

// transcriptTopic reads the diagnostics.log subscription and direction of the connection from the params of diagnostics.transcript.
// The page receives the start and end of the call record at the first subscription and the last release.
func transcriptTopic(e *Endpoint, params json.RawMessage) (topic, bool, error) {
	window, err := e.window(params)
	if err != nil {
		return topic{}, false, err
	}
	var p struct {
		On *bool `json:"on"`
	}
	if err := decode(params, &p); err != nil {
		return topic{}, false, err
	}
	if p.On == nil {
		return topic{}, false, rpcError(codeInvalidParams, "on is required")
	}
	return topic{window, logTopic, ""}, *p.On, nil
}

// modalHold is a held modal content reply of one window.
type modalHold struct {
	// The held reply is sent when release closes.
	release chan struct{}
	// held closes when the first reply is held.
	held chan struct{}
	once sync.Once
}

// modalHoldSet holds the modal content reply per window. A check creates the order in which a modal document receives its first content later than the following
// events.
type modalHoldSet struct {
	mu      sync.Mutex
	windows map[*Surfaces]*modalHold
}

var modalHolds = &modalHoldSet{windows: map[*Surfaces]*modalHold{}}

// wait does not return while the reply of window s is held.
func (set *modalHoldSet) wait(s *Surfaces) {
	set.mu.Lock()
	hold := set.windows[s]
	set.mu.Unlock()
	if hold == nil {
		return
	}
	hold.once.Do(func() { close(hold.held) })
	<-hold.release
}

// diagnosticModalHold starts holding the modal content reply of the window when on is set; otherwise it sends the held reply
// and stops holding.
func diagnosticModalHold(e *Endpoint, _ *endpointConn, params json.RawMessage) (any, error) {
	_, s, err := diagnosticHost(e, params)
	if err != nil {
		return nil, err
	}
	var p struct {
		On *bool `json:"on"`
	}
	if err := decode(params, &p); err != nil {
		return nil, err
	}
	if p.On == nil {
		return nil, rpcError(codeInvalidParams, "on is required")
	}
	modalHolds.mu.Lock()
	defer modalHolds.mu.Unlock()
	hold := modalHolds.windows[s]
	switch {
	case *p.On && hold == nil:
		modalHolds.windows[s] = &modalHold{release: make(chan struct{}), held: make(chan struct{})}
	case !*p.On && hold != nil:
		close(hold.release)
		delete(modalHolds.windows, s)
	}
	return nil, nil
}

// diagnosticModalHeld replies when the window has held one modal content reply.
// diagnosticNotifications returns the notifications of this application that the notification center still shows.
func diagnosticNotifications(e *Endpoint, _ *endpointConn, params json.RawMessage) (any, error) {
	if _, _, err := diagnosticHost(e, params); err != nil {
		return nil, err
	}
	capture, err := recorder()
	if err != nil {
		return nil, err
	}
	answer := make(chan string, 1)
	application.InvokeSync(func() { capture.DeliveredNotifications(func(list string) { answer <- list }) })
	select {
	case list := <-answer:
		var delivered []map[string]string
		if err := json.Unmarshal([]byte(list), &delivered); err != nil {
			return nil, fmt.Errorf("delivered notifications %q: %w", list, err)
		}
		return delivered, nil
	case <-time.After(pageTimeout):
		return nil, rpcError(codeTimeout, "the notification center did not list delivered notifications within %s", pageTimeout)
	}
}

func diagnosticModalHeld(e *Endpoint, _ *endpointConn, params json.RawMessage) (any, error) {
	_, s, err := diagnosticHost(e, params)
	if err != nil {
		return nil, err
	}
	modalHolds.mu.Lock()
	hold := modalHolds.windows[s]
	modalHolds.mu.Unlock()
	if hold == nil {
		return nil, errors.New("modal content answers are not held in this window")
	}
	select {
	case <-hold.held:
	case <-hold.release:
	}
	return nil, nil
}

// navigationDelaySet is the time by which the handling of the main webview navigation callback is delayed for each window.
type navigationDelaySet struct {
	mu      sync.Mutex
	windows map[*Surfaces]time.Duration
}

var navigationDelays = navigationDelaySet{windows: map[*Surfaces]time.Duration{}}

// diagnosticPageCollect makes the WebContent process of the app page of the window collect JavaScript objects. It is called before a memory check measures so that
// the check measures the remaining memory independently of the collection time.
func diagnosticPageCollect(e *Endpoint, _ *endpointConn, params json.RawMessage) (any, error) {
	_, s, err := diagnosticHost(e, params)
	if err != nil {
		return nil, err
	}
	application.InvokeSync(func() {
		var main unsafe.Pointer
		if main, err = system.MainWebview(s.window.NativeWindow()); err == nil {
			err = system.CollectGarbage(main)
		}
	})
	return nil, err
}

// diagnosticNativeObjects returns the number of live library objects attached to windows and web views after the application handled one event.
// The objects of a closed window are released when the autorelease pool of the event loop iteration that closed the window is drained, and the pool is drained when the application
// handles an event. A window check inserts one event so that it can measure the release of a closed window without user input, and counts after it.
// AppKit keeps a window that was on the screen until its close animation ends, so with equal the method replies when the count becomes equal to equal.
func diagnosticNativeObjects(e *Endpoint, _ *endpointConn, params json.RawMessage) (any, error) {
	if _, _, err := diagnosticHost(e, params); err != nil {
		return nil, err
	}
	var p struct {
		Equal json.RawMessage `json:"equal"`
	}
	if err := decode(params, &p); err != nil {
		return nil, err
	}
	var expected *platform.WindowObjects
	if p.Equal != nil {
		equal, err := platform.ParseWindowObjects(p.Equal)
		if err != nil {
			return nil, rpcError(codeInvalidParams, "%s", err)
		}
		expected = &equal
	}
	counter, ok := system.(platform.WindowObjectCounter)
	if !ok {
		return nil, errors.New("window object counts are not implemented on this platform")
	}
	type answer struct {
		counts  platform.WindowObjects
		reached bool
	}
	answers := make(chan answer, 1)
	application.InvokeSync(func() {
		counter.WindowObjectsWhen(expected, pageTimeout.Seconds(), func(counts platform.WindowObjects, reached bool) {
			answers <- answer{counts, reached}
		})
	})
	// The library replies within pageTimeout after it handles the event, so the wait is doubled to include the event handling time.
	select {
	case a := <-answers:
		if !a.reached {
			return nil, rpcError(codeTimeout, "window object counts did not reach %s within %s; they are %s", expected, pageTimeout, a.counts)
		}
		return a.counts.Payload(), nil
	case <-time.After(2 * pageTimeout):
		return nil, rpcError(codeTimeout, "the application did not handle an event within %s", pageTimeout)
	}
}

// diagnosticProcessExit replies when the process pid ends. A window check waits for the WebContent process of a closed window to end through
// the exit notification of the kernel.
func diagnosticProcessExit(e *Endpoint, _ *endpointConn, params json.RawMessage) (any, error) {
	if _, _, err := diagnosticHost(e, params); err != nil {
		return nil, err
	}
	var p struct {
		Pid json.RawMessage `json:"pid"`
	}
	if err := decode(params, &p); err != nil {
		return nil, err
	}
	pid, err := platform.ParseProcessID(p.Pid)
	if err != nil {
		return nil, rpcError(codeInvalidParams, "%s", err)
	}
	waiter, ok := system.(platform.ProcessExitWaiter)
	if !ok {
		return nil, errors.New("process exit waits are not implemented on this platform")
	}
	answers := make(chan bool, 1)
	application.InvokeSync(func() {
		waiter.WhenProcessExited(pid, pageTimeout.Seconds(), func(exited bool) { answers <- exited })
	})
	// The library replies within pageTimeout, so the wait is doubled to include the time for the main thread to send the reply.
	select {
	case exited := <-answers:
		if !exited {
			return nil, rpcError(codeTimeout, "process %d did not exit within %s", pid, pageTimeout)
		}
		return nil, nil
	case <-time.After(2 * pageTimeout):
		return nil, rpcError(codeTimeout, "the application did not answer within %s", 2*pageTimeout)
	}
}

// diagnosticNavigationDelay delays the later navigation callback handling of the window by ms milliseconds. 0 removes the delay.
func diagnosticNavigationDelay(e *Endpoint, _ *endpointConn, params json.RawMessage) (any, error) {
	_, s, err := diagnosticHost(e, params)
	if err != nil {
		return nil, err
	}
	var p struct {
		Ms *float64 `json:"ms"`
	}
	if err := decode(params, &p); err != nil {
		return nil, err
	}
	if p.Ms == nil || *p.Ms != math.Trunc(*p.Ms) || *p.Ms < 0 || *p.Ms > 10000 {
		return nil, rpcError(codeInvalidParams, "ms must be an integer from 0 to 10000")
	}
	navigationDelays.mu.Lock()
	defer navigationDelays.mu.Unlock()
	if *p.Ms == 0 {
		delete(navigationDelays.windows, s)
	} else {
		navigationDelays.windows[s] = time.Duration(*p.Ms) * time.Millisecond
	}
	return nil, nil
}

// handle waits for the delay of the window, runs the callback handling, and records in the diagnostic record that it finished.
func (d *navigationDelaySet) handle(s *Surfaces, handle func()) {
	d.mu.Lock()
	delay := d.windows[s]
	d.mu.Unlock()
	time.Sleep(delay)
	handle()
	s.note(fmt.Sprintf("navigation callback handled after %d ms", delay.Milliseconds()))
}
