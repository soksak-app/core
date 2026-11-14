// Surface synchronization, display confirmation, layout, and delivery of surface input.
//
// The page declares the region of each surface at every commit. A surface is a native web view added to the main window as a
// child at the declared region. bindings.go handles the messages of a native web view, and
// the operating system implementation delivers pointer input.

package host

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"unsafe"

	"github.com/soksak-app/core/packages/host/go/src/platform"
	"github.com/soksak-app/core/packages/host/go/src/routine"
)

// platformRect is the region that the operating system implementation uses. It has the same fields as Rect, so they are converted to each other.
type platformRect = platform.Rect

// Rect is a region in CSS pixels relative to the page viewport.
type Rect struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
	W float64 `json:"w"`
	H float64 `json:"h"`
}

type Surface struct {
	ID      string `json:"id"`
	Visible bool   `json:"visible"`
	// Tells whether the page requested that a surface that lost focus be dimmed.
	Dim bool `json:"dim"`
	// Plugin is the id of the plugin that owns the surface. A document region opens the plugin document of that plugin.
	Plugin      string             `json:"plugin"`
	Composition SurfaceComposition `json:"composition"`
	Rect
	// Start holds the start values of the view of a view surface, which the host injects as window.sokSurface before the page
	// runs (docs/spec/native-surfaces.md#view-surfaces). A surface of another composition carries none.
	Start *ViewStart `json:"start,omitempty"`
}

// SurfaceProject is the id and the canonical root of the project that the window shows, or nil when the window shows no project
// (docs/spec/plugins.md#tab-reports).
type SurfaceProject struct {
	ID   string `json:"id"`
	Root string `json:"root"`
}

// ViewStart is the start values of a view (docs/spec/native-surfaces.md#view-surfaces): the members of the surface context that
// the page receives at start, which the host injects as window.sokSurface before the page of the view runs.
type ViewStart struct {
	Params json.RawMessage `json:"params,omitempty"`
	// Origin is the origin of the view as the page sent it: the required form {"directory": path or null}, kept raw so that a
	// missing origin and a null origin are refused alike (viewOriginDirectory).
	Origin       json.RawMessage `json:"origin,omitempty"`
	Project      *SurfaceProject `json:"project,omitempty"`
	Declarations json.RawMessage `json:"declarations,omitempty"`
	// Diagnostics is the diagnostic declaration of the plugin or JSON null, kept raw so that a missing value is refused
	// (validateViewStart).
	Diagnostics json.RawMessage `json:"diagnostics,omitempty"`
	// Section is the section of the view or JSON null, kept raw so that a missing section is refused (validateViewStart).
	Section json.RawMessage `json:"section,omitempty"`
}

// viewStartOf returns the start values that the view of surface uses: those of the request or, when the request carries none, those that the host holds (docs/spec/native-surfaces.md#view-surfaces). It runs on the UI thread, as the record does.
func (s *Surfaces) viewStartOf(surface Surface) (ViewStart, error) {
	if surface.Start != nil {
		return *surface.Start, nil
	}
	spec := s.viewRecords().specs[surface.ID]
	if spec == nil {
		return ViewStart{}, fmt.Errorf("surface %q: view start is missing", surface.ID)
	}
	return spec.start, nil
}

// validateViewStart checks the start values of the view of the surface (docs/spec/native-surfaces.md#view-surfaces).
func validateViewStart(surface string, start *ViewStart) error {
	if start.Params != nil && !json.Valid(start.Params) {
		return fmt.Errorf("surface %q: view start params are not JSON", surface)
	}
	if start.Project != nil && start.Project.ID == "" {
		return fmt.Errorf("surface %q: view start project id is empty", surface)
	}
	if start.Project != nil && start.Project.Root == "" {
		return fmt.Errorf("surface %q: view start project root is empty", surface)
	}
	if start.Declarations != nil {
		var declarations map[string]json.RawMessage
		if err := json.Unmarshal(start.Declarations, &declarations); err != nil {
			return fmt.Errorf("surface %q: view start declarations are not an object", surface)
		}
	}
	if _, err := viewOriginDirectory(surface, start.Origin); err != nil {
		return err
	}
	if err := checkViewDiagnostics(surface, start.Diagnostics); err != nil {
		return err
	}
	return checkViewSection(surface, start.Section)
}

// checkViewSection checks the section of the start values of the view of surface: it is required, and it is null or an object
// with exactly a non-empty id, a non-empty sidebar and a card that is a non-empty text or null
// (docs/spec/native-surfaces.md#view-surfaces).
func checkViewSection(surface string, section json.RawMessage) error {
	if section == nil {
		return fmt.Errorf("surface %q: view start section is missing", surface)
	}
	if strings.TrimSpace(string(section)) == "null" {
		return nil
	}
	malformed := fmt.Errorf("surface %q: view start section is not {id, sidebar, card}", surface)
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(section, &fields); err != nil || len(fields) != 3 {
		return malformed
	}
	for _, key := range []string{"id", "sidebar", "card"} {
		if _, ok := fields[key]; !ok {
			return malformed
		}
	}
	var value struct {
		ID      *string `json:"id"`
		Sidebar *string `json:"sidebar"`
		Card    *string `json:"card"`
	}
	if err := json.Unmarshal(section, &value); err != nil {
		return malformed
	}
	if value.ID == nil || *value.ID == "" || value.Sidebar == nil || *value.Sidebar == "" || (value.Card != nil && *value.Card == "") {
		return malformed
	}
	return nil
}

// checkViewDiagnostics checks the diagnostic declaration of the start values of the view of surface: it is required, and it is an
// object or null (docs/spec/native-surfaces.md#view-surfaces).
func checkViewDiagnostics(surface string, diagnostics json.RawMessage) error {
	if diagnostics == nil {
		return fmt.Errorf("surface %q: view start diagnostics is missing", surface)
	}
	if strings.TrimSpace(string(diagnostics)) == "null" {
		return nil
	}
	var declaration map[string]json.RawMessage
	if err := json.Unmarshal(diagnostics, &declaration); err != nil {
		return fmt.Errorf("surface %q: view start diagnostics is not an object or null", surface)
	}
	return nil
}

// viewOriginDirectory returns the directory that the origin of the view of surface records, or nil when it records none. The origin
// is required and has the one form {"directory": path} or {"directory": null}; any other value is refused with its reason
// (docs/spec/native-surfaces.md#view-surfaces).
func viewOriginDirectory(surface string, origin json.RawMessage) (*string, error) {
	if origin == nil {
		return nil, fmt.Errorf("surface %q: view start origin is missing", surface)
	}
	malformed := fmt.Errorf("surface %q: view start origin is not {directory} with a path or null", surface)
	var fields map[string]json.RawMessage
	// default: the decode error is reported as the form error; a JSON null decodes to no map, which is refused the same way.
	if err := json.Unmarshal(origin, &fields); err != nil || fields == nil || len(fields) != 1 {
		return nil, malformed
	}
	directory, ok := fields["directory"]
	if !ok {
		return nil, malformed
	}
	if string(directory) == "null" {
		return nil, nil
	}
	var path string
	if err := json.Unmarshal(directory, &path); err != nil {
		return nil, malformed
	}
	if path == "" {
		return nil, fmt.Errorf("surface %q: view start origin directory is empty", surface)
	}
	if !localAbsolutePath(path) {
		return nil, fmt.Errorf("surface %q: view start origin directory is not an absolute path", surface)
	}
	return &path, nil
}

// localAbsolutePath reports whether a view origin directory is an absolute path in the one local form: it starts with `/`,
// not with `//` (UNC) or `/<letter>:` (drive), and holds no NUL byte. The rule is a string rule, so every host applies the same
// test on every platform: the // and drive forms are refused for portability, not because the platform API accepts them.
// The Rust host runs the same test (is_local_absolute_path).
func localAbsolutePath(path string) bool {
	drive := len(path) >= 3 && path[0] == '/' && ((path[1] >= 'A' && path[1] <= 'Z') || (path[1] >= 'a' && path[1] <= 'z')) && path[2] == ':'
	return strings.HasPrefix(path, "/") && !strings.HasPrefix(path, "//") && !drive && !strings.Contains(path, "\x00")
}

type SurfaceRegion struct {
	Name    string `json:"name"`
	Kind    string `json:"kind"`
	Sidecar string `json:"sidecar,omitempty"`
	// Present is the presentation mode of an image region, copy or lease (docs/spec/native-surfaces.md#image-regions).
	Present string `json:"present,omitempty"`
	Input   string `json:"input"`
}

type SurfaceComposition struct {
	Kind     string          `json:"kind"`
	Page     string          `json:"page,omitempty"`
	Regions  []SurfaceRegion `json:"regions,omitempty"`
	Overlays []string        `json:"overlays,omitempty"`
}

// declaresImageRegion reports whether the composition declares an image region, which takes the keys of its surface.
func (c SurfaceComposition) declaresImageRegion() bool {
	for _, region := range c.Regions {
		if region.Kind == "image" {
			return true
		}
	}
	return false
}

func validCompositionName(name string) bool {
	if len(name) < 1 || len(name) > 64 {
		return false
	}
	for i, ch := range name {
		if (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') || (i > 0 && ch == '-') {
			continue
		}
		return false
	}
	return true
}

// validViewPage reports whether page is a path inside the plugin release: relative, with no empty, `.` or `..` segment, no `.binary`
// segment, and the `.html` extension (docs/spec/plugins.md#view-surfaces).
func validViewPage(page string) bool {
	if !strings.HasSuffix(page, ".html") {
		return false
	}
	for _, segment := range strings.Split(page, "/") {
		if segment == "" || segment == "." || segment == ".." || segment == ".binary" {
			return false
		}
	}
	return true
}

func validateComposition(plugin string, composition SurfaceComposition) error {
	if composition.Kind == "dom" || composition.Kind == "hybrid" {
		return fmt.Errorf("plugin %s surface composition: kind %s is removed; the composition takes kind view", plugin, composition.Kind)
	}
	if composition.Kind != "view" {
		return fmt.Errorf("surface composition must be view")
	}
	if !validViewPage(composition.Page) {
		return fmt.Errorf("view composition page %q must be a path inside the plugin release that ends in .html", composition.Page)
	}
	return validateRegions(composition)
}

