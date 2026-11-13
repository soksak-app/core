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
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"sync"
	"sync/atomic"
	"time"
	"unsafe"

	"github.com/soksak-app/core/packages/host/go/src/platform"
	"github.com/soksak-app/core/packages/host/go/src/routine"
	sok "github.com/soksak-app/core/packages/sok/go/src"
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
	diagnosticMethods["diagnostics.layout.trace"] = diagnosticLayoutTrace
	diagnosticMethods["diagnostics.modal.hold"] = onModalWebViews(diagnosticModalHold)
	diagnosticMethods["diagnostics.modal.held"] = onModalWebViews(diagnosticModalHeld)
	diagnosticMethods["diagnostics.presentation.failure"] = diagnosticPresentationFailure
	diagnosticMethods["diagnostics.window.draw-covered"] = diagnosticWindowDrawCovered
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
	diagnosticWindowClosed = endWindowHolds
	diagnosticPageEnded = func(s *Surfaces) { endNativeWaits(s, waitEndPage) }
	diagnosticMethods["diagnostics.page.collect"] = onMainPage(diagnosticPageCollect)
	diagnosticMethods["diagnostics.native.objects"] = diagnosticNativeObjects
	diagnosticMethods["diagnostics.native.window-color-space"] = diagnosticNativeWindowColorSpace
	diagnosticMethods["diagnostics.objects"] = diagnosticObjects
	diagnosticMethods["diagnostics.heap.profile"] = diagnosticHeapProfile
	diagnosticMethods["diagnostics.cpu.profile"] = diagnosticCPUProfile
	diagnosticMethods["diagnostics.gc.loop"] = diagnosticGCLoop
	diagnosticMethods["diagnostics.process.exit"] = diagnosticProcessExit
	diagnosticMethods["diagnostics.memory.pressure"] = diagnosticMemoryPressure
	diagnosticMethods["diagnostics.page.request"] = onMainPage(diagnosticPageMethod("diagnostics.page.request"))
	diagnosticMethods["diagnostics.page.calls"] = onMainPage(diagnosticPageMethod("diagnostics.page.calls"))
	diagnosticMethods["diagnostics.document.viewport-marker"] = diagnosticDocumentViewportMarker
	diagnosticMethods["diagnostics.host.events"] = onMainPage(diagnosticHostEvents)
	diagnosticMethods["diagnostics.surface.hold"] = diagnosticSurfaceHold
	diagnosticMethods["diagnostics.surface.held"] = diagnosticPageMethod("diagnostics.surface.held")
	diagnosticMethods["diagnostics.layout.fail"] = diagnosticPageMethod("diagnostics.layout.fail")
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

