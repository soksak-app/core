package workbench

import (
	"fmt"
	"slices"
	"strings"
)

// declaredRows is the rows section of the workbench declaration: the pages in menu order, the labels of the choices and the groups of
// each page with their rows (docs/spec/settings.md#search). The web host reads the same section (settings-rows.js).
type declaredRows struct {
	Pages []struct {
		ID          string `json:"id"`
		Name        string `json:"name"`
		Description string `json:"description"`
		// Icon is the declared design icon of the item of the page in the menu (docs/spec/settings.md#menu).
		Icon string `json:"icon"`
	} `json:"pages"`
	Accounts struct {
		Description string `json:"description"`
	} `json:"accounts"`
	Labels map[string]map[string]string `json:"labels"`
	Groups map[string][]declaredGroup   `json:"groups"`
}

// declaredGroup is a group of a page with its rows.
type declaredGroup struct {
	ID          string        `json:"id"`
	Name        string        `json:"name"`
	Description string        `json:"description"`
	Rows        []declaredRow `json:"rows"`
}

// declaredRow is a row of a group: its setting key, label, form, and optional description, unit and dependency.
type declaredRow struct {
	Key         string `json:"key"`
	Label       string `json:"label"`
	Form        string `json:"form"`
	Description string `json:"description"`
	Unit        string `json:"unit"`
	Depends     string `json:"depends"`
}

// group returns the declared group of the page with the name, or an error when the declaration has none.
func (r declaredRows) groupByID(page, id string) (declaredGroup, bool) {
	for _, group := range r.Groups[page] {
		if group.ID == id {
			return group, true
		}
	}
	return declaredGroup{}, false
}

// rowMatch is a row that a search matched, with the page and the group that draw it.
type rowMatch struct {
	page, group string
	row         declaredRow
}

// match returns the rows that the query matches, in the order of the pages, the groups and the rows. A row matches when the lower-case
// query is a substring of its label, its description, its group name or its key (docs/spec/settings.md#search). The web host matches
// the same rows with the same rule (matchingRowKeys of settings-rows.js).
func (r declaredRows) match(query string) []rowMatch {
	needle := strings.ToLower(query)
	contains := func(text string) bool { return strings.Contains(strings.ToLower(text), needle) }
	var matches []rowMatch
	for _, page := range r.Pages {
		for _, group := range r.Groups[page.ID] {
			for _, row := range group.Rows {
				if contains(row.Label) || contains(row.Description) || contains(group.Name) || contains(row.Key) {
					matches = append(matches, rowMatch{page: page.ID, group: group.Name, row: row})
				}
			}
		}
	}
	return matches
}

// pageName returns the name of the page with the id, which the declaration names.
func (r declaredRows) pageName(id string) string {
	for _, page := range r.Pages {
		if page.ID == id {
			return page.Name
		}
	}
	return id
}

// buildSearch draws the results of the query in place of a page (docs/spec/settings.md#search): the heading, the count of the settings and
// of the installed plugins, then one group for each page with its matched rows, the plugin settings with their controls, the installed
// plugins, and the card of the catalog plugins. Each drawn setting row is in the declared rows, so the status lists it.
func (s *Shell) buildSearch(b *settingsBuilder, query string, match settingsMatch) error {
	rows := s.settings.Catalog.Rows
	keys := match.keys()
	caption := fmt.Sprintf("%d개 설정", len(keys))
	if len(match.installed) > 0 {
		caption += fmt.Sprintf(" · 플러그인 %d개", len(match.installed))
	}
	// The body draws the rows of the groups only, so each caption of the head is a row of the first group.
	head := []*SettingsControl{
		b.add(SettingsControl{Label: fmt.Sprintf("“%s” 찾기", query), kind: controlCaption}),
		b.add(SettingsControl{Label: caption, kind: controlCaption}),
	}
	if len(keys) == 0 && len(match.installed) == 0 && len(match.catalog) == 0 {
		head = append(head, b.add(SettingsControl{Label: "일치하는 설정이 없다.", kind: controlCaption}))
	}
	b.group("", "", settingsRow{controls: head})
	if len(keys) == 0 && len(match.installed) == 0 && len(match.catalog) == 0 {
		return nil
	}
	if err := s.drawCoreMatches(b, rows, match.rows); err != nil {
		return err
	}
	for _, definition := range match.pluginSettings {
		control, err := s.declaredControl(b, definition)
		if err != nil {
			return err
		}
		row := s.row(b, definition.Label, control)
		if id, missing := s.settings.Missing(definition.Key); missing {
			row.controls = append([]*SettingsControl{pluginBadge(b, id+" 필요", "warn")}, row.controls...)
		}
		row.key, row.description = definition.Key, definition.Description
		b.model.declaredRows = append(b.model.declaredRows, row)
		b.group("플러그인 › "+s.pluginName(definition.Plugin), "", row)
	}
	if len(match.installed) > 0 {
		status := s.pluginOperations.Status()
		busy := status.Operation != nil && status.Operation.State == "running"
		entries, err := s.installedEntries(s.pluginRowsOf(status))
		if err != nil {
			return err
		}
		var installed []settingsRow
		for _, entry := range entries {
			if slices.Contains(match.installed, entry.row.ID) {
				installed = append(installed, s.installedRows(b, entry, status, busy)...)
			}
		}
		b.group("설치된 플러그인", "", installed...)
	}
	if len(match.catalog) > 0 {
		names := strings.Join(match.catalog[:min(len(match.catalog), 4)], ", ")
		if len(match.catalog) > 4 {
			names += " …"
		}
		card := settingsRow{controls: []*SettingsControl{
			b.add(SettingsControl{Label: fmt.Sprintf("찾아보기에 %d개 더 있다", len(match.catalog)), kind: controlCaption}),
			b.add(SettingsControl{Label: names, kind: controlCaption}),
			b.small("browse-find", "core.settings-tab.browse-find", "찾아보기에서 보기", "core.settings-tab.browse", map[string]any{"query": query}),
		}}
		b.group("", "", card)
	}
	return nil
}

