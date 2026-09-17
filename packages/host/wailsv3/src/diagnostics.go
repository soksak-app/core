//go:build diagnostics

// 진단 빌드의 엔드포인트 메서드.
//
// 이 파일은 diagnostics 빌드 태그로만 컴파일되고, init 에서 diagnosticMethods 에 메서드를
// 추가한다. 다른 빌드에는 이 메서드가 선언되지 않으므로 엔드포인트가 연결을 닫는다. 형식은
// docs/spec/endpoint.md 의 진단 빌드 절에 정의한다.
//
// 페이지는 화면에 합성된 결과를 읽을 수 없다. 표면과 모달은 이 애플리케이션이 만든 OS 뷰이고
// 합성은 윈도 서버가 수행하므로, 녹화는 화면 영역이 아니라 창 번호를 지정한다.

package host

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
)

func init() {
	diagnosticMethods["diagnostics.fixture"] = diagnosticFixture
	diagnosticMethods["diagnostics.drag"] = diagnosticDrag
	diagnosticMethods["diagnostics.capture.stop"] = diagnosticCaptureStop
	diagnosticMethods["diagnostics.knob"] = diagnosticKnob
	diagnosticMethods["diagnostics.transcript"] = diagnosticTranscript
}

// frameStep 은 끌기 한 걸음의 길이다. 페이지가 같은 값으로 걸음 수를 센다.
const frameStep = 16 * time.Millisecond

// diagnosticHost 는 엔드포인트의 호스트를 반환한다.
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

// diagnosticFixture 는 <config-dir>/test-project 를 빈 폴더 설정으로 만들고, 페이지가 다른
// 프로젝트를 닫고 공통 설정을 기본값으로 되돌린 뒤 그 프로젝트를 새 배치로 열게 한다.
func diagnosticFixture(e *Endpoint, _ *endpointConn, params json.RawMessage) (any, error) {
	h, s, err := diagnosticHost(e, params)
	if err != nil {
		return nil, err
	}
	root := filepath.Join(h.workspace.directory, "test-project")
	if err := os.MkdirAll(root, 0700); err != nil {
		return nil, err
	}
	if err := writeJSON(filepath.Join(root, ".soksak", "settings.json"), Record{}); err != nil {
		return nil, err
	}
	return h.ask(s, "diagnostics.fixture", map[string]any{"root": root}, pageTimeout)
}

// dragPlan 은 경계 하나를 왕복하는 끌기다. 각 반복은 왕복이므로 경계는 제자리로 돌아온다.
type dragPlan struct {
	Axis  string  `json:"axis"`
	Line  int     `json:"line"`
	DX    float64 `json:"dx"`
	DY    float64 `json:"dy"`
	MS    int     `json:"ms"`
	Times int     `json:"times"`
}

// steps 는 한 방향 이동의 걸음 수다. 페이지가 같은 식으로 센다.
func (p dragPlan) steps() int {
	if n := int(math.Round(float64(p.MS) / float64(frameStep/time.Millisecond))); n > 1 {
		return n
	}
	return 1
}

// capture 는 진행 중인 녹화다. 녹화 구현은 애플리케이션에 하나다.
var capture struct {
	mu        sync.Mutex
	directory string
}