// validateRegions checks the names and kinds of the regions and overlays of a view composition.
func validateRegions(composition SurfaceComposition) error {
	seen := map[string]bool{}
	for _, region := range composition.Regions {
		if !validCompositionName(region.Name) || seen[region.Name] {
			return fmt.Errorf("invalid or duplicate composition name %q", region.Name)
		}
		seen[region.Name] = true
		switch region.Kind {
		case "document":
			if region.Input != "native" || region.Sidecar != "" || region.Present != "" {
				return fmt.Errorf("document region %q must own native input", region.Name)
			}
		case "image":
			if region.Input != "dom" || region.Sidecar == "" {
				return fmt.Errorf("image region %q requires DOM input and a sidecar", region.Name)
			}
			if region.Present != "copy" && region.Present != "lease" {
				return fmt.Errorf("image region %q declares present copy or lease", region.Name)
			}
		default:
			return fmt.Errorf("unknown region kind %q", region.Kind)
		}
	}
	for _, overlay := range composition.Overlays {
		if !validCompositionName(overlay) || seen[overlay] {
			return fmt.Errorf("invalid or duplicate composition name %q", overlay)
		}
		seen[overlay] = true
	}
	return nil
}

// requireRegion checks that surface declares the region name of kind, and for an image region the sidecar, and returns the
// declared presentation mode of the region, which is empty for a document region.
func (s *Surfaces) requireRegion(surface, name, kind, sidecar string) (string, error) {
	s.mu.Lock()
	composition, ok := s.compositions[surface]
	s.mu.Unlock()
	if !ok {
		return "", fmt.Errorf("surface %q has no composition declaration", surface)
	}
	for _, region := range composition.Regions {
		if region.Name != name {
			continue
		}
		if region.Kind != kind {
			return "", fmt.Errorf("region %q is declared as %s, not %s", name, region.Kind, kind)
		}
		if kind == "image" && sidecar != "" && region.Sidecar != sidecar {
			return "", fmt.Errorf("image %q is not declared for sidecar %q", name, sidecar)
		}
		return region.Present, nil
	}
	return "", fmt.Errorf("region %q is not declared by surface %q", name, surface)
}

type SyncRequest struct {
	// Tells whether the continuous layout update ended.
	Settled  bool                   `json:"settled"`
	Surfaces []Surface              `json:"surfaces"`
	Overlays []WindowOverlayRequest `json:"overlays,omitempty"`
	// The height (pt) of the first row that the next draw will show. Inside a layout transaction, the window title bar is set to this height
	// (docs/spec/native-surfaces.md#title-bar-height).
	Titlebar float64 `json:"titlebar"`
	// The size of the window that the page made the layout at. The layout trace keeps it with the layout transaction of the preparation
	// (docs/spec/native-surfaces.md#layout-transaction).
	Viewport LayoutViewport `json:"viewport"`
}

// LayoutViewport is the size (pt) of the window that the page made a layout at.
type LayoutViewport struct {
	Width  float64 `json:"width"`
	Height float64 `json:"height"`
}

// layoutViewports holds, while a layout trace of a diagnostic build runs, the viewport of each preparation that began its layout
// transaction since the start of the trace, by its ticket, and nil while no trace runs. A preparation notes its viewport in the
// main-thread step that begins its transaction, and a stop waits for its own main-thread step while it holds the lock of the
// layout trace, so the viewports have a lock of their own.
var layoutViewports struct {
	mu       sync.Mutex
	byTicket map[uint64]LayoutViewport
}

// noteLayoutViewport keeps viewport, the size of the window that the page made the layout of the preparation ticket at, for the
// layout trace that runs; without a trace it keeps nothing.
func noteLayoutViewport(ticket uint64, viewport LayoutViewport) {
	layoutViewports.mu.Lock()
	defer layoutViewports.mu.Unlock()
	if layoutViewports.byTicket != nil {
		layoutViewports.byTicket[ticket] = viewport
	}
}

type syncRequestWire struct {
	Settled      bool                   `json:"settled"`
	Surfaces     []syncSurfaceWire      `json:"surfaces"`
	Overlays     []WindowOverlayRequest `json:"overlays,omitempty"`
	Titlebar     float64                `json:"titlebar"`
	Viewport     LayoutViewport         `json:"viewport"`
	Declarations []json.RawMessage      `json:"declarations"`
}

type syncSurfaceWire struct {
	ID          string             `json:"id"`
	Visible     bool               `json:"visible"`
	Dim         bool               `json:"dim"`
	Plugin      string             `json:"plugin"`
	Composition SurfaceComposition `json:"composition"`
	Rect
	Start *syncViewStartWire `json:"start,omitempty"`
}

type syncViewStartWire struct {
	Params       json.RawMessage `json:"params,omitempty"`
	Origin       json.RawMessage `json:"origin,omitempty"`
	Project      *SurfaceProject `json:"project,omitempty"`
	Declarations json.RawMessage `json:"declarations"`
	Diagnostics  json.RawMessage `json:"diagnostics,omitempty"`
	Section      json.RawMessage `json:"section,omitempty"`
}

// decodeSyncRequest resolves the request-local declaration table before any surface state is read or changed.
func decodeSyncRequest(raw json.RawMessage) (SyncRequest, error) {
	wire, err := argument[syncRequestWire]("request", raw)
	if err != nil {
		return SyncRequest{}, err
	}
	if wire.Declarations == nil {
		return SyncRequest{}, fmt.Errorf("argument request.declarations must be a non-null array")
	}
	declarations := make([]json.RawMessage, len(wire.Declarations))
	for i, declaration := range wire.Declarations {
		var object map[string]json.RawMessage
		if err := json.Unmarshal(declaration, &object); err != nil || object == nil {
			return SyncRequest{}, fmt.Errorf("argument request.declarations[%d] must be an object", i)
		}
		declarations[i] = append(json.RawMessage(nil), declaration...)
	}
	used := make([]bool, len(declarations))
	surfaces := make([]Surface, len(wire.Surfaces))
	for i, item := range wire.Surfaces {
		surface := Surface{
			ID: item.ID, Visible: item.Visible, Dim: item.Dim, Plugin: item.Plugin,
			Composition: item.Composition, Rect: item.Rect,
		}
		if item.Composition.Kind == "view" && item.Start != nil {
			indexText := strings.TrimSpace(string(item.Start.Declarations))
			if indexText == "" || indexText[0] < '0' || indexText[0] > '9' {
				return SyncRequest{}, fmt.Errorf("surface %q: view start declarations must be a nonnegative integer index", item.ID)
			}
			index, err := strconv.ParseUint(indexText, 10, 64)
			if err != nil {
				return SyncRequest{}, fmt.Errorf("surface %q: view start declarations must be a nonnegative integer index", item.ID)
			}
			if index >= uint64(len(declarations)) {
				return SyncRequest{}, fmt.Errorf("surface %q: view start declarations index %d is out of range", item.ID, index)
			}
			used[index] = true
			surface.Start = &ViewStart{
				Params: item.Start.Params, Origin: item.Start.Origin, Project: item.Start.Project,
				Declarations: declarations[index], Diagnostics: item.Start.Diagnostics, Section: item.Start.Section,
			}
		} else if item.Start != nil {
			return SyncRequest{}, fmt.Errorf("surface %q: non-view composition cannot carry start values", item.ID)
		}
		surfaces[i] = surface
	}
	for i, referenced := range used {
		if !referenced {
			return SyncRequest{}, fmt.Errorf("argument request.declarations[%d] is unused", i)
		}
	}
	return SyncRequest{
		Settled: wire.Settled, Surfaces: surfaces, Overlays: wire.Overlays, Titlebar: wire.Titlebar, Viewport: wire.Viewport,
	}, nil
}

type WindowOverlayRequest struct {
	X       float64 `json:"x"`
	Y       float64 `json:"y"`
	W       float64 `json:"w"`
	H       float64 `json:"h"`
	Visible *bool   `json:"visible"`
}

// nativeWebviewOptions are the creation values of modal web views.
type nativeWebviewOptions struct {
	URL                 string
	Name                string
	X, Y, Width, Height float64
	Hidden, Transparent bool
}

// nativeWebview is a web view that the app created. The handle and the registry are read and changed on the AppKit main thread.
type nativeWebview struct {
	owner   *Surfaces
	id      uint64
	handle  unsafe.Pointer
	logical bool
}

var nativeViews = map[uint64]*nativeWebview{}
var nativeSerial uint64

