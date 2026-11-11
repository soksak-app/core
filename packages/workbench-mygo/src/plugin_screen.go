package workbench

import (
	"errors"
	"fmt"
	"regexp"
	"slices"
	"strconv"
	"strings"

	"github.com/egoist/mygo/ui"
)

// The plugin screen, the plugin page of the library (docs/spec/installation.md#plugin-screen). Its values are those of
// `core.plugins`, and it runs the plugin operations through their commands.

// PluginInstalled is what installed.json records of a plugin.
type PluginInstalled struct {
	Version string `json:"version"`
	Enabled bool   `json:"enabled"`
}

// PluginSidecar is a sidecar that a plugin names. Version and Range are nil when they are unknown.
type PluginSidecar struct {
	Name    string  `json:"name"`
	Range   *string `json:"range"`
	Version *string `json:"version"`
}

// PluginRow is an entry of `plugins` of `core.plugins`. Sidecars is nil for an incompatible plugin that is neither installed
// nor loaded.
type PluginRow struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
	State       string `json:"state"`
	// Composition is the kind of the surface composition of a loaded plugin, and nil without one.
	Composition  *string          `json:"composition"`
	Installed    *PluginInstalled `json:"installed"`
	Latest       *string          `json:"latest"`
	Incompatible bool             `json:"incompatible"`
	Sidecars     []PluginSidecar  `json:"sidecars"`
}

// PluginOperation is `operation` of `core.plugins`.
type PluginOperation struct {
	Action string
	Plugin string
	State  string
	Error  string
}

// PluginUpdate is an entry of `updates` of `core.plugins`.
type PluginUpdate struct {
	ID        string `json:"id"`
	Installed string `json:"installed"`
	Latest    string `json:"latest"`
}

// OutdatedSidecar is an entry of `outdated` of `core.plugins`. Running is nil for a service that sent no version, and
// Installed is nil for a sidecar that is no longer declared.
type OutdatedSidecar struct {
	Sidecar   string  `json:"sidecar"`
	Running   *string `json:"running"`
	Installed *string `json:"installed"`
	Sessions  int     `json:"sessions"`
}

// PluginFailure is why the plugin state or the registry index could not be read. Kind is `state` or `index`.
type PluginFailure struct {
	Kind    string
	Message string
}

// PluginContribution is a contribution of a plugin to an extension point.
type PluginContribution struct {
	Plugin string
	Point  string
	Index  int
	State  string
	Reason string
}

// AppVersion is the candidate of the application update.
type AppVersion struct {
	Version string
	Release string
}

// AppIncompatible is an installed plugin whose range does not contain the candidate. Compatible is nil without a version that does.
type AppIncompatible struct {
	ID         string
	Installed  string
	Range      string
	Compatible *string
}

// AppOperation is the running or failed application update. State is `staging`, `applying` or `failed`.
type AppOperation struct {
	Version string
	State   string
	Error   string
}

// AppUpdate is the state of the application update.
type AppUpdate struct {
	Version      string
	Available    *AppVersion
	Incompatible []AppIncompatible
	Operation    *AppOperation
	// Error is the failure of the last read of the candidate.
	Error string
}

// PluginPage is what the plugin screen draws.
type PluginPage struct {
	// Hosted is false without a host, where the page has only the loaded plugins and no action.
	Hosted        bool
	Core          *string
	Query         string
	Failure       *PluginFailure
	Plugins       []PluginRow
	Operation     *PluginOperation
	Updates       []PluginUpdate
	Outdated      []OutdatedSidecar
	App           AppUpdate
	Contributions []PluginContribution
	// Reveal brings the update list into view in this frame.
	Reveal bool
}

// PluginAction is an action button of a card, in the position of its element name: an entry of `actions` of `core.library`.
type PluginAction struct {
	Plugin   string `json:"plugin"`
	Action   string `json:"action"`
	Disabled bool   `json:"disabled"`
}

var pluginStates = map[string]string{
	"loaded": "사용 중", "disabled": "사용 안 함", "available": "설치 안 됨", "reload": "창을 다시 불러오면 적용", "refused": "불러오지 못함",
}

var contributionStates = map[string]string{
	"connected": "연결됨", "provider-missing": "제공자 없음", "version-mismatch": "version 불일치", "invalid": "오류",
}

