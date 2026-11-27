package workbench

import (
	"fmt"
	"strconv"
)

// The pages of the settings tab (docs/spec/settings.md#pages). Each builder adds the groups of one page in document order. A builder
// fails only when the stored choices or the catalog name no label.

// choiceRow is the row of a select control whose choices are the catalog choices of key, labelled by labels.
func (s *Shell) choiceRow(b *settingsBuilder, name, key string, labels map[string]string) (settingsRow, error) {
	options, err := labelled(s.settings.Catalog.choices(key), labels)
	if err != nil {
		return settingsRow{}, err
	}
	control, err := s.choose(b, key, options, valueText(s.value(key)))
	if err != nil {
		return settingsRow{}, err
	}
	return s.row(b, name, control), nil
}

// dependentRow is the row of a setting that depends on the boolean parent setting: it is indented under the parent, and disabled
// while the parent is off (docs/spec/settings.md#dependency-and-validation-rules).
func (s *Shell) dependentRow(b *settingsBuilder, name string, control *SettingsControl, parent string) settingsRow {
	on, _ := s.value(parent).(bool) // silent: the settings store checks the type of the value.
	row := s.row(b, name, control)
	row.indent, row.disabled = true, !on
	for _, item := range row.controls {
		item.Disabled = !on
	}
	return row
}

// buildLook builds 모양: the theme and its mode, the shape values and the display choices.
func (s *Shell) buildLook(b *settingsBuilder) error {
	catalog := s.settings.Catalog
	themeScope := s.controlScope("theme")
	theme := settingsRow{}
	for i := range catalog.Themes {
		item := &catalog.Themes[i]
		theme.controls = append(theme.controls, b.pressedButton("theme:"+item.Name, "core.settings-tab.theme", "", "core.settings.theme",
			map[string]any{"name": item.Name, "scope": themeScope}, item.Name == s.value("theme")))
		last := theme.controls[len(theme.controls)-1]
		last.kind, last.theme, last.Label = controlSwatch, item, item.Name
	}
	theme.controls = append(theme.controls, s.overrideControls(b, "theme", "전역 테마 사용")...)
	// The row is the key of the theme, so the search finds it on this page (docs/spec/settings.md#search).
	theme.key = "theme"
	mode, err := s.choiceRow(b, "모드", "mode", map[string]string{"dark": "어두움", "light": "밝음"})
	if err != nil {
		return err
	}
	b.group("테마", "테마가 색과 형태의 기본값을 정하고, 모드는 그 테마의 밝은 쪽과 어두운 쪽을 고른다.", theme, mode)

	fonts := make(map[string]string, len(catalog.Fonts))
	for _, font := range catalog.Fonts {
		fonts[font.ID] = font.Name
	}
	shape := catalog.Settings.ShapeRanges
	font, err := s.choiceRow(b, "폰트", "font", fonts)
	if err != nil {
		return err
	}
	steps := map[string]string{}
	for _, step := range catalog.Settings.TextSteps {
		steps[strconv.FormatFloat(step, 'f', -1, 64)] = strconv.FormatFloat(step, 'f', -1, 64)
	}
	textSize, err := s.choiceRow(b, "textSize", "textSize", steps)
	if err != nil {
		return err
	}
	b.group("형태", "테마가 준 값에서 시작한다. 통로를 0 으로 내리면 카드가 선 하나를 공유한다.",
		s.row(b, "통로", s.slide(b, "gap", shape["gap"], "px")),
		s.row(b, "모서리", s.slide(b, "radius", shape["radius"], "px")),
		font,
		s.row(b, "글자 크기", s.stepper(b, "size", shape["size"], "px")),
		textSize)

	focus, err := s.choiceRow(b, "포커스 표시", "focusInd", map[string]string{"border": "테두리", "corner": "꺽쇠"})
	if err != nil {
		return err
	}
	rule, err := s.choiceRow(b, "경계선", "fullRule", map[string]string{"under": "가림", "over": "보임", "none": "숨김"})
	if err != nil {
		return err
	}
	b.group("표시", "배치는 그대로 두고 보이는 모습만 바꾼다.", focus, rule, s.row(b, "포커스 밖 흐리게", s.toggle(b, "dim")))
	return nil
}

