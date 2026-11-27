package workbench

import (
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"slices"
	"strconv"
	"strings"

	"github.com/egoist/mygo/ui"
)

// The settings tab of the mygo host (docs/spec/settings.md): native UI instead of the modal web view of the other hosts. A
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

// settingsPages are the pages of the settings tab in menu order, with their labels (docs/spec/settings.md#menu). The plugin page is
// opened from the menu's plugin items and from Installed, and the menu does not list it.
var settingsPages = [][2]string{{"look", "모양"}, {"workspace", "작업 공간"}, {"sets", "사이드바 세트"}, {"behavior", "동작"},
	{"agents", "에이전트 연동"}, {"diag", "진단"}, {"installed", "설치됨"}, {"browse", "찾아보기"}, {"plugin", "플러그인"}}

// settingsName is the title of the settings tab.
const settingsName = "설정"

// The placement of the card, as the chrome metrics of workbench.json hold them: its width, its top, the share of the window
// height that it fills at most, and the margin that a moved card keeps from the window edges.
const (
	settingsCardMaxShare = 0.74
)

// The kinds of a control of the card.
type controlKind int

const (
	controlButton controlKind = iota
	controlSwatch
	controlSwitch
	controlSelect
	// controlSegment is a choice of two or three listed values, with one button per value (docs/spec/settings.md#controls).
	controlSegment
	controlSlider
	// controlStepper is a small bounded integer with its unit, changed one step at a time by its − and + buttons.
	controlStepper
	controlText
	controlCaption
	// controlMark is the mark of the common tab that the project value of its setting applies.
	controlMark
	// controlSetup is a row of the agent group, with the name, state, file and optional action of a setup part.
	controlSetup
	// controlAccount is a row of the group Accounts, with the line and the usage lines of an account and its buttons.
	controlAccount
	// controlChip is a section chip of a set, and controlBadge a badge of a row (docs/spec/settings.md#pages).
	controlChip
	controlBadge
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
	// small is the size sm of a button, 24 points high (docs/spec/settings.md#controls).
	small bool
	// dot says that the item of the menu shows the dot of a plugin with settings (docs/spec/settings.md#menu).
	dot     bool
	Name    string          `json:"name"`
	Index   int             `json:"index"`
	Key     *string         `json:"key"`
	Label   string          `json:"label"`
	On      *bool           `json:"on"`
	Value   *string         `json:"value"`
	Command *ControlCommand `json:"command"`
	Options []string        `json:"options"`
	Groups  []OptionGroup   `json:"groups"`
	// Disabled is true while the control takes no press: a dependent setting whose parent is off, a side whose switch is off for its
	// set select, and the first row's ↑ or the last row's ↓ (docs/spec/settings.md#status).
	Disabled bool `json:"disabled"`
	// Primary says that the button is the primary button of its group, drawn with the accent color (docs/spec/settings.md#controls).
	Primary bool `json:"primary"`

	kind controlKind
	// missingTip is the tooltip of a section chip whose plugin is not loaded (docs/spec/plugins.md#missing-plugins).
	missingTip string
	title      string            // the title of a button, which shows as its tip while the pointer rests on it (docs/spec/settings.md#pages)
	param      string            // the parameter that takes the value of the control
	labels     map[string]string // the text of each option
	lo, hi     float64           // the bounds of a slider
	unit       string
	theme      *CatalogTheme // the theme of a swatch
	maxLength  int
	searchable bool        // a field that runs its command for each change, as the plugin search does
	tone       string      // the tone of a badge: ok, acc, warn, err or neutral (docs/spec/settings.md#controls)
	setup      *setupRow   // the content of a row of the agent group
	account    *accountRow // the content of a row of the group Accounts
}

// accountRow is the content of a row of the group Accounts: the line of the account, its usage lines and its controls.
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
	// plugin is the id of the plugin of a row of Installed, which the row is named by (docs/spec/settings.md#plugins).
	plugin string
	// aboutLines says that each line of the description is one element core.settings-tab.plugins.about (docs/spec/settings.md#plugin-page).
	aboutLines bool
	controls   []*SettingsControl
	// list says that the controls stand in the flow of a line, one after the other (.set-list).
	list bool
	// side says that the row is a row of the sidebar list: number is its number in the order, and name its side name
	// (docs/spec/settings.md#pages).
	side   bool
	number string
	// indent says that the row depends on a parent setting, so it is indented under it, and disabled that its controls take no
	// press while the parent is off (docs/spec/settings.md#dependency-and-validation-rules).
	indent, disabled bool
}