var versionForm = regexp.MustCompile(`^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$`)

func versionParts(version string) ([3]int, error) {
	var parts [3]int
	match := versionForm.FindStringSubmatch(version)
	if match == nil {
		return parts, errors.New("version " + version + " must be x.y.z with numeric parts and no leading zeros")
	}
	for i := range parts {
		number, err := strconv.Atoi(match[i+1])
		if err != nil {
			return parts, err
		}
		parts[i] = number
	}
	return parts, nil
}

// CompareVersions compares two versions by number, as compareVersions of @soksak/plugin-api does.
func CompareVersions(a, b string) (int, error) {
	left, err := versionParts(a)
	if err != nil {
		return 0, err
	}
	right, err := versionParts(b)
	if err != nil {
		return 0, err
	}
	return slices.Compare(left[:], right[:]), nil
}

func hasUpdate(row PluginRow) (bool, error) {
	if row.Installed == nil || row.Latest == nil {
		return false, nil
	}
	order, err := CompareVersions(*row.Latest, row.Installed.Version)
	return order > 0, err
}

// ShownPlugins returns the ids of the plugins of the cards, in order: those whose id, name or description contains the
// query, ignoring letter case.
func ShownPlugins(page PluginPage) []string {
	ids := []string{}
	for _, row := range shownRows(page) {
		ids = append(ids, row.ID)
	}
	return ids
}

func shownRows(page PluginPage) []PluginRow {
	needle := strings.ToLower(page.Query)
	rows := []PluginRow{}
	for _, row := range page.Plugins {
		for _, text := range []string{row.ID, row.Name, row.Description} {
			if strings.Contains(strings.ToLower(text), needle) {
				rows = append(rows, row)
				break
			}
		}
	}
	return rows
}

func cardActions(page PluginPage, row PluginRow) []PluginAction {
	if !page.Hosted {
		return nil
	}
	disabled := page.Operation != nil && page.Operation.State == "running"
	actions := []PluginAction{}
	add := func(action string) {
		actions = append(actions, PluginAction{Plugin: row.ID, Action: action, Disabled: disabled})
	}
	if row.Installed == nil && row.Latest != nil {
		add("install")
	}
	if update, err := hasUpdate(row); update && err == nil {
		add("update")
	}
	if row.State == "reload" {
		add("apply")
	}
	if row.Installed != nil {
		if row.Installed.Enabled {
			add("disable")
		} else {
			add("enable")
		}
		add("remove")
	}
	return actions
}

// PluginPageActions returns the action buttons of the cards in document order.
func PluginPageActions(page PluginPage) []PluginAction {
	actions := []PluginAction{}
	for _, row := range shownRows(page) {
		actions = append(actions, cardActions(page, row)...)
	}
	return actions
}

func actionLabel(action string) string {
	return map[string]string{"install": "설치", "update": "업데이트", "apply": "적용", "enable": "사용", "disable": "사용 안 함", "remove": "제거"}[action]
}

func sidecarLine(sidecars []PluginSidecar) string {
	if len(sidecars) == 0 {
		return "사이드카 없음"
	}
	items := make([]string, len(sidecars))
	for i, sidecar := range sidecars {
		items[i] = sidecar.Name
		switch {
		case sidecar.Version != nil:
			items[i] += " " + *sidecar.Version
		case sidecar.Range != nil:
			items[i] += " " + *sidecar.Range
		}
	}
	return "사이드카 " + strings.Join(items, ", ")
}

func versionLine(page PluginPage, row PluginRow) string {
	parts := []string{}
	if row.Installed != nil {
		parts = append(parts, "설치된 버전 "+row.Installed.Version)
	}
	if row.Latest != nil {
		parts = append(parts, "최신 버전 "+*row.Latest)
	}
	if row.Incompatible {
		core := ""
		if page.Core != nil {
			core = *page.Core
		}
		parts = append(parts, "core "+core+"에 맞는 버전 없음")
	}
	return strings.Join(parts, " · ")
}

// PluginLook is the theme and the lengths of the plugin page, which the window gives. LeastCard is the least width of a card.
type PluginLook struct {
	Bg, Card, Fg, Muted, Edge, Rail, No          ui.Color
	Control, Small, Caption, LineHeight          float32
	Radius, RadiusSmall, BorderWidth, Gap        float32
	Space1, Space2, Space3, FieldPadY, LeastCard float32
}