// buildWorkspace builds 작업 공간: the project opening, the project tab position, the window sidebars and their sizes.
func (s *Shell) buildWorkspace(b *settingsBuilder) error {
	scope := s.settingsTab.scope
	if scope == "common" {
		opening, err := s.choiceRow(b, "열기 방식", "projectOpening", map[string]string{"tabs": "현재 창", "windows": "별도 창"})
		if err != nil {
			return err
		}
		b.group("프로젝트", "프로젝트를 여는 방식. 모든 프로젝트에 적용되며, 이미 열린 창은 그대로 둔다.", opening)
	}
	position, err := s.choiceRow(b, "프로젝트 탭 위치", "projectTabs", s.settings.Catalog.Rows.Labels["projectTabs"])
	if err != nil {
		return err
	}
	b.group("위치", "프로젝트 탭이 놓이는 위치. 바꾸면 카드 배치도 함께 바뀐다.", position)
	return s.buildSidebarRows(b)
}

// buildSidebarRows builds the group 사이드바 and the group 사이드바 크기 of the window sidebars.
func (s *Shell) buildSidebarRows(b *settingsBuilder) error {
	// A link control takes the sets of the scope of the links as its options.
	sets, err := s.settings.Sets(s.controlScope("links"))
	if err != nil {
		return err
	}
	links, err := s.settings.Links(s.controlScope("links"))
	if err != nil {
		return err
	}
	// The order sets which sidebar takes the room of the plane first, so the list shows the sides in the order of sidebarOrder
	// (docs/spec/external-sidebars.md).
	rows, err := s.sideRows(b, sideList{order: "sidebarOrder", switches: true}, sets, links)
	if err != nil {
		return err
	}
	b.group("사이드바", "위에 있는 줄부터 자리를 잡는다. 먼저 놓인 변이 그 변의 전체 길이를 쓰고, 다음 변은 그만큼 빠진다. 끈 변도 자기 순서를 지킨다.", rows...)

	widths := s.settings.Catalog.Settings.LayoutRanges
	b.group("사이드바 크기", "사이드바의 폭(pt). 처음 폭은 카드 안 사이드바와 저장 크기가 없는 창 사이드바가 여는 크기(위·아래 사이드바는 높이)이며 최소 폭과 최대 폭 사이여야 한다.",
		s.row(b, "최소 폭", s.slide(b, "sidebarMinWidth", widths["sidebarMinWidth"], "pt")),
		s.row(b, "최대 폭", s.slide(b, "sidebarMaxWidth", widths["sidebarMaxWidth"], "pt")),
		s.row(b, "처음 폭", s.slide(b, "sidebarWidth", widths["sidebarWidth"], "pt")))
	return nil
}

// buildBehavior builds 동작: the language, the card arrangement, the memory saver and the error toasts.
func (s *Shell) buildBehavior(b *settingsBuilder) error {
	catalog := s.settings.Catalog
	languages := map[string]string{"auto": "자동"}
	for _, language := range catalog.MenuLanguages {
		languages[language.ID] = language.Label
	}
	language, err := s.choiceRow(b, "언어", "language", languages)
	if err != nil {
		return err
	}
	b.group("언어", "애플리케이션 메뉴의 언어. 자동은 시스템 언어를 따르고, 목록에 없으면 영어다.", language)
	arrange, err := s.choiceRow(b, "카드 자동 정렬", "cardArrange", map[string]string{"resize": "크기맞춤", "even": "균등"})
	if err != nil {
		return err
	}
	b.group("카드", "resize는 배치를 지키며 카드 크기를 고르게 나눈다. even은 카드를 같은 격자로 놓는다.", arrange)
	if s.settingsTab.scope != "common" {
		return nil
	}
	process, err := s.choiceRow(b, "보기 프로세스", "viewProcess", map[string]string{"plugin": "플러그인마다 하나", "view": "카드마다 하나"})
	if err != nil {
		return err
	}
	b.group("메모리", "메모리 절약을 켜면 숨긴 지 정한 시간이 지난 탭을 내리고, 다시 보일 때 저장된 상태로 연다.",
		process,
		s.row(b, "메모리 절약", s.toggle(b, "memorySaver")),
		s.dependentRow(b, "숨긴 뒤 내리기까지", s.slide(b, "memorySaverDelay", catalog.Settings.MemorySaverDelay, "분"), "memorySaver"))
	return s.buildNotices(b, catalog.Rows)
}

