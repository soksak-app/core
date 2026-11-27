package workbench

import (
	"fmt"
	"slices"
	"sort"
	"strings"
)

// The plugin pages of the settings tab: Installed, Browse and the page of one plugin (docs/spec/settings.md#plugins). Their rows come
// from the plugin state of the host (`core.plugins`), and every action runs a declared plugin command.

// pluginEntry is a row of Installed with the facts that its badges, its sort and its filter read.
type pluginEntry struct {
	row     PluginRow
	problem bool
	update  bool
	// missing lists the dependencies of the loaded plugin that no installed plugin provides, sorted by id.
	missing []string
}

// missingDependencies returns the dependencies of a loaded plugin that are not installed, sorted by id. The dependencies come from the
// loaded manifest; a dependency that the state does not list is not reported (docs/spec/settings.md#plugins).
func (s *Shell) missingDependencies(id string, rows []PluginRow) []string {
	loaded := s.loadedPlugin(id)
	if loaded == nil {
		return nil
	}
	var missing []string
	for dependency := range loaded.Dependencies {
		for _, row := range rows {
			if row.ID == dependency && row.Installed == nil {
				missing = append(missing, dependency)
			}
		}
	}
	sort.Strings(missing)
	return missing
}

// installedEntries returns the rows of Installed sorted as the page shows them: a problem first, then an update, then the rest, each group
// by name (docs/spec/settings.md#plugins).
func (s *Shell) installedEntries(rows []PluginRow) ([]pluginEntry, error) {
	var entries []pluginEntry
	for _, row := range rows {
		if row.State == "available" {
			continue
		}
		update, err := hasUpdate(row)
		if err != nil {
			return nil, err
		}
		missing := s.missingDependencies(row.ID, rows)
		problem := row.State == "requires" || row.State == "refused" || len(missing) > 0
		entries = append(entries, pluginEntry{row: row, problem: problem, update: update, missing: missing})
	}
	rank := func(entry pluginEntry) int {
		switch {
		case entry.problem:
			return 0
		case entry.update:
			return 1
		}
		return 2
	}
	slices.SortStableFunc(entries, func(a, b pluginEntry) int {
		if d := rank(a) - rank(b); d != 0 {
			return d
		}
		return strings.Compare(a.row.Name, b.row.Name)
	})
	return entries, nil
}

// installedMatches reports whether a row passes the filter of Installed (docs/spec/settings.md#plugins).
func installedMatches(entry pluginEntry, filter string) bool {
	switch filter {
	case "active":
		return entry.row.State == "loaded"
	case "disabled":
		return entry.row.Installed != nil && !entry.row.Installed.Enabled
	case "updates":
		return entry.update
	case "problems":
		return entry.problem
	}
	return true
}

// installedQueryMatches reports whether a row matches the search text of Installed: its name, its id or its description.
func installedQueryMatches(entry pluginEntry, query string) bool {
	query = strings.ToLower(strings.TrimSpace(query))
	if query == "" {
		return true
	}
	for _, text := range []string{entry.row.Name, entry.row.ID, entry.row.Description} {
		if strings.Contains(strings.ToLower(text), query) {
			return true
		}
	}
	return false
}

// pluginBadge is a badge of a row of Installed with its tone (docs/spec/settings.md#plugins).
func pluginBadge(b *settingsBuilder, label, tone string) *SettingsControl {
	return b.add(SettingsControl{Name: "core.settings-tab.badge", Key: text(label), Label: label, tone: tone, kind: controlBadge})
}

// pluginAction is an action button of a plugin row or page, which is disabled while an operation runs. Its key is the plugin and the
// action name, and the status lists it in actions (docs/spec/settings.md#status).
func (s *Shell) pluginAction(b *settingsBuilder, busy bool, plugin, action, label, command string, params map[string]any) *SettingsControl {
	control := b.small(plugin+":"+action, "core.settings-tab.plugins.action", label, command, params)
	control.Disabled = busy
	b.model.actions = append(b.model.actions, settingsActionStatus{Plugin: plugin, Action: action, Disabled: busy})
	return control
}