type Surfaces struct {
	// closed is set on the UI thread when the window closes. A layout request of the page that is still in flight then
	// creates no surface, because nothing would close it.
	closed bool
	// pageReloading is set from the reload request to a ready page until the new page starts (askPageToReload).
	pageReloading atomic.Bool
	// elements are the surfaces as the workbench of a window without a main page draws them.
	elements surfaceElements
	// drawingMu orders the drawing messages to the suppliers of image regions (sendImageDrawing).
	drawingMu sync.Mutex
	// windowReads joins the changes of host.window that arrive during a reading (windowChanged).
	windowReads latestRead
	// prepareNative registers the main web view and prepares the window. It is decided when the window is created.
	prepareNative func()
	window        Frontend
	// titles sets the title of the native window (windows.go setTitle). NewSurfaces sets the window, and a test sets a recorder.
	titles titleSetter
	// fronts shows the native window (windows.go windowFront). NewSurfaces sets the window, and a test sets a recorder.
	fronts windowFront
	// host is the host that created this window. name is the window identifier of the endpoint and title is the window title.
	host  *Host
	name  string
	title string
	// projects holds the projects that this window shows, by project id, with the folder root of each.
	projects map[string]string
	// pendingProjects holds owner reservations that have not been committed by ProjectShown. Host.mu protects it.
	pendingProjects map[string]bool
	// shown is the project that the window shows, empty when it shows none, and root is its folder root. owner.mu protects both.
	// A release of the shown project clears both at once.
	shown string
	root  string
	ready bool
	// responder is the first responder that the workbench last received (window-responder).
	responder responderState
	// responderObservation is the first responder observation of the window, which close ends. It is read and changed only on
	// the UI thread.
	responderObservation unsafe.Pointer
	// cursorObservation is the observation of the cursor of the window, which close ends. It is read and changed only on the UI
	// thread.
	cursorObservation unsafe.Pointer
	// sheetObservation is the observation of the sheets of the window, which close ends. It is read and changed only on the UI
	// thread.
	sheetObservation unsafe.Pointer
	// dialogHold holds the dialogs of the pages of the window while a client watches its host.dialog, and close ends it. It is
	// read and changed only on the UI thread.
	dialogHold unsafe.Pointer
	// readied holds a channel for each reload that waits for the new page: WindowReady sends nil, and the close of the window and a
	// start of the new page that fails send the error that ends the reload. Host.mu protects it.
	readied []chan error
	// closeAsked tells that the window asked its page with project-close-request and the page has answered neither windowClose nor
	// windowCloseKept, so the end of the page answers it (endPage). Host.mu protects it.
	closeAsked bool
	monitor    uintptr

	// Protects the modal state and the theme between host calls.
	// Views are handled only on the main thread, so no lock is needed for them, and a path that holds this lock does not wait
	// for the main thread.
	mu           sync.Mutex
	views        map[string]*nativeWebview
	compositions map[string]SurfaceComposition
	// surfacePlugins is the plugin of each surface that declared its composition.
	surfacePlugins       map[string]string
	compositionRevisions map[string]uint64
	// lifecycle counts the failures of each view surface and keeps the record that creates its view again (view_lifecycle.go).
	lifecycle *viewLifecycle
	// events receives the window events of this window in place of the window, when it is set. The tests set it.
	events func(name string, data any)
	// presentation holds the views that wait for their presentation after a card layout change (presentation_wait.go).
	presentation presentationWait
	// A surface is a native view, so input that pressed a surface does not reach the page. This map converts the pressed
	// view to the surface id that the page uses.
	named map[uintptr]string
	// registrations are the entries that surface pages registered. When the main page is read again, the new page is told again.
	registrations map[string][]SurfaceRegistration
	// Tells whether a continuous update is in progress. The page announces it at every commit, and with this value run-began and
	// run-ended are published only at the start and the end of a continuous update and not for every frame.
	running bool
	// settled is the channel that waits for the continuous update to end. It is closed when run-ended is published.
	settled         []chan struct{}
	lastPreparation uint64
	// opened is the layout transaction that a frame of a window without a main page opened (OpenLayout) and that no preparation has
	// taken over yet, and 0 without one.
	opened atomic.Uint64
	// Tells whether the page committed. page-ready is published only once.
	first sync.Once
	// A modal is a web view inside the main window. It is created for each display and removed when it closes. The instance number
	// rejects the reply of an earlier display.
	nextModal uint64
	modal     *modal
	// modalPaintChange closes and is replaced at every change of the modal state (modals.go), which wakes the waits of
	// host.window.presented for the first paint of the open modal.
	modalPaintChange chan struct{}
	// waitEnds closes and is replaced at each end that ends the waits of the window for its page: the close of the window and
	// the end of the process of its main page (endWaits). waitsEnded is the end that still holds, which a wait that begins after it
	// meets at once: the close of the window, or the end of the page process until a new page starts. lastEnd is the last end.
	// mu protects the three.
	waitEnds   chan struct{}
	waitsEnded string
	lastEnd    string
	// pageCallEnds closes and is replaced at each end of the generation of the main page (endPageCalls), which ends the waits of
	// the host calls that the page sent: the page reads again only after each of them has its reply. pageCallsEnded is the end
	// that holds until the next page starts, which a call that begins after it meets at once, and lastPageCallEnd is the last end.
	// mu protects the three.
	pageCallEnds    chan struct{}
	pageCallsEnded  string
	lastPageCallEnd string
	// workbenchDialog is true while a dialog that the workbench draws itself is open (SetDialogBackground).
	workbenchDialog bool
	shapes          map[string]*nativeShape
	// documents are the document regions that the surface pages attached.
	documents *Documents
	// sourceOrigins assigns generations to view incarnations and exposes their current window snapshot.
	sourceOrigins *sourceOrigins
	// streams are the stream subscriptions of the document regions.
	streams *DocumentStreams
	// images are the image regions that the surface pages attached.
	images *Images
	// imageDetachMu guards the pending image detaches of the window, the failures of the detaches of each surface by image
	// name, the ends told when the page reports ready, and whether the page is ready for them (docs/spec/sidecars.md).
	imageDetachMu       sync.Mutex
	imageDetaches       map[imageDetachKey]*pendingImageDetach
	imageDetachFailures map[string]map[string]string
	endedImageDetaches  []map[string]any
	detachPageReady     bool
	// reload hooks replace native calls only in owning host tests; production uses the platform operations.
	reloadCancelLayout  func() error
	reloadKeysPageEnded func()
	reloadHideSurface   func(unsafe.Pointer, bool)
	reloadCloseImage    func(unsafe.Pointer)
	// invoke runs a task on the UI thread and waits for it. NewSurfaces sets mainThreadStep, and a test sets a runner that
	// records the tasks.
	invoke   func(task func())
	sidecars *Sidecars
	// The receivers of the sidecar messages of each pair of a sidecar and a session id (docs/spec/native-surfaces.md#view-surfaces).
	sidecarRoutes sidecarRoutes
	watch         sync.Once

	// The theme that the main page set last. The page calls Theme after it loads.
	theme Theme

	// layoutEnds is closed and replaced each time a layout transaction of the window ends by itself, by a press or key event, by
	// its cancel or by the end of the page, so the app DOM wait of a presentation request ends with the transaction it belongs to
	// (docs/spec/native-surfaces.md#layout-transaction).
	layoutEndsMu sync.Mutex
	layoutEnds   chan struct{}
}

// layoutEnd returns the channel that the next end of a layout transaction of the window closes.
func (s *Surfaces) layoutEnd() <-chan struct{} {
	s.layoutEndsMu.Lock()
	defer s.layoutEndsMu.Unlock()
	if s.layoutEnds == nil {
		s.layoutEnds = make(chan struct{})
	}
	return s.layoutEnds
}

// layoutEnded ends the waits inside the presentation request of the window: its app DOM wait and its raster wait.
func (s *Surfaces) layoutEnded() {
	s.layoutEndsMu.Lock()
	if s.layoutEnds != nil {
		close(s.layoutEnds)
	}
	s.layoutEnds = make(chan struct{})
	s.layoutEndsMu.Unlock()
	if s.images != nil {
		s.images.EndWaits()
	}
}

func NewSurfaces(win Frontend, sidecars *Sidecars) *Surfaces {
	s := &Surfaces{
		window: win, titles: win, fronts: win, projects: map[string]string{}, sidecars: sidecars,
		modalPaintChange:     make(chan struct{}),
		views:                map[string]*nativeWebview{},
		compositions:         map[string]SurfaceComposition{},
		surfacePlugins:       map[string]string{},
		compositionRevisions: map[string]uint64{},
		named:                map[uintptr]string{},
		shapes:               map[string]*nativeShape{},
		documents:            NewDocuments(),
		sourceOrigins:        newSourceOrigins(),
		streams:              NewDocumentStreams(),
		images:               NewImages(),
		invoke:               mainThreadStep,
		// The value for the case in which no theme was received yet. If it is not an empty map, null is carried in the JSON,
		// and a page that receives it stops while iterating over the tokens.
		theme: Theme{Tokens: map[string]string{}},
	}
	return s
}

// windowEvent sends an event to the app DOM of this window, or to the events function of a test.
func (s *Surfaces) windowEvent(name string, data any) {
	if s.events != nil {
		s.events(name, data)
		return
	}
	s.window.Emit(name, data)
}

// DeliverSidecarMessage posts a sidecar message to each routed view of its pair and sends sidecar-message to the main page only while
// the main page listens to the pair (docs/spec/native-surfaces.md#view-surfaces). The posts run in one UI-thread task that the sidecar
// reader does not wait for, so the messages of a session reach a view in the order in which the sidecar sent them.
func (s *Surfaces) DeliverSidecarMessage(message SidecarMessage) {
	page, views := s.sidecarRoutes.targets(message.Sidecar, message.Surface)
	if len(views) > 0 {
		text := string(viewSidecarMessage(message.Surface, message.Cids, message.Body))
		mainThreadPost(func() { s.postSidecarMessage(message.Sidecar, message.Surface, text, views) })
	}
	if page {
		s.Emit("sidecar-message", message)
	}
}

// postSidecarMessage posts text to each view of views on the UI thread. A route whose view generation is no longer current is removed
// and recorded; a post that the current view refuses is written to the application log.
func (s *Surfaces) postSidecarMessage(sidecar, id, text string, views []sidecarRouteView) {
	for _, view := range views {
		if !s.currentViewGeneration(view.surface, view.generation) {
			s.sidecarRoutes.removeView(sidecar, id, view.surface, view.generation)
			EmitHost(LevelDebug, "host.view.sidecar.discard", map[string]any{
				"surface": view.surface, "sidecar": sidecar, "id": id, "generation": view.generation, "reason": "view-generation-not-current",
			})
			continue
		}
		if channel, ok := s.documents.view(view.surface); !ok || channel.document == "" {
			LogError("view sidecar route", fmt.Errorf("%s: no ready document", view.surface))
			continue
		}
		handle, err := s.documents.Get(DocumentKey{Surface: view.surface, Name: viewRegionName})
		if err != nil {
			LogError("view sidecar route", fmt.Errorf("%s: %w", view.surface, err))
			continue
		}
		if !system.PostDocument(handle, text) {
			LogError("view sidecar route", fmt.Errorf("%s: the view document refused the message", view.surface))
		}
	}
}

// Emit delivers an event to the single app DOM of this window.
func (s *Surfaces) Emit(name string, data ...any) {
	s.window.Emit(name, data...)
}

// ProjectRoot returns the project directory of this window.
func (s *Surfaces) ProjectRoot() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.root
}

// shownProject returns the project that this window shows, or empty when it shows none.
func (s *Surfaces) shownProject() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.shown
}

// shownProjectValue returns the id and the root of the project that this window shows, or nil when it shows none.
func (s *Surfaces) shownProjectValue() *SurfaceProject {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.shown == "" {
		return nil
	}
	return &SurfaceProject{ID: s.shown, Root: s.root}
}

// A captured source lease never substitutes a successor's mount context. Its
// final admission is linearized with sourceOrigins.retire and view removal.
type mountedSidecarLease struct {
	ctx        context.Context
	origins    *sourceOrigins
	documents  *Documents
	surface    string
	generation uint64
	root       string
}

