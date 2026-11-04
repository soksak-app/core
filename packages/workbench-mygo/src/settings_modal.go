package workbench

import (
	"cmp"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strconv"
	"strings"

	"github.com/egoist/mygo/ui"
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
	// Mark is the short text and Icon the SVG elements of the add menu, and Menu the context menu of the surface.
	Mark, Icon string
	Menu       []PluginMenuItem
	Sections   []LoadedSection
	Surface    bool
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
	searchable bool // a field that runs its command for each change, as the plugin search does
}

// settingsRow is a row of a group: a name and its controls, with the key and the description of a declared setting.
type settingsRow struct {
	name        string
	key         string
	description string
	controls    []*SettingsControl
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

// row is a row of one control. In the project scope a setting that the project overrides adds its reset button.
func (s *Shell) row(b *settingsBuilder, name string, control *SettingsControl) settingsRow {
	row := settingsRow{name: name, controls: []*SettingsControl{control}}
	if s.settingsWindow.scope == "project" && control.Key != nil && s.settings.Overridden(*control.Key) {
		row.controls = append(row.controls, b.resetButton(*control.Key, "전역값 사용"))
	}
	return row
}

func (b *settingsBuilder) resetButton(key, label string) *SettingsControl {
	return b.button("reset:"+key, "core.settings-modal.reset", label, "core.settings.reset", map[string]any{"key": key})
}

// setting is the command of a control of the setting key: core.settings.change, or core.settings.link for a link key of the
// form link:<place>:<plugin>.
func (s *Shell) setting(key string) (*ControlCommand, string) {
	scope := s.settingsWindow.scope
	if rest, ok := strings.CutPrefix(key, "link:"); ok {
		place, plugin, _ := strings.Cut(rest, ":")
		params := map[string]any{"place": place, "plugin": nil, "scope": scope}
		if plugin != "" {
			params["plugin"] = plugin
		}
		return settingCommand("core.settings.link", params), "set"
	}
	return settingCommand("core.settings.change", map[string]any{"key": key, "scope": scope}), "value"
}

func (s *Shell) value(key string) any { return s.settings.Scoped(key, s.settingsWindow.scope) }

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

func (s *Shell) toggle(b *settingsBuilder, key string) *SettingsControl {
	on, _ := s.value(key).(bool)
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
			map[string]any{"name": item.Name, "scope": scope}, item.Name == s.value("theme")))
		last := theme.controls[len(theme.controls)-1]
		last.kind, last.theme, last.Label = controlSwatch, item, item.Name
	}
	if scope == "project" && s.settings.Overridden("theme") {
		theme.controls = append(theme.controls, b.resetButton("theme", "전역 테마 사용"))
	}
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

	sets, err := s.settings.Sets(scope)
	if err != nil {
		return err
	}
	links, err := s.settings.Links(scope)
	if err != nil {
		return err
	}
	rows := []settingsRow{s.row(b, "왼쪽 사이드바 보이기", s.toggle(b, "left")), s.row(b, "오른쪽 사이드바 보이기", s.toggle(b, "right"))}
	for _, side := range [][2]string{{"left", "왼쪽 사이드바 세트"}, {"right", "오른쪽 사이드바 세트"}} {
		row, err := s.linkChoice(b, side[1], side[0], "", sets, links)
		if err != nil {
			return err
		}
		rows = append(rows, row)
	}
	if scope == "project" && s.settings.Overridden("links") {
		rows = append(rows, settingsRow{controls: []*SettingsControl{b.resetButton("links", "전역 연결 사용")}})
	}
	b.group("사이드바", "표시 스위치는 해당 변의 모든 창 사이드바에 적용된다. 일반 세트와 플러그인 창 세트는 각각 독립된 열에 표시된다.", rows...)

	widths := catalog.Settings.LayoutRanges
	b.group("사이드바 크기", "사이드바의 폭(pt). 처음 폭은 카드 안 사이드바와 새 창 사이드바 열이 여는 폭이며 최소 폭과 최대 폭 사이여야 한다.",
		s.row(b, "최소 폭", s.slide(b, "sidebarMinWidth", widths["sidebarMinWidth"], "pt")),
		s.row(b, "최대 폭", s.slide(b, "sidebarMaxWidth", widths["sidebarMaxWidth"], "pt")),
		s.row(b, "처음 폭", s.slide(b, "sidebarWidth", widths["sidebarWidth"], "pt")))
	b.group("표시", "배치는 그대로 두고 보이는 모습만 바꾼다.",
		choice("포커스 표시", "focusInd", map[string]string{"border": "테두리", "corner": "꺽쇠"}),
		choice("경계선", "fullRule", map[string]string{"under": "가림", "over": "보임", "none": "숨김"}),
		s.row(b, "포커스 밖 흐리게", s.toggle(b, "dim")))

	languages := map[string]string{"auto": "자동"}
	for _, language := range catalog.MenuLanguages {
		languages[language.ID] = language.Label
	}
	b.group("언어", "애플리케이션 메뉴가 이 언어를 따른다. 자동은 시스템 언어이고 목록에 없으면 영어다.", choice("언어", "language", languages))
	if scope == "common" {
		b.group("메모리", "메모리 절약을 켜면 숨긴 지 정한 시간이 지난 탭을 내리고, 다시 보일 때 저장된 상태로 다시 연다.",
			s.row(b, "메모리 절약", s.toggle(b, "memorySaver")),
			s.row(b, "숨긴 뒤 내리기까지", s.slide(b, "memorySaverDelay", catalog.Settings.MemorySaverDelay, "분")))
		on := s.settings.DebugOn()
		debug := b.add(SettingsControl{Name: "core.settings-modal.debug", Label: "디버그", On: &on, Command: settingCommand("core.settings.debug", nil), kind: controlSwitch, param: "on"})
		b.group("진단", "디버그를 켜면 성능 트레이스와 모든 로그 종류의 상세 기록이 남는다. 끄면 오류만 기록된다.", settingsRow{name: "디버그", controls: []*SettingsControl{debug}})
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
	for _, plugin := range matched {
		rows = append(rows, settingsRow{controls: []*SettingsControl{b.button("plugin:"+plugin.ID, "core.settings-modal.plugin", plugin.Name, "core.settings-modal.plugin", map[string]any{"plugin": plugin.ID})}})
		b.model.listed = append(b.model.listed, plugin.ID)
	}
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
	case "integer":
		return s.slide(b, definition.Key, [2]float64{definition.Minimum, definition.Maximum}, ""), nil
	case "string":
		return s.textField(b, definition.Key, definition.MaxLength), nil
	case "address":
		return s.textField(b, definition.Key, 2048), nil
	}
	return nil, fmt.Errorf("setting %s has no control for type %s", definition.Key, definition.Type)
}