func diagnosticDocumentViewportMarker(e *Endpoint, _ *endpointConn, params json.RawMessage, _ *ReplyScope) (any, error) {
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

func diagnosticClock(e *Endpoint, _ *endpointConn, params json.RawMessage, _ *ReplyScope) (any, error) {
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

// The ends of a native wait for an event that may not come (docs/spec/endpoint.md): no limit ends it.
const (
	waitEndConnection = "the endpoint connection of the request closed"
	waitEndWindow     = "the window closed"
	waitEndPage       = "the page of the window ended"
)

// nativeWait is a native wait of a window that has not answered. ended takes the first end that the connection of its request,
// its window or its page gives it.
type nativeWait struct {
	once  sync.Once
	ended func(reason string)
}

func (w *nativeWait) end(reason string) { w.once.Do(func() { w.ended(reason) }) }

// nativeWaits holds the native waits of each window that have not answered.
var nativeWaits = struct {
	mu      sync.Mutex
	windows map[*Surfaces]map[*nativeWait]struct{}
}{windows: map[*Surfaces]map[*nativeWait]struct{}{}}

// registerNativeWait keeps w among the waits of window s until remove.
func registerNativeWait(s *Surfaces, w *nativeWait) (remove func()) {
	nativeWaits.mu.Lock()
	if nativeWaits.windows[s] == nil {
		nativeWaits.windows[s] = map[*nativeWait]struct{}{}
	}
	nativeWaits.windows[s][w] = struct{}{}
	nativeWaits.mu.Unlock()
	return func() {
		nativeWaits.mu.Lock()
		delete(nativeWaits.windows[s], w)
		nativeWaits.mu.Unlock()
	}
}

// endNativeWaits ends the native waits of window s that have not answered, naming reason.
func endNativeWaits(s *Surfaces, reason string) {
	nativeWaits.mu.Lock()
	waits := nativeWaits.windows[s]
	delete(nativeWaits.windows, s)
	nativeWaits.mu.Unlock()
	for w := range waits {
		w.end(reason)
	}
}

// awaitNative starts a native wait of window s on the UI thread and returns its answer. The wait ends by its answer or by the
// first of the close of the endpoint connection c of the request, the close of the window and the end of its page; end then
// makes the library answer, given the reason of that end, and the reason is returned with the answer. An answer that came
// first has no reason.
func awaitNative[T any](s *Surfaces, c *endpointConn, start func(answer func(T)) (end func(reason string))) (T, string) {
	answers := make(chan T, 1)
	ended := make(chan string, 1)
	defer registerNativeWait(s, &nativeWait{ended: func(reason string) { ended <- reason }})()
	var end func(reason string)
	mainThreadStep(func() { end = start(func(v T) { answers <- v }) })
	var connection <-chan struct{}
	if c != nil {
		connection = c.done
	}
	var reason string
	select {
	case v := <-answers:
		return v, ""
	case <-connection:
		reason = waitEndConnection
	case reason = <-ended:
	}
	// The library answers an ended wait before end returns, and a wait that answered already keeps its answer.
	mainThreadStep(func() { end(reason) })
	return <-answers, reason
}

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

// onMainPage is a method that acts on the main page of a window: a framework without a main page answers it with an error.
func onMainPage(method endpointMethod) endpointMethod { return onlyWith("main page", method) }

// onModalWebViews is a method that acts on the modal web views of a window, which a framework without a main page does not have.
func onModalWebViews(method endpointMethod) endpointMethod {
	return onlyWith("modal web views", method)
}

func onlyWith(subject string, method endpointMethod) endpointMethod {
	return func(e *Endpoint, c *endpointConn, params json.RawMessage, reply *ReplyScope) (any, error) {
		if _, _, err := diagnosticHost(e, params); err != nil {
			return nil, err
		}
		if !framework.MainPage() {
			return nil, fmt.Errorf("the %s host has no %s", framework.ApplicationName(), subject)
		}
		return method(e, c, params, reply)
	}
}

// diagnosticPageMethod sends a diagnostic method that the main page handles to that page. The exposure reply of a surface must be held
// before it leaves the page so that it arrives after the request ends, so the page handles diagnostics.surface.hold and diagnostics.surface.held
// (docs/spec/endpoint.md).
func diagnosticPageMethod(method string) endpointMethod {
	return func(e *Endpoint, _ *endpointConn, params json.RawMessage, reply *ReplyScope) (any, error) {
		h, s, err := diagnosticHost(e, params)
		if err != nil {
			return nil, err
		}
		return h.ask(reply.Context(), s, method, params)
	}
}

func diagnosticPresentationFailure(e *Endpoint, _ *endpointConn, params json.RawMessage, _ *ReplyScope) (any, error) {
	_, s, err := diagnosticHost(e, params)
	if err != nil {
		return nil, err
	}
	var injectErr error
	mainThreadStep(func() { injectErr = system.InjectSettledFailure(s.window.NativeWindow()) })
	if injectErr != nil {
		return nil, injectErr
	}
	return nil, nil
}

// documentDrawCoveredPlatform is implemented only by platforms that make the document regions of a window draw while it is
// covered.
type documentDrawCoveredPlatform interface {
	DrawDocumentsCovered(window platform.Window, draw bool) error
}

// diagnosticWindowDrawCovered makes the image regions and the documents of the document regions of the window draw while the
// window is covered, or ends that, and sends the drawing state that changed. The window keeps reporting its occlusion
// (docs/spec/native-surfaces.md#image-regions, docs/spec/native-surfaces.md#document-regions).
func diagnosticWindowDrawCovered(e *Endpoint, _ *endpointConn, params json.RawMessage, _ *ReplyScope) (any, error) {
	_, s, err := diagnosticHost(e, params)
	if err != nil {
		return nil, err
	}
	var p struct {
		Draw *bool `json:"draw"`
	}
	if err := decode(params, &p); err != nil {
		return nil, err
	}
	if p.Draw == nil {
		return nil, rpcError(codeInvalidParams, "draw is required")
	}
	documents, ok := system.(documentDrawCoveredPlatform)
	if !ok {
		return nil, errors.New("the covered drawing of document regions is unavailable on this platform")
	}
	if err := s.useWindow(func(window platform.Window) error { return documents.DrawDocumentsCovered(window, *p.Draw) }); err != nil {
		return nil, nativeError(codeHandler, err)
	}
	s.images.SetDrawCovered(*p.Draw)
	if err := s.sendImageDrawing(); err != nil {
		return nil, err
	}
	return nil, nil
}

// diagnosticFixture creates <config-dir>/test-project as an empty folder configuration and makes the page close other
// projects, reset the common settings to their defaults, and open that project with a new layout.
func diagnosticFixture(e *Endpoint, _ *endpointConn, params json.RawMessage, reply *ReplyScope) (any, error) {
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
	// The project settings file is written in the current numbered form (docs/spec/installation.md#stored-data-formats).
	settings := []byte(fmt.Sprintf("{\"format\": %d}\n", settingsFormat))
	if err := system.WritePrivateFile(filepath.Join(root, ".soksak", "settings.json"), settings); err != nil {
		return nil, err
	}
	// settings are the common settings applied over the defaults. When given, it must be an object.
	var request struct {
		Settings     json.RawMessage `json:"settings"`
		DebugEntries json.RawMessage `json:"debugEntries"`
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
	if len(request.DebugEntries) > 0 {
		var entries []json.RawMessage
		if err := json.Unmarshal(request.DebugEntries, &entries); err != nil || entries == nil {
			return nil, fmt.Errorf("diagnostics.fixture debugEntries must be an array")
		}
		page["debugEntries"] = request.DebugEntries
	}
	return h.ask(reply.Context(), s, "diagnostics.fixture", page)
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
	capture bool
	plan    CapturePlan
}

func parseDragCaptureOptions(params json.RawMessage) (dragCaptureOptions, error) {
	var request struct {
		Capture json.RawMessage `json:"capture"`
	}
	if err := decode(params, &request); err != nil {
		return dragCaptureOptions{}, err
	}
	options := dragCaptureOptions{}
	// capture is absent, null or false for a drag without a recording, or the plan of the recording, which
	// diagnostics.capture.start checks with the same messages.
	if raw := bytes.TrimSpace(request.Capture); len(raw) != 0 && !bytes.Equal(raw, []byte("null")) && !bytes.Equal(raw, []byte("false")) {
		if raw[0] != '{' {
			return dragCaptureOptions{}, rpcError(codeInvalidParams, "capture must be false or a plan {gap, seconds | frames}")
		}
		plan, err := parseCapturePlan(raw)
		if err != nil {
			return dragCaptureOptions{}, err
		}
		options.capture = true
		options.plan = plan
	}
	return options, nil
}

// parseDragNative reads native, which makes the host deliver the drag as native pointer input instead of the page
// (docs/spec/endpoint.md). It is false when absent.
func parseDragNative(params json.RawMessage) (bool, error) {
	var request struct {
		Native json.RawMessage `json:"native"`
	}
	if err := decode(params, &request); err != nil {
		return false, err
	}
	if len(request.Native) == 0 {
		return false, nil
	}
	var native *bool
	if err := json.Unmarshal(request.Native, &native); err != nil || native == nil {
		return false, rpcError(codeInvalidParams, "native must be a boolean")
	}
	return *native, nil
}

// nativeDrag delivers the drag of plan from the boundary point from as native input of the primary button, as a person
// drags: for each round trip a press at from, each step as a drag of the button at from plus the offset times the
// fraction of the step, out and back, and a release at from after the last step. deliver delivers one input without
// activating the window or the application, step(previous) returns at the host time of the next step, one display period
// after previous, the host time of the step before it, and answers that time, and presented returns when
// the window has presented its current layout; it runs before each press, because a press goes where the last frame
// drew. A failed input after a press releases the button at the last point, so no press stays open in the window. The
// reply is {from, steps, took, asked, pressWaits, tripSteps}: took is the time from the first press to the last release without
// the waits before the presses, on clock, the clock of the host, asked the time that the steps ask, and pressWaits the wait before
// each press, all in milliseconds, and tripSteps the number of steps of each round trip.
func nativeDrag(plan dragPlan, from point, clock func() time.Duration, deliver func(PointerInput) error, step func(previous time.Duration) (time.Duration, error), presented func() error) (map[string]any, error) {
	span := float64(plan.MS) * float64(time.Millisecond)
	at := func(fraction float64) point {
		return point{X: from.X + plan.DX*fraction, Y: from.Y + plan.DY*fraction}
	}
	input := func(phase string, p point) PointerInput {
		return PointerInput{Pointer: mainPointer, X: p.X, Y: p.Y, Phase: phase, Button: "left", Clicks: 1}
	}
	began := clock()
	var waited time.Duration
	pressWaits := make([]int64, 0, plan.Times)
	tripSteps := make([]int, 0, plan.Times)
	steps := 0
	for turn := 0; turn < plan.Times; turn++ {
		tripStart := steps
		waiting := clock()
		// A person moves to the point before the press. An application that is not active takes the move into its virtual key
		// window, so the press and the steps after it pass the application as a person's do and the buttons that a person
		// holds do not enter the gesture (docs/spec/exposure.md#virtual-key-window).
		if err := deliver(input("move", from)); err != nil {
			return nil, fmt.Errorf("native drag move before the press of round trip %d: %w", turn+1, err)
		}
		if err := presented(); err != nil {
			return nil, fmt.Errorf("native drag wait before the press of round trip %d: %w", turn+1, err)
		}
		wait := clock() - waiting
		waited += wait
		pressWaits = append(pressWaits, wait.Milliseconds())
		if err := deliver(input("down", from)); err != nil {
			return nil, fmt.Errorf("native drag press of round trip %d: %w", turn+1, err)
		}
		last := from
		// Each leg runs until its elapsed time reaches plan.MS, so the position follows the time of the host and
		// not a count of steps fixed in advance. The steps are the refreshes that the window presented.
		for _, back := range []bool{false, true} {
			legStart := clock()
			// The period of a step runs from the time of the step before it, so the delivery of an input, which is inside the
			// period, does not lengthen the step (docs/spec/diagnostics.md).
			previous := legStart
			for {
				taken, err := step(previous)
				if err != nil {
					err = fmt.Errorf("native drag step %d: %w", steps+1, err)
					if released := deliver(input("up", last)); released != nil {
						err = fmt.Errorf("%w; release after the failed step: %v", err, released)
					}
					return nil, err
				}
				previous = taken
				steps++
				elapsed := float64(clock()-legStart) / span
				fraction := math.Min(elapsed, 1)
				if back {
					fraction = 1 - fraction
				}
				last = at(fraction)
				if err := deliver(input("drag", last)); err != nil {
					err = fmt.Errorf("native drag step %d: %w", steps, err)
					if released := deliver(input("up", last)); released != nil {
						err = fmt.Errorf("%w; release after the failed step: %v", err, released)
					}
					return nil, err
				}
				if elapsed >= 1 {
					break
				}
			}
		}
		if err := deliver(input("up", from)); err != nil {
			return nil, fmt.Errorf("native drag release of round trip %d: %w", turn+1, err)
		}
		tripSteps = append(tripSteps, steps-tripStart)
	}
	return map[string]any{"from": from, "steps": steps, "took": (clock() - began - waited).Milliseconds(),
		"asked": plan.Times * 2 * plan.MS, "pressWaits": pressWaits, "tripSteps": tripSteps}, nil
}

// nextStep waits with sleep until one period after previous, the host time of the step before, and answers the host time of
// the step: that time, or now when the delivery of the step before outlasted the period, so a late step does not bring the
// steps after it closer than one period.
func nextStep(previous, period, now time.Duration, sleep func(time.Duration)) time.Duration {
	at := previous + period
	if at <= now {
		return now
	}
	sleep(at - now)
	return at
}

// stepPeriod is the length of one step at refreshRate, the refresh rate of the display that shows the window at the
// moment the step is taken. A missing rate is an error: no step length is assumed.
func stepPeriod(refreshRate *int) (time.Duration, error) {
	if refreshRate == nil || *refreshRate <= 0 {
		return 0, errors.New("the window is on no display with a refresh rate")
	}
	return time.Second / time.Duration(*refreshRate), nil
}

// refreshRate reads the refresh rate of the display that shows the window now, or nil when the window is on no screen.
func (s *Surfaces) refreshRate() (*int, error) {
	var facts windowFacts
	err := s.nativeFacts(func(window platform.Window) (string, error) { return system.WindowFacts(window) }, &facts, nil)
	if err != nil {
		return nil, err
	}
	return facts.RefreshRate, nil
}

// recording is a recording in progress.
var recording Recording

// platformCapture is the window recording operation of the platform. after is the time from which a still must be requested before
// the recording stops, 0 for a stop that requests no later still. window and connection are the window and the endpoint connection
// of the request, whose ends end the waits of the operations.
type platformCapture struct {
	platform.Capturer
	after      float64
	window     *Surfaces
	connection *endpointConn
}

// captureTokens gives each capture operation that waits a new, larger token.
var captureTokens atomic.Uint64

// awaitCapture runs the capture operation call with a new token. No limit ends its wait: the first of the close of the endpoint
// connection of the request, the close of the window and the end of its page ends it through CaptureEndWait, from the thread
// of that end. The operation waits off the UI thread, so the close and the page end reach the UI thread while it waits. The
// operation then fails with the reason of that end.
func awaitCapture[T any](c platformCapture, call func(token uint64) T) T {
	token := captureTokens.Add(1)
	w := &nativeWait{ended: func(reason string) { c.CaptureEndWait(token, reason) }}
	if c.window != nil {
		defer registerNativeWait(c.window, w)()
	}
	if c.connection != nil {
		defer c.connection.onClose(func() { w.end(waitEndConnection) })()
	}
	return call(token)
}

func (c platformCapture) Open(target CaptureTarget) error {
	return c.CaptureOpen(target.Window, target.Display)
}

// Start waits, as the other capture waits do, for still 0 of the recording.
func (c platformCapture) Start(directory string, plan CapturePlan) error {
	return awaitCapture(c, func(token uint64) error {
		return c.CaptureStart(directory, plan.Gap, plan.Seconds, plan.Frames, token)
	})
}

// captureAnswer is the answer of a capture operation that returns a value and an error.
type captureAnswer[T any] struct {
	value T
	err   error
}

func (c platformCapture) Stop() (int, error) {
	answer := awaitCapture(c, func(token uint64) captureAnswer[int] {
		frames, err := c.CaptureStop(c.after, token)
		return captureAnswer[int]{frames, err}
	})
	return answer.value, answer.err
}

// newWindowCapturer is the platform recording of a new window, or an error on a platform without it.
func (c platformCapture) newWindowCapturer() (platform.NewWindowCapturer, error) {
	capturer, ok := c.Capturer.(platform.NewWindowCapturer)
	if !ok {
		return nil, errors.New("the recording of a new window is not implemented on this platform")
	}
	return capturer, nil
}

// HoldNewWindow sets the hold in a step of the main thread: the native hold sets AppKit state, and the request that starts it runs
// on a goroutine of the endpoint, from which a native call of the main thread runs its body directly
// (native/darwin/src/main_thread.h).
func (c platformCapture) HoldNewWindow() error {
	capturer, err := c.newWindowCapturer()
	if err != nil {
		return err
	}
	mainThreadStep(func() { err = capturer.CaptureHoldNewWindow() })
	return err
}

// WaitNewWindow waits, as the other capture waits do, until the close of the endpoint connection of the request or of its
// window, also after the request returned, because the hold of a recording that the request started waits for a window that
// the application has not created yet. registerEnd receives the end of the wait for the stop of the recording.
func (c platformCapture) WaitNewWindow(registerEnd func(end func(reason string))) (int, error) {
	capturer, err := c.newWindowCapturer()
	if err != nil {
		return -1, err
	}
	answer := awaitCapture(c, func(token uint64) captureAnswer[int] {
		registerEnd(func(reason string) { c.CaptureEndWait(token, reason) })
		number, err := capturer.CaptureWaitNewWindow(token)
		return captureAnswer[int]{number, err}
	})
	return answer.value, answer.err
}

func (c platformCapture) ReleaseNewWindow() {
	if capturer, err := c.newWindowCapturer(); err == nil {
		capturer.CaptureReleaseNewWindow()
	}
}

type captureStatus interface {
	Missed() int
	Late() int
	LongestGap() float64
}

// captureStopPayload is the reply of the stop of a recording; window is the window server number of the recorded window, nil
// (JSON null) for a display recording.
func captureStopPayload(c captureStatus, directory string, count int, window *int) map[string]any {
	payload := map[string]any{
		"window":      windowNumberValue(window),
		"frames":      directory,
		"stills":      filepath.Join(directory, "stills.jsonl"),
		"displayLink": filepath.Join(directory, "display-link.json"),
		"count":       count,
		"missed":      c.Missed(),
		"late":        c.Late(),
		"longestGap":  c.LongestGap(),
	}
	return payload
}

// windowNumberValue is the JSON value of the window of a recording: its window server number, or null.
func windowNumberValue(window *int) any {
	if window == nil {
		return nil
	}
	return *window
}

// recorder returns the recording device of this platform for a request on connection c about window s, whose ends end the
// waits of the device.
func recorder(s *Surfaces, c *endpointConn) (platformCapture, error) {
	capturer, ok := system.(platform.Capturer)
	if !ok {
		return platformCapture{}, errors.New("window capture is not implemented on this platform")
	}
	return platformCapture{Capturer: capturer, window: s, connection: c}, nil
}

// diagnosticDrag requests a drag from the page and sends the time of each step, or with native delivers it as native
// pointer input at the boundary point that the page answers.
//
// The page finds the boundary and applies the input at each step. When the window is not in front, the browser
// slows the clock of the document, so the host sends the time of each step as a diagnostics-tick event. When the page finishes the drag and
// replies, the host waits until the last layout is displayed and then replies.
func diagnosticDrag(e *Endpoint, c *endpointConn, params json.RawMessage, reply *ReplyScope) (any, error) {
	ctx := reply.Context()
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
	native, err := parseDragNative(params)
	if err != nil {
		return nil, err
	}
	// A window without a main page has only native input to drag with.
	native = native || !framework.MainPage()
	// With native, the page answers the point of the boundary, and the host delivers the drag as native input there.
	var from point
	if native {
		from, err = presentedBoundary(func() (float64, error) { return s.presented(ctx) }, func() (point, error) { return dragBoundary(ctx, h, s, plan) })
		if err != nil {
			return nil, err
		}
	}
	// The layout trace and the time of each step are the record of every drag, on the clock of diagnostics.clock, so a check
	// judges the drag by them. A trace that does not start or end fails the drag.
	trace, err := recorder(s, c)
	if err != nil {
		return nil, err
	}
	run := &layoutTraceRun{}
	if err := startLayoutTrace(trace, run); err != nil {
		return nil, err
	}
	// The recording of a drag is its log: a recording that does not start is told in the result (recordedDragResult), and the
	// drag runs and answers without it.
	var recorded dragRecording
	if captureOptions.capture {
		var startErr error
		recorded.frames, recorded.window, startErr = startCapture(h, s, c, false, captureOptions.plan)
		if startErr != nil {
			recorded.failure = fmt.Sprintf("the recording did not start: %v", startErr)
		}
	}
	var tickMu sync.Mutex
	sent := []float64{}
	s.note(fmt.Sprintf("diagnostics: drag %s:%d by %g,%g for %d ms, %d times, native %t", plan.Axis, plan.Line, plan.DX, plan.DY, plan.MS, plan.Times, native))
	stepped := func() {
		tickMu.Lock()
		sent = append(sent, trace.CaptureClock())
		tickMu.Unlock()
	}
	// Each drag path answers after its last layout is displayed, so the layout trace stops after that presentation.
	settle := func() (map[string]any, error) {
		switch {
		case !framework.MainPage():
			return workbenchDrag(plan, func(method string, params any) (json.RawMessage, error) {
				return h.ask(ctx, s, method, params)
			}, h.steps.listen, func() (map[string]any, error) { return nativeDragPresented(ctx, h, s, plan, from, stepped) })
		case native:
			return nativeDragPresented(ctx, h, s, plan, from, stepped)
		default:
			return pageDrag(ctx, h, s, plan, stepped)
		}
	}
	var layouts []map[string]any
	result, err := stopAfterSettled(settle, func() error {
		var err error
		layouts, err = stopLayoutTrace(trace, run)
		return err
	})
	if err != nil {
		// When the requester does not receive the frame folder, the recording stops and the folder is deleted.
		if recorded.frames != "" {
			if abortErr := recording.Abort(trace); abortErr != nil {
				err = fmt.Errorf("%w; abort capture: %v", err, abortErr)
			}
		}
		return nil, err
	}
	tickMu.Lock()
	ticks := append([]float64(nil), sent...)
	tickMu.Unlock()
	return recordedDragResult(result, ticks, layouts, recorded), nil
}

// dragRecording is the recording of a recorded drag: its frame folder and recorded window when it started, and failure, what
// failed of it.
type dragRecording struct {
	frames  string
	window  *int
	failure string
}

// recordedDragResult adds to the result of a drag the time of each step, its layout trace and its recording: a recording that
// started adds frames and window, and captureError tells what failed of the recording. The recording is the log of the drag,
// so the drag does not fail on it.
func recordedDragResult(result map[string]any, ticks []float64, layouts []map[string]any, recorded dragRecording) map[string]any {
	result["ticks"] = ticks
	result["layouts"] = layouts
	if recorded.frames != "" {
		result["frames"] = recorded.frames
		result["window"] = windowNumberValue(recorded.window)
	}
	if recorded.failure != "" {
		result["captureError"] = recorded.failure
	}
	return result
}

// layoutTraceRun is one run of the layout trace of the host. The native layout trace records the transactions of the application
// and a start discards what it recorded, so one run holds it at a time: a drag, or diagnostics.layout.trace, whose run has
// endpoint set and ends also with the close of the endpoint connection that started it (forget removes that end).
type layoutTraceRun struct {
	endpoint bool
	forget   func()
}

// layoutTraces holds the run of the layout trace that is running, nil when none is.
var layoutTraces struct {
	mu  sync.Mutex
	run *layoutTraceRun
}

// startLayoutTrace starts the layout trace for run; it fails while another run holds the trace.
func startLayoutTrace(trace platformCapture, run *layoutTraceRun) error {
	layoutTraces.mu.Lock()
	defer layoutTraces.mu.Unlock()
	if layoutTraces.run != nil {
		return errors.New("the layout trace is already running")
	}
	layoutTraces.run = run
	mainThreadStep(func() {
		layoutViewports.mu.Lock()
		layoutViewports.byTicket = map[uint64]LayoutViewport{}
		layoutViewports.mu.Unlock()
		trace.LayoutTraceStart()
	})
	return nil
}

// stopLayoutTrace stops the layout trace of run and returns its layout transactions (layoutTrace); it fails when run does not hold
// the trace.
func stopLayoutTrace(trace platformCapture, run *layoutTraceRun) ([]map[string]any, error) {
	layoutTraces.mu.Lock()
	defer layoutTraces.mu.Unlock()
	if layoutTraces.run != run {
		return nil, errors.New("no layout trace is running")
	}
	layoutTraces.run = nil
	if run.forget != nil {
		run.forget()
	}
	var records []platform.LayoutRecord
	var viewports map[uint64]LayoutViewport
	var err error
	mainThreadStep(func() {
		records, err = trace.LayoutTraceStop()
		layoutViewports.mu.Lock()
		viewports, layoutViewports.byTicket = layoutViewports.byTicket, nil
		layoutViewports.mu.Unlock()
	})
	return layoutTrace(records, viewports), err
}

// diagnosticLayoutTrace starts the layout trace with on set, and with on unset stops the trace that it started and answers
// {layouts}, the layout transactions recorded since its start on the clock of diagnostics.clock in milliseconds. The trace also
// ends with the close of the endpoint connection c that started it (docs/spec/endpoint.md).
func diagnosticLayoutTrace(e *Endpoint, c *endpointConn, params json.RawMessage, _ *ReplyScope) (any, error) {
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
		return nil, rpcError(codeInvalidParams, "on must be a boolean")
	}
	trace, err := recorder(s, c)
	if err != nil {
		return nil, err
	}
	if !*p.On {
		layoutTraces.mu.Lock()
		run := layoutTraces.run
		layoutTraces.mu.Unlock()
		if run == nil || !run.endpoint {
			return nil, errors.New("no layout trace of diagnostics.layout.trace is running")
		}
		layouts, err := stopLayoutTrace(trace, run)
		if err != nil {
			return nil, err
		}
		return map[string]any{"layouts": layouts}, nil
	}
	run := &layoutTraceRun{endpoint: true}
	if err := startLayoutTrace(trace, run); err != nil {
		return nil, err
	}
	if c != nil {
		// The end runs in the close of c, before the close returns, or here when c closed already.
		forget := c.onClose(func() {
			if _, err := stopLayoutTrace(trace, run); err == nil {
				s.note("diagnostics: the layout trace ended with its endpoint connection")
			}
		})
		layoutTraces.mu.Lock()
		if layoutTraces.run == run {
			run.forget = forget
		} else {
			forget()
		}
		layoutTraces.mu.Unlock()
	}
	return nil, nil
}

// dragTick is one step of a drag that the page performs. Fraction is how far its leg has reached, from 0 to 1, and Last ends the
// leg. Error reports that the next step could not be paced, which ends the drag.
type dragTick struct {
	Fraction float64 `json:"fraction"`
	Last     bool    `json:"last"`
	Error    string  `json:"error,omitempty"`
}

// sendLegs sends the steps of the 2 × plan.Times one-way legs of plan. Each leg runs until plan.MS has passed on clock. Each step
// comes one display period after the one before, the period the window has at the moment of the step (stepPeriod), so the length
// of a step follows the display the window is on. A failed read sends one error tick and ends the drag.
func sendLegs(plan dragPlan, refreshRate func() (*int, error), clock func() time.Duration, wait func(time.Duration), send func(dragTick)) {
	span := time.Duration(plan.MS) * time.Millisecond
	for leg := 0; leg < 2*plan.Times; leg++ {
		began := clock()
		for {
			rate, err := refreshRate()
			var period time.Duration
			if err == nil {
				period, err = stepPeriod(rate)
			}
			if err != nil {
				send(dragTick{Error: err.Error()})
				return
			}
			wait(period)
			elapsed := clock() - began
			last := elapsed >= span
			fraction := 1.0
			if !last {
				fraction = float64(elapsed) / float64(span)
			}
			send(dragTick{Fraction: fraction, Last: last})
			if last {
				break
			}
		}
	}
}

// pageDrag requests the drag of plan from the page and sends its steps as diagnostics-tick events, calling sent at each step that
// was sent. It answers the result of the page after the last layout is displayed. The end of ctx ends the request.
func pageDrag(ctx context.Context, h *Host, s *Surfaces, plan dragPlan, sent func()) (map[string]any, error) {
	// The steps start after the request is sent so that the first step arrives after the page received the drag request. Every step
	// is sent, also after the request ended, so the page that runs the gesture receives each of its steps (docs/spec/endpoint.md).
	reply := h.relay.request(ctx, relayTarget{owner: s}, 0, func(id uint64) error {
		s.window.Emit("exposure-request", map[string]any{"id": id, "method": "diagnostics.drag", "params": plan})
		began := time.Now()
		routine.Go("diagnostics-ticks", func() {
			sendLegs(plan, s.refreshRate, func() time.Duration { return time.Since(began) }, time.Sleep, func(tick dragTick) {
				if tick.Error == "" {
					sent()
				}
				s.window.Emit("diagnostics-tick", tick)
			})
		})
		return nil
	})
	return dragResult(ctx, h, s, reply)
}

// dragStepCallback is the callback through which a step of a native drag reaches the view of a window.
const dragStepCallback = "mouseDragged:"

// workbenchDrag runs deliver, which delivers the drag of plan as native input, on a window without a main page. ask reaches the
// workbench, which records the position of the boundary from diagnostics.drag to diagnostics.drag.end, and listen gives the steps of
// the main thread. The reply of deliver gains boundary and handled, the milliseconds from the entry of each step to the return of
// its callback. The record ends after a failed delivery and after a failed diagnostics.drag too, so a next drag can start.
func workbenchDrag(plan dragPlan, ask func(method string, params any) (json.RawMessage, error), listen func(func(StepRecord)) func(),
	deliver func() (map[string]any, error)) (map[string]any, error) {
	if _, err := ask("diagnostics.drag", map[string]any{"axis": plan.Axis, "line": plan.Line}); err != nil {
		// The workbench may have started its record before the request failed, so the record ends here too.
		_, endErr := ask("diagnostics.drag.end", nil)
		return nil, errors.Join(err, endErr)
	}
	handled := []float64{}
	end := listen(func(step StepRecord) {
		if step.Callback == dragStepCallback {
			handled = append(handled, math.Round(float64(step.Return-step.Entry)/1e5)/10)
		}
	})
	result, err := deliver()
	end()
	raw, endErr := ask("diagnostics.drag.end", nil)
	if err = errors.Join(err, endErr); err != nil {
		return nil, err
	}
	var record struct {
		Boundary []float64 `json:"boundary"`
	}
	if err := json.Unmarshal(raw, &record); err != nil {
		return nil, fmt.Errorf("the workbench record of the drag is not {boundary}: %w", err)
	}
	steps, ok := result["steps"].(int)
	if !ok {
		return nil, fmt.Errorf("the drag reply has no steps: %v", result)
	}
	if len(handled) != steps || len(record.Boundary) != steps+1 {
		return nil, fmt.Errorf("the drag delivered %d steps and recorded %d callbacks and %d boundary positions", steps, len(handled), len(record.Boundary))
	}
	result["boundary"], result["handled"] = record.Boundary, handled
	return result, nil
}

// presentedBoundary reads the point of a boundary of a native drag after the window presented its current layout. A press goes where
// the last frame drew, so a boundary that a change just made takes no press before it.
func presentedBoundary(presented func() (float64, error), boundary func() (point, error)) (point, error) {
	if _, err := presented(); err != nil {
		return point{}, err
	}
	return boundary()
}

// dragBoundary asks the page for the point of the boundary of plan in window content coordinates.
func dragBoundary(ctx context.Context, h *Host, s *Surfaces, plan dragPlan) (point, error) {
	raw, err := h.ask(ctx, s, "diagnostics.drag.boundary", map[string]any{"axis": plan.Axis, "line": plan.Line})
	if err != nil {
		return point{}, err
	}
	var at struct{ X, Y *float64 }
	if err := json.Unmarshal(raw, &at); err != nil || at.X == nil || at.Y == nil {
		return point{}, fmt.Errorf("the page boundary of the drag is not {x, y}: %s", raw)
	}
	return point{X: *at.X, Y: *at.Y}, nil
}

// nativeDragPresented delivers the drag of plan from from as native input through the delivery of input.pointer, which
// does not activate the window or the application, at the host time of each step, calling sent at each step, and
// answers after the last release when the last layout is displayed.
func nativeDragPresented(ctx context.Context, h *Host, s *Surfaces, plan dragPlan, from point, sent func()) (map[string]any, error) {
	backend := hostBackend{h: h}
	start := time.Now()
	clock := func() time.Duration { return time.Since(start) }
	result, err := nativeDrag(plan, from, clock, func(input PointerInput) error { return backend.Pointer(s.name, input) },
		func(previous time.Duration) (time.Duration, error) {
			// The period is read from the display of the window at the moment of the step, so a window that moves
			// between a 60 Hz and a 120 Hz display follows the display it is on.
			rate, err := s.refreshRate()
			if err != nil {
				return 0, err
			}
			period, err := stepPeriod(rate)
			if err != nil {
				return 0, err
			}
			taken := nextStep(previous, period, clock(), time.Sleep)
			sent()
			return taken, nil
		}, func() error {
			_, err := s.presented(ctx)
			return err
		})
	if err != nil {
		return nil, err
	}
	if err := dragPresented(ctx, h, s); err != nil {
		return nil, err
	}
	return result, nil
}

// layoutTrace converts the layout transaction records to {ticket, begun, requested, presented, committed, commitPath,
// openAtCommit, flushed, displayed, refreshed, viewport}. A value that did not happen is null, and viewport, the size {width,
// height} of the window that the page made the layout at, is null for a transaction that no preparation of the trace began.
func layoutTrace(records []platform.LayoutRecord, viewports map[uint64]LayoutViewport) []map[string]any {
	layouts := make([]map[string]any, 0, len(records))
	stage := func(value float64) any {
		if math.IsNaN(value) {
			return nil
		}
		return value
	}
	for _, record := range records {
		var commitPath any
		if record.CommitPath != "" {
			commitPath = record.CommitPath
		}
		var viewport any
		if size, ok := viewports[record.Ticket]; ok {
			viewport = map[string]any{"width": size.Width, "height": size.Height}
		}
		layouts = append(layouts, map[string]any{
			"ticket": record.Ticket, "begun": stage(record.Begun), "requested": stage(record.Requested), "presented": stage(record.Presented),
			"committed": stage(record.Committed), "commitPath": commitPath, "openAtCommit": stage(record.OpenAtCommit),
			"flushed": stage(record.Flushed), "displayed": stage(record.Displayed), "refreshed": stage(record.Refreshed),
			"viewport": viewport,
		})
	}
	return layouts
}

// stopAfterSettled runs settle, which waits until the last layout of a drag is displayed, and then stop, which ends the layout
// trace, so that the trace holds the presentation of the last layout. stop runs also when settle fails.
func stopAfterSettled[T any](settle func() (T, error), stop func() error) (T, error) {
	result, err := settle()
	return result, errors.Join(err, stop())
}

// dragResult checks the drag reply of the page, waits until the last layout is displayed, and returns the result.
func dragResult(ctx context.Context, h *Host, s *Surfaces, reply ExposureResult) (map[string]any, error) {
	if reply.Error != nil {
		return nil, reply.Error
	}
	if err := dragPresented(ctx, h, s); err != nil {
		return nil, err
	}
	result := map[string]any{}
	if len(reply.Result) > 0 && string(reply.Result) != "null" {
		if err := json.Unmarshal(reply.Result, &result); err != nil {
			return nil, fmt.Errorf("the page drag result is not an object: %w", err)
		}
	}
	return result, nil
}

// dragPresented waits until the last layout of a drag is displayed (windowPresented).
func dragPresented(ctx context.Context, h *Host, s *Surfaces) error {
	if _, err := windowPresented(ctx, h, s); err != nil {
		return err
	}
	s.note("diagnostics: drag presented")
	return nil
}

// startCapture starts the recording of window s with plan in a new folder under the configuration directory and waits for still 0.
// With display, it records the windows of this application on the display that holds the window.
func startCapture(h *Host, s *Surfaces, c *endpointConn, display bool, plan CapturePlan) (string, *int, error) {
	capture, err := recorder(s, c)
	if err != nil {
		return "", nil, err
	}
	// The window list query of the window server waits for a reply, so only the window number is read on the main thread.
	var numbers []int
	mainThreadStep(func() { numbers, err = capture.WindowNumbers(s.window.NativeWindow()) })
	if err != nil {
		return "", nil, err
	}
	if len(numbers) == 0 {
		return "", nil, errors.New("the window has no window server number")
	}
	directory := filepath.Join(h.workspace.directory, "logs", "captures", fmt.Sprintf("%s-%d", s.name, time.Now().UnixNano()))
	if err := recording.Start(capture, CaptureTarget{Window: numbers[0], Display: display}, directory, plan); err != nil {
		return "", nil, err
	}
	// A display recording records every window of the application on the display, so it has no window of its own.
	if display {
		return directory, nil, nil
	}
	window := numbers[0]
	return directory, &window, nil
}

// startNewWindowCapture holds the next new window of the application and answers with the frame directory once the hold is
// set; the recording of that window starts when the application shows it (Recording.StartNewWindow).
func startNewWindowCapture(h *Host, s *Surfaces, capture platformCapture, plan CapturePlan) (string, error) {
	directory := filepath.Join(h.workspace.directory, "logs", "captures", fmt.Sprintf("%s-new-%d", s.name, time.Now().UnixNano()))
	if err := recording.StartNewWindow(capture, directory, plan); err != nil {
		return "", err
	}
	return directory, nil
}

// diagnosticCaptureStill takes one picture of a window without giving it focus, writes it to <config-dir>/captures/still-*/window.png, and returns
// the path. It is observation material for visual checks during development, and the requester deletes that directory after checking.
func diagnosticCaptureStill(e *Endpoint, c *endpointConn, params json.RawMessage, _ *ReplyScope) (any, error) {
	h, s, err := diagnosticHost(e, params)
	if err != nil {
		return nil, err
	}
	path, err := captureStill(h, s, c)
	if err != nil {
		return nil, err
	}
	return map[string]string{"path": path}, nil
}

// captureStill writes a still PNG of the window of s into a private folder under <config-dir>/logs/captures and
// returns its path.
func captureStill(h *Host, s *Surfaces, c *endpointConn) (string, error) {
	capture, err := recorder(s, c)
	if err != nil {
		return "", err
	}
	var numbers []int
	mainThreadStep(func() { numbers, err = capture.WindowNumbers(s.window.NativeWindow()) })
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
	// The child windows of an open modal or settings window stand over the window, so the picture holds them too.
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
		path, err := captureStill(h, s, nil)
		if err != nil {
			return paths, fmt.Errorf("window %s: %w", s.name, err)
		}
		paths = append(paths, path)
	}
	return paths, nil
}

// diagnosticCaptureStart starts the window recording and returns the frame folder.
func diagnosticCaptureStart(e *Endpoint, c *endpointConn, params json.RawMessage, _ *ReplyScope) (any, error) {
	h, s, err := diagnosticHost(e, params)
	if err != nil {
		return nil, err
	}
	p, err := parseCaptureStartOptions(params)
	if err != nil {
		return nil, err
	}
	capture, err := recorder(s, c)
	if err != nil {
		return nil, err
	}
	if p.NewWindow {
		directory, err := startNewWindowCapture(h, s, capture, p.Plan)
		if err != nil {
			return nil, err
		}
		// The held window is known once the application shows it, after this reply; the stop reply names it.
		return map[string]any{"frames": directory, "window": nil}, nil
	}
	directory, window, err := startCapture(h, s, c, p.Display, p.Plan)
	if err != nil {
		return nil, err
	}
	return map[string]any{"frames": directory, "window": windowNumberValue(window)}, nil
}

type captureStartOptions struct {
	Display   bool
	NewWindow bool
	Plan      CapturePlan
}

// The largest number of stills that a recording plans (native/darwin/src/capture.h).
const capturePlanLimit = 4096

// parseCapturePlan reads the plan of the stills of a recording, gap and seconds or frames, and refuses it with the messages of the
// native start (native/darwin/src/capture.h) before any window is held or prepared.
func parseCapturePlan(params json.RawMessage) (CapturePlan, error) {
	var request struct {
		Gap     json.RawMessage `json:"gap"`
		Seconds json.RawMessage `json:"seconds"`
		Frames  json.RawMessage `json:"frames"`
	}
	if err := decode(params, &request); err != nil {
		return CapturePlan{}, err
	}
	present := func(raw json.RawMessage) bool {
		return len(raw) != 0 && !bytes.Equal(bytes.TrimSpace(raw), []byte("null"))
	}
	number := func(raw json.RawMessage) (float64, bool) {
		var value *float64
		if err := json.Unmarshal(raw, &value); err != nil || value == nil || math.IsNaN(*value) || math.IsInf(*value, 0) {
			return 0, false
		}
		return *value, true
	}
	gap, ok := number(request.Gap)
	if !present(request.Gap) || !ok || gap < 1 || gap > 1000 {
		return CapturePlan{}, rpcError(codeInvalidParams, "gap must be a number of milliseconds from 1 to 1000")
	}
	plan := CapturePlan{Gap: gap}
	hasSeconds, hasFrames := present(request.Seconds), present(request.Frames)
	if hasSeconds && hasFrames {
		return CapturePlan{}, rpcError(codeInvalidParams, "give seconds or frames, not both")
	}
	if !hasSeconds && !hasFrames {
		return CapturePlan{}, rpcError(codeInvalidParams, "a recording needs seconds or frames")
	}
	if hasSeconds {
		seconds, ok := number(request.Seconds)
		if !ok || !(seconds > 0 && seconds <= 600) {
			return CapturePlan{}, rpcError(codeInvalidParams, "seconds must be above 0 and at most 600")
		}
		// Every still whose planned time n·gap is before the length.
		if count := math.Ceil(seconds * 1000 / gap); count > capturePlanLimit {
			return CapturePlan{}, rpcError(codeInvalidParams, "the recording plans %.0f stills, more than %d", count, capturePlanLimit)
		}
		plan.Seconds = seconds
		return plan, nil
	}
	frames, ok := number(request.Frames)
	if !ok || frames != math.Trunc(frames) || frames < 1 || frames > capturePlanLimit {
		return CapturePlan{}, rpcError(codeInvalidParams, "frames must be an integer from 1 to %d", capturePlanLimit)
	}
	plan.Frames = int(frames)
	return plan, nil
}

func parseCaptureStartOptions(params json.RawMessage) (captureStartOptions, error) {
	var request struct {
		Display   bool            `json:"display"`
		NewWindow json.RawMessage `json:"newWindow"`
	}
	if err := decode(params, &request); err != nil {
		return captureStartOptions{}, err
	}
	plan, err := parseCapturePlan(params)
	if err != nil {
		return captureStartOptions{}, err
	}
	options := captureStartOptions{Display: request.Display, Plan: plan}
	if len(request.NewWindow) != 0 {
		var newWindow *bool
		if err := json.Unmarshal(request.NewWindow, &newWindow); err != nil || newWindow == nil {
			return captureStartOptions{}, rpcError(codeInvalidParams, "newWindow must be a boolean")
		}
		options.NewWindow = *newWindow
	}
	if options.NewWindow && options.Display {
		return captureStartOptions{}, rpcError(codeInvalidParams, "newWindow records the new window alone and cannot be combined with display")
	}
	return options, nil
}

// diagnosticCaptureStop records until a still requested at or after after has completed, ends the recording, and returns the frame
// folder, the stills and the number of frames.
func diagnosticCaptureStop(e *Endpoint, c *endpointConn, params json.RawMessage, _ *ReplyScope) (any, error) {
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
	capture, err := recorder(s, c)
	if err != nil {
		return nil, err
	}
	if p.After != nil {
		if *p.After < 0 {
			return nil, rpcError(codeInvalidParams, "after must not be negative")
		}
		capture.after = *p.After
	}
	directory, count, window, err := recording.Finish(capture)
	if err != nil {
		return nil, err
	}
	return captureStopPayload(captureStatusAdapter{capture}, directory, count, window), nil
}

type captureStatusAdapter struct{ platformCapture }

func (c captureStatusAdapter) Missed() int         { return c.CaptureMissed() }
func (c captureStatusAdapter) Late() int           { return c.CaptureLate() }
func (c captureStatusAdapter) LongestGap() float64 { return c.CaptureLongestGap() }

// diagnosticLogFlush waits until the records written so far are in the event log of the host.
func diagnosticLogFlush(e *Endpoint, _ *endpointConn, params json.RawMessage, _ *ReplyScope) (any, error) {
	if _, err := e.window(params); err != nil {
		return nil, err
	}
	return nil, FlushRecords()
}

// diagnosticHostRelaunch quits the application as host.quit does and starts it again with the same executable and
// arguments once this process has ended, so the new process reads the files that a check left in the configuration
// folder (docs/spec/endpoint.md#diagnostic-builds). It replies once the quit has begun.
func diagnosticHostRelaunch(e *Endpoint, _ *endpointConn, params json.RawMessage, _ *ReplyScope) (any, error) {
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
	QuitWithCause("update", HostQuitSource("update"), func() { routine.Go("quit", framework.Quit) })
	return nil, nil
}

// diagnosticTestMark stores the start or the end of a test as an event and replies with the position of its line.
func diagnosticTestMark(e *Endpoint, _ *endpointConn, params json.RawMessage, _ *ReplyScope) (any, error) {
	if _, err := e.window(params); err != nil {
		return nil, err
	}
	mark, err := ParseTestMark(params)
	if err != nil {
		return nil, err
	}
	boot, seq, err := EmitTestMark(mark)
	if err != nil {
		return nil, err
	}
	return map[string]any{"boot": boot, "seq": seq}, nil
}

// diagnosticStallDump stores the path of a stall dump that the window check wrote as an event with the running host calls and the
// goroutine stacks, and replies with the position of its line and the running calls of the window of the request.
func diagnosticStallDump(e *Endpoint, _ *endpointConn, params json.RawMessage, _ *ReplyScope) (any, error) {
	window, err := e.window(params)
	if err != nil {
		return nil, err
	}
	path, err := ParseStallDump(params)
	if err != nil {
		return nil, err
	}
	return StallDump(path, window, runningCalls, time.Now())
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

func diagnosticInputReference(e *Endpoint, c *endpointConn, params json.RawMessage, _ *ReplyScope) (any, error) {
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
	// A wait ends by its document, by the close of the reference or its window, or by the connection or the page of the request.
	window := s.window.NativeWindow()
	// silent: the library answers an ended wait with the failure that names its end, so the reply carries the reason.
	reply, _ := awaitNative(s, c, func(done func(result)) func(string) {
		reference.InputReference(window, action, document, func(value json.RawMessage, failure error) { done(result{value, failure}) })
		return func(reason string) { reference.EndInputReferenceWait(window, reason) }
	})
	return reply.value, reply.failure
}

// inputSourceRoles are the input source roles that select of diagnostics.input.source takes (docs/spec/endpoint.md). The platform
// maps each role to its input source; no identifier of a platform's input source is named here.
var inputSourceRoles = []string{"latin", "korean", "japanese"}

// inputSourceRequest is a diagnostics.input.source request: Select is the role to select, Restore the platform identifier of an
// input source that an earlier reply reported in source, and both are empty for a read of the current input source.
type inputSourceRequest struct {
	Select  string
	Restore string
}

// parseInputSource reads the params of diagnostics.input.source. A select that is not an input source role, an empty restore, and
// a request with both are refused.
func parseInputSource(params json.RawMessage) (inputSourceRequest, error) {
	var p struct {
		Select  *string `json:"select"`
		Restore *string `json:"restore"`
	}
	if err := decode(params, &p); err != nil {
		return inputSourceRequest{}, err
	}
	if p.Select != nil && p.Restore != nil {
		return inputSourceRequest{}, rpcError(codeInvalidParams, "select and restore exclude each other")
	}
	if p.Restore != nil {
		if *p.Restore == "" {
			return inputSourceRequest{}, rpcError(codeInvalidParams, "restore must be a non-empty string")
		}
		return inputSourceRequest{Restore: *p.Restore}, nil
	}
	if p.Select == nil {
		return inputSourceRequest{}, nil
	}
	for _, role := range inputSourceRoles {
		if *p.Select == role {
			return inputSourceRequest{Select: role}, nil
		}
	}
	return inputSourceRequest{}, rpcError(codeInvalidParams, "select must be one of latin, korean, japanese")
}

// answerInputSource performs request through the input source operations of the platform, each in a main-thread step that step
// runs, waits for a selection through await, and replies {current, source}: the role of the selected input source, null for an
// input source without a role, and its platform identifier.
func answerInputSource(sources platform.InputSources, request inputSourceRequest, step func(func()),
	await func(start func(adopted func(error)) (end func(reason string))) error) (any, error) {
	if request.Select != "" || request.Restore != "" {
		err := await(func(adopted func(error)) func(string) {
			if request.Select != "" {
				return sources.SelectInputSource(request.Select, adopted)
			}
			return sources.RestoreInputSource(request.Restore, adopted)
		})
		if err != nil {
			return nil, err
		}
	}
	var role, source string
	var err error
	step(func() { role, source, err = sources.InputSource() })
	if err != nil {
		return nil, err
	}
	var current any
	if role != "" {
		current = role
	}
	return map[string]any{"current": current, "source": source}, nil
}

// diagnosticInputSource selects the input source of a role when select is given, or the input source that restore names, and
// returns the role and the platform identifier of the currently selected keyboard input source.
func diagnosticInputSource(e *Endpoint, c *endpointConn, params json.RawMessage, _ *ReplyScope) (any, error) {
	_, s, err := diagnosticHost(e, params)
	if err != nil {
		return nil, err
	}
	request, err := parseInputSource(params)
	if err != nil {
		return nil, err
	}
	sources, ok := system.(platform.InputSources)
	if !ok {
		return nil, errors.New("keyboard input sources are not implemented on this platform")
	}
	// A selection ends by its adoption or by the connection, the window or the page of the request.
	return answerInputSource(sources, request, mainThreadStep, func(start func(func(error)) func(string)) error {
		// silent: the library answers an ended selection with the failure that names its end, so the failure carries the reason.
		failure, _ := awaitNative(s, c, start)
		return failure
	})
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
	// forget takes back the end of the hold by the connection that turned it on; it is called under the lock of the set.
	forget func()
}

// end ends the hold of window s when it is still hold: the held answers are sent and diagnostics.modal.held answers. The caller
// holds set.mu.
func (set *modalHoldSet) end(s *Surfaces, hold *modalHold) {
	if set.windows[s] != hold {
		return
	}
	close(hold.release)
	delete(set.windows, s)
	hold.forget()
}

// windowClosed ends the hold of window s when the window closes.
func (set *modalHoldSet) windowClosed(s *Surfaces) {
	set.mu.Lock()
	defer set.mu.Unlock()
	if hold := set.windows[s]; hold != nil {
		set.end(s, hold)
	}
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
// and stops holding. A hold also ends when its window closes or when the endpoint connection c that turned it on closes
// (docs/spec/endpoint.md).
func diagnosticModalHold(e *Endpoint, c *endpointConn, params json.RawMessage, _ *ReplyScope) (any, error) {
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
	hold := modalHolds.windows[s]
	started := *p.On && hold == nil
	switch {
	case started:
		hold = &modalHold{release: make(chan struct{}), held: make(chan struct{}), forget: func() {}}
		modalHolds.windows[s] = hold
	case !*p.On && hold != nil:
		modalHolds.end(s, hold)
	}
	modalHolds.mu.Unlock()
	if started && c != nil {
		// The end runs in the close of c, before the close returns, or here when c closed already.
		forget := c.onClose(func() {
			modalHolds.mu.Lock()
			modalHolds.end(s, hold)
			modalHolds.mu.Unlock()
		})
		modalHolds.mu.Lock()
		if modalHolds.windows[s] == hold {
			hold.forget = forget
		} else {
			forget()
		}
		modalHolds.mu.Unlock()
	}
	return nil, nil
}

// surfaceHolds is the endpoint connection that asked for the latest reply hold of each surface of each window.
var surfaceHolds = struct {
	mu    sync.Mutex
	conns map[*Surfaces]map[string]*endpointConn
}{conns: map[*Surfaces]map[string]*endpointConn{}}

// diagnosticSurfaceHold asks the main page to hold the replies of a surface. When the endpoint connection c that asked closes,
// the host sends diagnostics-surface-released {surface} to the window, unless a later hold of that surface was asked
// (docs/spec/endpoint.md).
func diagnosticSurfaceHold(e *Endpoint, c *endpointConn, params json.RawMessage, scope *ReplyScope) (any, error) {
	h, s, err := diagnosticHost(e, params)
	if err != nil {
		return nil, err
	}
	reply, err := h.ask(scope.Context(), s, "diagnostics.surface.hold", params)
	if err != nil || c == nil {
		return reply, err
	}
	var p struct {
		Surface string `json:"surface"`
	}
	if err := decode(params, &p); err != nil {
		return nil, err
	}
	surfaceHolds.mu.Lock()
	if surfaceHolds.conns[s] == nil {
		surfaceHolds.conns[s] = map[string]*endpointConn{}
	}
	surfaceHolds.conns[s][p.Surface] = c
	surfaceHolds.mu.Unlock()
	// The release runs in the close of c, before the close returns.
	c.onClose(func() {
		surfaceHolds.mu.Lock()
		latest := surfaceHolds.conns[s][p.Surface] == c
		if latest {
			delete(surfaceHolds.conns[s], p.Surface)
		}
		surfaceHolds.mu.Unlock()
		if latest {
			s.window.Emit("diagnostics-surface-released", map[string]any{"surface": p.Surface})
		}
	})
	return reply, nil
}

// endWindowHolds ends the diagnostic holds of window s when it closes: its modal content hold ends and its surface holds
// are forgotten, since the page that held them ends with the window.
func endWindowHolds(s *Surfaces) {
	endNativeWaits(s, waitEndWindow)
	modalHolds.windowClosed(s)
	surfaceHolds.mu.Lock()
	delete(surfaceHolds.conns, s)
	surfaceHolds.mu.Unlock()
}

// diagnosticModalHeld replies when the window has held one modal content reply.
// diagnosticNotifications returns the notifications of this application that the notification center still shows.
func diagnosticNotifications(e *Endpoint, _ *endpointConn, params json.RawMessage, _ *ReplyScope) (any, error) {
	if _, _, err := diagnosticHost(e, params); err != nil {
		return nil, err
	}
	capture, err := recorder(nil, nil)
	if err != nil {
		return nil, err
	}
	answer := make(chan string, 1)
	mainThreadStep(func() { capture.DeliveredNotifications(func(list string) { answer <- list }) })
	// The library answers once on every path, so the host waits for the list without a limit of its own.
	list := <-answer
	var delivered []map[string]string
	if err := json.Unmarshal([]byte(list), &delivered); err != nil {
		return nil, fmt.Errorf("delivered notifications %q: %w", list, err)
	}
	return delivered, nil
}

func diagnosticModalHeld(e *Endpoint, _ *endpointConn, params json.RawMessage, _ *ReplyScope) (any, error) {
	_, s, err := diagnosticHost(e, params)
	if err != nil {
		return nil, err
	}
	wait, err := modalHolds.heldWait(s)
	if err != nil {
		return nil, err
	}
	wait()
	return nil, nil
}

// heldWait reads the hold of window s when diagnostics.modal.held arrives and returns the wait of the answer, which returns
// when the window holds a modal content answer or the hold ends. It fails when the window does not hold answers.
func (set *modalHoldSet) heldWait(s *Surfaces) (func(), error) {
	set.mu.Lock()
	hold := set.windows[s]
	set.mu.Unlock()
	if hold == nil {
		return nil, errors.New("modal content answers are not held in this window")
	}
	return func() {
		select {
		case <-hold.held:
		case <-hold.release:
		}
	}, nil
}

// diagnosticPageCollect makes the WebContent process of the app page of the window collect JavaScript objects. It is called before a memory check measures so that
// the check measures the remaining memory independently of the collection time.
func diagnosticPageCollect(e *Endpoint, _ *endpointConn, params json.RawMessage, _ *ReplyScope) (any, error) {
	_, s, err := diagnosticHost(e, params)
	if err != nil {
		return nil, err
	}
	mainThreadStep(func() {
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
func diagnosticHostEvents(e *Endpoint, _ *endpointConn, params json.RawMessage, _ *ReplyScope) (any, error) {
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
func diagnosticNativeObjects(e *Endpoint, c *endpointConn, params json.RawMessage, _ *ReplyScope) (any, error) {
	_, s, err := diagnosticHost(e, params)
	if err != nil {
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
	a, reason := awaitNative(s, c, func(done func(answer)) func(string) {
		end := counter.WindowObjectsWhen(expected, func(counts platform.WindowObjects, reached bool) { done(answer{counts, reached}) })
		return func(string) { end() }
	})
	return nativeObjectsAnswer(expected, a.counts, a.reached, reason)
}

// nativeObjectsAnswer is the reply of diagnostics.native.objects to the answer of the library and the reason of the end of a
// wait that did not reach its counts.
func nativeObjectsAnswer(expected *platform.WindowObjects, counts platform.WindowObjects, reached bool, reason string) (any, error) {
	switch {
	case !reached && expected == nil:
		return nil, rpcError(codeTimeout, "the window object counts ended before the application handled an event: %s", reason)
	case !reached:
		return nil, rpcError(codeTimeout, "window object counts did not reach %s before %s; they are %s", expected, reason, counts)
	}
	return counts.Payload(), nil
}

type nativeWindowColorSpaceFacts struct {
	Name      *string `json:"name"`
	ICCSHA256 *string `json:"iccSHA256"`
}

func diagnosticNativeWindowColorSpace(e *Endpoint, _ *endpointConn, params json.RawMessage, _ *ReplyScope) (any, error) {
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
func diagnosticObjects(e *Endpoint, _ *endpointConn, params json.RawMessage, _ *ReplyScope) (any, error) {
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
	mainThreadStep(func() {
		views = s.surfaceCount()
		attached := s.documents.Attached()
		answers = make(chan pageAnswer, 1+len(attached))
		pages = len(attached)
		// A window without a main page has no page objects to count.
		if framework.MainPage() {
			var main unsafe.Pointer
			main, err = system.MainWebview(s.window.NativeWindow())
			if err != nil {
				return
			}
			pages++
			counter.CountPageObjects(main, false, func(elements, documents int64, err error) {
				answers <- pageAnswer{main: true, counts: PageObjects{Elements: elements, Documents: documents}, err: err}
			})
		}
		for key, handle := range attached {
			counter.CountPageObjects(handle, true, func(elements, documents int64, err error) {
				answers <- pageAnswer{key: key, counts: PageObjects{Elements: elements, Documents: documents}, err: err}
			})
		}
	})
	if err != nil {
		return ObjectCounts{}, err
	}
	var counts ObjectCounts
	var failure error
	// The library answers each count once on every path, so the host waits for each answer without a limit of its own.
	for i := 0; i < pages; i++ {
		answer := <-answers
		if answer.err != nil {
			failure = errors.Join(failure, answer.err)
		} else if answer.main {
			counts.Page = &answer.counts
		} else {
			counts.Documents = append(counts.Documents, DocumentObjects{Key: answer.key, Counts: answer.counts})
		}
	}
	if failure != nil {
		return ObjectCounts{}, failure
	}
	if frames := s.window.Frames(); frames != nil {
		counts.Framework = &FrameworkObjects{Callbacks: framework.RegisteredCallbacks(), Nodes: frames.Nodes(), NativeViews: frames.NativeViews()}
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
func diagnosticHeapProfile(e *Endpoint, _ *endpointConn, params json.RawMessage, _ *ReplyScope) (any, error) {
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

// diagnosticCPUProfile starts the CPU profile of the Go runtime with on: true and stops it with on: false, so a check profiles the work
// of the host between its two requests (docs/spec/endpoint.md).
func diagnosticCPUProfile(e *Endpoint, _ *endpointConn, params json.RawMessage, _ *ReplyScope) (any, error) {
	var p struct {
		On *bool `json:"on"`
	}
	if err := decode(params, &p); err != nil {
		return nil, err
	}
	if p.On == nil {
		return nil, rpcError(codeInvalidParams, "on is required")
	}
	if !*p.On {
		path, err := StopCPUProfile()
		if err != nil || path == "" {
			return nil, err
		}
		return map[string]any{"path": path}, nil
	}
	h, _, err := diagnosticHost(e, params)
	if err != nil {
		return nil, err
	}
	return nil, StartCPUProfile(filepath.Join(h.workspace.directory, "logs"))
}

// collectGarbage is the collection of the loop of diagnostics.gc.loop.
var collectGarbage = runtime.GC

// gcLoopStopWaits is called by the stop of diagnostics.gc.loop when it begins to wait for the goroutine of the loop to return, before
// it waits. A check releases the collection that it holds after this event, so a stop that answers before it finds the collection
// held. nil calls nothing.
var gcLoopStopWaits func()

// gcLoop is the goroutine of diagnostics.gc.loop while it runs.
var gcLoop struct {
	mu   sync.Mutex
	stop chan struct{}
	done chan struct{}
}

// diagnosticGCLoop starts a goroutine that collects garbage without pause, or stops it and answers after it has returned, so a
// check measures the work of the main thread while the runtime collects (docs/spec/endpoint.md).
func diagnosticGCLoop(_ *Endpoint, _ *endpointConn, params json.RawMessage, _ *ReplyScope) (any, error) {
	var p struct {
		On *bool `json:"on"`
	}
	if err := decode(params, &p); err != nil {
		return nil, err
	}
	if p.On == nil {
		return nil, rpcError(codeInvalidParams, "on is required")
	}
	gcLoop.mu.Lock()
	defer gcLoop.mu.Unlock()
	switch {
	case *p.On && gcLoop.stop == nil:
		stop, done, collect := make(chan struct{}), make(chan struct{}), collectGarbage
		gcLoop.stop, gcLoop.done = stop, done
		routine.Go("diagnostics-gc-loop", func() {
			defer close(done)
			for {
				select {
				case <-stop:
					return
				default:
					collect()
				}
			}
		})
	case !*p.On && gcLoop.stop != nil:
		close(gcLoop.stop)
		if gcLoopStopWaits != nil {
			gcLoopStopWaits()
		}
		<-gcLoop.done
		gcLoop.stop, gcLoop.done = nil, nil
	}
	return nil, nil
}

// diagnosticMemoryPressure delivers a memory pressure level as the source of the process delivers it, so a check observes the
// report that the pages receive (docs/spec/hosts.md#memory-pressure).
func diagnosticMemoryPressure(e *Endpoint, _ *endpointConn, params json.RawMessage, _ *ReplyScope) (any, error) {
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
	mainThreadStep(func() { injected = system.InjectMemoryPressure(level) })
	return nil, injected
}

// diagnosticProcessExit replies when the process pid ends. A window check waits for the WebContent process of a closed window to end through
// the exit notification of the kernel.
func diagnosticProcessExit(e *Endpoint, c *endpointConn, params json.RawMessage, _ *ReplyScope) (any, error) {
	_, s, err := diagnosticHost(e, params)
	if err != nil {
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
	exited, reason := awaitNative(s, c, func(done func(bool)) func(string) {
		end := waiter.WhenProcessExited(pid, done)
		return func(string) { end() }
	})
	return processExitAnswer(pid, exited, reason)
}

// processExitAnswer is the reply of diagnostics.process.exit to the answer of the library and the reason of the end of a wait
// that did not see the exit. A wait that the library could not register answers without a reason.
func processExitAnswer(pid int32, exited bool, reason string) (any, error) {
	switch {
	case exited:
		return nil, nil
	case reason == "":
		return nil, fmt.Errorf("process %d exit wait could not be registered", pid)
	}
	return nil, rpcError(codeTimeout, "process %d did not exit before %s", pid, reason)
}
