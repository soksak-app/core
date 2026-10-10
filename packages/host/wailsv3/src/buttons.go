package host

import (
	"fmt"
	"sync"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// Buttons is the value of host.buttons. It keeps the mask of pressed mouse buttons that the button source (platform.WatchButtons) reported
// and announces the new value through changed when the mask changes. While the mask is not 0, input.pointer rejects press and release
// with 1007, so the open press of a rejected release can end after this value becomes 0 (docs/spec/exposure.md#host-entries).
type Buttons struct {
	mu      sync.Mutex
	mask    uint64
	changed func(value map[string]any)
}

// NewButtons creates host.buttons with mask 0. changed is called once for each changed value, in the order of the reports.
func NewButtons(changed func(value map[string]any)) *Buttons {
	return &Buttons{changed: changed}
}

// Report records the mask that the source read. When it differs from the recorded value, it announces the new value. It announces inside the lock so that
// the order of the announcements equals the order of the reports. changed must not block.
func (b *Buttons) Report(mask uint64) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if mask == b.mask {
		return
	}
	b.mask = mask
	b.changed(buttonsValue(mask))
}

// Value is the current value {mask} of host.buttons.
func (b *Buttons) Value() map[string]any {
	b.mu.Lock()
	defer b.mu.Unlock()
	return buttonsValue(b.mask)
}

func buttonsValue(mask uint64) map[string]any { return map[string]any{"mask": mask} }

// watchButtons installs the button watch of the operating system and fills host.buttons. The watch reports the current mask at the time of installation.
func (h *Host) watchButtons() error {
	var err error
	application.InvokeSync(func() { err = system.WatchButtons(h.buttons.Report) })
	if err != nil {
		return fmt.Errorf("mouse buttons: %w", err)
	}
	return nil
}
