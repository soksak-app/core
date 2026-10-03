// 표면 동기화, 표시 확인, 배치와 표면 입력 전달.
//
// 페이지는 커밋할 때마다 각 표면의 영역을 선언한다. 표면은 선언된 영역에 메인 창의
// 자식으로 추가한 네이티브 웹뷰다. 네이티브 웹뷰의 메시지는 bindings.go 가 처리하고,
// 포인터 입력은 운영체제 구현이 전달한다.

package host

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math"
	"reflect"
	"sort"
	"strings"
	"sync"
	"time"
	"unsafe"

	"github.com/wailsapp/wails/v3/pkg/application"

	"github.com/min-median-max/soksak/packages/host/wailsv3/src/platform"
)

// platformRect 는 운영체제 구현이 사용하는 영역이다. Rect 와 필드가 같으므로 서로 변환한다.
type platformRect = platform.Rect

// Rect 는 페이지 뷰포트 기준 CSS 픽셀 단위의 영역이다.
type Rect struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
	W float64 `json:"w"`
	H float64 `json:"h"`
}

type Surface struct {
	ID string `json:"id"`
	// URL 은 이 애플리케이션이 서비스하는 표면 페이지의 경로다.
	URL     string `json:"url"`
	Visible bool   `json:"visible"`
	// 페이지가 초점을 잃은 표면을 흐리게 표시하도록 요청했는지 나타낸다.
	Dim         bool               `json:"dim"`
	Composition SurfaceComposition `json:"composition"`
	Rect
}

type SurfaceRegion struct {
	Name    string `json:"name"`
	Kind    string `json:"kind"`
	Sidecar string `json:"sidecar,omitempty"`
	Input   string `json:"input"`
}

