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
	"bufio"
	"context"
	"flag"
	"fmt"
	"io"
	"log"
	"math"
	"net"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

type Observe struct {
	began sync.Once
	// 지금 녹화가 프레임을 적는 폴더. --capture 가 첫 값을 주고, 지시가 그 뒤의
	// 값을 준다. 지시를 받는 고루틴과 이벤트 수신자가 함께 읽는다.
	mu   sync.Mutex
	into string
	// 창이 크기를 알리는 수신자를 붙였는지.
	sized sync.Once
	// 이 폴더가 실행 하나만 받는지. 지시는 자기가 시킨 끌기만 녹화한다. --capture
	// 는 사람이 끄는 경계도 담으라는 뜻이므로 계속 받는다.
	once bool
}

// dir 는 지금 녹화가 적을 폴더를 반환한다. 빈 값이면 녹화하지 않는다.
func (o *Observe) dir() string {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.into
}

// writeTo 는 다음 녹화가 적을 폴더를 정한다. once 면 실행 하나만 받는다.
func (o *Observe) writeTo(into string, once bool) {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.into = into
	o.once = once
}

// wrote 는 실행 하나가 끝났음을 알린다. 실행 하나만 받기로 한 폴더는 여기서 닫힌다.
func (o *Observe) wrote() {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.once {
		o.into = ""
		o.once = false
	}
}

func (o *Observe) ServiceName() string { return "observe" }

// ServiceStartup 이 관측을 시작한다.
//
// 창 목록을 주기로 확인하지 않는다. 자식 창을 붙이고 떼는 것은 이 애플리케이션이므로
// 그 지점에서 windows-changed 를 발행하고 여기서 구독한다. 첫 보고는 창이 표시되는
// 이벤트에서 받는다.
func (o *Observe) ServiceStartup(ctx context.Context, _ application.ServiceOptions) error {
	// 로그를 표준오류와 제어 연결에 함께 적는다. 제품은 이 서비스를 등록하지
	// 않으므로 그 로그는 지금까지처럼 표준오류에만 간다.
	log.SetOutput(io.MultiWriter(os.Stderr, logging))
	app := application.Get()
	offChange := app.Event.On("windows-changed", func(*application.CustomEvent) { o.report() })
	offRecord := o.record()
	// 모달의 문서가 렌더링할 때마다 남긴다. 갱신된 내용이 그 문서에 도달했는지는
	// 이 보고로만 알 수 있다.
	offRendered := app.Event.On("modal-rendered", func(e *application.CustomEvent) {
		log.Printf("observe: modal rendered %v", e.Data)
	})
	// 관측은 페이지가 처음 커밋한 뒤에 시작한다. 그때 창이 화면에 있고 표면이 있다.
	// 창 이벤트에 붙이면 이 서비스가 늦게 시작할 때 이미 지나간 이벤트를 기다린다.
	offReady := app.Event.On("page-ready", func(*application.CustomEvent) { o.start() })
	go func() {
		<-ctx.Done()
		offChange()
		offRecord()
		offRendered()
		offReady()
	}()
	return nil
}

