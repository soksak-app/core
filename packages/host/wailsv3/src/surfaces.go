// Surface synchronization, display confirmation, layout, and delivery of surface input.
//
// The page declares the region of each surface at every commit. A surface is a native web view added to the main window as a
// child at the declared region. bindings.go handles the messages of a native web view, and
// the operating system implementation delivers pointer input.

package host

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"reflect"
	"sort"
	"strings"
	"sync"
	"time"
	"unsafe"

	"github.com/wailsapp/wails/v3/pkg/application"

	"github.com/soksak-app/core/packages/host/wailsv3/src/platform"
	"github.com/soksak-app/core/packages/host/wailsv3/src/routine"
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
	_, err := viewOriginDirectory(surface, start.Origin)
	return err
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
	Input   string `json:"input"`
}

type SurfaceComposition struct {
	Kind     string          `json:"kind"`
	Page     string          `json:"page,omitempty"`
	Regions  []SurfaceRegion `json:"regions,omitempty"`
	Overlays []string        `json:"overlays,omitempty"`
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
			if region.Input != "native" || region.Sidecar != "" {
				return fmt.Errorf("document region %q must own native input", region.Name)
			}
		case "image":
			if region.Input != "dom" || region.Sidecar == "" {
				return fmt.Errorf("image region %q requires DOM input and a sidecar", region.Name)
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

func (s *Surfaces) requireRegion(surface, name, kind, sidecar string) error {
	s.mu.Lock()
	composition, ok := s.compositions[surface]
	s.mu.Unlock()
	if !ok {
		return fmt.Errorf("surface %q has no composition declaration", surface)
	}
	for _, region := range composition.Regions {
		if region.Name != name {
			continue
		}
		if region.Kind != kind {
			return fmt.Errorf("region %q is declared as %s, not %s", name, region.Kind, kind)
		}
		if kind == "image" && sidecar != "" && region.Sidecar != sidecar {
			return fmt.Errorf("image %q is not declared for sidecar %q", name, sidecar)
		}
		return nil
	}
	return fmt.Errorf("region %q is not declared by surface %q", name, surface)
}

type SyncRequest struct {
	// Tells whether the continuous layout update ended.
	Settled  bool                   `json:"settled"`
	Surfaces []Surface              `json:"surfaces"`
	Overlays []WindowOverlayRequest `json:"overlays,omitempty"`
	// The height (pt) of the first row that the next draw will show. Inside a layout transaction, the window title bar is set to this height
	// (docs/spec/native-surfaces.md#title-bar-height).
	Titlebar float64 `json:"titlebar"`
}

type WindowOverlayRequest struct {
	X       float64 `json:"x"`
	Y       float64 `json:"y"`
	W       float64 `json:"w"`
	H       float64 `json:"h"`
	Visible *bool   `json:"visible"`
}

// nativeWebviewOptions are the creation values of surface and modal web views.
type nativeWebviewOptions struct {
	URL                 string
	Name                string
	X, Y, Width, Height float64
	Hidden, Transparent bool
	FillParent          bool
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
	// prepareNative registers the main web view and prepares the window. It is decided when the window is created.
	prepareNative func()
	window        *application.WebviewWindow
	// titles sets the title of the native window (windows.go setTitle). NewSurfaces sets the window, and a test sets a recorder.
	titles titleSetter
	// host is the host that created this window. name is the window identifier of the endpoint and title is the window title.
	host  *Host
	name  string
	title string
	// projects holds the projects that this window shows, by project id, with the folder root of each (docs/plans/plugin-host-routes.md rule 3).
	projects map[string]string
	// pendingProjects holds owner reservations that have not been committed by ProjectShown. Host.mu protects it.
	pendingProjects map[string]bool
	// shown is the project that the window shows, empty when it shows none, and root is its folder root. owner.mu protects both.
	// A release of the shown project clears both at once (docs/plans/plugin-host-routes.md F229-1).
	shown string
	root  string
	ready bool
	// readied is the channel that waits for the next WindowReady. Host.mu protects it.
	readied []chan struct{}
	monitor uintptr

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
	// Surfaces in a continuous resize. A surface does not receive a call for every frame; it receives the start and
	// the end of the continuous change.
	live map[string]bool
	// registrations are the entries that surface pages registered. When the main page is read again, the new page is told again.
	registrations map[string][]SurfaceRegistration
	// Tells whether a continuous update is in progress. The page announces it at every commit, and with this value run-began and
	// run-ended are published only at the start and the end of a continuous update and not for every frame.
	running bool
	// settled is the channel that waits for the continuous update to end. It is closed when run-ended is published.
	settled         []chan struct{}
	lastPreparation uint64
	// Tells whether the page committed. page-ready is published only once.
	first sync.Once
	// A modal is a web view inside the main window. It is created for each display and removed when it closes. The instance number
	// rejects the reply of an earlier display.
	nextModal uint64
	modal     *modal
	shapes    map[string]*nativeShape
	// documents are the document regions that the surface pages attached.
	documents *Documents
	// pluginHosts are the plugin host web views of the window, by plugin id (plugin_host.go).
	pluginHosts map[string]unsafe.Pointer
	// sourceOrigins assigns generations to plugin-host and view incarnations and exposes their current window snapshot.
	sourceOrigins *sourceOrigins
	// pluginHostChannels are the channels of the plugin host pages of the window, by plugin id (plugin_host_channel.go).
	pluginHostChannels *pluginHostChannels
	// pluginHostStates are the saved values of the plugin hosts of the application, shared by every window
	// (plugin_host.go).
	pluginHostStates *pluginHostStates
	// pluginHostRestarts are the restart-limit records of the plugin hosts of the application, shared by every window
	// (plugin_host.go).
	pluginHostRestarts *pluginHostRestarts
	// streams are the stream subscriptions of the document regions.
	streams *DocumentStreams
	// images are the image regions that the surface pages attached.
	images               *Images
	imageDetachMu        sync.Mutex
	pendingImageDetaches []imageDetachTarget
	// reload hooks replace native calls only in owning host tests; production uses the platform operations.
	reloadCancelLayout func() error
	reloadHideSurface  func(unsafe.Pointer, bool)
	reloadCloseImage   func(unsafe.Pointer)
	// invoke runs a task on the UI thread and waits for it. NewSurfaces sets application.InvokeSync, and a test sets a runner that
	// records the tasks.
	invoke   func(task func())
	sidecars *Sidecars
	watch    sync.Once

	// The theme that the main page set last. The page calls Theme after it loads.
	theme Theme
}

func NewSurfaces(win *application.WebviewWindow, sidecars *Sidecars) *Surfaces {
	s := &Surfaces{
		window: win, titles: win, projects: map[string]string{}, sidecars: sidecars,
		views:                map[string]*nativeWebview{},
		compositions:         map[string]SurfaceComposition{},
		surfacePlugins:       map[string]string{},
		compositionRevisions: map[string]uint64{},
		named:                map[uintptr]string{},
		live:                 map[string]bool{},
		shapes:               map[string]*nativeShape{},
		documents:            NewDocuments(),
		pluginHosts:          map[string]unsafe.Pointer{},
		sourceOrigins:        newSourceOrigins(),
		pluginHostChannels:   newPluginHostChannels(),
		streams:              NewDocumentStreams(),
		images:               NewImages(),
		invoke:               application.InvokeSync,
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
	s.window.EmitEvent(name, data)
}

// Emit delivers an event to the single app DOM of this window.
func (s *Surfaces) Emit(name string, data ...any) {
	s.window.EmitEvent(name, data...)
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

// SidecarSend passes a message that a surface page of this window sent to a sidecar.
func (s *Surfaces) SidecarSend(name, surface string, body json.RawMessage, cids []string) error {
	// A plugin session is reached only through the plugin host call (docs/plans/plugin-host-routes.md rule 2).
	if strings.HasPrefix(surface, "plugin:") {
		return fmt.Errorf("sidecar session %s is reserved for a plugin host", surface)
	}
	return s.sidecars.SendWithCids(s, name, surface, body, cids)
}

func (s *Surfaces) sidecarSendFrom(viewID uint64, name, surface string, body json.RawMessage, cids []string) error {
	if err := s.authorizeSurface(viewID, surface); err != nil {
		return err
	}
	return s.SidecarSend(name, surface, body, cids)
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
			var err error
			application.InvokeSync(func() {
				err = work()
			})
			return err
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
	application.InvokeSync(func() {
		if !s.running {
			close(done)
			return
		}
		s.settled = append(s.settled, done)
	})
	return done
}

// resizing starts or ends the continuous resize of a surface. The two calls form a pair, so the state of each surface
// is kept here and only a change is passed on.
func (s *Surfaces) resizing(id string, view *nativeWebview, live bool) {
	if s.live[id] == live {
		return
	}
	if live {
		s.live[id] = true
	} else {
		delete(s.live, id)
	}
	system.SetWebviewResizing(view.NativeView(), live)
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
	application.InvokeAsync(func() { s.Emit("surface-pressed", id) })
	return true
}

// pressAt publishes a surface press when the coordinates of a directly injected press are in a surface or its document.
// A direct injection does not pass through the local event monitor of AppKit, so this is called separately from the monitor.
func (s *Surfaces) pressAt(x, y float64) error {
	var got struct {
		View uint64 `json:"view"`
	}
	if err := s.nativeFacts(func(window unsafe.Pointer) (string, error) {
		return system.WindowHit(window, x, y)
	}, &got, nil); err != nil {
		return err
	}
	if got.View != 0 {
		s.press(uintptr(got.View))
	}
	return nil
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
	application.InvokeAsync(func() { s.Emit("surface-input", step) })
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

// aligned fits a region in page coordinates to the display pixels. Call it on the UI thread.
func aligned(win *application.WebviewWindow, at Rect) (Rect, error) {
	got, err := system.AlignRect(win.NativeWindow(), platformRect{X: at.X, Y: at.Y, W: max1(at.W), H: max1(at.H)})
	if err != nil {
		return Rect{}, fmt.Errorf("surface alignment: %w", err)
	}
	return Rect(got), nil
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
		// default: a view without start values has no origin, which validateViewStart refuses.
		start := ViewStart{}
		if surface.Start != nil {
			start = *surface.Start
		}
		if err := validateViewStart(surface.ID, &start); err != nil {
			return nil, err
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
	application.InvokeSync(func() {
		main, err := system.MainWebview(win.NativeWindow())
		if err != nil {
			began = err
			return
		}
		began = RunLayout(func() error {
			return system.SetWindowOverlays(main, windowOverlays)
		}, func() error {
			s.lastPreparation++
			prepared.Ticket = s.lastPreparation
			return system.BeginLayout(win.NativeWindow(), prepared.Ticket, func(allowed bool) {
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
				}, func() error { return system.CancelLayout(win.NativeWindow()) })
				if err == nil {
					s.watch.Do(func() { s.watchInput(win) })
				} else if !req.Settled {
					s.run(false)
				}
				done <- applyResult{chrome: chrome, restore: restore, gone: gone, placements: placements, err: err}
			})
		})
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
		s.sidecars.Close(id)
	}
	s.surfacesClosed(gone)
	// A continuous frame updates only the native position. If the image raster were rebuilt
	// at every divider step, the sidecar work would be serialized behind the display queue. The settled frame below
	// performs the raster update that serves as the reference.
	if req.Settled {
		if err := s.refreshImageRasters(); err != nil {
			// A cancel commits the transaction, so the title bar is restored first to match the row before drawing.
			restore := outcome.restore
			if cancel := system.EnqueueUI(func() {
				if failure := restore(); failure != nil {
					LogError("surface layout title bar restore", failure)
				}
				if failure := system.CancelLayout(win.NativeWindow()); failure != nil {
					LogError("surface layout cancel", failure)
				}
			}); cancel != nil {
				return prepared, fmt.Errorf("%w; scheduling layout cancellation: %v", err, cancel)
			}
			return prepared, err
		}
	}
	return prepared, nil
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
func (s *Surfaces) watchInput(win *application.WebviewWindow) {
	monitor, err := system.WatchInput(win.NativeWindow(), platform.Input{Press: s.press, Point: s.point})
	if err != nil {
		LogError("surface input", err)
		return
	}
	s.monitor = monitor
}

// Placement is the actual position of one surface in page coordinates. The host fits the region that the page declared to the display pixels,
// so the two values differ, and the page receives that difference.
type Placement struct {
	ID string `json:"id"`
	Rect
	Visible bool `json:"visible"`
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
	Ticket              uint64      `json:"ticket"`
	Placements          []Placement `json:"placements"`
	Settled             bool        `json:"settled"`
	WaitForPresentation bool        `json:"waitForPresentation,omitempty"`
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
	done := make(chan result, 1)
	// A settled frame checks the DOM document and the image raster. A continuous frame commits after the native preparation so that the next
	// display cycle is not serialized behind a document or raster callback. The frame check handles
	// this transition.
	routine.Go("layout-prepare", func() {
		var waiting error
		if req.Settled || req.WaitForPresentation {
			domReady := make(chan struct{})
			application.InvokeSync(func() {
				waiting = system.AfterPresentation(win.NativeWindow(), func() { close(domReady) })
			})
			if waiting == nil {
				timer := time.NewTimer(pageTimeout)
				select {
				case <-domReady:
				case <-timer.C:
					waiting = fmt.Errorf("application documents did not present within %s", pageTimeout)
				}
				timer.Stop()
			}
		}
		// A continuous frame also waits, before the commit, for each visible image region to display a raster of the prepared size.
		// Without waiting, a surface resize would show the previous raster while the region is enlarged
		// (docs/spec/surface-composition.md).
		if waiting == nil {
			waiting = s.refreshImageRasters()
		}
		if waiting == nil {
			if err := s.images.WaitCurrentError(pageTimeout); err != nil {
				if err.Error() == "presentationTimeout" {
					waiting = fmt.Errorf("the current image raster did not present within %s; pending %s",
						pageTimeout, s.images.PendingRasters())
				} else {
					waiting = fmt.Errorf("the current image raster failed to present: %w", err)
				}
			}
		}
		// The commit and the cancel run outside the framework event lock.
		if err := system.EnqueueUI(func() {
			if waiting != nil {
				if err := system.CancelLayout(win.NativeWindow()); err != nil {
					waiting = fmt.Errorf("%w; cancelling layout: %v", waiting, err)
				}
				done <- result{err: waiting}
				return
			}
			out := make([]Placement, 0, len(req.Placements))
			for _, p := range req.Placements {
				view := s.views[p.ID]
				if view == nil {
					failure := fmt.Errorf("surface %q closed before presentation", p.ID)
					if err := system.CancelLayout(win.NativeWindow()); err != nil {
						failure = fmt.Errorf("%w; cancelling layout: %v", failure, err)
					}
					done <- result{err: failure}
					return
				}
				view.SetHidden(!p.Visible)
				out = append(out, Placement{ID: p.ID, Rect: Rect(system.SurfaceFrame(view.NativeView())), Visible: p.Visible})
			}
			if req.Settled {
				if err := s.joinShownViews(win.NativeWindow(), req.Ticket, req.Placements); err != nil {
					if cancel := system.CancelLayout(win.NativeWindow()); cancel != nil {
						err = fmt.Errorf("%w; cancelling layout: %v", err, cancel)
					}
					done <- result{err: err}
					return
				}
			}
			committed := system.CommitLayout(win.NativeWindow(), req.Ticket)
			if !committed {
				done <- result{err: fmt.Errorf("surface preparation %d is no longer current", req.Ticket)}
				return
			}
			if req.Settled {
				s.run(false)
			}
			done <- result{placed: out}
		}); err != nil {
			done <- result{err: err}
		}
	})
	outcome := <-done
	if outcome.err != nil {
		return nil, outcome.err
	}
	placed := outcome.placed
	s.windowChanged()
	return placed, nil
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
		// The streams of the surface end with its documents; the closed documents need no turn-off.
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
func (s *Surfaces) apply(win *application.WebviewWindow, req SyncRequest) ([]string, []Placement, error) {
	if !req.Settled {
		s.run(true)
	}
	wanted := map[string]bool{}
	type desiredSurface struct {
		id      string
		decl    Surface
		view    *nativeWebview
		aligned Rect
		visible bool
	}
	desired := make([]desiredSurface, 0, len(req.Surfaces))
	created := make([]string, 0)
	// opened are the surfaces that this call creates; the host tells the sidecars of their plugins after the layout is applied.
	opened := make([]Surface, 0)
	rollback := func() {
		for _, id := range created {
			if view := s.views[id]; view != nil {
				s.closeRegisteredSurface(application.InvokeSync, view)
				delete(s.views, id)
			}
		}
	}
	for _, surface := range req.Surfaces {
		wanted[surface.ID] = true
		w, h := max1(surface.W), max1(surface.H)
		visible := surface.Visible && surface.W >= 1 && surface.H >= 1
		view := s.views[surface.ID]
		if view == nil {
			var err error
			view, err = s.createRegisteredSurface(application.InvokeSync, surface.ID, func() (unsafe.Pointer, error) {
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
		alignedWant := Rect{}
		if visible {
			var err error
			alignedWant, err = aligned(win, Rect{X: surface.X, Y: surface.Y, W: w, H: h})
			if err != nil {
				rollback()
				return nil, nil, err
			}
		}
		desired = append(desired, desiredSurface{id: surface.ID, decl: surface, view: view, aligned: alignedWant, visible: visible})
	}

	placed := make([]Placement, 0, len(desired))
	for _, item := range desired {
		s.mu.Lock()
		s.compositions[item.id] = item.decl.Composition
		s.surfacePlugins[item.id] = item.decl.Plugin
		s.mu.Unlock()
		s.images.SetSurfaceVisible(item.id, item.visible)
		// The view of a view surface is created by its first sync and fills the surface (docs/spec/plugins.md#view-surfaces).
		// default: a view without start values has no origin; the start values script refuses it (CheckSyncRequest refuses it first).
		start := ViewStart{}
		if item.decl.Start != nil {
			start = *item.decl.Start
		}
		if err := s.syncView(item.id, item.view.NativeView(), item.decl.Plugin, item.decl.Composition.Page, item.visible, start); err != nil {
			return nil, nil, err
		}
		// The native view is kept hidden until PresentSurfaces confirms that the corresponding application DOM frame
		// was displayed.
		item.view.SetHidden(true)
		system.SetSurfaceAlphaHandle(item.view.NativeView(), alphaFor(item.decl.Dim))
		if item.visible {
			item.view.SetBounds(item.aligned.X, item.aligned.Y, item.aligned.W, item.aligned.H)
		}
		placement := Placement{ID: item.id, Rect: Rect(system.SurfaceFrame(item.view.NativeView())), Visible: item.visible}
		PerformanceSurface("placed", item.id, &placement)
		placed = append(placed, placement)
	}

	// Only the page writes this list, so a surface that is not in the list is a removed surface.
	var gone []string
	for id, view := range s.views {
		if wanted[id] {
			continue
		}
		s.closeSurfaceDocuments(id)
		s.images.CloseSurface(id, func(handle unsafe.Pointer) {
			system.CloseImage(handle)
			s.windowChanged()
		})
		s.images.EndGeneration(id)
		s.closeRegisteredSurface(application.InvokeSync, view)
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
		s.pluginHostReset(surface.Plugin, application.InvokeSync)
	}
	return gone, placed, nil
}

// createRegisteredSurface creates the native view of the surface id and names it in s.named in one call of run. The window
// state reads s.named on the UI thread, so run is the UI-thread call (application.InvokeSync), and a reading never finds
// the native view without its surface id.
func (s *Surfaces) createRegisteredSurface(run func(func()), id string, create func() (unsafe.Pointer, error)) (*nativeWebview, error) {
	var view *nativeWebview
	var err error
	run(func() {
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
	application.InvokeSync(func() {
		nativeSerial++
		var handle unsafe.Pointer
		handle, err = system.CreateWebview(owner.window.NativeWindow(), platform.WebviewOptions{
			Identifier: nativeSerial,
			Name:       options.Name,
			Script:     webviewBootstrap + "\n" + backgroundScript,
			X:          options.X, Y: options.Y, Width: options.Width, Height: options.Height,
			Hidden: options.Hidden, Transparent: options.Transparent,
			FillParent: options.FillParent,
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
	application.InvokeSync(func() { handle = v.handle })
	return handle
}

func (v *nativeWebview) SetURL(url string) error {
	var applied bool
	application.InvokeSync(func() {
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
	application.InvokeSync(func() {
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
	application.InvokeSync(func() {
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
	application.InvokeSync(func() {
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
	application.InvokeSync(v.closeOnUI)
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
// The window state reads s.named on the UI thread, so run is the UI-thread call (application.InvokeSync), and a reading
// finds either the native view with its name or neither.
func (s *Surfaces) closeRegisteredSurface(run func(func()), view *nativeWebview) {
	run(func() {
		handle := uintptr(view.handle)
		view.closeOnUI()
		delete(s.named, handle)
	})
}
