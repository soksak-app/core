package workbench_test

import (
	"encoding/json"
	"strings"
	"testing"

	workbench "github.com/soksak-app/core/packages/workbench-mygo/src"
)

// The notices of the outdated persistent services (docs/spec/persistent-services.md#updates): one warning per service through the
// notice store, with the title and the text of the web workbench, and withdrawn when the service leaves outdated.

func strptr(s string) *string { return &s }

// The notice of a service that sent a version names both versions, its sessions and the action that ends it.
func TestAnOutdatedServiceShowsOneWarningWithTheWebTitleTextAndAction(t *testing.T) {
	store := workbench.NewShownErrors(func(string) {})
	notices := workbench.NewOutdatedNotices(store)
	notices.Reconcile([]workbench.OutdatedSidecar{{Sidecar: "@fixture/echo", Running: strptr("0.0.6"), Installed: strptr("0.0.7"), Sessions: 2}}, noSurfaces)
	toasts := store.ToastStatuses()
	if len(toasts) != 1 || toasts[0].Kind != "warning" {
		t.Fatalf("toasts = %+v, want one warning", toasts)
	}
	if want := "@fixture/echo 0.0.6이 실행 중이고 설치된 버전은 0.0.7다"; toasts[0].Title != want {
		t.Fatalf("title = %q, want %q", toasts[0].Title, want)
	}
	entries := store.EntryStatuses()
	if len(entries) != 1 {
		t.Fatalf("entries = %+v, want one", entries)
	}
	if want := "세션 2개가 이 서비스를 쓰고 있다. 세션이 모두 끝나면 서비스가 자동으로 교체된다. 교체를 누르면 세션 2개가 끝나고 설치된 버전이 시작된다."; entries[0]["text"] != want {
		t.Fatalf("text = %q, want %q", entries[0]["text"], want)
	}
	if entries[0]["source"] != (workbench.NoticeSource{Kind: "core"}) {
		t.Fatalf("source = %+v, want core", entries[0]["source"])
	}
	actions := entries[0]["actions"].([]workbench.NoticeAction)
	if len(actions) != 1 || actions[0].Label != "교체" || actions[0].Command != "core.plugins.replace" || actions[0].Params["sidecar"] != "@fixture/echo" {
		t.Fatalf("actions = %+v, want the replace action of the service", actions)
	}
}

// A service that sent no version is named without a version.
func TestAServiceThatSentNoVersionIsNamedWithoutOne(t *testing.T) {
	store := workbench.NewShownErrors(func(string) {})
	workbench.NewOutdatedNotices(store).Reconcile([]workbench.OutdatedSidecar{{Sidecar: "@fixture/echo", Installed: strptr("0.0.7"), Sessions: 0}}, noSurfaces)
	if got, want := store.ToastStatuses()[0].Title, "@fixture/echo 서비스가 버전 없이 실행 중이고 설치된 버전은 0.0.7다"; got != want {
		t.Fatalf("title = %q, want %q", got, want)
	}
}

// A repeated list shows no second notice for a service that is still outdated, and each service has its own notice.
func TestARepeatedListShowsNoNewNoticeForAShownService(t *testing.T) {
	store := workbench.NewShownErrors(func(string) {})
	notices := workbench.NewOutdatedNotices(store)
	list := []workbench.OutdatedSidecar{
		{Sidecar: "@fixture/echo", Running: strptr("0.0.6"), Installed: strptr("0.0.7"), Sessions: 2},
		{Sidecar: "@fixture/other", Installed: strptr("1.0.0"), Sessions: 0},
	}
	notices.Reconcile(list, noSurfaces)
	notices.Reconcile(list, noSurfaces)
	if n := len(store.ToastStatuses()); n != 2 {
		t.Fatalf("toasts = %d, want one per service", n)
	}
	for _, toast := range store.ToastStatuses() {
		if toast.Count != 1 {
			t.Fatalf("toast %q count = %d, want 1 after a repeated list", toast.Title, toast.Count)
		}
	}
}

// A service that leaves the list is withdrawn from its toast, and its center entry stays.
func TestAServiceThatLeavesTheListIsWithdrawnAndItsEntryStays(t *testing.T) {
	store := workbench.NewShownErrors(func(string) {})
	notices := workbench.NewOutdatedNotices(store)
	echo := workbench.OutdatedSidecar{Sidecar: "@fixture/echo", Running: strptr("0.0.6"), Installed: strptr("0.0.7"), Sessions: 2}
	other := workbench.OutdatedSidecar{Sidecar: "@fixture/other", Running: strptr("0.1.0"), Installed: strptr("0.2.0"), Sessions: 1}
	notices.Reconcile([]workbench.OutdatedSidecar{echo, other}, noSurfaces)
	notices.Reconcile([]workbench.OutdatedSidecar{other}, noSurfaces)
	toasts := store.ToastStatuses()
	if len(toasts) != 1 || toasts[0].Title != "@fixture/other 0.1.0이 실행 중이고 설치된 버전은 0.2.0다" {
		t.Fatalf("toasts = %+v, want only the notice of the other service", toasts)
	}
	if n := len(store.EntryStatuses()); n != 2 {
		t.Fatalf("entries = %d, want 2 (the withdrawn entry stays)", n)
	}
	for _, entry := range store.EntryStatuses() {
		if title, _ := entry["title"].(string); strings.HasPrefix(title, "@fixture/echo") && entry["read"] != true {
			t.Fatalf("the withdrawn notice entry %v is unread, want read", title)
		}
	}
}

