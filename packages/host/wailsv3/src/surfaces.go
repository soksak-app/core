// 표면 동기화, 표시 확인, 배치와 표면 입력 전달.
//
// 페이지는 커밋할 때마다 각 표면의 영역을 선언한다. 표면은 선언된 영역에 메인 창의
// 자식으로 추가한 네이티브 웹뷰다. 네이티브 웹뷰의 메시지는 bindings.go 가 처리하고,
// 포인터 입력은 운영체제 구현이 전달한다.

package host

import (
	"encoding/json"
	"fmt"
	"log"
	"sync"
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
	Dim bool `json:"dim"`
	Rect
}

type SyncRequest struct {
	// 연속적인 배치 갱신이 종료되었는지 나타낸다.
	Settled  bool      `json:"settled"`
	Surfaces []Surface `json:"surfaces"`
}

// nativeWebviewOptions 는 표면과 모달 웹뷰의 생성 값이다.
type nativeWebviewOptions struct {
	URL                 string
	X, Y, Width, Height float64
	Hidden, Transparent bool
	FillParent          bool
}

// nativeWebview 는 앱이 만든 웹뷰다. 핸들과 레지스트리는 AppKit 주 스레드에서 읽고 바꾼다.
type nativeWebview struct {
	owner  *Surfaces
	id     uint64
	handle unsafe.Pointer
}

var nativeViews = map[uint64]*nativeWebview{}
var nativeSerial uint64

type Surfaces struct {
	window *application.WebviewWindow
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
	mu    sync.Mutex
	views map[string]*nativeWebview
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
	modalView *nativeWebview
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
		views:     map[string]*nativeWebview{},
		named:     map[uintptr]string{},
		live:      map[string]bool{},
		shapes:    map[string]*nativeShape{},
		documents: NewDocuments(),
		images:    NewImages(),
		// 아직 테마를 받지 않았을 때의 값. 빈 맵이 아니면 JSON 에 null 이 실리고,
		// 이 값을 받는 페이지는 토큰을 순회하다 멈춘다.
		theme: Theme{Tokens: map[string]string{}},
	}
	return s
}