type SurfaceComposition struct {
	Kind     string          `json:"kind"`
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

func validateComposition(composition SurfaceComposition) error {
	if composition.Kind == "dom" {
		if len(composition.Regions) != 0 || len(composition.Overlays) != 0 {
			return fmt.Errorf("dom composition cannot declare regions or overlays")
		}
		return nil
	}
	if composition.Kind != "hybrid" || len(composition.Regions) == 0 || composition.Overlays == nil {
		return fmt.Errorf("surface composition must be dom or a complete hybrid composition")
	}
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
	// 연속적인 배치 갱신이 종료되었는지 나타낸다.
	Settled  bool                   `json:"settled"`
	Surfaces []Surface              `json:"surfaces"`
	Overlays []WindowOverlayRequest `json:"overlays"`
}

type WindowOverlayRequest struct {
	X       float64 `json:"x"`
	Y       float64 `json:"y"`
	W       float64 `json:"w"`
	H       float64 `json:"h"`
	Visible *bool   `json:"visible"`
}

// nativeWebviewOptions 는 표면과 모달 웹뷰의 생성 값이다.
type nativeWebviewOptions struct {
	URL                 string
	Name                string
	X, Y, Width, Height float64
	Hidden, Transparent bool
	FillParent          bool
}

// nativeWebview 는 앱이 만든 웹뷰다. 핸들과 레지스트리는 AppKit 주 스레드에서 읽고 바꾼다.
type nativeWebview struct {
	owner   *Surfaces
	id      uint64
	handle  unsafe.Pointer
	logical bool
}

var nativeViews = map[uint64]*nativeWebview{}
var nativeSerial uint64

type Surfaces struct {
	// prepareNative 는 메인 웹뷰를 등록하고 창을 준비한다. 창을 만들 때 정한다.
	prepareNative func()
	window        *application.WebviewWindow
	// host 는 이 창을 만든 호스트다. name 은 엔드포인트의 창 식별자이고 title 은 창 제목이다.
	host     *Host
	name     string
	title    string
	projects map[string]bool
	root     string
	ready    bool
	// readied 는 다음 WindowReady 를 기다리는 채널이다. Host.mu 로 보호한다.
	readied []chan struct{}
	monitor uintptr

	// 호스트 호출 사이의 모달 상태와 테마를 보호한다.
	// 뷰는 주 스레드에서만 다루므로 잠금이 필요 없고, 이 잠금을 잡은 경로는 주 스레드를
	// 기다리지 않는다.
	mu                   sync.Mutex
	views                map[string]*nativeWebview
	compositions         map[string]SurfaceComposition
	compositionRevisions map[string]uint64
	// 표면은 네이티브 뷰이므로 표면을 누른 입력은 페이지에 도달하지 않는다. 이 맵은 누른
	// 뷰를 페이지가 사용하는 표면 id 로 바꾼다.
	named map[uintptr]string
	// 연속 크기 변경 중인 표면. 표면은 프레임마다 호출을 받지 않고 연속 변경의 시작과
	// 끝을 받는다.
	live map[string]bool
	// registrations 는 표면 페이지가 등록한 항목이다. 메인 페이지가 다시 읽히면 새 페이지에 다시 알린다.
	registrations map[string][]SurfaceRegistration
	// 연속 갱신이 진행 중인지 나타낸다. 페이지가 커밋마다 알리고, 이 값으로 run-began 과
	// run-ended 를 프레임마다가 아니라 연속 갱신의 시작과 끝에만 발행한다.
	running bool
	// settled 는 연속 갱신이 끝나기를 기다리는 채널이다. run-ended 를 발행할 때 닫는다.
	settled         []chan struct{}
	lastPreparation uint64
	// 페이지가 커밋했는지 나타낸다. page-ready 를 한 번만 발행한다.
	first sync.Once
	// 모달은 메인 창 안의 웹뷰이고, 표시할 때마다 만들고 닫을 때 제거한다. 인스턴스 번호로
	// 이전 표시의 응답을 거부한다.
	nextModal uint64
	modal     *modal
	shapes    map[string]*nativeShape
	// documents 는 표면 페이지가 붙인 문서 영역이다.
	documents *Documents
	// images 는 표면 페이지가 붙인 그림 영역이다.
	images   *Images
	sidecars *Sidecars
	watch    sync.Once

	// 메인 페이지가 마지막으로 정한 테마. 페이지는 로드한 뒤 Theme 을 호출한다.
	theme Theme
}

func NewSurfaces(win *application.WebviewWindow, sidecars *Sidecars) *Surfaces {
	s := &Surfaces{
		window: win, projects: map[string]bool{}, sidecars: sidecars,
		views:                map[string]*nativeWebview{},
		compositions:         map[string]SurfaceComposition{},
		compositionRevisions: map[string]uint64{},
		named:                map[uintptr]string{},
		live:                 map[string]bool{},
		shapes:               map[string]*nativeShape{},
		documents:            NewDocuments(),
		images:               NewImages(),
		// 아직 테마를 받지 않았을 때의 값. 빈 맵이 아니면 JSON 에 null 이 실리고,
		// 이 값을 받는 페이지는 토큰을 순회하다 멈춘다.
		theme: Theme{Tokens: map[string]string{}},
	}
	return s
}

// Emit 은 이벤트를 이 창의 단일 앱 DOM에 전달한다.
func (s *Surfaces) Emit(name string, data ...any) {
	s.window.EmitEvent(name, data...)
}

// ProjectRoot 는 이 창의 프로젝트 디렉터리를 반환한다.
func (s *Surfaces) ProjectRoot() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.root
}

// SidecarSend 는 이 창의 표면 페이지가 보낸 메시지를 사이드카에 전달한다.
func (s *Surfaces) SidecarSend(name, surface string, body json.RawMessage) error {
	return s.sidecars.Send(s, name, surface, body)
}

func (s *Surfaces) sidecarSendFrom(viewID uint64, name, surface string, body json.RawMessage) error {
	if err := s.authorizeSurface(viewID, surface); err != nil {
		return err
	}
	return s.SidecarSend(name, surface, body)
}

