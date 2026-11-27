package workbench

import (
	"fmt"
	"slices"
	"strings"
)

// The page 사이드바 세트 (docs/spec/settings.md#사이드바-세트): the set list with the section chips and the confirmation of a removal, and
// the editor of the edited set. Every change runs a declared command of the sets, and a removal runs core.settings-tab.confirm first.

// buildSets builds the set list and the editor of the edited set.
func (s *Shell) buildSets(b *settingsBuilder) error {
	w := &s.settingsTab
	scope := s.controlScope("sets")
	sets, err := s.settings.Sets(scope)
	if err != nil {
		return err
	}
	links, err := s.settings.Links(scope)
	if err != nil {
		return err
	}
	if !slices.ContainsFunc(sets, func(set StoredSet) bool { return set.ID == w.editing }) {
		w.editing = ""
	}
	rows := make([]settingsRow, 0, len(sets)+1)
	for _, set := range sets {
		rows = append(rows, s.setRow(b, set, links, scope))
		rows = append(rows, s.missingLineRows(b, set)...)
	}
	rows = append(rows, settingsRow{controls: []*SettingsControl{b.button("sets:create", "core.settings-tab.create", "새 세트", "core.settings.sets.create",
		map[string]any{"scope": scope})}})
	if controls := s.overrideControls(b, "sets", "전역 세트 사용"); controls != nil {
		rows = append(rows, settingsRow{controls: controls})
	}
	b.group("세트", "사이드바에 보여 줄 섹션 묶음. 어느 변에 놓을지는 작업 공간과 플러그인에서 고른다.", rows...)
	for _, set := range sets {
		if set.ID == w.editing {
			s.setEditor(b, set, scope)
		}
	}
	return nil
}

// setRow is the row of one set: its name, its layout, the sides and windows that use it, its section chips and its buttons.
func (s *Shell) setRow(b *settingsBuilder, set StoredSet, links []StoredLink, scope string) settingsRow {
	w := &s.settingsTab
	name := set.Title
	if name == "" {
		name = "(이름 없음)"
	}
	layout := "목록"
	if set.Layout == "tabs" {
		layout = "탭"
	}
	controls := []*SettingsControl{
		b.add(SettingsControl{Name: "core.settings-tab.set-title", Key: text("set-title:" + set.ID), Label: name, kind: controlCaption}),
		b.add(SettingsControl{Name: "core.settings-tab.badge", Key: text("badge:layout:" + set.ID), Label: layout, kind: controlMark}),
	}
	if users := s.setUsers(set.ID, links); len(users) > 0 {
		controls = append(controls, b.add(SettingsControl{Key: text("users:" + set.ID),
			Label: "· 쓰는 곳: " + strings.Join(users, ", "), kind: controlCaption}))
	}
	controls = append(controls, s.sectionChips(b, set, scope)...)
	if len(set.Sections) == 0 {
		controls = append(controls, b.add(SettingsControl{Key: text("empty:" + set.ID), Label: "섹션 없음", kind: controlCaption}))
	}
	if w.editing == set.ID {
		controls = append(controls, b.small("done:"+set.ID, "core.settings-tab.edit", "완료", "core.settings-tab.edit", map[string]any{"set": nil}))
	} else {
		controls = append(controls, b.small("edit:"+set.ID, "core.settings-tab.edit", "편집", "core.settings-tab.edit", map[string]any{"set": set.ID}))
	}
	controls = append(controls, b.small("delete:"+set.ID, "core.settings-tab.delete", "삭제", "core.settings-tab.confirm",
		map[string]any{"kind": "set", "id": set.ID, "answer": "ask"}))
	row := settingsRow{name: name, controls: controls}
	if w.confirm.kind == "set" && w.confirm.id == set.ID {
		row.description = confirmLine(s.setUsers(set.ID, links))
		row.controls = append(row.controls,
			b.small("confirm-no:"+set.ID, "core.settings-tab.confirm-no", "취소", "core.settings-tab.confirm", map[string]any{"kind": "set", "id": set.ID, "answer": "no"}),
			b.small("confirm-yes:"+set.ID, "core.settings-tab.confirm-yes", "삭제", "core.settings-tab.confirm", map[string]any{"kind": "set", "id": set.ID, "answer": "yes"}))
	}
	return row
}

// confirmLine is the line of the confirmation of a removal: the links that use the set become 사용 안 함.
func confirmLine(users []string) string {
	if len(users) > 0 {
		return "쓰는 곳은 “사용 안 함”이 된다."
	}
	return "삭제할까?"
}

// setUsers names the sides and the plugin windows that a link of the set places it on.
func (s *Shell) setUsers(set string, links []StoredLink) []string {
	var users []string
	for _, link := range links {
		if link.Set != set {
			continue
		}
		if link.pluginID() == "" {
			users = append(users, sideNames[link.Place])
			continue
		}
		users = append(users, s.pluginNameOf(link.pluginID())+" 창 "+link.Place)
	}
	return users
}

// pluginNameOf is the name of a loaded plugin, or its id when no plugin is loaded under it.
func (s *Shell) pluginNameOf(id string) string {
	if plugin := s.loadedPlugin(id); plugin != nil {
		return plugin.Name
	}
	return id
}

