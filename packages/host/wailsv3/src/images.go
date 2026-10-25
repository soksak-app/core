package host

// The display region for external pictures in a surface page, related to the picture envelope of docs/spec/sidecars.md.
//
// A surface page requests that a picture be shown in a native region. The host creates an image region inside the surface web view,
// lays it out with the margins that the page reported, and shows in the region the picture that a sidecar sent. The image region is a subview of the
// surface web view, so it moves and hides together with the surface.
// It closes when the surface is removed or the surface page is read again. The image region shows the picture
// envelope (image envelope) that a sidecar sent, and the host verifies the authenticity of the sidecar.

import (
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
)

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
	// The generation and the raster that a detached image region used last. A region attached again in the same generation counts from the next raster, because the sidecar
	// ignores a configuration whose (generation, raster) did not increase as a past configuration. It is cleared when the generation of the surface changes.
	detachedRasters map[ImageKey][2]uint64
	nextGeneration  uint64
	changed         chan struct{}
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
	PresentationError  string
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

func NewImages() *Images {
	return &Images{
		handles:         map[ImageKey]unsafe.Pointer{},
		owners:          map[ImageKey]*ImageOwner{},
		states:          map[ImageKey]*ImageRasterState{},
		generations:     map[string]uint64{},
		surfaceVisible:  map[string]bool{},
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
	i.nextGeneration++
	i.generations[surface] = i.nextGeneration
	i.forgetDetachedRastersLocked(surface)
	for key, state := range i.states {
		if key.Surface == surface {
			state.Generation = i.nextGeneration
			state.Configured = false
			state.PresentationError = ""
			state.LastSequence = 0
		}
	}
	return i.nextGeneration
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

// SetSurfaceVisible records the visibility of the outer SurfaceHost.
func (i *Images) SetSurfaceVisible(surface string, visible bool) {
	i.mu.Lock()
	defer i.mu.Unlock()
	if held, ok := i.surfaceVisible[surface]; ok && held == visible {
		return
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
		}
	}
	i.changedLocked()
}

// Reserve takes a name. It returns an error when owner is nil.
func (i *Images) Reserve(key ImageKey, owner *ImageOwner) error {
	i.mu.Lock()
	defer i.mu.Unlock()
	if owner == nil {
		return fmt.Errorf("image %q: owner is required", key.Name)
	}
	if _, ok := i.handles[key]; ok {
		return fmt.Errorf("image %q is already attached", key.Name)
	}
	i.handles[key] = nil
	i.owners[key] = owner
	generation := i.generations[key.Surface]
	if generation == 0 {
		i.nextGeneration++
		generation = i.nextGeneration
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
		outer, known := i.surfaceVisible[key.Surface]
		if state.Visible && (!known || outer) && i.handles[key] != nil {
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
		state.Configured = false
		state.LastSequence = 0
		state.PresentedSequence = 0
		state.PresentationError = ""
		invalidated++
	}
	if invalidated > 0 {
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
		i.changedLocked()
	}
	surfaceVisible, known := i.surfaceVisible[key.Surface]
	if !visible || (known && !surfaceVisible) || state.Configured {
		return nil, nil
	}
	state.Configured = true
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

// MarkPresented records that the frame of the current raster was copied to the native display storage.
func (i *Images) MarkPresented(key ImageKey, generation, raster uint64, sequence int) bool {
	i.mu.Lock()
	defer i.mu.Unlock()
	state := i.states[key]
	if state == nil || state.Generation != generation || state.Raster != raster || state.LastSequence != sequence {
		return false
	}
	if state.PresentedRaster != raster || state.PresentedSequence != sequence {
		state.PresentedRaster = raster
		state.PresentedSequence = sequence
		state.PresentationError = ""
		i.changedLocked()
		return true
	}
	return false
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

// currentPresentedLocked returns whether every visible valid image region displayed the current raster.
func (i *Images) currentPresentedLocked() bool {
	for key, state := range i.states {
		surfaceVisible, known := i.surfaceVisible[key.Surface]
		if i.handles[key] != nil && state.Visible && (!known || surfaceVisible) && state.Raster > 0 &&
			(state.LastSequence <= 0 || state.PresentedRaster != state.Raster || state.PresentedSequence != state.LastSequence) {
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
		surfaceVisible, known := i.surfaceVisible[key.Surface]
		if i.handles[key] == nil || !state.Visible || (known && !surfaceVisible) || state.Raster == 0 {
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

// WaitCurrent waits until every visible image region displays the current raster or the time limit ends.
func (i *Images) WaitCurrent(timeout time.Duration) bool {
	return i.WaitCurrentError(timeout) == nil
}

// WaitCurrentError waits for the current raster or returns its exact failure.
func (i *Images) WaitCurrentError(timeout time.Duration) error {
	return i.waitCurrentObserved(timeout, nil)
}

// waitCurrentObserved signals the first pending check under the owner lock so tests can order the next frame before wakeup.
func (i *Images) waitCurrentObserved(timeout time.Duration, waiting func()) error {
	deadline := time.Now().Add(timeout)
	for {
		i.mu.Lock()
		for _, state := range i.states {
			if state.PresentationError != "" {
				err := errors.New(state.PresentationError)
				i.mu.Unlock()
				return err
			}
		}
		if i.currentPresentedLocked() {
			i.mu.Unlock()
			return nil
		}
		changed := i.changed
		if waiting != nil {
			waiting()
			waiting = nil
		}
		i.mu.Unlock()

		remaining := time.Until(deadline)
		if remaining <= 0 {
			return errors.New("presentationTimeout")
		}
		timer := time.NewTimer(remaining)
		select {
		case <-changed:
			if !timer.Stop() {
				select {
				case <-timer.C:
				default:
				}
			}
		case <-timer.C:
			return errors.New("presentationTimeout")
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

func imageReply(reason, name string, generation, raster uint64, sequence int) *Reply {
	return &Reply{Name: name, JSON: map[string]interface{}{
		"image": map[string]interface{}{
			"error": reason, "name": name, "generation": generation, "raster": raster, "sequence": sequence,
		},
	}, Reason: reason, Generation: generation, Raster: raster, Sequence: sequence}
}

// Decide parses and validates an image envelope and returns the decision.
// body must be a JSON object that contains the "image" field.
// It returns NotImage when it is not an image envelope.
// It returns Reply when it is not valid.
// It returns Present when it is valid and registered.
func Decide(bodyBytes []byte, sender, surface string, images *Images) Decision {
	var obj map[string]interface{}
	if err := json.Unmarshal(bodyBytes, &obj); err != nil {
		return &NotImage{}
	}

	imageField, ok := obj["image"]
	if !ok {
		return &NotImage{}
	}

	imageBytes, err := json.Marshal(imageField)
	if err != nil {
		return &NotImage{}
	}

	var envelope struct {
		Name  string `json:"name"`
		Token struct {
			Kind  string `json:"kind"`
			ID    uint32 `json:"id"`
			Nonce string `json:"nonce"`
		} `json:"token"`
		Width      int     `json:"width"`
		Height     int     `json:"height"`
		Scale      float64 `json:"scale"`
		Format     string  `json:"format"`
		Generation uint64  `json:"generation"`
		Raster     uint64  `json:"raster"`
		Sequence   int     `json:"sequence"`
	}

	if err := json.Unmarshal(imageBytes, &envelope); err != nil {
		LogError("image frame", fmt.Sprintf("surface=%s sender=%s malformed image envelope: %s", surface, sender, imageBytes))
		return &NotImage{}
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

// recoverFrame is called, after the current frame failed for a native reason, with that reason
// (notFound has no IOSurface to display, so it requests a new raster configuration). It returns true when it handled the envelope.
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
func HandleEnvelope(bodyBytes []byte, sender, surface string, images *Images, onMain func(func() error) error,
	sendResponse func(string, map[string]interface{}) error, recoverFrame func(reason string) error, declared func() bool, presented func()) bool {
	decision := Decide(bodyBytes, sender, surface, images)

	switch d := decision.(type) {
	case *NotImage:
		return false

	case *Reply:
		logRefusedFrame(surface, sender, images, d.Name, d.Generation, d.Raster, d.Sequence, d.Reason)
		logAnswerError("image reply "+d.Name, sendResponse(d.Name, d.JSON))
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
			if !invalidated {
				images.MarkPresentationFailed(key, d.Generation, d.Raster, d.Sequence, reason)
				if err := recoverFrame(reason); err != nil {
					LogError("image recovery", fmt.Sprintf("surface=%s name=%s reason=%s error=%v", surface, d.Name, reason, err))
				}
			}
			response := AfterPresent(false, reason, d.Name, d.Generation, d.Raster, d.Sequence)
			logAnswerError("image response "+d.Name, sendResponse(d.Name, response))
		} else {
			if images.MarkPresented(key, d.Generation, d.Raster, d.Sequence) {
				presented()
			}
			response := AfterPresent(true, "", d.Name, d.Generation, d.Raster, d.Sequence)
			logAnswerError("image response "+d.Name, sendResponse(d.Name, response))
		}
		return true

	default:
		return false
	}
}
