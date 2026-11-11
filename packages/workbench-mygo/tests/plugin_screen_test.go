package workbench_test

import (
	"fmt"
	"math"
	"reflect"
	"slices"
	"testing"

	"github.com/egoist/mygo/ui"

	workbench "github.com/soksak-app/core/packages/workbench-mygo/src"
)

func stringOf(v string) *string { return &v }

func hostedPlugins() workbench.PluginPage {
	core := "0.5.0"
	return workbench.PluginPage{
		Hosted: true, Core: &core,
		Plugins: []workbench.PluginRow{
			{ID: "alpha", Name: "Alpha", Description: "First tool", State: "loaded",
				Installed: &workbench.PluginInstalled{Version: "1.0.0", Enabled: true}, Latest: stringOf("1.2.0"),
				Sidecars: []workbench.PluginSidecar{{Name: "hello", Version: stringOf("2.0.0")}, {Name: "other", Range: stringOf("^1.0.0")}}},
			{ID: "beta", Name: "Beta", Description: "Second tool", State: "available", Latest: stringOf("3.0.0"), Sidecars: []workbench.PluginSidecar{}},
			{ID: "gamma", Name: "gamma", State: "reload", Installed: &workbench.PluginInstalled{Version: "1.0.0", Enabled: false}, Incompatible: true},
		},
	}
}

func drawPlugins(page *workbench.PluginPage, errors *workbench.ShownErrors, binder *workbench.Binder) *ui.Tester {
	return ui.NewTester(func(c *ui.Context) {
		workbench.DrawPluginSearch(c, binder, page.Query, func(field ui.Element) ui.Element { return field.FillWidth() })
		workbench.DrawPluginPage(c, binder, *page, errors, workbench.PluginLook{LeastCard: 245, Gap: 10, Control: 12, Small: 11, Caption: 10, LineHeight: 1.45,
			Space1: 4, Space2: 8, Space3: 12, FieldPadY: 5, BorderWidth: 1})
	}, 640, 900)
}

func noErrors() *workbench.ShownErrors { return workbench.NewShownErrors(func(string) {}) }

func TestAPluginCardShowsItsStateVersionsAndSidecars(t *testing.T) {
	page := hostedPlugins()
	tt := drawPlugins(&page, noErrors(), recorder(t, new([]call), screenCommands...))
	for _, want := range []string{
		"Alpha", "alpha", "사용 중", "First tool", "설치된 버전 1.0.0 · 최신 버전 1.2.0", "사이드카 hello 2.0.0, other ^1.0.0",
		"Beta", "설치 안 됨", "최신 버전 3.0.0", "사이드카 없음",
		"창을 다시 불러오면 적용", "설치된 버전 1.0.0 · core 0.5.0에 맞는 버전 없음",
	} {
		if !tt.HasText(want) {
			t.Errorf("no text %q in %q", want, tt.Texts())
		}
	}
}

func TestThePluginsStandInColumnsOfCards(t *testing.T) {
	page := hostedPlugins()
	tt := drawPlugins(&page, noErrors(), recorder(t, new([]call), screenCommands...))
	first, _ := tt.Find("Alpha")
	second, _ := tt.Find("Beta")
	third, _ := tt.Find("gamma")
	if first.Y != second.Y || second.X <= first.X {
		t.Fatalf("the first two stand at %+v and %+v", first, second)
	}
	if third.Y <= first.Y || third.X != first.X {
		t.Fatalf("the third stands at %+v under %+v", third, first)
	}
}

func TestTheActionsOfACardFollowThePlugin(t *testing.T) {
	var calls []call
	page := hostedPlugins()
	tt := drawPlugins(&page, noErrors(), recorder(t, &calls, screenCommands...))
	want := []workbench.PluginAction{
		{Plugin: "alpha", Action: "update"}, {Plugin: "alpha", Action: "disable"}, {Plugin: "alpha", Action: "remove"},
		{Plugin: "beta", Action: "install"},
		{Plugin: "gamma", Action: "apply"}, {Plugin: "gamma", Action: "enable"}, {Plugin: "gamma", Action: "remove"},
	}
	if got := workbench.PluginPageActions(page); !slices.Equal(got, want) {
		t.Fatalf("actions %+v, want %+v", got, want)
	}
	pressPositional(t, tt, "core.library.plugins.action", 3)
	pressPositional(t, tt, "core.library.plugins.action", 4)
	wantCalls := []call{{"core.plugins.install", map[string]any{"plugin": "beta"}}, {"core.plugins.apply", map[string]any{}}}
	if !reflect.DeepEqual(calls, wantCalls) {
		t.Fatalf("commands %+v, want %+v", calls, wantCalls)
	}
}