// pluginSwitch is the switch core.settings-tab.plugins.switch of a plugin: on runs core.plugins.disable and off runs core.plugins.enable.
func pluginSwitch(b *settingsBuilder, row PluginRow, busy bool) *SettingsControl {
	on := row.Installed.Enabled
	command := "core.plugins.enable"
	if on {
		command = "core.plugins.disable"
	}
	return b.add(SettingsControl{Name: "core.settings-tab.plugins.switch", Key: text("plugin:" + row.ID), Label: row.Name + " 사용", On: &on,
		Command: settingCommand(command, map[string]any{"plugin": row.ID}), Disabled: busy, kind: controlSwitch, param: "on"})
}

// pluginMeta is the meta line of a row: the category of the plugin when it declares one, its id, and the installed version or the latest
// version of an uninstalled plugin, joined with ` · ` and with the parts that have no value left out (docs/spec/settings.md#plugins).
// The category comes from the loaded manifest, and an uninstalled plugin has none.
func pluginMeta(row PluginRow, category string) string {
	version := ""
	switch {
	case row.Installed != nil:
		version = row.Installed.Version
	case row.Latest != nil:
		version = *row.Latest
	}
	var parts []string
	for _, part := range []string{category, row.ID} {
		if part != "" {
			parts = append(parts, part)
		}
	}
	if version != "" {
		parts = append(parts, "v"+version)
	}
	return strings.Join(parts, " · ")
}

// installedRows builds the rows of one installed plugin in Installed and the line of its last operation, when it has one.
func (s *Shell) installedRows(b *settingsBuilder, entry pluginEntry, status PluginsStatus, busy bool) []settingsRow {
	row := entry.row
	var category string
	if loaded := s.loadedPlugin(row.ID); loaded != nil && len(loaded.Categories) > 0 {
		category = loaded.Categories[0]
	}
	content := settingsRow{name: row.Name, description: pluginMeta(row, category), plugin: row.ID}
	if entry.problem {
		content.controls = append(content.controls, pluginBadge(b, "필요한 플러그인 없음", "warn"))
	}
	if row.Installed != nil && !row.Installed.Enabled {
		content.controls = append(content.controls, pluginBadge(b, "꺼짐", "neutral"))
	}
	if entry.update {
		content.controls = append(content.controls, pluginBadge(b, "업데이트 "+*row.Latest, "acc"))
	}
	for _, dependency := range entry.missing {
		content.controls = append(content.controls, pluginBadge(b, dependency+" 필요", "warn"))
	}
	if row.State == "reload" {
		content.controls = append(content.controls, pluginBadge(b, "창을 다시 불러오면 적용", "warn"))
	}
	if row.State == "refused" {
		content.controls = append(content.controls, pluginBadge(b, "불러오지 못함", "warn"))
	}
	for _, dependency := range entry.missing {
		content.controls = append(content.controls, s.pluginAction(b, busy, row.ID, "install-dependency", dependency+" 설치", "core.plugins.install", map[string]any{"plugin": dependency}))
	}
	if entry.update {
		content.controls = append(content.controls, s.pluginAction(b, busy, row.ID, "update", "업데이트", "core.plugins.update", map[string]any{"plugin": row.ID}))
	}
	if row.Installed != nil {
		content.controls = append(content.controls, pluginSwitch(b, row, busy))
	}
	info := b.button("plugin:"+row.ID, "core.settings-tab.plugin", row.Name+" 정보와 설정", "core.settings-tab.plugin", map[string]any{"plugin": row.ID})
	content.controls = append(content.controls, info)
	rows := []settingsRow{content}
	if line := s.pluginOperationLine(row.ID, status.Operation); line != "" {
		rows = append(rows, settingsRow{description: line})
	}
	return rows
}