// SidecarReconnected 는 영속 사이드카의 연결이 끊긴 뒤 다시 맺히면 그 사이드카의 그림
// configure 를 다시 보낸다(V5-106) — 이전 연결이 확인한 configure 상태는 연결과 함께 죽는다.
func (s *Surfaces) SidecarReconnected(sidecar string) {
	if err := s.RefreshSidecarRasters(sidecar); err != nil {
		log.Printf("sidecar %s reconnection reconfigure: %v", sidecar, err)
	}
}

// DecideImageEnvelope 은 사이드카가 보낸 이미지 봉투를 결정하고 처리한다.
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
	)
}

// run 은 run-began 과 run-ended 를 발행한다. 페이지가 갱신이 더 있는지 알리고, 이 함수는
// 그 값이 바뀔 때만 이벤트를 발행한다.
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

// whenSettled 는 연속 갱신이 끝나면 닫히는 채널을 반환한다. 진행 중인 갱신이 없으면 닫힌
// 채널이다.
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

// resizing 은 표면의 연속 크기 변경을 시작하거나 끝낸다. 두 호출은 짝을 이루므로 표면별
// 상태를 여기에 두고 바뀐 경우만 전달한다.
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

// press 는 표면 또는 표면이 소유한 문서 웹뷰의 id 를 발행한다. 누름의 의미는 페이지가 결정한다.
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
	// AppKit의 로컬 마우스 감시기 안에서 Wails의 EmitEvent를 동기 실행하면
	// 현재 NSEvent 처리가 재진입하여 다음 버튼 이벤트가 WebView에 이동으로
	// 전달될 수 있다. 원래 이벤트가 반환된 뒤 같은 메인 런루프 순서로 발행한다.
	application.InvokeAsync(func() { s.Emit("surface-pressed", id) })
	return true
}

// pressAt 은 직접 주입한 누름의 좌표가 표면 또는 그 문서에 있는 경우 표면 누름을 발행한다.
// 직접 주입은 AppKit 로컬 이벤트 감시기를 거치지 않으므로 감시기와 별도로 호출한다.
func (s *Surfaces) pressAt(x, y float64) error {
	var got struct {
		View uint64 `json:"view"`
	}
	if err := native(func() (string, error) {
		return system.WindowHit(s.window.NativeWindow(), x, y)
	}, &got, nil); err != nil {
		return err
	}
	if got.View != 0 {
		s.press(uintptr(got.View))
	}
	return nil
}

// SurfaceOwnerID 는 입력을 받은 native view 가 속한 논리 surface 를 찾는다.
// map 항목은 논리 surface 를 생성할 때 추가되고 surface 와 함께 제거된다.
// 알 수 없는 native view 는 card 를 활성화해서는 안 된다.
func SurfaceOwnerID(named map[uintptr]string, view uintptr) (string, bool) {
	id, ok := named[view]
	return id, ok && id != ""
}

// point 는 왼쪽 단추 끌기의 한 단계를 페이지 좌표로 발행한다. phase 는 누름 0, 이동 1,
// 뗌 2 이다.
//
// 경계의 잡기 영역은 두 카드 사이 통로보다 넓으므로, 통로 폭이 선 하나이면 그 영역이
// 표면 아래에 있다. 페이지가 위치를 자기 경계와 비교한다.
func (s *Surfaces) point(phase int, x float64, y float64) {
	// 표면 누름과 같은 이유로 네이티브 이벤트 감시기에서 DOM 이벤트를 동기
	// 실행하지 않는다. 메인 런루프가 입력 이벤트를 먼저 완료하게 한다.
	step := InputStep{Phase: phase, X: x, Y: y}
	application.InvokeAsync(func() { s.Emit("surface-input", step) })
}

// InputStep 은 페이지가 받는 끌기의 한 단계다.
type InputStep struct {
	Phase int     `json:"phase"`
	X     float64 `json:"x"`
	Y     float64 `json:"y"`
}

