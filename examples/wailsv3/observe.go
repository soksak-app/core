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
	"log"

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

var observing = flag.Bool("observe", false,
	"register the observation service, which reports this window's number")