// buildInstalled builds Installed: the search, the filter with its counts, the update of all, the rows and the card that opens Browse
// (docs/spec/settings.md#plugins).
func (s *Shell) buildInstalled(b *settingsBuilder) error {
	w := &s.settingsTab
	status := s.pluginOperations.Status()
	busy := status.Operation != nil && status.Operation.State == "running"
	entries, err := s.installedEntries(s.pluginRowsOf(status))
	if err != nil {
		return err
	}
	counts := map[string]int{}
	for _, entry := range entries {
		for _, name := range []string{"all", "active", "disabled", "updates", "problems"} {
			if installedMatches(entry, name) {
				counts[name]++
			}
		}
	}
	rows, err := s.installedTopRows(b, entries, busy)
	if err != nil {
		return err
	}
	search := b.add(SettingsControl{Name: "core.settings-tab.search", Key: text("plugin-search"), Value: text(w.query), Command: settingCommand("core.settings-tab.search", nil),
		kind: controlText, param: "query", searchable: true, Label: "설치된 플러그인 찾기"})
	var chips []*SettingsControl
	for _, item := range [][2]string{{"all", "전체"}, {"active", "사용 중"}, {"disabled", "꺼짐"}, {"updates", "업데이트"}, {"problems", "문제"}} {
		chips = append(chips, b.pressedButton("filter:"+item[0], "core.settings-tab.filter", fmt.Sprintf("%s %d", item[1], counts[item[0]]),
			"core.settings-tab.filter", map[string]any{"filter": item[0]}, w.filter == item[0]))
	}
	rows = append(rows, settingsRow{name: "", controls: []*SettingsControl{search}}, settingsRow{name: "거르기", controls: chips})
	shown := 0
	for _, entry := range entries {
		if !installedMatches(entry, w.filter) || !installedQueryMatches(entry, w.query) {
			continue
		}
		shown++
		row := entry.row
		b.model.listed = append(b.model.listed, row.ID)
		rows = append(rows, s.installedRows(b, entry, status, busy)...)
	}
	if shown == 0 {
		rows = append(rows, settingsRow{description: "맞는 플러그인이 없다."})
	}
	catalogRows := s.pluginRowsOf(status)
	catalog := len(catalogRows)
	missing := 0
	for _, row := range catalogRows {
		if row.Installed == nil && row.State == "available" {
			missing++
		}
	}
	browse := settingsRow{description: fmt.Sprintf("카탈로그 %d개 중 %d개를 더 설치할 수 있다. 설치 전에 필요한 플러그인을 확인한다.", catalog, missing),
		controls: []*SettingsControl{b.pressedButton("nav:browse", "core.settings-tab.nav", "찾아보기", "core.settings-tab.nav", map[string]any{"page": "browse"}, false)}}
	rows = append(rows, browse)
	b.group("설치된 플러그인", "켜고 끄기, 업데이트, 문제 고치기. 하나를 누르면 그 플러그인의 정보와 설정이 한 페이지에 있다. 새로 찾는 일은 ‘찾아보기’ 화면에서 한다.", rows...)
	return nil
}

// pluginOperationLine is the line that the operation of a plugin shows under its row: its running action. A failed operation shows its
// error through the error display under the name plugin <id>, and the error leaves when the operation of the plugin ends without a
// failure (docs/spec/settings.md#plugins).
func (s *Shell) pluginOperationLine(id string, operation *PluginOperation) string {
	if operation == nil || operation.Plugin != id {
		return ""
	}
	switch operation.State {
	case "running":
		return id + " " + operation.Action + " 진행 중"
	case "failed":
		s.errors.Show("plugin "+id, operation.Error, "")
	default:
		s.errors.Hide("plugin " + id)
	}
	return ""
}

