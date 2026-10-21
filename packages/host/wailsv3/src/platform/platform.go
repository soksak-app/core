// Package platform declares the operating system specific behavior of the native host and selects the implementation of the current operating system.
//
// The package platform/<os>/ registers the operating system specific implementation with Register in init. The host package
// imports all operating system packages, so only the implementation of the current operating system is registered.
//
// Windows and views are passed as unsafe.Pointer handles. Call a function that receives a handle on the UI thread.
package platform

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net"
	"os"
	"os/exec"
	"sync"
	"time"
	"unsafe"

	"github.com/soksak-app/core/packages/host/wailsv3/src/routine"
)

// Rect is a region in CSS pixels relative to the page viewport.
type Rect struct {
	X, Y, W, H float64
}

// DOMOverlay is the CSS pixel margin relative to the surface viewport and the display state.
type DOMOverlay struct {
	Left, Top, Right, Bottom float64
	Visible                  bool
}

// WindowOverlay is a main DOM region that must take part in the native hit ownership decision.
type WindowOverlay struct {
	X, Y, W, H float64
	Visible    bool
}

// ClipboardValue distinguishes an empty clipboard from an operation error.
type ClipboardValue struct {
	Present bool
	Type    string
	Text    string
	PNG     []byte
	URLs    []string
}

func VisibleWindowOverlayRects(overlays []WindowOverlay) []float64 {
	values := make([]float64, 0, len(overlays)*4)
	for _, overlay := range overlays {
		if !overlay.Visible {
			continue
		}
		values = append(values, overlay.X, overlay.Y, overlay.W, overlay.H)
	}
	return values
}

// WebviewOptions are the creation values of a native web view that the app creates.
type WebviewOptions struct {
	// Identifier is the number attached to the messages that the web view sent.
	Identifier uint64
	// Name is the native view identifier that the window hit test returns. When empty, no identifier is set.
	Name string
	// Script is the script that runs when each document starts.
	Script              string
	X, Y, Width, Height float64
	Hidden, Transparent bool
	// FillParent tells whether the view resizes with the size of its parent view.
	FillParent bool
	// Receive receives the messages that the document of the web view sent. It is called outside the UI thread.
	Receive func(identifier uint64, body string)
	// Committed receives that the web view started to show a new document. It is called outside the UI thread.
	Committed func(identifier uint64)
	// Terminated receives that the WebContent process of the web view ended. It is called outside the UI thread.
	Terminated func(identifier uint64)
}

// Input is the functions that receive the input over a surface.
type Input struct {
	// Press returns whether the pressed view is a surface and, for a surface, passes that fact.
	Press func(view uintptr) bool
	// Point passes one step of a left button drag in page coordinates. phase is 0 for press, 1 for move and 2 for release.
	Point func(phase int, x, y float64)
}

// InputSources are the keyboard input source operations. Only the platform implementation of a diagnostic build (tag diagnostics) provides them, and
// diagnostic code uses them by checking the value of Current() against this interface. Call both operations on the main thread.
type InputSources interface {
	// InputSource returns the identifier of the currently selected keyboard input source.
	InputSource() (string, error)
	// SelectInputSource selects identifier among the enabled input sources.
	SelectInputSource(identifier string) error
	// AwaitInputSource calls adopted once the text input context of the key view holds identifier, with an error when it does
	// not within 2 seconds. Call it on the main thread; adopted runs on the main thread.
	AwaitInputSource(identifier string, adopted func(error))
}

// WindowObjects is the number of live objects, among the objects that the common library attached to windows and web views, whose lifetime shows the release of the window and the web view.
// When a closed window and its web views are released, the object count of that window drops.
type WindowObjects struct {
	// WindowCompositions is the number of composition views that hold the main web view inside the content view of a window.
	WindowCompositions int64
	// SurfaceHosts is the number of containers of logical surfaces and of the web views attached to the surfaces.
	SurfaceHosts int64
	// InputRegistrations is the number of registrations of the web views (main, modal, surface web views) that registered input.
	InputRegistrations int64
}

// Payload is the reply of diagnostics.native.objects.
func (o WindowObjects) Payload() map[string]int64 {
	return map[string]int64{
		"windowCompositions": o.WindowCompositions,
		"surfaceHosts":       o.SurfaceHosts,
		"inputRegistrations": o.InputRegistrations,
	}
}

// String is the notation of the counts used in error messages.
func (o WindowObjects) String() string {
	return fmt.Sprintf("windowCompositions %d, surfaceHosts %d, inputRegistrations %d",
		o.WindowCompositions, o.SurfaceHosts, o.InputRegistrations)
}

// ErrWindowObjectsEqual is the error for an invalid equal of diagnostics.native.objects.
var ErrWindowObjectsEqual = errors.New("equal must be an object of windowCompositions, surfaceHosts and inputRegistrations, each a non-negative integer")

