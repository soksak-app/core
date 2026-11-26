package host

import (
	"encoding/json"
	"testing"
)

// noticeWindow is a window of a test that records the notices that the host sends to it.
type noticeWindow struct {
	frontendNumbered
	notices *[]string
}

func (w *noticeWindow) Emit(name string, _ ...any) { *w.notices = append(*w.notices, name) }

// The host answers each stored entry of a plugin key with workspace-changed to every window, and a replace that stored nothing notifies
// no window (docs/spec/plugins.md#plugin-data).
// contract: workspace.plugin-data.notifies-stored-entries
func TestAStoredPluginEntryNotifiesEveryWindowAndARefusedReplaceNone(t *testing.T) {
	h := &Host{workspace: NewWorkspace(t.TempDir()), windows: map[uint]*Surfaces{}}
	var first, second []string
	for id, notices := range map[uint]*[]string{1: &first, 2: &second} {
		h.windows[id] = &Surfaces{window: &noticeWindow{frontendNumbered: frontendNumbered{id: id}, notices: notices}}
	}
	request := func(base string) (any, error) {
		raw := `{"kind":"pluginData","plugin":"probe","key":"marks","entry":{"format":1,"value":2}` + base + `}`
		return h.Workspace(json.RawMessage(raw))
	}
	if stored, err := request(""); err != nil || stored != true {
		t.Fatalf("pluginData = %v %v, want true", stored, err)
	}
	if len(first) != 1 || first[0] != "workspace-changed" || len(second) != 1 || second[0] != "workspace-changed" {
		t.Fatalf("the windows received %v and %v after a stored entry, want workspace-changed each", first, second)
	}
	if stored, err := request(`,"base":1,"default":0`); err != nil || stored != false {
		t.Fatalf("pluginData on another base = %v %v, want false", stored, err)
	}
	if len(first) != 1 || len(second) != 1 {
		t.Fatalf("the windows received %v and %v after a replace that stored nothing, want no other notice", first, second)
	}
}
