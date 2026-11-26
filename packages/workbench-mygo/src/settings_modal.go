package workbench

import (
	"cmp"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"slices"
	"strconv"
	"strings"

	"github.com/egoist/mygo/ui"

	"github.com/soksak-app/core/packages/workbench-mygo/src/layout"
)

// The settings window of the mygo host (docs/spec/settings.md): native UI instead of the modal web view of the other hosts. A
// model of the card holds its controls in document order, the status reads it and the drawing draws it, so the two cannot
// differ.

// LoadedSection is a sidebar section of a loaded plugin.
type LoadedSection struct{ ID, Name string }

// LoadedPlugin is a plugin that the window loaded.
type LoadedPlugin struct {
	ID, Name, Description string
	// Version is the installed version, and Dependencies the sidecar ranges of plugin.json.
	Version      string
	Dependencies map[string]string
	// Composition is the kind of the surface composition, and nil without one.
	Composition *string
	// Mark is the short text and Icon the SVG elements of the add menu, Menu the context menu of the surface, and Save the command
	// that saves a surface.
	Mark, Icon, Save string
	// Ink is the theme token of the color of the plugin in a library preview, and empty without one.
	Ink      string
	Menu     []PluginMenuItem
	Sections []LoadedSection
	Surface  bool
	// Params is surface.params, the schema of the parameters of a tab, and nil for a plugin that opens tabs without them.
	Params any
	// Categories are the plugin categories that the plugin serves (docs/spec/plugins.md#plugin-categories).
	Categories []string
}

// settingsSections are the sections of the window in order, with their labels.
var settingsSections = [][2]string{{"general", "일반"}, {"plugins", "플러그인"}, {"sidebars", "사이드바"}}

// settingsName is the title of the window and the name of its card.
const settingsName = "설정"

// The placement of the card, as the chrome metrics of workbench.json hold them: its width, its top, the share of the window
// height that it fills at most, and the margin that a moved card keeps from the window edges.
const (
	settingsCardMaxShare = 0.74
	settingsCardMargin   = 8
)

// The kinds of a control of the card.
type controlKind int

const (
	controlButton controlKind = iota
	controlSwatch
	controlSwitch
	controlSelect
	controlSlider
	controlText
	controlCaption
	// controlMark is the mark of the common tab that the project value of its setting applies.
	controlMark
	// controlSetup is a row of the agent group, with the name, state, file and optional action of a setup part.
	controlSetup
	// controlAccount is a row of the group 계정, with the line and the usage lines of an account and its buttons.
	controlAccount
)

// ControlCommand is the command of a control, without the value that the control adds.
type ControlCommand struct {
	Name   string         `json:"name"`
	Params map[string]any `json:"params"`
}

// OptionGroup is a heading of the options of a select box.
type OptionGroup struct {
	Label  string   `json:"label"`
	Values []string `json:"values"`
}

// SettingsControl is a control of the card as the status reports it.
type SettingsControl struct {
	Name    string          `json:"name"`
	Index   int             `json:"index"`
	Key     *string         `json:"key"`
	Label   string          `json:"label"`
	On      *bool           `json:"on"`
	Value   *string         `json:"value"`
	Command *ControlCommand `json:"command"`
	Options []string        `json:"options"`
	Groups  []OptionGroup   `json:"groups"`

	kind       controlKind
	param      string            // the parameter that takes the value of the control
	labels     map[string]string // the text of each option
	lo, hi     float64           // the bounds of a slider
	unit       string
	theme      *CatalogTheme // the theme of a swatch
	maxLength  int
	searchable bool        // a field that runs its command for each change, as the plugin search does
	setup      *setupRow   // the content of a row of the agent group
	account    *accountRow // the content of a row of the group 계정
}

// accountRow is the content of a row of the group 계정: the line of the account, its usage lines and its controls.
type accountRow struct {
	line     string
	usage    []string
	controls []*SettingsControl
}

// settingsRow is a row of a group: a name and its controls, with the key and the description of a declared setting.
type settingsRow struct {
	name        string
	key         string
	description string
	controls    []*SettingsControl
	// list says that the controls stand in the flow of a line, one after the other (.set-list).
	list bool
	// value is the name of the value of an order row, which stands before its buttons.
	value string
}

// settingsGroup is a group of rows with its name and its one-line text.
type settingsGroup struct {
	name, text string
	rows       []settingsRow
}

// settingsModel is the card: its section buttons, its scope buttons, the folder of the project scope and its groups.
type settingsModel struct {
	close        *SettingsControl
	nav, scopes  []*SettingsControl
	folder       string
	groups       []settingsGroup
	declaredRows []settingsRow
	listed       []string
	controls     []*SettingsControl
}

// settingsWindow is the state of the window of a shell. Its section, scope, search, plugin and edited set outlast a close.
type settingsWindow struct {
	// drawnHeight is the height of the card in the last frame, and 0 before its first frame.
	drawnHeight     float64
	open            bool
	section, scope  string
	query           string
	chosen, editing string
	moved           bool
	x, y            float64
	width, height   float64
	scroll          ui.ScrollState
	scrollKey       string
	drafts          map[string]string
	// The fields of the group 계정 of the shown plugin page (docs/spec/plugins.md#accounts): the plugin of the page, the name and the
	// kind of the row 새 계정, the account whose name is edited and the text of its field. Another page clears them.
	accountPlugin, accountName, accountKind, accountEdit, accountEditName string
}

func newSettingsWindow() settingsWindow {
	return settingsWindow{section: "general", scope: "common", drafts: map[string]string{}}
}

// builder adds the controls of a card in document order.
type settingsBuilder struct {
	model  *settingsModel
	counts map[string]int
}

func (b *settingsBuilder) add(control SettingsControl) *SettingsControl {
	control.Index = b.counts[control.Name]
	b.counts[control.Name]++
	added := &control
	b.model.controls = append(b.model.controls, added)
	return added
}

func text(value string) *string { return &value }

func settingCommand(name string, params map[string]any) *ControlCommand {
	if params == nil {
		params = map[string]any{}
	}
	return &ControlCommand{Name: name, Params: params}
}

// button is a button with its key, its element name and its command.
func (b *settingsBuilder) button(key, name, label, command string, params map[string]any) *SettingsControl {
	return b.add(SettingsControl{Name: name, Key: text(key), Label: label, Command: settingCommand(command, params), kind: controlButton})
}

// pressedButton is a button that shows that it is on.
func (b *settingsBuilder) pressedButton(key, name, label, command string, params map[string]any, on bool) *SettingsControl {
	control := b.button(key, name, label, command, params)
	control.On = &on
	return control
}

// valueText is a value as a control shows it.
func valueText(value any) string {
	switch typed := value.(type) {
	case string:
		return typed
	case float64:
		return strconv.FormatFloat(typed, 'f', -1, 64)
	}
	return fmt.Sprint(value)
}

// settingsBuild builds the card of the current state and the current values.
func (s *Shell) settingsBuild() (*settingsModel, error) {
	w := &s.settingsWindow
	store := s.settings
	if store.Project() == "" {
		w.scope = "common"
	}
	model := &settingsModel{}
	b := &settingsBuilder{model: model, counts: map[string]int{}}
	b.add(SettingsControl{Name: "core.settings-modal.grip", Label: settingsName, kind: controlCaption})
	model.close = b.add(SettingsControl{Name: "core.settings-modal.close", Key: text("close"), Label: "닫는다", Command: settingCommand("core.settings.close", nil), kind: controlButton})
	for _, section := range settingsSections {
		model.nav = append(model.nav, b.pressedButton("nav:"+section[0], "core.settings-modal.nav", section[1], "core.settings-modal.nav",
			map[string]any{"section": section[0]}, section[0] == w.section))
	}
	scopes := [][2]string{{"common", "전역"}}
	if store.Project() != "" {
		scopes = append(scopes, [2]string{"project", "프로젝트"})
	}
	for _, scope := range scopes {
		model.scopes = append(model.scopes, b.pressedButton("pick:scope:"+scope[0], "core.settings-modal.scope", scope[1], "core.settings-modal.scope",
			map[string]any{"scope": scope[0]}, scope[0] == w.scope))
	}
	if w.scope == "project" {
		project := s.opened()
		if project == nil {
			return nil, errors.New("the project settings scope has no active project")
		}
		model.folder = project.Root
	}
	build := map[string]func(*settingsBuilder) error{"general": s.buildGeneral, "plugins": s.buildPlugins, "sidebars": s.buildSidebars}
	if err := build[w.section](b); err != nil {
		return nil, err
	}
	return model, nil
}

func (b *settingsBuilder) group(name, text string, rows ...settingsRow) {
	b.model.groups = append(b.model.groups, settingsGroup{name: name, text: text, rows: rows})
}