// ParseWindowObjects reads the equal of diagnostics.native.objects. A name other than the three names, a missing name, and a value that is not an integer or
// is negative are rejected with ErrWindowObjectsEqual.
func ParseWindowObjects(raw json.RawMessage) (WindowObjects, error) {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil || fields == nil || len(fields) != 3 {
		return WindowObjects{}, ErrWindowObjectsEqual
	}
	read := func(name string) (int64, bool) {
		value, ok := fields[name]
		if !ok {
			return 0, false
		}
		// json.Number also accepts a number inside quotes, so the value is read as any and checked to be a JSON number.
		decoder := json.NewDecoder(bytes.NewReader(value))
		decoder.UseNumber()
		var decoded any
		if decoder.Decode(&decoded) != nil {
			return 0, false
		}
		number, isNumber := decoded.(json.Number)
		if !isNumber {
			return 0, false
		}
		n, err := number.Int64()
		return n, err == nil && n >= 0
	}
	compositions, ok1 := read("windowCompositions")
	hosts, ok2 := read("surfaceHosts")
	registrations, ok3 := read("inputRegistrations")
	if !ok1 || !ok2 || !ok3 {
		return WindowObjects{}, ErrWindowObjectsEqual
	}
	return WindowObjects{WindowCompositions: compositions, SurfaceHosts: hosts, InputRegistrations: registrations}, nil
}

// ErrProcessID is the error for an invalid pid of diagnostics.process.exit.
var ErrProcessID = errors.New("pid must be a positive integer")

// ParseProcessID reads the pid of diagnostics.process.exit. A pid that is missing, is not a JSON integer, or is not between 1 and 2147483647 is
// rejected with ErrProcessID.
func ParseProcessID(raw json.RawMessage) (int32, error) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var decoded any
	if len(raw) == 0 || decoder.Decode(&decoded) != nil {
		return 0, ErrProcessID
	}
	number, isNumber := decoded.(json.Number)
	if !isNumber {
		return 0, ErrProcessID
	}
	pid, err := number.Int64()
	if err != nil || pid < 1 || pid > math.MaxInt32 {
		return 0, ErrProcessID
	}
	return int32(pid), nil
}

// ProcessExitWaiter is the operation that waits for the exit of a process. Only the platform implementation of a diagnostic build (tag diagnostics) provides it, and
// diagnostic code uses it by checking the value of Current() against this interface.
type ProcessExitWaiter interface {
	// WhenProcessExited gives done true when the process pid ends and false when it does not end within seconds. A process that
	// no longer exists has ended. Call it on the UI thread, and done is also called on the UI thread.
	WhenProcessExited(pid int32, seconds float64, done func(exited bool))
}

// WindowObjectCounter is the operation that counts WindowObjects. Only the platform implementation of a diagnostic build (tag diagnostics) provides it, and
// diagnostic code uses it by checking the value of Current() against this interface.
type WindowObjectCounter interface {
	// WindowObjectsWhen gives done the count and true when the count becomes equal to expected after the application handled one event and drained the autorelease pool of that event loop iteration.
	// When it does not become equal within seconds, it gives the count at that time and false. When expected is
	// nil, it gives the count after the event and true. Call it on the UI thread, and done is also called on the UI thread.
	WindowObjectsWhen(expected *WindowObjects, seconds float64, done func(counts WindowObjects, reached bool))
}

// PageObjectCounter is the operation that counts the elements and documents of a web view. Only the platform implementation of a diagnostic build (tag diagnostics) provides it, and
// diagnostic code uses it by checking the value of Current() against this interface.
type PageObjectCounter interface {
	// CountPageObjects evaluates the element count of the main document of view and its document count (the main document and its frames) in the
	// page content world, or in the content world of document regions when document is true, and gives done the counts with a nil error, or zero
	// counts and the failure. In the page content world parked is the element count of the parked surface hosts of the workbench, which are
	// outside the document; a document world gives zero. Call it on the UI thread, and done is also called on the UI thread.
	CountPageObjects(view unsafe.Pointer, document bool, done func(elements, documents, parked int64, err error))
}

// Capturer is the window recording operation. Only the platform implementation of a diagnostic build (tag diagnostics) provides it, and
// diagnostic code uses it by checking the value of Current() against this interface.
type Capturer interface {
	// WindowNumbers returns the window server numbers of the window and its child windows. The number of the window itself comes first.
	WindowNumbers(window unsafe.Pointer) ([]int, error)
	// CaptureOpen makes the window with the window server number windowNumber the recording target. With display, it records the windows of this app on the display
	// that holds the window.
	CaptureOpen(windowNumber int, display bool) error
	// CaptureStart starts the frame recording in directory.
	CaptureStart(directory string) error
	// CaptureWait returns whether the first frame was recorded.
	CaptureWait() (bool, error)
	// CaptureStop ends the recording and returns the number of recorded frames.
	// after is the last display time (ms, on the same clock as the display time) to include in the recording, and 0 means the time of the call.
	CaptureStop(after float64) (int, error)
	// CaptureLimited tells whether the last recording reached the frame limit.
	CaptureLimited() bool
	// CaptureLongestGap is the longest display interval (ms) between consecutive frames in the recording stopped last.
	CaptureLongestGap() float64
	// CaptureClock is the current time (ms). It is on the same clock as the display time of the recorded frames.
	CaptureClock() float64
	// DeliveredNotifications gives done the notifications of this application that the notification center still shows, as [{identifier, title, body}] JSON.
	// Call it on the UI thread, and done is also called on the UI thread.
	DeliveredNotifications(done func(json string))
	// LayoutTraceStart starts recording, for each layout transaction, the start, the app DOM display confirmation, and the commit time. Call it on the UI thread.
	LayoutTraceStart()
	// LayoutTraceStop stops the recording and returns, for each transaction, ticket, begun, presented and committed (ms, on the same clock as the display time).
	// A stage that did not happen is NaN. Call it on the UI thread.
	LayoutTraceStop() ([][5]float64, error)
	// CaptureStill takes one picture of the window with the window server number windowNumber without giving it focus and writes it to path as PNG.
	// It is observation material.
	CaptureStill(windowNumber int, path string) error
}