func (s *Surfaces) mountedSidecarLease(ctx context.Context, surface string, expected uint64) (*mountedSidecarLease, error) {
	if expected == 0 || expected > maxSourceGeneration {
		return nil, errors.New("surface-closed")
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if s.documents == nil {
		return nil, errors.New("surface-closed")
	}
	origins := s.sourceOriginState()
	origins.mu.Lock()
	defer origins.mu.Unlock()
	s.documents.mu.Lock()
	defer s.documents.mu.Unlock()
	channel, ok := s.documents.views[surface]
	if !ok {
		return nil, errors.New("surface-closed")
	}
	if origins.views[surface] != channel.generation || expected != channel.generation {
		return nil, errors.New("surface-closed")
	}
	if !channel.projectBound {
		return nil, fmt.Errorf("surface %s mount project is not committed", surface)
	}
	if channel.projectRoot == "" {
		return nil, fmt.Errorf("mounted surface %s has no project", surface)
	}
	return &mountedSidecarLease{ctx: ctx, origins: origins, documents: s.documents, surface: surface, generation: channel.generation, root: channel.projectRoot}, nil
}
func (lease *mountedSidecarLease) admit() (func(), error) {
	lease.origins.mu.Lock()
	lease.documents.mu.Lock()
	unlock := func() { lease.documents.mu.Unlock(); lease.origins.mu.Unlock() }
	channel, ok := lease.documents.views[lease.surface]
	if err := lease.ctx.Err(); err != nil {
		unlock()
		return nil, err
	}
	if !ok || lease.origins.views[lease.surface] != lease.generation || channel.generation != lease.generation ||
		!channel.projectBound || channel.projectRoot != lease.root {
		unlock()
		return nil, errors.New("surface-closed")
	}
	return unlock, nil
}
func (s *Surfaces) sidecarSendContext(ctx context.Context, generation uint64, name, surface string, body json.RawMessage, cids []string) error {
	if err := s.pendingImageDetachError(surface); err != nil {
		return err
	}
	lease, err := s.mountedSidecarLease(ctx, surface, generation)
	if err != nil {
		return err
	}
	return s.sidecars.sendAtRootGuarded(ctx, s, name, surface, lease.root, body, cids, lease.admit)
}

// sendViewSidecar never borrows a successor for an old source-bound request.
func (s *Surfaces) sendViewSidecar(ctx context.Context, req ViewSidecarSendRequest) error {
	if origin, ok := viewSourceOf(ctx); req.Source == "" || req.Source != req.Surface || req.Generation == 0 || req.Generation > maxSourceGeneration || (ok && (origin.surface != req.Source || origin.generation != req.Generation)) {
		return errors.New("surface-closed")
	}
	return s.sidecarSendContext(ctx, req.Generation, req.Sidecar, req.Source, req.Body, req.Cids)
}

// windowSidecarSend is a separate window/background owner, never a view fallback.
func (s *Surfaces) windowSidecarSend(ctx context.Context, name, surface string, body json.RawMessage, cids []string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if _, ok := viewSourceOf(ctx); ok {
		return errors.New("view sidecar sends require their original source generation")
	}
	ticket, err := s.sourceOriginState().watchAbsence(surface)
	if err != nil {
		return err
	}
	defer ticket.release()
	if s.documents != nil {
		if _, mounted := s.documents.view(surface); mounted {
			return fmt.Errorf("mounted surface %s requires viewSidecarSend with its original source generation", surface)
		}
	}
	if err := s.pendingImageDetachError(surface); err != nil {
		return err
	}
	documents := s.documents
	admit := func() (func(), error) {
		ticket.origins.mu.Lock()
		if documents != nil {
			documents.mu.Lock()
		}
		unlock := func() {
			if documents != nil {
				documents.mu.Unlock()
			}
			ticket.origins.mu.Unlock()
		}
		if err := ctx.Err(); err != nil {
			unlock()
			return nil, err
		}
		_, active := ticket.origins.views[surface]
		mounted := false
		if documents != nil {
			_, mounted = documents.views[surface]
		}
		if ticket.invalid || active || mounted {
			unlock()
			return nil, fmt.Errorf("mounted surface %s requires viewSidecarSend with its original source generation", surface)
		}
		return unlock, nil
	}
	return s.sidecars.sendFromPageGuarded(ctx, s, name, surface, body, cids, admit)
}

// SidecarReconnected sends the picture configure of a persistent sidecar again when its connection is made again after it was lost
// (V5-106); the configure state that the earlier connection confirmed ended with that connection.
func (s *Surfaces) SidecarReconnected(sidecar string) {
	if err := s.RefreshSidecarRasters(sidecar); err != nil {
		LogError(fmt.Sprintf("sidecar %s reconnection reconfigure", sidecar), err)
	}
}

// FrameAnswerEvent returns the performance trace event of an answer to a frame of the surface: the image name and the
// answer as the sidecar receives it, whether the frame was consumed or refused.
func FrameAnswerEvent(surface, image string, response map[string]any) map[string]any {
	return map[string]any{"event": "image.frame", "surface": surface, "name": image, "response": response}
}

// DecideImageEnvelope decides and handles the image envelope that a sidecar sent.
func (s *Surfaces) DecideImageEnvelope(sidecarName, surface string, body json.RawMessage) bool {
	sidecars := s.sidecars
	return HandleEnvelope(body, sidecarName, surface, s.images,
		func(work func() error) error {
			return sidecars.presents.present(work, mainThreadStep)
		},
		func(image string, response map[string]interface{}) error {
			// Every answer to a frame, consumed or refused with its reason, is an image.frame event of the performance
			// trace, so a frame that the host does not present is visible in the timeline (docs/spec/performance-trace.md).
			PerformanceObserve("host", func() map[string]any {
				return FrameAnswerEvent(surface, image, response)
			})
			responseBytes, err := json.Marshal(response)
			if err != nil {
				return err
			}
			return sidecars.SendResponse(sidecarName, surface, image, json.RawMessage(responseBytes))
		},
		func(reason string) error {
			if reason != "notFound" {
				return nil
			}
			return s.refreshImageRasters()
		},
		func() bool { return sidecars.Declared(sidecarName) },
		s.windowChanged,
	)
}

// run publishes run-began and run-ended. The page announces whether more updates follow, and this function
// publishes an event only when that value changes.
func (s *Surfaces) run(going bool) {
	if s.running == going {
		return
	}
	s.running = going
	if going {
		s.Emit("run-began")
		return
	}
	for _, done := range s.settled {
		close(done)
	}
	s.settled = nil
	s.Emit("run-ended")
}

// whenSettled returns a channel that closes when the continuous update ends. When no update is in progress, it is a closed
// channel.
func (s *Surfaces) whenSettled() <-chan struct{} {
	done := make(chan struct{})
	mainThreadStep(func() {
		if !s.running {
			close(done)
			return
		}
		s.settled = append(s.settled, done)
	})
	return done
}

// press publishes the id of a surface or of a document web view that the surface owns. The page decides the meaning of the press.
func (s *Surfaces) press(view uintptr) bool {
	id, ok := SurfaceOwnerID(s.named, view)
	if !ok {
		for handle, key := range s.documents.Names() {
			if handle == uint64(view) {
				id, ok = key.Surface, true
				break
			}
		}
	}
	if !ok {
		return false
	}
	// If Wails EmitEvent ran synchronously inside the local mouse monitor of AppKit,
	// the handling of the current NSEvent would be re-entered and the next button event could be
	// delivered to the WebView as a move. It is published in the same main run loop order after the original event returns.
	mainThreadPost(func() { s.Emit("surface-pressed", id) })
	return true
}

// readPressThenDeliver reads the view under a press and then delivers the press, in one step of the UI thread. A read
// after the delivery runs after a later layout may have moved the views, and then names another view as the target.
func readPressThenDeliver(read, deliver func() error) error {
	if err := read(); err != nil {
		return err
	}
	return deliver()
}

// viewAt reads the web view under the coordinates of a directly injected press. A direct injection does not pass through
// the local event monitor of AppKit, so the host publishes its surface press separately from the monitor.
func viewAt(window platform.Window, x, y float64) (uintptr, error) {
	text, err := system.WindowHit(window, x, y)
	if err != nil {
		return 0, err
	}
	var got struct {
		View uint64 `json:"view"`
	}
	if err := json.Unmarshal([]byte(text), &got); err != nil {
		return 0, err
	}
	return uintptr(got.View), nil
}

// SurfaceOwnerID finds the logical surface to which the native view that received the input belongs.
// A map entry is added when a logical surface is created and removed together with the surface.
// An unknown native view must not activate a card.
func SurfaceOwnerID(named map[uintptr]string, view uintptr) (string, bool) {
	id, ok := named[view]
	return id, ok && id != ""
}

// point publishes one step of a left button drag in page coordinates. phase is 0 for press, 1 for move and
// 2 for release.
//
// The grab region of a boundary is wider than the passage between two cards, so when the passage width is one line, that region is
// under a surface. The page compares the position with its own boundary.
func (s *Surfaces) point(phase int, x float64, y float64) {
	// For the same reason as a surface press, the DOM event is not run synchronously in the native event monitor.
	// The main run loop completes the input event first.
	step := InputStep{Phase: phase, X: x, Y: y}
	mainThreadPost(func() { s.Emit("surface-input", step) })
}

// InputStep is one step of a drag that the page receives.
type InputStep struct {
	Phase int     `json:"phase"`
	X     float64 `json:"x"`
	Y     float64 `json:"y"`
}

// alphaFor returns the opacity of a surface. The page decides whether to dim it.
func alphaFor(dim bool) float64 {
	if dim {
		return 0.45
	}
	return 1
}

func max1(v float64) float64 {
	if v < 1 {
		return 1
	}
	return v
}

// prepareSurfaceVisibility hides only a surface whose requested placement is invisible. A visible surface keeps its native hidden state.
func prepareSurfaceVisibility(requestedVisible bool, setHidden func(bool)) {
	if !requestedVisible {
		setHidden(true)
	}
}

// ValidateRect rejects geometry that must not be passed to a native view.
func ValidateRect(name string, x, y, width, height float64) error {
	if math.IsNaN(x) || math.IsNaN(y) || math.IsNaN(width) || math.IsNaN(height) ||
		math.IsInf(x, 0) || math.IsInf(y, 0) || math.IsInf(width, 0) || math.IsInf(height, 0) {
		return fmt.Errorf("%s geometry must contain finite numbers", name)
	}
	if width < 0 || height < 0 {
		return fmt.Errorf("%s geometry must not have a negative size", name)
	}
	return nil
}

// aligned fits a region in page coordinates to the display pixels, and returns the backing scale of the window whose device pixels
// it fitted the region to. A window without a backing scale has no device pixels, so the fit fails. Call it on the UI thread.
func aligned(win Frontend, at Rect) (Rect, float64, error) {
	got, scale, err := system.AlignRect(win.NativeWindow(), platformRect{X: at.X, Y: at.Y, W: max1(at.W), H: max1(at.H)})
	if err != nil {
		return Rect{}, 0, fmt.Errorf("surface alignment: %w", err)
	}
	return fittedRect(got, scale)
}

// fittedRect returns the region that the platform fitted to the device pixels of scale, and that scale. It rejects a scale that no
// window has, so a surface is never seated on a grid that no display has.
func fittedRect(got platformRect, scale float64) (Rect, float64, error) {
	if !(scale > 0) || math.IsInf(scale, 0) {
		return Rect{}, 0, fmt.Errorf("surface alignment: the window has backing scale %v", scale)
	}
	return Rect(got), scale, nil
}

// seatedPlacement is the placement of the surface id at rect. A visible surface names the backing scale whose device pixels the host
// fitted it to; a hidden one is fitted to no grid and names none.
func seatedPlacement(id string, rect Rect, visible bool, scale float64) Placement {
	if !visible {
		scale = 0
	}
	return Placement{ID: id, Rect: rect, Visible: visible, Scale: scale}
}

// CheckSyncRequest checks the whole synchronization request before the layout starts and returns the window
// overlays. held and plugins are the composition declarations and the plugins of the surfaces that the window already received.
func CheckSyncRequest(req SyncRequest, held map[string]SurfaceComposition, plugins map[string]string) ([]platform.WindowOverlay, error) {
	if err := ValidateTitlebarHeight(req.Titlebar); err != nil {
		return nil, err
	}
	seen := map[string]bool{}
	for _, surface := range req.Surfaces {
		if surface.ID == "" || seen[surface.ID] {
			return nil, fmt.Errorf("invalid or duplicate surface %q", surface.ID)
		}
		seen[surface.ID] = true
		if err := ValidateRect(fmt.Sprintf("surface %q", surface.ID), surface.X, surface.Y, surface.W, surface.H); err != nil {
			return nil, err
		}
		if err := validateComposition(surface.Plugin, surface.Composition); err != nil {
			return nil, fmt.Errorf("surface %q: %w", surface.ID, err)
		}
		if surface.Plugin == "" {
			return nil, fmt.Errorf("surface %q requires its plugin", surface.ID)
		}
		if surface.Start != nil {
			if err := validateViewStart(surface.ID, surface.Start); err != nil {
				return nil, err
			}
		}
		if surface.Composition.Kind == "view" {
			declared, exists := held[surface.ID]
			if !exists {
				return nil, fmt.Errorf("surface %q has no composition declaration in the current page", surface.ID)
			}
			if !reflect.DeepEqual(declared, surface.Composition) || plugins[surface.ID] != surface.Plugin {
				return nil, fmt.Errorf("surface %q changed its composition declaration", surface.ID)
			}
		}
	}
	windowOverlays := make([]platform.WindowOverlay, 0, len(req.Overlays))
	for _, overlay := range req.Overlays {
		if err := ValidateRect("window overlay", overlay.X, overlay.Y, overlay.W, overlay.H); err != nil {
			return nil, err
		}
		visible := true
		if overlay.Visible != nil {
			visible = *overlay.Visible
		}
		windowOverlays = append(windowOverlays, platform.WindowOverlay{X: overlay.X, Y: overlay.Y, W: overlay.W, H: overlay.H, Visible: visible})
	}
	return windowOverlays, nil
}

// SyncSurfaces fits the surface views to the regions that the page declared.
//
// It is an AppKit call and service calls arrive in their own goroutines, so the work runs on the main thread.
func (s *Surfaces) SyncSurfaces(req SyncRequest) (PreparedSurfaces, error) {
	// The preparation takes over the layout that a frame opened for it: a preparation that begins its layout joins the open
	// transaction, and one that fails cancels it, so the transaction does not hold the frames of the window after the preparation
	// ends (docs/spec/hosts.md#native-views). A cancel of a layout that a begun preparation joined changes nothing.
	opened := s.opened.Swap(0)
	prepared, err := s.syncSurfaces(req)
	if err != nil && opened != 0 {
		err = s.cancelOpenedLayout(opened, err)
	}
	return prepared, err
}

// cancelOpenedLayout cancels the opened layout ticket of a preparation that failed with failure, and returns failure with the failure
// of the cancel.
func (s *Surfaces) cancelOpenedLayout(ticket uint64, failure error) error {
	win := s.window
	if win == nil {
		return failure
	}
	done := make(chan error, 1)
	if err := system.EnqueueUI(func() {
		// The close of the window cancelled every layout of the window, and the framework may have released its native window.
		if s.closed {
			done <- nil
			return
		}
		done <- s.cancelLayoutPresentation(win.NativeWindow(), ticket)
	}); err != nil {
		return fmt.Errorf("%w; cancelling the opened layout: %v", failure, err)
	}
	if err := <-done; err != nil {
		return fmt.Errorf("%w; cancelling the opened layout: %v", failure, err)
	}
	return failure
}

func (s *Surfaces) syncSurfaces(req SyncRequest) (PreparedSurfaces, error) {
	win, ok := s.window, s.window != nil
	if !ok {
		return PreparedSurfaces{}, errNoWindow
	}
	s.mu.Lock()
	windowOverlays, err := CheckSyncRequest(req, s.compositions, s.surfacePlugins)
	s.mu.Unlock()
	if err != nil {
		return PreparedSurfaces{}, err
	}
	// The page committed, so the window is on the screen and the surfaces exist. Work to run once after the application is drawn
	// starts here.
	s.first.Do(func() { s.Emit("page-ready") })
	var prepared PreparedSurfaces
	type applyResult struct {
		chrome     Chrome
		restore    func() error
		gone       []string
		placements []Placement
		err        error
	}
	done := make(chan applyResult, 1)
	var began error
	now := currentSurfaceClock()
	began = runSurfaceDispatch(now, mainThreadStep, win.Name(), &prepared.Ticket, "sync", "sync-layout-ui", func() error {
		// The close of the window cancelled its layouts on this thread, and its page commits none after the close, so a layout that
		// began now would stay open and hold the layouts and the frames of every other window.
		if s.closed {
			return errWindowClosed
		}
		for _, surface := range req.Surfaces {
			if _, err := s.viewStartOf(surface); err != nil {
				return err
			}
		}
		began = RunLayout(func() error {
			return setWindowOverlays(framework.MainPage(), win.NativeWindow(), windowOverlays)
		}, func() error {
			s.lastPreparation++
			prepared.Ticket = s.lastPreparation
			noteLayoutViewport(prepared.Ticket, req.Viewport)
			recordLayoutBegin(prepared.Ticket)
			queued, trace := surfaceDispatchClock(now)
			return system.BeginLayout(win.NativeWindow(), prepared.Ticket, func(allowed bool) {
				observeSurfaceCallback(now, win.Name(), &prepared.Ticket, "sync", "sync-layout-ready-callback", queued, trace, func() {
					if !allowed {
						done <- applyResult{err: errNoWindow}
						return
					}
					var chrome Chrome
					var restore func() error
					var gone []string
					var placements []Placement
					err := ApplyOrCancel(func() (func() error, error) {
						var err error
						chrome, restore, err = titlebarChrome(win.NativeWindow(), req.Titlebar)
						return restore, err
					}, func() error {
						var err error
						gone, placements, err = s.apply(win, req)
						return err
					}, func() error { return s.cancelLayoutPresentation(win.NativeWindow(), prepared.Ticket) })
					if err == nil {
						s.watch.Do(func() { s.watchInput(win) })
					} else if !req.Settled {
						s.run(false)
					}
					done <- applyResult{chrome: chrome, restore: restore, gone: gone, placements: placements, err: err}
				})
			})
		})
		return began
	})
	if began != nil {
		return prepared, began
	}
	outcome := <-done
	if outcome.err != nil {
		return prepared, outcome.err
	}
	gone := outcome.gone
	prepared.Placements = outcome.placements
	prepared.Chrome = outcome.chrome
	// Tells the sidecars and the exposure registration of the main page about the removed surfaces. Call it outside the main thread.
	for _, id := range gone {
		s.closeRemovedSurface(id)
	}
	s.surfacesClosed(gone)
	err = PrepareRasterUpdate(s.refreshImageRasters, func() error {
		return system.EnqueueUI(func() {
			if failure := outcome.restore(); failure != nil {
				LogError("surface layout title bar restore", failure)
			}
			if failure := s.cancelLayoutPresentation(win.NativeWindow(), prepared.Ticket); failure != nil {
				LogError("surface layout cancel", failure)
			}
		})
	})
	return prepared, err
}

// setWindowOverlays gives the main web view of window the declared overlays. A window without a main page has none, because its
// workbench draws over native views through the covers of the framework (docs/spec/native-surfaces.md#surface-host-container).
// mainPage tells whether the windows of the framework show a main page.
func setWindowOverlays(mainPage bool, window platform.Window, overlays []platform.WindowOverlay) error {
	if !mainPage {
		return nil
	}
	main, err := system.MainWebview(window)
	if err != nil {
		return err
	}
	return system.SetWindowOverlays(main, overlays)
}

// PrepareRasterUpdate starts the prepared raster configuration before the caller replies, and cancels a failed preparation.
func PrepareRasterUpdate(refresh, cancel func() error) error {
	if err := refresh(); err != nil {
		if cancellation := cancel(); cancellation != nil {
			return fmt.Errorf("%w; scheduling layout cancellation: %v", err, cancellation)
		}
		return err
	}
	return nil
}

// RunLayout starts the surface layout transaction after it places the window cover. The cover is placed before the layout, so when the cover is rejected,
// no layout was started.
func RunLayout(overlays, begin func() error) error {
	if err := overlays(); err != nil {
		return err
	}
	return begin()
}

// ApplyOrCancel sets the window title bar in the started layout and then fits the surfaces, and cancels the layout when either of them fails. When the title bar
// cannot be set, it does not fit the surfaces. When the surfaces cannot be fitted, it restores the previous title bar with the restore that titlebar returned and then
// cancels. A cancel commits the transaction, so unless it is restored, the new title bar would be shown with the previous row. A failure of
// the restore and of the cancel is appended to that error.
func ApplyOrCancel(titlebar func() (restore func() error, err error), apply, cancel func() error) error {
	restore, err := titlebar()
	if err == nil {
		err = apply()
		if err != nil {
			if restoreErr := restore(); restoreErr != nil {
				err = fmt.Errorf("%w; restoring the title bar: %v", err, restoreErr)
			}
		}
	}
	if err == nil {
		return nil
	}
	if cancelErr := cancel(); cancelErr != nil {
		err = fmt.Errorf("%w; cancelling layout: %v", err, cancelErr)
	}
	return err
}

// watchInput delivers the surface input of a window to this window. Call it on the UI thread.
func (s *Surfaces) watchInput(win Frontend) {
	monitor, err := system.WatchInput(win.NativeWindow(), platform.Input{Press: s.press, Point: s.point})
	if err != nil {
		LogError("surface input", err)
		return
	}
	s.monitor = monitor
}

// Placement is the actual position of one surface in page coordinates. The host fits the region that the page declared to the display pixels,
// so the two values differ, and the page receives that difference. Scale is the backing scale whose device pixels the host fitted a
// visible surface to: the window can change display before the page reads the placement, so the page judges the rectangle on that
// grid. A hidden surface has no scale.
type Placement struct {
	ID string `json:"id"`
	Rect
	Visible bool    `json:"visible"`
	Scale   float64 `json:"scale,omitempty"`
}

// PreparedSurfaces is the reply of the preparation. Chrome is the window button region and the title bar height after the host set the title bar in this transaction,
// and the page reads it as the committed state after it confirmed the display of this preparation.
type PreparedSurfaces struct {
	Ticket     uint64      `json:"ticket"`
	Placements []Placement `json:"placements"`
	Chrome     Chrome      `json:"chrome"`
}

// PresentRequest is the DOM display confirmation request. PresentSurfaces confirms without blocking the AppKit thread.
type PresentRequest struct {
	Ticket     uint64      `json:"ticket"`
	Placements []Placement `json:"placements"`
	Settled    bool        `json:"settled"`
}

func completeLayoutPresentation(prepareViews, awaitDOM, awaitRasters func() error, commit func(error)) {
	err := prepareViews()
	if err == nil {
		err = awaitDOM()
	}
	if err == nil {
		err = awaitRasters()
	}
	commit(err)
}

type surfaceDispatchMode uint8

const (
	surfaceDispatchOff surfaceDispatchMode = iota
	surfaceDispatchPerformance
	surfaceDispatchFrame
)

func recordSurfaceDispatch(mode surfaceDispatchMode, window string, ticket *uint64, operation, stage string, queued, entered, returned uint64) {
	recordSurfaceDispatchOf(mode, window, "", ticket, operation, stage, queued, entered, returned)
}

// recordSurfaceDispatchOf records a dispatch that belongs to one surface, such as the placement of its composition, with that
// surface; surface is empty for a dispatch of the window layout.
func recordSurfaceDispatchOf(mode surfaceDispatchMode, window, surface string, ticket *uint64, operation, stage string, queued, entered, returned uint64) {
	fields := map[string]any{
		"event": "surface.dispatch", "window": window, "operation": operation, "stage": stage,
		"queued_ns": strconv.FormatUint(queued, 10), "entered_ns": strconv.FormatUint(entered, 10),
		"returned_ns": strconv.FormatUint(returned, 10),
	}
	if surface != "" {
		fields["surface"] = surface
	}
	if ticket != nil && *ticket != 0 {
		fields["ticket"] = *ticket
	}
	switch mode {
	case surfaceDispatchPerformance:
		PerformanceObserve("host", func() map[string]any { return fields })
	case surfaceDispatchFrame:
		delete(fields, "event")
		EmitHost(LevelTrace, "host.frame.surface.dispatch", fields)
	}
}

// surfaceClock reads the monotonic clock in nanoseconds. Production passes the clock of the host platform; a test passes the
// instants that it needs.
type surfaceClock func() (uint64, error)

// currentSurfaceClock returns the monotonic clock of the host platform, or a clock that reports that the platform is unavailable.
func currentSurfaceClock() surfaceClock {
	if system == nil {
		return func() (uint64, error) { return 0, errors.New("the platform is unavailable") }
	}
	return system.MonotonicNanos
}

func surfaceDispatchClock(now surfaceClock) (uint64, surfaceDispatchMode) {
	return surfaceDispatchClockFrom(
		PerformanceEnabled(),
		func() bool { return GateEvent(ClassCall, LevelDebug) },
		func() bool { return GateEvent(ClassFrame, LevelTrace) },
		func() (uint64, bool) { return readSurfaceDispatchClock(now) },
	)
}

func surfaceDispatchClockFrom(performance bool, callTrace, frameTrace func() bool, read func() (uint64, bool)) (uint64, surfaceDispatchMode) {
	mode := surfaceDispatchOff
	if performance && callTrace() {
		mode = surfaceDispatchPerformance
	} else if frameTrace() {
		mode = surfaceDispatchFrame
	}
	if mode == surfaceDispatchOff {
		return 0, surfaceDispatchOff
	}
	value, ok := read()
	if !ok {
		return 0, surfaceDispatchOff
	}
	return value, mode
}

func readSurfaceDispatchClock(now surfaceClock) (uint64, bool) {
	value, err := now()
	if err != nil {
		LogError("surface dispatch clock", err)
		return 0, false
	}
	if value == 0 {
		LogError("surface dispatch clock", "the host monotonic clock returned 0")
		return 0, false
	}
	return value, true
}

func runSurfaceDispatch(now surfaceClock, dispatch func(func()), window string, ticket *uint64, operation, stage string, work func() error) error {
	return runSurfaceDispatchOf(now, dispatch, window, "", ticket, operation, stage, work)
}

// runSurfaceDispatchOf runs work through dispatch and records it with surface, which is empty for a dispatch of the window layout.
func runSurfaceDispatchOf(now surfaceClock, dispatch func(func()), window, surface string, ticket *uint64, operation, stage string, work func() error) error {
	queued, mode := surfaceDispatchClock(now)
	var entered, returned uint64
	var enteredAvailable, returnedAvailable bool
	var workErr error
	dispatch(func() {
		if mode != surfaceDispatchOff {
			entered, enteredAvailable = readSurfaceDispatchClock(now)
		}
		workErr = work()
		if mode != surfaceDispatchOff {
			returned, returnedAvailable = readSurfaceDispatchClock(now)
		}
	})
	if mode != surfaceDispatchOff && enteredAvailable && returnedAvailable {
		recordSurfaceDispatchOf(mode, window, surface, ticket, operation, stage, queued, entered, returned)
	}
	return workErr
}

func observeSurfaceCallback(now surfaceClock, window string, ticket *uint64, operation, stage string, queued uint64, mode surfaceDispatchMode, work func()) {
	var entered, returned uint64
	var enteredAvailable, returnedAvailable bool
	if mode != surfaceDispatchOff {
		entered, enteredAvailable = readSurfaceDispatchClock(now)
	}
	work()
	if mode != surfaceDispatchOff {
		returned, returnedAvailable = readSurfaceDispatchClock(now)
		if enteredAvailable && returnedAvailable {
			recordSurfaceDispatch(mode, window, ticket, operation, stage, queued, entered, returned)
		}
	}
}

// waitSurfaceRasters runs the raster stage of a presentation, the refresh of the rasters of its image regions and the wait until
// they present, and records it as the stage present-raster-wait: queued_ns before the refresh, entered_ns when the wait starts and
// returned_ns when it ends, also when the wait fails. A refresh that fails starts no wait and records nothing.
func waitSurfaceRasters(now surfaceClock, window string, ticket *uint64, refresh, wait func() error) error {
	queued, mode := surfaceDispatchClock(now)
	if err := refresh(); err != nil {
		return err
	}
	if mode == surfaceDispatchOff {
		return wait()
	}
	entered, enteredAvailable := readSurfaceDispatchClock(now)
	err := wait()
	returned, returnedAvailable := readSurfaceDispatchClock(now)
	if enteredAvailable && returnedAvailable {
		recordSurfaceDispatch(mode, window, ticket, "present", "present-raster-wait", queued, entered, returned)
	}
	return err
}

func (s *Surfaces) PresentSurfaces(req PresentRequest) ([]Placement, error) {
	win, ok := s.window, s.window != nil
	if !ok {
		return nil, errNoWindow
	}
	type result struct {
		placed []Placement
		err    error
	}
	now := currentSurfaceClock()
	done := make(chan result, 1)
	routine.Go("layout-prepare", func() {
		completeLayoutPresentation(func() error {
			var prepareErr error
			prepareErr = runSurfaceDispatch(now, mainThreadStep, win.Name(), &req.Ticket, "present", "present-prepare-ui", func() error {
				for _, p := range req.Placements {
					view := s.views[p.ID]
					if view == nil {
						return fmt.Errorf("surface %q closed before presentation", p.ID)
					}
					view.SetHidden(!p.Visible)
				}
				return s.joinViewsForPresentRequest(win.NativeWindow(), req, req.Placements)
			})
			return prepareErr
		}, func() error {
			domReady := make(chan error, 1)
			ended := s.layoutEnd()
			var waiting error
			waiting = runSurfaceDispatch(now, mainThreadStep, win.Name(), &req.Ticket, "present", "present-dom-register-ui", func() error {
				queued, trace := surfaceDispatchClock(now)
				waiting = win.AfterPresentation(func(failure error) {
					observeSurfaceCallback(now, win.Name(), &req.Ticket, "present", "present-dom-callback", queued, trace, func() { domReady <- failure })
				})
				return waiting
			})
			if waiting != nil {
				return waiting
			}
			// The wait ends by the presentation update, or by the end of the transaction: a press or key event, a cancel or the end
			// of the page. No wait ends by time (docs/spec/native-surfaces.md#layout-transaction).
			select {
			case failure := <-domReady:
				return failure
			case <-ended:
				return nil
			}
		}, func() error {
			// A continuous frame also waits for each visible image region to display a raster of the prepared size.
			// Without waiting, a surface resize would show the previous raster while the region is enlarged
			// (docs/spec/surface-composition.md).
			return waitSurfaceRasters(now, win.Name(), &req.Ticket, s.refreshImageRasters, func() error {
				err := s.images.WaitLayoutRasters(req.Settled)
				if errors.Is(err, errLayoutWaitEnded) {
					return nil
				}
				if err != nil {
					return fmt.Errorf("the current image raster failed to present: %w", err)
				}
				return nil
			})
		}, func(waiting error) {
			// The commit and the cancel run outside the framework event lock.
			queued, mode := surfaceDispatchClock(now)
			if err := system.EnqueueUI(func() {
				var entered uint64
				var enteredAvailable bool
				if mode != surfaceDispatchOff {
					entered, enteredAvailable = readSurfaceDispatchClock(now)
				}
				defer func() {
					if mode != surfaceDispatchOff {
						returned, returnedAvailable := readSurfaceDispatchClock(now)
						if enteredAvailable && returnedAvailable {
							recordSurfaceDispatch(mode, win.Name(), &req.Ticket, "present", "present-commit-ui", queued, entered, returned)
						}
					}
				}()
				if waiting != nil {
					if err := s.cancelLayoutPresentation(win.NativeWindow(), req.Ticket); err != nil {
						waiting = fmt.Errorf("%w; cancelling layout: %v", waiting, err)
					}
					done <- result{err: waiting}
					return
				}
				out, failure := s.finishLayoutPresentation(win.NativeWindow(), req)
				if failure != nil {
					done <- result{err: failure}
					return
				}
				done <- result{placed: out}
			}); err != nil {
				done <- result{err: err}
			}
		})
	})
	outcome := <-done
	if outcome.err != nil {
		return nil, outcome.err
	}
	placed := outcome.placed
	s.windowChanged()
	return placed, nil
}

// CancelRequest names the preparation that the page does not present.
type CancelRequest struct {
	Ticket uint64 `json:"ticket"`
}

// CancelSurfaces abandons the waits of the ticket and cancels its layout on the UI thread.
func (s *Surfaces) CancelSurfaces(req CancelRequest) error {
	if s.window == nil {
		return errNoWindow
	}
	done := make(chan error, 1)
	window := s.window.NativeWindow()
	if err := system.EnqueueUI(func() {
		// The close of the window cancelled every layout of the window, and the framework may have released its native window.
		if s.closed {
			done <- nil
			return
		}
		done <- s.cancelLayoutPresentation(window, req.Ticket)
	}); err != nil {
		return err
	}
	return <-done
}

// FocusRequest names the surface that takes the keyboard of the window, and null names the workbench. Decided gives the keys
// that wait for the decision of the workbench after the keyboard moved, and a call without it leaves them waiting
// (docs/spec/native-surfaces.md#keyboard-of-a-surface).
type FocusRequest struct {
	Surface *string `json:"surface"`
	Decided bool    `json:"decided,omitempty"`
}

// FocusSurface gives the keyboard of the window to the surface of the request or to the workbench on the UI thread
// (docs/spec/native-surfaces.md#keyboard-of-a-surface). A surface that the window does not hold is refused.
func (s *Surfaces) FocusSurface(req FocusRequest) error {
	if s.window == nil {
		return errNoWindow
	}
	declared := false
	if req.Surface != nil {
		s.mu.Lock()
		declared = s.compositions[*req.Surface].declaresImageRegion()
		s.mu.Unlock()
	}
	done := make(chan error, 1)
	window := s.window.NativeWindow()
	if err := system.EnqueueUI(func() {
		// A window that closed takes no keyboard, and its close dropped the keys that waited (docs/spec/native-surfaces.md#keyboard-of-a-surface).
		// A call of its workbench that arrives after the close reaches no native window, which the framework may have released.
		if s.closed {
			done <- nil
			return
		}
		// A refused surface still gives the keys: they wait for no later decision of this call.
		if req.Decided {
			defer system.KeysDecided(window)
		}
		if req.Surface == nil {
			system.FocusWorkbench(window)
			done <- nil
			return
		}
		view := s.views[*req.Surface]
		if view == nil {
			done <- fmt.Errorf("surface %q is not attached", *req.Surface)
			return
		}
		if declared {
			system.FocusSurfaceForRegion(view.handle)
		} else {
			system.FocusSurface(view.handle)
		}
		done <- nil
	}); err != nil {
		return err
	}
	return <-done
}

// endPage ends the generation of the main page of s in the turn of the reload request or of the end of the process of the page
// (docs/spec/hosts.md#process-lifecycle): it answers what the page owed (answerPage) with end, and the keys that waited for the
// decision of the workbench go.
func (h *Host) endPage(s *Surfaces, end string) {
	h.answerPage(s, end)
	s.mainPageEnded()
}

// answerPage answers what the main page of s owed when its generation ends. The window is no longer ready, every request to the page
// and to the surface documents of the window ends with 1003 and later requests to those documents are refused until the next page
// starts, each removal that asked the page is allowed, and a close question that the page left closes the window as a window whose
// page is not ready closes. The waits of the host calls that the page sent end with 1003 end (endPageCalls), because the page
// reads again only after each of its calls has its reply. An end that finds nothing owed changes nothing.
func (h *Host) answerPage(s *Surfaces, end string) {
	h.mu.Lock()
	s.ready = false
	asked := s.closeAsked
	s.closeAsked = false
	h.mu.Unlock()
	s.pageReloading.Store(true)
	s.endPageCalls(end)
	h.relay.Abandon(func(t relayTarget) bool { return t.owner == s })
	// The page that a removal asked ended, so the removal is allowed (docs/spec/projects.md).
	h.removals.Abandon(s.name)
	if asked {
		s.window.Close()
	}
}

// endReloads ends each reload of s that waits for the new page with err, which is nil for the ready of that page.
func (h *Host) endReloads(s *Surfaces, err error) {
	h.mu.Lock()
	readied := s.readied
	s.readied = nil
	h.mu.Unlock()
	for _, ready := range readied {
		ready <- err
	}
}

// mainPageEnded gives the keys of the window that waited for the decision of its workbench, which ended with its page or its
// process (docs/spec/native-surfaces.md#keyboard-of-a-surface), and cancels every layout transaction of the window, because the
// page that holds their tickets ended (docs/spec/native-surfaces.md#layout-transaction). It does not wait for the UI thread.
func (s *Surfaces) mainPageEnded() {
	if diagnosticPageEnded != nil {
		diagnosticPageEnded(s)
	}
	if s.window == nil {
		return
	}
	window := s.window.NativeWindow()
	if err := system.EnqueueUI(func() {
		// The close of the window dropped its keys and cancelled its layouts, and the framework may have released its native window.
		if s.closed {
			return
		}
		system.KeysPageEnded(window)
		if err := s.cancelAllLayoutPresentations(window); err != nil {
			LogError("surface layout cancel", err)
		}
	}); err != nil {
		LogError("key wait", err)
	}
	s.layoutEnded()
}

// finishLayoutPresentation reads the actual surface frames and commits an accepted presentation on the UI thread.
func (s *Surfaces) finishLayoutPresentation(window platform.Window, req PresentRequest) ([]Placement, error) {
	if err := s.ensureCurrentPresentationJoins(window, req); err != nil {
		if cancel := s.cancelLayoutPresentation(window, req.Ticket); cancel != nil {
			err = fmt.Errorf("%w; cancelling layout: %v", err, cancel)
		}
		return nil, err
	}
	out := make([]Placement, 0, len(req.Placements))
	for _, p := range req.Placements {
		view := s.views[p.ID]
		if view == nil {
			failure := fmt.Errorf("surface %q closed before presentation", p.ID)
			if err := s.cancelLayoutPresentation(window, req.Ticket); err != nil {
				failure = fmt.Errorf("%w; cancelling layout: %v", failure, err)
			}
			return nil, failure
		}
		// The frame was fitted by the preparation of this ticket, so it keeps the scale that the preparation answered.
		out = append(out, seatedPlacement(p.ID, Rect(system.SurfaceFrame(view.NativeView())), p.Visible, p.Scale))
	}
	committed := system.CommitLayout(window, req.Ticket)
	if !committed {
		failure := fmt.Errorf("surface preparation %d is no longer current", req.Ticket)
		if cancel := s.cancelLayoutPresentation(window, req.Ticket); cancel != nil {
			failure = fmt.Errorf("%w; cancelling layout: %v", failure, cancel)
		}
		return nil, failure
	}
	s.presentation.accept(req.Ticket)
	if req.Settled {
		s.run(false)
	}
	return out, nil
}

// ensureCurrentPresentationJoins verifies that each visible root view in the request still matches its ticket join, and joins the views
// that replaced a root view or whose root view is new to the ticket.
func (s *Surfaces) ensureCurrentPresentationJoins(window platform.Window, req PresentRequest) error {
	requests, err := s.rejoinRequests(window, req)
	if err != nil {
		return err
	}
	for _, request := range requests {
		abandon, joined, err := system.JoinView(request.window, request.ticket, request.view, request.presented, request.ended)
		// A transaction that a press or key event ended while the presentation waited takes no join: it committed what its
		// joined views had presented, and the commit of the ticket answers that state, as the first stage records only the views
		// that joined (docs/spec/native-surfaces.md#layout-transaction).
		if _, _, err := s.viewJoined(request, viewJoinAnswer{abandon: abandon, joined: joined, err: err}); err != nil {
			return err
		}
	}
	return nil
}

// rejoinRequests verifies that each visible root view in the request still matches its ticket join and returns the joins of the views
// that replaced a root view or whose root view is new to the ticket. The presentation recorded the state of its ticket before it
// waited, so a ticket without state was cancelled meanwhile, by a reload, the close of the window or cancelSurfaces, and its
// preparation is no longer current.
func (s *Surfaces) rejoinRequests(window platform.Window, req PresentRequest) ([]viewJoinRequest, error) {
	state := s.presentation.pending[req.Ticket]
	if state == nil {
		return nil, fmt.Errorf("surface preparation %d is no longer current", req.Ticket)
	}
	var requests []viewJoinRequest
	for _, placement := range req.Placements {
		if !placement.Visible || s.viewRecords().specs[placement.ID] == nil {
			continue
		}
		previous, exists := state.placements[placement.ID]
		if !exists {
			return nil, fmt.Errorf("visible view %s has no placement in presentation %d", placement.ID, req.Ticket)
		}
		channel, current := s.documents.view(placement.ID)
		if !current {
			if state.invalid[placement.ID] {
				continue
			}
			if previous.generation == 0 {
				state.invalid[placement.ID] = true
				continue
			}
			return nil, fmt.Errorf("visible view %s has no current generation for presentation %d", placement.ID, req.Ticket)
		}
		if state.joined[placement.ID] == channel.generation {
			continue
		}
		if !state.requiresJoin[placement.ID] && previous.generation == channel.generation {
			continue
		}
		if join, waiting := s.presentation.waiting[placement.ID]; waiting {
			if join.ticket != req.Ticket {
				return nil, fmt.Errorf("visible view %s still waits for presentation %d", placement.ID, join.ticket)
			}
			if join.generation == channel.generation {
				return nil, fmt.Errorf("visible view %s has a pending join that is not recorded for presentation %d", placement.ID, req.Ticket)
			}
			delete(s.presentation.waiting, placement.ID)
			if join.abandon != nil {
				if err := join.abandon(); err != nil {
					return nil, fmt.Errorf("abandoning replaced generation %d of view %s: %w", join.generation, placement.ID, err)
				}
			}
		}
		previous.generation = channel.generation
		state.placements[placement.ID] = previous
		state.requiresJoin[placement.ID] = true
		delete(state.invalid, placement.ID)
		if request, ok := s.requestViewJoin(window, req.Ticket, placement); ok {
			requests = append(requests, request)
		}
	}
	return requests, nil
}

// CreateLogicalSurfaceHandle passes a native creation failure as it is and rejects a nil handle.
// The callback is separated so that the failure contract can be tested without creating a window.
func CreateLogicalSurfaceHandle(create func() (unsafe.Pointer, error), id string) (unsafe.Pointer, error) {
	handle, err := create()
	if err != nil {
		return nil, fmt.Errorf("surface %s: create: %w", id, err)
	}
	if handle == nil {
		return nil, fmt.Errorf("surface %s: create returned a nil handle", id)
	}
	return handle, nil
}

// WindowNativeKind is the kind of native object that is closed when the window closes.
type WindowNativeKind int

const (
	WindowNativeDocument WindowNativeKind = iota
	WindowNativeImage
	WindowNativeSurface
)

// WindowNative is a native object that is closed when the window closes.
type WindowNative struct {
	Kind   WindowNativeKind
	Handle unsafe.Pointer
}

func (kind WindowNativeKind) String() string {
	switch kind {
	case WindowNativeDocument:
		return "document region"
	case WindowNativeImage:
		return "image region"
	default:
		return "surface"
	}
}

// CloseWindowSurfaces closes, for each logical surface of the closing window, its document regions and image regions and then closes the surface. Surfaces are closed in id
// order.
//
// A logical surface holds a main web view and a document region has its own web content process, so a surface and a region that are not closed leave the web view and its web content process after the window
// closed. Even when one object cannot be closed, the rest are closed and all failures are returned.
// close closes one native object and is called on the UI thread.
func CloseWindowSurfaces(surfaces map[string]unsafe.Pointer, documents *Documents, streams *DocumentStreams, images *Images, close func(WindowNative) error) error {
	ids := make([]string, 0, len(surfaces))
	for id := range surfaces {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	var failures []string
	for _, id := range ids {
		var natives []WindowNative
		// The streams and the request logs of the surface end with its documents.
		streams.RemoveSurface(id)
		for _, handle := range documents.RemoveSurface(id) {
			natives = append(natives, WindowNative{Kind: WindowNativeDocument, Handle: handle})
		}
		for _, handle := range images.RemoveSurface(id) {
			natives = append(natives, WindowNative{Kind: WindowNativeImage, Handle: handle})
		}
		natives = append(natives, WindowNative{Kind: WindowNativeSurface, Handle: surfaces[id]})
		for _, native := range natives {
			if err := close(native); err != nil {
				failures = append(failures, fmt.Sprintf("surface %q: closing the %s: %v", id, native.Kind, err))
			}
		}
	}
	if len(failures) > 0 {
		return errors.New(strings.Join(failures, "; "))
	}
	return nil
}

// closeRemovedSurface closes the sidecar sessions associated with a native surface removed by a complete placement.
func (s *Surfaces) closeRemovedSurface(id string) {
	s.sidecars.NativeViewRemoved(id)
}

func createLogicalSurface(create func() (unsafe.Pointer, error), owner *Surfaces, id string) (*nativeWebview, error) {
	handle, err := CreateLogicalSurfaceHandle(create, id)
	if err != nil {
		return nil, err
	}
	return &nativeWebview{owner: owner, handle: handle, logical: true}, nil
}

// apply creates, moves and removes the surface views, and returns the ids whose views were removed. The caller ends the shells after that
// outside this thread. SyncSurfaces checked the request with
// CheckSyncRequest before it started the layout.
func (s *Surfaces) apply(win Frontend, req SyncRequest) ([]string, []Placement, error) {
	if !req.Settled {
		s.run(true)
	}
	wanted := map[string]bool{}
	type desiredSurface struct {
		id      string
		decl    Surface
		view    *nativeWebview
		aligned Rect
		scale   float64
		visible bool
		// created tells that this preparation creates the surface.
		created bool
	}
	desired := make([]desiredSurface, 0, len(req.Surfaces))
	created := make([]string, 0)
	// opened are the surfaces that this call creates; the host tells the sidecars of their plugins after the layout is applied.
	opened := make([]Surface, 0)
	rollback := func() {
		for _, id := range created {
			if view := s.views[id]; view != nil {
				s.closeRegisteredSurface(mainThreadStep, view)
				delete(s.views, id)
			}
		}
	}
	for _, surface := range req.Surfaces {
		wanted[surface.ID] = true
		w, h := max1(surface.W), max1(surface.H)
		visible := surface.Visible && surface.W >= 1 && surface.H >= 1
		view := s.views[surface.ID]
		made := view == nil
		if made {
			var err error
			view, err = s.createRegisteredSurface(mainThreadStep, surface.ID, func() (unsafe.Pointer, error) {
				return system.CreateSurface(win.NativeWindow())
			})
			if err != nil {
				rollback()
				return nil, nil, err
			}
			s.views[surface.ID] = view
			created = append(created, surface.ID)
			opened = append(opened, surface)
			PerformanceSurface("created", surface.ID, nil)
		}
		alignedWant, scale := Rect{}, 0.0
		if visible {
			var err error
			alignedWant, scale, err = aligned(win, Rect{X: surface.X, Y: surface.Y, W: w, H: h})
			if err != nil {
				rollback()
				return nil, nil, err
			}
		}
		desired = append(desired, desiredSurface{id: surface.ID, decl: surface, view: view, aligned: alignedWant, scale: scale, visible: visible, created: made})
	}

	placed := make([]Placement, 0, len(desired))
	for _, item := range desired {
		s.mu.Lock()
		s.compositions[item.id] = item.decl.Composition
		s.surfacePlugins[item.id] = item.decl.Plugin
		s.mu.Unlock()
		s.images.SetSurfaceVisible(item.id, item.visible)
		// The view of a view surface is created by its first sync and fills the surface (docs/spec/plugins.md#view-surfaces).
		start, err := s.viewStartOf(item.decl)
		if err != nil {
			return nil, nil, err
		}
		// Newly created native surfaces start hidden; existing visible surfaces remain visible through preparation. A surface hides before
		// its view, because a surface that hides notes what held the keyboard inside it and gives it back when it shows.
		prepareSurfaceVisibility(item.visible, item.view.SetHidden)
		if err := s.syncView(item.id, item.view.NativeView(), item.decl.Plugin, item.decl.Composition.Page, item.visible, start); err != nil {
			return nil, nil, err
		}
		system.SetSurfaceAlphaHandle(item.view.NativeView(), alphaFor(item.decl.Dim))
		// A window without a main page sets the frame of a surface in the frame that draws its card, when its native view element gives
		// its placement (docs/spec/hosts.md#operation-groups). A surface that the preparation creates has no element in the frame of the
		// transaction, which was built before the surface existed, so the preparation places it in its box here, and the element of the
		// next frame keeps that place.
		if item.visible && (framework.MainPage() || item.created) {
			item.view.SetBounds(item.aligned.X, item.aligned.Y, item.aligned.W, item.aligned.H)
		}
		placement := seatedPlacement(item.id, placedRect(item.view, item.aligned, item.visible), item.visible, item.scale)
		PerformanceSurface("placed", item.id, &placement)
		placed = append(placed, placement)
	}

	// Only the page writes this list, so a surface that is not in the list is a removed surface.
	var gone []string
	for id, view := range s.views {
		if wanted[id] {
			continue
		}
		s.setElement(id, SurfaceElement{})
		s.closeSurfaceDocuments(id)
		s.images.CloseSurface(id, func(handle unsafe.Pointer) {
			system.CloseImage(handle)
			s.windowChanged()
		})
		s.images.EndGeneration(id)
		s.closeRegisteredSurface(mainThreadStep, view)
		delete(s.views, id)
		s.mu.Lock()
		delete(s.compositions, id)
		delete(s.surfacePlugins, id)
		s.mu.Unlock()
		// A surface that is removed and created again is a reopened tab, which clears the failures of its view.
		s.viewRecords().forget(id)
		delete(s.compositionRevisions, id)
		// Instrument of the surface lifecycle (V5-104): a surface that disappeared from the list is destroyed at this point.
		PerformanceSurface("destroyed", id, nil)
		gone = append(gone, id)
	}
	for _, surface := range opened {
		s.sidecars.SurfaceOpened(surface.Plugin, surface.ID)
	}
	return gone, placed, nil
}

// placedRect is the rectangle that a visible surface has in the frame that shows the layout, and the frame of a hidden one.
func placedRect(view *nativeWebview, aligned Rect, visible bool) Rect {
	if visible && !framework.MainPage() {
		return aligned
	}
	return Rect(system.SurfaceFrame(view.NativeView()))
}

// createRegisteredSurface creates the native view of the surface id and names it in s.named in one call of run. The window
// state reads s.named on the UI thread, so run is the UI-thread call (mainThreadStep), and a reading never finds
// the native view without its surface id.
func (s *Surfaces) createRegisteredSurface(run func(func()), id string, create func() (unsafe.Pointer, error)) (*nativeWebview, error) {
	var view *nativeWebview
	var err error
	run(func() {
		if s.closed {
			err = errWindowClosed
			return
		}
		view, err = createLogicalSurface(create, s, id)
		if err == nil {
			s.named[uintptr(view.handle)] = id
		}
	})
	return view, err
}

func newNativeWebview(owner *Surfaces, options nativeWebviewOptions) (*nativeWebview, error) {
	var view *nativeWebview
	var err error
	owner.invoke(func() {
		if owner.closed {
			err = errWindowClosed
			return
		}
		nativeSerial++
		var handle unsafe.Pointer
		handle, err = system.CreateWebview(owner.window.NativeWindow(), platform.WebviewOptions{
			Identifier: nativeSerial,
			Name:       options.Name,
			Script:     webviewBootstrap + "\n" + backgroundScript,
			X:          options.X, Y: options.Y, Width: options.Width, Height: options.Height,
			Hidden: options.Hidden, Transparent: options.Transparent,
			Receive:    dispatchNative,
			Committed:  committedNative,
			Terminated: terminatedNative,
		})
		if err != nil {
			return
		}
		view = &nativeWebview{id: nativeSerial, handle: handle, owner: owner}
		nativeViews[view.id] = view
	})
	if err != nil {
		return nil, err
	}
	if err := view.SetURL(options.URL); err != nil {
		view.Close()
		return nil, err
	}
	return view, nil
}

func (v *nativeWebview) NativeView() unsafe.Pointer {
	var handle unsafe.Pointer
	mainThreadStep(func() { handle = v.handle })
	return handle
}

func (v *nativeWebview) SetURL(url string) error {
	var applied bool
	mainThreadStep(func() {
		if v.handle == nil {
			return
		}
		applied = system.NavigateWebview(v.handle, url)
	})
	if !applied {
		return fmt.Errorf("native webview is closed or its URL is invalid: %s", url)
	}
	return nil
}

func (v *nativeWebview) SetBounds(x, y, width, height float64) {
	mainThreadStep(func() {
		if v.handle != nil {
			if v.logical {
				system.SetSurfaceBounds(v.handle, x, y, width, height)
			} else {
				system.SetWebviewBounds(v.handle, x, y, width, height)
			}
		}
	})
}

func (v *nativeWebview) SetHidden(hidden bool) {
	mainThreadStep(func() {
		if v.handle != nil {
			if v.logical {
				system.SetSurfaceHiddenHandle(v.handle, hidden)
			} else {
				system.SetWebviewHidden(v.handle, hidden)
			}
		}
	})
}

func (v *nativeWebview) setBackground(enabled bool) {
	mainThreadStep(func() {
		if v.handle != nil {
			system.SetWebviewBackground(v.handle, enabled)
		}
	})
}

// Call execJS on the main thread.
func (v *nativeWebview) execJS(script string) {
	if v.handle == nil {
		return
	}
	system.EvaluateScript(v.handle, script)
}

func (v *nativeWebview) Close() {
	mainThreadStep(v.closeOnUI)
}

// closeOnUI closes the native view. It runs on the UI thread, so a caller that already runs there closes the view without
// waiting for another UI-thread call.
func (v *nativeWebview) closeOnUI() {
	if v.handle == nil {
		return
	}
	delete(nativeViews, v.id)
	if v.logical {
		system.CloseSurface(v.handle)
	} else {
		system.CloseWebview(v.handle)
	}
	v.handle = nil
}

// closeRegisteredSurface closes the native view of a removed surface and forgets its name in s.named in one call of run.
// The window state reads s.named on the UI thread, so run is the UI-thread call (mainThreadStep), and a reading
// finds either the native view with its name or neither.
func (s *Surfaces) closeRegisteredSurface(run func(func()), view *nativeWebview) {
	run(func() {
		handle := uintptr(view.handle)
		view.closeOnUI()
		delete(s.named, handle)
	})
}