func (l PluginLook) text(c *ui.Context, text string, size float32, color ui.Color) ui.Element {
	return ui.Text(c, text).LineHeight(l.LineHeight).FontSize(size).TextColor(color)
}

// button gives a pressable element the look of .ui-button.
func (l PluginLook) button(c *ui.Context, button ui.Element, label string) ui.Element {
	edge := l.Edge
	if button.Hovered() {
		edge = l.Rail
	}
	button.Padding(l.FieldPadY, l.Space3, l.FieldPadY, l.Space3).Border(l.BorderWidth, edge).Radius(l.RadiusSmall).Background(l.Bg).Label(label).Children(func() {
		l.text(c, label, l.Control, l.Fg).SingleLine()
	})
	return button
}

// error draws the shown error of the place where at the size of the page.
func (l PluginLook) error(c *ui.Context, shown *ShownErrors, where string) {
	if text, ok := shown.Text(where); ok {
		l.text(c, text, l.Control, l.No).Wrap().Role(ui.RoleStatus).Label(text)
	}
}

// DrawPluginPage draws the plugin page: the reason of a failure, the update list, the outdated services and the cards of the shown plugins in as
// many columns of the least card width as the page holds, the grid of .library-plugins of packages/workbench/library.css, in the room its
// scroll container gives it beside a classic bar.
func DrawPluginPage(c *ui.Context, binder *Binder, page PluginPage, shown *ShownErrors, look PluginLook) {
	gap := 2 * look.Gap
	ui.Column(c).FillWidth().Gap(gap).Children(func() {
		drawPluginFailure(c, page, shown, look)
		if page.Hosted {
			drawUpdateList(c, binder, page, shown, look)
			drawOutdatedSidecars(c, binder, page, look)
		}
		rows := shownRows(page)
		if len(rows) > 0 {
			ui.Grid(c).ColumnTracks(ui.Fr(1).Min(look.LeastCard).AutoFill()).FillWidth().Gap(gap).Children(func() {
				for _, row := range rows {
					drawPluginCard(c.Key(row.ID), binder, page, row, shown, look)
				}
			})
		}
		if len(rows) == 0 && (page.Failure == nil || page.Failure.Kind != "state") {
			look.text(c, "찾는 플러그인이 없습니다.", look.Control, look.Muted)
		}
	})
}

// DrawPluginSearch draws the search of the plugin page in the place of its element, which the head of the library gives.
func DrawPluginSearch(c *ui.Context, binder *Binder, query string, place func(ui.Element) ui.Element) {
	search := binder.Control(c, "core.library.plugins.search", "core.library.plugins.search", "")
	before := query
	place(binder.Bound(ui.TextInput(c, &query), "core.library.plugins.search")).Label("플러그인 검색").Placeholder("이름, id, 설명 검색")
	if query != before {
		search(map[string]any{"query": query})
	}
}

func drawPluginFailure(c *ui.Context, page PluginPage, shown *ShownErrors, look PluginLook) {
	const where = "library plugins"
	if page.Failure == nil {
		shown.Hide(where)
		return
	}
	text := "플러그인 상태를 읽지 못했습니다: " + page.Failure.Message
	if page.Failure.Kind == "index" {
		text = "레지스트리를 읽지 못했습니다: " + page.Failure.Message
	}
	shown.Show(where, text, "")
	look.error(c, shown, where)
}

func drawUpdateList(c *ui.Context, binder *Binder, page PluginPage, shown *ShownErrors, look PluginLook) {
	if page.App.Operation == nil || page.App.Operation.State != "failed" {
		shown.Hide("library app update")
	}
	if page.App.Available == nil && len(page.Updates) == 0 {
		return
	}
	list := ui.Column(c).FillWidth().Gap(look.Space2).PaddingY(look.Space2).AlignItems(ui.Start)
	if page.Reveal {
		list.ScrollIntoView()
	}
	list.Children(func() {
		if page.App.Available != nil {
			drawAppUpdateRow(c, binder, page.App, shown, look)
		}
		for _, update := range page.Updates {
			line := fmt.Sprintf("%s: %s → %s", update.ID, update.Installed, update.Latest)
			ui.Text(binder.Name(c, "core.library.plugins.updates", update.ID), line).LineHeight(look.LineHeight).FontSize(look.Control).TextColor(look.Fg).Wrap().Label(line)
		}
		if len(page.Updates) > 0 {
			look.button(c, binder.Press(c, "core.library.plugins.update-all", "core.plugins.update-all", "", nil), "모두 업데이트")
		}
	})
}