// row is a row of one control. A setting that the project overrides adds its reset button in the project tab and its mark in
// the common tab.
func (s *Shell) row(b *settingsBuilder, name string, control *SettingsControl) settingsRow {
	row := settingsRow{name: name, controls: []*SettingsControl{control}}
	if control.Key != nil {
		row.controls = append(row.controls, s.overrideControls(b, *control.Key, "전역값 사용")...)
	}
	return row
}

// overrideControls are the controls of a setting that the selected project overrides: the button that removes the project value in
// the project tab, and the mark that the project value applies in the common tab (docs/spec/settings.md#scope-of-a-control).
func (s *Shell) overrideControls(b *settingsBuilder, key, reset string) []*SettingsControl {
	if !s.settings.Overridden(key) || s.settings.Project() == "" {
		return nil
	}
	if s.settingsWindow.scope == "project" {
		return []*SettingsControl{b.resetButton(key, reset)}
	}
	return []*SettingsControl{b.add(SettingsControl{Name: "core.settings-modal.applied", Key: text("applied:" + key), Label: "프로젝트 값", kind: controlMark})}
}

// settingOf is the setting of the key of a control: links for a link, sets for a control of the set editor, and the key itself
// for every other control.
func settingOf(key string) string {
	for _, prefix := range []string{"title:", "layout:", "row:"} {
		if strings.HasPrefix(key, prefix) {
			return "sets"
		}
	}
	if strings.HasPrefix(key, "link:") {
		return "links"
	}
	return key
}

// controlScope is the scope that a control of the key shows and writes: the project scope in the project tab, and in the common
// tab the scope that the applied value of its setting comes from (docs/spec/settings.md#scope-of-a-control).
func (s *Shell) controlScope(key string) string {
	if s.settingsWindow.scope == "project" {
		return "project"
	}
	return s.settings.Source(settingOf(key))
}

func (b *settingsBuilder) resetButton(key, label string) *SettingsControl {
	return b.button("reset:"+key, "core.settings-modal.reset", label, "core.settings.reset", map[string]any{"key": key})
}

// setting is the command of a control of the setting key: core.settings.change, or core.settings.link for a link key of the
// form link:<place>:<plugin>.
func (s *Shell) setting(key string) (*ControlCommand, string) {
	scope := s.controlScope(key)
	if rest, ok := strings.CutPrefix(key, "link:"); ok {
		place, plugin, _ := strings.Cut(rest, ":") // silent: the key of a link control is written with both parts.
		params := map[string]any{"place": place, "plugin": nil, "scope": scope}
		if plugin != "" {
			params["plugin"] = plugin
		}
		return settingCommand("core.settings.link", params), "set"
	}
	return settingCommand("core.settings.change", map[string]any{"key": key, "scope": scope}), "value"
}

func (s *Shell) value(key string) any { return s.settings.Scoped(key, s.controlScope(key)) }

// choose is the select box of the setting key.
func (s *Shell) choose(b *settingsBuilder, key string, options [][2]string, now string) (*SettingsControl, error) {
	values := make([]string, len(options))
	labels := make(map[string]string, len(options))
	for i, option := range options {
		values[i], labels[option[0]] = option[0], option[1]
	}
	if !slices.Contains(values, now) {
		return nil, fmt.Errorf("unknown settings choice %s for %s", now, key)
	}
	command, param := s.setting(key)
	return b.add(SettingsControl{Name: "core.settings-modal.set", Key: text(key), Value: text(now), Command: command, Options: values, kind: controlSelect, param: param, labels: labels}), nil
}

// choosePlugin is the select box of a plugin setting: its options are the loaded plugins of the category by id, labeled with their names,
// and it has no selected value while nothing is chosen (docs/spec/settings.md#controls).
func (s *Shell) choosePlugin(b *settingsBuilder, key string, options [][2]string, now any) *SettingsControl {
	values := make([]string, len(options))
	labels := make(map[string]string, len(options))
	for i, option := range options {
		values[i], labels[option[0]] = option[0], option[1]
	}
	var value *string
	if id, ok := now.(string); ok {
		value = text(id)
	}
	command, param := s.setting(key)
	return b.add(SettingsControl{Name: "core.settings-modal.set", Key: text(key), Value: value, Command: command, Options: values, kind: controlSelect, param: param, labels: labels})
}

// syncPluginChoices shows the error that asks for a choice of each plugin setting that has no value, and withdraws it when the setting
// has one (docs/spec/plugins.md#settings-declarations).
func (s *Shell) syncPluginChoices() {
	for _, definition := range s.settings.Definitions {
		if definition.Type != "plugin" {
			continue
		}
		source := "plugin choice " + definition.Key
		if s.settings.Value(definition.Key) != nil {
			s.errors.HideFrom(workbenchErrorPlace, source)
		} else if !s.errors.ShownFrom(workbenchErrorPlace, source) {
			s.errors.ShowFrom(workbenchErrorPlace, source, definition.Key+": choose a "+definition.Category+" plugin", "")
		}
	}
}

func (s *Shell) toggle(b *settingsBuilder, key string) *SettingsControl {
	on, _ := s.value(key).(bool) // silent: the settings store checks the type of the value.
	command, param := s.setting(key)
	return b.add(SettingsControl{Name: "core.settings-modal.set", Key: text(key), On: &on, Value: text(strconv.FormatBool(on)), Command: command, kind: controlSwitch, param: param})
}

func (s *Shell) slide(b *settingsBuilder, key string, bounds [2]float64, unit string) *SettingsControl {
	now := valueText(s.value(key))
	command, param := s.setting(key)
	return b.add(SettingsControl{Name: "core.settings-modal.set", Key: text(key), Value: text(now), Command: command, kind: controlSlider, param: param, lo: bounds[0], hi: bounds[1], unit: unit})
}

func (s *Shell) textField(b *settingsBuilder, key string, maxLength int) *SettingsControl {
	command, param := s.setting(key)
	return b.add(SettingsControl{Name: "core.settings-modal.set", Key: text(key), Value: text(valueText(s.value(key))), Command: command, kind: controlText, param: param, maxLength: maxLength})
}

// sectionNames are the names of the section ids.
func (s *Shell) sectionNames(ids []string) []string {
	names := make([]string, len(ids))
	for i, id := range ids {
		names[i] = id + " (불러오지 않음)"
		for _, plugin := range s.plugins {
			for _, section := range plugin.Sections {
				if section.ID == id {
					names[i] = section.Name
				}
			}
		}
	}
	return names
}

// joinedOr joins names, or gives none for an empty list.
func joinedOr(names []string, separator, none string) string {
	if len(names) == 0 {
		return none
	}
	return strings.Join(names, separator)
}

// setOptions are the choices of a sidebar: not used and every set.
func (s *Shell) setOptions(sets []StoredSet) [][2]string {
	options := [][2]string{{"off", "사용 안 함"}}
	for _, set := range sets {
		options = append(options, [2]string{set.ID, set.Title + " — " + joinedOr(s.sectionNames(set.Sections), " · ", "섹션 없음")})
	}
	return options
}

// linked is the choice of a place: a set id, or off.
func linked(links []StoredLink, place, plugin string) string {
	for _, link := range links {
		if link.Place == place && link.pluginID() == plugin {
			return link.Set
		}
	}
	return "off"
}

// linkChoice is the select box of a sidebar choice.
func (s *Shell) linkChoice(b *settingsBuilder, name, place, plugin string, sets []StoredSet, links []StoredLink) (settingsRow, error) {
	control, err := s.choose(b, "link:"+place+":"+plugin, s.setOptions(sets), linked(links, place, plugin))
	if err != nil {
		return settingsRow{}, err
	}
	return s.row(b, name, control), nil
}

func labelled(values []string, labels map[string]string) ([][2]string, error) {
	options := make([][2]string, len(values))
	for i, value := range values {
		label, ok := labels[value]
		if !ok {
			return nil, fmt.Errorf("settings choice %s has no label", value)
		}
		options[i] = [2]string{value, label}
	}
	return options, nil
}