// start 는 창을 보고하고 요청된 동작을 시작한다. page-ready 는 페이지가 다시
// 로드되면 다시 발행되므로 여기서 한 번만 실행한다.
func (o *Observe) start() {
	o.began.Do(func() {
		o.writeTo(*capturing, false)
		o.transcribe()
		o.report()
		o.open()
		o.zoom()
		o.resize()
		o.drive()
		o.click()
		o.commands()
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
	bus := application.Get().Event
	offBegan := bus.On("run-began", func(*application.CustomEvent) {
		if into := o.dir(); into != "" {
			captureStart(into)
		}
	})
	offEnded := bus.On("run-ended", func(*application.CustomEvent) {
		into := o.dir()
		o.wrote()
		if into != "" {
			log.Printf("observe: wrote %d frames to %s", captureStop(), into)
		}
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

// zoom 은 창을 최대화한다.
//
// 창의 단추가 서는 자리는 창의 크기에서 계산되므로, 크기가 바뀐 뒤에도 그 자리가
// 유지되는지 검사할 수 있어야 한다.
func (o *Observe) zoom() {
	if !*zooming {
		return
	}
	application.InvokeSync(func() {
		if win, ok := mainWindow(); ok {
			win.Maximise()
		}
	})
}

var zooming = flag.Bool("zoom", false,
	"maximise the window once the page is drawn")

// resize 는 창의 콘텐츠를 지정된 크기로 만들고 실제로 얻은 크기를 보고한다.
//
// 최대화와 달리 크기를 이 쪽이 정한다. 최대화가 주는 크기는 화면의 가용 영역이고,
// 그 영역은 애플리케이션이 시작한 직후에 1pt 바뀐다 — 두 애플리케이션이 그 변화의
// 양쪽에서 최대화하면 창의 크기가 서로 달라진다. 크기를 지정하면 그 경주가 결과를
// 움직이지 못한다.
//
// 얻은 크기를 보고한다. 요청한 크기가 그대로 적용되지 않는 애플리케이션이 있으면
// 그것을 읽는 쪽이 알아야 한다.
func (o *Observe) resize() {
	if *resizing == "" {
		return
	}
	w, h, err := parseSize(*resizing)
	if err != nil {
		log.Printf("observe: --resize %v", err)
		return
	}
	o.size(w, h)
}

// parseSize 는 "width,height" 를 읽는다.
func parseSize(spec string) (int, int, error) {
	var w, h int
	if _, err := fmt.Sscanf(spec, "%d,%d", &w, &h); err != nil || w <= 0 || h <= 0 {
		return 0, 0, fmt.Errorf("takes width,height, got %q", spec)
	}
	return w, h, nil
}

// size 는 창의 콘텐츠를 이 크기로 만들고 얻은 크기를 보고한다.
func (o *Observe) size(w, h int) {
	win, ok := mainWindow()
	if !ok {
		return
	}
	// 크기가 실제로 적용된 시점은 창이 알린다. 설정한 직후에 읽으면 아직 적용되지
	// 않은 크기를 읽는 애플리케이션이 있다. 수신자는 한 번만 붙인다: 이 애플리케이션은
	// 지시를 여러 번 받으므로, 부를 때마다 붙이면 한 번의 변경이 여러 줄로 남는다.
	o.sized.Do(func() {
		win.OnWindowEvent(events.Common.WindowDidResize, func(*application.WindowEvent) {
			got, high := win.Size()
			log.Printf("observe: sized %dx%d", got, high)
		})
	})
	application.InvokeSync(func() { win.SetSize(w, h) })
}

var resizing = flag.String("resize", "",
	"give the window's content this size once the page is drawn, as width,height")

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
		// 페이지의 렌더링 완료를 알리는 이벤트가 없으므로 요청받은 시각까지 기다린다.
		time.Sleep(plan.wait)
		startDrag(plan)
	}()
}

// startDrag 는 끌기를 요청하고 그 걸음의 시각을 보낸다.
//
// 페이지는 끌기가 무엇인지를 갖고, 걸음이 언제인지는 여기서 온다. 창이 앞에 없으면
// 브라우저가 그 문서의 시계를 1초 가까이로 묶으므로, 페이지가 스스로 세면 끌기는
// 요청한 속도의 수십 분의 일로 느려진다. 이 시계는 창이 어디에 있든 늦춰지지 않는다.
//
// 걸음의 수는 페이지가 세는 것과 같다. 그만큼 보내고 멈춘다.
func startDrag(plan drivePlan) {
	bus := application.Get().Event
	bus.Emit("observe-drag", plan)
	go func() {
		tick := time.NewTicker(frame)
		defer tick.Stop()
		for left := plan.steps() * 2 * plan.Times; left > 0; left-- {
			<-tick.C
			bus.Emit("observe-tick")
		}
	}()
}

// frame 은 한 걸음의 길이다. 페이지의 observe.js 가 같은 값을 적는다.
const frame = 16 * time.Millisecond

// steps 는 한 쓸기의 걸음 수다. 페이지가 세는 것과 같은 식이다.
func (p drivePlan) steps() int {
	if n := int(math.Round(float64(p.MS) / float64(frame/time.Millisecond))); n > 1 {
		return n
	}
	return 1
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

// ControlPort 는 이 애플리케이션이 지시를 받는 포트다. 다른 호스트는 다른 포트를
// 쓰므로 둘이 함께 떠 있을 수 있다. examples/test/app.mjs 가 같은 숫자를 적는다.
const ControlPort = 49732

// commands 는 지시를 받는 통로를 연다.
//
// 한 애플리케이션이 여러 번 몰 수 있고, 그 애플리케이션은 검사보다 오래 산다.
// 그래서 검사를 다시 돌려도 창이 새로 뜨지 않는다. 새 창은 사람이 보고 있는 화면
// 앞에 놓이므로, 뜨는 횟수가 곧 가리는 횟수다.
//
// 통로는 열린 포트다. 지시 한 줄을 받고, 그 지시가 끝날 때까지 이 애플리케이션의
// 로그를 그대로 돌려보낸다. 부르는 쪽은 자기가 기다리는 줄을 읽으면 끊는다.
func (o *Observe) commands() {
	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", ControlPort))
	if err != nil {
		log.Printf("observe: no control port, %v", err)
		return
	}
	log.Printf("observe: control on %d", ControlPort)
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go o.serve(conn)
		}
	}()
}

// serve 는 연결 하나가 보내는 지시들을 수행한다.
func (o *Observe) serve(conn net.Conn) {
	defer conn.Close()
	logging.join(conn)
	defer logging.leave(conn)
	in := bufio.NewScanner(conn)
	for in.Scan() {
		o.command(strings.TrimSpace(in.Text()))
	}
}

// logging 은 이 애플리케이션의 로그를 표준오류와 열린 연결들에 함께 적는다.
//
// 검사가 읽는 줄은 관측이 남기는 것과 페이지의 검증기가 남기는 것 둘 다이고, 둘
// 모두 표준 로거를 지난다. 그래서 로거 하나만 갈래를 내면 된다.
var logging = &fan{}

type fan struct {
	mu sync.Mutex
	to []net.Conn
}

func (f *fan) join(conn net.Conn) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.to = append(f.to, conn)
}

func (f *fan) leave(conn net.Conn) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for i, at := range f.to {
		if at == conn {
			f.to = append(f.to[:i], f.to[i+1:]...)
			return
		}
	}
}

