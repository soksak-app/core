package workbench

import (
	"fmt"
	"slices"
	"strconv"

	"github.com/soksak-app/core/packages/workbench-mygo/src/layout"
)

// The sidebar list of 작업 공간 (docs/spec/settings.md#작업-공간): one row per side in the order of sidebarOrder. Each row shows its
// number, its name, the badge of a project override and the caption of the shortcuts below the list, and its controls are the set
// select, the on/off switch and the order buttons, as packages/workbench/settings-sides.js draws them.

// sideShortcuts is the caption below the list. Its order is fixed, whatever the placement order of the sides is.
const sideShortcuts = "⌘B 왼쪽 · ⌥⌘B 오른쪽 · ⇧⌘J 위 · ⌘J 아래"

// sideList says which setting list a sidebar list edits: the workspace list (sidebarOrder, with the switches of the sides) or the list of a
// plugin (<plugin>.win.order or <plugin>.card.order, without switches), whose links take the place prefix window- or card-.
type sideList struct {
	order    string
	prefix   string
	plugin   string
	switches bool
}

// sideRows builds the four rows of a sidebar list, the caption of the workspace list, and the reset buttons of the project overrides.
// Each row shows its number, its name, the badge of a project override, the set select, the switch of the workspace list, and the order
// buttons (docs/spec/settings.md#작업-공간, docs/spec/settings.md#plugin-page).
func (s *Shell) sideRows(b *settingsBuilder, list sideList, sets []StoredSet, links []StoredLink) ([]settingsRow, error) {
	scope := s.controlScope(list.order)
	order, _ := s.value(list.order).([]any) // silent: the settings store checks that the value is an order of the sides.
	inProject := s.settingsWindow.scope == "project" && s.settings.Project() != ""
	var projectLinks, commonLinks []StoredLink
	if inProject && s.settings.Overridden("links") {
		var err error
		if projectLinks, err = s.settings.Links("project"); err != nil {
			return nil, err
		}
		if commonLinks, err = s.settings.Links("common"); err != nil {
			return nil, err
		}
	}
	rows := make([]settingsRow, 0, len(order)+2)
	for index, item := range order {
		side, _ := item.(string) // silent: the settings store checks that the value is an order of the sides.
		place := list.prefix + side
		name := sideNames[side]
		row := settingsRow{side: true, number: strconv.Itoa(index + 1), name: name}
		on := true
		if list.switches {
			on, _ = s.value(side).(bool) // silent: the settings store checks the type of the value.
		}
		linkOverridden := inProject && s.settings.Overridden("links") && linked(projectLinks, place, list.plugin) != linked(commonLinks, place, list.plugin)
		orderOverridden := inProject && s.settings.Overridden(list.order)
		if inProject && (linkOverridden || orderOverridden || (list.switches && s.settings.Overridden(side))) {
			row.controls = append(row.controls, b.add(SettingsControl{Name: "core.settings-tab.override", Key: text("override:" + side),
				Label: s.opened().Title + " 값", kind: controlBadge, tone: "acc"}))
		}
		if !inProject && list.switches {
			row.controls = append(row.controls, s.overrideControls(b, side, "")...)
		}
		link, err := s.choose(b, "link:"+place+":"+list.plugin, s.setOptions(sets), linked(links, place, list.plugin))
		if err != nil {
			return nil, err
		}
		// A side that is off keeps its stored link and shows the select disabled (docs/spec/settings.md#작업-공간).
		link.Name, link.kind, link.Disabled = "core.settings-tab.link", controlSelect, list.switches && !on
		row.controls = append(row.controls, link)
		if list.switches {
			label := name + " 사이드바 보이기"
			b.model.labels[side] = label
			sw := s.toggle(b, side)
			sw.Name, sw.Label = "core.settings-tab.side", label
			row.controls = append(row.controls, sw)
		}
		up := b.button(fmt.Sprintf("order:%s:%d:up", list.order, index), "core.settings-tab.order", "↑", "core.settings.change",
			map[string]any{"key": list.order, "value": swapped(order, index, index-1), "scope": scope})
		up.title = "위로"
		up.Disabled = index == 0
		down := b.button(fmt.Sprintf("order:%s:%d:down", list.order, index), "core.settings-tab.order", "↓", "core.settings.change",
			map[string]any{"key": list.order, "value": swapped(order, index, index+1), "scope": scope})
		down.title = "아래로"
		down.Disabled = index == len(order)-1
		row.controls = append(row.controls, up, down)
		rows = append(rows, row)
	}
	if list.switches {
		rows = append(rows, settingsRow{description: sideShortcuts})
	}
	if inProject {
		var marks []*SettingsControl
		keys := []string{"links", list.order}
		if list.switches {
			keys = append(slices.Clone(layout.WindowSides), keys...)
		}
		for _, key := range keys {
			if s.settings.Overridden(key) {
				marks = append(marks, b.button("reset:"+key, "core.settings-tab.reset", s.opened().Title+" 값 지우기", "core.settings.reset",
					map[string]any{"key": key, "scope": "project"}))
			}
		}
		if len(marks) > 0 {
			rows = append(rows, settingsRow{controls: marks})
		}
	}
	// The rows are the parts of one list keyed by its order, as sideList of settings-sides.js keys it, so the search finds the list.
	for i := range rows {
		rows[i].key = list.order
	}
	return rows, nil
}

// swapped is the order with the entries at a and b exchanged, which the order buttons write. The button of the first row (up) and of
// the last row (down) is disabled and never runs, so its value is the order unchanged, which keeps the index in range.
func swapped(list []any, a, b int) []any {
	next := slices.Clone(list)
	if a >= 0 && b >= 0 && a < len(next) && b < len(next) {
		next[a], next[b] = next[b], next[a]
	}
	return next
}