// CoreRootResolver returns the file at urlPath of the core root of a view of plugin (docs/spec/plugin-processes.md, rule 4)
// with its content type. found is false for a path that is not served.
type CoreRootResolver func(plugin, urlPath string) (data []byte, contentType string, found bool)

// CoreRootHost registers the core root resolver of the application.
type CoreRootHost interface {
	// SetCoreRoot receives the resolver. The native scheme of each view calls it on the UI thread for each request of sok://core/<path>,
	// and the view receives the file with the header Access-Control-Allow-Origin of its plugin when found is true.
	SetCoreRoot(resolve CoreRootResolver) error
}

// Platform is the behavior that differs for each operating system.
//
// A function that does not return an error receives only a handle that a creation function returning an error made.
type Platform interface {
	CoreRootHost
	// EnqueueUI runs work once on the main queue after the current framework event callback ends.
	EnqueueUI(work func()) error
	// PrepareWindow fits the sizes of the content view of the window and the main web view.
	PrepareWindow(window unsafe.Pointer) error
	// Fullscreen switches the window to full screen or back and calls done on the UI thread when the transition
	// ends. A request that arrives during a transition is handled after that transition ends.
	Fullscreen(window unsafe.Pointer, on bool, done func()) error

	// TitlebarHeight returns the title bar height (pt) of the window. It is 0 while the title bar is not shown, as in full screen, and
	// it returns an error when the window has no buttons. Call it on the UI thread.
	TitlebarHeight(window unsafe.Pointer) (float64, error)
	// SetTitlebarHeight sets the title bar of the window to height (pt). AppKit places the window buttons at the vertical center of that height,
	// so the host does not move the buttons. It returns an error when the window has no buttons. A full screen window does not show the title bar, and
	// AppKit restores the height at which it entered when it leaves, so the call succeeds without changing the height. Call it on the UI thread.
	SetTitlebarHeight(window unsafe.Pointer, height float64) error
	// WindowControls returns the region that the window buttons occupy in page coordinates.
	WindowControls(window unsafe.Pointer) (Rect, error)
	// WindowFacts returns the frame, the active state, the window buttons and the web views of the window as JSON. The form is
	// the same as sp_window_facts of native/darwin/src/window_facts.h. Call it on the UI thread.
	WindowFacts(window unsafe.Pointer) (string, error)
	// ProcessFootprintKB returns the physical footprint (KB) of the process pid: the size that the system attributes to the process,
	// which counts the pages that no other process shares. The resident size counts the shared pages too. It returns an error when the
	// process cannot be read, such as a process that has ended.
	ProcessFootprintKB(pid int) (uint64, error)
	SetMainWebview(window unsafe.Pointer) error
	// RevealAfterLoad keeps the window transparent and makes it opaque when the next display ends after the first load of the main web view finished.
	// The caller puts the window on the screen after this call (native/darwin/src/window_reveal.h). Call it on the UI thread.
	RevealAfterLoad(window unsafe.Pointer) error
	// FileDrop receives, as dropped, the files that were dropped on the window of the main web view. json is {"urls":[...],"x":..,"y":..}
	// (page coordinates). Call it on the UI thread.
	FileDrop(main unsafe.Pointer, dropped func(json string)) error
	MainWebview(window unsafe.Pointer) (unsafe.Pointer, error)
	// KillWebContentProcess ends the current WebContent process. The application termination calls it so that WebKit child processes are not left
	// behind.
	KillWebContentProcess(view unsafe.Pointer) error
	// SampleThreads writes the stacks of the threads of this process, sampled for one second, into the file path. The watch of
	// the main thread calls it for a stall (docs/spec/logging.md, stalls).
	SampleThreads(path string) error
	// CollectGarbage makes the WebContent processes of view collect JavaScript objects. The memory measurement of a diagnostic build
	// uses it. Call it on the UI thread.
	CollectGarbage(view unsafe.Pointer) error
	// ConfigureMainWindow makes the background of the main web view of the window transparent and fits the appearance of the window to dark. Call it on the UI thread.
	ConfigureMainWindow(window unsafe.Pointer, dark bool) error
	ClipboardRead(kind string) (ClipboardValue, error)
	ClipboardWriteText(text string) error
	ClipboardWritePNG(bytes []byte) error
	// OpenLink opens a URL with the default application of the user for its scheme. Call it on the UI thread.
	OpenLink(url string) error
	// DiagnosticReportsDirectory is the folder in which the operating system writes the crash reports of the current user, as the
	// system names it.
	DiagnosticReportsDirectory() (string, error)
	// StartNotifications starts using the notification center of the operating system and passes its event JSON to receive on the UI thread
	// ({"type":"state",...} and {"type":"activated","identifier":...}). Call it on the UI thread.
	StartNotifications(receive func(event string)) error
	// PostNotification posts or replaces the notification of identifier. Call it on the UI thread.
	PostNotification(identifier, title, body string) error
	// RemoveNotification removes the notification of identifier. Call it on the UI thread.
	RemoveNotification(identifier string) error
	// WindowHit returns the hit test result {view, main, identifier} at the window coordinates (x, y) as JSON.
	// Call it on the UI thread.
	WindowHit(window unsafe.Pointer, x, y float64) (string, error)
	// MoveWindow moves the top left of the window frame to the screen coordinates (x, y). Call it on the UI thread.
	MoveWindow(window unsafe.Pointer, x, y float64) error
	// Screens returns the displays [{x, y, width, height, scale}] as JSON in screen coordinates.
	// Call it on the UI thread.
	Screens() (string, error)

	// CreateWebview adds a native web view above the main web view of the window and returns its handle.
	CreateWebview(window unsafe.Pointer, options WebviewOptions) (unsafe.Pointer, error)
	// NavigateWebview opens url relative to the address of the main document. It returns false when url is invalid.
	NavigateWebview(view unsafe.Pointer, url string) bool
	SetWebviewBounds(view unsafe.Pointer, x, y, width, height float64)
	SetWebviewHidden(view unsafe.Pointer, hidden bool)
	// SetWebviewBackground sets the value of window.__soksakBackground of the document.
	SetWebviewBackground(view unsafe.Pointer, enabled bool)
	EvaluateScript(view unsafe.Pointer, script string)
	// CloseWebview removes the web view and releases the handle.
	CloseWebview(view unsafe.Pointer)
	// WebviewFrame returns the current region of the view in page coordinates.
	WebviewFrame(view unsafe.Pointer) Rect
	// CreateSurface creates a logical SurfaceHost below the main DOM web view.
	CreateSurface(main unsafe.Pointer) (unsafe.Pointer, error)
	CloseSurface(surface unsafe.Pointer)
	SetSurfaceBounds(surface unsafe.Pointer, x, y, width, height float64)
	SurfaceFrame(surface unsafe.Pointer) Rect
	SetSurfaceHiddenHandle(surface unsafe.Pointer, hidden bool)
	SetSurfaceAlphaHandle(surface unsafe.Pointer, alpha float64)
	SetWindowOverlays(main unsafe.Pointer, overlays []WindowOverlay) error
	// SetWebviewAlpha sets the opacity of the view.
	SetWebviewAlpha(view unsafe.Pointer, alpha float64)
	// SetSurfaceOverlays sets the declared DOM overlays to process before the native input.
	SetSurfaceOverlays(view unsafe.Pointer, overlays []DOMOverlay)
	// SetWebviewResizing passes the start and the end of a continuous resize to the view.
	SetWebviewResizing(view unsafe.Pointer, live bool)
	// ConfigureModal sets the accessibility name and the corner radius of a modal web view.
	ConfigureModal(view unsafe.Pointer, title string, radius float64)
	// FocusModal moves the keyboard focus to the modal web view or returns it to the main web view.
	FocusModal(view unsafe.Pointer, take bool)
	// AlignRect fits a region in page coordinates inward to the display pixels.
	AlignRect(window unsafe.Pointer, at Rect) (Rect, error)

	// CreateDocument creates a hidden external document web view inside the surface web view surface. directory is the absolute path at which the persistent
	// data store keeps the site data. changed receives the state JSON ({url, title, loading, progress, canGoBack, canGoForward,
	// error, scroll}) on the UI thread.
	// folder and plugin are the installed folder and the id of the plugin whose surface owns the region; the region serves
	// sok://<plugin>/<path> from folder (docs/spec/native-surfaces.md#document-regions). channel is empty for a document region.
	// A view surface passes the text of the view channel script, and its configuration is the only one that serves the core
	// root and runs the script (docs/spec/native-surfaces.md#view-surfaces).
	CreateDocument(surface unsafe.Pointer, directory, folder, plugin, channel string, changed func(state string)) (unsafe.Pointer, error)
	// SetViewMessage receives {"message": value} for each message of the sok-view handler of a view, and {"error": reason} for a
	// message from another frame. It must be set before the view loads a page.
	SetViewMessage(document unsafe.Pointer, message func(value string)) error
	// SetViewEnded receives the end of the WebContent process of a view, before the host closes the view. A closed view receives no call.
	SetViewEnded(document unsafe.Pointer, ended func()) error
	// SetViewResponsiveness receives the responsiveness notices of a view: false when its WebContent process stops answering its
	// responsiveness check, and true when it answers again. A closed view receives no call (docs/spec/native-surfaces.md#view-surfaces).
	SetViewResponsiveness(document unsafe.Pointer, responsiveness func(responsive bool)) error
	// AddDocumentScript adds a user script that runs at document start in the page world, before any page script, for each load of the
	// document from now on. The host adds the theme script of a view before it loads the page (docs/spec/native-surfaces.md#view-surfaces).
	AddDocumentScript(document unsafe.Pointer, source string) error
	// TakeDocumentBinary takes the bytes that the binary store of the document keeps under id, and releases the id. It returns the error
	// text of the native layer when the document is closed or the id is not stored (docs/spec/native-surfaces.md#document-regions).
	TakeDocumentBinary(document unsafe.Pointer, id string) ([]byte, error)
	SetDocumentEvent(document unsafe.Pointer, event func(value string)) error
	// SetDocumentStream receives {"stream": "elements" or "requests", "message": {...}} for each stream message of the document.
	SetDocumentStream(document unsafe.Pointer, stream func(value string)) error
	// SetDocumentStreamOn turns the stream elements or requests on or off. It returns false for another stream or a closed document.
	SetDocumentStreamOn(document unsafe.Pointer, stream string, on bool) bool
	// AckDocumentStream acknowledges the element snapshot seq. It returns false for a seq that native has not sent.
	AckDocumentStream(document unsafe.Pointer, seq uint64) bool
	// SetDocumentMessage receives {"message": value} for each message of a plugin document and {"error": reason}.
	SetDocumentMessage(document unsafe.Pointer, message func(value string)) error
	// PostDocument posts the JSON value json to the current plugin document; false when there is none.
	PostDocument(document unsafe.Pointer, json string) bool
	// LoadDocument opens an http, https, file or sok address; it returns false for another address.
	LoadDocument(document unsafe.Pointer, url string) bool
	// ZoomDocument sets the page zoom of the document. It returns false when the value is not a finite positive number.
	ZoomDocument(document unsafe.Pointer, zoom float64) bool
	// GoDocument runs back 0, forward 1, reload 2, stop 3, and the history entry that is offset away from the current one 4,
	// and returns whether it ran.
	GoDocument(document unsafe.Pointer, action, offset int) bool
	// QueryDocument asks the region for its media, capture and form state; reply receives the JSON reply of native once, as
	// {media, capture, form} or {error}.
	QueryDocument(document unsafe.Pointer, reply func(value string))
	// DocumentInteractionState returns the interactionState of the region as base64, empty when the web view yields none; ok
	// is false for a closed region.
	DocumentInteractionState(document unsafe.Pointer) (state string, ok bool)
	// RestoreDocument restores the base64 interactionState into a region that has loaded nothing; the error is the refusal of
	// native.
	RestoreDocument(document unsafe.Pointer, state string) error
	// PlaceDocument sets the document region with the CSS pixel margins of the surface viewport.
	PlaceDocument(document unsafe.Pointer, left, top, right, bottom float64, visible bool)
	// SetDocumentBackground dims the document while a dialog is open.
	SetDocumentBackground(document unsafe.Pointer, enabled bool)
	// SetDocumentAppearance sets the explicit theme of the document web view and its web content.
	SetDocumentAppearance(document unsafe.Pointer, dark bool)
	// CloseDocument removes the document web view. changed is not called afterward.
	CloseDocument(document unsafe.Pointer)

	// CreateImage creates an external picture display region inside the surface web view surface. event receives
	// keyboard, IME and input events as a JSON string ({key, insert, compose, focus, size, error})
	// on the main thread.
	CreateImage(surface unsafe.Pointer, name string, event func(json string)) (unsafe.Pointer, error)
	// PlaceImage sets the image region with the CSS pixel margins of the surface viewport.
	PlaceImage(image unsafe.Pointer, left, top, right, bottom float64, visible bool)
	// RasterImage returns the device pixel size of the applied image region and the ratio of device pixels per CSS pixel.
	RasterImage(image unsafe.Pointer) (width, height int, scale float64, ok bool)
	// SurfacePlacedImage returns whether the surface of the region has a native size. A region of a surface that is not laid out yet has no raster size.
	SurfacePlacedImage(image unsafe.Pointer) bool
	// PresentImage displays an external IOSurface. token_id is the global ID of the IOSurface,
	// nonce is the 16-byte data to compare with the nonce, width and height are the size in device pixels,
	// and scale is the scale at which the image was created (used as contentsScale).
	// On failure, it returns the native rejection reason (notFound, forbidden, size, unsupported and others) as an error string.
	PresentImage(image unsafe.Pointer, token_id uint32, nonce [16]byte, width, height, scale float64) error
	// FocusImage makes the region the first responder and sends a focus event.
	FocusImage(image unsafe.Pointer)
	// CaretImage stores the caret (input cursor) position.
	CaretImage(image unsafe.Pointer, x, y, w, h float64)
	// TextImage stores the string to show as the accessibility value.
	TextImage(image unsafe.Pointer, utf8 string)
	// FactsImage returns all information of the region as JSON.
	FactsImage(image unsafe.Pointer) (string, error)
	// CloseImage removes the image region. event is not called afterward.
	CloseImage(image unsafe.Pointer)

	// BeginLayout starts a surface layout transaction. When the layout becomes possible, it calls ready on the UI thread.
	BeginLayout(window unsafe.Pointer, ticket uint64, ready func(allowed bool)) error
	// CommitLayout fixes the layout of ticket and returns whether it fixed it.
	CommitLayout(window unsafe.Pointer, ticket uint64) bool
	// CancelLayout cancels the layout in progress.
	CancelLayout(window unsafe.Pointer) error
	// JoinView joins the view webview to the open layout transaction of window with ticket, so that the commit waits until the view
	// presents. presented is called on the UI thread when the view presents. abandon ends the join without presentation and is
	// nil when joined is false, which means that no transaction of ticket is open.
	JoinView(window unsafe.Pointer, ticket uint64, view unsafe.Pointer, presented func()) (abandon func() error, joined bool, err error)
	// StartPageTitlebar sets the title bar of the window to height (pt) when a new page starts. For a visible window, it sets it inside the start
	// transaction of ticket and commits it together with the first display of the new page (surfaceLayoutStartPage). It calls ready on the
	// UI thread after setting it or after a failure. Call it on the UI thread.
	StartPageTitlebar(window unsafe.Pointer, ticket uint64, height float64, ready func(error)) error
	// AfterPresentation checks the display readiness of the app document before the open layout is committed.
	AfterPresentation(window unsafe.Pointer, done func()) error
	// AfterSettled calls done on the UI thread after the main web view and the visible app document displayed the screen, in a state
	// in which the window has no open surface layout transaction. displayed is the time (ms, mach absolute time) at which that screen is displayed.
	AfterSettled(window unsafe.Pointer, done func(displayed float64, err error)) error
	// InjectSettledFailure makes the next settled wait fail in a diagnostic build.
	InjectSettledFailure(window unsafe.Pointer) error

	// CreateShape creates a shape view that is drawn over a surface. It returns a nil handle when the window has no content view.
	CreateShape(window unsafe.Pointer, x, y, w, h float64) (unsafe.Pointer, error)
	SetShapeFrame(shape unsafe.Pointer, x, y, w, h float64)
	// SetShapeStyle sets the corner radius, the line width, the fill color and the line color. The colors are sRGB in the range 0-1 and alpha.
	SetShapeStyle(shape unsafe.Pointer, radius, lineWidth float64, fill, line [4]float64)
	// RaiseShape raises the shape above its sibling views.
	RaiseShape(shape unsafe.Pointer)
	DestroyShape(shape unsafe.Pointer)

	// WatchInput watches the presses, drags and key inputs of the window and returns the watch number.
	WatchInput(window unsafe.Pointer, input Input) (uintptr, error)
	// UnwatchInput releases the watch that WatchInput returned.
	UnwatchInput(monitor uintptr)

	// WatchButtons installs the watch of the mask of pressed mouse buttons that the operating system reports. It reports the current mask at the time of installation, and
	// after that, for every press or release of a mouse button delivered to any application, it reports the mask of that time through changed on the UI thread.
	// It also reports the same mask again. Call it once on the UI thread after the application started.
	WatchButtons(changed func(mask uint64)) error

	// InjectPointer delivers a pointer input at the content area coordinates (x, y) of the window and returns the result.
	// phase is 0 for move, 1 for press, 2 for drag, 3 for release and 4 for scroll, and button is 0 for left and 1 for right.
	// For a press and a release, it calls done on the UI thread after the document at the coordinates received the event or receive seconds passed.
	// For other phases, it calls done immediately after delivery. held is the state of the rejection when the result is PointerButtonHeld.
	InjectPointer(window unsafe.Pointer, x, y float64, phase, button int, deltaX, deltaY, receive float64, done func(result PointerResult, held ButtonHeld)) error
	// ActivateWindow activates the application and the window. It calls done(nil) on the UI thread after only the web view at the coordinates received the active state,
	// or calls done with an error that names the stage where it stopped when it does not finish within timeout seconds.
	// When the coordinates are a native surface, it does not wait for the web view state.
	ActivateWindow(window unsafe.Pointer, x, y, timeout float64, done func(error)) error
	// InjectKey delivers a key input to the window and returns whether it delivered it. modifiers is the bit sum of 1 Shift, 2 Control,
	// 4 Option and 8 Command.
	InjectKey(window unsafe.Pointer, key, text string, modifiers uint, down bool) (PointerResult, error)

	// Listen creates the listener of the local endpoint in directory. directory must be exclusive to the current user.
	// application is part of the address name.
	// When the listener is closed, the address is also removed.
	Listen(directory, application string) (net.Listener, Endpoint, error)
	// ServiceProcessExists checks, before an endpoint is reused after the application restarted,
	// whether the preserved sidecar service process is still alive. It is an error when this cannot be determined.
	ServiceProcessExists(pid int) (bool, error)
	// WaitServiceProcessEnd waits until the service process pid ends, for at most timeout, and answers whether it ended.
	// A process that does not exist has ended. The wait uses the kernel notification of the end of a process, which
	// also reports a process that stays as a zombie, so it does not poll (docs/spec/terminal-runtime.md#updates).
	WaitServiceProcessEnd(pid int, timeout time.Duration) (bool, error)
	// NewSession makes command start in a new session. A persistent service belongs to the configuration directory and not to the application process,
	// so it does not receive the signals of the process group and the terminal of the application. Call it before starting
	// command.
	NewSession(command *exec.Cmd) error
	// ExitStatus writes the exit of an ended process as `exit status <code>` or `signal <number>`. Both hosts write the exit of a
	// sidecar to the log with the same text (docs/spec/sidecars.md#declaration-and-startup).
	ExitStatus(state *os.ProcessState) (string, error)
	// SecureServiceDirectory makes the persistent service directory path accessible only to the current user.
	SecureServiceDirectory(path string) error

	// OnTermination makes quit be called with the first termination signal (SIGTERM, SIGINT, SIGHUP) that is received. A termination
	// signal after that ends the process with the default action.
	OnTermination(quit func(signal os.Signal)) error
	// OnQuitRequest makes quit be called when a termination request of the operating system (quit from the Dock, logout, restart, a quit Apple event of another program) is
	// received, and that request is not answered until AnswerQuitRequests. Call it on the UI thread after the application
	// started.
	OnQuitRequest(quit func()) error
	// AnswerQuitRequests answers the received termination requests without an error. Call it on the UI thread right before the application ends after the save finished.
	AnswerQuitRequests()
	// CancelQuitRequests answers the received termination requests with userCanceledErr. Call it on the UI thread when a window protects a modified
	// tab and the application does not end.
	CancelQuitRequests()

	// OnMemoryPressure starts the one memory pressure source of the process, which observes the levels normal, warn and critical
	// (docs/spec/hosts.md#memory-pressure); report is called on the UI thread with the level and the seq of each change of level.
	// Call it once on the UI thread after the application started.
	OnMemoryPressure(report func(level string, seq uint64)) error
	// InjectMemoryPressure delivers the level normal, warn or critical as the memory pressure source delivers it; it is the fault
	// injection of the checks. Call it on the UI thread after OnMemoryPressure.
	InjectMemoryPressure(level string) error

	// InstantWindowResize makes the window zoom and the animated resize end within one screen update.
	// Call it before creating a window.
	InstantWindowResize() error

	// PullNativeEvents moves whole records of the native event ring into buffer and returns the number of bytes written;
	// 0 means the ring is empty (docs/spec/logging.md#writers).
	PullNativeEvents(buffer []byte) (int, error)

	// TakeNativeEventLoss returns the events and bytes that the native ring refused in a channel (0 for the main file, 1 for the
	// debug file) since the last call.
	TakeNativeEventLoss(channel uint8) (events, bytes uint64, err error)

	// SetNativeEventPolicy gives the native library the policy of the event log (docs/spec/logging.md#classes-and-policy): for each
	// class, in the order lifecycle, input, call, io, frame, the number of the least severe level that is stored (0 error, 1 warn,
	// 2 info, 3 debug, 4 trace) or -1 for none. It is an error for a value outside -1 to 4.
	SetNativeEventPolicy(levels [5]int8) error

	// MonotonicNanos reads the monotonic clock of the records in nanoseconds (`mono_ns` of docs/spec/logging.md#event): the
	// clock that the native library stamps its events with, so the layers of one process compare.
	MonotonicNanos() (uint64, error)

	// SetEventBoot gives the native library the boot identifier of the run, which its correlation identifiers carry
	// (`<boot>.<n>`). It is an error for an empty identifier and for one with a character other than letters, digits, '-' and '_'.
	SetEventBoot(boot string) error

	// ObserveActivity installs the observers that record the activity of the application and of its windows as events of
	// the native ring (docs/spec/logging.md#automatic-entrances). A second call installs nothing more.
	ObserveActivity() error

	// FlushNativeObservers stores the summary of every counted source of the native observers that has deliveries after its last
	// summary, so the tail of a source is in the native ring before the last pull (docs/spec/logging.md#automatic-entrances).
	FlushNativeObservers() error

	// ReplaceStandardError replaces the standard error of the process with file. Child processes started afterward also inherit that
	// descriptor (docs/spec/hosts.md#application-log).
	ReplaceStandardError(file *os.File) error

	// InstallDock registers the Dock menu. The new window item calls newWindow.
	InstallDock(newWindow func()) error
	// DockItems returns the titles of the Dock menu items as a JSON array. Call it on the UI thread.
	DockItems() (string, error)
	// MenuItems returns the application menu as a JSON array. Each submenu is {title, items: [{title, key}]}.
	// Call it on the UI thread.
	MenuItems() (string, error)
	// PreferredLanguage returns the main tag (for example "ko") of the system preferred language. It is used to map the initial menu language to
	// a language of the contract table. Call it on the UI thread.
	PreferredLanguage() (string, error)
	// OSVersion returns the product version of the operating system, such as "26.6.2" (docs/spec/debug.md).
	OSVersion() (string, error)
	// MenuSelect runs the item with the title title in the submenu with the title menu. Call it on the UI thread.
	MenuSelect(menu, title string) error
	// MainWindow is the handle of the main window of the application. It is nil when there is none. Call it on the UI thread.
	MainWindow() (unsafe.Pointer, error)
	// DockSelect runs the Dock menu item with the title title. Call it on the UI thread.
	DockSelect(title string) error

	// DirectoryIdentity returns the string that identifies a directory.
	DirectoryIdentity(path string, info os.FileInfo) (string, error)
	// CreatePrivateDirectories creates the missing directories of path with permissions exclusive to the current user. It does not change the permissions of a directory
	// that already exists.
	CreatePrivateDirectories(path string) error
	// AppendPrivateFile opens the file at path for appending. When it does not exist, it creates a file that only the current user reads and writes. It does not change the permissions of an existing
	// file.
	AppendPrivateFile(path string) (*os.File, error)
	// CreatePrivateFile creates a new file at path that only the current user reads and writes and opens it for writing. When path already exists, the error is
	// os.ErrExist.
	CreatePrivateFile(path string) (*os.File, error)
	// OpenPrivateFile opens the existing file at path for reading and writing. A missing file is an os.ErrNotExist error, and its contents and
	// permissions are not changed.
	OpenPrivateFile(path string) (*os.File, error)
	// TryLockFile takes an exclusive advisory lock (flock LOCK_EX|LOCK_NB) on file without waiting. It reports false when another open file holds the
	// lock.
	TryLockFile(file *os.File) (bool, error)
	// IsNamedFile reports whether file is the file that path names now, which is the same device and inode. A missing path names no file.
	IsNamedFile(file *os.File, path string) (bool, error)
	// WritePrivateFile replaces the content of the file at path with data. When it does not exist, it creates a file that only the current user reads and writes. It does not change the permissions of an existing
	// file.
	WritePrivateFile(path string, data []byte) error
	// PrivateDirectory creates a directory that only the current user can access, together with its parent directories. When it already exists, it checks the kind,
	// the owner and the permissions. The recording and the capture of a diagnostic build use it.
	PrivateDirectory(path string) error
}