// Emit 은 이벤트를 이 창의 문서와 이 창에 속한 네이티브 웹뷰에만 전달한다.
func (s *Surfaces) Emit(name string, data ...any) {
	s.window.EmitEvent(name, data...)
	var value any
	if len(data) == 1 {
		value = data[0]
	} else if len(data) > 1 {
		value = data
	}
	payload, err := json.Marshal(map[string]any{"event": name, "data": value})
	if err != nil {
		log.Printf("native event: %v", err)
		return
	}
	application.InvokeSync(func() {
		for _, view := range nativeViews {
			if view.owner == s {
				view.execJS("window.__soksakNative?.receive(" + string(payload) + ")")
			}
		}
	})
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

// DecideImageEnvelope 은 사이드카가 보낸 이미지 봉투를 결정하고 처리한다.
func (s *Surfaces) DecideImageEnvelope(sidecarName, surface string, body json.RawMessage) bool {
	sidecars := s.sidecars
	return HandleEnvelope(body, sidecarName, surface, s.images,
		func(work func() bool) bool {
			var result bool
			application.InvokeSync(func() {
				result = work()
			})
			return result
		},
		func(image string, response map[string]interface{}) error {
			responseBytes, err := json.Marshal(response)
			if err != nil {
				return err
			}
			return sidecars.SendResponse(sidecarName, surface, image, json.RawMessage(responseBytes))
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

// press 는 뷰가 표면인지 반환하고, 표면이면 그 id 를 발행한다. 누름의 의미는 페이지가 결정한다.
func (s *Surfaces) press(view uintptr) bool {
	id, ok := s.named[view]
	if !ok {
		return false
	}
	s.Emit("surface-pressed", id)
	return true
}

// point 는 왼쪽 단추 끌기의 한 단계를 페이지 좌표로 발행한다. phase 는 누름 0, 이동 1,
// 뗌 2 이다.
//
// 경계의 잡기 영역은 두 카드 사이 통로보다 넓으므로, 통로 폭이 선 하나이면 그 영역이
// 표면 아래에 있다. 페이지가 위치를 자기 경계와 비교한다.
func (s *Surfaces) point(phase int, x float64, y float64) {
	s.Emit("surface-input", InputStep{Phase: phase, X: x, Y: y})
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

// aligned 는 페이지 좌표의 영역을 디스플레이 픽셀에 맞춘다. UI 스레드에서 호출한다.
func aligned(win *application.WebviewWindow, at Rect) Rect {
	got, err := system.AlignRect(win.NativeWindow(), platformRect{X: at.X, Y: at.Y, W: max1(at.W), H: max1(at.H)})
	if err != nil {
		log.Printf("surface alignment: %v", err)
	}
	return Rect(got)
}

// SyncSurfaces 는 표면 뷰를 페이지가 선언한 영역에 맞춘다.
//
// AppKit 호출이고 서비스 호출은 자기 고루틴에서 도착하므로 작업은 주 스레드에서 실행한다.
func (s *Surfaces) SyncSurfaces(req SyncRequest) (PreparedSurfaces, error) {
	win, ok := s.window, s.window != nil
	if !ok {
		return PreparedSurfaces{}, errNoWindow
	}
	// 페이지가 커밋했으므로 창이 화면에 있고 표면이 있다. 애플리케이션이 그려진 뒤에
	// 한 번 실행할 작업은 여기서 시작한다.
	s.first.Do(func() { s.Emit("page-ready") })
	var prepared PreparedSurfaces
	var gone []string
	done := make(chan bool, 1)
	var began error
	application.InvokeSync(func() {
		s.lastPreparation++
		prepared.Ticket = s.lastPreparation
		began = system.BeginLayout(win.NativeWindow(), prepared.Ticket, func(allowed bool) {
			if allowed {
				gone, prepared.Placements = s.apply(win, req)
				s.watch.Do(func() { s.watchInput(win) })
			}
			done <- allowed
		})
	})
	if began != nil {
		return prepared, began
	}
	if !<-done {
		return prepared, errNoWindow
	}
	// 제거된 표면을 사이드카와 메인 페이지의 노출 등록에 알린다. 주 스레드 밖에서 호출한다.
	for _, id := range gone {
		s.sidecars.Close(id)
	}
	s.surfacesClosed(gone)
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
}

type PreparedSurfaces struct {
	Ticket     uint64      `json:"ticket"`
	Placements []Placement `json:"placements"`
}

// PresentRequest 는 DOM 표시 확인 요청이다. PresentSurfaces 는 AppKit 스레드를 막지 않고 확인한다.
type PresentRequest struct {
	PreparedSurfaces
	Settled bool `json:"settled"`
}

func (s *Surfaces) PresentSurfaces(req PresentRequest) ([]Placement, error) {
	win, ok := s.window, s.window != nil
	if !ok {
		return nil, errNoWindow
	}
	done := make(chan []Placement, 1)
	var waiting error
	application.InvokeSync(func() {
		waiting = system.AfterPresentation(win.NativeWindow(), func() {
			out := make([]Placement, 0, len(req.Placements))
			for _, p := range req.Placements {
				view := s.views[p.ID]
				if view == nil {
					continue
				}
				out = append(out, Placement{ID: p.ID, Rect: Rect(system.WebviewFrame(view.NativeView()))})
			}
			committed := system.CommitLayout(win.NativeWindow(), req.Ticket)
			if committed && req.Settled {
				s.run(false)
			}
			done <- out
		})
	})
	if waiting != nil {
		return nil, waiting
	}
	placed := <-done
	s.windowChanged()
	return placed, nil
}

// apply 는 표면 뷰를 만들고 옮기고 제거하며, 뷰가 제거된 id 를 반환한다. 그 뒤의 셸은
// 호출자가 이 스레드 밖에서 종료한다.
func (s *Surfaces) apply(win *application.WebviewWindow, req SyncRequest) ([]string, []Placement) {
	if !req.Settled {
		s.run(true)
	}
	wanted := map[string]bool{}
	placed := make([]Placement, 0, len(req.Surfaces))
	place := func(id string, view *nativeWebview, want Rect) {
		want = aligned(win, want)
		view.SetBounds(want.X, want.Y, want.W, want.H)
		placed = append(placed, Placement{ID: id, Rect: Rect(system.WebviewFrame(view.NativeView()))})
	}
	for _, surface := range req.Surfaces {
		wanted[surface.ID] = true
		w, h := max1(surface.W), max1(surface.H)
		// 면적이 없는 웹뷰는 보이지 않으므로 1 픽셀 뷰로 두지 않고 숨긴다.
		visible := surface.Visible && surface.W >= 1 && surface.H >= 1

		alpha := alphaFor(surface.Dim)
		want := Rect{X: surface.X, Y: surface.Y, W: w, H: h}
		if view, live := s.views[surface.ID]; live {
			s.resizing(surface.ID, view, !req.Settled)
			place(surface.ID, view, want)
			view.SetHidden(!visible)
			system.SetWebviewAlpha(view.NativeView(), alpha)
			continue
		}
		view, err := newNativeWebview(s, nativeWebviewOptions{
			URL:    surface.URL,
			X:      surface.X,
			Y:      surface.Y,
			Width:  w,
			Height: h,

			Hidden: !visible,
		})
		if err != nil {
			log.Printf("surface %s: %v", surface.ID, err)
			continue
		}
		system.SetWebviewAlpha(view.NativeView(), alpha)
		view.setBackground(s.dialog())
		s.views[surface.ID] = view
		s.named[uintptr(view.NativeView())] = surface.ID
		place(surface.ID, view, want)
	}

	// 이 목록은 페이지만 작성하므로 목록에 없는 표면은 제거된 표면이다.
	var gone []string
	for id, view := range s.views {
		if wanted[id] {
			continue
		}
		s.resizing(id, view, false)
		s.closeSurfaceDocuments(id)
		s.images.CloseSurface(id, func(handle unsafe.Pointer) {
			system.CloseImage(handle)
			s.windowChanged()
		})
		delete(s.named, uintptr(view.NativeView()))
		view.Close()
		delete(s.views, id)
		gone = append(gone, id)
	}
	return gone, placed
}

func newNativeWebview(owner *Surfaces, options nativeWebviewOptions) (*nativeWebview, error) {
	var view *nativeWebview
	var err error
	application.InvokeSync(func() {
		nativeSerial++
		var handle unsafe.Pointer
		handle, err = system.CreateWebview(owner.window.NativeWindow(), platform.WebviewOptions{
			Identifier: nativeSerial,
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
			system.SetWebviewBounds(v.handle, x, y, width, height)
		}
	})
}

func (v *nativeWebview) SetHidden(hidden bool) {
	application.InvokeSync(func() {
		if v.handle != nil {
			system.SetWebviewHidden(v.handle, hidden)
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
		system.CloseWebview(v.handle)
		v.handle = nil
	})
}