// settingsGroup is a group of rows with its name and its one-line text.
type settingsGroup struct {
	name, text string
	rows       []settingsRow
}

// settingsModel is the card: its section buttons, its scope buttons, the folder of the project scope and its groups.
type settingsModel struct {
	close        *SettingsControl
	find         *SettingsControl
	nav, scopes  []*SettingsControl
	folder       string
	groups       []settingsGroup
	declaredRows []settingsRow
	listed       []string
	controls     []*SettingsControl
	// actions are the action buttons of the plugin rows and pages, labels the row name of each control key, shown the number of
	// catalog rows that Browse shows, and results the result of a search.
	actions []settingsActionStatus
	labels  map[string]string
	shown   int
	results *settingsResultsStatus
}

// settingsTab is the state of the window of a shell. Its section, scope, search, plugin and edited set outlast a close.
type settingsTab struct {
	open bool
	// openedOnce says that this window has opened its settings tab, so the work screen shows the closed hint after a close.
	openedOnce  bool
	page, scope string
	// find is the text of the menu search, filter the filter of Installed and back the page of the back link of the plugin page.
	find, filter, back string
	// browse is the state of Browse, confirm the open confirmation and undo the toast of the last change.
	browse  settingsBrowse
	confirm settingsConfirm
	undo    *settingsUndo
	// locale is the language of the frame that the model was built for.
	locale          string
	query           string
	chosen, editing string
	width, height   float64
	scroll          ui.ScrollState
	scrollKey       string
	// revealGroup is the name of the group that the next draw scrolls into view, from core.settings-tab.nav with a group.
	revealGroup string
	drafts      map[string]string
	// The fields of the group Accounts of the shown plugin page (docs/spec/plugins.md#accounts): the plugin of the page, the name and the
	// kind of the row of core.settings-tab.account-add, the account whose name is edited and the text of its field. Another page clears them.
	accountPlugin, accountName, accountKind, accountEdit, accountEditName string
	// builds counts the models that settingsBuild built, which the tests read (SettingsModelBuilds).
	builds int
	// inputs advances with each change of a setting, the plugins or the accounts; the model is kept while its key holds.
	inputs uint64
	model  *settingsModel
	key    settingsKey
}

// settingsKey is what the settings model reads besides the settings, the plugins and the accounts: a change of any field rebuilds the
// model (docs/spec/settings.md#performance).
type settingsKey struct {
	inputs, setup                    uint64
	plugins                          int
	operation                        PluginOperation
	locale, project                  string
	page, scope, query, find, filter string
	browse                           settingsBrowse
	confirm                          settingsConfirm
	chosen, editing                  string
	accountPlugin                    string
	accountName, accountKind         string
	accountEdit, accountEditName     string
}

// settingsInputsChanged records a change that the settings model reads and asks the window for a frame.
func (s *Shell) settingsInputsChanged() {
	s.settingsTab.inputs++
	s.options.Invalidate()
}

// SettingsModelBuilds returns how many settings models the shell has built.
func (s *Shell) SettingsModelBuilds() int { return s.settingsTab.builds }

func newSettingsTab() settingsTab {
	return settingsTab{page: "look", scope: "common", filter: "all", back: "installed", browse: settingsBrowse{limit: settingsBrowseFirst}, drafts: map[string]string{}}
}

// builder adds the controls of a card in document order.
type settingsBuilder struct {
	model  *settingsModel
	counts map[string]int
	// descriptions holds the description of each declared row, by its setting key (docs/spec/settings.md#rows).
	descriptions map[string]string
}