// installedTopRows builds the lines above the tool row of Installed, in document order: the core update row with its notices and its
// operation, the update list with Update all, the outdated sidecars and the held operations (docs/spec/settings.md#plugins).
func (s *Shell) installedTopRows(b *settingsBuilder, entries []pluginEntry, busy bool) ([]settingsRow, error) {
	var rows []settingsRow
	app := s.appUpdates.Status()
	if app.Available != nil {
		line := fmt.Sprintf("core: %s → %s", app.Version, app.Available.Version)
		row := settingsRow{controls: []*SettingsControl{b.add(SettingsControl{Name: "core.settings-tab.plugins.app", Key: text("core"), Label: line, kind: controlCaption})}}
		// Each installed plugin that the available release does not fit has its notice in the core row, before the buttons.
		for _, item := range app.Incompatible {
			version := "버전 없음"
			if item.Compatible != nil {
				version = "최신 버전 " + *item.Compatible
			}
			notice := fmt.Sprintf("%s %s (%s): %s에 맞는 %s", item.ID, item.Installed, item.Range, app.Available.Version, version)
			row.controls = append(row.controls, b.add(SettingsControl{Name: "core.settings-tab.plugins.incompatible", Key: text(item.ID), Label: notice, kind: controlCaption}))
		}
		if app.Available.Release != "" {
			row.controls = append(row.controls, b.button("core:release", "core.settings-tab.plugins.app-release", "릴리스 페이지", "core.app.release", map[string]any{}))
		}
		row.controls = append(row.controls, b.button("core:update", "core.settings-tab.plugins.app-update", "업데이트", "core.app.update", map[string]any{}))
		rows = append(rows, row)
	}
	if app.Operation != nil {
		if app.Operation.State == "failed" {
			s.errors.Show("settings core app", app.Operation.Version+" 업데이트하지 못했습니다: "+app.Operation.Error, "")
		} else {
			step := "적용하는 중"
			if app.Operation.State == "staging" {
				step = "받는 중"
			}
			rows = append(rows, settingsRow{controls: []*SettingsControl{b.add(SettingsControl{Name: "core.settings-tab.plugins.app", Key: text("core:operation"),
				Label: app.Operation.Version + " " + step, kind: controlCaption})}})
		}
	}
	updates := 0
	for _, entry := range entries {
		if entry.update {
			updates++
		}
	}
	if updates > 0 {
		all := b.small("update-all", "core.settings-tab.plugins.update-all", fmt.Sprintf("모두 업데이트 (%d)", updates), "core.plugins.update-all", map[string]any{})
		all.Disabled = busy
		rows = append(rows, settingsRow{controls: []*SettingsControl{all}})
	}
	for _, item := range s.pluginOperations.Status().Outdated {
		running, declared, verb := "이전 버전", "선언 없음", "종료"
		if item.Running != nil {
			running = *item.Running
		}
		if item.Installed != nil {
			declared, verb = *item.Installed, "적용"
		}
		line := fmt.Sprintf("%s: %s → %s", item.Sidecar, running, declared)
		replace := b.add(SettingsControl{Name: "core.settings-tab.plugins.replace", Key: text(item.Sidecar), Label: fmt.Sprintf("세션 %d개를 끝내고 %s", item.Sessions, verb),
			Command: settingCommand("core.plugins.replace", map[string]any{"sidecar": item.Sidecar}), Disabled: busy, kind: controlButton})
		rows = append(rows, settingsRow{controls: []*SettingsControl{b.add(SettingsControl{Name: "core.settings-tab.plugins.outdated", Key: text(item.Sidecar), Label: line, kind: controlCaption}), replace}})
	}
	held, err := s.heldRows(b, busy)
	if err != nil {
		return nil, err
	}
	return append(rows, held...), nil
}

// heldVerbs are the label verb and the command of the action that ends the sessions of a held operation, by the held action.
var heldVerbs = map[string][2]string{"update": {"업데이트", "core.plugins.update"}, "install": {"설치", "core.plugins.install"}, "enable": {"사용", "core.plugins.enable"}}