// alphaFor 는 표면의 불투명도를 반환한다. 흐리게 표시할지는 페이지가 결정한다.
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

// ValidateRect 는 native view 에 전달되어서는 안 되는 geometry 를 거부한다.
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

// aligned 는 페이지 좌표의 영역을 디스플레이 픽셀에 맞춘다. UI 스레드에서 호출한다.
func aligned(win *application.WebviewWindow, at Rect) (Rect, error) {
	got, err := system.AlignRect(win.NativeWindow(), platformRect{X: at.X, Y: at.Y, W: max1(at.W), H: max1(at.H)})
	if err != nil {
		return Rect{}, fmt.Errorf("surface alignment: %w", err)
	}
	return Rect(got), nil
}

// CheckSyncRequest 는 배치를 시작하기 전에 동기화 요청 전체를 검사하고 창 오버레이를
// 반환한다. held 는 창이 이미 받은 표면의 composition 선언이다.
func CheckSyncRequest(req SyncRequest, held map[string]SurfaceComposition) ([]platform.WindowOverlay, error) {
	seen := map[string]bool{}
	for _, surface := range req.Surfaces {
		if surface.ID == "" || seen[surface.ID] {
			return nil, fmt.Errorf("invalid or duplicate surface %q", surface.ID)
		}
		seen[surface.ID] = true
		if err := validateComposition(surface.Composition); err != nil {
			return nil, fmt.Errorf("surface %q: %w", surface.ID, err)
		}
		if declared, exists := held[surface.ID]; exists && !reflect.DeepEqual(declared, surface.Composition) {
			return nil, fmt.Errorf("surface %q changed its composition declaration", surface.ID)
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

// SyncSurfaces 는 표면 뷰를 페이지가 선언한 영역에 맞춘다.
//
// AppKit 호출이고 서비스 호출은 자기 고루틴에서 도착하므로 작업은 주 스레드에서 실행한다.
func (s *Surfaces) SyncSurfaces(req SyncRequest) (PreparedSurfaces, error) {
	win, ok := s.window, s.window != nil
	if !ok {
		return PreparedSurfaces{}, errNoWindow
	}
	s.mu.Lock()
	windowOverlays, err := CheckSyncRequest(req, s.compositions)
	s.mu.Unlock()
	if err != nil {
		return PreparedSurfaces{}, err
	}
	// 페이지가 커밋했으므로 창이 화면에 있고 표면이 있다. 애플리케이션이 그려진 뒤에
	// 한 번 실행할 작업은 여기서 시작한다.
	s.first.Do(func() { s.Emit("page-ready") })
	var prepared PreparedSurfaces
	type applyResult struct {
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
		if err := system.SetWindowOverlays(main, windowOverlays); err != nil {
			began = err
			return
		}
		s.lastPreparation++
		prepared.Ticket = s.lastPreparation
		began = system.BeginLayout(win.NativeWindow(), prepared.Ticket, func(allowed bool) {
			if !allowed {
				done <- applyResult{err: errNoWindow}
				return
			}
			gone, placements, err := s.apply(win, req)
			if err == nil {
				s.watch.Do(func() { s.watchInput(win) })
			} else {
				if cancelErr := system.CancelLayout(win.NativeWindow()); cancelErr != nil {
					err = fmt.Errorf("%w; cancelling layout: %v", err, cancelErr)
				}
				if !req.Settled {
					s.run(false)
				}
			}
			done <- applyResult{gone: gone, placements: placements, err: err}
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
	// 제거된 표면을 사이드카와 메인 페이지의 노출 등록에 알린다. 주 스레드 밖에서 호출한다.
	for _, id := range gone {
		s.sidecars.Close(id)
	}
	s.surfacesClosed(gone)
	// 연속 frame 은 native 위치만 갱신한다. divider 단계마다 image raster 를 다시
	// 구성하면 sidecar 작업이 display queue 뒤에 직렬화된다. 아래의 settled frame 이
	// 기준이 되는 raster 갱신을 수행한다.
	if req.Settled {
		if err := s.refreshImageRasters(); err != nil {
			if cancel := system.EnqueueUI(func() {
				if failure := system.CancelLayout(win.NativeWindow()); failure != nil {
					log.Printf("cancel surface preparation: %v", failure)
				}
			}); cancel != nil {
				return prepared, fmt.Errorf("%w; scheduling layout cancellation: %v", err, cancel)
			}
			return prepared, err
		}
	}
	return prepared, nil
}

// watchInput 은 창의 표면 입력을 이 창에 전달한다. UI 스레드에서 호출한다.
func (s *Surfaces) watchInput(win *application.WebviewWindow) {
	monitor, err := system.WatchInput(win.NativeWindow(), platform.Input{Press: s.press, Point: s.point})
	if err != nil {
		log.Printf("surface input: %v", err)
		return
	}
	s.monitor = monitor
}

// Placement 는 표면 하나의 실제 위치를 페이지 좌표로 나타낸다. 페이지가 선언한 영역을
// 호스트가 디스플레이 픽셀에 맞추므로 두 값이 다르고, 페이지는 그 차이를 전달받는다.
type Placement struct {
	ID string `json:"id"`
	Rect
	Visible bool `json:"visible"`
}

type PreparedSurfaces struct {
	Ticket     uint64      `json:"ticket"`
	Placements []Placement `json:"placements"`
}

// PresentRequest 는 DOM 표시 확인 요청이다. PresentSurfaces 는 AppKit 스레드를 막지 않고 확인한다.
type PresentRequest struct {
	PreparedSurfaces
	Settled             bool `json:"settled"`
	WaitForPresentation bool `json:"waitForPresentation"`
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
	// settled frame 은 DOM document 와 image raster 를 확인한다. 연속 frame 은 다음
	// display cycle 이 document 나 raster callback 뒤에 직렬화되지 않도록 native 준비
	// 뒤에 commit 한다. 이 전환은 frame 검사가 다룬다.
	go func() {
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
		// 연속 divider gesture 중에는 native surface frame 과 DOM 을 display cycle
		// 마다 commit 한다. 여기서 모든 image raster 를 다시 구성하면 다음 frame 이
		// sidecar raster 작업 뒤에 직렬화되고 native layer 가 DOM 보다 늦어진다.
		// settled frame 이 기준이며, raster transaction 을 완료해야 한다.
		if waiting == nil && req.Settled {
			waiting = s.refreshImageRasters()
		}
		if waiting == nil && req.Settled {
			if err := s.images.WaitCurrentError(pageTimeout); err != nil {
				if err.Error() == "presentationTimeout" {
					waiting = fmt.Errorf("the current image raster did not present within %s; pending %s",
						pageTimeout, s.images.PendingRasters())
				} else {
					waiting = fmt.Errorf("the current image raster failed to present: %w", err)
				}
			}
		}
		// 커밋과 취소는 프레임워크 이벤트 잠금 밖에서 실행한다.
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
	}()
	outcome := <-done
	if outcome.err != nil {
		return nil, outcome.err
	}
	placed := outcome.placed
	s.windowChanged()
	return placed, nil
}

// CreateLogicalSurfaceHandle 은 native 생성 실패를 그대로 전달하고 nil handle 을 거부한다.
// 창을 만들지 않고 실패 contract 를 테스트할 수 있도록 callback 을 분리한다.
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

// WindowNativeKind 는 창이 닫힐 때 닫는 네이티브 객체의 종류다.
type WindowNativeKind int

const (
	WindowNativeDocument WindowNativeKind = iota
	WindowNativeImage
	WindowNativeSurface
)

// WindowNative 는 창이 닫힐 때 닫는 네이티브 객체다.
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

// CloseWindowSurfaces 는 닫히는 창의 논리 표면마다 문서 영역과 그림 영역을 닫은 뒤 표면을 닫는다. 표면은 id
// 순서로 닫는다.
//
// 논리 표면은 메인 웹뷰를 보유하고 문서 영역은 자기 웹 콘텐츠 프로세스를 가지므로, 닫지 않은 표면과 영역은 창이
// 닫힌 뒤에도 웹뷰와 그 웹 콘텐츠 프로세스를 남긴다. 한 객체를 닫지 못해도 나머지를 닫고 모든 실패를 반환한다.
// close 는 네이티브 객체 하나를 닫으며 UI 스레드에서 호출된다.
func CloseWindowSurfaces(surfaces map[string]unsafe.Pointer, documents *Documents, images *Images, close func(WindowNative) error) error {
	ids := make([]string, 0, len(surfaces))
	for id := range surfaces {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	var failures []string
	for _, id := range ids {
		var natives []WindowNative
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

// apply 는 표면 뷰를 만들고 옮기고 제거하며, 뷰가 제거된 id 를 반환한다. 그 뒤의 셸은
// 호출자가 이 스레드 밖에서 종료한다.
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
	rollback := func() {
		for _, id := range created {
			if view := s.views[id]; view != nil {
				nativeHandle := uintptr(view.NativeView())
				view.Close()
				delete(s.named, nativeHandle)
				delete(s.views, id)
			}
		}
	}
	for _, surface := range req.Surfaces {
		if err := ValidateRect(fmt.Sprintf("surface %q", surface.ID), surface.X, surface.Y, surface.W, surface.H); err != nil {
			s.mu.Unlock()
			return nil, nil, err
		}
		wanted[surface.ID] = true
		w, h := max1(surface.W), max1(surface.H)
		visible := surface.Visible && surface.W >= 1 && surface.H >= 1
		view := s.views[surface.ID]
		if view == nil {
			var err error
			application.InvokeSync(func() {
				view, err = createLogicalSurface(func() (unsafe.Pointer, error) {
					return system.CreateSurface(win.NativeWindow())
				}, s, surface.ID)
			})
			if err != nil {
				rollback()
				return nil, nil, err
			}
			s.views[surface.ID] = view
			s.named[uintptr(view.NativeView())] = surface.ID
			created = append(created, surface.ID)
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
		s.mu.Unlock()
		s.images.SetSurfaceVisible(item.id, item.visible)
		// PresentSurfaces 가 대응하는 애플리케이션 DOM frame 이 표시되었음을
		// 확인할 때까지 native view 를 숨긴 상태로 둔다.
		item.view.SetHidden(true)
		system.SetSurfaceAlphaHandle(item.view.NativeView(), alphaFor(item.decl.Dim))
		if item.visible {
			item.view.SetBounds(item.aligned.X, item.aligned.Y, item.aligned.W, item.aligned.H)
		}
		placed = append(placed, Placement{ID: item.id, Rect: Rect(system.SurfaceFrame(item.view.NativeView())), Visible: item.visible})
	}

	// 이 목록은 페이지만 작성하므로 목록에 없는 표면은 제거된 표면이다.
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
		nativeHandle := uintptr(view.NativeView())
		view.Close()
		delete(s.named, nativeHandle)
		delete(s.views, id)
		s.mu.Lock()
		delete(s.compositions, id)
		s.mu.Unlock()
		delete(s.compositionRevisions, id)
		// 표면 생명주기의 계기(V5-104): 목록에서 사라진 표면은 이 자리에서 파괴된다.
		PerformanceObserve(s.host.configDir, "host", func() map[string]any {
			return map[string]any{
				"event": "surface", "phase": "destroyed", "surface": id,
			}
		})
		gone = append(gone, id)
	}
	return gone, placed, nil
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

// execJS 는 주 스레드에서 호출한다.
func (v *nativeWebview) execJS(script string) {
	if v.handle == nil {
		return
	}
	system.EvaluateScript(v.handle, script)
}

func (v *nativeWebview) Close() {
	application.InvokeSync(func() {
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
	})
}