// sectionChips are the chips of the sections of a set, each with its removal control. A section of a plugin that is not loaded has a
// dashed chip with its name struck through and the tooltip `<name>(<id>) 플러그인 필요` (docs/spec/plugins.md#missing-plugins).
func (s *Shell) sectionChips(b *settingsBuilder, set StoredSet, scope string) []*SettingsControl {
	var controls []*SettingsControl
	for index, id := range set.Sections {
		chip := SettingsControl{Name: "core.settings-tab.chip", Key: text(fmt.Sprintf("chip:%s:%d", set.ID, index)), Label: s.sectionNames([]string{id})[0], kind: controlChip}
		if !s.sectionLoaded(id) {
			plugin, _, _ := strings.Cut(id, ".")
			line := s.missingPluginLine(plugin)
			chip.missingTip = fmt.Sprintf("%s(%s) 플러그인 필요", line.Name, plugin)
		}
		controls = append(controls, b.add(chip))
		controls = append(controls, b.button(fmt.Sprintf("remove:%s:%d", set.ID, index), "core.settings-tab.row-act", "×", "core.settings.sets.row",
			map[string]any{"id": set.ID, "action": "remove", "index": index, "scope": scope}))
	}
	return controls
}

// sectionLoaded tells whether a loaded plugin registers the section.
func (s *Shell) sectionLoaded(id string) bool {
	for _, plugin := range s.plugins {
		for _, section := range plugin.Sections {
			if section.ID == id {
				return true
			}
		}
	}
	return false
}

// setEditor is the group of the edited set: its name, its layout, its section chips and the select 섹션 추가….
func (s *Shell) setEditor(b *settingsBuilder, set StoredSet, scope string) {
	update := map[string]any{"id": set.ID, "scope": scope}
	title := b.add(SettingsControl{Name: "core.settings-tab.set-title", Key: text("title:" + set.ID), Value: text(set.Title), Command: settingCommand("core.settings.sets.update", update),
		kind: controlText, param: "title", maxLength: setTitleMax})
	layout := b.add(SettingsControl{Name: "core.settings-tab.choice", Key: text("layout:" + set.ID), Value: text(set.Layout), Options: []string{"list", "tabs"},
		Command: settingCommand("core.settings.sets.update", update), kind: choiceKind(2), param: "layout", labels: map[string]string{"list": "목록", "tabs": "탭"}})
	rows := []settingsRow{{name: "이름", controls: []*SettingsControl{title}}, {name: "배치", controls: []*SettingsControl{layout}}}
	if set.Title == "" {
		rows[0].description = "이름이 필요하다."
	}
	chips := settingsRow{name: "섹션", list: true}
	chips.controls = append(chips.controls, s.sectionChips(b, set, scope)...)
	if len(set.Sections) == 0 {
		chips.description = "아직 섹션이 없다."
	}
	rows = append(rows, chips)
	rows = append(rows, settingsRow{controls: []*SettingsControl{s.sectionAdder(b, set, scope)}})
	rows = append(rows, settingsRow{description: "바꾼 값은 바로 저장된다. 같은 섹션은 한 세트에 한 번만 들어간다.",
		controls: []*SettingsControl{b.small("done:"+set.ID, "core.settings-tab.edit", "완료", "core.settings-tab.edit", map[string]any{"set": nil})}})
	b.group("세트 편집: "+set.Title, "", rows...)
}

// sectionAdder is the select 섹션 추가…: its options are the registered sections that the set does not contain, each with its plugin.
func (s *Shell) sectionAdder(b *settingsBuilder, set StoredSet, scope string) *SettingsControl {
	labels := map[string]string{}
	var groups []OptionGroup
	var options []string
	for _, plugin := range s.plugins {
		group := OptionGroup{Label: plugin.Name}
		for _, section := range plugin.Sections {
			if slices.Contains(set.Sections, section.ID) {
				continue
			}
			group.Values = append(group.Values, section.ID)
			labels[section.ID] = section.Name
		}
		if len(group.Values) > 0 {
			groups = append(groups, group)
			options = append(options, group.Values...)
		}
	}
	return b.add(SettingsControl{Name: "core.settings-tab.add", Key: text("add:" + set.ID), Label: "섹션 추가…", Options: options, Groups: groups,
		Command: settingCommand("core.settings.sets.row", map[string]any{"id": set.ID, "action": "add", "scope": scope}), kind: controlSelect, param: "section", labels: labels})
}

// missingLineRows returns the set line of each plugin whose sections the set holds and cannot draw: the text of the line of the sidebar
// and its button, under the element core.sidebar.missing of the plugin (docs/spec/plugins.md#missing-plugins).
func (s *Shell) missingLineRows(b *settingsBuilder, set StoredSet) []settingsRow {
	var frame SidebarFrame
	for _, id := range set.Sections {
		if !s.sectionLoaded(id) {
			plugin, _, _ := strings.Cut(id, ".")
			frame.Missing = append(frame.Missing, MissingSection{ID: id, Plugin: plugin})
		}
	}
	var rows []settingsRow
	for _, line := range MissingLines(frame, s.missingPluginLine) {
		controls := []*SettingsControl{b.add(SettingsControl{Name: "core.sidebar.missing", Key: text(line.Plugin), Label: line.Text, kind: controlCaption})}
		if line.Action != nil {
			controls = append(controls, b.button(line.Plugin+":missing", "core.sidebar.missing", line.Action.Label, line.Action.Command, line.Action.Params))
		}
		rows = append(rows, settingsRow{controls: controls})
	}
	return rows
}