func (s *Shell) buildGeneral(b *settingsBuilder) error {
	catalog := s.settings.Catalog
	scope := s.settingsWindow.scope
	themeScope := s.controlScope("theme")
	var failed error
	choice := func(name, key string, labels map[string]string) settingsRow {
		options, err := labelled(catalog.choices(key), labels)
		if err != nil {
			failed = err
			return settingsRow{}
		}
		control, err := s.choose(b, key, options, valueText(s.value(key)))
		if err != nil {
			failed = err
			return settingsRow{}
		}
		return s.row(b, name, control)
	}
	if scope == "common" {
		b.group("프로젝트", "프로젝트를 여는 방식은 모든 프로젝트에 적용됩니다. 이미 열린 창은 유지됩니다.",
			choice("열기 방식", "projectOpening", map[string]string{"tabs": "현재 창", "windows": "별도 창"}))
	}
	theme := settingsRow{}
	for i := range catalog.Themes {
		item := &catalog.Themes[i]
		theme.controls = append(theme.controls, b.pressedButton("theme:"+item.Name, "core.settings-modal.theme", "", "core.settings.theme",
			map[string]any{"name": item.Name, "scope": themeScope}, item.Name == s.value("theme")))
		last := theme.controls[len(theme.controls)-1]
		last.kind, last.theme, last.Label = controlSwatch, item, item.Name
	}
	theme.controls = append(theme.controls, s.overrideControls(b, "theme", "전역 테마 사용")...)
	b.group("테마", "테마가 색과 형태의 기본값을 정하고, 모드는 그 테마의 밝은 쪽과 어두운 쪽을 고른다.", theme,
		choice("모드", "mode", map[string]string{"dark": "어두움", "light": "밝음"}))

	fonts := make(map[string]string, len(catalog.Fonts))
	for _, font := range catalog.Fonts {
		fonts[font.ID] = font.Name
	}
	shape := catalog.Settings.ShapeRanges
	b.group("형태", "테마가 준 값에서 시작한다. 통로를 0 으로 내리면 카드가 선 하나를 공유한다.",
		s.row(b, "통로", s.slide(b, "gap", shape["gap"], "px")),
		s.row(b, "모서리", s.slide(b, "radius", shape["radius"], "px")),
		choice("폰트", "font", fonts),
		s.row(b, "글자 크기", s.slide(b, "size", shape["size"], "px")))
	b.group("위치", "프로젝트 탭이 놓이는 위치. 바꾸면 카드 배치도 함께 바뀐다.",
		choice("프로젝트 탭 위치", "projectTabs", map[string]string{"top": "위", "left": "왼쪽"}))

	// A link control takes the sets of the scope of the links as its options.
	sets, err := s.settings.Sets(s.controlScope("links"))
	if err != nil {
		return err
	}
	links, err := s.settings.Links(s.controlScope("links"))
	if err != nil {
		return err
	}
	// One fixed sidebar per side; the order sets which sidebar takes the room of the plane first (docs/spec/external-sidebars.md).
	rows := []settingsRow{}
	for _, side := range layout.WindowSides {
		rows = append(rows, s.row(b, sideNames[side]+" 사이드바 보이기", s.toggle(b, side)))
	}
	for _, side := range layout.WindowSides {
		row, err := s.linkChoice(b, sideNames[side]+" 사이드바 세트", side, "", sets, links)
		if err != nil {
			return err
		}
		rows = append(rows, row)
	}
	if controls := s.overrideControls(b, "links", "전역 연결 사용"); controls != nil {
		rows = append(rows, settingsRow{controls: controls})
	}
	rows = append(rows, s.orderRows(b, "sidebarOrder", "사이드바 순서", sideNames)...)
	b.group("사이드바", "한 변에는 고정 사이드바가 하나 있고, 포커스된 플러그인의 창 세트는 같은 자리의 내용을 바꾼다. 순서가 앞선 변의 사이드바가 먼저 공간을 차지한다.", rows...)

	widths := catalog.Settings.LayoutRanges
	b.group("사이드바 크기", "사이드바의 폭(pt). 처음 폭은 카드 안 사이드바와 저장 크기가 없는 창 사이드바가 여는 크기(위·아래 사이드바는 높이)이며 최소 폭과 최대 폭 사이여야 한다.",
		s.row(b, "최소 폭", s.slide(b, "sidebarMinWidth", widths["sidebarMinWidth"], "pt")),
		s.row(b, "최대 폭", s.slide(b, "sidebarMaxWidth", widths["sidebarMaxWidth"], "pt")),
		s.row(b, "처음 폭", s.slide(b, "sidebarWidth", widths["sidebarWidth"], "pt")))
	b.group("표시", "배치는 그대로 두고 보이는 모습만 바꾼다.",
		choice("포커스 표시", "focusInd", map[string]string{"border": "테두리", "corner": "꺽쇠"}),
		choice("카드 자동 정렬", "cardArrange", map[string]string{"resize": "크기맞춤", "even": "균등"}),
		choice("경계선", "fullRule", map[string]string{"under": "가림", "over": "보임", "none": "숨김"}),
		s.row(b, "포커스 밖 흐리게", s.toggle(b, "dim")))

	languages := map[string]string{"auto": "자동"}
	for _, language := range catalog.MenuLanguages {
		languages[language.ID] = language.Label
	}
	b.group("언어", "애플리케이션 메뉴가 이 언어를 따른다. 자동은 시스템 언어이고 목록에 없으면 영어다.", choice("언어", "language", languages))
	if scope == "common" {
		b.group("메모리", "메모리 절약을 켜면 숨긴 지 정한 시간이 지난 탭을 내리고, 다시 보일 때 저장된 상태로 다시 연다. 보기 프로세스는 새로 여는 보기부터 적용된다.",
			choice("보기 프로세스", "viewProcess", map[string]string{"plugin": "플러그인마다 하나", "view": "보기마다 하나"}),
			s.row(b, "메모리 절약", s.toggle(b, "memorySaver")),
			s.row(b, "숨긴 뒤 내리기까지", s.slide(b, "memorySaverDelay", catalog.Settings.MemorySaverDelay, "분")))
		b.group("알림", "오류 토스트의 자동 닫힘을 정한다. 끄면 각 토스트의 ×로만 닫는다.",
			s.row(b, "자동 닫힘", s.toggle(b, "autoDismissErrorToasts")),
			s.row(b, "초 후 자동으로 닫힘", s.textField(b, "errorToastDismissSeconds", 3)))
		on := s.settings.DebugOn()
		debug := b.add(SettingsControl{Name: "core.settings-modal.debug", Label: "디버그", On: &on, Command: settingCommand("core.settings.debug", nil), kind: controlSwitch, param: "on"})
		b.group("진단", "디버그를 켜면 성능 트레이스와 모든 로그 종류의 상세 기록이 남는다. 끄면 오류만 기록된다.", settingsRow{name: "디버그", controls: []*SettingsControl{debug}})
		s.buildSetup(b)
	}
	return failed
}

// matchedPlugins are the loaded plugins whose id, name or description holds the query, by id.
func (s *Shell) matchedPlugins(query string) []LoadedPlugin {
	needle := strings.ToLower(query)
	var matched []LoadedPlugin
	for _, plugin := range s.plugins {
		for _, field := range []string{plugin.ID, plugin.Name, plugin.Description} {
			if strings.Contains(strings.ToLower(field), needle) {
				matched = append(matched, plugin)
				break
			}
		}
	}
	slices.SortFunc(matched, func(a, b LoadedPlugin) int { return cmp.Compare(a.ID, b.ID) })
	return matched
}

func (s *Shell) loadedPlugin(id string) *LoadedPlugin {
	for i := range s.plugins {
		if s.plugins[i].ID == id {
			return &s.plugins[i]
		}
	}
	return nil
}

func (s *Shell) buildPlugins(b *settingsBuilder) error {
	w := &s.settingsWindow
	if plugin := s.loadedPlugin(w.chosen); plugin != nil {
		return s.buildPluginPage(b, plugin)
	}
	w.chosen = ""
	manage := b.button("plugins:manage", "core.settings-modal.manage", "플러그인 관리", "core.plugins.browse", nil)
	search := b.add(SettingsControl{Name: "core.settings-modal.search", Key: text("plugin-search"), Value: text(w.query), Command: settingCommand("core.settings-modal.search", nil),
		kind: controlText, param: "query", searchable: true, Label: "이름, id, 설명으로 찾기"})
	rows := []settingsRow{{controls: []*SettingsControl{manage}}, {name: "찾기", controls: []*SettingsControl{search}}}
	matched := s.matchedPlugins(w.query)
	list := settingsRow{list: true}
	for _, plugin := range matched {
		list.controls = append(list.controls, b.button("plugin:"+plugin.ID, "core.settings-modal.plugin", plugin.Name, "core.settings-modal.plugin", map[string]any{"plugin": plugin.ID}))
		b.model.listed = append(b.model.listed, plugin.ID)
	}
	rows = append(rows, list)
	if len(matched) == 0 {
		rows = append(rows, settingsRow{description: "찾는 플러그인이 없습니다."})
	}
	b.group("플러그인", "창이 불러온 플러그인의 설정. 설치, 업데이트, 제거와 플러그인 설명은 플러그인 관리에서 본다.", rows...)
	return nil
}

// declaredControl is the control of the form of a plugin setting.
func (s *Shell) declaredControl(b *settingsBuilder, definition SettingDefinition) (*SettingsControl, error) {
	switch definition.Type {
	case "enum":
		options := make([][2]string, len(definition.Values))
		for i, value := range definition.Values {
			options[i] = [2]string{value, value}
		}
		return s.choose(b, definition.Key, options, valueText(s.value(definition.Key)))
	case "plugin":
		var options [][2]string
		for _, plugin := range s.plugins {
			if slices.Contains(plugin.Categories, definition.Category) {
				options = append(options, [2]string{plugin.ID, plugin.Name})
			}
		}
		return s.choosePlugin(b, definition.Key, options, s.value(definition.Key)), nil
	case "integer":
		return s.slide(b, definition.Key, [2]float64{definition.Minimum, definition.Maximum}, ""), nil
	case "string":
		return s.textField(b, definition.Key, definition.MaxLength), nil
	case "address":
		return s.textField(b, definition.Key, 2048), nil
	}
	return nil, fmt.Errorf("setting %s has no control for type %s", definition.Key, definition.Type)
}