// PointerResult is the result of delivering a pointer input.
type PointerResult int

const (
	// PointerDelivered means that the input was delivered.
	PointerDelivered PointerResult = iota
	// PointerRejected means that the input was not delivered because the window, the coordinates or the phase is not valid.
	PointerRejected
	// PointerInactive means that the input is a move without a button and the window is not the key window, so it was not delivered.
	PointerInactive
	// PointerUnreceived means that a press or a release was delivered but the document did not receive it within the time limit.
	PointerUnreceived
	// PointerButtonHeld means that AppKit reported a pressed mouse button, so the synthetic press or release was not delivered.
	PointerButtonHeld
	// PointerPressOpen means that the synthetic press of that button in that window is still open, so the press was not delivered.
	PointerPressOpen
)

// ButtonHeld is the state that AppKit reported at the time of the rejection with PointerButtonHeld.
type ButtonHeld struct {
	// Mask is the value of NSEvent.pressedMouseButtons.
	Mask uint64
	// Frontmost is the frontmost application. It is nil when AppKit does not report a frontmost application.
	Frontmost *FrontmostApplication
}

// FrontmostApplication is the frontmost application. BundleIdentifier is an empty string when there is no bundle identifier.
type FrontmostApplication struct {
	BundleIdentifier string
	PID              int
}

