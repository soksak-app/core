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
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"time"
	"unsafe"

	"github.com/soksak-app/core/packages/host/wailsv3/src/platform"
	"github.com/soksak-app/core/packages/host/wailsv3/src/routine"
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
	diagnosticMethods["diagnostics.clock"] = diagnosticClock
	diagnosticMethods["diagnostics.drag"] = diagnosticDrag
	diagnosticMethods["diagnostics.capture.start"] = diagnosticCaptureStart
	diagnosticMethods["diagnostics.capture.stop"] = diagnosticCaptureStop
	diagnosticMethods["diagnostics.capture.document-identity.start"] = diagnosticCaptureDocumentIdentityStart
	diagnosticMethods["diagnostics.modal.hold"] = diagnosticModalHold
	diagnosticMethods["diagnostics.modal.held"] = diagnosticModalHeld
	diagnosticMethods["diagnostics.presentation.failure"] = diagnosticPresentationFailure
	diagnosticMethods["diagnostics.input.source"] = diagnosticInputSource
	diagnosticMethods["diagnostics.input.reference"] = diagnosticInputReference
	diagnosticMethods["diagnostics.log.flush"] = diagnosticLogFlush
	diagnosticMethods["diagnostics.host.relaunch"] = diagnosticHostRelaunch
	diagnosticMethods["diagnostics.test.mark"] = diagnosticTestMark
	diagnosticMethods["diagnostics.stall.dump"] = diagnosticStallDump
	diagnosticMethods["diagnostics.capture.still"] = diagnosticCaptureStill
	debugCaptures = debugCaptureWindows
	diagnosticMethods["diagnostics.notifications"] = diagnosticNotifications
	holdModalContent = modalHolds.wait
	diagnosticMethods["diagnostics.page.collect"] = diagnosticPageCollect
	diagnosticMethods["diagnostics.native.objects"] = diagnosticNativeObjects
	diagnosticMethods["diagnostics.native.window-color-space"] = diagnosticNativeWindowColorSpace
	diagnosticMethods["diagnostics.objects"] = diagnosticObjects
	diagnosticMethods["diagnostics.heap.profile"] = diagnosticHeapProfile
	diagnosticMethods["diagnostics.process.exit"] = diagnosticProcessExit
	diagnosticMethods["diagnostics.memory.pressure"] = diagnosticMemoryPressure
	diagnosticMethods["diagnostics.page.request"] = diagnosticPageMethod("diagnostics.page.request")
	diagnosticMethods["diagnostics.page.calls"] = diagnosticPageMethod("diagnostics.page.calls")
	diagnosticMethods["diagnostics.document.viewport-marker"] = diagnosticDocumentViewportMarker
	diagnosticMethods["diagnostics.host.events"] = diagnosticHostEvents
	diagnosticMethods["diagnostics.surface.hold"] = diagnosticPageMethod("diagnostics.surface.hold")
	diagnosticMethods["diagnostics.surface.held"] = diagnosticPageMethod("diagnostics.surface.held")
	diagnosticSubscriptions["diagnostics.transcript"] = transcriptTopic
	diagnosticTopics[logTopic] = func(on bool) (string, any) {
		return "diagnostics.transcript", map[string]bool{"on": on}
	}
	transcribe = func(e *Endpoint, window, line string) {
		e.publish(topic{window, logTopic, ""}, "diagnostics.log", map[string]any{"window": window, "line": line})
	}
}

// documentViewportMarkerPlatform is implemented only by platforms that expose the diagnostic native viewport marker.
type documentViewportMarkerPlatform interface {
	SetDocumentViewportMarker(document unsafe.Pointer, enabled bool) (color [3]uint8, borderWidthPt float64, err error)
}