// heldRows builds the error line and the action of each held operation: the error goes through the error display, and the action ends
// the sessions with end true. The action is absent while a sessions count is not known (docs/spec/settings.md#plugins).
func (s *Shell) heldRows(b *settingsBuilder, busy bool) ([]settingsRow, error) {
	var rows []settingsRow
	for _, held := range s.pluginOperations.Status().Held {
		verb, ok := heldVerbs[held.Action]
		if !ok {
			return nil, fmt.Errorf("held operation of %s has an unknown action %q", held.Plugin, held.Action)
		}
		s.errors.Show("settings plugin "+held.Plugin, held.Error, "")
		sessions, known := 0, true
		for _, service := range held.Sidecars {
			if service.Sessions == nil {
				known = false
				break
			}
			sessions += *service.Sessions
		}
		row := settingsRow{name: held.Plugin}
		if known {
			control := b.button(held.Plugin, "core.settings-tab.plugins.end", fmt.Sprintf("세션 %d개를 끝내고 %s", sessions, verb[0]), verb[1],
				map[string]any{"plugin": held.Plugin, "end": true})
			control.Disabled = busy
			b.model.actions = append(b.model.actions, settingsActionStatus{Plugin: held.Plugin, Action: "end", Disabled: busy})
			row.controls = []*SettingsControl{control}
		}
		rows = append(rows, row)
	}
	return rows, nil
}

// browseSize is the number of catalog rows that Browse shows at once (docs/spec/settings.md#plugins).
const browseSize = 30

// buildBrowse builds Browse: the search, the switch core.settings-tab.browse-hide, the count, the rows of the catalog that match, and the button
// of the next rows (docs/spec/settings.md#plugins).
func (s *Shell) buildBrowse(b *settingsBuilder) error {
	w := &s.settingsTab
	status := s.pluginOperations.Status()
	busy := status.Operation != nil && status.Operation.State == "running"
	query := strings.ToLower(strings.TrimSpace(w.browse.query))
	catalog := slices.Clone(s.pluginRowsOf(status))
	sort.SliceStable(catalog, func(i, j int) bool { return strings.Compare(catalog[i].Name, catalog[j].Name) < 0 })
	var matched []PluginRow
	for _, row := range catalog {
		if w.browse.hideInstalled && row.Installed != nil {
			continue
		}
		if query != "" && !catalogQueryMatches(row, query) {
			continue
		}
		matched = append(matched, row)
	}
	limit := w.browse.limit
	if limit < browseSize {
		limit = browseSize
	}
	shown := matched
	if len(shown) > limit {
		shown = shown[:limit]
	}
	b.model.shown = len(shown)

	search := b.add(SettingsControl{Name: "core.settings-tab.browse-search", Key: text("browse-query"), Value: text(w.browse.query),
		Command: settingCommand("core.settings-tab.browse", nil), kind: controlText, param: "query", searchable: true, Label: "이름, 기능으로 찾기"})
	hide := hideInstalledSwitch(b, w.browse.hideInstalled)
	count := fmt.Sprintf("%d개", len(catalog))
	if query != "" || w.browse.hideInstalled {
		count = fmt.Sprintf("%d / %d개", len(shown), len(catalog))
	}
	rows := []settingsRow{{controls: []*SettingsControl{search}}, {controls: []*SettingsControl{hide}}, {description: count}}
	for _, row := range shown {
		b.model.listed = append(b.model.listed, row.ID)
		rows = append(rows, s.catalogRow(b, row, busy))
	}
	if len(shown) == 0 {
		rows = append(rows, settingsRow{description: "맞는 플러그인이 없다."})
	}
	if len(matched) > len(shown) {
		next := len(matched) - len(shown)
		if next > browseSize {
			next = browseSize
		}
		more := b.button("browse-more", "core.settings-tab.browse-more", fmt.Sprintf("%d개 더 보기", next), "core.settings-tab.browse", map[string]any{"more": true})
		rows = append(rows, settingsRow{controls: []*SettingsControl{more}})
	}
	b.group("플러그인 찾아보기", fmt.Sprintf("카탈로그 %d개. 하나를 누르면 설치 전에 자세히 본다.", len(catalog)), rows...)
	return nil
}

// catalogQueryMatches reports whether a catalog row matches the lower-cased search text: its name, its id or its description.
func catalogQueryMatches(row PluginRow, query string) bool {
	for _, text := range []string{row.Name, row.ID, row.Description} {
		if strings.Contains(strings.ToLower(text), query) {
			return true
		}
	}
	return false
}