func TestWhileAnOperationRunsEveryActionIsDisabled(t *testing.T) {
	var calls []call
	page := hostedPlugins()
	page.Operation = &workbench.PluginOperation{Action: "update", Plugin: "alpha", State: "running"}
	tt := drawPlugins(&page, noErrors(), recorder(t, &calls, screenCommands...))
	if !tt.HasText("alpha update 진행 중") {
		t.Fatalf("the card of the operation shows %q", tt.Texts())
	}
	for _, action := range workbench.PluginPageActions(page) {
		if !action.Disabled {
			t.Fatalf("an action is enabled: %+v", action)
		}
	}
	pressPositional(t, tt, "core.library.plugins.action", 3)
	if len(calls) != 0 {
		t.Fatalf("a disabled action ran %+v", calls)
	}
}

func TestADisabledActionRunsNothing(t *testing.T) {
	var calls []call
	page := hostedPlugins()
	page.Operation = &workbench.PluginOperation{Plugin: "beta", Action: "install", State: "running"}
	tt := drawPlugins(&page, noErrors(), recorder(t, &calls, screenCommands...))
	pressPositional(t, tt, "core.library.plugins.action", 0)
	tt.Frame()
	if len(calls) != 0 {
		t.Fatalf("a disabled action ran %+v", calls)
	}
}

func TestAFailedOperationShowsItsErrorOnItsCard(t *testing.T) {
	var lines []string
	errors := workbench.NewShownErrors(func(line string) { lines = append(lines, line) })
	page := hostedPlugins()
	page.Operation = &workbench.PluginOperation{Action: "update", Plugin: "alpha", State: "failed", Error: "no network"}
	tt := drawPlugins(&page, errors, recorder(t, new([]call), screenCommands...))
	if !tt.HasText("no network") {
		t.Fatalf("the card shows %q", tt.Texts())
	}
	if !slices.Equal(lines, []string{"library plugin alpha: no network"}) {
		t.Fatalf("written lines %q", lines)
	}
	page.Operation = nil
	tt.Frame()
	if _, shown := errors.Text("library plugin alpha"); shown {
		t.Fatal("the error stays after the failed operation ended")
	}
}

func TestTheSearchFiltersTheCardsAndRunsItsCommand(t *testing.T) {
	var calls []call
	page := hostedPlugins()
	page.Query = "SECOND"
	tt := drawPlugins(&page, noErrors(), recorder(t, &calls, screenCommands...))
	if tt.HasText("Alpha") || !tt.HasText("Beta") {
		t.Fatalf("the query shows %q", tt.Texts())
	}
	if got := workbench.ShownPlugins(page); !slices.Equal(got, []string{"beta"}) {
		t.Fatalf("shown plugins %q", got)
	}
	pressPositional(t, tt, "core.library.plugins.search", 0)
	tt.Type("x")
	if len(calls) != 1 || calls[0].name != "core.library.plugins.search" || calls[0].params["query"] != "SECONDx" {
		t.Fatalf("commands %+v", calls)
	}
	page.Query = calls[0].params["query"].(string)
	tt.Frame()
	if !tt.HasText("찾는 플러그인이 없습니다.") {
		t.Fatalf("a query without a match shows %q", tt.Texts())
	}
}