// buildNotices builds the group 알림 of the behavior page from the rows of the workbench declaration, with their labels, descriptions,
// units and dependencies, in the declared order (docs/spec/notifications.md#settings).
func (s *Shell) buildNotices(b *settingsBuilder, rows declaredRows) error {
	group, ok := rows.groupByID("behavior", "notices")
	if !ok {
		return fmt.Errorf("the workbench declaration has no group notices on the page behavior")
	}
	var built []settingsRow
	for _, def := range group.Rows {
		var row settingsRow
		var err error
		switch def.Form {
		case "choice":
			row, err = s.choiceRow(b, def.Label, def.Key, rows.Labels[def.Key])
		case "switch":
			row = s.row(b, def.Label, s.toggle(b, def.Key))
		case "stepper":
			row = s.dependentRow(b, def.Label, s.stepper(b, def.Key, s.settings.Catalog.Settings.ProblemToastDismissSeconds, def.Unit), def.Depends)
		default:
			return fmt.Errorf("the notification row %s has the form %q, which the group 알림 does not draw", def.Key, def.Form)
		}
		if err != nil {
			return err
		}
		row.description = def.Description
		built = append(built, row)
	}
	b.group(group.Name, group.Description, built...)
	return nil
}

// buildDiag builds 진단: the debug switch.
func (s *Shell) buildDiag(b *settingsBuilder) error {
	on := s.settings.DebugOn()
	debug := b.add(SettingsControl{Name: "core.settings-tab.debug", Label: "디버그", On: &on, Command: settingCommand("core.settings.debug", nil), kind: controlSwitch, param: "on"})
	b.group("진단", "디버그를 켜면 성능 트레이스와 모든 로그 종류의 상세 기록이 남는다. 끄면 오류만 기록된다.", settingsRow{name: "디버그", controls: []*SettingsControl{debug}})
	return nil
}

// settingsPageDescriptions are the descriptions under the title of each page of the menu (docs/spec/settings.md#pages).
var settingsPageDescriptions = map[string]string{
	"look":      "테마와 모드, 카드의 간격·모서리·글꼴.",
	"workspace": "프로젝트 창, 탭 위치, 사이드바 배치와 크기.",
	"sets":      "사이드바에 보여 줄 섹션 묶음. 어느 변에 놓을지는 작업 공간과 플러그인에서 고른다.",
	"behavior":  "언어, 메모리, 알림.",
}

// settingsPageDescription is the description of a page, or empty for a page whose description is not implemented yet.
func settingsPageDescription(page string) string { return settingsPageDescriptions[page] }

// settingsPageTitle is the title of the page in front: the label of the menu, or the name of the plugin of a plugin page.
func settingsPageTitle(w *settingsTab) string {
	if w.page == "plugin" {
		return w.chosen
	}
	for _, item := range settingsPages {
		if item[0] == w.page {
			return item[1]
		}
	}
	return ""
}

// buildAgents builds 에이전트 연동: the setup parts of the agent.
func (s *Shell) buildAgents(b *settingsBuilder) error {
	s.buildSetup(b)
	return nil
}