// hideInstalledSwitch is the switch core.settings-tab.browse-hide of Browse.
func hideInstalledSwitch(b *settingsBuilder, on bool) *SettingsControl {
	return b.add(SettingsControl{Name: "core.settings-tab.browse-hide", Key: text("hideInstalled"), Label: "설치한 것 숨기기", On: &on,
		Command: settingCommand("core.settings-tab.browse", nil), kind: controlSwitch, param: "hideInstalled"})
}

// catalogRow is one row of Browse: the name that opens the plugin page, the missing dependencies, the description, the meta line and
// the install action or the state of the installed plugin (docs/spec/settings.md#plugins).
func (s *Shell) catalogRow(b *settingsBuilder, row PluginRow, busy bool) settingsRow {
	name := b.button(row.ID, "core.settings-tab.browse-row", row.Name, "core.settings-tab.plugin", map[string]any{"plugin": row.ID})
	controls := []*SettingsControl{name}
	for _, dependency := range s.missingDependencies(row.ID, nil) {
		controls = append(controls, pluginBadge(b, dependency+" 필요", "warn"))
	}
	switch {
	case row.Installed == nil:
		controls = append(controls, s.pluginAction(b, busy, row.ID, "install", "설치", "core.plugins.install", map[string]any{"plugin": row.ID}))
	case row.Installed.Enabled:
		controls = append(controls, pluginBadge(b, "설치됨", "ok"))
	default:
		controls = append(controls, pluginBadge(b, "설치됨 · 꺼짐", "neutral"))
	}
	description := row.Description
	if description == "" {
		description = ""
	}
	return settingsRow{description: strings.TrimSpace(description + "\n" + pluginMeta(row, "")), controls: controls}
}

// buildPluginTab builds the page of one plugin: the back link, the info card, then the groups Accounts, Settings, Sections, Window sidebars and
// Card sidebar (docs/spec/settings.md#plugin-page). The info card follows the state of the plugin: an uninstalled plugin offers its
// installation, and an installed plugin its switch, its update, its missing dependencies and its removal.
func (s *Shell) buildPluginTab(b *settingsBuilder) error {
	w := &s.settingsTab
	status := s.pluginOperations.Status()
	var item *PluginRow
	rows := s.pluginRowsOf(status)
	for i := range rows {
		if rows[i].ID == w.chosen {
			item = &rows[i]
		}
	}
	if item == nil {
		return fmt.Errorf("plugin %s is not in the plugin state", w.chosen)
	}
	busy := status.Operation != nil && status.Operation.State == "running"
	unit := s.loadedPlugin(item.ID)
	backName := "설치됨"
	if w.back == "browse" {
		backName = "찾아보기"
	}
	back := b.button("plugin-back", "core.settings-tab.back", "‹ "+backName, "core.settings-tab.back", map[string]any{})
	info := []settingsRow{{controls: []*SettingsControl{back}}}
	// The description of the manifest, one element per line (docs/spec/settings.md#plugin-page).
	if unit != nil && unit.Description != "" {
		info = append(info, settingsRow{description: unit.Description, aboutLines: true})
	}
	if item.Installed == nil {
		info = append(info, settingsRow{name: "설치", controls: []*SettingsControl{s.pluginAction(b, busy, item.ID, "install", "설치", "core.plugins.install", map[string]any{"plugin": item.ID})}})
	} else {
		use := settingsRow{name: "사용", description: fmt.Sprintf("설치 %s", item.Installed.Version)}
		pluginUpdate, err := hasUpdate(*item)
		if err != nil {
			return err
		}
		if pluginUpdate {
			use.description = fmt.Sprintf("설치 %s · 배포 %s", item.Installed.Version, *item.Latest)
		} else {
			use.description += " · 최신"
		}
		use.controls = []*SettingsControl{pluginSwitch(b, *item, busy)}
		if pluginUpdate {
			use.controls = append(use.controls, s.pluginAction(b, busy, item.ID, "update", *item.Latest+"로 업데이트", "core.plugins.update", map[string]any{"plugin": item.ID}))
		}
		info = append(info, use)
		for _, dependency := range s.missingDependencies(item.ID, rows) {
			info = append(info, settingsRow{name: "필요", description: fmt.Sprintf("필요한 %s(%s) 플러그인이 설치되어 있지 않다.", dependency, dependency),
				controls: []*SettingsControl{s.pluginAction(b, busy, item.ID, "install-dependency", dependency+" 설치", "core.plugins.install", map[string]any{"plugin": dependency})}})
		}
		info = append(info, s.removalRow(b, item.ID))
	}
	contributions, err := s.contributionRows(b, item.ID)
	if err != nil {
		return err
	}
	info = append(info, contributions...)
	b.group(item.Name, item.ID, info...)
	if declared := s.units[item.ID]; unit != nil && declared != nil && declared.Accounts != nil {
		if w.accountPlugin != item.ID {
			w.accountPlugin, w.accountName, w.accountKind, w.accountEdit, w.accountEditName = item.ID, "", declared.Accounts.Kinds[0].Value, "", ""
		}
		s.buildAccounts(b, unit, declared.Accounts)
	}
	if err := s.buildPluginSettings(b, item.ID); err != nil {
		return err
	}
	if unit != nil {
		ids := make([]string, len(unit.Sections))
		for i, section := range unit.Sections {
			ids[i] = section.ID
		}
		// Each section is a read-only chip with its name; a plugin without sections says so in a line.
		var rows []settingsRow
		if len(ids) == 0 {
			rows = []settingsRow{{description: "이 플러그인에는 섹션이 없다."}}
		} else {
			names := s.sectionNames(ids)
			chips := make([]*SettingsControl, len(ids))
			for i, id := range ids {
				chips[i] = b.add(SettingsControl{Name: "core.settings-tab.chip", Key: text("section:" + id), Label: names[i], kind: controlChip})
			}
			rows = []settingsRow{{controls: chips}}
		}
		b.group("섹션", "이 플러그인이 사이드바에 제공하는 섹션.", rows...)
	}
	// The sidebar choices come from the loaded manifest, so a plugin that is not loaded has no sidebar group.
	if unit == nil {
		return nil
	}
	return s.buildPluginSides(b, item.ID, unit.Surface)
}