// outdatedEntries returns the entries of the status core.notices of the shell, newest first, with their text and count.
func (f *shellFixture) outdatedEntries() []struct {
	Title string `json:"title"`
	Text  string `json:"text"`
	Count int    `json:"count"`
} {
	f.t.Helper()
	var notices struct {
		Entries []struct {
			Title string `json:"title"`
			Text  string `json:"text"`
			Count int    `json:"count"`
		} `json:"entries"`
	}
	if err := json.Unmarshal([]byte(f.status("core.notices")), &notices); err != nil {
		f.t.Fatalf("core.notices is %s: %v", f.status("core.notices"), err)
	}
	return notices.Entries
}

// A service that is outdated when the window starts shows its warning through the shell, with the title of the web workbench.
func TestAnOutdatedServiceAtStartShowsItsWarningThroughTheShell(t *testing.T) {
	plugins := &pluginsHost{registry: "file:///registry/index.json", index: registryOf(map[string][]string{})}
	plugins.outdated = []any{map[string]any{"sidecar": "hello", "running": "1.0.0", "installed": "2.0.0", "sessions": 2}}
	f := pluginShell(t, plugins, "")
	f.settle()
	toasts := f.toasts()
	if len(toasts) != 1 || toasts[0].Kind != "warning" || toasts[0].Title != "hello 1.0.0이 실행 중이고 설치된 버전은 2.0.0다" {
		t.Fatalf("core.toasts is %+v, want one warning with the web title", toasts)
	}
}

// A sidecars-changed event that leaves the service out of the list closes its toast.
func TestASidecarsChangedThatRemovesTheServiceClosesItsToast(t *testing.T) {
	plugins := &pluginsHost{registry: "file:///registry/index.json", index: registryOf(map[string][]string{})}
	plugins.outdated = []any{map[string]any{"sidecar": "hello", "running": "1.0.0", "installed": "2.0.0", "sessions": 2}}
	f := pluginShell(t, plugins, "")
	f.settle()
	if toasts := f.toasts(); len(toasts) != 1 {
		t.Fatalf("core.toasts is %+v before the change, want the warning of the service", toasts)
	}
	plugins.outdated = []any{}
	f.shell.Event("sidecars-changed", nil)
	f.settle()
	if toasts := f.toasts(); len(toasts) != 0 {
		t.Fatalf("core.toasts is %+v after the service left the list, want none", toasts)
	}
}

// A sidecars-changed event that keeps the service with a new session count rewrites its notice text and keeps its count.
func TestASidecarsChangedWithANewSessionCountRewritesTheNoticeText(t *testing.T) {
	plugins := &pluginsHost{registry: "file:///registry/index.json", index: registryOf(map[string][]string{})}
	plugins.outdated = []any{map[string]any{"sidecar": "hello", "running": "1.0.0", "installed": "2.0.0", "sessions": 2}}
	f := pluginShell(t, plugins, "")
	f.settle()
	plugins.outdated = []any{map[string]any{"sidecar": "hello", "running": "1.0.0", "installed": "2.0.0", "sessions": 3}}
	f.shell.Event("sidecars-changed", nil)
	f.settle()
	entries := f.outdatedEntries()
	if len(entries) != 1 || entries[0].Count != 1 || !strings.HasPrefix(entries[0].Text, "세션 3개가 이 서비스를 쓰고 있다.") {
		t.Fatalf("core.notices entries are %+v, want one entry with count 1 and the text of 3 sessions", entries)
	}
}

// noSurfaces names no tab for any surface, so a service shows no card notice.
var noSurfaces = func(string) (workbench.NoticeSource, bool) { return workbench.NoticeSource{}, false }

// cardsShown returns the cards of the unread card notices of the center; a withdrawn notice keeps its entry, read.
func cardsShown(store *workbench.ShownErrors) []string {
	var cards []string
	for _, entry := range store.EntryStatuses() {
		source := entry["source"].(workbench.NoticeSource)
		if source.Kind == "card" && entry["read"] != true {
			cards = append(cards, source.Card)
		}
	}
	return cards
}

// A service that holds a session on a surface shows its warning as a card notice on the card of that surface, and the notice is
// withdrawn when the surface leaves the service's surfaces.
func TestAServiceOnASurfaceShowsItsWarningAsACardNoticeOnItsCard(t *testing.T) {
	store := workbench.NewShownErrors(func(string) {})
	notices := workbench.NewOutdatedNotices(store)
	targets := func(surface string) (workbench.NoticeSource, bool) {
		if surface == "surface-1" {
			return workbench.NoticeSource{Kind: "card", Card: "card-a", Tab: "surface-1", Plugin: "plugin"}, true
		}
		return workbench.NoticeSource{}, false
	}
	service := workbench.OutdatedSidecar{Sidecar: "@fixture/echo", Running: strptr("0.0.6"), Installed: strptr("0.0.7"), Sessions: 2,
		Surfaces: []string{"surface-1", "surface-2"}}
	notices.Reconcile([]workbench.OutdatedSidecar{service}, targets)
	if got := cardsShown(store); len(got) != 1 || got[0] != "card-a" {
		t.Fatalf("card notices = %v, want one on card-a; surface-2 has no tab", got)
	}
	service.Surfaces = []string{"surface-2"}
	notices.Reconcile([]workbench.OutdatedSidecar{service}, targets)
	if got := cardsShown(store); len(got) != 0 {
		t.Fatalf("card notices after surface-1 left = %v, want none", got)
	}
}
