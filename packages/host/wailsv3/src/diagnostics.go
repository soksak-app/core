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
	"time"

	"github.com/min-median-max/soksak/packages/host/wailsv3/src/platform"
	"github.com/wailsapp/wails/v3/pkg/application"
)

func init() {
	diagnosticMethods["diagnostics.fixture"] = diagnosticFixture
	diagnosticMethods["diagnostics.drag"] = diagnosticDrag
	diagnosticMethods["diagnostics.capture.start"] = diagnosticCaptureStart
	diagnosticMethods["diagnostics.capture.stop"] = diagnosticCaptureStop
	diagnosticMethods["diagnostics.knob"] = diagnosticKnob
	diagnosticSubscriptions["diagnostics.transcript"] = transcriptTopic
	diagnosticTopics[logTopic] = func(on bool) (string, any) {
		return "diagnostics.transcript", map[string]bool{"on": on}
	}
	transcribe = func(e *Endpoint, window, line string) {
		e.publish(topic{window, logTopic, ""}, "diagnostics.log", map[string]any{"window": window, "line": line})
	}
}

// logTopic 은 diagnostics.log 알림을 받는 연결의 topic 이름이다. 상태 이름은 점으로 구분한
// 소문자이므로 이 값과 겹치지 않는다.
const logTopic = "#diagnostics.log"

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

// recording 은 진행 중인 녹화다.
var recording Recording

// platformCapture 는 플랫폼의 창 녹화 연산이다.
type platformCapture struct{ platform.Capturer }

func (c platformCapture) Open(target CaptureTarget) error {
	return c.CaptureOpen(target.Window, target.Display)
}
func (c platformCapture) Start(directory string) error { return c.CaptureStart(directory) }
func (c platformCapture) Wait() (bool, error)          { return c.CaptureWait() }
func (c platformCapture) Stop() (int, error)           { return c.CaptureStop() }

// recorder 는 이 플랫폼의 녹화 장치를 반환한다.
func recorder() (platformCapture, error) {
	capturer, ok := system.(platform.Capturer)
	if !ok {
		return platformCapture{}, errors.New("window capture is not implemented on this platform")
	}
	return platformCapture{capturer}, nil
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
		frames, err = startCapture(h, s, false)
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
	result, err := dragResult(s, reply)
	if err != nil {
		// 요청자가 프레임 폴더를 받지 못하면 녹화를 멈추고 폴더를 지운다.
		if p.Capture {
			if capture, captureErr := recorder(); captureErr == nil {
				recording.Abort(capture)
			}
		}
		return nil, err
	}
	if p.Capture {
		result["frames"] = frames
	}
	return result, nil
}

// dragResult 는 페이지의 끌기 응답을 확인하고, 마지막 배치가 표시될 때까지 기다린 뒤 결과를 반환한다.
func dragResult(s *Surfaces, reply ExposureResult) (map[string]any, error) {
	if reply.Error != nil {
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
	return result, nil
}

// startCapture 는 창 s 의 녹화를 설정 디렉터리 아래 새 폴더에 시작하고 첫 프레임을 기다린다.
// display 이면 창이 있는 디스플레이에서 이 앱의 창을 녹화한다.
func startCapture(h *Host, s *Surfaces, display bool) (string, error) {
	capture, err := recorder()
	if err != nil {
		return "", err
	}
	// 윈도 서버의 창 목록 조회는 답을 기다리므로 창 번호만 주 스레드에서 읽는다.
	var numbers []int
	application.InvokeSync(func() { numbers, err = capture.WindowNumbers(s.window.NativeWindow()) })
	if err != nil {
		return "", err
	}
	if len(numbers) == 0 {
		return "", errors.New("the window has no window server number")
	}
	directory := filepath.Join(h.workspace.directory, "captures", fmt.Sprintf("%s-%d", s.name, time.Now().UnixNano()))
	if err := recording.Start(capture, CaptureTarget{Window: numbers[0], Display: display}, directory); err != nil {
		return "", err
	}
	return directory, nil
}

// diagnosticCaptureStart 는 창 녹화를 시작하고 프레임 폴더를 반환한다.
func diagnosticCaptureStart(e *Endpoint, _ *endpointConn, params json.RawMessage) (any, error) {
	h, s, err := diagnosticHost(e, params)
	if err != nil {
		return nil, err
	}
	var p struct {
		Display bool `json:"display"`
	}
	if err := decode(params, &p); err != nil {
		return nil, err
	}
	directory, err := startCapture(h, s, p.Display)
	if err != nil {
		return nil, err
	}
	return map[string]any{"frames": directory}, nil
}

// diagnosticCaptureStop 은 녹화를 끝내고 프레임 폴더와 프레임 수를 반환한다.
func diagnosticCaptureStop(e *Endpoint, _ *endpointConn, params json.RawMessage) (any, error) {
	if _, _, err := diagnosticHost(e, params); err != nil {
		return nil, err
	}
	capture, err := recorder()
	if err != nil {
		return nil, err
	}
	directory, count, err := recording.Finish(capture)
	if err != nil {
		return nil, err
	}
	return map[string]any{"frames": directory, "count": count, "longestGap": capture.CaptureLongestGap()}, nil
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

// transcriptTopic 은 diagnostics.transcript 의 params 에서 연결의 diagnostics.log 구독과 방향을 읽는다.
// 페이지는 첫 구독과 마지막 해제에서 호출 기록의 시작과 종료를 받는다.
func transcriptTopic(e *Endpoint, params json.RawMessage) (topic, bool, error) {
	window, err := e.window(params)
	if err != nil {
		return topic{}, false, err
	}
	var p struct {
		On *bool `json:"on"`
	}
	if err := decode(params, &p); err != nil {
		return topic{}, false, err
	}
	if p.On == nil {
		return topic{}, false, rpcError(codeInvalidParams, "on is required")
	}
	return topic{window, logTopic, ""}, *p.On, nil
}