// Endpoint is the transport and the address of the local endpoint.
type Endpoint struct {
	// Transport is unix or pipe.
	Transport string
	Address   string
}

var (
	mu      sync.Mutex
	current Platform
)

// Register registers the implementation of the current operating system. A second registration fails.
func Register(p Platform) {
	mu.Lock()
	defer mu.Unlock()
	if current != nil {
		panic("platform: implementation registered twice")
	}
	current = p
}

// Current returns the registered implementation. It returns an error when no implementation is registered.
func Current() (Platform, error) {
	mu.Lock()
	defer mu.Unlock()
	if current == nil {
		return nil, errors.New("no platform implementation is registered")
	}
	return current, nil
}

// Dispatcher passes the document commits and the messages that a web view announced on the UI thread to a handler outside the UI thread. A receiver can wait for the main
// thread, so the dispatcher returns to WebKit before it calls the handler.
//
// WebKit announces the commit of a web view and the messages of the later document in the order received. The handlers run in their own goroutines, so
// for the same web view, the message handler is called after the handling of the commit received before the message finished, and commits are also handled in the
// order received. This keeps the first request of a new document from running before the cleanup of the previous document. Another web view
// is not waited for.
type Dispatcher struct {
	// Receive receives the messages that the document of the web view sent.
	Receive func(identifier uint64, body string)
	// Committed receives that the web view started to show a new document.
	Committed func(identifier uint64)
	// Held is called with the web view number when a message starts to wait for the handling of an earlier commit of the same web view. It is the point at which a check observes
	// the hold, and it is not called when nil.
	Held func(identifier uint64)

	mu sync.Mutex
	// views is the order of the web views that have a commit in progress. It is cleared when every received commit is handled.
	views map[uint64]*documentOrder
}

