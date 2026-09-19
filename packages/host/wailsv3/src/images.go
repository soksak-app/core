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
	"fmt"
	"regexp"
	"sync"
	"unsafe"
)

// imageStore 는 그림 영역의 영구 데이터 저장소 이름이다.
const imageStore = "soksak-images"

var imageName = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,63}$`)

// ImageRequest 는 표면 페이지의 그림 영역 호출이다.
type ImageRequest struct {
	Surface string  `json:"surface"`
	Name    string  `json:"name"`
	Left    float64 `json:"left"`
	Top     float64 `json:"top"`
	Right   float64 `json:"right"`
	Bottom  float64 `json:"bottom"`
	Visible bool    `json:"visible"`
}

// ImageKey 는 표면과 그림 이름의 쌍이다.
type ImageKey struct {
	Surface, Name string
}

// CheckImage 는 호출한 표면 caller 가 req.Surface 이고 그림 이름이 올바른지 확인하고 키를 반환한다.
func CheckImage(caller string, req ImageRequest) (ImageKey, error) {
	if caller == "" || caller != req.Surface {
		return ImageKey{}, fmt.Errorf("this image is not surface %q", req.Surface)
	}
	if !imageName.MatchString(req.Name) {
		return ImageKey{}, fmt.Errorf("invalid image name %q", req.Name)
	}
	return ImageKey{req.Surface, req.Name}, nil
}

// ImageOwner 는 그림 영역을 등록한 사이드카와 소유자를 기록한다.
type ImageOwner struct {
	SidecarName  string
	SidecarOwner SidecarOwner
}

// Images 는 창의 그림 영역이다.
type Images struct {
	mu      sync.Mutex
	handles map[ImageKey]unsafe.Pointer
	owners  map[ImageKey]*ImageOwner
}

func NewImages() *Images {
	return &Images{
		handles: map[ImageKey]unsafe.Pointer{},
		owners:  map[ImageKey]*ImageOwner{},
	}
}

// Reserve 는 이름을 차지한다.
func (i *Images) Reserve(key ImageKey, owner *ImageOwner) error {
	i.mu.Lock()
	defer i.mu.Unlock()
	if _, ok := i.handles[key]; ok {
		return fmt.Errorf("image %q is already attached", key.Name)
	}
	i.handles[key] = nil
	i.owners[key] = owner
	return nil
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
	delete(i.handles, key)
	delete(i.owners, key)
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
		delete(i.handles, key)
		delete(i.owners, key)
		if handle != nil {
			removed = append(removed, handle)
		}
	}
	return removed
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

// Reply 는 사이드카에 보낼 오류 응답을 나타낸다.
type Reply struct {
	JSON map[string]interface{}
}

// Present 는 표시할 이미지를 나타낸다.
type Present struct {
	ID       uint32
	Nonce    [16]byte
	Width    int
	Height   int
	Name     string
	Sequence int
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
		Name     string `json:"name"`
		Token    struct {
			Kind  string `json:"kind"`
			ID    uint32 `json:"id"`
			Nonce string `json:"nonce"`
		} `json:"token"`
		Width    int `json:"width"`
		Height   int `json:"height"`
		Format   string `json:"format"`
		Sequence int `json:"sequence"`
	}

	if err := json.Unmarshal(imageBytes, &envelope); err != nil {
		return &NotImage{}
	}

	// 포맷과 토큰 종류 검증
	if envelope.Format != "bgra8" || envelope.Token.Kind != "iosurface-global" {
		return &Reply{
			JSON: map[string]interface{}{
				"image": map[string]interface{}{
					"error":    "unsupported",
					"name":     envelope.Name,
					"sequence": envelope.Sequence,
				},
			},
		}
	}

	// nonce 를 base64 에서 디코딩하여 [16]byte 배열로 변환
	decodedNonce, err := base64.StdEncoding.DecodeString(envelope.Token.Nonce)
	if err != nil {
		return &Reply{
			JSON: map[string]interface{}{
				"image": map[string]interface{}{
					"error":    "unsupported",
					"name":     envelope.Name,
					"sequence": envelope.Sequence,
				},
			},
		}
	}

	// 디코딩된 nonce 가 정확히 16바이트여야 함
	if len(decodedNonce) != 16 {
		return &Reply{
			JSON: map[string]interface{}{
				"image": map[string]interface{}{
					"error":    "unsupported",
					"name":     envelope.Name,
					"sequence": envelope.Sequence,
				},
			},
		}
	}

	// nonce 를 [16]byte 배열로 변환
	var nonce [16]byte
	copy(nonce[:], decodedNonce)

	// 이미지가 등록되어 있고 발신자가 일치하는지 확인
	key := ImageKey{Surface: surface, Name: envelope.Name}
	owner, err := images.GetOwner(key) // err is already declared above but Go allows reassignment
	if err == nil && owner.SidecarName == sender {
		// 발신자가 일치함 - 표시 가능
		return &Present{
			ID:       envelope.Token.ID,
			Nonce:    nonce,
			Width:    envelope.Width,
			Height:   envelope.Height,
			Name:     envelope.Name,
			Sequence: envelope.Sequence,
		}
	}

	// 등록되지 않았거나 발신자가 다름
	return &Reply{
		JSON: map[string]interface{}{
			"image": map[string]interface{}{
				"error":    "notAttached",
				"name":     envelope.Name,
				"sequence": envelope.Sequence,
			},
		},
	}
}

// AfterPresent 는 이미지 표시 후 응답을 생성한다.
// ok 가 true 면 released 응답을 반환하고, false 면 reason 을 오류로 반환한다.
func AfterPresent(ok bool, reason, name string, sequence int) map[string]interface{} {
	if ok {
		return map[string]interface{}{
			"image": map[string]interface{}{
				"released": map[string]interface{}{
					"name":     name,
					"sequence": sequence,
				},
			},
		}
	}
	return map[string]interface{}{
		"image": map[string]interface{}{
			"error":    reason,
			"name":     name,
			"sequence": sequence,
		},
	}
}

// HandleEnvelope 는 이미지 봉투를 처리한다. 메인 스레드에서 실행할 작업과 응답 전송 방식을 인자로 받는다.
// 봉투를 처리했으면 true, 아니면 false를 반환한다.
func HandleEnvelope(bodyBytes []byte, sender, surface string, images *Images, onMain func(func() error) error, sendResponse func(map[string]interface{}) error) bool {
	decision := Decide(bodyBytes, sender, surface, images)

	switch d := decision.(type) {
	case *NotImage:
		return false

	case *Reply:
		_ = sendResponse(d.JSON)
		return true

	case *Present:
		key := ImageKey{Surface: surface, Name: d.Name}
		handle, err := images.Get(key)
		if err != nil {
			response := AfterPresent(false, "notAttached", d.Name, d.Sequence)
			_ = sendResponse(response)
			return true
		}

		_ = onMain(func() error {
			// 플랫폼에 이미지를 표시한다
			_ = system.PresentImage(handle, d.ID, d.Nonce, float64(d.Width), float64(d.Height))
			return nil
		})

		response := AfterPresent(true, "", d.Name, d.Sequence)
		_ = sendResponse(response)
		return true

	default:
		return false
	}
}