// accountLogin is the login of an account as its row shows it.
func accountLogin(account AccountView) string {
	switch {
	case account.Running:
		return "로그인 중"
	case account.Login == nil:
		return "-"
	case *account.Login && account.Until != nil:
		return "로그인됨 · " + *account.Until + "까지"
	case *account.Login:
		return "로그인됨"
	}
	return "로그인 필요"
}

// accountField is a text field of the group 계정 that runs command with its text as name.
func accountField(b *settingsBuilder, key, command, now string) *SettingsControl {
	return b.add(SettingsControl{Name: "core.settings-modal." + key, Key: text(key), Value: text(now), Command: settingCommand(command, nil), kind: controlText, param: "name", maxLength: 40})
}

// buildAccounts adds the group 계정 of a plugin that declares accounts: a row per account and the row 새 계정.
func (s *Shell) buildAccounts(b *settingsBuilder, plugin *LoadedPlugin, declared *accountsDeclaration) {
	w := &s.settingsWindow
	accounts, err := s.accounts.List(plugin.ID)
	if err != nil {
		// A record of another form fails the page through the error display, and the group shows no account.
		s.accounts.fail(plugin.ID, err)
		accounts = []AccountView{}
	}
	rows := make([]settingsRow, 0, len(accounts)+1)
	for _, account := range accounts {
		kind := ""
		for _, item := range declared.Kinds {
			if item.Value == account.Kind {
				kind = item.Label
			}
		}
		content := &accountRow{line: account.Name + " · " + kind + " · " + accountLogin(account)}
		for _, usage := range account.Usage {
			line := fmt.Sprintf("%s %s%%", usage.Label, strconv.FormatFloat(usage.Used, 'f', -1, 64))
			if usage.Resets != nil {
				line += " · " + *usage.Resets + " 초기화"
			}
			content.usage = append(content.usage, line)
		}
		// The row stands before its controls in document order, as the element of the page holds them.
		row := b.add(SettingsControl{Name: "core.settings-modal.account", kind: controlAccount, account: content})
		params := map[string]any{"plugin": plugin.ID, "id": account.ID}
		if w.accountEdit == account.ID {
			content.controls = append(content.controls,
				accountField(b, "account-edit-name", "core.settings-modal.account-edit-name", w.accountEditName),
				b.button("account-save:"+account.ID, "core.settings-modal.account-save", "저장", "core.accounts.rename", map[string]any{"plugin": plugin.ID, "id": account.ID, "name": w.accountEditName}),
				b.button("account-edit-cancel:"+account.ID, "core.settings-modal.account-edit-cancel", "취소", "core.settings-modal.account-edit", map[string]any{"id": nil}))
		} else {
			switch {
			case account.Running:
				content.controls = append(content.controls, b.button("account-login-cancel:"+account.ID, "core.settings-modal.account-login-cancel", "취소", "core.accounts.login-cancel", params))
			case account.Login != nil && !*account.Login:
				content.controls = append(content.controls, b.button("account-login:"+account.ID, "core.settings-modal.account-login", "로그인", "core.accounts.login", params))
			case account.Login != nil && *account.Login:
				content.controls = append(content.controls, b.button("account-logout:"+account.ID, "core.settings-modal.account-logout", "로그아웃", "core.accounts.logout", params))
			}
			content.controls = append(content.controls,
				b.button("account-edit:"+account.ID, "core.settings-modal.account-edit", "이름 변경", "core.settings-modal.account-edit", map[string]any{"id": account.ID}),
				b.button("account-remove:"+account.ID, "core.settings-modal.account-remove", "삭제", "core.accounts.remove", params))
		}
		// The label is the text of the row in document order, as the page reports the textContent of its row.
		row.Label = content.line + strings.Join(content.usage, "")
		for _, control := range content.controls {
			if control.kind == controlButton {
				row.Label += control.Label
			}
		}
		rows = append(rows, settingsRow{controls: []*SettingsControl{row}})
	}
	options := make([][2]string, len(declared.Kinds))
	values := make([]string, len(declared.Kinds))
	labels := make(map[string]string, len(declared.Kinds))
	for i, item := range declared.Kinds {
		options[i], values[i], labels[item.Value] = [2]string{item.Value, item.Label}, item.Value, item.Label
	}
	name := accountField(b, "account-name", "core.settings-modal.account-name", w.accountName)
	kind := b.add(SettingsControl{Name: "core.settings-modal.account-kind", Key: text("account-kind"), Value: text(w.accountKind), Command: settingCommand("core.settings-modal.account-kind", nil),
		Options: values, kind: controlSelect, param: "kind", labels: labels})
	add := b.button("account-add", "core.settings-modal.account-add", "추가", "core.accounts.add", map[string]any{"plugin": plugin.ID, "name": w.accountName, "kind": w.accountKind})
	rows = append(rows, settingsRow{name: "새 계정", controls: []*SettingsControl{name, kind, add}})
	b.group("계정", plugin.Name+" 플러그인이 실행하는 CLI의 계정. 로그인은 시스템 브라우저에서 한다.", rows...)
}

func (s *Shell) buildPluginPage(b *settingsBuilder, plugin *LoadedPlugin) error {
	scope := s.controlScope("links")
	back := b.button("plugins:list", "core.settings-modal.back", "목록", "core.settings-modal.plugin", map[string]any{"plugin": nil})
	b.group(plugin.Name, plugin.ID, settingsRow{controls: []*SettingsControl{back}})
	if unit := s.units[plugin.ID]; unit != nil && unit.Accounts != nil {
		w := &s.settingsWindow
		if w.accountPlugin != plugin.ID {
			w.accountPlugin, w.accountName, w.accountKind, w.accountEdit, w.accountEditName = plugin.ID, "", unit.Accounts.Kinds[0].Value, "", ""
		}
		s.buildAccounts(b, plugin, unit.Accounts)
	}
	var rows []settingsRow
	for _, definition := range s.settings.Definitions {
		if definition.Plugin != plugin.ID {
			continue
		}
		control, err := s.declaredControl(b, definition)
		if err != nil {
			return err
		}
		row := s.row(b, definition.Label, control)
		row.key, row.description = definition.Key, definition.Description
		rows = append(rows, row)
		b.model.declaredRows = append(b.model.declaredRows, row)
	}
	if len(rows) == 0 {
		rows = []settingsRow{{description: "이 플러그인에는 설정이 없습니다."}}
	}
	b.group("설정", plugin.Name+" 플러그인이 선언한 설정.", rows...)
	ids := make([]string, len(plugin.Sections))
	for i, section := range plugin.Sections {
		ids[i] = section.ID
	}
	b.group("섹션", "이 플러그인이 사이드바에 제공하는 섹션.", settingsRow{description: joinedOr(s.sectionNames(ids), ", ", "이 플러그인에는 섹션이 없습니다.")})
	sets, err := s.settings.Sets(scope)
	if err != nil {
		return err
	}
	links, err := s.settings.Links(scope)
	if err != nil {
		return err
	}
	choices := func(places [][2]string) ([]settingsRow, error) {
		rows := make([]settingsRow, len(places))
		for i, place := range places {
			row, err := s.linkChoice(b, place[1], place[0], plugin.ID, sets, links)
			if err != nil {
				return nil, err
			}
			rows[i] = row
		}
		return rows, nil
	}
	sides := [][2]string{}
	for _, side := range layout.WindowSides {
		sides = append(sides, [2]string{"window-" + side, "창 " + sideNames[side] + " 사이드바"})
	}
	window, err := choices(sides)
	if err != nil {
		return err
	}
	b.group("창 사이드바", "이 플러그인의 탭이 포커스 카드의 활성 탭인 동안 그 변 고정 사이드바의 내용을 이 세트로 바꾼다.", window...)
	if plugin.Surface {
		card, err := choices([][2]string{{"card-left", "카드 왼쪽 사이드바"}, {"card-right", "카드 오른쪽 사이드바"}, {"card-top", "카드 상단 사이드바"}, {"card-bottom", "카드 하단 사이드바"}})
		if err != nil {
			return err
		}
		b.group("카드 사이드바", "카드 내부의 네 변에 표시한다.", card...)
	}
	return nil
}

// registeredSections are the section ids in the order of the plugins and their declarations.
func (s *Shell) registeredSections() []string {
	var ids []string
	for _, plugin := range s.plugins {
		for _, section := range plugin.Sections {
			ids = append(ids, section.ID)
		}
	}
	return ids
}