func TestTheUpdateListComesBeforeTheCards(t *testing.T) {
	var calls []call
	page := hostedPlugins()
	page.Updates = []workbench.PluginUpdate{{ID: "alpha", Installed: "1.0.0", Latest: "1.2.0"}}
	page.App = workbench.AppUpdate{Version: "0.5.0", Available: &workbench.AppVersion{Version: "0.6.0", Release: "https://example.test/r"},
		Incompatible: []workbench.AppIncompatible{{ID: "alpha", Installed: "1.0.0", Range: "^0.5.0", Compatible: stringOf("1.3.0")}, {ID: "beta", Installed: "1.0.0", Range: "^0.5.0"}}}
	tt := drawPlugins(&page, noErrors(), recorder(t, &calls, screenCommands...))
	if row := positional(t, tt, "core.library.plugins.updates", 0); row.Label != "alpha: 1.0.0 → 1.2.0" {
		t.Fatalf("the row of the update says %q", row.Label)
	}
	for _, want := range []string{"core: 0.5.0 → 0.6.0", "alpha 1.0.0 (^0.5.0): 0.6.0에 맞는 최신 버전 1.3.0", "beta 1.0.0 (^0.5.0): 0.6.0에 맞는 버전 없음"} {
		if !tt.HasText(want) {
			t.Errorf("no text %q in %q", want, tt.Texts())
		}
	}
	first, card := positional(t, tt, "core.library.app.row", 0), positional(t, tt, "core.library.plugins.action", 0)
	if first.Bounds.Y >= card.Bounds.Y {
		t.Fatalf("the update list at %v does not come before the cards at %v", first.Bounds.Y, card.Bounds.Y)
	}
	pressPositional(t, tt, "core.library.plugins.update-all", 0)
	pressPositional(t, tt, "core.library.app.release", 0)
	pressPositional(t, tt, "core.library.app.update", 0)
	want := []call{{"core.plugins.update-all", map[string]any{}}, {"core.app.release", map[string]any{}}, {"core.app.update", map[string]any{}}}
	if !reflect.DeepEqual(calls, want) {
		t.Fatalf("commands %+v, want %+v", calls, want)
	}
}

func TestAFailedApplicationUpdateIsShownInItsRow(t *testing.T) {
	var lines []string
	errors := workbench.NewShownErrors(func(line string) { lines = append(lines, line) })
	page := hostedPlugins()
	page.App = workbench.AppUpdate{Version: "0.5.0", Available: &workbench.AppVersion{Version: "0.6.0"},
		Operation: &workbench.AppOperation{Version: "0.6.0", State: "failed", Error: "no space"}}
	tt := drawPlugins(&page, errors, recorder(t, new([]call), screenCommands...))
	if !absent(tt, "core.library.app.release") {
		t.Fatal("a version without a release page shows the release button")
	}
	if !tt.HasText("0.6.0 업데이트하지 못했습니다: no space") {
		t.Fatalf("the row shows %q", tt.Texts())
	}
	if !slices.Equal(lines, []string{"library app update: 0.6.0 업데이트하지 못했습니다: no space"}) {
		t.Fatalf("written lines %q", lines)
	}
}

func TestAnOutdatedServiceHasItsReplaceAction(t *testing.T) {
	var calls []call
	page := hostedPlugins()
	page.Outdated = []workbench.OutdatedSidecar{
		{Sidecar: "hello", Running: stringOf("1.0.0"), Installed: stringOf("2.0.0"), Sessions: 3},
		{Sidecar: "gone", Sessions: 1},
	}
	tt := drawPlugins(&page, noErrors(), recorder(t, &calls, screenCommands...))
	for _, want := range []string{"hello: 1.0.0 → 2.0.0", "세션 3개를 끝내고 적용", "gone: 이전 버전 → 선언 없음", "세션 1개를 끝내고 종료"} {
		if !tt.HasText(want) {
			t.Errorf("no text %q in %q", want, tt.Texts())
		}
	}
	positional(t, tt, "core.library.plugins.outdated", 1)
	pressPositional(t, tt, "core.library.plugins.replace", 1)
	want := []call{{"core.plugins.replace", map[string]any{"sidecar": "gone"}}}
	if !reflect.DeepEqual(calls, want) {
		t.Fatalf("commands %+v, want %+v", calls, want)
	}
}