// diagnosticDrag 는 페이지에 끌기를 요청하고 걸음의 시각을 보낸다.
//
// 페이지는 경계를 찾아 걸음마다 입력을 적용한다. 창이 앞에 없으면 브라우저가 문서의 시계를
// 늦추므로 걸음의 시각은 호스트가 diagnostics-tick 이벤트로 보낸다. 페이지가 끌기를 마치고
// 답하면 마지막 배치가 표시될 때까지 기다린 뒤 답한다.
func diagnosticDrag(e *Endpoint, _ *endpointConn, params json.RawMessage) (any, error) {
	h, s, err := diagnosticHost(e, params)
	if err != nil {
		return nil, err
	}
	var p struct {
		dragPlan
		Capture bool `json:"capture"`
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
	var frames string
	if p.Capture {
		frames, err = startCapture(h, s)
		if err != nil {
			return nil, err
		}
	}
	ticks := plan.steps() * 2 * plan.Times
	s.log(fmt.Sprintf("diagnostics: drag %s:%d by %g,%g in %d steps, %d times", plan.Axis, plan.Line, plan.DX, plan.DY, plan.steps(), plan.Times))
	id, w := h.relay.open(s, "")
	s.window.EmitEvent("exposure-request", map[string]any{"id": id, "method": "diagnostics.drag", "params": plan})
	stop := make(chan struct{})
	go func() {
		tick := time.NewTicker(frameStep)
		defer tick.Stop()
		for left := ticks; left > 0; left-- {
			select {
			case <-tick.C:
				s.window.EmitEvent("diagnostics-tick")
			case <-stop:
				return
			}
		}
	}()
	reply := h.relay.wait(id, w, time.Duration(ticks)*frameStep+pageTimeout)
	close(stop)
	if reply.Error != nil {
		if p.Capture {
			stopCapture()
		}
		return nil, reply.Error
	}
	select {
	case <-s.whenSettled():
	case <-time.After(pageTimeout):
		return nil, rpcError(codeTimeout, "the drag was not presented within %s", pageTimeout)
	}
	s.log("diagnostics: drag presented")
	result := map[string]any{}
	if len(reply.Result) > 0 && string(reply.Result) != "null" {
		if err := json.Unmarshal(reply.Result, &result); err != nil {
			return nil, fmt.Errorf("the page drag result is not an object: %w", err)
		}
	}
	if p.Capture {
		result["frames"] = frames
	}
	return result, nil
}

// startCapture 는 창 s 의 녹화를 설정 디렉터리 아래 새 폴더에 시작하고 첫 프레임을 기다린다.
func startCapture(h *Host, s *Surfaces) (string, error) {
	capture.mu.Lock()
	defer capture.mu.Unlock()
	if capture.directory != "" {
		return "", fmt.Errorf("a capture into %s is running", capture.directory)
	}
	directory := filepath.Join(h.workspace.directory, "captures", fmt.Sprintf("%s-%d", s.name, time.Now().UnixNano()))
	if err := os.MkdirAll(directory, 0700); err != nil {
		return "", err
	}
	// 윈도 서버의 창 목록 조회는 답을 기다리므로 창 번호만 주 스레드에서 읽는다.
	var numbers []int
	var err error
	application.InvokeSync(func() { numbers, err = system.WindowNumbers(s.window.NativeWindow()) })
	if err != nil {
		return "", err
	}
	if len(numbers) == 0 {
		return "", errors.New("the window has no window server number")
	}
	if err := system.CaptureOpen(numbers[0]); err != nil {
		return "", err
	}
	if err := system.CaptureStart(directory); err != nil {
		return "", err
	}
	capture.directory = directory
	ready, err := system.CaptureWait()
	if err == nil && !ready {
		err = errors.New("capture did not produce an initial frame")
	}
	if err != nil {
		capture.directory = ""
		_, _ = system.CaptureStop()
		return "", err
	}
	return directory, nil
}

// stopCapture 는 실패한 끌기의 녹화를 끝낸다. 프레임 폴더는 요청자가 받지 못했으므로 지운다.
func stopCapture() {
	capture.mu.Lock()
	defer capture.mu.Unlock()
	if capture.directory == "" {
		return
	}
	_, _ = system.CaptureStop()
	_ = os.RemoveAll(capture.directory)
	capture.directory = ""
}

// diagnosticCaptureStop 은 녹화를 끝내고 프레임 폴더와 프레임 수를 반환한다.
func diagnosticCaptureStop(e *Endpoint, _ *endpointConn, params json.RawMessage) (any, error) {
	if _, _, err := diagnosticHost(e, params); err != nil {
		return nil, err
	}
	capture.mu.Lock()
	defer capture.mu.Unlock()
	if capture.directory == "" {
		return nil, errors.New("no capture is running")
	}
	count, err := system.CaptureStop()
	directory := capture.directory
	capture.directory = ""
	if err != nil {
		return nil, err
	}
	return map[string]any{"frames": directory, "count": count}, nil
}

// diagnosticKnob 은 합성기의 검사 값을 페이지에 전달한다.
func diagnosticKnob(e *Endpoint, _ *endpointConn, params json.RawMessage) (any, error) {
	window, err := e.window(params)
	if err != nil {
		return nil, err
	}
	var p struct {
		Name  string   `json:"name"`
		Value *float64 `json:"value"`
	}
	if err := decode(params, &p); err != nil {
		return nil, err
	}
	if p.Name == "" || p.Value == nil {
		return nil, rpcError(codeInvalidParams, "name and a numeric value are required")
	}
	return e.backend.PageRequest(window, "diagnostics.knob", mustJSON(p))
}

// diagnosticTranscript 는 연결의 diagnostics.log 알림을 켜거나 끈다. 페이지는 첫 구독과 마지막
// 해제에서 호출 기록의 시작과 종료를 받는다.
func diagnosticTranscript(e *Endpoint, c *endpointConn, params json.RawMessage) (any, error) {
	window, err := e.window(params)
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
	e.watching.Lock()
	defer e.watching.Unlock()
	t := topic{window, logTopic, ""}
	if !e.subscribe(c, t, *p.On) {
		return nil, nil
	}
	if _, err := e.backend.PageRequest(window, "diagnostics.transcript", mustJSON(map[string]bool{"on": *p.On})); err != nil {
		if *p.On {
			e.subscribe(c, t, false)
		}
		return nil, err
	}
	return nil, nil
}