// sectionSelect is the select box of one section row, grouped by plugin. A section of a plugin that is not loaded stands in a
// group of its own as the current value.
func (s *Shell) sectionSelect(b *settingsBuilder, set StoredSet, index int, now string) *SettingsControl {
	scope := s.controlScope("sets")
	labels := map[string]string{}
	var groups []OptionGroup
	var options []string
	for _, plugin := range s.plugins {
		if len(plugin.Sections) == 0 {
			continue
		}
		group := OptionGroup{Label: plugin.Name}
		for _, section := range plugin.Sections {
			group.Values = append(group.Values, section.ID)
			labels[section.ID] = section.Name
		}
		groups = append(groups, group)
		options = append(options, group.Values...)
	}
	if !slices.Contains(options, now) {
		labels[now] = s.sectionNames([]string{now})[0]
		groups = append(groups, OptionGroup{Label: "불러오지 않음", Values: []string{now}})
		options = append(options, now)
	}
	return b.add(SettingsControl{Name: "core.settings-modal.row", Key: text(fmt.Sprintf("row:%s:%d", set.ID, index)), Value: text(now), Options: options, Groups: groups,
		Command: settingCommand("core.settings.sets.row", map[string]any{"id": set.ID, "action": "choose", "index": index, "scope": scope}), kind: controlSelect, param: "section", labels: labels})
}

// setEditor is the group of the edited set.
func (s *Shell) setEditor(b *settingsBuilder, set StoredSet) {
	scope := s.controlScope("sets")
	update := map[string]any{"id": set.ID, "scope": scope}
	title := b.add(SettingsControl{Name: "core.settings-modal.set", Key: text("title:" + set.ID), Value: text(set.Title), Command: settingCommand("core.settings.sets.update", update), kind: controlText, param: "title", maxLength: setTitleMax})
	layout := b.add(SettingsControl{Name: "core.settings-modal.set", Key: text("layout:" + set.ID), Value: text(set.Layout), Options: []string{"list", "tabs"}, Command: settingCommand("core.settings.sets.update", update),
		kind: controlSelect, param: "layout", labels: map[string]string{"list": "목록", "tabs": "탭"}})
	rows := []settingsRow{{name: "이름", controls: []*SettingsControl{title}}, {name: "배치", controls: []*SettingsControl{layout}}}
	for index, id := range set.Sections {
		row := settingsRow{name: fmt.Sprintf("섹션 %d", index+1), controls: []*SettingsControl{s.sectionSelect(b, set, index, id)}}
		act := func(action, label string) {
			row.controls = append(row.controls, b.button(fmt.Sprintf("%s:%s:%d", action, set.ID, index), "core.settings-modal.row-act", label, "core.settings.sets.row",
				map[string]any{"id": set.ID, "action": action, "index": index, "scope": scope}))
		}
		if index > 0 {
			act("up", "▲")
		}
		if index < len(set.Sections)-1 {
			act("down", "▼")
		}
		act("remove", "−")
		rows = append(rows, row)
	}
	rows = append(rows, settingsRow{controls: []*SettingsControl{b.button("add:"+set.ID, "core.settings-modal.add", "+", "core.settings.sets.row", map[string]any{"id": set.ID, "action": "add", "scope": scope})}},
		settingsRow{controls: []*SettingsControl{b.button("edit:", "core.settings-modal.edit", "완료", "core.settings-modal.edit", map[string]any{"set": nil})}})
	b.group("세트 편집: "+set.Title, "바꾼 값은 바로 저장된다. 같은 섹션은 한 세트에 한 번만 들어간다.", rows...)
}

func (s *Shell) buildSidebars(b *settingsBuilder) error {
	w := &s.settingsWindow
	scope := s.controlScope("sets")
	sets, err := s.settings.Sets(scope)
	if err != nil {
		return err
	}
	if !slices.ContainsFunc(sets, func(set StoredSet) bool { return set.ID == w.editing }) {
		w.editing = ""
	}
	rows := make([]settingsRow, 0, len(sets)+2)
	for _, set := range sets {
		layout := "목록"
		if set.Layout == "tabs" {
			layout = "탭"
		}
		line := b.add(SettingsControl{Name: "core.settings-modal.set-caption", Label: set.Title + " · " + layout + " · " + joinedOr(s.sectionNames(set.Sections), ", ", "섹션 없음"), kind: controlCaption})
		rows = append(rows, settingsRow{controls: []*SettingsControl{line,
			b.pressedButton("edit:"+set.ID, "core.settings-modal.edit", "편집", "core.settings-modal.edit", map[string]any{"set": set.ID}, set.ID == w.editing),
			b.button("delete:"+set.ID, "core.settings-modal.delete", "삭제", "core.settings.sets.delete", map[string]any{"id": set.ID, "scope": scope})}})
	}
	rows = append(rows, settingsRow{controls: []*SettingsControl{b.button("sets:create", "core.settings-modal.create", "새 세트", "core.settings.sets.create", map[string]any{"scope": scope})}})
	if controls := s.overrideControls(b, "sets", "전역 세트 사용"); controls != nil {
		rows = append(rows, settingsRow{controls: controls})
	}
	b.group("세트", "사이드바에 보여 줄 섹션 묶음. 어느 사이드바에 보일지는 일반과 플러그인 페이지에서 고른다.", rows...)
	for _, set := range sets {
		if set.ID == w.editing {
			s.setEditor(b, set)
		}
	}
	return nil
}

// settingsCard is the rectangle of the card in the window.
func (s *Shell) settingsCard() (x, y, width, height float64) {
	x, y = s.settingsCardOrigin()
	height = s.settingsWindow.drawnHeight
	if height == 0 {
		height = s.settingsCardMost()
	}
	return x, y, s.options.Declared.ChromeNumber("set-card-w", "px"), height
}

// settingsCardMost is the largest height of the card in the window.
func (s *Shell) settingsCardMost() float64 { return s.settingsWindow.height * settingsCardMaxShare }

// settingsCardOrigin is the corner of the card in the window.
func (s *Shell) settingsCardOrigin() (x, y float64) {
	w := &s.settingsWindow
	if w.moved {
		return w.x, w.y
	}
	return (w.width - s.options.Declared.ChromeNumber("set-card-w", "px")) / 2, s.options.Declared.ChromeNumber("set-card-top", "px")
}

// clampCard keeps a moved card inside the window.
func (s *Shell) clampCard() {
	w := &s.settingsWindow
	x, y, cardW, cardH := s.settingsCard()
	w.x = max(settingsCardMargin, min(w.width-cardW-settingsCardMargin, x))
	w.y = max(settingsCardMargin, min(w.height-cardH-settingsCardMargin, y))
}

// moveCard moves the card by dx and dy within the window.
func (s *Shell) moveCard(dx, dy float64) {
	w := &s.settingsWindow
	x, y := s.settingsCardOrigin()
	w.moved, w.x, w.y = true, x+dx, y+dy
	s.clampCard()
}

// settingsModalStatus is the value of core.settings-modal.
type settingsModalStatus struct {
	Open     bool               `json:"open"`
	Controls []*SettingsControl `json:"controls"`
	Rows     []settingsRowValue `json:"rows"`
	Query    string             `json:"query"`
	Listed   []string           `json:"listed"`
	Section  string             `json:"section"`
	Scope    string             `json:"scope"`
	Plugin   *string            `json:"plugin"`
	Editing  *string            `json:"editing"`
	Scroll   float64            `json:"scroll"`
	Card     map[string]float64 `json:"card"`
	Pane     map[string]float64 `json:"pane"`
}

type settingsRowValue struct {
	Key         string  `json:"key"`
	Name        string  `json:"name"`
	Description *string `json:"description"`
}

func optional(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}

func (s *Shell) settingsStatus() (any, error) {
	w := &s.settingsWindow
	if !w.open {
		return settingsModalStatus{Controls: []*SettingsControl{}}, nil
	}
	model, err := s.settingsBuild()
	if err != nil {
		return nil, err
	}
	rows := make([]settingsRowValue, len(model.declaredRows))
	for i, row := range model.declaredRows {
		rows[i] = settingsRowValue{Key: row.key, Name: row.name, Description: optional(row.description)}
	}
	listed := model.listed
	if listed == nil {
		listed = []string{}
	}
	status := settingsModalStatus{Open: true, Controls: model.controls, Rows: rows, Query: w.query, Listed: listed, Section: w.section, Scope: w.scope, Scroll: float64(w.scroll.Y)}
	if w.section == "plugins" {
		status.Plugin = optional(w.chosen)
	}
	status.Editing = optional(w.editing)
	x, y, width, height := s.settingsCard()
	status.Card = map[string]float64{"x": x, "y": y, "w": width, "h": height}
	// The pane is the box that scrolls, under the fixed head of the card and beside its section nav: a control is reachable only
	// inside it (docs/spec/settings.md). The card draws its children inside its border, so the pane starts one border width in.
	pane := s.readSettingsPane()
	border := float64(2 * s.palette.BorderWidth)
	status.Pane = map[string]float64{
		"x": x + float64(s.palette.BorderWidth) + float64(pane.navW),
		"y": y + float64(s.palette.BorderWidth) + float64(pane.headH),
		"w": width - border - float64(pane.navW),
		"h": height - border - float64(pane.headH),
	}
	return status, nil
}