func drawAppUpdateRow(c *ui.Context, binder *Binder, app AppUpdate, shown *ShownErrors, look PluginLook) {
	ui.Column(binder.Name(c, "core.library.app.row", "")).FillWidth().Gap(look.Space2).Role(ui.RoleGroup).Label("core").Children(func() {
		look.text(c, fmt.Sprintf("core: %s → %s", app.Version, app.Available.Version), look.Control, look.Fg)
		ui.Row(c).Gap(look.Space2).Children(func() {
			if app.Available.Release != "" {
				look.button(c, binder.Press(c, "core.library.app.release", "core.app.release", "", nil), "릴리스 페이지")
			}
			look.button(c, binder.Press(c, "core.library.app.update", "core.app.update", "", nil), "업데이트")
		})
		for _, item := range app.Incompatible {
			version := "버전 없음"
			if item.Compatible != nil {
				version = "최신 버전 " + *item.Compatible
			}
			line := fmt.Sprintf("%s %s (%s): %s에 맞는 %s", item.ID, item.Installed, item.Range, app.Available.Version, version)
			ui.Text(binder.Name(c, "core.library.app.incompatible", item.ID), line).LineHeight(look.LineHeight).FontSize(look.Control).TextColor(look.Fg).Wrap().Label(line)
		}
		drawAppOperation(c, binder, app, shown, look)
	})
}

func drawAppOperation(c *ui.Context, binder *Binder, app AppUpdate, shown *ShownErrors, look PluginLook) {
	operation := app.Operation
	if operation == nil {
		return
	}
	const name = "core.library.app.operation"
	if operation.State == "failed" {
		const where = "library app update"
		shown.Show(where, operation.Version+" 업데이트하지 못했습니다: "+operation.Error, "")
		ui.Box(binder.Name(c, name, "")).Role(ui.RoleGroup).Children(func() { look.error(c, shown, where) })
		return
	}
	step := "적용하는 중"
	if operation.State == "staging" {
		step = "받는 중"
	}
	line := operation.Version + " " + step
	ui.Text(binder.Name(c, name, ""), line).LineHeight(look.LineHeight).FontSize(look.Control).TextColor(look.Fg).Label(line)
}

func drawOutdatedSidecars(c *ui.Context, binder *Binder, page PluginPage, look PluginLook) {
	for _, item := range page.Outdated {
		running, declared, verb := "이전 버전", "선언 없음", "종료"
		if item.Running != nil {
			running = *item.Running
		}
		if item.Installed != nil {
			declared, verb = *item.Installed, "적용"
		}
		line := fmt.Sprintf("%s: %s → %s", item.Sidecar, running, declared)
		ui.Row(binder.Name(c, "core.library.plugins.outdated", item.Sidecar)).FillWidth().Gap(look.Space3).PaddingY(look.Space2).AlignItems(ui.Center).Role(ui.RoleGroup).Label(line).Children(func() {
			look.text(c, line, look.Control, look.Fg).Wrap().Grow(1)
			look.button(c, binder.Press(c, "core.library.plugins.replace", "core.plugins.replace", item.Sidecar, map[string]any{"sidecar": item.Sidecar}),
				fmt.Sprintf("세션 %d개를 끝내고 %s", item.Sessions, verb))
		})
	}
}

