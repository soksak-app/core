package host_test

import (
	"encoding/json"
	"testing"

	host "github.com/soksak-app/core/packages/host/wailsv3/src"
)

// buttonsBackend is a fakeBackend that answers host.buttons with the value of buttons.
type buttonsBackend struct {
	*fakeBackend
	buttons *host.Buttons
}

func (b buttonsBackend) HostStatus(window, name string) (any, error) {
	if name == "host.buttons" {
		return b.buttons.Value(), nil
	}
	return b.fakeBackend.HostStatus(window, name)
}

// nextMask reads the mask of the next notification of host.buttons.
func nextMask(t *testing.T, read func() (message, error)) uint64 {
	t.Helper()
	got, err := read()
	if err != nil {
		t.Fatalf("no host.buttons notification: %v", err)
	}
	var change struct {
		Window string
		Name   string
		Value  struct{ Mask *uint64 }
	}
	if err := json.Unmarshal(got.Params, &change); err != nil || got.Method != "status.changed" || change.Window != "main" ||
		change.Name != "host.buttons" || change.Value.Mask == nil {
		t.Fatalf("host.buttons notification %+v (%v)", got, err)
	}
	return *change.Value.Mask
}

// contract: exposure.host-buttons.notifies-mask-change
func TestButtonsNotifyEachMaskChange(t *testing.T) {
	backend := buttonsBackend{fakeBackend: newFakeBackend()}
	endpoint, address, _ := serve(t, &backend)
	backend.buttons = host.NewButtons(func(value map[string]any) { endpoint.NotifyWatchers("host.buttons", value) })
	conn := dial(t, address)
	read := func() (message, error) { return receive(t, conn) }
	watch := map[string]any{"window": "main", "name": "host.buttons"}
	if got := call(t, conn, 1, "status.watch", watch); got.Error != nil {
		t.Fatalf("status.watch: %+v", got)
	}
	if got := call(t, conn, 2, "status.get", watch); got.Error != nil || string(got.Result) != `{"mask":0}` {
		t.Fatalf("host.buttons before a report: %+v", got)
	}
	// A report of the same mask is not announced. The next notification is the next different mask.
	backend.buttons.Report(0)
	backend.buttons.Report(1)
	if mask := nextMask(t, read); mask != 1 {
		t.Fatalf("first notification mask %d, want 1", mask)
	}
	backend.buttons.Report(1)
	backend.buttons.Report(3)
	backend.buttons.Report(0)
	if mask := nextMask(t, read); mask != 3 {
		t.Fatalf("second notification mask %d, want 3", mask)
	}
	if mask := nextMask(t, read); mask != 0 {
		t.Fatalf("third notification mask %d, want 0", mask)
	}
	// A remaining notification comes before the reply to this request.
	if got := call(t, conn, 3, "status.get", watch); got.Error != nil || string(got.Result) != `{"mask":0}` {
		t.Fatalf("host.buttons after the reports: %+v", got)
	}
}
