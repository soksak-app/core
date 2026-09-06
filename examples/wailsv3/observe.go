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
	offShow := func() {}
	if win, ok := mainWindow(); ok {
		offShow = win.OnWindowEvent(events.Common.WindowShow, func(*application.WindowEvent) {
			o.report()
			o.drive()
		})
	}
	go func() {
		<-ctx.Done()
		offChange()
		offShow()
	}()
	return nil
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
	x, y   float64
	dx, dy float64
	over   time.Duration
	times  int
}

func (p drivePlan) run() {
	const frame = 16 * time.Millisecond
	steps := int(p.over / frame)
	if steps < 1 {
		steps = 1
	}
	log.Printf("관측: 끌기 (%g,%g) %+g,%+g %d걸음 ×%d", p.x, p.y, p.dx, p.dy, steps, p.times)
	// 경계는 끈 만큼 옮겨져 있다. 다음 번은 처음 자리가 아니라 지금 자리를 눌러야
	// 같은 경계를 잡는다.
	x, y := p.x, p.y
	for turn := 0; turn < p.times; turn++ {
		dx, dy := p.dx, p.dy
		if turn%2 == 1 {
			dx, dy = -dx, -dy
		}
		drag(x, y, dx, dy, steps, frame)
		x, y = x+dx, y+dy
	}
	log.Print("관측: 끌기 끝")
}

// drag presses at x,y, moves by dx,dy in even steps and releases.
func drag(x, y, dx, dy float64, steps int, frame time.Duration) {
	send := func(phase int, x, y float64) {
		application.Get().Event.Emit("surface-input", InputStep{Phase: phase, X: x, Y: y})
	}
	send(0, x, y)
	for i := 1; i <= steps; i++ {
		time.Sleep(frame)
		at := float64(i) / float64(steps)
		send(1, x+dx*at, y+dy*at)
	}
	send(2, x+dx, y+dy)
	time.Sleep(frame)
}

// parseDrive reads "x,y,dx,dy,ms,times": press at x,y, move by dx,dy over ms, and
// do it that many times, each turn going back the way the one before it came.
func parseDrive(spec string) (drivePlan, error) {
	parts := strings.Split(spec, ",")
	if len(parts) != 6 {
		return drivePlan{}, fmt.Errorf("wants x,y,dx,dy,ms,times, got %q", spec)
	}
	var n [6]float64
	for i, part := range parts {
		v, err := strconv.ParseFloat(strings.TrimSpace(part), 64)
		if err != nil {
			return drivePlan{}, fmt.Errorf("%q is not a number", part)
		}
		n[i] = v
	}
	return drivePlan{
		x: n[0], y: n[1], dx: n[2], dy: n[3],
		over:  time.Duration(n[4]) * time.Millisecond,
		times: int(n[5]),
	}, nil
}

var observing = flag.Bool("observe", false,
	"register the observation service, which reports this window's number")

var driving = flag.String("drive", "",
	"drag a boundary once the window is up, as x,y,dx,dy,ms,times")