// contributionRows builds one line for each contribution of the plugin: its point, its entry number and its state. An invalid contribution
// shows its reason, which the error display shows under the name plugin <id> contribution <point> <n> (docs/spec/settings.md#plugin-page).
func (s *Shell) contributionRows(b *settingsBuilder, plugin string) ([]settingsRow, error) {
	states := map[string]string{"connected": "연결됨", "provider-missing": "제공자 없음", "version-mismatch": "version 불일치"}
	var rows []settingsRow
	for _, entry := range s.contributions.Status() {
		if entry.Plugin != plugin {
			continue
		}
		number := entry.Index + 1
		where := fmt.Sprintf("plugin %s contribution %s %d", plugin, entry.Point, number)
		var label string
		switch {
		case entry.State == "invalid":
			reason := "invalid"
			if entry.Reason != nil {
				reason = *entry.Reason
			}
			label = fmt.Sprintf("%s 기여 %d: %s", entry.Point, number, reason)
			s.errors.Show(where, label, "")
		case states[entry.State] != "":
			label = fmt.Sprintf("%s 기여 %d: %s", entry.Point, number, states[entry.State])
			s.errors.Hide(where)
		default:
			return nil, fmt.Errorf("contribution %s of %s has an unknown state %q", where, plugin, entry.State)
		}
		caption := b.add(SettingsControl{Name: "core.settings-tab.plugins.contribution", Key: text(fmt.Sprintf("%s:%d", entry.Point, entry.Index)), Label: label, kind: controlCaption})
		rows = append(rows, settingsRow{controls: []*SettingsControl{caption}})
	}
	return rows, nil
}

