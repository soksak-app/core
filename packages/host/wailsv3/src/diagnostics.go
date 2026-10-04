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
	"unsafe"

	"github.com/soksak-app/core/packages/host/wailsv3/src/platform"
	"github.com/wailsapp/wails/v3/pkg/application"
)

func init() {
	diagnosticPlugins = true
	diagnosticMethods["diagnostics.fixture"] = diagnosticFixture
	diagnosticMethods["diagnostics.drag"] = diagnosticDrag
	diagnosticMethods["diagnostics.capture.start"] = diagnosticCaptureStart
	diagnosticMethods["diagnostics.capture.stop"] = diagnosticCaptureStop
	diagnosticMethods["diagnostics.modal.hold"] = diagnosticModalHold
	diagnosticMethods["diagnostics.modal.held"] = diagnosticModalHeld
	diagnosticMethods["diagnostics.presentation.failure"] = diagnosticPresentationFailure
	diagnosticMethods["diagnostics.input.source"] = diagnosticInputSource
	diagnosticMethods["diagnostics.capture.still"] = diagnosticCaptureStill
	diagnosticMethods["diagnostics.notifications"] = diagnosticNotifications
	holdModalContent = modalHolds.wait
	diagnosticMethods["diagnostics.navigation.delay"] = diagnosticNavigationDelay
	diagnosticMethods["diagnostics.page.collect"] = diagnosticPageCollect
	diagnosticMethods["diagnostics.native.objects"] = diagnosticNativeObjects
	diagnosticMethods["diagnostics.process.exit"] = diagnosticProcessExit
	handleNavigation = navigationDelays.handle
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

func diagnosticPresentationFailure(e *Endpoint, _ *endpointConn, params json.RawMessage) (any, error) {
	_, s, err := diagnosticHost(e, params)
	if err != nil {
		return nil, err
	}
	var injectErr error
	application.InvokeSync(func() { injectErr = system.InjectSettledFailure(s.window.NativeWindow()) })
	if injectErr != nil {
		return nil, injectErr
	}
	return nil, nil
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
	// settings 는 기본값 위에 적용할 공통 설정이다. 주어지면 객체여야 한다.
	var request struct {
		Settings json.RawMessage `json:"settings"`
	}
	if err := json.Unmarshal(params, &request); err != nil {
		return nil, err
	}
	page := map[string]any{"root": root}
	if len(request.Settings) > 0 {
		var settings map[string]any
		if err := json.Unmarshal(request.Settings, &settings); err != nil || settings == nil {
			return nil, fmt.Errorf("diagnostics.fixture settings must be an object")
		}
		page["settings"] = settings
	}
	return h.ask(s, "diagnostics.fixture", page, pageTimeout)
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

// platformCapture 는 플랫폼의 창 녹화 연산이다. after 는 멈출 때 녹화에 포함할 마지막 표시 시각이다.
type platformCapture struct {
	platform.Capturer
	after float64
}

func (c platformCapture) Open(target CaptureTarget) error {
	return c.CaptureOpen(target.Window, target.Display)
}
func (c platformCapture) Start(directory string) error { return c.CaptureStart(directory) }
func (c platformCapture) Wait() (bool, error)          { return c.CaptureWait() }
func (c platformCapture) Stop() (int, error)           { return c.CaptureStop(c.after) }

func (c platformCapture) Limited() bool { return c.CaptureLimited() }

type captureStatus interface {
	Limited() bool
	LongestGap() float64
}

func captureStopPayload(c captureStatus, directory string, count int, records [][4]float64) map[string]any {
	return map[string]any{
		"frames":     directory,
		"count":      count,
		"limited":    c.Limited(),
		"longestGap": c.LongestGap(),
		"layouts":    layoutTrace(records),
	}
}

// recorder 는 이 플랫폼의 녹화 장치를 반환한다.
func recorder() (platformCapture, error) {
	capturer, ok := system.(platform.Capturer)
	if !ok {
		return platformCapture{}, errors.New("window capture is not implemented on this platform")
	}
	return platformCapture{Capturer: capturer}, nil
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
	// 녹화하면 걸음을 보낸 시각을 프레임과 같은 시계로 기록한다. 걸음부터 화면까지의 지연을 잴 수 있다.
	var clock func() float64
	if p.Capture {
		frames, err = startCapture(h, s, false)
		if err != nil {
			return nil, err
		}
		capture, err := recorder()
		if err != nil {
			return nil, err
		}
		clock = capture.CaptureClock
		application.InvokeSync(capture.LayoutTraceStart)
	}
	var tickMu sync.Mutex
	sent := []float64{}
	ticks := plan.steps() * 2 * plan.Times
	s.log(fmt.Sprintf("diagnostics: drag %s:%d by %g,%g in %d steps, %d times", plan.Axis, plan.Line, plan.DX, plan.DY, plan.steps(), plan.Times))
	stop := make(chan struct{})
	// 페이지가 드래그 요청을 받은 뒤에 첫 틱이 도착하도록 요청을 보낸 다음 틱을 시작한다.
	reply := h.relay.Request(relayTarget{owner: s}, time.Duration(ticks)*frameStep+pageTimeout, func(id uint64) error {
		s.window.EmitEvent("exposure-request", map[string]any{"id": id, "method": "diagnostics.drag", "params": plan})
		go func() {
			tick := time.NewTicker(frameStep)
			defer tick.Stop()
			for left := ticks; left > 0; left-- {
				select {
				case <-tick.C:
					if clock != nil {
						tickMu.Lock()
						sent = append(sent, clock())
						tickMu.Unlock()
					}
					s.window.EmitEvent("diagnostics-tick")
				case <-stop:
					return
				}
			}
		}()
		return nil
	})
	close(stop)
	result, err := dragResult(s, reply)
	var layouts []map[string]any
	if p.Capture {
		if capture, captureErr := recorder(); captureErr == nil {
			var records [][4]float64
			var traceErr error
			application.InvokeSync(func() { records, traceErr = capture.LayoutTraceStop() })
			err = errors.Join(err, traceErr)
			layouts = layoutTrace(records)
		} else {
			err = errors.Join(err, captureErr)
		}
	}
	if err != nil {
		// 요청자가 프레임 폴더를 받지 못하면 녹화를 멈추고 폴더를 지운다.
		if p.Capture {
			if capture, captureErr := recorder(); captureErr == nil {
				if abortErr := recording.Abort(capture); abortErr != nil {
					err = fmt.Errorf("%w; abort capture: %v", err, abortErr)
				}
			} else {
				err = errors.Join(err, captureErr)
			}
		}
		return nil, err
	}
	if p.Capture {
		result["frames"] = frames
		tickMu.Lock()
		result["ticks"] = append([]float64(nil), sent...)
		tickMu.Unlock()
		result["layouts"] = layouts
	}
	return result, nil
}

// layoutTrace 는 배치 트랜잭션 기록을 {ticket, begun, presented, committed} 로 바꾼다. 일어나지 않은 단계는 null 이다.
func layoutTrace(records [][4]float64) []map[string]any {
	layouts := make([]map[string]any, 0, len(records))
	stage := func(value float64) any {
		if math.IsNaN(value) {
			return nil
		}
		return value
	}
	for _, record := range records {
		layouts = append(layouts, map[string]any{
			"ticket": uint64(record[0]), "begun": stage(record[1]), "presented": stage(record[2]), "committed": stage(record[3]),
		})
	}
	return layouts
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

// diagnosticCaptureStill 은 창을 포커스를 주지 않고 한 장 찍어 <config-dir>/captures/still-*/window.png 로
// 쓰고 경로를 반환한다. 개발 중 눈으로 확인하는 관측 자료이며, 요청자가 확인한 뒤 그 디렉터리를 지운다.
func diagnosticCaptureStill(e *Endpoint, _ *endpointConn, params json.RawMessage) (any, error) {
	h, s, err := diagnosticHost(e, params)
	if err != nil {
		return nil, err
	}
	capture, err := recorder()
	if err != nil {
		return nil, err
	}
	var numbers []int
	application.InvokeSync(func() { numbers, err = capture.WindowNumbers(s.window.NativeWindow()) })
	if err != nil {
		return nil, err
	}
	if len(numbers) == 0 {
		return nil, errors.New("the window has no window server number")
	}
	// 녹화와 같이 캡처마다 비공개 디렉터리를 만든다.
	directory := filepath.Join(h.workspace.directory, "captures", fmt.Sprintf("still-%s-%d", s.name, time.Now().UnixNano()))
	if err := os.MkdirAll(directory, 0700); err != nil {
		return nil, err
	}
	path := filepath.Join(directory, "window.png")
	if err := capture.CaptureStill(numbers[0], path); err != nil {
		return nil, err
	}
	return map[string]string{"path": path}, nil
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
	capture, err := recorder()
	if err != nil {
		return nil, err
	}
	directory, err := startCapture(h, s, p.Display)
	if err != nil {
		return nil, err
	}
	application.InvokeSync(capture.LayoutTraceStart)
	return map[string]any{"frames": directory}, nil
}

// diagnosticCaptureStop 은 after 의 표시 시각까지 녹화한 뒤 녹화를 끝내고 프레임 폴더와 프레임 수를
// 반환한다.
func diagnosticCaptureStop(e *Endpoint, _ *endpointConn, params json.RawMessage) (any, error) {
	if _, _, err := diagnosticHost(e, params); err != nil {
		return nil, err
	}
	var p struct {
		After *float64 `json:"after"`
	}
	if err := decode(params, &p); err != nil {
		return nil, err
	}
	capture, err := recorder()
	if err != nil {
		return nil, err
	}
	if p.After != nil {
		if *p.After < 0 {
			return nil, rpcError(codeInvalidParams, "after must not be negative")
		}
		capture.after = *p.After
	}
	directory, count, err := recording.Finish(capture)
	if err != nil {
		return nil, err
	}
	var records [][4]float64
	application.InvokeSync(func() { records, err = capture.LayoutTraceStop() })
	if err != nil {
		return nil, errors.Join(err, os.RemoveAll(directory))
	}
	return captureStopPayload(captureStatusAdapter{capture}, directory, count, records), nil
}

type captureStatusAdapter struct{ platformCapture }

func (c captureStatusAdapter) Limited() bool       { return c.CaptureLimited() }
func (c captureStatusAdapter) LongestGap() float64 { return c.CaptureLongestGap() }

// diagnosticInputSource 는 select 가 있으면 그 입력 소스를 선택하고, 현재 선택된 키보드 입력 소스를 반환한다.
func diagnosticInputSource(e *Endpoint, _ *endpointConn, params json.RawMessage) (any, error) {
	if _, err := e.window(params); err != nil {
		return nil, err
	}
	var p struct {
		Select *string `json:"select"`
	}
	if err := decode(params, &p); err != nil {
		return nil, err
	}
	if p.Select != nil && *p.Select == "" {
		return nil, rpcError(codeInvalidParams, "select must be a non-empty string")
	}
	sources, ok := system.(platform.InputSources)
	if !ok {
		return nil, errors.New("keyboard input sources are not implemented on this platform")
	}
	var current string
	var err error
	application.InvokeSync(func() {
		if p.Select != nil {
			if err = sources.SelectInputSource(*p.Select); err != nil {
				return
			}
		}
		current, err = sources.InputSource()
	})
	if err != nil {
		return nil, err
	}
	return map[string]string{"current": current}, nil
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

// modalHold 는 한 창에서 붙잡은 모달 내용 응답이다.
type modalHold struct {
	// release 가 닫히면 붙잡은 응답을 보낸다.
	release chan struct{}
	// held 는 첫 응답을 붙잡으면 닫힌다.
	held chan struct{}
	once sync.Once
}

// modalHoldSet 은 창별로 모달 내용 응답을 붙잡는다. 검사는 모달 문서가 처음 내용을 이후
// 이벤트보다 늦게 받는 순서를 만든다.
type modalHoldSet struct {
	mu      sync.Mutex
	windows map[*Surfaces]*modalHold
}

var modalHolds = &modalHoldSet{windows: map[*Surfaces]*modalHold{}}

// wait 는 창 s 의 응답을 붙잡은 동안 반환하지 않는다.
func (set *modalHoldSet) wait(s *Surfaces) {
	set.mu.Lock()
	hold := set.windows[s]
	set.mu.Unlock()
	if hold == nil {
		return
	}
	hold.once.Do(func() { close(hold.held) })
	<-hold.release
}

// diagnosticModalHold 는 on 이면 창의 모달 내용 응답을 붙잡기 시작하고, 아니면 붙잡은 응답을
// 보내고 붙잡기를 멈춘다.
func diagnosticModalHold(e *Endpoint, _ *endpointConn, params json.RawMessage) (any, error) {
	_, s, err := diagnosticHost(e, params)
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
	modalHolds.mu.Lock()
	defer modalHolds.mu.Unlock()
	hold := modalHolds.windows[s]
	switch {
	case *p.On && hold == nil:
		modalHolds.windows[s] = &modalHold{release: make(chan struct{}), held: make(chan struct{})}
	case !*p.On && hold != nil:
		close(hold.release)
		delete(modalHolds.windows, s)
	}
	return nil, nil
}

// diagnosticModalHeld 는 창에서 모달 내용 응답을 하나 붙잡으면 답한다.
// diagnosticNotifications 는 알림 센터가 아직 보이는 이 애플리케이션의 알림을 반환한다.
func diagnosticNotifications(e *Endpoint, _ *endpointConn, params json.RawMessage) (any, error) {
	if _, _, err := diagnosticHost(e, params); err != nil {
		return nil, err
	}
	capture, err := recorder()
	if err != nil {
		return nil, err
	}
	answer := make(chan string, 1)
	application.InvokeSync(func() { capture.DeliveredNotifications(func(list string) { answer <- list }) })
	select {
	case list := <-answer:
		var delivered []map[string]string
		if err := json.Unmarshal([]byte(list), &delivered); err != nil {
			return nil, fmt.Errorf("delivered notifications %q: %w", list, err)
		}
		return delivered, nil
	case <-time.After(pageTimeout):
		return nil, rpcError(codeTimeout, "the notification center did not list delivered notifications within %s", pageTimeout)
	}
}

func diagnosticModalHeld(e *Endpoint, _ *endpointConn, params json.RawMessage) (any, error) {
	_, s, err := diagnosticHost(e, params)
	if err != nil {
		return nil, err
	}
	modalHolds.mu.Lock()
	hold := modalHolds.windows[s]
	modalHolds.mu.Unlock()
	if hold == nil {
		return nil, errors.New("modal content answers are not held in this window")
	}
	select {
	case <-hold.held:
	case <-hold.release:
	}
	return nil, nil
}

// navigationDelaySet 은 창마다 main webview navigation callback 처리를 늦출 시간이다.
type navigationDelaySet struct {
	mu      sync.Mutex
	windows map[*Surfaces]time.Duration
}

var navigationDelays = navigationDelaySet{windows: map[*Surfaces]time.Duration{}}

// diagnosticPageCollect 는 창의 앱 페이지 WebContent process 가 JavaScript 객체를 수집하게 한다. 메모리 검사가
// 수집 시점과 관계없이 남은 메모리를 재도록 재기 전에 부른다.
func diagnosticPageCollect(e *Endpoint, _ *endpointConn, params json.RawMessage) (any, error) {
	_, s, err := diagnosticHost(e, params)
	if err != nil {
		return nil, err
	}
	application.InvokeSync(func() {
		var main unsafe.Pointer
		if main, err = system.MainWebview(s.window.NativeWindow()); err == nil {
			err = system.CollectGarbage(main)
		}
	})
	return nil, err
}

// diagnosticNativeObjects 는 애플리케이션이 이벤트 하나를 처리한 뒤 창과 웹뷰에 붙인 라이브러리 객체의 살아 있는 수를
// 반환한다. 닫은 창의 객체는 그 창을 닫은 이벤트 반복의 자동 해제 풀이 비워질 때 해제되고, 풀은 애플리케이션이
// 이벤트를 처리할 때 비워진다. 창 검사가 닫은 창의 해제를 사용자 입력 없이 재도록 이벤트 하나를 넣고 그 뒤에 센다.
// AppKit 은 화면에 있던 창을 닫기 애니메이션이 끝날 때까지 유지하므로, equal 을 주면 수가 equal 과 같아질 때 응답한다.
func diagnosticNativeObjects(e *Endpoint, _ *endpointConn, params json.RawMessage) (any, error) {
	if _, _, err := diagnosticHost(e, params); err != nil {
		return nil, err
	}
	var p struct {
		Equal json.RawMessage `json:"equal"`
	}
	if err := decode(params, &p); err != nil {
		return nil, err
	}
	var expected *platform.WindowObjects
	if p.Equal != nil {
		equal, err := platform.ParseWindowObjects(p.Equal)
		if err != nil {
			return nil, rpcError(codeInvalidParams, "%s", err)
		}
		expected = &equal
	}
	counter, ok := system.(platform.WindowObjectCounter)
	if !ok {
		return nil, errors.New("window object counts are not implemented on this platform")
	}
	type answer struct {
		counts  platform.WindowObjects
		reached bool
	}
	answers := make(chan answer, 1)
	application.InvokeSync(func() {
		counter.WindowObjectsWhen(expected, pageTimeout.Seconds(), func(counts platform.WindowObjects, reached bool) {
			answers <- answer{counts, reached}
		})
	})
	// 라이브러리는 이벤트를 처리한 뒤 pageTimeout 안에 답하므로, 이벤트 처리 시간까지 두 배를 기다린다.
	select {
	case a := <-answers:
		if !a.reached {
			return nil, rpcError(codeTimeout, "window object counts did not reach %s within %s; they are %s", expected, pageTimeout, a.counts)
		}
		return a.counts.Payload(), nil
	case <-time.After(2 * pageTimeout):
		return nil, rpcError(codeTimeout, "the application did not handle an event within %s", pageTimeout)
	}
}

// diagnosticProcessExit 는 pid 의 프로세스가 끝나면 응답한다. 창 검사가 닫은 창의 WebContent 프로세스가 끝나는 것을
// 커널의 종료 알림으로 기다린다.
func diagnosticProcessExit(e *Endpoint, _ *endpointConn, params json.RawMessage) (any, error) {
	if _, _, err := diagnosticHost(e, params); err != nil {
		return nil, err
	}
	var p struct {
		Pid json.RawMessage `json:"pid"`
	}
	if err := decode(params, &p); err != nil {
		return nil, err
	}
	pid, err := platform.ParseProcessID(p.Pid)
	if err != nil {
		return nil, rpcError(codeInvalidParams, "%s", err)
	}
	waiter, ok := system.(platform.ProcessExitWaiter)
	if !ok {
		return nil, errors.New("process exit waits are not implemented on this platform")
	}
	answers := make(chan bool, 1)
	application.InvokeSync(func() {
		waiter.WhenProcessExited(pid, pageTimeout.Seconds(), func(exited bool) { answers <- exited })
	})
	// 라이브러리는 pageTimeout 안에 답하므로, 메인 스레드가 답을 보낼 시간까지 두 배를 기다린다.
	select {
	case exited := <-answers:
		if !exited {
			return nil, rpcError(codeTimeout, "process %d did not exit within %s", pid, pageTimeout)
		}
		return nil, nil
	case <-time.After(2 * pageTimeout):
		return nil, rpcError(codeTimeout, "the application did not answer within %s", 2*pageTimeout)
	}
}

// diagnosticNavigationDelay 는 창의 이후 navigation callback 처리를 ms 밀리초 늦춘다. 0 은 지연을 없앤다.
func diagnosticNavigationDelay(e *Endpoint, _ *endpointConn, params json.RawMessage) (any, error) {
	_, s, err := diagnosticHost(e, params)
	if err != nil {
		return nil, err
	}
	var p struct {
		Ms *float64 `json:"ms"`
	}
	if err := decode(params, &p); err != nil {
		return nil, err
	}
	if p.Ms == nil || *p.Ms != math.Trunc(*p.Ms) || *p.Ms < 0 || *p.Ms > 10000 {
		return nil, rpcError(codeInvalidParams, "ms must be an integer from 0 to 10000")
	}
	navigationDelays.mu.Lock()
	defer navigationDelays.mu.Unlock()
	if *p.Ms == 0 {
		delete(navigationDelays.windows, s)
	} else {
		navigationDelays.windows[s] = time.Duration(*p.Ms) * time.Millisecond
	}
	return nil, nil
}

// handle 은 창의 지연만큼 기다린 뒤 callback 처리를 실행하고, 끝났음을 진단 기록에 남긴다.
func (d *navigationDelaySet) handle(s *Surfaces, handle func()) {
	d.mu.Lock()
	delay := d.windows[s]
	d.mu.Unlock()
	time.Sleep(delay)
	handle()
	s.log(fmt.Sprintf("navigation callback handled after %d ms", delay.Milliseconds()))
}