// documentOrder is the number of commits received and the number of commits whose handling finished for one web view. changed is closed and recreated
// each time a handling finishes.
type documentOrder struct {
	received, handled uint64
	changed           chan struct{}
}

// wait waits until the number of commits of order whose handling finished is count.
func (d *Dispatcher) wait(order *documentOrder, count uint64) {
	for {
		d.mu.Lock()
		if order.handled >= count {
			d.mu.Unlock()
			return
		}
		changed := order.changed
		d.mu.Unlock()
		<-changed
	}
}

// Handle changes the receiver function. It is called on the UI thread when a web view is created, and Commit and Message on other threads read it inside the same
// lock.
func (d *Dispatcher) Handle(receive func(identifier uint64, body string), committed func(identifier uint64)) {
	d.mu.Lock()
	d.Receive, d.Committed = receive, committed
	d.mu.Unlock()
}

// Commit passes a commit received on the UI thread to handler. It is called after the handling of the earlier commit of the same web view finished.
func (d *Dispatcher) Commit(identifier uint64) {
	d.mu.Lock()
	handler := d.Committed
	if handler == nil {
		d.mu.Unlock()
		return
	}
	if d.views == nil {
		d.views = map[uint64]*documentOrder{}
	}
	order := d.views[identifier]
	if order == nil {
		order = &documentOrder{changed: make(chan struct{})}
		d.views[identifier] = order
	}
	order.received++
	count := order.received
	d.mu.Unlock()
	routine.Go("dispatcher-commit", func() {
		d.wait(order, count-1)
		handler(identifier)
		d.mu.Lock()
		order.handled = count
		close(order.changed)
		order.changed = make(chan struct{})
		if order.handled == order.received && d.views[identifier] == order {
			delete(d.views, identifier)
		}
		d.mu.Unlock()
	})
}

// Message passes a message received on the UI thread to handler. It is called after the handling of the commit of the same web view received before it finished.
func (d *Dispatcher) Message(identifier uint64, body string) {
	d.mu.Lock()
	handler := d.Receive
	if handler == nil {
		d.mu.Unlock()
		return
	}
	order := d.views[identifier]
	var count uint64
	if order != nil {
		count = order.received
	}
	d.mu.Unlock()
	routine.Go("dispatcher-message", func() {
		if order != nil {
			if d.Held != nil {
				d.Held(identifier)
			}
			d.wait(order, count)
		}
		handler(identifier, body)
	})
}