func TestAPluginStateThatCannotBeReadShowsItsReasonAndNoCards(t *testing.T) {
	page := workbench.PluginPage{Hosted: true, Failure: &workbench.PluginFailure{Kind: "state", Message: "bad file"}}
	tt := drawPlugins(&page, noErrors(), recorder(t, new([]call), screenCommands...))
	if !tt.HasText("플러그인 상태를 읽지 못했습니다: bad file") || tt.HasText("찾는 플러그인이 없습니다.") {
		t.Fatalf("the page shows %q", tt.Texts())
	}
}

func TestARegistryThatCannotBeReadKeepsTheCards(t *testing.T) {
	page := hostedPlugins()
	page.Failure = &workbench.PluginFailure{Kind: "index", Message: "offline"}
	tt := drawPlugins(&page, noErrors(), recorder(t, new([]call), screenCommands...))
	if !tt.HasText("레지스트리를 읽지 못했습니다: offline") || !tt.HasText("Alpha") {
		t.Fatalf("the page shows %q", tt.Texts())
	}
}

func TestWithoutAHostThePageHasNoAction(t *testing.T) {
	page := hostedPlugins()
	page.Hosted = false
	tt := drawPlugins(&page, noErrors(), recorder(t, new([]call), screenCommands...))
	if !absent(tt, "core.library.plugins.action") {
		t.Fatal("a page without a host has an action")
	}
	if got := workbench.PluginPageActions(page); len(got) != 0 {
		t.Fatalf("actions %+v", got)
	}
}

func TestAContributionShowsItsStateAndAnInvalidOneItsError(t *testing.T) {
	var lines []string
	errors := workbench.NewShownErrors(func(line string) { lines = append(lines, line) })
	page := hostedPlugins()
	page.Contributions = []workbench.PluginContribution{
		{Plugin: "alpha", Point: "git.panel", Index: 0, State: "connected"},
		{Plugin: "alpha", Point: "git.panel", Index: 1, State: "invalid", Reason: "no id"},
	}
	tt := drawPlugins(&page, errors, recorder(t, new([]call), screenCommands...))
	if !tt.HasText("git.panel 기여 1: 연결됨") || !tt.HasText("git.panel 기여 2: no id") {
		t.Fatalf("the card shows %q", tt.Texts())
	}
	if !slices.Equal(lines, []string{"library plugin alpha contribution git.panel 2: git.panel 기여 2: no id"}) {
		t.Fatalf("written lines %q", lines)
	}
}

func TestVersionsCompareByNumber(t *testing.T) {
	for _, test := range []struct {
		a, b string
		want int
	}{{"1.2.0", "1.10.0", -1}, {"2.0.0", "1.9.9", 1}, {"1.0.0", "1.0.0", 0}} {
		if got, err := workbench.CompareVersions(test.a, test.b); err != nil || got != test.want {
			t.Errorf("CompareVersions(%s, %s) = %d, %v, want %d", test.a, test.b, got, err, test.want)
		}
	}
	for _, version := range []string{"1.0", "1.0.0-beta", "01.0.0", "1.0.x"} {
		if _, err := workbench.CompareVersions(version, "1.0.0"); err == nil || err.Error() != "version "+version+" must be x.y.z with numeric parts and no leading zeros" {
			t.Errorf("CompareVersions(%s, 1.0.0) fails with %v", version, err)
		}
	}
}

func TestAVersionOfAnotherFormIsShownAndOffersNoUpdate(t *testing.T) {
	errors := noErrors()
	page := hostedPlugins()
	page.Plugins[0].Latest = stringOf("next")
	tt := drawPlugins(&page, errors, recorder(t, new([]call), screenCommands...))
	if !tt.HasText("version next must be x.y.z with numeric parts and no leading zeros") {
		t.Fatalf("the card shows %q", tt.Texts())
	}
	if got := workbench.PluginPageActions(page)[0]; got.Action != "disable" {
		t.Fatalf("the first action is %+v", got)
	}
}

