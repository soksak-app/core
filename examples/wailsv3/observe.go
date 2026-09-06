// 개발 중 관측을 담당하는 서비스.
//
// 페이지는 화면에 합성된 결과를 읽을 수 없다. 표면과 모달은 이 애플리케이션이 만든
// OS 뷰와 창이고 합성은 윈도 서버가 수행한다. 캡처 도구는 화면 영역이 아니라 창을
// 지정해야 한다. 영역을 캡처하면 앞에 있는 다른 창이 함께 캡처되고, 창을 앞으로
// 이동시키면 측정 대상 상태가 바뀐다.
//
// 제품의 계약이 아니라 별개 서비스다. 등록하지 않으면 이 파일은 실행되지 않는다.
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
)

type Observe struct{ began sync.Once }

func (o *Observe) ServiceName() string { return "observe" }

// ServiceStartup 이 관측을 시작한다.
//
// 창 목록을 주기로 확인하지 않는다. 자식 창을 붙이고 떼는 것은 이 애플리케이션이므로
// 그 지점에서 windows-changed 를 발행하고 여기서 구독한다. 첫 보고는 창이 표시되는
// 이벤트에서 받는다.
func (o *Observe) ServiceStartup(ctx context.Context, _ application.ServiceOptions) error {
	app := application.Get()
	offChange := app.Event.On("windows-changed", func(*application.CustomEvent) { o.report() })
	offRecord := o.record()
	// 관측은 페이지가 처음 커밋한 뒤에 시작한다. 그때 창이 화면에 있고 표면이 있다.
	// 창 이벤트에 붙이면 이 서비스가 늦게 시작할 때 이미 지나간 이벤트를 기다린다.
	offReady := app.Event.On("page-ready", func(*application.CustomEvent) { o.start() })
	go func() {
		<-ctx.Done()
		offChange()
		offRecord()
		offReady()
	}()
	return nil
}

// start 는 창을 보고하고 요청된 동작을 시작한다. page-ready 는 페이지가 다시
// 로드되면 다시 발행되므로 여기서 한 번만 실행한다.
func (o *Observe) start() {
	o.began.Do(func() {
		o.transcribe()
		o.report()
		o.open()
		o.drive()
		o.click()
	})
}

// transcribe 는 페이지에게 호출과 답을 기록하라고 요청한다. 기록기는 페이지에
// 있으므로 두 애플리케이션이 같은 형식으로 남긴다.
func (o *Observe) transcribe() {
	if !*transcribing {
		return
	}
	application.Get().Event.Emit("observe-record")
}

// open 은 이 창의 녹화를 준비한다. 윈도 서버의 창 목록을 읽는 것이 느리므로 한 번만
// 읽는다.
func (o *Observe) open() {
	if *capturing == "" {
		return
	}
	// 윈도 서버의 창 목록 조회는 답을 기다린다. 그 답이 주 큐로 오는 경우 주
	// 스레드에서 기다리면 서로를 기다리게 되므로, 창 번호만 주 스레드에서 읽고
	// 조회는 이 고루틴에서 한다.
	now := o.windows()
	if len(now) > 0 {
		captureOpen(now[0])
	}
}

// record 는 갱신이 이어지는 동안 이 창을 녹화한다.
//
// 페이지가 갱신이 더 있는지를 보고하므로, 사람이 끄는 경계도 --drive 가 끄는 경계와
// 같은 방식으로 녹화된다. 주기로 확인하지 않는다.
func (o *Observe) record() func() {
	if *capturing == "" {
		return func() {}
	}
	bus := application.Get().Event
	offBegan := bus.On("run-began", func(*application.CustomEvent) {
		captureStart(*capturing)
	})
	offEnded := bus.On("run-ended", func(*application.CustomEvent) {
		log.Printf("observe: wrote %d frames to %s", captureStop(), *capturing)
	})
	return func() {
		offBegan()
		offEnded()
	}
}

// windows 는 이 창과 여기에 붙은 자식 창들의 번호를 반환한다. 모달은 별도 창이므로
// 열려 있는 동안 목록에 포함된다.
//
// 자식 창 목록은 AppKit 의 것이므로 주 스레드에서 읽는다. 이벤트 수신자는 자기
// 고루틴에서 실행되고, 그동안 주 스레드가 자식 창을 붙이거나 떼면 목록을 순회하는
// 도중에 그 목록이 바뀐다.
func (o *Observe) windows() []int {
	var now []int
	application.InvokeSync(func() {
		win, ok := mainWindow()
		if !ok {
			return
		}
		now = windowNumbers(win.NativeWindow())
	})
	return now
}

