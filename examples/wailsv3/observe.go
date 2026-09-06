// 개발 중 관측을 담당하는 서비스.
//
// 화면에 무엇이 그려졌는지는 페이지가 알 수 없다. 표면과 모달은 이 앱이 만든 OS 창이고
// 합성은 윈도 서버가 한다. 그래서 밖에서 봐야 하고, 캡처 도구는 화면의 영역이 아니라
// 창을 지목할 수 있어야 한다. 영역을 찍으면 앞에 있는 다른 창이 함께 찍히고, 창을 앞으로
// 끌어내면 재려던 상태가 바뀐다.
//
// 제품의 계약이 아니라 별개 서비스다. 등록하지 않으면 이 파일은 아무 일도 하지 않는다.
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"strconv"
	"strings"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

type Observe struct{}

func (o *Observe) ServiceName() string { return "observe" }

// ServiceStartup 이 관측을 시작한다.
//
// 창 목록이 바뀌는 것을 주기로 확인하지 않는다. 창을 붙이고 떼는 것은 이 앱이므로
// 그 자리에서 알리고, 여기서는 그것을 구독한다. 첫 창도 마찬가지로, 떠오르는 것을
// 기다리지 않고 떠올랐다는 이벤트를 받는다.
func (o *Observe) ServiceStartup(ctx context.Context, _ application.ServiceOptions) error {
	app := application.Get()
	offChange := app.Event.On("windows-changed", func(*application.CustomEvent) { o.report() })
	offRecord := o.record()
	offShow := func() {}
	if win, ok := mainWindow(); ok {
		offShow = win.OnWindowEvent(events.Common.WindowShow, func(*application.WindowEvent) {
			o.report()
			o.open()
			o.drive()
		})
	}
	go func() {
		<-ctx.Done()
		offChange()
		offRecord()
		offShow()
	}()
	return nil
}

// open readies the recording for this window. Reading the window server's list is
// the slow part, so it is read once, here.
func (o *Observe) open() {
	if *capturing == "" {
		return
	}
	if now := o.Windows(); len(now) > 0 {
		captureOpen(now[0])
	}
}

// record keeps this window's composite while a run of updates is going.
//
// The page says whether more is coming, so a boundary dragged by hand is recorded
// the same way a driven one is. Nothing is asked on a clock.
func (o *Observe) record() func() {
	if *capturing == "" {
		return func() {}
	}
	bus := application.Get().Event
	offBegan := bus.On("run-began", func(*application.CustomEvent) {
		captureStart(*capturing)
	})
	offEnded := bus.On("run-ended", func(*application.CustomEvent) {
		log.Printf("관측: %d 프레임을 %s 에 적었다", captureStop(), *capturing)
	})
	return func() {
		offBegan()
		offEnded()
	}
}

// Windows 는 이 창과 여기 붙은 창들의 번호를 반환한다. 모달은 자기 창이므로 목록에
// 들어왔다 나간다.
func (o *Observe) Windows() []int {
	win, ok := mainWindow()
	if !ok {
		return nil
	}
	return windowNumbers(win.NativeWindow())
}

// report 는 지금의 창 목록을 한 줄 남긴다.
func (o *Observe) report() {
	if now := o.Windows(); len(now) > 0 {
		log.Printf("관측: 창 번호 %v", now)
	}
}

// drive drags a boundary without anyone touching the mouse.
//
// The steps go the way a press on a surface goes: the page receives surface-input
// and matches the point against its own dividers. So this measures the path the
// product uses, not one built beside it.
//
// A drag is motion, so it is written on a clock. That clock produces the steps; it
// does not watch for anything.
func (o *Observe) drive() {
	if *driving == "" {
		return
	}
	plan, err := parseDrive(*driving)
	if err != nil {
		log.Printf("관측: --drive %v", err)
		return
	}
	go plan.run()
}

// drivePlan is one drag, repeated. A repeat goes back where it came from, so the
// boundary stays in place over a long run and every cycle covers the same pixels.
type drivePlan struct {
	wait   time.Duration
	x, y   float64
	dx, dy float64
	over   time.Duration
	times  int
}

func (p drivePlan) run() {
	const frame = 16 * time.Millisecond
	// 이 앱이 열지 않은 페이지가 그려지기를 기다린다. 남의 페이지가 다 그려졌다고
	// 알려주는 것은 없으므로 여기서만 시계를 쓴다. 재는 동안에는 쓰지 않는다.
	time.Sleep(p.wait)

	steps := int(p.over / frame)
	if steps < 1 {
		steps = 1
	}
	log.Printf("관측: 흔들기 (%g,%g) %+g,%+g %d걸음 ×%d", p.x, p.y, p.dx, p.dy, steps, p.times)

	send := func(phase int, x, y float64) {
		application.Get().Event.Emit("surface-input", InputStep{Phase: phase, X: x, Y: y})
	}
	// 한 번 누른 채로 왕복한다. 놓았다 다시 누르면 경계가 최소 크기에 걸려 명령한
	// 만큼 가지 않았을 때 다음 누름이 빗나가고, 그때부터 아무것도 움직이지 않는다.
	send(0, p.x, p.y)
	for turn := 0; turn < p.times; turn++ {
		p.sweep(send, 0, 1, steps, frame)
		p.sweep(send, 1, 0, steps, frame)
	}
	send(2, p.x, p.y)
	log.Print("관측: 흔들기 끝")
}

// sweep moves the held point from one fraction of the offset to another.
func (p drivePlan) sweep(send func(int, float64, float64), from, to float64, steps int, frame time.Duration) {
	for i := 1; i <= steps; i++ {
		time.Sleep(frame)
		at := from + (to-from)*float64(i)/float64(steps)
		send(1, p.x+p.dx*at, p.y+p.dy*at)
	}
}

// parseDrive reads "wait,x,y,dx,dy,ms,times": wait that many ms for the pages to
// be drawn, then press at x,y, move by dx,dy over ms, and do it that many times,
// each turn going back the way the one before it came.
func parseDrive(spec string) (drivePlan, error) {
	parts := strings.Split(spec, ",")
	if len(parts) != 7 {
		return drivePlan{}, fmt.Errorf("wants wait,x,y,dx,dy,ms,times, got %q", spec)
	}
	var n [7]float64
	for i, part := range parts {
		v, err := strconv.ParseFloat(strings.TrimSpace(part), 64)
		if err != nil {
			return drivePlan{}, fmt.Errorf("%q is not a number", part)
		}
		n[i] = v
	}
	return drivePlan{
		wait: time.Duration(n[0]) * time.Millisecond,
		x:    n[1], y: n[2], dx: n[3], dy: n[4],
		over:  time.Duration(n[5]) * time.Millisecond,
		times: int(n[6]),
	}, nil
}

var observing = flag.Bool("observe", false,
	"register the observation service, which reports this window's number")

var driving = flag.String("drive", "",
	"drag a boundary once the window is up, as wait,x,y,dx,dy,ms,times")

var capturing = flag.String("capture", "",
	"record this window into this directory while a drag runs")
