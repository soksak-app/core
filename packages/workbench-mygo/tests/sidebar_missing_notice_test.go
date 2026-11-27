package workbench_test

import (
	"testing"

	"github.com/egoist/mygo/ui"

	workbench "github.com/soksak-app/core/packages/workbench-mygo/src"
	"github.com/soksak-app/core/packages/workbench-mygo/src/layout"
)

// drawLeftSidebar draws the left window sidebar of the fixture and fails the test on a frame error.
func drawLeftSidebar(t *testing.T, f *sidebarsFixture) *ui.Tester {
	t.Helper()
	var failed error
	tt := ui.NewTester(func(c *ui.Context) {
		f.sidebars.Begin()
		frame, err := f.sidebars.Frame("left", "spc-1", workbench.FocusedSurface{})
		if err != nil {
			failed = err
			return
		}
		f.sidebars.Draw(c, frame, layout.Rect{X: 10, Y: 20, W: 190, H: 480})
	}, 320, 520)
	if failed != nil {
		t.Fatal(failed)
	}
	return tt
}

// newSidebarsWithPlugin is newSidebars with a notice store and a plugin state that the test changes.
func newSidebarsWithPlugin(t *testing.T, state *string, notices *workbench.ShownErrors) *sidebarsFixture {
	t.Helper()
	declared, err := workbench.Declared()
	if err != nil {
		t.Fatal(err)
	}
	fixture := &sidebarsFixture{registry: workbench.NewRegistry(declared), notices: notices}
	binder := workbench.NewBinder(fixture.registry, func(command string, err error) { t.Errorf("%s: %v", command, err) })
	fixture.sidebars, err = workbench.NewSidebars(workbench.SidebarsOptions{Look: func() (float32, float32) { return 1, 10 }, Declared: declared, Registry: fixture.registry, Binder: binder,
		Environment: []byte(sidebarsEnvironment), Installed: []byte(sidebarsInstalled), Notices: notices,
		Plugin:  func(string) workbench.PluginLine { return workbench.PluginLine{Name: "gone", State: *state} },
		Changed: func() { fixture.changes++ }, Seat: func(_ *ui.Context, seat workbench.SidebarSeat) { fixture.seats = append(fixture.seats, seat) }})
	if err != nil {
		t.Fatal(err)
	}
	return fixture
}

// The missing plugin of a window sidebar is a warning notice whose source is the sidebar, shown on its status line and as a toast; the
// sidebar has no line above its sections (docs/spec/plugins.md#missing-plugins, docs/spec/notifications.md#sidebar-notice).
func TestTheMissingPluginOfAWindowSidebarIsAWarningNoticeOnItsStatusLine(t *testing.T) {
	state := ""
	f := newSidebarsWithPlugin(t, &state, workbench.NewShownErrors(func(string) {}))
	tt := drawLeftSidebar(t, f)
	if !tt.HasText("gone · 플러그인이 없어 섹션 1개를 못 보여 준다.") {
		t.Fatalf("the status line shows %q", tt.Texts())
	}
	set := element(t, tt, "core.sidebar", "left")
	if _, ok := exposedNode(set.Children, "core.sidebar.missing", "gone"); ok {
		t.Fatal("a warning line stands above the sections of the sidebar")
	}
	entries := f.notices.EntryStatuses()
	if len(entries) != 1 || entries[0]["title"] != "gone" || entries[0]["kind"] != "warning" {
		t.Fatalf("the notice center holds %+v", entries)
	}
	if source := entries[0]["source"].(workbench.NoticeSource); source.Kind != "sidebar" || source.Sidebar != "left" {
		t.Fatalf("the source of the notice is %+v", source)
	}
	if toasts := f.notices.ToastStatuses(); len(toasts) != 1 || toasts[0].Title != "gone" {
		t.Fatalf("the toasts are %+v", toasts)
	}
}

// A redraw of the same missing plugin keeps one notice, and a plugin that is reloading withdraws it from the status line and the toasts
// while the notice center keeps its entry (docs/spec/notifications.md#sidebar-notice).
func TestTheMissingPluginNoticeIsWithdrawnWhenThePluginReloads(t *testing.T) {
	state := ""
	notices := workbench.NewShownErrors(func(string) {})
	f := newSidebarsWithPlugin(t, &state, notices)
	drawLeftSidebar(t, f)
	tt := drawLeftSidebar(t, f)
	if n := len(notices.EntryStatuses()); n != 1 {
		t.Fatalf("a redraw of the same plugin holds %d notices, want 1", n)
	}
	state = "reload"
	tt = drawLeftSidebar(t, f)
	if tt.HasText("gone · 플러그인이 없어 섹션 1개를 못 보여 준다.") {
		t.Fatal("the status line still shows the withdrawn notice")
	}
	if toasts := notices.ToastStatuses(); len(toasts) != 0 {
		t.Fatalf("the withdrawn notice is still a toast: %+v", toasts)
	}
	if n := len(notices.EntryStatuses()); n != 1 {
		t.Fatalf("the notice center holds %d entries after the withdrawal, want the entry kept", n)
	}
}

// A card sidebar's notice shows no toast while its card has the focus, and the notice center keeps its entry; a window sidebar's notice
// is a toast (docs/spec/notifications.md#sidebar-notice).
func TestACardSidebarNoticeHasNoToastWhileItsCardHasTheFocus(t *testing.T) {
	notices := workbench.NewShownErrors(func(string) {})
	notices.SetFocusSource(func() string { return "card-f" })
	warning := workbench.NoticeFields{Kind: "warning", Title: "carded(carded)", Text: "플러그인이 없어 섹션 1개를 못 보여 준다."}
	notices.NotifyFrom("missing-plugin:card-f:left:carded", warning, workbench.NoticeSource{Kind: "sidebar", Card: "card-f", Sidebar: "card-f:left", Plugin: "carded"})
	if toasts := notices.ToastStatuses(); len(toasts) != 0 {
		t.Fatalf("a focused card's sidebar notice is a toast: %+v", toasts)
	}
	if n := len(notices.EntryStatuses()); n != 1 {
		t.Fatalf("the notice center holds %d entries, want the entry of the sidebar notice", n)
	}
	notices.NotifyFrom("missing-plugin:left:window", workbench.NoticeFields{Kind: "warning", Title: "window(window)", Text: "플러그인이 없어 섹션 1개를 못 보여 준다."},
		workbench.NoticeSource{Kind: "sidebar", Sidebar: "left", Plugin: "window"})
	if toasts := notices.ToastStatuses(); len(toasts) != 1 || toasts[0].Title != "window(window)" {
		t.Fatalf("a window sidebar's notice is not a toast: %+v", toasts)
	}
}