// Write 는 어느 연결이 실패해도 오류를 돌려주지 않는다. 로그는 실패해도 계속
// 남아야 하고, 끊어진 연결은 그 연결을 쥔 쪽이 거둔다.
func (f *fan) Write(p []byte) (int, error) {
	f.mu.Lock()
	to := append([]net.Conn(nil), f.to...)
	f.mu.Unlock()
	for _, conn := range to {
		_, _ = conn.Write(p)
	}
	return len(p), nil
}

// command 는 지시 한 줄을 수행한다.
//
// drag 는 --drive 와 같은 끌기이되 기다림이 없다. 그 기다림은 페이지가 처음
// 그려지기를 기다리는 것이고, 지시를 받을 때 페이지는 이미 그려져 있다.
func (o *Observe) command(line string) {
	verb, rest, _ := strings.Cut(line, " ")
	switch verb {
	case "":
	case "drag":
		// 폴더는 없어도 된다. 녹화 없이 끄는 지시는 화면이 아니라 로그를 읽는
		// 검사의 것이다.
		spec, into, _ := strings.Cut(rest, " ")
		plan, err := parseDrive(spec)
		if err != nil {
			log.Printf("observe: drag %v", err)
			return
		}
		plan.wait = 0
		o.writeTo(into, true)
		startDrag(plan)
	case "reset":
		// 이 애플리케이션은 검사보다 오래 살고 검사는 여럿이다. 앞의 검사가 연
		// 모달이나 옮긴 경계가 남아 있으면 다음 검사는 자기가 만들지 않은 상태를
		// 잰다. 페이지를 다시 읽으면 모든 검사가 같은 자리에서 시작한다.
		application.InvokeSync(func() {
			win, ok := mainWindow()
			if !ok {
				return
			}
			// 이미 그 상태면 건드리지 않는다. 창의 크기를 다시 정하면 그 사이에
			// 창의 단추가 제자리를 벗어나고, 페이지의 검사는 그것을 본다. 되돌릴
			// 것이 없는데 되돌리는 일이 그 자체로 잴 것을 만든다.
			if win.IsMaximised() {
				win.UnMaximise()
			}
			if w, h := win.Size(); w != startWidth || h != startHeight {
				win.SetSize(startWidth, startHeight)
			}
			win.Reload()
		})
		log.Printf("observe: reset")
	case "click":
		application.Get().Event.Emit("observe-click", rest)
	case "transcript":
		application.Get().Event.Emit("observe-record", rest != "off")
		log.Printf("observe: transcript %s", onOff(rest))
	case "zoom":
		application.InvokeSync(func() {
			win, ok := mainWindow()
			if !ok {
				return
			}
			if rest == "off" {
				win.UnMaximise()
			} else {
				win.Maximise()
			}
		})
		log.Printf("observe: zoom %s", onOff(rest))
	case "size":
		w, h, err := parseSize(rest)
		if err != nil {
			log.Printf("observe: size %v", err)
			return
		}
		o.size(w, h)
	case "knob":
		name, value, ok := strings.Cut(rest, " ")
		if !ok {
			log.Printf("observe: knob takes a name and a value, got %q", rest)
			return
		}
		at, err := strconv.ParseFloat(strings.TrimSpace(value), 64)
		if err != nil {
			log.Printf("observe: knob %q is not a number", value)
			return
		}
		application.Get().Event.Emit("observe-knob", map[string]any{"name": name, "value": at})
	default:
		log.Printf("observe: %q is not a command", verb)
	}
}

// 창이 만들어질 때 받은 콘텐츠 크기. reset 이 창을 이 크기로 되돌린다.
const (
	startWidth  = 1200
	startHeight = 760
)

// onOff 는 지시의 값을 로그에 적을 말로 바꾼다.
func onOff(value string) string {
	if value == "off" {
		return "off"
	}
	return "on"
}

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
		// --drive 와 같은 기다림이다. 누를 요소가 언제 그려지는지 알리는 이벤트가
		// 없다.
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