func diagnosticDocumentViewportMarker(e *Endpoint, _ *endpointConn, params json.RawMessage) (any, error) {
	var request struct {
		Window   *string `json:"window"`
		Surface  *string `json:"surface"`
		Document *string `json:"document"`
		Enabled  *bool   `json:"enabled"`
	}
	if err := decode(params, &request); err != nil {
		return nil, err
	}
	if request.Surface == nil || *request.Surface == "" {
		return nil, rpcError(codeInvalidParams, "surface is required and must be non-empty")
	}
	if request.Document == nil || *request.Document == "" {
		return nil, rpcError(codeInvalidParams, "document is required and must be non-empty")
	}
	if request.Enabled == nil {
		return nil, rpcError(codeInvalidParams, "enabled is required and must be a boolean")
	}
	_, s, err := diagnosticHost(e, params)
	if err != nil {
		return nil, err
	}
	marker, ok := system.(documentViewportMarkerPlatform)
	if !ok {
		return nil, errors.New("native document viewport marker is unavailable on this platform")
	}
	if s.invoke == nil {
		return nil, errors.New("document viewport marker has no UI-thread dispatcher")
	}
	var color [3]uint8
	var borderWidthPt float64
	var markerErr error
	key := DocumentKey{Surface: *request.Surface, Name: *request.Document}
	s.invoke(func() {
		document, getErr := s.documents.Get(key)
		if getErr != nil {
			if *request.Enabled {
				markerErr = getErr
				return
			}
			document = nil
		}
		color, borderWidthPt, markerErr = marker.SetDocumentViewportMarker(document, *request.Enabled)
	})
	if markerErr != nil {
		return nil, markerErr
	}
	return struct {
		Enabled       bool     `json:"enabled"`
		Kind          string   `json:"kind"`
		MarkerColor   [3]uint8 `json:"markerColor"`
		BorderWidthPt float64  `json:"borderWidthPt"`
	}{Enabled: *request.Enabled, Kind: "native", MarkerColor: color, BorderWidthPt: borderWidthPt}, nil
}