// declaredDescriptions returns the description of each declared row that has one, by its setting key.
func declaredDescriptions(rows declaredRows) map[string]string {
	descriptions := map[string]string{}
	for _, groups := range rows.Groups {
		for _, group := range groups {
			for _, row := range group.Rows {
				if row.Description != "" {
					descriptions[row.Key] = row.Description
				}
			}
		}
	}
	return descriptions
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

// small is a button of the small size sm, which is 24 points high (docs/spec/settings.md#controls).
func (b *settingsBuilder) small(key, name, label, command string, params map[string]any) *SettingsControl {
	control := b.button(key, name, label, command, params)
	control.small = true
	return control
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
	w := &s.settingsTab
	store := s.settings
	if store.Project() == "" {
		w.scope = "common"
	}
	w.builds++
	model := &settingsModel{labels: map[string]string{}}
	b := &settingsBuilder{model: model, counts: map[string]int{}, descriptions: declaredDescriptions(s.settings.Catalog.Rows)}
	model.close = b.add(SettingsControl{Name: "core.settings-tab.close", Key: text("close"), Label: "닫는다", Command: settingCommand("core.settings.close", nil), kind: controlButton})
	// The menu lists the pages of Settings and Plugins; the plugin page is opened by a plugin item.
	for _, page := range settingsPages[:len(settingsPages)-1] {
		model.nav = append(model.nav, b.pressedButton("nav:"+page[0], "core.settings-tab.nav", page[1], "core.settings-tab.nav",
			map[string]any{"page": page[0]}, page[0] == w.page))
	}
	// The plugins with settings or accounts follow the pages in the group of their plugin items, by id (docs/spec/settings.md#menu).
	for _, plugin := range s.pluginMenuItems() {
		item := b.pressedButton("plugin:"+plugin.ID, "core.settings-tab.plugin-item", plugin.Name, "core.settings-tab.plugin",
			map[string]any{"plugin": plugin.ID}, w.page == "plugin" && w.chosen == plugin.ID)
		item.dot = true
		model.nav = append(model.nav, item)
	}
	// The search field stands at the top of the menu and runs core.settings-tab.find for each change (docs/spec/settings.md#menu).
	model.find = b.add(SettingsControl{Name: "core.settings-tab.find", Key: text("find"), Value: text(w.find), Command: settingCommand("core.settings-tab.find", nil),
		kind: controlText, param: "query", searchable: true, Label: "설정 찾기"})
	scopes := [][2]string{{"common", "전역"}}
	if store.Project() != "" {
		scopes = append(scopes, [2]string{"project", "프로젝트"})
	}
	for _, scope := range scopes {
		model.scopes = append(model.scopes, b.pressedButton("pick:scope:"+scope[0], "core.settings-tab.scope", scope[1], "core.settings-tab.scope",
			map[string]any{"scope": scope[0]}, scope[0] == w.scope))
	}
	if w.scope == "project" {
		project := s.opened()
		if project == nil {
			return nil, errors.New("the project settings scope has no active project")
		}
		model.folder = project.Root
	}
	// A query of the menu search replaces the page with its results (docs/spec/settings.md#search).
	if w.find != "" {
		match := s.matchSettings(store, w.find)
		model.results = &settingsResultsStatus{Settings: match.keys(), Plugins: match.installed, Catalog: len(match.catalog)}
		if err := s.buildSearch(b, w.find, match); err != nil {
			return nil, err
		}
		return model, nil
	}
	if err := s.pageBuilders()[w.page](b); err != nil {
		return nil, err
	}
	return model, nil
}

// pageBuilders returns the builder of each page of the settings tab, by page id.
func (s *Shell) pageBuilders() map[string]func(*settingsBuilder) error {
	return map[string]func(*settingsBuilder) error{"look": s.buildLook, "workspace": s.buildWorkspace, "sets": s.buildSets,
		"behavior": s.buildBehavior, "agents": s.buildAgents, "diag": s.buildDiag, "installed": s.buildInstalled, "browse": s.buildBrowse,
		"plugin": s.buildPluginTab}
}

func (b *settingsBuilder) group(name, text string, rows ...settingsRow) {
	// A row without its own description takes the declared description of its setting, as the web rows do.
	for i := range rows {
		if rows[i].description == "" && len(rows[i].controls) > 0 && rows[i].controls[0].Key != nil {
			rows[i].description = b.descriptions[*rows[i].controls[0].Key]
		}
	}
	b.model.groups = append(b.model.groups, settingsGroup{name: name, text: text, rows: rows})
}

// row is a row of one control. A setting that the project overrides adds its reset button in the project tab and its mark in
// the common tab.
func (s *Shell) row(b *settingsBuilder, name string, control *SettingsControl) settingsRow {
	row := settingsRow{name: name, controls: []*SettingsControl{control}}
	if control.Key != nil {
		b.model.labels[*control.Key] = name
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
	if s.settingsTab.scope == "project" {
		return []*SettingsControl{b.resetButton(key, reset)}
	}
	return []*SettingsControl{b.add(SettingsControl{Name: "core.settings-tab.applied", Key: text("applied:" + key), Label: "프로젝트 값", kind: controlMark})}
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
	if s.settingsTab.scope == "project" {
		return "project"
	}
	return s.settings.Source(settingOf(key))
}

func (b *settingsBuilder) resetButton(key, label string) *SettingsControl {
	return b.button("reset:"+key, "core.settings-tab.reset", label, "core.settings.reset", map[string]any{"key": key})
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
	return b.add(SettingsControl{Name: "core.settings-tab.choice", Key: text(key), Value: text(now), Command: command, Options: values, kind: choiceKind(len(values)), param: param, labels: labels}), nil
}

// choiceKind is the control of a listed choice: a segment for two or three values, a select box for more (docs/spec/settings.md#controls).
func choiceKind(count int) controlKind {
	if count <= 3 {
		return controlSegment
	}
	return controlSelect
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
	return b.add(SettingsControl{Name: "core.settings-tab.choice", Key: text(key), Value: value, Command: command, Options: values, kind: controlSelect, param: param, labels: labels})
}

// syncPluginChoices shows the error that asks for a choice of each plugin setting that has no value, and withdraws it when the setting
// has one (docs/spec/plugins.md#settings-declarations).
// syncMissingPlugins shows the load error of each plugin setting whose stored value names no loaded plugin, and withdraws the error of a
// setting that is no longer missing. Each error is shown under the key (docs/spec/plugins.md#settings-declarations).
func (s *Shell) syncMissingPlugins() {
	for _, definition := range s.settings.Definitions {
		if definition.Type != "plugin" {
			continue
		}
		source := "settings " + definition.Key
		if _, missing := s.settings.Missing(definition.Key); missing {
			s.errors.ShowFrom(workbenchErrorPlace, source, s.settings.MissingError(definition.Key), "")
		} else {
			s.errors.HideFrom(workbenchErrorPlace, source)
		}
	}
}

func (s *Shell) syncPluginChoices() {
	for _, definition := range s.settings.Definitions {
		if definition.Type != "plugin" {
			continue
		}
		// A stored value that names no loaded plugin is shown by its own error, not by the choice (docs/spec/plugins.md#settings-declarations).
		if _, missing := s.settings.Missing(definition.Key); missing {
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
	return b.add(SettingsControl{Name: "core.settings-tab.set", Key: text(key), On: &on, Value: text(strconv.FormatBool(on)), Command: command, kind: controlSwitch, param: param})
}

func (s *Shell) slide(b *settingsBuilder, key string, bounds [2]float64, unit string) *SettingsControl {
	now := valueText(s.value(key))
	command, param := s.setting(key)
	return b.add(SettingsControl{Name: "core.settings-tab.step", Key: text(key), Value: text(now), Command: command, kind: controlSlider, param: param, lo: bounds[0], hi: bounds[1], unit: unit})
}

// stepper is a stepper of a small bounded integer: its element is core.settings-tab.step, and its buttons change the value by one.
func (s *Shell) stepper(b *settingsBuilder, key string, bounds [2]float64, unit string) *SettingsControl {
	now := valueText(s.value(key))
	command, param := s.setting(key)
	return b.add(SettingsControl{Name: "core.settings-tab.step", Key: text(key), Value: text(now), Command: command, kind: controlStepper, param: param, lo: bounds[0], hi: bounds[1], unit: unit})
}

func (s *Shell) textField(b *settingsBuilder, key string, maxLength int) *SettingsControl {
	command, param := s.setting(key)
	return b.add(SettingsControl{Name: "core.settings-tab.text", Key: text(key), Value: text(valueText(s.value(key))), Command: command, kind: controlText, param: param, maxLength: maxLength})
}

// sectionNames are the names of the section ids.
func (s *Shell) sectionNames(ids []string) []string {
	names := make([]string, len(ids))
	for i, id := range ids {
		names[i] = id
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

// setOptions are the choices of a sidebar: not used and every set, each with its layout and its number of sections as the hint
// (docs/spec/settings.md#pages).
func (s *Shell) setOptions(sets []StoredSet) [][2]string {
	options := [][2]string{{"off", "사용 안 함"}}
	for _, set := range sets {
		layout := "목록"
		if set.Layout == "tabs" {
			layout = "탭"
		}
		options = append(options, [2]string{set.ID, fmt.Sprintf("%s (%s · %d)", set.Title, layout, len(set.Sections))})
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
	// A set reference is a select box whatever the number of its options (docs/spec/settings.md#controls).
	control.kind = controlSelect
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

// pluginMenuItems returns the loaded plugins that declare settings or accounts, by id (docs/spec/settings.md#menu).
func (s *Shell) pluginMenuItems() []*LoadedPlugin {
	items := []*LoadedPlugin{}
	for i := range s.plugins {
		if unit := s.units[s.plugins[i].ID]; unit != nil && (len(unit.Settings) > 0 || unit.Accounts != nil) {
			items = append(items, &s.plugins[i])
		}
	}
	slices.SortFunc(items, func(a, b *LoadedPlugin) int { return strings.Compare(a.ID, b.ID) })
	return items
}

func (s *Shell) loadedPlugin(id string) *LoadedPlugin {
	for i := range s.plugins {
		if s.plugins[i].ID == id {
			return &s.plugins[i]
		}
	}
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

// accountField is a text field of the group Accounts that runs command with its text as name.
func accountField(b *settingsBuilder, key, command, now string) *SettingsControl {
	return b.add(SettingsControl{Name: "core.settings-tab." + key, Key: text(key), Value: text(now), Command: settingCommand(command, nil), kind: controlText, param: "name", maxLength: 40})
}

// buildAccounts adds the group Accounts of a plugin that declares accounts: a row per account and the row of core.settings-tab.account-add.
func (s *Shell) buildAccounts(b *settingsBuilder, plugin *LoadedPlugin, declared *accountsDeclaration) {
	w := &s.settingsTab
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
		row := b.add(SettingsControl{Name: "core.settings-tab.account", kind: controlAccount, account: content})
		params := map[string]any{"plugin": plugin.ID, "id": account.ID}
		if w.accountEdit == account.ID {
			content.controls = append(content.controls,
				accountField(b, "account-edit-name", "core.settings-tab.account-edit-name", w.accountEditName),
				b.button("account-save:"+account.ID, "core.settings-tab.account-save", "저장", "core.accounts.rename", map[string]any{"plugin": plugin.ID, "id": account.ID, "name": w.accountEditName}),
				b.button("account-edit-cancel:"+account.ID, "core.settings-tab.account-edit-cancel", "취소", "core.settings-tab.account-edit", map[string]any{"id": nil}))
		} else {
			switch {
			case account.Running:
				content.controls = append(content.controls, b.button("account-login-cancel:"+account.ID, "core.settings-tab.account-login-cancel", "취소", "core.accounts.login-cancel", params))
			case account.Login != nil && !*account.Login:
				content.controls = append(content.controls, b.button("account-login:"+account.ID, "core.settings-tab.account-login", "로그인", "core.accounts.login", params))
			case account.Login != nil && *account.Login:
				content.controls = append(content.controls, b.button("account-logout:"+account.ID, "core.settings-tab.account-logout", "로그아웃", "core.accounts.logout", params))
			}
			content.controls = append(content.controls,
				b.button("account-edit:"+account.ID, "core.settings-tab.account-edit", "이름 변경", "core.settings-tab.account-edit", map[string]any{"id": account.ID}),
				b.button("account-remove:"+account.ID, "core.settings-tab.account-remove", "삭제", "core.accounts.remove", params))
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
	name := accountField(b, "account-name", "core.settings-tab.account-name", w.accountName)
	kind := b.add(SettingsControl{Name: "core.settings-tab.account-kind", Key: text("account-kind"), Value: text(w.accountKind), Command: settingCommand("core.settings-tab.account-kind", nil),
		Options: values, kind: controlSelect, param: "kind", labels: labels})
	add := b.button("account-add", "core.settings-tab.account-add", "추가", "core.accounts.add", map[string]any{"plugin": plugin.ID, "name": w.accountName, "kind": w.accountKind})
	rows = append(rows, settingsRow{name: "새 계정", controls: []*SettingsControl{name, kind, add}})
	b.group("계정", plugin.Name+" 플러그인이 실행하는 CLI의 계정. 로그인은 시스템 브라우저에서 한다.", rows...)
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
// settingsTabStatus is the value of core.settings-tab while the tab is in front; every field is present (docs/spec/settings.md#status).
type settingsTabStatus struct {
	Page     string                 `json:"page"`
	Scope    string                 `json:"scope"`
	Find     string                 `json:"find"`
	Query    string                 `json:"query"`
	Filter   string                 `json:"filter"`
	Browse   settingsBrowseStatus   `json:"browse"`
	Listed   []string               `json:"listed"`
	Actions  []settingsActionStatus `json:"actions"`
	Plugin   *string                `json:"plugin"`
	Back     string                 `json:"back"`
	Editing  *string                `json:"editing"`
	Rows     []settingsRowValue     `json:"rows"`
	Controls []*SettingsControl     `json:"controls"`
	Scroll   float64                `json:"scroll"`
	Undo     *settingsUndoStatus    `json:"undo"`
	Confirm  *settingsConfirmStatus `json:"confirm"`
	Errors   []settingsErrorStatus  `json:"errors"`
	Results  *settingsResultsStatus `json:"results"`
	Missing  []string               `json:"missing"`
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

// settingsStatus is the value of core.settings-tab: nil while the tab is not in front. The model is read through the key of the frame,
// so a command that changed the state reports the state at once, without a frame.
func (s *Shell) settingsStatus() (any, error) {
	w := &s.settingsTab
	if !w.open {
		return nil, nil
	}
	model, err := s.settingsModelNow()
	if err != nil {
		return nil, err
	}
	rows := make([]settingsRowValue, len(model.declaredRows))
	for i, row := range model.declaredRows {
		rows[i] = settingsRowValue{Key: row.key, Name: row.name, Description: optional(row.description)}
	}
	status := settingsTabStatus{Page: w.page, Scope: w.scope, Find: w.find, Query: w.query, Filter: w.filter, Back: w.back,
		Browse:   settingsBrowseStatus{Query: w.browse.query, HideInstalled: w.browse.hideInstalled, Shown: model.shown},
		Listed:   settingsList(model.listed),
		Actions:  settingsList(model.actions),
		Rows:     settingsList(rows),
		Controls: settingsList(model.controls),
		Scroll:   float64(w.scroll.Y),
		Errors:   settingsErrors(s.errors),
		Results:  model.results,
		Missing:  settingsList(s.settings.MissingKeys()),
	}
	if w.page == "plugin" {
		status.Plugin = optional(w.chosen)
	}
	status.Editing = optional(w.editing)
	if w.undo != nil {
		status.Undo = &settingsUndoStatus{Key: w.undo.key, Label: w.undo.label, Old: w.undo.old, New: w.undo.new}
	}
	if w.confirm.kind != "" {
		status.Confirm = &settingsConfirmStatus{Kind: w.confirm.kind, ID: w.confirm.id}
	}
	return status, nil
}

// settingsErrors returns the error lines of the settings tab: the lines of the plugin pages and of the core update, which the tab
// shows through the error display (docs/spec/settings.md#status).
func settingsErrors(shown *ShownErrors) []settingsErrorStatus {
	lines := shown.Lines(func(where string) bool {
		return strings.HasPrefix(where, "plugin ") || strings.HasPrefix(where, "settings ")
	})
	list := make([]settingsErrorStatus, 0, len(lines))
	for _, line := range lines {
		list = append(list, settingsErrorStatus{Key: line.Where, Text: line.Text})
	}
	return list
}

// settingsList returns the list, or an empty list for a nil one, so the status reports a list and not null.
func settingsList[T any](list []T) []T {
	if list == nil {
		return []T{}
	}
	return list
}

func (s *Shell) requireSettings() error {
	if !s.settingsTab.open {
		return errors.New("settings are not open")
	}
	return nil
}

// settingsSave writes a change of the settings in the order of the writes.
func (s *Shell) settingsSave(project string, patch map[string]any, remove []string, restore func()) {
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
		if err != nil {
			// The host refused the write: the stored value comes back in the store and in the model, and the error is shown once.
			restore()
			s.settingsInputsChanged()
		}
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
	s.settingsTab.inputs++
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
	auto, ok := s.settings.Value("autoDismissProblemToasts").(bool)
	if !ok {
		return fmt.Errorf("settings: autoDismissProblemToasts is %s, not a switch", jsonText(s.settings.Value("autoDismissProblemToasts")))
	}
	seconds, ok := s.settings.Value("problemToastDismissSeconds").(float64)
	if !ok {
		return fmt.Errorf("settings: problemToastDismissSeconds is %s, not a number", jsonText(s.settings.Value("problemToastDismissSeconds")))
	}
	s.errors.ConfigureToastDeadline(auto, int64(seconds)*1000)
	s.syncPluginChoices()
	s.syncMissingPlugins()
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
	s.registry.Status("core.settings-tab", func() any {
		status, err := s.settingsStatus()
		if err != nil {
			s.fail(err)
			return nil
		}
		return status
	})
	s.registerSettingsValues()
	s.registerSettingsSets()
	s.registerSettingsTab()
	s.registerSettingsTabCommands()
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
		scope := inScope(value.Scope)
		old := s.settings.Scoped(value.Key, scope)
		wasOverridden := s.settings.Overridden(value.Key)
		err := s.changing("core.settings.change", func() error { return s.settings.Change(value.Key, input, value.Scope) })
		if err == nil {
			s.recordChange(value.Key, scope, old, input, wasOverridden)
		}
		return invalidSetting(err)
	})
	act(s, "core.settings.theme", func(value settingsParam) error {
		scope := inScope(value.Scope)
		oldName, _ := s.settings.Scoped("theme", scope).(string)
		oldMode, _ := s.settings.Scoped("mode", scope).(string)
		err := s.changing("core.settings.theme", func() error { return s.settings.Theme(value.Name, value.Mode, value.Scope) })
		if err == nil {
			newName, _ := s.settings.Scoped("theme", scope).(string)
			s.recordTheme(scope, oldName, oldMode, newName)
		}
		return err
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
		if s.settingsTab.open {
			s.settingsTab.editing = id
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
	Page   string `json:"page,omitempty"`
	Group  string `json:"group,omitempty"`
	Answer string `json:"answer,omitempty"`
	// HideInstalled is the switch of Browse, and More asks for the next rows of Browse.
	HideInstalled *bool   `json:"hideInstalled,omitempty"`
	More          bool    `json:"more,omitempty"`
	Filter        string  `json:"filter,omitempty"`
	Scope         string  `json:"scope,omitempty"`
	Plugin        *string `json:"plugin,omitempty"`
	Query         *string `json:"query,omitempty"`
	Set           *string `json:"set,omitempty"`
	Name          *string `json:"name,omitempty"`
	Kind          *string `json:"kind,omitempty"`
	ID            *string `json:"id,omitempty"`
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

func (s *Shell) registerSettingsTab() {
	w := &s.settingsTab
	act(s, "core.settings.open", func(struct{}) error {
		if err := s.dialogRefusal(); err != nil {
			return err
		}
		s.closeDebug()
		s.closePicker()
		w.open, w.openedOnce = true, true
		s.options.Invalidate()
		return nil
	})
	act(s, "core.settings.close", func(struct{}) error { s.closeSettings(); return nil })
	// The page is shown from the notice center too, where the tab may be closed, so the command does not require the open tab; it opens
	// the tab as core.settings.open does.
	act(s, "core.settings-tab.nav", func(value windowParam) error {
		if !slices.ContainsFunc(settingsPages[:len(settingsPages)-1], func(page [2]string) bool { return page[0] == value.Page }) {
			return fmt.Errorf("unknown settings page %s", value.Page)
		}
		w.page = value.Page
		w.chosen = ""
		w.scroll = ui.ScrollState{}
		// The page comes to the front, as core.settings.open brings the tab forward (docs/spec/settings.md#opening-and-closing).
		w.open, w.openedOnce = true, true
		w.revealGroup = ""
		if value.Group != "" {
			// The group is named by its id in the rows declaration; the page scrolls it into view when it draws it.
			group, ok := s.settings.Catalog.Rows.groupByID(value.Page, value.Group)
			if !ok {
				return Refuse(InvalidParams, "unknown group %q of page %q", value.Group, value.Page)
			}
			w.revealGroup = group.Name
		}
		if value.Page == "installed" {
			// The installed page reads the plugin state and the application update of the host when it is shown, as the plugin page did
			// before the library was removed (docs/spec/settings.md#plugins).
			s.pluginOperations.Refresh(func() {})
			s.appUpdates.Refresh(func() {})
		}
		s.options.Invalidate()
		return nil
	})
	windowAct(s, "core.settings-tab.scope", func(value windowParam) error {
		if value.Scope != "common" && !(value.Scope == "project" && s.settings.Project() != "") {
			return fmt.Errorf("scope %s is not available", value.Scope)
		}
		w.scope = value.Scope
		return nil
	})
	windowAct(s, "core.settings-tab.plugin", func(value windowParam) error {
		if value.Plugin == nil {
			// A plugin page without a plugin is not drawn, so the null plugin leaves the plugin page for its back page.
			if w.page == "plugin" {
				w.page = w.back
			}
			w.chosen = ""
			return nil
		}
		// A plugin page opens for each plugin of the plugin state, loaded or not (docs/spec/settings.md#plugin-page).
		if !slices.ContainsFunc(s.pluginRowsOf(s.pluginOperations.Status()), func(row PluginRow) bool { return row.ID == *value.Plugin }) {
			return fmt.Errorf("unknown plugin %s", *value.Plugin)
		}
		w.chosen = *value.Plugin
		// The back link returns to the page that opened the plugin page: Browse when it was shown, else Installed.
		w.back = "installed"
		if w.page == "browse" {
			w.back = "browse"
		}
		w.page = "plugin"
		return nil
	})
	windowAct(s, "core.settings-tab.back", func(value windowParam) error {
		w.page, w.chosen = w.back, ""
		return nil
	})
	windowAct(s, "core.settings-tab.find", func(value windowParam) error {
		if value.Query == nil {
			return errors.New("query must be a string")
		}
		w.find = strings.TrimSpace(*value.Query)
		return nil
	})
	windowAct(s, "core.settings-tab.filter", func(value windowParam) error {
		if !slices.Contains([]string{"all", "active", "disabled", "updates", "problems"}, value.Filter) {
			return fmt.Errorf("unknown filter %s", value.Filter)
		}
		w.filter = value.Filter
		return nil
	})
	windowAct(s, "core.settings-tab.edit", func(value windowParam) error {
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
	windowAct(s, "core.settings-tab.account-name", func(value windowParam) error {
		if err := s.accountPage(); err != nil {
			return err
		}
		if value.Name == nil {
			return errors.New("name must be a string")
		}
		w.accountName = *value.Name
		return nil
	})
	windowAct(s, "core.settings-tab.account-kind", func(value windowParam) error {
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
	windowAct(s, "core.settings-tab.account-edit", func(value windowParam) error {
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
	windowAct(s, "core.settings-tab.account-edit-name", func(value windowParam) error {
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
}

// accountPage refuses a field command of the group Accounts while no page of a plugin with accounts shows.
func (s *Shell) accountPage() error {
	w := &s.settingsTab
	if w.page != "plugin" || w.chosen == "" || !s.accounts.Declares(w.chosen) {
		return errors.New("no page of a plugin with accounts shows")
	}
	return nil
}

// accountFinished clears the name of the row of core.settings-tab.account-add after a finished add and ends the edit after a finished rename, on the page of
// the plugin (docs/spec/plugins.md#accounts).
func (s *Shell) accountFinished(command, plugin string) {
	w := &s.settingsTab
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
	s.settingsTab.open = false
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
