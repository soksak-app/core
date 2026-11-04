package workbench_test

import (
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

func drawPlugins(page *workbench.PluginPage, errors *workbench.ShownErrors, run workbench.RunCommand) *ui.Tester {
	return ui.NewTester(func(c *ui.Context) {
		workbench.DrawPluginPage(c, workbench.NewElementNames(), *page, errors, run)
	}, 640, 900)
}

func noErrors() *workbench.ShownErrors { return workbench.NewShownErrors(func(string) {}) }

func TestAPluginCardShowsItsStateVersionsAndSidecars(t *testing.T) {
	page := hostedPlugins()
	tt := drawPlugins(&page, noErrors(), func(string, map[string]any) {})
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

func TestTheActionsOfACardFollowThePlugin(t *testing.T) {
	var calls []call
	page := hostedPlugins()
	tt := drawPlugins(&page, noErrors(), record(&calls))
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
	tt := drawPlugins(&page, noErrors(), record(&calls))
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

func TestAFailedOperationShowsItsErrorOnItsCard(t *testing.T) {
	var lines []string
	errors := workbench.NewShownErrors(func(line string) { lines = append(lines, line) })
	page := hostedPlugins()
	page.Operation = &workbench.PluginOperation{Action: "update", Plugin: "alpha", State: "failed", Error: "no network"}
	tt := drawPlugins(&page, errors, func(string, map[string]any) {})
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
	tt := drawPlugins(&page, noErrors(), func(name string, params map[string]any) {
		calls = append(calls, call{name, params})
		page.Query = params["query"].(string)
	})
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
	tt := drawPlugins(&page, noErrors(), record(&calls))
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
	tt := drawPlugins(&page, errors, func(string, map[string]any) {})
	if _, ok := keyedAt(tt.ElementTree(), workbench.ElementName{Name: "core.library.app.release", Index: 0}); ok {
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
	tt := drawPlugins(&page, noErrors(), record(&calls))
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
	tt := drawPlugins(&page, noErrors(), func(string, map[string]any) {})
	if !tt.HasText("플러그인 상태를 읽지 못했습니다: bad file") || tt.HasText("찾는 플러그인이 없습니다.") {
		t.Fatalf("the page shows %q", tt.Texts())
	}
}

func TestARegistryThatCannotBeReadKeepsTheCards(t *testing.T) {
	page := hostedPlugins()
	page.Failure = &workbench.PluginFailure{Kind: "index", Message: "offline"}
	tt := drawPlugins(&page, noErrors(), func(string, map[string]any) {})
	if !tt.HasText("레지스트리를 읽지 못했습니다: offline") || !tt.HasText("Alpha") {
		t.Fatalf("the page shows %q", tt.Texts())
	}
}

func TestWithoutAHostThePageHasNoAction(t *testing.T) {
	page := hostedPlugins()
	page.Hosted = false
	tt := drawPlugins(&page, noErrors(), func(string, map[string]any) {})
	if _, ok := keyedAt(tt.ElementTree(), workbench.ElementName{Name: "core.library.plugins.action", Index: 0}); ok {
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
	tt := drawPlugins(&page, errors, func(string, map[string]any) {})
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
	tt := drawPlugins(&page, errors, func(string, map[string]any) {})
	if !tt.HasText("version next must be x.y.z with numeric parts and no leading zeros") {
		t.Fatalf("the card shows %q", tt.Texts())
	}
	if got := workbench.PluginPageActions(page)[0]; got.Action != "disable" {
		t.Fatalf("the first action is %+v", got)
	}
}
