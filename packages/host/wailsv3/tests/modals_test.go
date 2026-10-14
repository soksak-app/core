package host_test

import (
	"reflect"
	"testing"

	host "github.com/soksak-app/core/packages/host/wailsv3/src"
)

// contract: overlay.pick.dropped-is-recorded
func TestAReplyOfAModalThatIsNotOpenIsDroppedWithTheFieldsOfItsRecord(t *testing.T) {
	open := &host.OpenModal{ID: "debug", Instance: 62}
	if fields, dropped := host.OverlayPickDropped(open, "debug", 62, "save-all"); dropped || fields != nil {
		t.Fatalf("the reply of the open modal was dropped with %v", fields)
	}
	cases := []struct {
		open     *host.OpenModal
		id       string
		instance uint64
		want     map[string]any
	}{
		{open, "debug", 61, map[string]any{"id": "debug", "instance": uint64(61), "key": "save-all", "open": "debug"}},
		{open, "settings", 62, map[string]any{"id": "settings", "instance": uint64(62), "key": "save-all", "open": "debug"}},
		{nil, "debug", 62, map[string]any{"id": "debug", "instance": uint64(62), "key": "save-all", "open": ""}},
	}
	for _, c := range cases {
		fields, dropped := host.OverlayPickDropped(c.open, c.id, c.instance, "save-all")
		if !dropped || !reflect.DeepEqual(fields, c.want) {
			t.Fatalf("drop of %s %d with %v: %v %v, want %v", c.id, c.instance, c.open, dropped, fields, c.want)
		}
	}
}