func diagnosticClock(e *Endpoint, _ *endpointConn, params json.RawMessage) (any, error) {
	if _, err := e.window(params); err != nil {
		return nil, err
	}
	nanos := monotonicNanos()
	if nanos == 0 {
		return nil, errors.New("monotonic clock returned zero")
	}
	return struct {
		MonoNS string `json:"mono_ns"`
	}{MonoNS: strconv.FormatUint(nanos, 10)}, nil
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
	// The project settings file is written in the current numbered form (docs/spec/installation.md#stored-data-migration).
	format, err := sok.SettingsFormat()
	if err != nil {
		return nil, err
	}
	if err := writeJSON(filepath.Join(root, ".soksak", "settings.json"), Record{"format": format}); err != nil {
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

type dragCaptureOptions struct {
	capture       bool
	frameIdentity bool
}

func parseDragCaptureOptions(params json.RawMessage) (dragCaptureOptions, error) {
	var request struct {
		Capture       json.RawMessage `json:"capture"`
		FrameIdentity json.RawMessage `json:"frameIdentity"`
	}
	if err := decode(params, &request); err != nil {
		return dragCaptureOptions{}, err
	}
	options := dragCaptureOptions{}
	if len(request.Capture) != 0 && !bytes.Equal(bytes.TrimSpace(request.Capture), []byte("null")) {
		var capture *bool
		if err := json.Unmarshal(request.Capture, &capture); err != nil || capture == nil {
			return dragCaptureOptions{}, rpcError(codeInvalidParams, "capture must be a boolean")
		}
		options.capture = *capture
	}
	if len(request.FrameIdentity) != 0 {
		var frameIdentity *bool
		if err := json.Unmarshal(request.FrameIdentity, &frameIdentity); err != nil || frameIdentity == nil {
			return dragCaptureOptions{}, rpcError(codeInvalidParams, "frameIdentity must be a boolean")
		}
		options.frameIdentity = *frameIdentity
	}
	if options.frameIdentity && !options.capture {
		return dragCaptureOptions{}, rpcError(codeInvalidParams, "frameIdentity requires capture to be true")
	}
	return options, nil
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

// documentFrameIdentityMu serializes marker setup and capture-stop cleanup around the single active recording.
var documentFrameIdentityMu sync.Mutex

func withDocumentFrameIdentityLifecycle(operation func() error) error {
	documentFrameIdentityMu.Lock()
	defer documentFrameIdentityMu.Unlock()
	return operation()
}

var pendingDocumentFrameIdentityStart chan documentFrameIdentityResult

type documentFrameIdentityResult struct {
	reply json.RawMessage
	err   error
}

// platformCapture is the window recording operation of the platform. after is the last display time to include in the recording when it stops.
type platformCapture struct {
	platform.Capturer
	after float64
}

func (c platformCapture) Open(target CaptureTarget) error {
	return c.CaptureOpen(target.Window, target.Display)
}
func (c platformCapture) Start(directory string, frameIdentity bool) error {
	return c.CaptureStart(directory, frameIdentity)
}
func (c platformCapture) Wait() (bool, error) { return c.CaptureWait() }
func (c platformCapture) Stop() (int, error)  { return c.CaptureStop(c.after) }

func (c platformCapture) Limited() bool { return c.CaptureLimited() }

type captureStatus interface {
	Limited() bool
	LongestGap() float64
}

func captureStopPayload(c captureStatus, directory string, count int, records [][5]float64, frameIdentity bool) map[string]any {
	payload := map[string]any{
		"frames":         directory,
		"callbackStatus": filepath.Join(directory, "callback-status.jsonl"),
		"displayLink":    filepath.Join(directory, "display-link.json"),
		"count":          count,
		"limited":        c.Limited(),
		"longestGap":     c.LongestGap(),
		"layouts":        layoutTrace(records),
	}
	if frameIdentity {
		payload["frameIdentity"] = map[string]any{
			"status":   "complete",
			"manifest": filepath.Join(directory, "frame-identities", "manifest.json"),
		}
	}
	return payload
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
	captureOptions, err := parseDragCaptureOptions(params)
	if err != nil {
		return nil, err
	}
	var p struct {
		dragPlan
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
	if captureOptions.capture {
		err = withDocumentFrameIdentityLifecycle(func() error {
			var startErr error
			frames, startErr = startCapture(h, s, false, captureOptions.frameIdentity, false)
			if startErr != nil {
				return startErr
			}
			capture, captureErr := recorder()
			if captureErr != nil {
				return captureErr
			}
			clock = capture.CaptureClock
			application.InvokeSync(capture.LayoutTraceStart)
			return nil
		})
		if err != nil {
			return nil, err
		}
	}
	var tickMu sync.Mutex
	sent := []float64{}
	ticks := plan.steps() * 2 * plan.Times
	s.note(fmt.Sprintf("diagnostics: drag %s:%d by %g,%g in %d steps, %d times", plan.Axis, plan.Line, plan.DX, plan.DY, plan.steps(), plan.Times))
	stop := make(chan struct{})
	// The tick starts after the request is sent so that the first tick arrives after the page received the drag request.
	reply := h.relay.Request(relayTarget{owner: s}, time.Duration(ticks)*frameStep+pageTimeout, func(id uint64) error {
		s.window.EmitEvent("exposure-request", map[string]any{"id": id, "method": "diagnostics.drag", "params": plan})
		routine.Go("diagnostics-ticks", func() {
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
		})
		return nil
	})
	close(stop)
	result, err := dragResult(s, reply)
	var layouts []map[string]any
	if captureOptions.capture {
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
		if captureOptions.capture {
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
	if captureOptions.capture {
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
func startCapture(h *Host, s *Surfaces, display bool, frameIdentity, documentIdentityAllowed bool) (string, error) {
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
	if err := recording.StartWithDocumentIdentity(capture, CaptureTarget{Window: numbers[0], Display: display}, directory, frameIdentity, documentIdentityAllowed); err != nil {
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
	p, err := parseCaptureStartOptions(params)
	if err != nil {
		return nil, err
	}
	capture, err := recorder()
	if err != nil {
		return nil, err
	}
	var directory string
	err = withDocumentFrameIdentityLifecycle(func() error {
		var startErr error
		directory, startErr = startCapture(h, s, p.Display, p.FrameIdentity, true)
		if startErr != nil {
			return startErr
		}
		application.InvokeSync(capture.LayoutTraceStart)
		return nil
	})
	if err != nil {
		return nil, err
	}
	return map[string]any{"frames": directory}, nil
}

func diagnosticCaptureDocumentIdentityStart(e *Endpoint, _ *endpointConn, params json.RawMessage) (any, error) {
	request, err := parseCaptureDocumentIdentityRequest(params)
	if err != nil {
		return nil, err
	}
	_, s, err := diagnosticHost(e, params)
	if err != nil {
		return nil, err
	}
	documentFrameIdentityMu.Lock()
	defer documentFrameIdentityMu.Unlock()
	active, selected := recording.FrameIdentityState()
	if !active {
		return nil, errors.New("document frame identity requires an active frameIdentity capture")
	}
	if selected != nil {
		return nil, fmt.Errorf("identity capture already selected surface %q generation %d", selected.surface, selected.generation)
	}
	if pendingDocumentFrameIdentityStart != nil {
		select {
		case <-pendingDocumentFrameIdentityStart:
			pendingDocumentFrameIdentityStart = nil
		default:
			return nil, errors.New("a previous document frame identity start is still pending")
		}
	}
	identity, ok := system.(platform.DocumentFrameIdentityCapture)
	if !ok {
		return nil, errors.New("document frame identity is not implemented on this platform")
	}
	if s.invoke == nil {
		return nil, errors.New("document frame identity has no UI-thread dispatcher")
	}
	if err := recording.SelectFrameIdentitySource(request.Surface, request.Generation); err != nil {
		return nil, err
	}
	pending := make(chan documentFrameIdentityResult, 1)
	pendingDocumentFrameIdentityStart = pending
	var dispatchErr error
	s.invoke(func() {
		document, resolveErr := s.documentFrameIdentityRoot(request.Surface, request.Generation)
		if resolveErr != nil {
			dispatchErr = resolveErr
			return
		}
		dispatchErr = identity.StartDocumentFrameIdentity(document, request.Generation, func(reply json.RawMessage, err error) {
			pending <- documentFrameIdentityResult{reply: reply, err: err}
		})
	})
	if dispatchErr != nil {
		pendingDocumentFrameIdentityStart = nil
		recording.ClearFrameIdentitySource(request.Surface, request.Generation)
		return nil, dispatchErr
	}
	var nativeReply json.RawMessage
	select {
	case result := <-pending:
		pendingDocumentFrameIdentityStart = nil
		nativeReply, err = result.reply, result.err
	case <-time.After(pageTimeout):
		return nil, errors.New("document frame identity start did not complete within the diagnostic timeout; its generation remains selected for capture cleanup")
	}
	if err != nil {
		return nil, err
	}
	var reply map[string]any
	if err := validateDocumentFrameIdentityStartReply(nativeReply, request.Generation, &reply); err != nil {
		return nil, fmt.Errorf("native document frame identity start returned invalid JSON metadata: %s", nativeReply)
	}
	reply["surface"] = request.Surface
	reply["generation"] = request.Generation
	return reply, nil
}

type captureDocumentIdentityRequest struct {
	Surface    string
	Generation uint64
}

func parseCaptureDocumentIdentityRequest(params json.RawMessage) (captureDocumentIdentityRequest, error) {
	var request struct {
		Surface    *string `json:"surface"`
		Generation *uint64 `json:"generation"`
	}
	if err := decode(params, &request); err != nil {
		return captureDocumentIdentityRequest{}, err
	}
	if request.Surface == nil || *request.Surface == "" {
		return captureDocumentIdentityRequest{}, rpcError(codeInvalidParams, "surface is required and must be non-empty")
	}
	if request.Generation == nil || *request.Generation == 0 || *request.Generation > maxSourceGeneration {
		return captureDocumentIdentityRequest{}, rpcError(codeInvalidParams, "generation must be a positive JavaScript safe integer")
	}
	return captureDocumentIdentityRequest{Surface: *request.Surface, Generation: *request.Generation}, nil
}

func (s *Surfaces) documentFrameIdentityRoot(surface string, generation uint64) (unsafe.Pointer, error) {
	if surface == "" || generation == 0 {
		return nil, errors.New("document frame identity requires a surface and generation")
	}
	if !s.currentViewGeneration(surface, generation) {
		return nil, fmt.Errorf("view surface %q generation %d is not current", surface, generation)
	}
	document, err := s.documents.Get(DocumentKey{Surface: surface, Name: ""})
	if err != nil {
		return nil, err
	}
	channel, exists := s.documents.view(surface)
	if !exists || channel.generation != generation || channel.handle != document {
		return nil, fmt.Errorf("view surface %q generation %d has no matching root document", surface, generation)
	}
	return document, nil
}

func validateDocumentFrameIdentityStartReply(raw json.RawMessage, generation uint64, reply *map[string]any) error {
	var metadata struct {
		Generation uint64 `json:"generation"`
		AtlasSlots uint64 `json:"atlasSlots"`
		ROI        struct {
			X      *float64 `json:"x"`
			Y      *float64 `json:"y"`
			Width  float64  `json:"width"`
			Height float64  `json:"height"`
			Scale  float64  `json:"scale"`
		} `json:"roi"`
	}
	if err := json.Unmarshal(raw, &metadata); err != nil || metadata.Generation != generation || metadata.AtlasSlots == 0 || metadata.AtlasSlots > 512 ||
		metadata.ROI.X == nil || metadata.ROI.Y == nil || math.IsNaN(*metadata.ROI.X) || math.IsInf(*metadata.ROI.X, 0) || math.IsNaN(*metadata.ROI.Y) || math.IsInf(*metadata.ROI.Y, 0) ||
		!frameIdentityFinitePositive(metadata.ROI.Width) || !frameIdentityFinitePositive(metadata.ROI.Height) || !frameIdentityFinitePositive(metadata.ROI.Scale) {
		return errors.New("invalid native document frame identity metadata")
	}
	if err := json.Unmarshal(raw, reply); err != nil || *reply == nil {
		return errors.New("native document frame identity metadata is not an object")
	}
	return nil
}

func frameIdentityFinitePositive(value float64) bool {
	return value > 0 && !math.IsNaN(value) && !math.IsInf(value, 0)
}

type captureStartOptions struct {
	Display       bool `json:"display"`
	FrameIdentity bool `json:"frameIdentity"`
}

func parseCaptureStartOptions(params json.RawMessage) (captureStartOptions, error) {
	var request struct {
		Display       bool            `json:"display"`
		FrameIdentity json.RawMessage `json:"frameIdentity"`
	}
	if err := decode(params, &request); err != nil {
		return captureStartOptions{}, err
	}
	options := captureStartOptions{Display: request.Display}
	if len(request.FrameIdentity) == 0 {
		return options, nil
	}
	var frameIdentity *bool
	if err := json.Unmarshal(request.FrameIdentity, &frameIdentity); err != nil || frameIdentity == nil {
		return captureStartOptions{}, rpcError(codeInvalidParams, "frameIdentity must be a boolean")
	}
	options.FrameIdentity = *frameIdentity
	return options, nil
}

// diagnosticCaptureStop records up to the display time of after, ends the recording, and returns the frame folder and the number of
// frames.
func diagnosticCaptureStop(e *Endpoint, _ *endpointConn, params json.RawMessage) (any, error) {
	_, s, err := diagnosticHost(e, params)
	if err != nil {
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
	documentFrameIdentityMu.Lock()
	defer documentFrameIdentityMu.Unlock()
	frameIdentity, source := recording.FrameIdentityState()
	var priorStartErr error
	if pendingDocumentFrameIdentityStart != nil {
		select {
		case result := <-pendingDocumentFrameIdentityStart:
			pendingDocumentFrameIdentityStart = nil
			priorStartErr = result.err
		case <-time.After(pageTimeout):
			priorStartErr = errors.New("document frame identity start is still pending at capture stop")
		}
	}
	identity, hasIdentity := system.(platform.DocumentFrameIdentityCapture)
	var directory string
	var count int
	var stoppedWithIdentity bool
	issuedSlots, removed, stopErr := documentIdentityStopSequence(frameIdentity, source, priorStartErr,
		func(generation uint64) (json.RawMessage, error) {
			if !hasIdentity {
				return nil, errors.New("document frame identity is not implemented on this platform")
			}
			return awaitDocumentFrameIdentity(s, func(done func(json.RawMessage, error)) error {
				return identity.FreezeDocumentFrameIdentity(generation, done)
			})
		},
		func() error {
			var finishErr error
			directory, count, stoppedWithIdentity, finishErr = recording.Finish(capture)
			return finishErr
		},
		func(generation uint64) (json.RawMessage, error) {
			if !hasIdentity {
				return nil, errors.New("document frame identity is not implemented on this platform")
			}
			return awaitDocumentFrameIdentity(s, func(done func(json.RawMessage, error)) error {
				return identity.RemoveDocumentFrameIdentity(generation, done)
			})
		})
	// Native callbacks own their cgo handles until completion; detach the timed-out channel so a late result
	// cannot be mistaken for the next capture session. Native generation fencing rejects its stale producer.
	pendingDocumentFrameIdentityStart = nil
	if source != nil && removed {
		recording.ClearFrameIdentitySource(source.surface, source.generation)
	}
	var records [][5]float64
	var layoutErr error
	application.InvokeSync(func() { records, layoutErr = capture.LayoutTraceStop() })
	if stopErr != nil {
		return nil, errors.Join(stopErr, layoutErr)
	}
	if layoutErr != nil {
		return nil, layoutErr
	}
	payload, err := finishCaptureStop(captureStatusAdapter{capture}, directory, count, stoppedWithIdentity, func() ([][5]float64, error) { return records, nil })
	if err != nil {
		return nil, err
	}
	if issuedSlots != nil {
		payload.(map[string]any)["frameIdentity"].(map[string]any)["issuedSlots"] = *issuedSlots
	}
	return payload, nil
}

func documentIdentityStopSequence(
	frameIdentity bool,
	source *documentFrameIdentitySource,
	priorStartErr error,
	freeze func(uint64) (json.RawMessage, error),
	stop func() error,
	remove func(uint64) (json.RawMessage, error),
) (*uint64, bool, error) {
	var failures []error
	if priorStartErr != nil {
		failures = append(failures, priorStartErr)
	}
	var frozen json.RawMessage
	if source != nil {
		var err error
		frozen, err = freeze(source.generation)
		if err != nil {
			failures = append(failures, fmt.Errorf("freeze document frame identity: %w", err))
		}
	}
	if err := stop(); err != nil {
		failures = append(failures, fmt.Errorf("stop capture: %w", err))
	}
	removed := source == nil
	if source != nil {
		removedJSON, err := remove(source.generation)
		if err != nil {
			failures = append(failures, fmt.Errorf("remove document frame identity: %w", err))
		} else if err := documentFrameIdentityRemoved(removedJSON, source.generation); err != nil {
			failures = append(failures, err)
		} else {
			removed = true
		}
	}
	if len(failures) != 0 {
		return nil, removed, errors.Join(failures...)
	}
	if source == nil {
		return nil, true, nil
	}
	issued, err := documentFrameIdentityIssuedSlots(frozen, source.generation)
	if err != nil {
		return nil, removed, err
	}
	return &issued, removed, nil
}

func documentFrameIdentityRemoved(raw json.RawMessage, generation uint64) error {
	var reply struct {
		Generation uint64 `json:"generation"`
		Removed    bool   `json:"removed"`
	}
	if err := json.Unmarshal(raw, &reply); err != nil || reply.Generation != generation || !reply.Removed {
		return fmt.Errorf("native document frame identity remove returned invalid metadata for generation %d: %s", generation, raw)
	}
	return nil
}

func awaitDocumentFrameIdentity(s *Surfaces, schedule func(func(json.RawMessage, error)) error) (json.RawMessage, error) {
	if s.invoke == nil {
		return nil, errors.New("document frame identity has no UI-thread dispatcher")
	}
	done := make(chan struct {
		reply json.RawMessage
		err   error
	}, 1)
	var scheduleErr error
	s.invoke(func() {
		scheduleErr = schedule(func(reply json.RawMessage, err error) {
			done <- struct {
				reply json.RawMessage
				err   error
			}{reply: reply, err: err}
		})
	})
	if scheduleErr != nil {
		return nil, scheduleErr
	}
	select {
	case result := <-done:
		return result.reply, result.err
	case <-time.After(pageTimeout):
		return nil, errors.New("document frame identity native operation did not complete within the diagnostic timeout")
	}
}

func documentFrameIdentityIssuedSlots(raw json.RawMessage, generation uint64) (uint64, error) {
	var reply struct {
		Generation  uint64  `json:"generation"`
		AtlasSlots  uint64  `json:"atlasSlots"`
		IssuedSlots *uint64 `json:"issuedSlots"`
	}
	if err := json.Unmarshal(raw, &reply); err != nil || reply.Generation != generation || reply.AtlasSlots == 0 || reply.AtlasSlots > 512 || reply.IssuedSlots == nil || *reply.IssuedSlots > reply.AtlasSlots {
		return 0, fmt.Errorf("native document frame identity freeze returned invalid metadata for generation %d: %s", generation, raw)
	}
	return *reply.IssuedSlots, nil
}

func finishCaptureStop(c captureStatus, directory string, count int, frameIdentity bool, layoutTrace func() ([][5]float64, error)) (any, error) {
	records, err := layoutTrace()
	if err != nil {
		return nil, err
	}
	return captureStopPayload(c, directory, count, records, frameIdentity), nil
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

// diagnosticHostRelaunch quits the application as host.quit does and starts it again with the same executable and
// arguments once this process has ended, so the new process reads the files that a check left in the configuration
// folder (docs/spec/endpoint.md#diagnostic-builds). It replies once the quit has begun.
func diagnosticHostRelaunch(e *Endpoint, _ *endpointConn, params json.RawMessage) (any, error) {
	h, _, err := diagnosticHost(e, params)
	if err != nil {
		return nil, err
	}
	executable, err := os.Executable()
	if err != nil {
		return nil, fmt.Errorf("application relaunch: %w", err)
	}
	command, err := PrepareAppRelaunch(executable, os.Getpid(), os.Args[1:])
	if err != nil {
		return nil, err
	}
	h.mu.Lock()
	h.update = &pendingStart{command: command, relaunch: true}
	h.mu.Unlock()
	routine.Go("quit", application.Get().Quit)
	return nil, nil
}

// diagnosticTestMark stores the start or the end of a test as an event and replies with the position of its line.
func diagnosticTestMark(e *Endpoint, _ *endpointConn, params json.RawMessage) (any, error) {
	if _, err := e.window(params); err != nil {
		return nil, err
	}
	mark, err := ParseTestMark(params)
	if err != nil {
		return nil, err
	}
	boot, seq, err := EmitTestMark(mark, 10*time.Second)
	if err != nil {
		return nil, err
	}
	return map[string]any{"boot": boot, "seq": seq}, nil
}

// diagnosticStallDump stores the path of a stall dump that the window check wrote as an event and replies with the position of its line.
func diagnosticStallDump(e *Endpoint, _ *endpointConn, params json.RawMessage) (any, error) {
	if _, err := e.window(params); err != nil {
		return nil, err
	}
	path, err := ParseStallDump(params)
	if err != nil {
		return nil, err
	}
	boot, seq, err := EmitStallDump(path, 10*time.Second)
	if err != nil {
		return nil, err
	}
	return map[string]any{"boot": boot, "seq": seq}, nil
}

func parseInputReference(params json.RawMessage) (string, *string, error) {
	var values map[string]json.RawMessage
	if err := json.Unmarshal(params, &values); err != nil {
		return "", nil, rpcError(codeInvalidParams, "input reference params must be an object")
	}
	var action string
	if err := json.Unmarshal(values["action"], &action); err != nil || (action != "open" && action != "read" && action != "focus" && action != "wait-document" && action != "wait" && action != "close") {
		return "", nil, rpcError(codeInvalidParams, "input reference action must be open, read, focus, wait-document, wait or close")
	}
	raw, hasDocument := values["document"]
	if action != "wait" && action != "wait-document" {
		if hasDocument {
			return "", nil, rpcError(codeInvalidParams, "input reference document is only for wait-document and wait")
		}
		return action, nil, nil
	}
	var document *string
	if !hasDocument || json.Unmarshal(raw, &document) != nil || document == nil {
		return "", nil, rpcError(codeInvalidParams, "input reference wait-document and wait require a document string")
	}
	return action, document, nil
}

func diagnosticInputReference(e *Endpoint, _ *endpointConn, params json.RawMessage) (any, error) {
	action, document, err := parseInputReference(params)
	if err != nil {
		return nil, err
	}
	_, s, err := diagnosticHost(e, params)
	if err != nil {
		return nil, err
	}
	reference, ok := system.(platform.InputReference)
	if !ok {
		return nil, errors.New("input reference is not implemented on this platform")
	}
	type result struct {
		value   json.RawMessage
		failure error
	}
	answer := make(chan result, 1)
	application.InvokeSync(func() {
		reference.InputReference(s.window.NativeWindow(), action, document, func(value json.RawMessage, failure error) {
			answer <- result{value, failure}
		})
	})
	reply := <-answer
	return reply.value, reply.failure
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
	if p.Select != nil {
		adopted := make(chan error, 1)
		application.InvokeSync(func() {
			sources.SelectInputSource(*p.Select, func(failure error) { adopted <- failure })
		})
		if err := <-adopted; err != nil {
			return nil, err
		}
	}
	application.InvokeSync(func() { current, err = sources.InputSource() })
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

// maxHostEvents is the most events of one diagnostics.host.events request (docs/spec/endpoint.md).
const maxHostEvents = 1000

// diagnosticHostEvents sends count host events diagnostics-unlistened, for which the page declares no listener, to the main page of the window.
func diagnosticHostEvents(e *Endpoint, _ *endpointConn, params json.RawMessage) (any, error) {
	_, s, err := diagnosticHost(e, params)
	if err != nil {
		return nil, err
	}
	var p struct {
		Count any `json:"count"`
	}
	if err := decode(params, &p); err != nil {
		return nil, err
	}
	count, ok := p.Count.(float64)
	if !ok || count != math.Trunc(count) || count < 1 || count > maxHostEvents {
		return nil, rpcError(codeInvalidParams, "diagnostics.host.events requires a count from 1 to %d", maxHostEvents)
	}
	for range int(count) {
		s.Emit("diagnostics-unlistened")
	}
	return map[string]int{"count": int(count)}, nil
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

type nativeWindowColorSpaceFacts struct {
	Name      *string `json:"name"`
	ICCSHA256 *string `json:"iccSHA256"`
}

func diagnosticNativeWindowColorSpace(e *Endpoint, _ *endpointConn, params json.RawMessage) (any, error) {
	_, surfaces, err := diagnosticHost(e, params)
	if err != nil {
		return nil, err
	}
	var facts nativeWindowColorSpaceFacts
	if err := surfaces.nativeFacts(system.WindowColorSpace, &facts, nil); err != nil {
		return nil, err
	}
	return facts, nil
}

// pageAnswer is the count of the main page (main is true) or of the document region key.
type pageAnswer struct {
	key    DocumentKey
	main   bool
	counts PageObjects
	err    error
}

// diagnosticObjects returns the object counts of the window (docs/spec/endpoint.md) that the diagnostic backend counts, and the figures of the
// Go runtime.
func diagnosticObjects(e *Endpoint, _ *endpointConn, params json.RawMessage) (any, error) {
	window, err := e.window(params)
	if err != nil {
		return nil, err
	}
	counter, ok := e.backend.(ObjectCounter)
	if !ok {
		return nil, errors.New("diagnostics.objects needs a backend that counts objects")
	}
	counts, err := counter.ObjectCounts(window)
	if err != nil {
		return nil, err
	}
	figures, err := RuntimeMemory()
	if err != nil {
		return nil, err
	}
	payload := counts.Payload()
	payload["runtime"] = figures
	return payload, nil
}

// ObjectCounts counts the objects of the window: the registries of the host, the elements and documents of the main page, and the elements and
// documents of each created document region. The document handles are read and counted on the UI thread, which closes a document region, so
// no handle is used after its region is closed.
func (b hostBackend) ObjectCounts(window string) (ObjectCounts, error) {
	h := b.h
	s := h.byName(window)
	if s == nil {
		return ObjectCounts{}, errMissingWindow(window)
	}
	counter, ok := system.(platform.PageObjectCounter)
	if !ok {
		return ObjectCounts{}, errors.New("page object counts are not implemented on this platform")
	}
	var views, pages int
	var answers chan pageAnswer
	var err error
	application.InvokeSync(func() {
		views = s.surfaceCount()
		var main unsafe.Pointer
		main, err = system.MainWebview(s.window.NativeWindow())
		if err != nil {
			return
		}
		attached := s.documents.Attached()
		answers = make(chan pageAnswer, 1+len(attached))
		counter.CountPageObjects(main, false, func(elements, documents int64, err error) {
			answers <- pageAnswer{main: true, counts: PageObjects{Elements: elements, Documents: documents}, err: err}
		})
		for key, handle := range attached {
			counter.CountPageObjects(handle, true, func(elements, documents int64, err error) {
				answers <- pageAnswer{key: key, counts: PageObjects{Elements: elements, Documents: documents}, err: err}
			})
		}
		pages = 1 + len(attached)
	})
	if err != nil {
		return ObjectCounts{}, err
	}
	var counts ObjectCounts
	var failure error
	timeout := time.After(pageTimeout)
	for i := 0; i < pages; i++ {
		select {
		case answer := <-answers:
			if answer.err != nil {
				failure = errors.Join(failure, answer.err)
			} else if answer.main {
				counts.Page = answer.counts
			} else {
				counts.Documents = append(counts.Documents, DocumentObjects{Key: answer.key, Counts: answer.counts})
			}
		case <-timeout:
			return ObjectCounts{}, rpcError(codeTimeout, "the page did not answer the object counts within %s", pageTimeout)
		}
	}
	if failure != nil {
		return ObjectCounts{}, failure
	}
	counts.Sessions = s.sidecars.Sessions(s)
	counts.Host = HostObjects{
		Surfaces:         int64(views),
		Regions:          int64(s.images.Count()),
		Documents:        int64(s.documents.Count()),
		SidecarSessions:  int64(len(counts.Sessions)),
		PendingReplies:   int64(s.sidecars.PendingCount(s) + h.relay.Pending(func(target relayTarget) bool { return target.owner == s })),
		EventSubscribers: int64(h.endpoint.SubscriberCount(s.name)),
	}
	return counts, nil
}

// diagnosticHeapProfile writes the heap profile of the Go runtime to the diagnostic folder of the configuration directory and replies its path.
func diagnosticHeapProfile(e *Endpoint, _ *endpointConn, params json.RawMessage) (any, error) {
	h, _, err := diagnosticHost(e, params)
	if err != nil {
		return nil, err
	}
	path, err := WriteHeapProfile(filepath.Join(h.workspace.directory, "logs"))
	if err != nil {
		return nil, err
	}
	return map[string]any{"path": path}, nil
}

// diagnosticMemoryPressure delivers a memory pressure level as the source of the process delivers it, so a check observes the
// report that the pages receive (docs/spec/hosts.md#memory-pressure).
func diagnosticMemoryPressure(e *Endpoint, _ *endpointConn, params json.RawMessage) (any, error) {
	if _, err := e.window(params); err != nil {
		return nil, err
	}
	var p struct {
		Level json.RawMessage `json:"level"`
	}
	if err := decode(params, &p); err != nil {
		return nil, err
	}
	level, err := ParseMemoryPressureLevel(p.Level)
	if err != nil {
		return nil, rpcError(codeInvalidParams, "%s", err)
	}
	var injected error
	application.InvokeSync(func() { injected = system.InjectMemoryPressure(level) })
	return nil, injected
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