// The description and each contribution line of a card are elements of their own names, as on the page, and a contribution line, its
// state or its error, has the caption size of .library-plugin__contribution.
func TestTheDescriptionAndContributionLinesOfACardAreNamedElements(t *testing.T) {
	page := hostedPlugins()
	page.Contributions = []workbench.PluginContribution{
		{Plugin: "alpha", Point: "db.items", Index: 0, State: "connected"},
		{Plugin: "alpha", Point: "db.items", Index: 1, State: "invalid", Reason: "no label"},
	}
	tt := drawPlugins(&page, noErrors(), recorder(t, new([]call), screenCommands...))
	if about := positional(t, tt, "core.library.plugins.about", 1); about.Label != "Second tool" {
		t.Fatalf("the second description line is %q", about.Label)
	}
	// Caption 10 at the line height 1.45 of drawPlugins.
	const line = 10 * 1.45
	for index, want := range []string{"db.items 기여 1: 연결됨", "db.items 기여 2: no label"} {
		node := positional(t, tt, "core.library.plugins.contribution", index)
		if node.Label != want || math.Abs(float64(node.Bounds.H)-line) > 0.01 {
			t.Errorf("contribution line %d is %q, %v high; want %q, %v high", index, node.Label, node.Bounds.H, want, line)
		}
	}
}

// A space is a break opportunity of the description also before a word that opens with a point, as on the page: the description of the
// layout probe takes five lines of its card at the window width of 1200, not six with "opens .lprobe" kept on one line.
func TestADescriptionBreaksAtTheSpaceBeforeAWordWithAPoint(t *testing.T) {
	const about = "Window check fixture that reports its tab reports, start values, surface size and a document region, opens .lprobe files, " +
		"and declares sections, settings and a right sidebar override."
	index := registryOf(map[string][]string{})
	index["plugins"] = []any{map[string]any{"id": "layoutprobe", "name": "Layout probe", "description": about,
		"versions": []any{map[string]any{"version": "0.0.40", "engines": map[string]string{"soksak": "*"}, "sidecars": map[string]string{}}}}}
	f := pluginShell(t, &pluginsHost{registry: "file:///registry/index.json", index: index}, `{"plugins":[]}`)
	f.run("core.library.page", map[string]string{"page": "plugins"})
	// Five lines of the small size 11 at the line height 1.45, in the description width 259 of a card of four columns.
	const lines = 5 * 11 * 1.45
	if box := f.box("core.library.plugins.about", "layoutprobe"); math.Abs(float64(box.W)-259) > 0.01 || math.Abs(float64(box.H)-lines) > 0.01 {
		t.Fatalf("the description is %v wide and %v high, want 259 wide and %v high", box.W, box.H, lines)
	}
}

// Under the classic scroller style the plugin page, whose cards overflow the library, lays its grid out beside the bar, as the grid
// of .library-plugins of the page: the four columns share the width less 17 points, each card 17/4 points narrower.
func TestThePluginPageGivesAClassicBarItsRoom(t *testing.T) {
	index := registryOf(map[string][]string{})
	plugins := []any{}
	for number := range 40 {
		plugins = append(plugins, map[string]any{"id": fmt.Sprintf("tool%02d", number), "name": fmt.Sprintf("Tool %d", number),
			"description": "A tool whose description takes a few lines of its card, so that the cards of forty tools overflow the library.",
			"versions": []any{map[string]any{"version": "0.0.40", "engines": map[string]string{"soksak": "*"}, "sidecars": map[string]string{}}}})
	}
	index["plugins"] = plugins
	f := pluginShell(t, &pluginsHost{registry: "file:///registry/index.json", index: index}, `{"plugins":[]}`)
	f.run("core.library.page", map[string]string{"page": "plugins"})
	first, second := f.box("core.library.plugins.about", "tool00"), f.box("core.library.plugins.about", "tool01")
	f.tester.SetPreferences(ui.Preferences{ClassicScrollbars: true, ClassicScrollbarWidth: 17, ThinClassicScrollbarWidth: 13})
	f.settle()
	got := f.box("core.library.plugins.about", "tool00")
	next := f.box("core.library.plugins.about", "tool01")
	if got.X != first.X || math.Abs(float64(got.W-(first.W-17.0/4))) > 0.01 || math.Abs(float64(next.X-(second.X-17.0/4))) > 0.01 {
		t.Fatalf("the descriptions are at x %v, %v wide, and x %v beside the classic bar, at x %v, %v wide, and x %v without; want each card 17/4 narrower",
			got.X, got.W, next.X, first.X, first.W, second.X)
	}
}