// removalRow is the row Remove of the info card: its description, the button Remove… and, while the removal is asked, the buttons Cancel and Remove.
func (s *Shell) removalRow(b *settingsBuilder, plugin string) settingsRow {
	w := &s.settingsTab
	row := settingsRow{name: "제거", description: "설정 값은 남겨 두고, 다시 설치하면 이어서 쓴다."}
	if w.confirm.kind == "plugin" && w.confirm.id == plugin {
		row.controls = []*SettingsControl{
			b.small("plugin-no", "core.settings-tab.confirm-no", "취소", "core.settings-tab.confirm", map[string]any{"kind": "plugin", "id": plugin, "answer": "no"}),
			b.small("plugin-yes", "core.settings-tab.confirm-yes", "제거", "core.settings-tab.confirm", map[string]any{"kind": "plugin", "id": plugin, "answer": "yes"}),
		}
		return row
	}
	row.controls = []*SettingsControl{b.small("plugin-ask", "core.settings-tab.delete", "제거…", "core.settings-tab.confirm", map[string]any{"kind": "plugin", "id": plugin, "answer": "ask"})}
	return row
}

// buildPluginSettings builds the group Settings of a plugin: one row for each setting that its declaration names, or the line that it has none.
func (s *Shell) buildPluginSettings(b *settingsBuilder, plugin string) error {
	var rows []settingsRow
	for _, definition := range s.settings.Definitions {
		if definition.Plugin != plugin {
			continue
		}
		control, err := s.declaredControl(b, definition)
		if err != nil {
			return err
		}
		row := s.row(b, definition.Label, control)
		// A stored value that names no loaded plugin shows its badge beside the choice (docs/spec/settings.md#plugins).
		if id, missing := s.settings.Missing(definition.Key); missing {
			row.controls = append([]*SettingsControl{pluginBadge(b, id+" 필요", "warn")}, row.controls...)
		}
		row.key, row.description = definition.Key, definition.Description
		rows = append(rows, row)
		b.model.declaredRows = append(b.model.declaredRows, row)
	}
	if len(rows) == 0 {
		rows = []settingsRow{{description: "이 플러그인에는 설정이 없다."}}
	}
	b.group("설정", "플러그인이 선언한 설정.", rows...)
	return nil
}

// buildPluginSides builds the groups Window sidebars and, for a plugin with a surface, Card sidebar: the four-row sidebar list of each, without
// switches, with the order of the plugin and the links of its places (docs/spec/settings.md#plugin-page).
func (s *Shell) buildPluginSides(b *settingsBuilder, plugin string, surface bool) error {
	scope := s.controlScope("links")
	sets, err := s.settings.Sets(scope)
	if err != nil {
		return err
	}
	links, err := s.settings.Links(scope)
	if err != nil {
		return err
	}
	window, err := s.sideRows(b, sideList{order: plugin + ".win.order", prefix: "window-", plugin: plugin}, sets, links)
	if err != nil {
		return err
	}
	b.group("창 사이드바", "이 플러그인의 탭이 포커스 카드의 활성 탭인 동안 쓰는 창 사이드바. 세트를 고른 변만 바뀌고, 위에 있는 줄부터 자리를 잡는다.", window...)
	if surface {
		card, err := s.sideRows(b, sideList{order: plugin + ".card.order", prefix: "card-", plugin: plugin}, sets, links)
		if err != nil {
			return err
		}
		b.group("카드 사이드바", "카드 안쪽 네 변. 세트를 고른 변만 보이고, 위에 있는 줄부터 자리를 잡는다. 순서는 이 플러그인의 카드에만 적용된다.", card...)
	}
	return nil
}

// pluginRowsOf returns the rows of the plugin pages. Before the host state is read, as without a host, the rows are the loaded plugins,
// each with the state loaded and no action (docs/spec/settings.md#plugins).
func (s *Shell) pluginRowsOf(status PluginsStatus) []PluginRow {
	if status.Core != nil {
		return status.Plugins
	}
	rows := make([]PluginRow, 0, len(s.plugins))
	for _, plugin := range s.plugins {
		version := plugin.Version
		rows = append(rows, PluginRow{ID: plugin.ID, Name: plugin.Name, Description: plugin.Description, State: "loaded",
			Installed: &PluginInstalled{Version: version, Enabled: true}, Sidecars: []PluginSidecar{}})
	}
	return rows
}