func (s *Shell) buildPluginPage(b *settingsBuilder, plugin *LoadedPlugin) error {
	scope := s.settingsWindow.scope
	back := b.button("plugins:list", "core.settings-modal.back", "목록", "core.settings-modal.plugin", map[string]any{"plugin": nil})
	b.group(plugin.Name, plugin.ID, settingsRow{controls: []*SettingsControl{back}})
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
	window, err := choices([][2]string{{"window-left", "창 왼쪽 사이드바"}, {"window-right", "창 오른쪽 사이드바"}})
	if err != nil {
		return err
	}
	b.group("창 사이드바", "포커스와 무관하게 창 가장자리에 표시한다.", window...)
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
	scope := s.settingsWindow.scope
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
	scope := s.settingsWindow.scope
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
	sets, err := s.settings.Sets(w.scope)
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
			b.button("delete:"+set.ID, "core.settings-modal.delete", "삭제", "core.settings.sets.delete", map[string]any{"id": set.ID, "scope": w.scope})}})
	}
	rows = append(rows, settingsRow{controls: []*SettingsControl{b.button("sets:create", "core.settings-modal.create", "새 세트", "core.settings.sets.create", map[string]any{"scope": w.scope})}})
	if w.scope == "project" && s.settings.Overridden("sets") {
		rows = append(rows, settingsRow{controls: []*SettingsControl{b.resetButton("sets", "전역 세트 사용")}})
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
	w := &s.settingsWindow
	cardW, _ := s.options.Declared.Metric("set-card-w")
	top, _ := s.options.Declared.Metric("set-card-top")
	x, y = (w.width-cardW)/2, top
	if w.moved {
		x, y = w.x, w.y
	}
	return x, y, cardW, w.height * settingsCardMaxShare
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
	x, y, _, _ := s.settingsCard()
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
	s.settings.BeginSave()
	s.calls.CallInOrder("workspace", "workspace", map[string]any{"kind": "settings", "id": id, "patch": patch, "remove": remove}, func(_ any, err error) {
		s.settings.EndSave()
		if err != nil {
			s.fail(err)
			return
		}
		s.options.Invalidate()
	})
}

// settingsChanged applies the settings after a change.
func (s *Shell) settingsChanged() error {
	if err := s.applyPalette(); err != nil {
		return err
	}
	s.options.Invalidate()
	return nil
}

// applyPalette takes the colors and the shape of the settings.
func (s *Shell) applyPalette() error {
	palette, err := s.settings.Palette()
	if err != nil {
		return err
	}
	s.palette = palette
	s.tellTheme()
	return nil
}