func drawPluginCard(c *ui.Context, binder *Binder, page PluginPage, row PluginRow, shown *ShownErrors, look PluginLook) {
	where := "library plugin " + row.ID
	edge, stateColor := look.Edge, look.Muted
	if row.State == "loaded" {
		edge, stateColor = look.Rail, look.Rail
	}
	ui.Column(c).Gap(look.Space1).Padding(look.Space2, look.Space3, look.Space2, look.Space3).Border(look.BorderWidth, edge).Radius(look.Radius).
		Background(look.Card).Role(ui.RoleListItem).Label(row.Name).Children(func() {
		ui.Row(c).FillWidth().Gap(look.Space2).AlignItems(ui.Baseline).Children(func() {
			look.text(c, row.Name, look.Control, look.Fg).Bold().SingleLine().Ellipsis("…").Shrink(1)
			ui.Spacer(c).Grow(1)
			look.text(c, pluginStates[row.State], look.Caption, stateColor).SingleLine()
		})
		look.text(c, row.ID, look.Caption, look.Muted).Wrap()
		if row.Description != "" {
			ui.Text(binder.Name(c, "core.library.plugins.about", row.ID), row.Description).LineHeight(look.LineHeight).FontSize(look.Small).TextColor(look.Fg).Wrap()
		}
		if line := versionLine(page, row); line != "" {
			look.text(c, line, look.Caption, look.Muted).Wrap()
		}
		if _, err := hasUpdate(row); err != nil {
			shown.Show(where+" version", err.Error(), "")
			look.error(c, shown, where+" version")
		} else {
			shown.Hide(where + " version")
		}
		if row.Sidecars != nil {
			look.text(c, sidecarLine(row.Sidecars), look.Caption, look.Muted).Wrap()
		}
		drawPluginContributions(c, binder, page, row, shown, look)
		drawCardActions(c, binder, page, row, look)
		drawCardOperation(c, page, row, shown, look)
	})
}

// drawPluginContributions draws the contribution lines of a card at the size of .library-plugin__contribution, the caption, and an
// invalid contribution as its error in the same line.
func drawPluginContributions(c *ui.Context, binder *Binder, page PluginPage, row PluginRow, shown *ShownErrors, look PluginLook) {
	for _, entry := range page.Contributions {
		if entry.Plugin != row.ID {
			continue
		}
		number := entry.Index + 1
		where := fmt.Sprintf("library plugin %s contribution %s %d", row.ID, entry.Point, number)
		line := binder.Name(c, "core.library.plugins.contribution", fmt.Sprintf("%s/%s/%d", row.ID, entry.Point, number))
		if entry.State == "invalid" {
			shown.Show(where, fmt.Sprintf("%s 기여 %d: %s", entry.Point, number, entry.Reason), "")
			if text, ok := shown.Text(where); ok {
				look.text(line, text, look.Caption, look.No).Wrap().Role(ui.RoleStatus).Label(text)
			}
			continue
		}
		shown.Hide(where)
		look.text(line, fmt.Sprintf("%s 기여 %d: %s", entry.Point, number, contributionStates[entry.State]), look.Caption, look.Fg).Wrap()
	}
}

// pluginCommands are the commands of the action buttons of a card.
var pluginCommands = map[string]string{"install": "core.plugins.install", "update": "core.plugins.update", "remove": "core.plugins.remove",
	"enable": "core.plugins.enable", "disable": "core.plugins.disable", "apply": "core.plugins.apply"}

func drawCardActions(c *ui.Context, binder *Binder, page PluginPage, row PluginRow, look PluginLook) {
	actions := cardActions(page, row)
	if len(actions) == 0 {
		return
	}
	ui.Row(c).Gap(look.Space2).Margin(look.Space1, 0, 0, 0).Children(func() {
		for _, action := range actions {
			// core.plugins.apply reloads the window for every changed plugin, so it takes no plugin.
			var params any = map[string]any{"plugin": row.ID}
			if action.Action == "apply" {
				params = nil
			}
			button := binder.Press(c, "core.library.plugins.action", pluginCommands[action.Action], row.ID+"/"+action.Action, params)
			look.button(c, button.Disabled(action.Disabled), actionLabel(action.Action))
		}
	})
}

// drawCardOperation shows the operation of the plugin. An operation that succeeds reloads the window, so a done operation
// shows no line.
func drawCardOperation(c *ui.Context, page PluginPage, row PluginRow, shown *ShownErrors, look PluginLook) {
	where := "library plugin " + row.ID
	operation := page.Operation
	if operation == nil || operation.Plugin != row.ID || operation.State != "failed" {
		shown.Hide(where)
	}
	if operation == nil || operation.Plugin != row.ID {
		return
	}
	switch operation.State {
	case "running":
		look.text(c, row.ID+" "+operation.Action+" 진행 중", look.Caption, look.Muted)
	case "failed":
		shown.Show(where, operation.Error, "")
		look.error(c, shown, where)
	}
}