// drawCoreMatches draws the matched core rows with their page controls. Each page is built as the settings tab builds it, and the rows
// that hold a matched key are taken from it in the order of the match (docs/spec/settings.md#search).
func (s *Shell) drawCoreMatches(b *settingsBuilder, rows declaredRows, matches []rowMatch) error {
	var pages []string
	for _, match := range matches {
		if !slices.Contains(pages, match.page) {
			pages = append(pages, match.page)
		}
	}
	builders := s.pageBuilders()
	for _, page := range pages {
		scratch := &settingsBuilder{model: &settingsModel{labels: map[string]string{}}, counts: map[string]int{}}
		if err := builders[page](scratch); err != nil {
			return err
		}
		// A row is identified by its group and its place in the group, so a row that holds two matched keys is drawn once.
		type placed struct {
			id    string
			group string
			row   settingsRow
		}
		byKey := map[string][]placed{}
		for _, group := range scratch.model.groups {
			for index, row := range group.rows {
				seen := map[string]bool{}
				for _, key := range rowKeys(row) {
					if !seen[key] {
						seen[key] = true
						byKey[key] = append(byKey[key], placed{id: fmt.Sprintf("%s#%d", group.name, index), group: group.name, row: row})
					}
				}
			}
		}
		drawn := map[string]bool{}
		for _, match := range matches {
			if match.page != page {
				continue
			}
			found, ok := byKey[match.row.Key]
			if !ok {
				return fmt.Errorf("the search matches %s, which the page %s does not draw", match.row.Key, page)
			}
			// The rows of one group are drawn in one group, in the order of the page.
			var groupOrder []string
			rowsByGroup := map[string][]settingsRow{}
			for _, item := range found {
				if drawn[item.id] {
					continue
				}
				drawn[item.id] = true
				if _, ok := rowsByGroup[item.group]; !ok {
					groupOrder = append(groupOrder, item.group)
				}
				rowsByGroup[item.group] = append(rowsByGroup[item.group], item.row)
			}
			for _, name := range groupOrder {
				b.group(rows.pageName(page)+" · "+name, "", rowsByGroup[name]...)
			}
			b.model.declaredRows = append(b.model.declaredRows, settingsRow{key: match.row.Key, controls: found[0].row.controls})
		}
	}
	return nil
}

// rowKeys returns the setting keys of a row: its own key and the keys of its controls.
func rowKeys(row settingsRow) []string {
	var keys []string
	if row.key != "" {
		keys = append(keys, row.key)
	}
	for _, control := range row.controls {
		if control.Key != nil {
			keys = append(keys, *control.Key)
		}
	}
	return keys
}

// pluginName returns the name of a loaded plugin, or its id when it is not loaded.
func (s *Shell) pluginName(id string) string {
	for _, plugin := range s.plugins {
		if plugin.ID == id {
			return plugin.Name
		}
	}
	return id
}

// settingsMatch is the match of a query over the core rows, the plugin settings, the installed plugins and the catalog plugins
// (docs/spec/settings.md#search). The web host matches the same inputs with the same rule (matchSettings of settings-match.js).
type settingsMatch struct {
	rows           []rowMatch
	pluginSettings []SettingDefinition
	installed      []string
	catalog        []string
}

// keys returns the keys of the matched settings: the core rows in the order of the table, then the plugin settings.
func (m settingsMatch) keys() []string {
	keys := []string{}
	for _, match := range m.rows {
		keys = append(keys, match.row.Key)
	}
	for _, definition := range m.pluginSettings {
		keys = append(keys, definition.Key)
	}
	return keys
}

// matchSettings matches the query. A plugin setting matches by its label, its description or the name of its plugin; an installed or
// catalog plugin row matches by its name, its id or its description. The rows come from the plugin status of the production reader, so the
// installed plugins are the rows that are not available and the catalog plugins are the available ones.
func (s *Shell) matchSettings(store *SettingsStore, query string) settingsMatch {
	needle := strings.ToLower(query)
	contains := func(texts ...string) bool {
		for _, text := range texts {
			if strings.Contains(strings.ToLower(text), needle) {
				return true
			}
		}
		return false
	}
	match := settingsMatch{rows: store.Catalog.Rows.match(query), installed: []string{}}
	names := map[string]string{}
	for _, plugin := range s.plugins {
		names[plugin.ID] = plugin.Name
	}
	for _, definition := range store.Definitions {
		if contains(definition.Label, definition.Description, names[definition.Plugin]) {
			match.pluginSettings = append(match.pluginSettings, definition)
		}
	}
	for _, row := range s.pluginOperations.Status().Plugins {
		texts := []string{row.Name, row.ID, row.Description}
		// A row matches by the categories of its loaded plugin (docs/spec/settings.md#plugins); a row without a loaded plugin has none.
		if loaded := s.loadedPlugin(row.ID); loaded != nil {
			texts = append(texts, loaded.Categories...)
		}
		if !contains(texts...) {
			continue
		}
		if row.State == "available" {
			match.catalog = append(match.catalog, row.Name)
		} else {
			match.installed = append(match.installed, row.ID)
		}
	}
	return match
}
