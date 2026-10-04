package host

import (
	"fmt"
	"sync"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// Buttons 는 host.buttons 의 값이다. 버튼 source(platform.WatchButtons)가 보고한 눌린 마우스 버튼 mask 를
// 보관하고, mask 가 바뀌면 changed 로 새 값을 알린다. input.pointer 는 이 mask 가 0 이 아닌 동안 누름과 뗌을
// 1007 로 거부하므로, 거부된 뗌의 열린 누름은 이 값이 0 이 된 뒤 끝낼 수 있다(docs/spec/exposure.md#host-entries).
type Buttons struct {
	mu      sync.Mutex
	mask    uint64
	changed func(value map[string]any)
}

// NewButtons 는 mask 0 의 host.buttons 를 만든다. changed 는 바뀐 값마다 보고한 차례대로 한 번 호출된다.
func NewButtons(changed func(value map[string]any)) *Buttons {
	return &Buttons{changed: changed}
}

// Report 는 source 가 읽은 mask 를 기록한다. 기록한 값과 다르면 새 값을 알린다. 알림의 순서가 보고의 순서와
// 같도록 잠금 안에서 알린다. changed 는 막히지 않아야 한다.
func (b *Buttons) Report(mask uint64) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if mask == b.mask {
		return
	}
	b.mask = mask
	b.changed(buttonsValue(mask))
}

// Value 는 host.buttons 의 현재 값 {mask} 다.
func (b *Buttons) Value() map[string]any {
	b.mu.Lock()
	defer b.mu.Unlock()
	return buttonsValue(b.mask)
}

func buttonsValue(mask uint64) map[string]any { return map[string]any{"mask": mask} }

// watchButtons 는 운영체제의 버튼 감시를 설치해 host.buttons 를 채운다. 감시는 설치한 차례에 현재 mask 를 알린다.
func (h *Host) watchButtons() error {
	var err error
	application.InvokeSync(func() { err = system.WatchButtons(h.buttons.Report) })
	if err != nil {
		return fmt.Errorf("mouse buttons: %w", err)
	}
	return nil
}