// requireSettings is the error of a command of a closed window.
func (s *Shell) requireSettings() error {
	if !s.settingsWindow.open {
		return errors.New("settings are not open")
	}
	return nil
}

// settingsSave writes a change of the settings in the order of the writes.
func (s *Shell) settingsSave(project string, patch map[string]any, remove []string) {
	var id any
	if project != "" {
		id = project
	}
	scope := "common"
	if project != "" {
		scope = "project"
	}
	keys := slices.Concat(slices.Sorted(maps.Keys(patch)), remove)
	cids := s.events.BeginOperation("workbench.settings.change", map[string]any{"scope": scope, "actor": s.settingsActor, "keys": strings.Join(keys, ",")})
	s.settings.BeginSave()
	write := s.settingsIssued
	s.settingsIssued++
	s.calls.Caused(cids).CallInOrder("workspace", "workspace", map[string]any{"kind": "settings", "id": id, "patch": patch, "remove": remove}, func(_ any, err error) {
		s.settings.EndSave()
		s.settingsAnswered(write, err)
		if err != nil {
			s.fail(err)
			return
		}
		// The observer has queued the real workspace completion before this
		// answer. Only the final pending write may request the latest policy;
		// followDiagnostics drains those records before closing either gate.
		if err := s.followDiagnostics(); err != nil {
			s.fail(err)
		}
		s.options.Invalidate()
	})
}

// settingsWait is a command that waits for the settings writes from to before to, with the first failure among them.
type settingsWait struct {
	from, to int
	err      error
	done     func(err error)
}

// afterSettingsWrites runs done once the host answered every settings write that the shell made since it had made from writes, with
// the first failure among the writes that it waited for: a command that changes the settings answers when they are written, as the
// page answers after its store wrote them.
func (s *Shell) afterSettingsWrites(from int, done func(err error)) {
	if s.settingsWritten >= s.settingsIssued || s.settingsIssued == from {
		done(nil)
		return
	}
	s.settingsWaits = append(s.settingsWaits, &settingsWait{from: from, to: s.settingsIssued, done: done})
}

// settingsAnswered records the answer of the settings write and runs each command whose writes are all answered.
func (s *Shell) settingsAnswered(write int, err error) {
	s.settingsWritten++
	waiting := s.settingsWaits[:0]
	var ready []*settingsWait
	for _, wait := range s.settingsWaits {
		if err != nil && wait.err == nil && wait.from <= write && write < wait.to {
			wait.err = err
		}
		if s.settingsWritten >= wait.to {
			ready = append(ready, wait)
		} else {
			waiting = append(waiting, wait)
		}
	}
	s.settingsWaits = waiting
	for _, wait := range ready {
		wait.done(wait.err)
	}
}

// settingsChanged applies the settings after a change.
func (s *Shell) settingsChanged() error {
	if err := s.applySettings(); err != nil {
		return err
	}
	s.followScale()
	s.followSettings()
	if err := s.followDiagnostics(); err != nil {
		return err
	}
	if s.plane != nil {
		s.settle()
	}
	s.options.Invalidate()
	return nil
}

// applySettings takes what the settings hold for the screens: the colors and the shape, and the sets and the links of the sidebars.
func (s *Shell) applySettings() error {
	if err := s.applyPalette(); err != nil {
		return err
	}
	sets, err := decode[[]SidebarSet](s.settings.Value("sets"))
	if err != nil {
		return err
	}
	links, err := decode[[]SidebarLink](s.settings.Value("links"))
	if err != nil {
		return err
	}
	s.sidebars.Adopt(sets, links)
	// The toast deadline follows the automatic-dismissal settings on every load and change of the settings.
	auto, ok := s.settings.Value("autoDismissErrorToasts").(bool)
	if !ok {
		return fmt.Errorf("settings: autoDismissErrorToasts is %s, not a switch", jsonText(s.settings.Value("autoDismissErrorToasts")))
	}
	seconds, ok := s.settings.Value("errorToastDismissSeconds").(float64)
	if !ok {
		return fmt.Errorf("settings: errorToastDismissSeconds is %s, not a number", jsonText(s.settings.Value("errorToastDismissSeconds")))
	}
	s.errors.ConfigureToastDeadline(auto, int64(seconds)*1000)
	s.syncPluginChoices()
	return nil
}

// applyPalette takes the colors and the shape of the settings.
func (s *Shell) applyPalette() error {
	palette, err := s.settings.Palette()
	if err != nil {
		return err
	}
	s.palette = palette
	// The plane of the shown space takes the gap of the settings at once; the settle after the change stores and draws it.
	if s.plane != nil {
		s.plane.SetGap(palette.PlaneGap())
		s.planes.SetSeam(palette.Seam())
	}
	s.tellTheme()
	return nil
}

// pageTheme is the theme that a page of the host reads, as the page workbench sends it: the mode and the token values.
func (s *SettingsStore) pageTheme() (map[string]any, error) {
	values := s.effective(s.common, s.overrides)
	name, _ := values["theme"].(string) // silent: the settings store checks the type of the value.
	theme, err := s.Catalog.Theme(name)
	if err != nil {
		return nil, err
	}
	colors := theme.Dark
	if values["mode"] == "light" {
		colors = theme.Light
	}
	tokens := map[string]string{}
	for _, key := range []string{"bg", "card", "fg", "muted", "edge", "rule", "rail", "focus", "no"} {
		tokens["--"+key] = colors[key]
	}
	// --half-gap is half the gap setting, and half the border width at the seam (halfGap of packages/workbench/settings.js).
	gap, _ := values["gap"].(float64) // silent: the settings store checks the type of the value.
	gap /= 2
	if gap == 0 {
		width, err := strconv.ParseFloat(strings.TrimSuffix(theme.Shape["bw"], "px"), 64)
		if err != nil {
			return nil, fmt.Errorf("theme %s: shape bw: %w", theme.Name, err)
		}
		gap = width / 2
	}
	font := ""
	for _, item := range s.Catalog.Fonts {
		if item.ID == values["font"] {
			font = item.Stack
		}
	}
	tokens["--r"] = valueText(values["radius"]) + "px"
	tokens["--half-gap"] = valueText(gap) + "px"
	tokens["--bw"] = theme.Shape["bw"]
	tokens["--font"] = font
	tokens["--size"] = valueText(values["size"]) + "px"
	return map[string]any{"scheme": values["mode"], "tokens": tokens}, nil
}

// tellTheme sends the theme to the pages of the host.
func (s *Shell) tellTheme() {
	theme, err := s.settings.pageTheme()
	if err != nil {
		s.fail(err)
		return
	}
	if err := s.options.Backdrop(theme["tokens"].(map[string]string)["--card"]); err != nil {
		s.fail(fmt.Errorf("window backdrop: %w", err))
		return
	}
	// A view reads the theme when it starts, so the theme keeps its place among the placements of the surfaces.
	s.calls.CallInOrder(surfaceOrder, "setTheme", theme, func(_ any, err error) {
		if err != nil {
			s.fail(err)
		}
	})
}

// menuLanguage is the language of the application menu: the setting, or for auto the language of the locale, which is the
// default language when the menu has no such language.
func (s *SettingsStore) menuLanguage(locale string) string {
	chosen, _ := s.Value("language").(string) // silent: the settings store checks the type of the value.
	if chosen != "auto" {
		return chosen
	}
	tag := firstPart(strings.ToLower(locale), "-")
	for _, language := range s.Catalog.MenuLanguages {
		if language.ID == tag {
			return tag
		}
	}
	return s.Catalog.Default
}

// tellLanguage sends the language of the application menu when it changed.
func (s *Shell) tellLanguage(locale string) {
	if !s.settings.begun {
		return
	}
	language := s.settings.menuLanguage(locale)
	if language == s.menuLanguage {
		return
	}
	s.menuLanguage = language
	s.calls.CallInOrder("appearance", "setMenuLanguage", language, func(_ any, err error) {
		if err != nil {
			s.fail(err)
		}
	})
}

// Scheme is the color scheme of the effective mode.
func (s *SettingsStore) Scheme() string {
	if s.Value("mode") == "light" {
		return "light"
	}
	return "dark"
}

// Palette is the palette of the effective theme, mode, gap and radius.
func (s *SettingsStore) Palette() (Palette, error) {
	name, _ := s.Value("theme").(string) // silent: the settings store checks the type of the value.
	theme, err := s.Catalog.Theme(name)
	if err != nil {
		return Palette{}, err
	}
	colors := theme.Dark
	if s.Scheme() == "light" {
		colors = theme.Light
	}
	color := func(key string) ui.Color { return ui.Hex(colors[key]) }
	border, err := strconv.ParseFloat(strings.TrimSuffix(theme.Shape["bw"], "px"), 32)
	if err != nil {
		return Palette{}, fmt.Errorf("theme %s: shape bw: %w", theme.Name, err)
	}
	radius, _ := s.Value("radius").(float64) // silent: the settings store checks the type of the value.
	gap, _ := s.Value("gap").(float64)       // silent: the settings store checks the type of the value.
	return Palette{Bg: color("bg"), Card: color("card"), Fg: color("fg"), Muted: color("muted"), Edge: color("edge"), Rule: color("rule"), Rail: color("rail"),
		Focus: color("focus"), No: color("no"), Radius: float32(radius), Gap: float32(gap), BorderWidth: float32(border)}, nil
}

