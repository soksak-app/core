package host

// 표면 페이지의 외부 그림 표시 영역. docs/spec/sidecars.md 의 "그림 봉투"와 관련된다.
//
// 표면 페이지가 그림을 네이티브 영역에 표시하도록 요청한다. 호스트는 표면 웹뷰 안에
// 그림 영역을 만들고, 페이지가 알린 여백으로 배치하며, 사이드카가 보낸 그림을 영역에
// 표시한다. 그림 영역은 표면 웹뷰의 하위 뷰이므로 표면과 함께 옮겨지고 숨겨진다.
// 표면이 제거되거나 표면 페이지가 다시 읽히면 닫는다. 그림 영역은 사이드카가 보낸
// 그림 봉투(image envelope)를 표시하는데, 호스트는 사이드카의 진정성을 검증한다.

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

// imageStore 는 그림 영역의 영구 데이터 저장소 이름이다.
const imageStore = "soksak-images"

var imageName = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,63}$`)

// ImageRequest 는 표면 페이지의 그림 영역 호출이다.
type ImageRequest struct {
	Surface string `json:"surface"`
	Name    string `json:"name"`
	Sidecar string `json:"sidecar,omitempty"`
}

// ImageKey 는 표면과 그림 이름의 쌍이다.
type ImageKey struct {
	Surface, Name string
}

// CheckImage 는 표면 호출자의 surface 소유권을 확인하고 키를 반환한다.
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

// ImageCallError 는 그림 영역 호출 call 의 실패를 돌려준다(docs/spec/native-host.md#host-calls).
func ImageCallError(call string, err error) error {
	if err == nil {
		return nil
	}
	return fmt.Errorf("%s: %w", call, err)
}

// ImageOwner 는 그림 영역을 등록한 사이드카와 소유자를 기록한다.
type ImageOwner struct {
	SidecarName  string
	SidecarOwner SidecarOwner
}

// Images 는 창의 그림 영역이다.
type Images struct {
	mu             sync.Mutex
	handles        map[ImageKey]unsafe.Pointer
	owners         map[ImageKey]*ImageOwner
	states         map[ImageKey]*ImageRasterState
	generations    map[string]uint64
	surfaceVisible map[string]bool
	// 뗀 그림 영역이 마지막으로 쓴 세대와 래스터. 같은 세대에서 다시 붙인 영역은 그 다음 래스터부터 센다. 사이드카는
	// (세대, 래스터)가 커지지 않은 구성을 지난 구성으로 보고 무시하기 때문이다. 표면의 세대가 바뀌면 지운다.
	detachedRasters map[ImageKey][2]uint64
	nextGeneration  uint64
	changed         chan struct{}
}

// ImageRasterState 는 호스트가 허용한 현재 전송 세대와 정확한 네이티브 래스터다.
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

// ImageConfigure 는 권한 있는 사이드카에 보낼 새 래스터 설정이다.
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

// changedLocked 는 이미지 표시 대기자에게 상태 변경을 알린다. i.mu 를 잡은 상태에서 호출한다.
func (i *Images) changedLocked() {
	close(i.changed)
	i.changed = make(chan struct{})
}

// BeginGeneration 은 새 표면 문서가 시작될 때 이전 프레임과 구별할 세대를 만든다. 표면에 남아 있는 그림
// 영역도 새 세대로 옮기고 구성을 지우므로, 영역을 닫기 전에 대기 중이던 이전 세대의 프레임은 거부된다.
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

// EndGeneration 은 제거한 표면의 현재 세대를 끝낸다. 번호는 다시 쓰지 않는다.
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

// SetSurfaceVisible 은 바깥 SurfaceHost의 표시 상태를 기록한다.
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
			// 표면을 숨기면 native pixel 이 해제되므로 다시 보이면 같은 크기라도 새 raster 를 설정한다. 숨긴 동안의
			// raster 에 속한 frame 은 그 뒤에 받지 않는다.
			state.Raster++
			state.Configured = false
			state.LastSequence = 0
		}
	}
	i.changedLocked()
}

// Reserve 는 이름을 차지한다. owner 가 nil 이면 오류를 반환한다.
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

// forgetDetachedRastersLocked 는 표면에서 뗀 영역의 래스터 기록을 지운다. 표면의 세대가 바뀌면 새 세대가 이전
// 구성보다 크므로 기록이 필요 없다.
func (i *Images) forgetDetachedRastersLocked(surface string) {
	for key := range i.detachedRasters {
		if key.Surface == surface {
			delete(i.detachedRasters, key)
		}
	}
}

// detachLocked 는 영역의 이름을 지우고, 같은 세대에서 다시 붙일 때 이어 셀 래스터를 남긴다.
func (i *Images) detachLocked(key ImageKey) {
	if state := i.states[key]; state != nil {
		i.detachedRasters[key] = [2]uint64{state.Generation, state.Raster}
	}
	delete(i.handles, key)
	delete(i.owners, key)
	delete(i.states, key)
}

// Set 은 차지한 이름에 만든 그림 영역을 적는다.
func (i *Images) Set(key ImageKey, handle unsafe.Pointer) bool {
	i.mu.Lock()
	defer i.mu.Unlock()
	if _, ok := i.handles[key]; !ok {
		return false
	}
	i.handles[key] = handle
	return true
}

// Get 은 만들어진 그림 영역을 반환한다.
func (i *Images) Get(key ImageKey) (unsafe.Pointer, error) {
	i.mu.Lock()
	defer i.mu.Unlock()
	if handle := i.handles[key]; handle != nil {
		return handle, nil
	}
	return nil, fmt.Errorf("image %q is not attached", key.Name)
}

// GetOwner 는 그림 영역을 등록한 사이드카 소유자를 반환한다.
func (i *Images) GetOwner(key ImageKey) (*ImageOwner, error) {
	i.mu.Lock()
	defer i.mu.Unlock()
	if owner, ok := i.owners[key]; ok && i.handles[key] != nil {
		return owner, nil
	}
	return nil, fmt.Errorf("image %q is not attached", key.Name)
}

// Remove 는 이름을 제거하고 그 그림 영역을 반환한다.
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

// RemoveSurface 는 표면의 이름을 모두 제거하고 만들어진 그림 영역을 반환한다.
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
	// 문서 영역의 정리는 바깥 SurfaceHost의 표시 상태를 바꾸지 않는다.
	// 표면 자체가 닫힐 때 EndGeneration이 그 상태를 제거한다.
	i.changedLocked()
	return removed
}

// Visible 은 영역 자체와 바깥 표면이 모두 표시된 그림의 핸들을 반환한다.
func (i *Images) Visible() map[ImageKey]unsafe.Pointer {
	return i.visibleWhere(func(key ImageKey) bool { return true })
}

// VisibleForSidecar 는 그 사이드카가 그리는 보이는 그림만 반환한다. 영속 사이드카의
// 연결이 다시 맺혔을 때 그 사이드카의 configure 를 다시 보내는 데 쓴다(V5-106).
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

// InvalidateSidecar 는 그 사이드카의 연결이 끊겼다고 표시한다(V5-106). configure 를
// 받아든 연결이 죽었으므로 configure 상태도 함께 죽는다 — 같은 크기라도 다시 보내야
// 새 연결의 서비스가 그림 상태를 만든다. 표시 순서 기록도 지운다 — 새 연결의 프레임은
// 순번을 처음부터 센다.
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

// ConfigureRaster 는 적용된 네이티브 래스터가 달라졌을 때 리비전을 올리고 보낼 설정을 반환한다.
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

// SetVisible 은 래스터가 없는 0 크기 배치에서도 영역의 표시 상태를 기록한다.
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

// FrameStatus 는 프레임이 메인 스레드에서 표시되기 직전에도 현재 래스터인지 검사한다.
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

// MarkPresented 는 현재 래스터의 프레임이 네이티브 표시 저장소에 복사되었음을 기록한다.
func (i *Images) MarkPresented(key ImageKey, generation, raster uint64, sequence int) {
	i.mu.Lock()
	defer i.mu.Unlock()
	state := i.states[key]
	if state == nil || state.Generation != generation || state.Raster != raster || state.LastSequence != sequence {
		return
	}
	if state.PresentedRaster != raster || state.PresentedSequence != sequence {
		state.PresentedRaster = raster
		state.PresentedSequence = sequence
		state.PresentationError = ""
		i.changedLocked()
	}
}

// MarkPresentationFailed 는 현재 raster 의 native presentation 실패를 기록한다.
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

// currentPresentedLocked 는 보이는 모든 유효한 그림 영역이 현재 래스터를 표시했는지 반환한다.
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

// PendingRasters 는 표시 장벽이 아직 기다리는 그림 영역을 표면과 이름 순서로 적는다. 장벽이 시간을 넘기면 오류에
// 붙여 어느 영역이 표시되지 않았는지 보고한다. 기다리는 영역이 없으면 "none" 이다.
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

// CurrentPresented 는 보이는 모든 그림 영역이 현재 래스터를 표시했는지 반환한다.
func (i *Images) CurrentPresented() bool {
	i.mu.Lock()
	defer i.mu.Unlock()
	return i.currentPresentedLocked()
}

// WaitCurrent 는 보이는 모든 그림 영역이 현재 래스터를 표시하거나 제한 시간이 끝날 때까지 기다린다.
func (i *Images) WaitCurrent(timeout time.Duration) bool {
	return i.WaitCurrentError(timeout) == nil
}

// WaitCurrentError 는 현재 raster 를 기다리거나 그 정확한 실패를 반환한다.
func (i *Images) WaitCurrentError(timeout time.Duration) error {
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

// RetryConfigure 는 설정 전송 실패 시 같은 래스터를 다음 완전한 배치에서 다시 보내게 한다.
func (i *Images) RetryConfigure(key ImageKey, generation, raster uint64) {
	i.mu.Lock()
	defer i.mu.Unlock()
	if state := i.states[key]; state != nil && state.Generation == generation && state.Raster == raster {
		state.Configured = false
		state.PresentationError = ""
	}
}

// AuthorizeFrame 은 봉투가 현재 공급자와 정확한 래스터에 속하고 순번이 증가하는지 확인한다.
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

// Names 는 만들어진 그림 영역의 주소별 키다.
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

// All 은 만들어진 그림 영역이다.
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

// CloseSurface 는 표면의 그림 영역을 모두 닫는다. UI 스레드에서 호출한다.
func (i *Images) CloseSurface(surface string, close func(unsafe.Pointer)) {
	handles := i.RemoveSurface(surface)
	for _, handle := range handles {
		close(handle)
	}
}

// Decision 은 이미지 봉투 의사 결정의 결과다.
type Decision interface{}

// NotImage 는 본문에 이미지 필드가 없음을 나타낸다.
type NotImage struct{}

// Reply 는 사이드카에 보낼 오류 응답을 나타낸다. Reason 과 Generation, Raster, Sequence 는 거부한 프레임이다.
type Reply struct {
	Name               string
	JSON               map[string]interface{}
	Reason             string
	Generation, Raster uint64
	Sequence           int
}

// Present 는 표시할 이미지를 나타낸다.
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

// Decide 는 이미지 봉투를 파싱하고 유효성을 검사하여 의사 결정을 반환한다.
// body 는 "image" 필드를 포함하는 JSON 객체여야 한다.
// 이미지 봉투가 아니면 NotImage 를 반환한다.
// 유효하지 않으면 Reply 를 반환한다.
// 유효하고 등록되어 있으면 Present 를 반환한다.
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

	// 포맷과 토큰 종류 검증
	if envelope.Format != "bgra8" || envelope.Token.Kind != "iosurface-global" {
		return imageReply("unsupported", envelope.Name, envelope.Generation, envelope.Raster, envelope.Sequence)
	}

	// nonce 를 base64 에서 디코딩하여 [16]byte 배열로 변환
	decodedNonce, err := base64.StdEncoding.DecodeString(envelope.Token.Nonce)
	if err != nil {
		return imageReply("unsupported", envelope.Name, envelope.Generation, envelope.Raster, envelope.Sequence)
	}

	// 디코딩된 nonce 가 정확히 16바이트여야 함
	if len(decodedNonce) != 16 {
		return imageReply("unsupported", envelope.Name, envelope.Generation, envelope.Raster, envelope.Sequence)
	}

	// nonce 를 [16]byte 배열로 변환
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

// AfterPresent 는 이미지 표시 후 응답을 생성한다.
// ok 가 true 면 consumed 응답을 반환하고, false 면 reason 을 오류로 반환한다.
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

// presentationReason 은 메인 스레드 표시 실패를 응답 이유로 바꾼다. 메인 스레드 작업 전에 떼어진 프레임
// (notAttached)은 표시 실패가 아니라 무효화된 프레임이므로 stale 이다. 알 수 없는 이유는 presentFailed 다.
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

// PresentationOutcome 은 표시하지 못한 프레임의 상세 detail 을 응답 사유와 로그 줄로 바꾼다. 대체된 프레임(stale,
// notAttached, staleRaster ...)은 표시 실패가 아니라 무효화된 프레임이므로 invalidated 가 참이다. current 는 실패한
// 영역의 현재 프레임 상태이며 표시 실패의 줄에만 남긴다.
func PresentationOutcome(surface, name string, generation, raster uint64, sequence int, token uint32, detail, current string) (reason string, invalidated bool, entry Entry) {
	frame := fmt.Sprintf("surface=%s name=%s generation=%d raster=%d sequence=%d token=%d reason=%s",
		surface, name, generation, raster, sequence, token, detail)
	reason = presentationReason(detail)
	if reason == "stale" {
		return reason, true, Entry{"info", "host", "image present", "frame invalidated before native presentation: " + frame}
	}
	return reason, false, Entry{"error", "host", "image present", frame + " current " + current}
}

// FrameState 는 거부한 프레임과 비교할 수 있도록 영역의 현재 프레임 상태를 글로 돌려준다.
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

// logRefusedFrame 은 호스트가 거부한 프레임을 거부 이유와 영역의 현재 프레임 상태와 함께 기록한다. 지원하지 않는
// 프레임은 사이드카의 결함이므로 오류이고, 떼어졌거나 대체된 프레임은 정상 경합이므로 관측이다.
func logRefusedFrame(surface, sender string, images *Images, name string, generation, raster uint64, sequence int, reason string) {
	level := "info"
	if reason == "unsupported" {
		level = "error"
	}
	Log(Entry{level, "host", "image frame", fmt.Sprintf("surface=%s name=%s sender=%s generation=%d raster=%d sequence=%d refused: %s current %s",
		surface, name, sender, generation, raster, sequence, reason, images.FrameState(ImageKey{Surface: surface, Name: name}))})
}

// HandleEnvelope 는 이미지 봉투를 처리한다. 메인 스레드에서 실행할 작업, 응답 전송 방식, 표시 실패 뒤의
// 복구를 인자로 받는다. recoverFrame 은 현재 프레임이 네이티브 이유로 실패한 뒤 그 이유와 함께 호출된다
// (notFound 는 표시할 IOSurface 가 없으므로 새 래스터 구성을 요청한다). 봉투를 처리했으면 true 를 반환한다.
func HandleEnvelope(bodyBytes []byte, sender, surface string, images *Images, onMain func(func() error) error,
	sendResponse func(string, map[string]interface{}) error, recoverFrame func(reason string) error) bool {
	decision := Decide(bodyBytes, sender, surface, images)

	switch d := decision.(type) {
	case *NotImage:
		return false

	case *Reply:
		logRefusedFrame(surface, sender, images, d.Name, d.Generation, d.Raster, d.Sequence, d.Reason)
		if err := sendResponse(d.Name, d.JSON); err != nil {
			LogError("image reply "+d.Name, err)
		}
		return true

	case *Present:
		key := ImageKey{Surface: surface, Name: d.Name}
		handle, err := images.Get(key)
		if err != nil {
			logRefusedFrame(surface, sender, images, d.Name, d.Generation, d.Raster, d.Sequence, "notAttached")
			response := AfterPresent(false, "notAttached", d.Name, d.Generation, d.Raster, d.Sequence)
			if err := sendResponse(d.Name, response); err != nil {
				LogError("image notAttached "+d.Name, err)
			}
			return true
		}

		err = onMain(func() error {
			if status := images.FrameStatus(key, d.Generation, d.Raster, d.Sequence); status != "" {
				return errors.New(status)
			}
			// 네이티브 래스터가 프레임과 다르면 그 프레임은 이전 래스터의 것이다. 기록에는 네이티브 래스터를 남긴다.
			width, height, scale, presentable := system.RasterImage(handle)
			if !presentable {
				return errors.New("staleRaster native=none")
			}
			if width != d.Width || height != d.Height || math.Abs(scale-d.Scale) > 0.000001 {
				return fmt.Errorf("staleRaster native=%dx%d@%v frame=%dx%d@%v", width, height, scale, d.Width, d.Height, d.Scale)
			}
			// 플랫폼에 이미지를 표시한다
			return system.PresentImage(handle, d.ID, d.Nonce, float64(d.Width), float64(d.Height), d.Scale)
		})

		if err != nil {
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
			if err := sendResponse(d.Name, response); err != nil {
				LogError("image response "+d.Name, err)
			}
		} else {
			images.MarkPresented(key, d.Generation, d.Raster, d.Sequence)
			response := AfterPresent(true, "", d.Name, d.Generation, d.Raster, d.Sequence)
			if err := sendResponse(d.Name, response); err != nil {
				LogError("image response "+d.Name, err)
			}
		}
		return true

	default:
		return false
	}
}