// report 는 지금의 창 목록을 한 줄 남긴다.
func (o *Observe) report() {
	if now := o.windows(); len(now) > 0 {
		log.Printf("observe: windows %s", numbers(now))
	}
}

// drive 는 경계를 끄는 일을 페이지에 요청한다.
//
// 끌기 자체는 페이지가 수행한다. 두 애플리케이션이 같은 페이지를 실행하므로, 어느
// 경계를 어떻게 끄는지는 한 번만 적힌다.
func (o *Observe) drive() {
	if *driving == "" {
		return
	}
	plan, err := parseDrive(*driving)
	if err != nil {
		log.Printf("observe: --drive %v", err)
		return
	}
	go func() {
		// 이 애플리케이션이 열지 않은 페이지가 렌더링될 때까지 기다린다. 외부
		// 페이지의 렌더링 완료를 알리는 이벤트가 없으므로 여기서만 시계를 쓴다.
		time.Sleep(plan.wait)
		application.Get().Event.Emit("observe-drag", plan)
	}()
}

// drivePlan 은 한 번의 끌기를 반복하는 계획이다. 각 반복은 왕복이므로 경계는 제자리로
// 돌아오고 모든 회차가 같은 픽셀을 지난다.
type drivePlan struct {
	wait  time.Duration `json:"-"`
	Axis  string        `json:"axis"`
	Line  int           `json:"line"`
	DX    float64       `json:"dx"`
	DY    float64       `json:"dy"`
	MS    int           `json:"ms"`
	Times int           `json:"times"`
}

// parseDrive 는 "wait,axis,line,dx,dy,ms,times" 를 읽는다. 페이지가 렌더링될 때까지
// wait 밀리초 기다린 뒤 그 경계를 누르고 ms 동안 dx,dy 만큼 왕복하며, 이를 times 번
// 반복한다.
func parseDrive(spec string) (drivePlan, error) {
	parts := strings.Split(spec, ",")
	if len(parts) != 7 {
		return drivePlan{}, fmt.Errorf("wants wait,axis,line,dx,dy,ms,times, got %q", spec)
	}
	if parts[1] != "x" && parts[1] != "y" {
		return drivePlan{}, fmt.Errorf("axis is x or y, got %q", parts[1])
	}
	var n [5]float64
	for i, at := range []int{0, 2, 3, 4, 5} {
		v, err := strconv.ParseFloat(strings.TrimSpace(parts[at]), 64)
		if err != nil {
			return drivePlan{}, fmt.Errorf("%q is not a number", parts[at])
		}
		n[i] = v
	}
	times, err := strconv.Atoi(strings.TrimSpace(parts[6]))
	if err != nil {
		return drivePlan{}, fmt.Errorf("%q is not a number", parts[6])
	}
	return drivePlan{
		wait: time.Duration(n[0]) * time.Millisecond,
		Axis: parts[1], Line: int(n[1]),
		DX: n[2], DY: n[3], MS: int(n[4]), Times: times,
	}, nil
}

// numbers writes window numbers the same way the other host does.
func numbers(list []int) string {
	out := make([]string, len(list))
	for i, n := range list {
		out[i] = strconv.Itoa(n)
	}
	return strings.Join(out, " ")
}

var observing = flag.Bool("observe", false,
	"register the observation service, which reports this window's number")

var driving = flag.String("drive", "",
	"drag a boundary once the page is drawn, as wait,axis,line,dx,dy,ms,times")

// click 은 CSS 선택자로 지정한 페이지 요소를 누른다.
//
// 경계는 표면 위에 있으므로 좌표로 도달한다. 페이지 크롬의 버튼은 DOM 요소이므로
// 문서만 클릭을 전달할 수 있고, 페이지의 관측 모듈이 그 일을 한다.
func (o *Observe) click() {
	if *clicking == "" {
		return
	}
	wait, selector, ok := strings.Cut(*clicking, ",")
	if !ok {
		log.Printf("observe: --click takes ms,selector, got %q", *clicking)
		return
	}
	after, err := strconv.Atoi(strings.TrimSpace(wait))
	if err != nil {
		log.Printf("observe: --click wait %q is not a number", wait)
		return
	}
	go func() {
		time.Sleep(time.Duration(after) * time.Millisecond)
		application.Get().Event.Emit("observe-click", selector)
	}()
}

var clicking = flag.String("click", "",
	"press one element of the page once it is drawn, as ms,selector")

var transcribing = flag.Bool("transcript", false,
	"write one line per host call and its answer to the log")

var capturing = flag.String("capture", "",
	"record this window into this directory while a drag runs")