// settingsParam is the parameter of a change of the settings.
type settingsParam struct {
	Key     string          `json:"key"`
	Value   json.RawMessage `json:"value"`
	Scope   string          `json:"scope"`
	Name    string          `json:"name"`
	Mode    string          `json:"mode"`
	Patch   map[string]any  `json:"patch"`
	On      bool            `json:"on"`
	Place   string          `json:"place"`
	Plugin  *string         `json:"plugin"`
	Set     string          `json:"set"`
	ID      string          `json:"id"`
	Title   *string         `json:"title"`
	Layout  *string         `json:"layout"`
	Action  string          `json:"action"`
	Index   int             `json:"index"`
	Section string          `json:"section"`
}

// inScope is scope, or the common scope when it is empty.
func inScope(scope string) string {
	if scope == "" {
		return "common"
	}
	return scope
}

// changing runs a change of the settings that actor makes and applies its result.
func (s *Shell) changing(actor string, change func() error) error {
	if err := s.settingsChange(actor, change); err != nil {
		return err
	}
	return s.settingsChanged()
}

// settingsChange runs a change of the settings that actor, the command that asks for it, makes (docs/spec/logging.md#operation-chains).
func (s *Shell) settingsChange(actor string, change func() error) error {
	s.settingsActor = actor
	return change()
}

// registerSettings adds the commands and the statuses of the settings.
func (s *Shell) registerSettings() {
	s.registry.Status("core.settings", func() any { return s.settings.Status() })
	s.registry.Status("core.settings-modal", func() any {
		status, err := s.settingsStatus()
		if err != nil {
			s.fail(err)
			return settingsModalStatus{Controls: []*SettingsControl{}}
		}
		return status
	})
	s.registerSettingsValues()
	s.registerSettingsSets()
	s.registerSettingsWindow()
}

func (s *Shell) registerSettingsValues() {
	act(s, "core.settings.set", func(value settingsParam) error {
		return invalidSetting(s.changing("core.settings.set", func() error { return s.settings.Set(value.Patch, value.Scope) }))
	})
	act(s, "core.settings.reset", func(value settingsParam) error {
		return s.changing("core.settings.reset", func() error { return s.settings.Reset(value.Key) })
	})
	act(s, "core.settings.debug", func(value settingsParam) error {
		return s.changing("core.settings.debug", func() error { return s.settings.Debug(value.On) })
	})
	act(s, "core.settings.change", func(value settingsParam) error {
		var input any
		if err := json.Unmarshal(value.Value, &input); err != nil {
			return invalidSetting(fmt.Errorf("core.settings.change: %w", err))
		}
		return invalidSetting(s.changing("core.settings.change", func() error { return s.settings.Change(value.Key, input, value.Scope) }))
	})
	act(s, "core.settings.theme", func(value settingsParam) error {
		return s.changing("core.settings.theme", func() error { return s.settings.Theme(value.Name, value.Mode, value.Scope) })
	})
	act(s, "core.settings.link", func(value settingsParam) error { return invalidSetting(s.linkSet(value)) })
}

// linkSet runs core.settings.link.
func (s *Shell) linkSet(value settingsParam) error {
	scope := inScope(value.Scope)
	plugin := ""
	if value.Plugin != nil {
		plugin = *value.Plugin
	}
	links, err := s.settings.Links(scope)
	if err != nil {
		return err
	}
	next, err := ChooseLink(links, value.Place, plugin, value.Set)
	if err != nil {
		return err
	}
	return s.changing("core.settings.link", func() error { return s.settings.Set(map[string]any{"links": next}, scope) })
}

// invalidSetting answers a refused change of the settings as an invalid argument of the command, as invalid of
// packages/workbench/core-exposure.js does (docs/spec/settings.md).
func invalidSetting(err error) error {
	var refused *Refusal
	if err == nil || errors.As(err, &refused) {
		return err
	}
	return Refuse(InvalidParams, "%s", err)
}

func (s *Shell) registerSettingsSets() {
	command(s, "core.settings.sets.create", func(value settingsParam) (any, error) {
		scope := inScope(value.Scope)
		sets, err := s.settings.Sets(scope)
		if err != nil {
			return nil, err
		}
		next := CreateSet(sets)
		id := next[len(next)-1].ID
		if err := s.changing("core.settings.link", func() error { return s.settings.Set(map[string]any{"sets": next}, scope) }); err != nil {
			return nil, err
		}
		if s.settingsWindow.open {
			s.settingsWindow.editing = id
		}
		return map[string]string{"id": id}, nil
	})
	change := func(value settingsParam, change func(sets []StoredSet) ([]StoredSet, error)) error {
		scope := inScope(value.Scope)
		sets, err := s.settings.Sets(scope)
		if err != nil {
			return err
		}
		next, err := change(sets)
		if err != nil {
			return err
		}
		return s.changing("core.settings.link", func() error { return s.settings.Set(map[string]any{"sets": next}, scope) })
	}
	act(s, "core.settings.sets.update", func(value settingsParam) error {
		return invalidSetting(change(value, func(sets []StoredSet) ([]StoredSet, error) {
			return UpdateSet(sets, value.ID, value.Title, value.Layout)
		}))
	})
	act(s, "core.settings.sets.row", func(value settingsParam) error {
		return invalidSetting(change(value, func(sets []StoredSet) ([]StoredSet, error) {
			return ChangeRow(sets, value.ID, value.Action, value.Index, value.Section, s.registeredSections())
		}))
	})
	act(s, "core.settings.sets.delete", func(value settingsParam) error {
		scope := inScope(value.Scope)
		sets, err := s.settings.Sets(scope)
		if err != nil {
			return err
		}
		links, err := s.settings.Links(scope)
		if err != nil {
			return err
		}
		remaining, kept, err := DeleteSet(sets, links, value.ID)
		if err != nil {
			return err
		}
		return s.changing("core.settings.sets.delete", func() error { return s.settings.Set(map[string]any{"sets": remaining, "links": kept}, scope) })
	})
}

// windowParam is the parameter of a command of the window.
type windowParam struct {
	// The members that a command does not declare are omitted, so a run of the workbench gives a command only its own members.
	Section string  `json:"section,omitempty"`
	Scope   string  `json:"scope,omitempty"`
	Plugin  *string `json:"plugin,omitempty"`
	Query   *string `json:"query,omitempty"`
	Set     *string `json:"set,omitempty"`
	Name    *string `json:"name,omitempty"`
	Kind    *string `json:"kind,omitempty"`
	ID      *string `json:"id,omitempty"`
	DX      float64 `json:"dx"`
	DY      float64 `json:"dy"`
}

// windowAct is a command of the open window.
func windowAct(s *Shell, name string, run func(value windowParam) error) {
	act(s, name, func(value windowParam) error {
		if err := s.requireSettings(); err != nil {
			return err
		}
		if err := run(value); err != nil {
			return err
		}
		s.options.Invalidate()
		return nil
	})
}