// pageTheme is the theme that a page of the host reads, as the page workbench sends it: the mode and the token values.
func (s *SettingsStore) pageTheme() (map[string]any, error) {
	values := s.effective(s.common, s.overrides)
	name, _ := values["theme"].(string)
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
	gap, _ := values["gap"].(float64)
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
	chosen, _ := s.Value("language").(string)
	if chosen != "auto" {
		return chosen
	}
	tag, _, _ := strings.Cut(strings.ToLower(locale), "-")
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

// Palette is the palette of the effective theme, mode, gap and radius.
func (s *SettingsStore) Palette() (Palette, error) {
	name, _ := s.Value("theme").(string)
	theme, err := s.Catalog.Theme(name)
	if err != nil {
		return Palette{}, err
	}
	colors := theme.Dark
	if s.Value("mode") == "light" {
		colors = theme.Light
	}
	color := func(key string) ui.Color { return ui.Hex(colors[key]) }
	border, err := strconv.ParseFloat(strings.TrimSuffix(theme.Shape["bw"], "px"), 32)
	if err != nil {
		return Palette{}, fmt.Errorf("theme %s: shape bw: %w", theme.Name, err)
	}
	radius, _ := s.Value("radius").(float64)
	gap, _ := s.Value("gap").(float64)
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

// changing runs a change of the settings and applies its result.
func (s *Shell) changing(change func() error) error {
	if err := change(); err != nil {
		return err
	}
	return s.settingsChanged()
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
		return s.changing(func() error { return s.settings.Set(value.Patch, value.Scope) })
	})
	act(s, "core.settings.reset", func(value settingsParam) error {
		return s.changing(func() error { return s.settings.Reset(value.Key) })
	})
	act(s, "core.settings.debug", func(value settingsParam) error {
		return s.changing(func() error { return s.settings.Debug(value.On) })
	})
	act(s, "core.settings.change", func(value settingsParam) error {
		var input any
		if err := json.Unmarshal(value.Value, &input); err != nil {
			return fmt.Errorf("core.settings.change: %w", err)
		}
		return s.changing(func() error { return s.settings.Change(value.Key, input, value.Scope) })
	})
	act(s, "core.settings.theme", func(value settingsParam) error {
		return s.changing(func() error { return s.settings.Theme(value.Name, value.Mode, value.Scope) })
	})
	act(s, "core.settings.link", func(value settingsParam) error {
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
		return s.changing(func() error { return s.settings.Set(map[string]any{"links": next}, scope) })
	})
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
		if err := s.changing(func() error { return s.settings.Set(map[string]any{"sets": next}, scope) }); err != nil {
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
		return s.changing(func() error { return s.settings.Set(map[string]any{"sets": next}, scope) })
	}
	act(s, "core.settings.sets.update", func(value settingsParam) error {
		return change(value, func(sets []StoredSet) ([]StoredSet, error) {
			return UpdateSet(sets, value.ID, value.Title, value.Layout)
		})
	})
	act(s, "core.settings.sets.row", func(value settingsParam) error {
		return change(value, func(sets []StoredSet) ([]StoredSet, error) {
			return ChangeRow(sets, value.ID, value.Action, value.Index, value.Section, s.registeredSections())
		})
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
		return s.changing(func() error { return s.settings.Set(map[string]any{"sets": remaining, "links": kept}, scope) })
	})
}

// windowParam is the parameter of a command of the window.
type windowParam struct {
	Section string  `json:"section"`
	Scope   string  `json:"scope"`
	Plugin  *string `json:"plugin"`
	Query   *string `json:"query"`
	Set     *string `json:"set"`
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
		s.closePicker()
		w.open = true
		s.options.Invalidate()
		return nil
	})
	act(s, "core.settings.close", func(struct{}) error {
		w.open = false
		s.options.Invalidate()
		return nil
	})
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
		sets, err := s.settings.Sets(w.scope)
		if err != nil {
			return err
		}
		if !slices.ContainsFunc(sets, func(set StoredSet) bool { return set.ID == *value.Set }) {
			return fmt.Errorf("unknown set %s", *value.Set)
		}
		w.editing = *value.Set
		return nil
	})
	windowAct(s, "core.settings-modal.move", func(value windowParam) error {
		s.moveCard(value.DX, value.DY)
		return nil
	})
}

// beginSettings takes the stored settings of the window and of its project.
func (s *Shell) beginSettings() error {
	var overrides map[string]any
	project := s.opened()
	id := ""
	if project != nil {
		id = project.ID
		if err := member(project.Rest, "settings", &overrides); err != nil {
			return err
		}
	}
	if err := s.settings.Begin(s.commonSettings, overrides, id); err != nil {
		return err
	}
	return s.applyPalette()
}
