// 개발 중 관측. 제품의 계약이 아니다.
//
// 페이지는 이 파일의 어떤 것도 부르지 않는다. 화면에 무엇이 그려졌는지는 페이지가
// 알 수 없고 — 표면과 모달은 이 앱이 만든 OS 창이다 — 그래서 개발자가 밖에서 봐야
// 한다. 창 번호를 알려 주면 캡처 도구가 그 창만 지목할 수 있고, 창을 앞으로 끌어낼
// 필요가 없으므로 포커스를 뺏지 않는다. 앞으로 끌어내면 재려던 상태가 바뀐다.
//
// `-observe` 없이 실행하면 이 파일은 아무 일도 하지 않는다.
package main

import (
	"flag"
	"fmt"
	"log"
	"time"
)

var observing = flag.Bool("observe", false,
	"report this window's number so a capture tool can address it")

// watchWindows reports the window numbers once the window exists, and again
// whenever the set changes: a modal is a window of its own and comes and goes.
func watchWindows() {
	if !*observing {
		return
	}
	go func() {
		last := ""
		for range time.Tick(300 * time.Millisecond) {
			win, ok := mainWindow()
			if !ok {
				continue
			}
			now := fmt.Sprint(windowNumbers(win.NativeWindow()))
			if now == last {
				continue
			}
			last = now
			log.Printf("관측: 창 번호 %s", now)
		}
	}()
}