func (s *Shell) registerSettingsWindow() {
	w := &s.settingsWindow
	act(s, "core.settings.open", func(struct{}) error {
		if err := s.dialogRefusal(); err != nil {
			return err
		}
		s.closeDebug()
		s.closePicker()
		w.open = true
		s.options.Invalidate()
		return nil
	})
	act(s, "core.settings.close", func(struct{}) error { s.closeSettings(); return nil })
	windowAct(s, "core.settings-modal.nav", func(value windowParam) error {
		if !slices.ContainsFunc(settingsSections, func(section [2]string) bool { return section[0] == value.Section }) {
			return fmt.Errorf("unknown settings section %s", value.Section)
		}
		w.section = value.Section
		return nil
	})
	windowAct(s, "core.settings-modal.scope", func(value windowParam) error {
		if value.Scope != "common" && !(value.Scope == "project" && s.settings.Project() != "") {
			return fmt.Errorf("scope %s is not available", value.Scope)
		}
		w.scope = value.Scope
		return nil
	})
	windowAct(s, "core.settings-modal.plugin", func(value windowParam) error {
		if value.Plugin == nil {
			w.chosen = ""
			return nil
		}
		if s.loadedPlugin(*value.Plugin) == nil {
			return fmt.Errorf("unknown plugin %s", *value.Plugin)
		}
		w.chosen = *value.Plugin
		return nil
	})
	windowAct(s, "core.settings-modal.search", func(value windowParam) error {
		if value.Query == nil {
			return errors.New("query must be a string")
		}
		w.query = *value.Query
		return nil
	})
	windowAct(s, "core.settings-modal.edit", func(value windowParam) error {
		if value.Set == nil {
			w.editing = ""
			return nil
		}
		sets, err := s.settings.Sets(s.controlScope("sets"))
		if err != nil {
			return err
		}
		if !slices.ContainsFunc(sets, func(set StoredSet) bool { return set.ID == *value.Set }) {
			return fmt.Errorf("unknown set %s", *value.Set)
		}
		w.editing = *value.Set
		return nil
	})
	windowAct(s, "core.settings-modal.account-name", func(value windowParam) error {
		if err := s.accountPage(); err != nil {
			return err
		}
		if value.Name == nil {
			return errors.New("name must be a string")
		}
		w.accountName = *value.Name
		return nil
	})
	windowAct(s, "core.settings-modal.account-kind", func(value windowParam) error {
		if err := s.accountPage(); err != nil {
			return err
		}
		if value.Kind == nil || !slices.ContainsFunc(s.units[w.chosen].Accounts.Kinds, func(item accountKind) bool { return item.Value == *value.Kind }) {
			kind := ""
			if value.Kind != nil {
				kind = *value.Kind
			}
			return fmt.Errorf("account kind %s is not declared by %s", kind, w.chosen)
		}
		w.accountKind = *value.Kind
		return nil
	})
	windowAct(s, "core.settings-modal.account-edit", func(value windowParam) error {
		if err := s.accountPage(); err != nil {
			return err
		}
		if value.ID == nil {
			w.accountEdit, w.accountEditName = "", ""
			return nil
		}
		accounts, err := s.accounts.List(w.chosen)
		if err != nil {
			return err
		}
		index := slices.IndexFunc(accounts, func(account AccountView) bool { return account.ID == *value.ID })
		if index < 0 {
			return fmt.Errorf("account %s is not defined", *value.ID)
		}
		w.accountEdit, w.accountEditName = *value.ID, accounts[index].Name
		return nil
	})
	windowAct(s, "core.settings-modal.account-edit-name", func(value windowParam) error {
		if err := s.accountPage(); err != nil {
			return err
		}
		if w.accountEdit == "" {
			return errors.New("no account name is edited")
		}
		if value.Name == nil {
			return errors.New("name must be a string")
		}
		w.accountEditName = *value.Name
		return nil
	})
	windowAct(s, "core.settings-modal.move", func(value windowParam) error {
		s.moveCard(value.DX, value.DY)
		return nil
	})
}

// accountPage refuses a field command of the group 계정 while no page of a plugin with accounts shows.
func (s *Shell) accountPage() error {
	w := &s.settingsWindow
	if w.section != "plugins" || w.chosen == "" || !s.accounts.Declares(w.chosen) {
		return errors.New("no page of a plugin with accounts shows")
	}
	return nil
}

// accountFinished clears the name of the row 새 계정 after a finished add and ends the edit after a finished rename, on the page of
// the plugin (docs/spec/plugins.md#accounts).
func (s *Shell) accountFinished(command, plugin string) {
	w := &s.settingsWindow
	if w.accountPlugin != plugin {
		return
	}
	if command == "core.accounts.add" {
		w.accountName = ""
	} else {
		w.accountEdit, w.accountEditName = "", ""
	}
	s.options.Invalidate()
}

// beginSettings takes the common settings and the stored settings of the project of the window. The library selects no project, so it
// shows the common settings (browse of packages/workbench/projects.js selects the project null).
func (s *Shell) beginSettings(common map[string]any) error {
	var overrides map[string]any
	project := s.opened()
	id := ""
	if project != nil && !s.browsing {
		id = project.ID
		if err := member(project.Rest, "settings", &overrides); err != nil {
			return err
		}
	}
	if err := s.settings.Begin(common, overrides, id); err != nil {
		return err
	}
	if err := s.followDiagnostics(); err != nil {
		return err
	}
	return s.applySettings()
}

// closeSettings closes the card.
func (s *Shell) closeSettings() {
	s.settingsWindow.open = false
	s.options.Invalidate()
}

// followDiagnostics puts the settings of the diagnostics in force: the host stores the policy of diagnostics.log and sets the switch
// of the performance trace. The same value is not sent again; a value that the host refused is sent again by the next change.
func (s *Shell) followDiagnostics() error {
	setting, err := decode[map[string]string](s.settings.Value("diagnostics.log"))
	if err != nil {
		return fmt.Errorf("diagnostics.log: %w", err)
	}
	classes := map[string]string{}
	for _, name := range eventClasses {
		classes[name] = "error" // default: a class that the setting does not name stores the errors.
		if level, named := setting[name]; named {
			classes[name] = level
		}
	}
	if text := jsonText(classes); text != s.diagnostics.policy && s.settings.saving == 0 {
		s.diagnostics.policy = text
		// A settings operation changes this policy itself. Its completed
		// workspace call must reach the host before either producer or writer
		// gate changes. Flush acknowledges the actual batches, without making
		// up a completion or allowing an event through a closed gate.
		s.events.Flush(func() {
			if s.events.ended || s.calls.ended.Load() || text != s.diagnostics.policy {
				return
			}
			if s.settings.saving != 0 {
				// A newer write arrived while the batch was in flight. Its
				// answer will request the newest effective policy again.
				s.diagnostics.policy = ""
				return
			}
			s.events.Follow(map[string]any{"classes": classes})
			s.calls.Call("log", map[string]any{"action": "policy", "classes": classes}, func(_ any, err error) {
				if err != nil {
					if text == s.diagnostics.policy {
						s.diagnostics.policy = ""
					}
					s.fail(err)
				}
			})
		})
	}
	action := "off"
	if s.settings.Value("diagnostics.performance") == true {
		action = "on"
	}
	if action != s.diagnostics.trace {
		s.switchTrace(action)
	}
	return nil
}

// switchTrace asks the host to switch the trace (docs/spec/performance-trace.md#the-switch). The trace stops at once and
// starts again only when the host acknowledged on; the requests leave in their order, and an off waits until the trace events
// that were accepted left, as setEnabled of packages/workbench/performance.js does.
func (s *Shell) switchTrace(action string) {
	s.diagnostics.trace = action
	flush := action == "off" && s.events.Traced()
	s.events.Tracing(false)
	s.diagnostics.switches = append(s.diagnostics.switches, traceSwitch{action: action, flush: flush})
	if len(s.diagnostics.switches) == 1 {
		s.sendTraceSwitch()
	}
}

// traceSwitch is a request of the switch of the trace that waits for its turn.
type traceSwitch struct {
	action string
	// flush tells that the request waits until the accepted trace events left.
	flush bool
}

// sendTraceSwitch sends the first waiting request of the switch, and the next one when the host answered it.
func (s *Shell) sendTraceSwitch() {
	request := s.diagnostics.switches[0]
	send := func() {
		s.calls.Call("performance", map[string]string{"action": request.action}, func(_ any, err error) {
			s.diagnostics.switches = s.diagnostics.switches[1:]
			last := len(s.diagnostics.switches) == 0
			switch {
			case err != nil:
				if last {
					s.diagnostics.trace = ""
				}
				s.fail(err)
			case last && request.action == s.diagnostics.trace:
				s.events.Tracing(request.action == "on")
			}
			if !last {
				s.sendTraceSwitch()
			}
		})
	}
	if request.flush {
		s.events.Flush(send)
		return
	}
	send()
}

// orderRows are the rows of an order of listed values (docs/spec/settings.md#controls): one row per value in the current order, named by
// names, with ▲ (absent on the first row) and ▼ (absent on the last row). A button swaps its row with the row above or below and runs
// core.settings.change with the whole new order.
func (s *Shell) orderRows(b *settingsBuilder, key, label string, names map[string]string) []settingsRow {
	scope := s.controlScope(key)
	now, _ := s.value(key).([]any) // silent: the settings store checks that the value is an order of its values.
	rows := []settingsRow{}
	for index, item := range now {
		name, _ := item.(string) // silent: the settings store checks that the value is an order of its values.
		// The row shows the name of its value before its buttons, and the first row the name of the setting, as orderRows of the page.
		row := settingsRow{value: names[name]}
		if index == 0 {
			row.name = label
		}
		act := func(direction, mark string, other int) {
			next := slices.Clone(now)
			next[index], next[other] = next[other], next[index]
			row.controls = append(row.controls, b.button(fmt.Sprintf("order:%s:%d:%s", key, index, direction), "core.settings-modal.order", mark,
				"core.settings.change", map[string]any{"key": key, "value": next, "scope": scope}))
		}
		if index > 0 {
			act("up", "▲", index-1)
		}
		if index < len(now)-1 {
			act("down", "▼", index+1)
		}
		if index == 0 {
			row.controls = append(row.controls, s.overrideControls(b, key, "전역값 사용")...)
		}
		rows = append(rows, row)
	}
	return rows
}
