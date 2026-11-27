package host

// The display region for external pictures in a surface page, related to the picture envelope of docs/spec/sidecars.md.
//
// A surface page requests that a picture be shown in a native region. The host creates an image region inside the surface web view,
// lays it out with the margins that the page reported, and shows in the region the picture that a sidecar sent. The image region is a subview of the
// surface web view, so it moves and hides together with the surface.
// It closes when the surface is removed or the surface page is read again. The image region shows the picture
// envelope (image envelope) that a sidecar sent, and the host verifies the authenticity of the sidecar.

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
	"unsafe"

	"github.com/soksak-app/core/packages/host/go/src/platform"
)

// inputDrawWindow is the age of a user input at which the screen request of the input is sent at once, without waiting for a tick
// (docs/spec/native-surfaces.md#copy-path-frames).
const inputDrawWindow = 200 * time.Millisecond

// imageStore is the name of the persistent data store of an image region.
const imageStore = "soksak-images"

var imageName = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,63}$`)

// ImageRequest is an image region call of a surface page.
type ImageRequest struct {
	Surface string `json:"surface"`
	Name    string `json:"name"`
	Sidecar string `json:"sidecar,omitempty"`
}

// ImageKey is the pair of a surface and a picture name.
type ImageKey struct {
	Surface, Name string
}

// CheckImage checks the surface ownership of the surface caller and returns the key.
func CheckImage(caller string, req ImageRequest) (ImageKey, error) {
	if caller == "" || caller != req.Surface {
		return ImageKey{}, fmt.Errorf("this image is not surface %q", req.Surface)
	}
	if !imageName.MatchString(req.Name) {
		return ImageKey{}, fmt.Errorf("invalid image name %q", req.Name)
	}
	return ImageKey{req.Surface, req.Name}, nil
}

func (s *Surfaces) checkImage(viewID uint64, req ImageRequest) (ImageKey, error) {
	if err := s.authorizeSurface(viewID, req.Surface); err != nil {
		return ImageKey{}, err
	}
	caller := s.surfaceOf(viewID)
	if caller == "" {
		caller = req.Surface
	}
	return CheckImage(caller, req)
}

// ImageCallError returns the failure of the image region call call (docs/spec/native-host.md#host-calls).
func ImageCallError(call string, err error) error {
	if err == nil {
		return nil
	}
	return fmt.Errorf("%s: %w", call, err)
}

// ImageOwner records the sidecar that registered an image region and its owner.
type ImageOwner struct {
	SidecarName  string
	SidecarOwner SidecarOwner
	// Lease is whether the region presents in the lease mode, which answers leased and released instead of consumed.
	Lease bool
}

type imageDetachTarget struct {
	Surface    string
	Name       string
	Sidecar    string
	Generation uint64
	Owner      SidecarOwner
}

// Images are the image regions of a window.
type Images struct {
	mu             sync.Mutex
	handles        map[ImageKey]unsafe.Pointer
	owners         map[ImageKey]*ImageOwner
	states         map[ImageKey]*ImageRasterState
	generations    map[string]uint64
	surfaceVisible map[string]bool
	// onScreen is whether the window is neither occluded nor minimized; the host reads it from AppKit before it attaches a region and at
	// each change (docs/spec/native-surfaces.md#image-regions).
	onScreen bool
	// drawCovered keeps the regions of the window drawing while it is not on screen. Only the diagnostic method
	// diagnostics.window.draw-covered sets it (images_draw_covered.go); a build without the diagnostics tag reads it as false.
	drawCovered bool
	// The generation and the raster that a detached image region used last. A region attached again in the same generation counts from the next raster, because the sidecar
	// ignores a configuration whose (generation, raster) did not increase as a past configuration. It is cleared when the generation of the surface changes.
	detachedRasters map[ImageKey][2]uint64
	changed         chan struct{}
	// waitEnds counts the ends of the layout transactions of the window, and endedSidecars the ends of the connections of the
	// sidecars of its regions, each with the name of the last one, so a raster wait ends with the event that ends it
	// (docs/spec/native-surfaces.md#layout-transaction).
	waitEnds      uint64
	endedSidecars uint64
	endedSidecar  string
}

// errLayoutWaitEnded is the end of a raster wait by the end of the layout transaction that it belongs to.
var errLayoutWaitEnded = errors.New("the layout transaction of the window ended")

// EndWaits ends each raster wait of the window, because the layout transaction that it belongs to ended.
func (i *Images) EndWaits() {
	i.mu.Lock()
	defer i.mu.Unlock()
	i.waitEnds++
	i.changedLocked()
}

// ImageRasterState is the current send generation that the host allowed and the exact native raster.
type ImageRasterState struct {
	Generation, Raster uint64
	Width, Height      int
	Scale              float64
	LastSequence       int
	Configured         bool
	Visible            bool
	PresentedRaster    uint64
	PresentedSequence  int
	// PresentedFrames counts the frames of the region that the host marked presented since the region was attached. A raster or a
	// generation change does not reset it, because it counts the frames of the region (host.window presentedFrames).
	PresentedFrames   uint64
	PresentationError string
	// SupplierEnded is true from the end of the supplier connection of the region until the host presents a frame of the region
	// again. The next connection may hold no session for the region and then sends no raster, so no wait requires a raster of the
	// region meanwhile (docs/spec/native-surfaces.md#image-regions).
	SupplierEnded bool
	// Drawing and Hidden are the drawing state last sent to the supplier, and DrawingSent whether one was sent (MarkDrawingSent).
	Drawing     bool
	Hidden      bool
	DrawingSent bool
	// ScreenRequest is the screen request that the region has not had answered; its Request is empty when none is unanswered.
	// ScreenAccepted and ScreenGeneration, ScreenRaster are the screen that the host accepted last, the baseline of the rows.
	ScreenRequest                  ImageScreenRequest
	ScreenAccepted                 bool
	ScreenGeneration, ScreenRaster uint64
	// FrameWanted is true from the frame request that asked the native region for a display frame until the native region reports that
	// frame, FrameRead is true while a read request waits for it, and FrameSequence counts the ticks of the region
	// (docs/spec/native-surfaces.md#copy-path-frames).
	FrameWanted   bool
	FrameRead     bool
	FrameSequence uint64
}

// ImageConfigure is the new raster configuration to send to the authorized sidecar.
type ImageConfigure struct {
	Name       string       `json:"name"`
	Generation uint64       `json:"generation"`
	Raster     uint64       `json:"raster"`
	Width      int          `json:"width"`
	Height     int          `json:"height"`
	Scale      float64      `json:"scale"`
	Sidecar    string       `json:"-"`
	Owner      SidecarOwner `json:"-"`
}

// ImageDrawing is the drawing state of an image region to send to its supplier (docs/spec/native-surfaces.md#image-regions).
type ImageDrawing struct {
	Name       string `json:"name"`
	Generation uint64 `json:"generation"`
	Drawing    bool   `json:"drawing"`
	// Hidden reports that the outer surface of the region is hidden: the region receives no configuration until it is shown.
	Hidden bool `json:"hidden"`
	// Configure is the configuration that this region waited for while it was not drawing.
	Configure *ImageConfigure `json:"-"`
	Key       ImageKey        `json:"-"`
	Sidecar   string          `json:"-"`
	Owner     SidecarOwner    `json:"-"`
}

// ImageScreenRequest is the request for the current screen of a drawing region (docs/spec/native-surfaces.md#copy-path-frames).
// Full is true when the host holds no accepted screen of the same generation and raster, so the supplier sends every row.
type ImageScreenRequest struct {
	Request    string `json:"request"`
	Name       string `json:"name"`
	Generation uint64 `json:"generation"`
	Raster     uint64 `json:"raster"`
	Full       bool   `json:"full"`
	// Cids are the correlation identifiers of the inputs that the request continues, present when the request was sent for an input.
	Cids    []string     `json:"cids,omitempty"`
	Key     ImageKey     `json:"-"`
	Sidecar string       `json:"-"`
	Owner   SidecarOwner `json:"-"`
}

// ScreenRequests returns a screen request for each drawing region that has no unanswered request, sorted by surface and name, and
// records each returned request as unanswered. A request is not sent again while the region has an unanswered one.
func (i *Images) ScreenRequests() []ImageScreenRequest {
	i.mu.Lock()
	defer i.mu.Unlock()
	requests := []ImageScreenRequest{}
	for key, state := range i.states {
		if request, ok := i.newScreenRequestLocked(key, state, nil); ok {
			requests = append(requests, request)
		}
	}
	sort.Slice(requests, func(a, b int) bool {
		if requests[a].Key.Surface != requests[b].Key.Surface {
			return requests[a].Key.Surface < requests[b].Key.Surface
		}
		return requests[a].Key.Name < requests[b].Key.Name
	})
	return requests
}

// InputScreenRequest returns the screen request that a user input sends at once to a drawing region: the input is at most inputDrawWindow old
// at now and the region has no unanswered request. cids are the correlation identifiers of the input. It returns false when the input sends
// no request, and the next tick sends the request of the region. An input at a time after now is not within the window.
func (i *Images) InputScreenRequest(key ImageKey, cids []string, inputAt, now time.Time) (ImageScreenRequest, bool) {
	age := now.Sub(inputAt)
	if age < 0 || age > inputDrawWindow {
		return ImageScreenRequest{}, false
	}
	i.mu.Lock()
	defer i.mu.Unlock()
	state := i.states[key]
	if state == nil {
		return ImageScreenRequest{}, false
	}
	return i.newScreenRequestLocked(key, state, cids)
}

// newScreenRequestLocked records and returns the screen request of a drawing region that has no unanswered request. It returns false
// when the region gets no request. Call it while holding i.mu.
func (i *Images) newScreenRequestLocked(key ImageKey, state *ImageRasterState, cids []string) (ImageScreenRequest, bool) {
	owner := i.owners[key]
	if owner == nil || i.handles[key] == nil || state.ScreenRequest.Request != "" || !i.drawingLocked(key, state) {
		return ImageScreenRequest{}, false
	}
	request := ImageScreenRequest{
		Request: "screen-" + rand.Text(), Name: key.Name, Generation: state.Generation, Raster: state.Raster,
		Full: !(state.ScreenAccepted && state.ScreenGeneration == state.Generation && state.ScreenRaster == state.Raster),
		Cids: cids, Key: key, Sidecar: owner.SidecarName, Owner: owner.SidecarOwner,
	}
	state.ScreenRequest = request
	return request, true
}

// AnswerScreen ends the unanswered screen request of a region. An accepted answer makes the rows of the request the baseline of the next
// screen request of the same generation and raster. It returns an error when the region has no unanswered request with that identifier.
func (i *Images) AnswerScreen(key ImageKey, request ImageScreenRequest, accepted bool) error {
	i.mu.Lock()
	defer i.mu.Unlock()
	return i.answerScreenLocked(key, request, accepted)
}

// answerScreenLocked ends the unanswered screen request of a region and returns an error when it has none with that identifier. Call it
// while holding i.mu.
func (i *Images) answerScreenLocked(key ImageKey, request ImageScreenRequest, accepted bool) error {
	state := i.states[key]
	if state == nil || request.Request == "" || state.ScreenRequest.Request != request.Request {
		return fmt.Errorf("image %q of surface %q has no unanswered screen request %q", key.Name, key.Surface, request.Request)
	}
	state.ScreenRequest = ImageScreenRequest{}
	if accepted {
		state.ScreenAccepted, state.ScreenGeneration, state.ScreenRaster = true, request.Generation, request.Raster
	}
	return nil
}

// endScreenLocked ends the unanswered screen request of a region without an answer and drops its accepted screen, because no message
// can answer the request any more: the generation or the raster of the region changed, or the connection of its supplier ended. The
// next request of the region is then full (docs/spec/native-surfaces.md#copy-path-frames). Call it while holding i.mu.
func endScreenLocked(state *ImageRasterState) {
	state.ScreenRequest = ImageScreenRequest{}
	state.ScreenAccepted = false
}

// ImageTick is the answer to the frame request of a drawing region at a display frame of its window
// (docs/spec/native-surfaces.md#copy-path-frames). Sequence counts the ticks of the region from 1 for each attachment, and RefreshRate is
// the refresh rate of the screen that showed the window at that display frame.
type ImageTick struct {
	Name        string       `json:"name"`
	Generation  uint64       `json:"generation"`
	Sequence    uint64       `json:"sequence"`
	RefreshRate int          `json:"refreshRate"`
	Key         ImageKey     `json:"-"`
	Sidecar     string       `json:"-"`
	Owner       SidecarOwner `json:"-"`
}

// FramePurpose is the purpose of a frame request: a draw of the region, or a read that counts display frames
// (docs/spec/native-surfaces.md#copy-path-frames).
type FramePurpose string

const (
	FrameDraw FramePurpose = "draw"
	FrameRead FramePurpose = "read"
)

// WantFrame answers the frame request of sender for a region (docs/spec/native-surfaces.md#copy-path-frames). It returns the refusal
// reason, notAttached when sender does not own the attached region and stale when generation is not the current one, or "" for an
// accepted request. ask is true when the caller asks the native region for one display frame: the region waits for no display frame yet,
// and it is drawing or the request is a read. A request while one waits and a draw request for a region that is not drawing ask nothing.
func (i *Images) WantFrame(key ImageKey, sender string, generation uint64, purpose FramePurpose) (reason string, ask bool) {
	i.mu.Lock()
	defer i.mu.Unlock()
	state := i.states[key]
	owner := i.owners[key]
	if state == nil || owner == nil || owner.SidecarName != sender || i.handles[key] == nil {
		return "notAttached", false
	}
	if generation != state.Generation {
		return "stale", false
	}
	if purpose == FrameRead {
		state.FrameRead = true
	} else if !i.drawingLocked(key, state) {
		return "", false
	}
	if state.FrameWanted {
		return "", false
	}
	state.FrameWanted = true
	return "", true
}

// ImageFrame is the answer of the display frame of a frame request: the tick, or NoScreen for a read request of a window on no screen,
// which has no display frame (docs/spec/native-surfaces.md#copy-path-frames). Tick names the region and its supplier in both cases.
type ImageFrame struct {
	Tick     ImageTick
	NoScreen bool
}

// Body returns the image message of the answer to the supplier; window is the window identifier of the endpoint, which the refusal
// noScreen names.
func (f ImageFrame) Body(window string) map[string]any {
	if f.NoScreen {
		return map[string]any{"image": map[string]any{"want": map[string]any{
			"error": "noScreen", "name": f.Tick.Name, "generation": f.Tick.Generation, "purpose": string(FrameRead), "window": window,
		}}}
	}
	return map[string]any{"image": map[string]any{"tick": f.Tick}}
}

// FrameTick ends the frame requests of a region at the display frame that the native region reported, and returns the answer: the tick
// of the region when it is drawing or a read request waited, or the refusal noScreen of a waiting read request when refreshRate is nil.
// refreshRate is the refresh rate that the native region read, or nil for a window on no screen, which has no display frame and sends
// no tick.
func (i *Images) FrameTick(key ImageKey, refreshRate *int) (ImageFrame, bool) {
	i.mu.Lock()
	defer i.mu.Unlock()
	state := i.states[key]
	if state == nil {
		return ImageFrame{}, false
	}
	read := state.FrameRead
	state.FrameWanted = false
	state.FrameRead = false
	owner := i.owners[key]
	if owner == nil || !read && (refreshRate == nil || !i.drawingLocked(key, state)) {
		return ImageFrame{}, false
	}
	tick := ImageTick{Name: key.Name, Generation: state.Generation, Key: key, Sidecar: owner.SidecarName, Owner: owner.SidecarOwner}
	if refreshRate == nil {
		return ImageFrame{Tick: tick, NoScreen: true}, true
	}
	state.FrameSequence++
	tick.Sequence = state.FrameSequence
	tick.RefreshRate = *refreshRate
	return ImageFrame{Tick: tick}, true
}

// SetOnScreen records whether the window is neither occluded nor minimized.
func (i *Images) SetOnScreen(onScreen bool) {
	i.mu.Lock()
	defer i.mu.Unlock()
	if i.onScreen != onScreen {
		i.onScreen = onScreen
		i.changedLocked()
	}
}

// drawingLocked reports whether a region is drawing: it is attached and visible, its outer surface is visible and the window is neither
// occluded nor minimized. Call it while holding i.mu.
func (i *Images) drawingLocked(key ImageKey, state *ImageRasterState) bool {
	return i.shownLocked(key, state) && (i.onScreen || i.drawsCoveredLocked())
}

// shownLocked reports whether a region and its outer surface are shown, whatever the state of the window. Call it while
// holding i.mu.
func (i *Images) shownLocked(key ImageKey, state *ImageRasterState) bool {
	outer, known := i.surfaceVisible[key.Surface]
	return i.handles[key] != nil && state.Visible && (!known || outer)
}

// DrawingChanges returns the drawing state of each attached region whose state was not sent yet or changed since it was sent, sorted by
// surface and name. It does not record a state as sent: the caller records each state whose send succeeded with MarkDrawingSent, so a
// state whose send failed is returned again by the next call.
func (i *Images) DrawingChanges() []ImageDrawing {
	i.mu.Lock()
	defer i.mu.Unlock()
	changes := []ImageDrawing{}
	for key, state := range i.states {
		owner := i.owners[key]
		if owner == nil || i.handles[key] == nil {
			continue
		}
		drawing := i.drawingLocked(key, state)
		// A surface that reported no hiding is not hidden: it may not be placed yet, and its placement configures the region.
		outer, known := i.surfaceVisible[key.Surface]
		hidden := known && !outer
		if state.DrawingSent && state.Drawing == drawing && state.Hidden == hidden {
			continue
		}
		// A raster that changed while the region was hidden has no configuration yet, and no later step sends it when the
		// region is shown without a new layout.
		var configure *ImageConfigure
		if drawing && !state.Configured && state.Width > 0 {
			state.Configured = true
			// A configuration ends the error of an ended supplier connection, because the supplier draws the raster again.
			state.PresentationError = ""
			configure = &ImageConfigure{Name: key.Name, Generation: state.Generation, Raster: state.Raster,
				Width: state.Width, Height: state.Height, Scale: state.Scale, Sidecar: owner.SidecarName, Owner: owner.SidecarOwner}
		}
		changes = append(changes, ImageDrawing{Name: key.Name, Generation: state.Generation, Drawing: drawing, Hidden: hidden, Configure: configure, Key: key,
			Sidecar: owner.SidecarName, Owner: owner.SidecarOwner})
	}
	sort.Slice(changes, func(a, b int) bool {
		if changes[a].Key.Surface != changes[b].Key.Surface {
			return changes[a].Key.Surface < changes[b].Key.Surface
		}
		return changes[a].Key.Name < changes[b].Key.Name
	})
	return changes
}

// MarkDrawingSent records the drawing state of change as sent to the supplier of its region. A change of an earlier generation records
// nothing, because the drawing state names the generation and the new generation is sent again.
func (i *Images) MarkDrawingSent(change ImageDrawing) {
	i.mu.Lock()
	defer i.mu.Unlock()
	state := i.states[change.Key]
	if state == nil || state.Generation != change.Generation {
		return
	}
	state.Drawing, state.Hidden, state.DrawingSent = change.Drawing, change.Hidden, true
}

func NewImages() *Images {
	return &Images{
		handles:         map[ImageKey]unsafe.Pointer{},
		owners:          map[ImageKey]*ImageOwner{},
		states:          map[ImageKey]*ImageRasterState{},
		generations:     map[string]uint64{},
		surfaceVisible:  map[string]bool{},
		onScreen:        true,
		detachedRasters: map[ImageKey][2]uint64{},
		changed:         make(chan struct{}),
	}
}

// changedLocked announces a state change to the waiters for picture display. Call it while holding i.mu.
func (i *Images) changedLocked() {
	close(i.changed)
	i.changed = make(chan struct{})
}

// BeginGeneration creates a generation that distinguishes frames from earlier ones when a new surface document starts. It also moves the picture
// regions that remain on the surface to the new generation and clears their configuration, so a frame of an earlier generation that was pending before the region closed is rejected.
func (i *Images) BeginGeneration(surface string) uint64 {
	i.mu.Lock()
	defer i.mu.Unlock()
	generation := imageGenerations.next()
	i.generations[surface] = generation
	i.forgetDetachedRastersLocked(surface)
	for key, state := range i.states {
		if key.Surface == surface {
			state.Generation = generation
			state.Configured = false
			// The drawing state names the generation, so the new generation is sent again.
			state.DrawingSent = false
			state.PresentationError = ""
			// A new document of the surface opens its supplier sessions again, so its rasters are required again.
			state.SupplierEnded = false
			state.LastSequence = 0
			state.PresentedRaster = 0
			state.PresentedSequence = 0
			endScreenLocked(state)
		}
	}
	i.changedLocked()
	return generation
}

// EndGeneration ends the current generation of a removed surface. The number is not reused.
func (i *Images) EndGeneration(surface string) {
	i.mu.Lock()
	defer i.mu.Unlock()
	delete(i.generations, surface)
	i.forgetDetachedRastersLocked(surface)
	hasState := false
	for key := range i.states {
		if key.Surface == surface {
			hasState = true
			break
		}
	}
	if hasState {
		i.surfaceVisible[surface] = false
	} else {
		delete(i.surfaceVisible, surface)
	}
	i.changedLocked()
}

// SetSurfaceVisible records the visibility of the outer SurfaceHost and reports whether it changed. A change makes the drawing state of
// each region of the surface differ from the state that its supplier holds, so the caller sends the drawing states
// (docs/spec/native-surfaces.md#image-regions).
func (i *Images) SetSurfaceVisible(surface string, visible bool) bool {
	i.mu.Lock()
	defer i.mu.Unlock()
	if held, ok := i.surfaceVisible[surface]; ok && held == visible {
		return false
	}
	i.surfaceVisible[surface] = visible
	if visible {
		for key, state := range i.states {
			if key.Surface != surface {
				continue
			}
			// Hiding a surface releases the native pixels, so when it is shown again a new raster is set even for the same size. A frame that belongs to
			// a raster of the hidden period is not received afterward.
			state.Raster++
			state.Configured = false
			state.LastSequence = 0
			state.PresentedSequence = 0
			state.PresentationError = ""
			endScreenLocked(state)
		}
	}
	i.changedLocked()
	return true
}

// Reserve takes a name. It returns an error when owner names no supplier sidecar or no window that receives its messages, because
// a region without a supplier would send its drawing state and configurations to no one.
func (i *Images) Reserve(key ImageKey, owner *ImageOwner) error {
	i.mu.Lock()
	defer i.mu.Unlock()
	if owner == nil || owner.SidecarName == "" || owner.SidecarOwner == nil {
		return fmt.Errorf("image %q: reserve requires a sidecar", key.Name)
	}
	if _, ok := i.handles[key]; ok {
		return fmt.Errorf("image %q is already attached", key.Name)
	}
	i.handles[key] = nil
	i.owners[key] = owner
	generation := i.generations[key.Surface]
	if generation == 0 {
		generation = imageGenerations.next()
		i.generations[key.Surface] = generation
	}
	state := &ImageRasterState{Generation: generation}
	if detached, ok := i.detachedRasters[key]; ok && detached[0] == generation {
		state.Raster = detached[1]
	}
	delete(i.detachedRasters, key)
	i.states[key] = state
	i.changedLocked()
	return nil
}

// forgetDetachedRastersLocked clears the raster records of regions detached from a surface. When the generation of the surface changes, the new generation is larger than the earlier
// configuration, so the records are not needed.
func (i *Images) forgetDetachedRastersLocked(surface string) {
	for key := range i.detachedRasters {
		if key.Surface == surface {
			delete(i.detachedRasters, key)
		}
	}
}

// detachLocked clears the name of a region and keeps the raster from which counting continues when it is attached again in the same generation.
func (i *Images) detachLocked(key ImageKey) {
	if state := i.states[key]; state != nil {
		i.detachedRasters[key] = [2]uint64{state.Generation, state.Raster}
	}
	delete(i.handles, key)
	delete(i.owners, key)
	delete(i.states, key)
}

// Set writes the created image region to the reserved name.
func (i *Images) Set(key ImageKey, handle unsafe.Pointer) bool {
	i.mu.Lock()
	defer i.mu.Unlock()
	if _, ok := i.handles[key]; !ok {
		return false
	}
	i.handles[key] = handle
	return true
}

// Get returns the created image region.
func (i *Images) Get(key ImageKey) (unsafe.Pointer, error) {
	i.mu.Lock()
	defer i.mu.Unlock()
	if handle := i.handles[key]; handle != nil {
		return handle, nil
	}
	return nil, fmt.Errorf("image %q is not attached", key.Name)
}

// GetOwner returns the sidecar owner that registered the image region.
func (i *Images) GetOwner(key ImageKey) (*ImageOwner, error) {
	i.mu.Lock()
	defer i.mu.Unlock()
	if owner, ok := i.owners[key]; ok && i.handles[key] != nil {
		return owner, nil
	}
	return nil, fmt.Errorf("image %q is not attached", key.Name)
}

// detachments captures the supplier and generation of every registered image before a page reload advances the surface generation.
func (i *Images) detachments(surface string) []imageDetachTarget {
	i.mu.Lock()
	defer i.mu.Unlock()
	var targets []imageDetachTarget
	for key, owner := range i.owners {
		if key.Surface != surface || owner == nil {
			continue
		}
		state := i.states[key]
		if state == nil {
			continue
		}
		targets = append(targets, imageDetachTarget{Surface: key.Surface, Name: key.Name,
			Sidecar: owner.SidecarName, Generation: state.Generation, Owner: owner.SidecarOwner})
	}
	sort.Slice(targets, func(left, right int) bool { return targets[left].Name < targets[right].Name })
	return targets
}

// Remove removes the name and returns its image region.
func (i *Images) Remove(key ImageKey) (unsafe.Pointer, error) {
	i.mu.Lock()
	defer i.mu.Unlock()
	handle, ok := i.handles[key]
	if !ok {
		return nil, fmt.Errorf("image %q is not attached", key.Name)
	}
	i.detachLocked(key)
	i.changedLocked()
	return handle, nil
}

// RemoveSurface removes all names of a surface and returns the created image regions.
func (i *Images) RemoveSurface(surface string) []unsafe.Pointer {
	i.mu.Lock()
	defer i.mu.Unlock()
	var removed []unsafe.Pointer
	for key, handle := range i.handles {
		if key.Surface != surface {
			continue
		}
		i.detachLocked(key)
		if handle != nil {
			removed = append(removed, handle)
		}
	}
	// The cleanup of document regions does not change the visibility of the outer SurfaceHost.
	// EndGeneration removes that state when the surface itself closes.
	i.changedLocked()
	return removed
}

// Visible returns the handles of the pictures for which both the region itself and the outer surface are visible.
func (i *Images) Visible() map[ImageKey]unsafe.Pointer {
	return i.visibleWhere(func(key ImageKey) bool { return true })
}

// VisibleForSidecar returns only the visible pictures that the sidecar draws. It is used to send the configure of a persistent sidecar again
// when the connection to that sidecar is made again (V5-106).
func (i *Images) VisibleForSidecar(sidecar string) map[ImageKey]unsafe.Pointer {
	return i.visibleWhere(func(key ImageKey) bool {
		owner := i.owners[key]
		return owner != nil && owner.SidecarName == sidecar
	})
}

func (i *Images) visibleWhere(belongs func(ImageKey) bool) map[ImageKey]unsafe.Pointer {
	i.mu.Lock()
	defer i.mu.Unlock()
	visible := map[ImageKey]unsafe.Pointer{}
	for key, state := range i.states {
		if !belongs(key) {
			continue
		}
		if i.shownLocked(key, state) {
			visible[key] = i.handles[key]
		}
	}
	return visible
}

// InvalidateSidecar marks that the connection to that sidecar was lost (V5-106). The connection that
// received the configure is dead, so the configure state ends with it; the configure must be sent again even for the same size
// so that the service of the new connection builds the picture state. The display order record is also cleared; the frames of the new connection
// count their sequence numbers from the start.
func (i *Images) InvalidateSidecar(sidecar string) int {
	i.mu.Lock()
	defer i.mu.Unlock()
	invalidated := 0
	for key, owner := range i.owners {
		if owner == nil || owner.SidecarName != sidecar {
			continue
		}
		state, ok := i.states[key]
		if !ok {
			continue
		}
		// A region that the presentation wait waits for has no supplier to present its raster until the new connection
		// configures it again, so the wait ends with the failure that names the supplier. A new configuration clears it.
		waited := i.drawingLocked(key, state) && state.Raster > 0
		state.Configured = false
		state.LastSequence = 0
		state.PresentedSequence = 0
		state.PresentationError = ""
		if waited {
			state.PresentationError = fmt.Sprintf("the supplier %s of the image region %s/%s ended", sidecar, key.Surface, key.Name)
		}
		// The service of the new connection has no drawing state and no screen of the region either.
		state.DrawingSent = false
		state.SupplierEnded = true
		endScreenLocked(state)
		invalidated++
	}
	if invalidated > 0 {
		// No raster of the ended connection comes, so the end ends the raster wait of its regions.
		i.endedSidecars++
		i.endedSidecar = sidecar
		i.changedLocked()
	}
	return invalidated
}

// ConfigureRaster raises the revision when the applied native raster changed and returns the configuration to send.
func (i *Images) ConfigureRaster(key ImageKey, width, height int, scale float64, visible bool) (*ImageConfigure, error) {
	i.mu.Lock()
	defer i.mu.Unlock()
	state, ok := i.states[key]
	owner := i.owners[key]
	if !ok || owner == nil || i.handles[key] == nil {
		return nil, fmt.Errorf("image %q is not attached", key.Name)
	}
	if state.Visible != visible {
		state.Visible = visible
		i.changedLocked()
	}
	if width < 1 || height < 1 || scale <= 0 || math.IsNaN(scale) || math.IsInf(scale, 0) {
		return nil, nil
	}
	if state.Width != width || state.Height != height || math.Abs(state.Scale-scale) > 0.000001 {
		state.Raster++
		state.Width, state.Height, state.Scale = width, height, scale
		state.LastSequence = 0
		state.Configured = false
		state.PresentedSequence = 0
		state.PresentationError = ""
		endScreenLocked(state)
		i.changedLocked()
	}
	// A supplier opens the session of a region at the size of its configuration, so a region of a window that is off
	// screen is configured as well; its drawing state keeps the supplier from drawing.
	if !i.shownLocked(key, state) || state.Configured {
		return nil, nil
	}
	state.Configured = true
	// A configuration ends the error of an ended supplier connection, because the supplier draws the raster again.
	state.PresentationError = ""
	return &ImageConfigure{Name: key.Name, Generation: state.Generation, Raster: state.Raster,
		Width: width, Height: height, Scale: scale, Sidecar: owner.SidecarName, Owner: owner.SidecarOwner}, nil
}

// SetVisible records the visibility of a region even in a layout of size 0 that has no raster.
func (i *Images) SetVisible(key ImageKey, visible bool) error {
	i.mu.Lock()
	defer i.mu.Unlock()
	state, ok := i.states[key]
	if !ok || i.handles[key] == nil {
		return fmt.Errorf("image %q is not attached", key.Name)
	}
	if state.Visible != visible {
		state.Visible = visible
		i.changedLocked()
	}
	return nil
}

// FrameStatus checks that a frame is the current raster also immediately before it is displayed on the main thread.
func (i *Images) FrameStatus(key ImageKey, generation, raster uint64, sequence int) string {
	i.mu.Lock()
	defer i.mu.Unlock()
	state := i.states[key]
	if state == nil || i.handles[key] == nil || state.Generation != generation {
		return "notAttached"
	}
	if !state.Configured || state.Raster != raster || state.LastSequence != sequence {
		return "stale"
	}
	return ""
}

// MarkPresented records a successful native presentation that advances the current raster's presented sequence. A newer
// frame can be accepted after FrameStatus allows an earlier native presentation to start but before its acknowledgement arrives.
func (i *Images) MarkPresented(key ImageKey, generation, raster uint64, sequence int) bool {
	i.mu.Lock()
	defer i.mu.Unlock()
	state := i.states[key]
	if state == nil || state.Generation != generation || state.Raster != raster || sequence <= 0 ||
		sequence <= state.PresentedSequence || sequence > state.LastSequence {
		return false
	}
	state.PresentedRaster = raster
	state.PresentedSequence = sequence
	state.PresentedFrames++
	// A presented frame shows that the supplier draws the region, so the waits require its rasters again.
	state.SupplierEnded = false
	if sequence == state.LastSequence {
		state.PresentationError = ""
	}
	i.changedLocked()
	return true
}

// PresentedFrame is the identity of the frame that an image region presents: the generation, the raster and the sequence of the frame.
type PresentedFrame struct {
	Generation uint64 `json:"generation"`
	Raster     uint64 `json:"raster"`
	Sequence   int    `json:"sequence"`
}

// PresentedFrame returns the frame that the image region presents. It returns false while no frame of the current raster is presented. A
// newer frame that the host accepted and has not presented yet does not change it.
func (i *Images) PresentedFrame(key ImageKey) (PresentedFrame, bool) {
	i.mu.Lock()
	defer i.mu.Unlock()
	state := i.states[key]
	if state == nil || state.PresentedSequence <= 0 || state.PresentedRaster != state.Raster {
		return PresentedFrame{}, false
	}
	return PresentedFrame{Generation: state.Generation, Raster: state.PresentedRaster, Sequence: state.PresentedSequence}, true
}

// PresentedFrames returns the number of frames of the image region that the host marked presented since the region was attached.
func (i *Images) PresentedFrames(key ImageKey) (uint64, error) {
	i.mu.Lock()
	defer i.mu.Unlock()
	state := i.states[key]
	if state == nil {
		return 0, fmt.Errorf("image %q is not attached", key.Name)
	}
	return state.PresentedFrames, nil
}

// SentDrawing returns the drawing state last sent to the supplier of a region; it is false before one was sent.
func (i *Images) SentDrawing(key ImageKey) bool {
	i.mu.Lock()
	defer i.mu.Unlock()
	state := i.states[key]
	return state != nil && state.DrawingSent && state.Drawing
}

// MarkPresentationFailed records the native presentation failure of the current raster.
func (i *Images) MarkPresentationFailed(key ImageKey, generation, raster uint64, sequence int, reason string) {
	i.mu.Lock()
	defer i.mu.Unlock()
	state := i.states[key]
	if state == nil || state.Generation != generation || state.Raster != raster || state.LastSequence != sequence {
		return
	}
	state.Configured = false
	state.PresentationError = reason
	i.changedLocked()
}

// awaitedLocked reports whether a wait requires a raster of the region: it is drawing, has a raster, and its supplier did not end
// since the region last presented a frame. Call it while holding i.mu.
func (i *Images) awaitedLocked(key ImageKey, state *ImageRasterState) bool {
	return i.drawingLocked(key, state) && state.Raster > 0 && !state.SupplierEnded
}

// currentPresentedLocked returns whether every awaited image region displayed the current raster.
func (i *Images) currentPresentedLocked() bool {
	for key, state := range i.states {
		if i.awaitedLocked(key, state) &&
			(state.LastSequence <= 0 || state.PresentedRaster != state.Raster || state.PresentedSequence != state.LastSequence) {
			return false
		}
	}
	return true
}

// currentRasterSnapshotInstalledLocked reports whether every awaited image region has a presented frame of its current raster.
func (i *Images) currentRasterSnapshotInstalledLocked() bool {
	for key, state := range i.states {
		if i.awaitedLocked(key, state) &&
			(state.PresentedRaster != state.Raster || state.PresentedSequence <= 0) {
			return false
		}
	}
	return true
}

// PendingRasters lists, in the order of surface and name, the image regions that the display barrier still waits for. When the barrier times out, the list is attached to the error to report
// which regions were not displayed. It is "none" when no region is waited for.
func (i *Images) PendingRasters() string {
	i.mu.Lock()
	defer i.mu.Unlock()
	var pending []string
	for key, state := range i.states {
		_, known := i.surfaceVisible[key.Surface]
		if !i.awaitedLocked(key, state) {
			continue
		}
		if state.LastSequence > 0 && state.PresentedRaster == state.Raster && state.PresentedSequence == state.LastSequence {
			continue
		}
		surface := "unknown"
		if known {
			surface = "visible"
		}
		pending = append(pending, fmt.Sprintf("%s/%s generation %d raster %d sequence %d presented %d/%d surface %s",
			key.Surface, key.Name, state.Generation, state.Raster, state.LastSequence,
			state.PresentedRaster, state.PresentedSequence, surface))
	}
	if len(pending) == 0 {
		return "none"
	}
	sort.Strings(pending)
	return strings.Join(pending, ", ")
}

// CurrentPresented returns whether every visible image region displayed the current raster.
func (i *Images) CurrentPresented() bool {
	i.mu.Lock()
	defer i.mu.Unlock()
	return i.currentPresentedLocked()
}

// WaitCurrentError waits until every drawing image region displays its current raster and returns nil, or returns the exact
// failure of a region. It has no time limit: the presentation of the raster ends it, and so do the removal of its region or
// surface, a presentation failure, the end of the supplier connection of a region (InvalidateSidecar) and the close of stop, the
// end of the request that waits (errRasterWaitStopped). The end of a layout transaction does not end it.
func (i *Images) WaitCurrentError(stop <-chan struct{}) error {
	return i.waitCurrentObserved(stop, nil)
}

// WaitLayoutRasters waits for the completion boundary selected by the layout request. It ends only by the presentation of each
// required raster, by the removal of its region or surface, by a presentation failure, by the end of the connection of a
// sidecar of the regions, or by the end of the layout transaction, which a cancel of its ticket or of its window ends
// (errLayoutWaitEnded) (docs/spec/native-surfaces.md#layout-transaction).
func (i *Images) WaitLayoutRasters(settled bool) error {
	return i.waitLayoutRastersObserved(settled, nil)
}

// errRasterWaitStopped is the end of a raster wait by the end of the request that waits.
var errRasterWaitStopped = errors.New("the request of the raster wait ended")

func (i *Images) waitLayoutRastersObserved(settled bool, waiting func()) error {
	if settled {
		return i.waitObserved(true, nil, waiting, i.currentPresentedLocked)
	}
	return i.waitObserved(true, nil, waiting, i.currentRasterSnapshotInstalledLocked)
}

// waitCurrentObserved calls waiting under the owner lock each time the wait finds the presentation incomplete and blocks, so a test
// orders the next frame after the wait checked the state and knows when the wait checked the frame that it gave.
func (i *Images) waitCurrentObserved(stop <-chan struct{}, waiting func()) error {
	return i.waitObserved(false, stop, waiting, i.currentPresentedLocked)
}

// waitObserved is the wait of the image regions: it ends at complete, at a presentation failure, at the end of the connection
// of a sidecar of the regions, at the end of the layout transaction when layout is set, and at the close of stop. waiting runs
// at each check that finds a raster pending, under the owner lock, so tests can order the next change before the wakeup.
func (i *Images) waitObserved(layout bool, stop <-chan struct{}, waiting func(), complete func() bool) error {
	i.mu.Lock()
	ends, sidecars := i.waitEnds, i.endedSidecars
	i.mu.Unlock()
	for {
		select {
		case <-stop:
			return errRasterWaitStopped
		default:
		}
		i.mu.Lock()
		if i.endedSidecars != sidecars {
			err := fmt.Errorf("the sidecar %s of an image region ended", i.endedSidecar)
			i.mu.Unlock()
			return err
		}
		if layout && i.waitEnds != ends {
			i.mu.Unlock()
			return errLayoutWaitEnded
		}
		for _, state := range i.states {
			if state.PresentationError != "" {
				err := errors.New(state.PresentationError)
				i.mu.Unlock()
				return err
			}
		}
		if complete() {
			i.mu.Unlock()
			return nil
		}
		changed := i.changed
		if waiting != nil {
			waiting()
		}
		i.mu.Unlock()
		select {
		case <-changed:
		case <-stop:
			return errRasterWaitStopped
		}
	}
}

// RetryConfigure makes the same raster be sent again in the next complete layout when sending the configuration failed.
func (i *Images) RetryConfigure(key ImageKey, generation, raster uint64) {
	i.mu.Lock()
	defer i.mu.Unlock()
	if state := i.states[key]; state != nil && state.Generation == generation && state.Raster == raster {
		state.Configured = false
		state.PresentationError = ""
	}
}

// AuthorizeFrame checks that the envelope belongs to the current provider and the exact raster and that its sequence number increases.
func (i *Images) AuthorizeFrame(key ImageKey, sender string, generation, raster uint64,
	width, height int, scale float64, sequence int) string {
	i.mu.Lock()
	defer i.mu.Unlock()
	state, ok := i.states[key]
	owner := i.owners[key]
	if !ok || owner == nil || i.handles[key] == nil || owner.SidecarName != sender || state.Generation != generation {
		return "notAttached"
	}
	if !state.Configured || state.Raster != raster || state.Width != width || state.Height != height ||
		math.Abs(state.Scale-scale) > 0.000001 || sequence <= 0 || sequence <= state.LastSequence {
		return "stale"
	}
	state.LastSequence = sequence
	return ""
}

// Names are the keys of the created image regions by address.
func (i *Images) Names() map[uint64]ImageKey {
	i.mu.Lock()
	defer i.mu.Unlock()
	names := map[uint64]ImageKey{}
	for key, handle := range i.handles {
		if handle != nil {
			names[uint64(uintptr(handle))] = key
		}
	}
	return names
}

// Entries are the created image regions by key.
func (i *Images) Entries() map[ImageKey]unsafe.Pointer {
	i.mu.Lock()
	defer i.mu.Unlock()
	entries := map[ImageKey]unsafe.Pointer{}
	for key, handle := range i.handles {
		if handle != nil {
			entries[key] = handle
		}
	}
	return entries
}

// All are the created image regions.
func (i *Images) All() []unsafe.Pointer {
	i.mu.Lock()
	defer i.mu.Unlock()
	var all []unsafe.Pointer
	for _, handle := range i.handles {
		if handle != nil {
			all = append(all, handle)
		}
	}
	return all
}

// CloseSurface closes all image regions of a surface. Call it on the UI thread.
func (i *Images) CloseSurface(surface string, close func(unsafe.Pointer)) {
	handles := i.RemoveSurface(surface)
	for _, handle := range handles {
		close(handle)
	}
}

// Decision is the result of the decision on an image envelope.
type Decision interface{}

// NotImage means that the body has no image field.
type NotImage struct{}

// Reply is the error reply to send to the sidecar. Reason, Generation, Raster and Sequence belong to the rejected frame.
type Reply struct {
	Name               string
	JSON               map[string]interface{}
	Reason             string
	Generation, Raster uint64
	Sequence           int
}

// Present is the image to display.
type Present struct {
	ID         uint32
	Nonce      [16]byte
	Width      int
	Height     int
	Scale      float64
	Name       string
	Generation uint64
	Raster     uint64
	Sequence   int
}

// ScreenMessage is the screen message of a supplier that answers a screen request (docs/spec/native-surfaces.md#copy-path-frames).
// Its rows are not interpreted by the host.
type ScreenMessage struct {
	Request    string
	Name       string
	Generation uint64
	Raster     uint64
}

// MalformedScreen is a screen message with a missing or mistyped member. Member is the dotted path of the first such member, Text
// names it, and Echo holds each of request, name, generation and raster that the message holds with a valid type.
type MalformedScreen struct {
	Member string
	Text   string
	Echo   map[string]interface{}
}

// Error returns the text that names the malformed member.
func (m *MalformedScreen) Error() string {
	return m.Text
}

func imageReply(reason, name string, generation, raster uint64, sequence int) *Reply {
	return &Reply{Name: name, JSON: map[string]interface{}{
		"image": map[string]interface{}{
			"error": reason, "name": name, "generation": generation, "raster": raster, "sequence": sequence,
		},
	}, Reason: reason, Generation: generation, Raster: raster, Sequence: sequence}
}

// Decide validates the image message of a body and returns the decision. It reads the members of the member image that
// ReadMessageBody decoded and decodes no part of the body again.
// It returns NotImage when it is not an image envelope.
// It returns Reply when it is not valid.
// It returns Present when it is valid and registered.
func Decide(body MessageBody, sender, surface string, images *Images) Decision {
	if body.imageMalformed {
		LogError("image frame", fmt.Sprintf("surface=%s sender=%s malformed image envelope: %s", surface, sender, body.imageRaw))
		return &NotImage{}
	}
	image := body.image
	if image == nil {
		return &NotImage{}
	}
	if image.Want != nil {
		return decideWant(image.Want)
	}
	if image.Screen != nil {
		return decideScreen(image.Screen)
	}

	var envelope struct {
		Name  string
		Token struct {
			Kind  string `json:"kind"`
			ID    uint32 `json:"id"`
			Nonce string `json:"nonce"`
		}
		Width      int
		Height     int
		Scale      float64
		Format     string
		Generation uint64
		Raster     uint64
		Sequence   int
	}
	for _, member := range []struct {
		raw    json.RawMessage
		target any
	}{
		{image.Name, &envelope.Name}, {image.Token, &envelope.Token}, {image.Width, &envelope.Width}, {image.Height, &envelope.Height},
		{image.Scale, &envelope.Scale}, {image.Format, &envelope.Format}, {image.Generation, &envelope.Generation},
		{image.Raster, &envelope.Raster}, {image.Sequence, &envelope.Sequence},
	} {
		if member.raw == nil {
			continue
		}
		if err := json.Unmarshal(member.raw, member.target); err != nil {
			LogError("image frame", fmt.Sprintf("surface=%s sender=%s malformed image envelope: %s", surface, sender, body.imageRaw))
			return &NotImage{}
		}
	}

	// Validates the format and the token kind
	if envelope.Format != "bgra8" || envelope.Token.Kind != "iosurface-global" {
		return imageReply("unsupported", envelope.Name, envelope.Generation, envelope.Raster, envelope.Sequence)
	}

	// Decodes the nonce from base64 and converts it to a [16]byte array
	decodedNonce, err := base64.StdEncoding.DecodeString(envelope.Token.Nonce)
	if err != nil {
		// The refusal record states only the reply, so the cause of the refusal is written here.
		LogError("image frame", fmt.Sprintf("surface=%s name=%s sender=%s generation=%d raster=%d sequence=%d nonce is not base64: %v", surface, envelope.Name, sender, envelope.Generation, envelope.Raster, envelope.Sequence, err))
		return imageReply("unsupported", envelope.Name, envelope.Generation, envelope.Raster, envelope.Sequence)
	}

	// The decoded nonce must be exactly 16 bytes
	if len(decodedNonce) != 16 {
		LogError("image frame", fmt.Sprintf("surface=%s name=%s sender=%s generation=%d raster=%d sequence=%d nonce is %d bytes, want 16", surface, envelope.Name, sender, envelope.Generation, envelope.Raster, envelope.Sequence, len(decodedNonce)))
		return imageReply("unsupported", envelope.Name, envelope.Generation, envelope.Raster, envelope.Sequence)
	}

	// Converts the nonce to a [16]byte array
	var nonce [16]byte
	copy(nonce[:], decodedNonce)

	key := ImageKey{Surface: surface, Name: envelope.Name}
	if reason := images.AuthorizeFrame(key, sender, envelope.Generation, envelope.Raster,
		envelope.Width, envelope.Height, envelope.Scale, envelope.Sequence); reason != "" {
		return imageReply(reason, envelope.Name, envelope.Generation, envelope.Raster, envelope.Sequence)
	}
	return &Present{
		ID: envelope.Token.ID, Nonce: nonce, Width: envelope.Width, Height: envelope.Height,
		Scale: envelope.Scale, Name: envelope.Name, Generation: envelope.Generation,
		Raster: envelope.Raster, Sequence: envelope.Sequence,
	}
}

// decideScreen validates the members of a screen message in their order: request, name, generation, raster and rows. It returns the
// first missing or mistyped member as a MalformedScreen, and otherwise the ScreenMessage. A null value is mistyped
// (docs/spec/native-surfaces.md#copy-path-frames); json.Unmarshal leaves its target unchanged for null, so each read refuses null first.
func decideScreen(raw json.RawMessage) Decision {
	var members map[string]json.RawMessage
	if string(raw) == "null" || json.Unmarshal(raw, &members) != nil {
		return &MalformedScreen{Member: "screen", Text: "image screen message has no screen object", Echo: map[string]interface{}{}}
	}
	echo := map[string]interface{}{}
	var request, name string
	var generation, raster uint64
	var failure *MalformedScreen
	fail := func(member, text string) {
		if failure == nil {
			failure = &MalformedScreen{Member: member, Text: text, Echo: echo}
		}
	}
	if screenMember(members, "request", &request) && request != "" {
		echo["request"] = request
	} else {
		fail("request", "image screen message has no request")
	}
	if screenMember(members, "name", &name) && name != "" {
		echo["name"] = name
	} else {
		fail("name", "image screen message has no image name")
	}
	if screenMember(members, "generation", &generation) {
		echo["generation"] = generation
	} else {
		fail("generation", "image screen message has no valid generation")
	}
	if screenMember(members, "raster", &raster) {
		echo["raster"] = raster
	} else {
		fail("raster", "image screen message has no valid raster")
	}
	rows, ok := members["rows"]
	var rowList []json.RawMessage
	if !ok || string(rows) == "null" || json.Unmarshal(rows, &rowList) != nil {
		fail("rows", "image screen message has no rows array")
	}
	for index, row := range rowList {
		var fields map[string]json.RawMessage
		var number uint64
		if string(row) == "null" || json.Unmarshal(row, &fields) != nil || !screenRowNumber(fields, &number) {
			fail(fmt.Sprintf("rows.%d.row", index), fmt.Sprintf("image screen message row %d has no valid row number", index))
		}
		if _, has := fields["cells"]; !has {
			fail(fmt.Sprintf("rows.%d.cells", index), fmt.Sprintf("image screen message row %d has no cells", index))
		}
	}
	if failure != nil {
		return failure
	}
	return &ScreenMessage{Request: request, Name: name, Generation: generation, Raster: raster}
}

// FrameRequest is the frame request of a supplier for a region (docs/spec/native-surfaces.md#copy-path-frames).
type FrameRequest struct {
	Name       string
	Generation uint64
	Purpose    FramePurpose
}

// MalformedFrameRequest is a frame request with a missing or mistyped member. Member names it, Text states it, and Name is the name of
// the region, or "" when the request has no valid name.
type MalformedFrameRequest struct {
	Member string
	Text   string
	Name   string
}

// Error returns the text that names the malformed member.
func (m *MalformedFrameRequest) Error() string {
	return m.Text
}

// decideWant validates the members of a frame request in their order: name, generation and purpose, which is draw when it is absent. A
// null value is mistyped.
func decideWant(raw json.RawMessage) Decision {
	var members map[string]json.RawMessage
	if string(raw) == "null" || json.Unmarshal(raw, &members) != nil {
		return &MalformedFrameRequest{Member: "want", Text: "image frame request has no want object"}
	}
	var name string
	if !screenMember(members, "name", &name) || name == "" {
		return &MalformedFrameRequest{Member: "name", Text: "image frame request has no image name"}
	}
	var generation uint64
	if !screenMember(members, "generation", &generation) {
		return &MalformedFrameRequest{Member: "generation", Text: "image frame request has no valid generation", Name: name}
	}
	purpose := FrameDraw
	if _, present := members["purpose"]; present {
		var value string
		if !screenMember(members, "purpose", &value) || value != string(FrameDraw) && value != string(FrameRead) {
			return &MalformedFrameRequest{Member: "purpose", Text: "image frame request has a purpose that is neither draw nor read", Name: name}
		}
		purpose = FramePurpose(value)
	}
	return &FrameRequest{Name: name, Generation: generation, Purpose: purpose}
}

// screenMember reads a member of a screen message into target and reports whether it is present, not null and of the type of target.
func screenMember(members map[string]json.RawMessage, member string, target interface{}) bool {
	raw, ok := members[member]
	return ok && string(raw) != "null" && json.Unmarshal(raw, target) == nil
}

// screenRowNumber reads the row number of a row of a screen message and reports whether it is a non-negative integer.
func screenRowNumber(fields map[string]json.RawMessage, number *uint64) bool {
	return screenMember(fields, "row", number)
}

// screenEcho returns the members that identify a screen request, as the host answers them.
func screenEcho(request, name string, generation, raster uint64) map[string]interface{} {
	return map[string]interface{}{"request": request, "name": name, "generation": generation, "raster": raster}
}

// ReceiveScreen answers the screen message of sender for a drawing region. It accepts the message when sender owns the region, its
// generation and raster are current, and its request is the unanswered request of the region, and it returns "" then. Otherwise it returns
// the refusal reason: notAttached when the region has no owner that sender is, and stale when the generation, the raster or the request is
// out of date. A refused message leaves the unanswered request unanswered.
func (i *Images) ReceiveScreen(key ImageKey, sender string, answer ImageScreenRequest) string {
	i.mu.Lock()
	defer i.mu.Unlock()
	state := i.states[key]
	owner := i.owners[key]
	if state == nil || owner == nil || owner.SidecarName != sender || i.handles[key] == nil {
		return "notAttached"
	}
	if answer.Generation != state.Generation || answer.Raster != state.Raster || state.ScreenRequest.Request == "" ||
		answer.Request != state.ScreenRequest.Request {
		return "stale"
	}
	if err := i.answerScreenLocked(key, answer, true); err != nil {
		return "stale"
	}
	return ""
}

// LeasedReply is the answer to a frame that a region in the lease mode presents: the host holds its IOSurface.
func LeasedReply(name string, generation, raster uint64, sequence int) map[string]interface{} {
	return map[string]interface{}{"image": map[string]interface{}{
		"leased": map[string]interface{}{"name": name, "generation": generation, "raster": raster, "sequence": sequence},
	}}
}

// ReleasedReply is the message to the supplier of a region in the lease mode when the region stops holding the surface
// of the frame (docs/spec/sidecars.md#image-envelope).
func ReleasedReply(name string, generation, raster uint64, sequence int) map[string]interface{} {
	return map[string]interface{}{"image": map[string]interface{}{
		"released": map[string]interface{}{"name": name, "generation": generation, "raster": raster, "sequence": sequence},
	}}
}

// AfterPresent builds the reply after the image is displayed.
// It returns a consumed reply when ok is true, and returns reason as an error when it is false.
func AfterPresent(ok bool, reason, name string, generation, raster uint64, sequence int) map[string]interface{} {
	if ok {
		return map[string]interface{}{
			"image": map[string]interface{}{
				"consumed": map[string]interface{}{
					"name": name, "generation": generation, "raster": raster, "sequence": sequence,
				},
			},
		}
	}
	return map[string]interface{}{
		"image": map[string]interface{}{
			"error": reason, "name": name, "generation": generation, "raster": raster, "sequence": sequence,
		},
	}
}

// presentationReason converts a main thread presentation failure to a reply reason. A frame that was detached before the main thread task
// (notAttached) is an invalidated frame and not a presentation failure, so it is stale. An unknown reason is presentFailed.
func presentationReason(reason string) string {
	if strings.HasPrefix(reason, "staleRaster") {
		return "stale"
	}
	switch reason {
	case "stale", "notAttached":
		return "stale"
	case "notFound", "forbidden", "size", "scale", "unsupported":
		return reason
	default:
		return "presentFailed"
	}
}

// PresentationOutcome converts the detail detail of a frame that could not be displayed to a reply reason and a log line. A replaced frame (stale,
// notAttached, staleRaster ...) is an invalidated frame and not a presentation failure, so invalidated is true. current is the current frame state of the failed
// region and is kept only in the line of a presentation failure.
func PresentationOutcome(surface, name string, generation, raster uint64, sequence int, token uint32, detail, current string) (reason string, invalidated bool, entry Entry) {
	frame := fmt.Sprintf("surface=%s name=%s generation=%d raster=%d sequence=%d token=%d reason=%s",
		surface, name, generation, raster, sequence, token, detail)
	reason = presentationReason(detail)
	if reason == "stale" {
		return reason, true, Entry{"info", "host", "image present", "frame invalidated before native presentation: " + frame}
	}
	return reason, false, Entry{"error", "host", "image present", frame + " current " + current}
}

// FrameState returns the current frame state of a region as text so that it can be compared with a rejected frame.
func (i *Images) FrameState(key ImageKey) string {
	i.mu.Lock()
	defer i.mu.Unlock()
	state := i.states[key]
	if state == nil {
		return "none"
	}
	return fmt.Sprintf("generation=%d raster=%d sequence=%d configured=%t size=%dx%d@%v presented raster=%d sequence=%d",
		state.Generation, state.Raster, state.LastSequence, state.Configured, state.Width, state.Height, state.Scale,
		state.PresentedRaster, state.PresentedSequence)
}

// logRefusedFrame records a frame that the host rejected together with the reason for the rejection and the current frame state of the region. An unsupported
// frame is a defect of the sidecar, so it is an error, and a detached or replaced frame is a normal race, so it is an observation.
func logRefusedFrame(surface, sender string, images *Images, name string, generation, raster uint64, sequence int, reason string) {
	level := "info"
	if reason == "unsupported" {
		level = "error"
	}
	Log(Entry{level, "host", "image frame", fmt.Sprintf("surface=%s name=%s sender=%s generation=%d raster=%d sequence=%d refused: %s current %s",
		surface, name, sender, generation, raster, sequence, reason, images.FrameState(ImageKey{Surface: surface, Name: name}))})
}

// logAnswerError records the error of an answer to a frame: an answer that cannot reach a sidecar that ended needs no
// receiver, because the frames of a sidecar end with its process, and any other failure is an error.
func logAnswerError(where string, err error) {
	switch {
	case errors.Is(err, ErrSidecarEnded):
		LogInfo(where, fmt.Sprintf("not sent: %v", err))
	case err != nil:
		LogError(where, err)
	}
}

// HandleEnvelope handles an image envelope. It takes as arguments the work to run on the main thread, the way to send the reply, the recovery after a presentation failure, whether a plugin still declares the sending sidecar, and the callback for a newly presented frame.
// recoverFrame runs before the answer with notFound, when the native region has no IOSurface to display, and with staleRaster, when the
// native raster of the region differs from the frame, so the host state holds an earlier raster than the native region; each requests
// a configuration of the native raster (docs/spec/native-surfaces.md#image-regions). It returns true when it handled the envelope.
func HandleEnvelope(body MessageBody, sender, surface string, images *Images, onMain func(func() error) error,
	sendResponse func(string, map[string]interface{}) error, recoverFrame func(reason string) error, declared func() bool, presented func()) bool {
	decision := Decide(body, sender, surface, images)

	switch d := decision.(type) {
	case *NotImage:
		return false

	case *Reply:
		logRefusedFrame(surface, sender, images, d.Name, d.Generation, d.Raster, d.Sequence, d.Reason)
		logAnswerError("image reply "+d.Name, sendResponse(d.Name, d.JSON))
		return true

	case *ScreenMessage:
		key := ImageKey{Surface: surface, Name: d.Name}
		reason := images.ReceiveScreen(key, sender,
			ImageScreenRequest{Request: d.Request, Name: d.Name, Generation: d.Generation, Raster: d.Raster})
		var screen map[string]interface{}
		if reason == "" {
			screen = map[string]interface{}{"accepted": screenEcho(d.Request, d.Name, d.Generation, d.Raster)}
		} else {
			screen = screenEcho(d.Request, d.Name, d.Generation, d.Raster)
			screen["error"] = reason
		}
		logAnswerError("image screen "+d.Name, sendResponse(d.Name, map[string]interface{}{"image": map[string]interface{}{"screen": screen}}))
		return true

	case *FrameRequest:
		key := ImageKey{Surface: surface, Name: d.Name}
		reason, ask := images.WantFrame(key, sender, d.Generation, d.Purpose)
		if reason != "" {
			want := map[string]interface{}{"error": reason, "name": d.Name, "generation": d.Generation}
			logAnswerError("image want "+d.Name, sendResponse(d.Name, map[string]interface{}{"image": map[string]interface{}{"want": want}}))
			return true
		}
		if !ask {
			return true
		}
		handle, err := images.Get(key)
		if err == nil {
			err = onMain(func() error { return system.WantImageFrame(handle) })
		}
		if err != nil {
			// The native region asked for no display frame, so the request ends here and the next request asks again.
			images.FrameTick(key, nil)
			LogError("image want "+d.Name, fmt.Sprintf("surface=%s sender=%s the display frame was not requested: %v", surface, sender, err))
		}
		return true

	case *MalformedFrameRequest:
		if d.Name == "" {
			LogError("image want", fmt.Sprintf("surface=%s sender=%s %s; the message names no image, so no answer is sent", surface, sender, d.Text))
			return true
		}
		LogError("image want", fmt.Sprintf("surface=%s sender=%s %s", surface, sender, d.Text))
		want := map[string]interface{}{"error": "malformed", "member": d.Member, "name": d.Name}
		logAnswerError("image want "+d.Name, sendResponse(d.Name, map[string]interface{}{"image": map[string]interface{}{"want": want}}))
		return true

	case *MalformedScreen:
		// The answer is routed by the image name. A message without a valid name names no image, so its one error record says that
		// no answer is sent.
		name, named := d.Echo["name"].(string)
		if !named {
			LogError("image screen", fmt.Sprintf("surface=%s sender=%s %s; the message names no image, so no answer is sent", surface, sender, d.Text))
			return true
		}
		LogError("image screen", fmt.Sprintf("surface=%s sender=%s %s", surface, sender, d.Text))
		screen := map[string]interface{}{}
		for member, value := range d.Echo {
			screen[member] = value
		}
		screen["error"] = "malformed"
		screen["member"] = d.Member
		logAnswerError("image screen "+name, sendResponse(name, map[string]interface{}{"image": map[string]interface{}{"screen": screen}}))
		return true

	case *Present:
		key := ImageKey{Surface: surface, Name: d.Name}
		if !declared() {
			// No plugin declares the sidecar any more: the buffer of the frame ended with its process, and a native
			// presentation would report the missing buffer to the page (docs/spec/native-surfaces.md#image-regions).
			LogInfo("image present", fmt.Sprintf("frame of sidecar %s, which no plugin declares, invalidated: surface=%s name=%s sequence=%d",
				sender, surface, d.Name, d.Sequence))
			logAnswerError("image response "+d.Name, sendResponse(d.Name, AfterPresent(false, "stale", d.Name, d.Generation, d.Raster, d.Sequence)))
			return true
		}
		handle, err := images.Get(key)
		if err != nil {
			logRefusedFrame(surface, sender, images, d.Name, d.Generation, d.Raster, d.Sequence, "notAttached")
			response := AfterPresent(false, "notAttached", d.Name, d.Generation, d.Raster, d.Sequence)
			logAnswerError("image notAttached "+d.Name, sendResponse(d.Name, response))
			return true
		}

		err = onMain(func() error {
			if status := images.FrameStatus(key, d.Generation, d.Raster, d.Sequence); status != "" {
				return errors.New(status)
			}
			// When the native raster differs from the frame, that frame belongs to an earlier raster. The record keeps the native raster.
			width, height, scale, presentable := system.RasterImage(handle)
			if !presentable {
				return errors.New("staleRaster native=none")
			}
			if width != d.Width || height != d.Height || math.Abs(scale-d.Scale) > 0.000001 {
				return fmt.Errorf("staleRaster native=%dx%d@%v frame=%dx%d@%v", width, height, scale, d.Width, d.Height, d.Scale)
			}
			// Displays the image on the platform
			return system.PresentImage(handle, d.ID, d.Nonce, float64(d.Width), float64(d.Height), d.Scale,
				d.Generation, d.Raster, d.Sequence)
		})

		if err != nil && !declared() {
			// No plugin declares the sidecar any more: its process ended with its buffers, so the frame is invalidated
			// and no recovery starts it again (docs/spec/native-surfaces.md#image-regions).
			LogInfo("image present", fmt.Sprintf("frame of sidecar %s, which no plugin declares, invalidated: surface=%s name=%s sequence=%d reason=%v",
				sender, surface, d.Name, d.Sequence, err))
			response := AfterPresent(false, "stale", d.Name, d.Generation, d.Raster, d.Sequence)
			logAnswerError("image response "+d.Name, sendResponse(d.Name, response))
		} else if err != nil {
			reason, invalidated, line := PresentationOutcome(surface, d.Name, d.Generation, d.Raster, d.Sequence, d.ID,
				err.Error(), images.FrameState(key))
			Log(line)
			recovery := ""
			if !invalidated {
				images.MarkPresentationFailed(key, d.Generation, d.Raster, d.Sequence, reason)
				recovery = reason
			} else if strings.HasPrefix(err.Error(), "staleRaster") {
				recovery = "staleRaster"
			}
			if recovery != "" {
				if err := recoverFrame(recovery); err != nil {
					LogError("image recovery", fmt.Sprintf("surface=%s name=%s reason=%s error=%v", surface, d.Name, recovery, err))
				}
			}
			response := AfterPresent(false, reason, d.Name, d.Generation, d.Raster, d.Sequence)
			logAnswerError("image response "+d.Name, sendResponse(d.Name, response))
		} else {
			if images.MarkPresented(key, d.Generation, d.Raster, d.Sequence) {
				presented()
			} else {
				LogInfo("image present", fmt.Sprintf("presented frame did not advance the region: surface=%s name=%s generation=%d raster=%d sequence=%d current %s",
					surface, d.Name, d.Generation, d.Raster, d.Sequence, images.FrameState(key)))
			}
			response := AfterPresent(true, "", d.Name, d.Generation, d.Raster, d.Sequence)
			if owner, err := images.GetOwner(key); err == nil && owner.Lease {
				response = LeasedReply(d.Name, d.Generation, d.Raster, d.Sequence)
			}
			logAnswerError("image response "+d.Name, sendResponse(d.Name, response))
		}
		return true

	default:
		return false
	}
}

// imageGenerationCounter issues the generations of the image attachments of the process. A persistent supplier outlives the
// application process and keeps the generation of each surface, and a surface moves between windows, so every window of the
// process takes its generations from this one counter, and each generation is the larger of the previous one plus 1 and the
// boot clock of the platform in microseconds (docs/spec/surface-composition.md).
type imageGenerationCounter struct {
	mu   sync.Mutex
	last uint64
}

var imageGenerations imageGenerationCounter

func (c *imageGenerationCounter) next() uint64 {
	// The platform of a running host implements the clock, because a host that misses an operation of its platform fails at
	// startup (docs/spec/hosts.md); a failure here is a defect of the platform, which ends the process with an error record.
	system, err := platform.Current()
	var nanos uint64
	if err == nil {
		nanos, err = system.MonotonicNanos()
	}
	if err != nil {
		fatalError("image generation", fmt.Sprintf("the boot clock cannot be read: %v", err))
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.last = max(c.last+1, nanos/1000)
	return c.last
}
