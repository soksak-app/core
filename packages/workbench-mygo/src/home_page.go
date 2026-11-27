package workbench

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/egoist/mygo/ui"

	"github.com/soksak-app/core/packages/workbench-mygo/src/layout"
)

// The drawing of the project home (docs/spec/projects.md#project-home): the logo and the line of the start, the search, the two form
// buttons, the rows of the projects in two groups, the path row or the no-results line, and the key hint line.

// drawHome draws the project home in the room of width by height below the title bar.
func (s *Shell) drawHome(c *ui.Context, width, height float32) {
	s.surfaces.drawnHome = true
	m := s.metrics
	s.checkFolders()
	ui.Column(c).Size(width, height).Background(s.palette.Bg).Children(func() {
		ui.Scroll(c).FillWidth().Grow(1).Children(func() {
			ui.Column(c).FillWidth().Padding(m.space4).AlignItems(ui.Center).Children(func() {
				ui.Column(c).FillWidth().Gap(m.space3).Children(func() {
					s.drawHomeStart(c)
					s.drawHomeSearch(c)
					s.drawHomeButtons(c)
					if s.home.formMode != "" {
						s.drawHomeForm(c)
					}
					s.drawHomeRows(c)
				})
			})
		})
		// The key hint line stays below the scroll area, as the foot of the project home did, so the foot has no command.
		ui.Row(c).FillWidth().PaddingX(m.space4).PaddingY(m.space2).Children(func() {
			s.drawHomeKeys(c)
		})
	})
}

// drawHomeStart draws the logo and the line 어디서 시작할까?.
func (s *Shell) drawHomeStart(c *ui.Context) {
	ui.Row(c).Gap(s.metrics.space3).AlignItems(ui.Center).Children(func() {
		s.drawBrand(c)
		ui.Text(c, "어디서 시작할까?").Bold().LineHeight(s.metrics.lineHeight).FontSize(s.textControl()).TextColor(s.palette.Fg)
	})
}

// drawHomeSearch draws the search field, which takes the focus when the home is shown. Each change runs core.home.search.
func (s *Shell) drawHomeSearch(c *ui.Context) {
	query := s.home.query
	ui.Row(c).FillWidth().Gap(s.metrics.space2).AlignItems(ui.Center).Children(func() {
		run := s.binder.Control(c, "core.home.search", "core.home.search", "")
		field := s.drawnTextField(s.binder.Bound(ui.TextInputBase(c, &query), "core.home.search")).Grow(1).MinWidth(0).Label("프로젝트 찾기").
			Placeholder("프로젝트 찾기 또는 폴더 경로 붙여넣기")
		if field.Changed() {
			run(map[string]string{"query": query})
		}
		// The caption is the shortcut of core.home.search.focus (docs/spec/projects.md#project-home).
		ui.Text(c, "⌘O").LineHeight(s.metrics.lineHeight).FontSize(s.textCaption()).TextColor(s.palette.Muted)
	})
}

// drawHomeButtons draws the primary button 새 프로젝트 and the button 폴더 열기, which open the form in their mode.
func (s *Shell) drawHomeButtons(c *ui.Context) {
	ui.Row(c).Gap(s.metrics.space2).Children(func() {
		s.uiButton(c, s.binder.Press(c, "core.home.add", "core.home.form.open", "", map[string]string{"mode": "create"}), "새 프로젝트", true)
		s.uiButton(c, s.binder.Press(c, "core.home.open-folder", "core.home.form.open", "", map[string]string{"mode": "open"}), "폴더 열기", false)
	})
}

// drawHomeForm draws the form of the open mode: the name of a new folder for create, and the folder path of both modes.
func (s *Shell) drawHomeForm(c *ui.Context) {
	m := s.metrics
	creates := s.home.formMode == "create"
	ui.Column(c).FillWidth().Padding(m.space4).Radius(s.radiusSmall()).Border(s.palette.BorderWidth, s.palette.Edge).Background(s.palette.Card).Gap(m.space3).Children(func() {
		if creates {
			s.drawFormField(c, "core.home.form.name", "name", &s.home.name, "프로젝트 폴더 이름", "my-project", true, nil)
		}
		label := "폴더 경로"
		if creates {
			label = "생성 위치"
		}
		s.drawFormField(c, "core.home.form.parent", "parent", &s.home.parent, label, "/Users/…", !creates, func() {
			s.uiButton(c, s.binder.Press(c, "core.home.form.choose", "core.home.choose-folder", "", nil).AlignSelf(ui.Start), "폴더 선택", false)
		})
		ui.Row(c).FillWidth().Gap(m.space2).Justify(ui.End).Children(func() {
			s.uiButton(c, s.binder.Press(c, "core.home.form.cancel", "core.home.form.cancel", "", nil), "취소", false)
			submit := "프로젝트로 열기"
			if creates {
				submit = "생성 후 열기"
			}
			s.uiButton(c, s.binder.Press(c, "core.home.form.submit", "core.home.form.submit", "", nil), submit, true)
		})
	})
}

// drawFormField draws a field of the form with its title over it and after under it. Enter submits the form, and the first field takes the focus as
// the form opens.
func (s *Shell) drawFormField(c *ui.Context, name, field string, value *string, title, placeholder string, first bool, after func()) {
	m := s.metrics
	ui.Column(c).FillWidth().Gap(m.space2).Children(func() {
		ui.Text(c, title).LineHeight(s.metrics.lineHeight).FontSize(s.textControl()).TextColor(s.palette.Muted)
		set := s.binder.Control(c, name, "core.home.form.set", field)
		input := s.drawnTextField(s.binder.Bound(ui.TextInputBase(c, value), name)).FillWidth().Label(title).Placeholder(placeholder)
		if first {
			input.AutoFocus()
		}
		if input.Changed() {
			set(homeField{Field: field, Value: *value})
		}
		if input.Submitted() {
			s.binder.run("core.home.form.submit", nil)
		}
		if after != nil {
			after()
		}
	})
}

// drawHomeRows draws the rows of the projects in the groups 고정 and 최근; the group 최근 is shown only while a pinned row exists. With a
// query that starts with / or ~ and matches no project, it draws the row that opens the path.
func (s *Shell) drawHomeRows(c *ui.Context) {
	rows := s.homeRows()
	if len(rows) == 0 {
		s.drawHomeNoRows(c)
		return
	}
	selected := s.selectedRow(rows)
	pinned := rows[0].Pinned
	for i, row := range rows {
		if i == 0 && pinned {
			s.drawHomeGroup(c, "고정")
		}
		if i > 0 && rows[i-1].Pinned && !row.Pinned {
			s.drawHomeGroup(c, "최근")
		}
		s.drawHomeRow(c, row, row.ID == selected)
	}
}

// drawHomeGroup draws the title of a group of rows.
func (s *Shell) drawHomeGroup(c *ui.Context, title string) {
	ui.Text(c, title).LineHeight(s.metrics.lineHeight).FontSize(s.textCaption()).TextColor(s.palette.Muted)
}

// drawHomeNoRows draws the path row for a query that starts with / or ~, and the line of no match for any other query.
func (s *Shell) drawHomeNoRows(c *ui.Context) {
	query := strings.TrimSpace(s.home.query)
	if query == "" {
		return
	}
	if !strings.HasPrefix(query, "/") && !strings.HasPrefix(query, "~") {
		ui.Text(s.binder.Name(c, "core.home.no-results", ""), fmt.Sprintf("“%s”와 맞는 프로젝트가 없다.", query)).LineHeight(s.metrics.lineHeight).
			FontSize(s.textControl()).TextColor(s.palette.Muted)
		return
	}
	m := s.metrics
	ui.Row(s.binder.Name(c, "core.home.path", "")).Role(ui.RoleGroup).FillWidth().Gap(m.space3).AlignItems(ui.Center).Padding(m.space3).
		Radius(s.radiusSmall()).Border(s.palette.BorderWidth, s.palette.Edge).Children(func() {
		ui.Text(c, "이 경로를 프로젝트로 연다").LineHeight(m.lineHeight).FontSize(s.textControl()).TextColor(s.palette.Fg)
		ui.Text(c, query).SingleLine().Ellipsis("…").Font(debugMonoFont).LineHeight(m.lineHeight).FontSize(s.textSmall()).TextColor(s.palette.Muted).FillWidth()
		s.uiButton(c, s.binder.Press(c, "core.home.path", "core.home.form.open", query, map[string]any{"mode": "open", "parent": query}), "열기", true)
	})
}

// drawHomeRow draws one row: the confirm state of a removal, or the letter square, the name, the badge, the path, the space count, the day, and
// the pin and remove buttons, which show on hover or selection and stay on a pinned row.
func (s *Shell) drawHomeRow(c *ui.Context, project projectRecord, selected bool) {
	m := s.metrics
	if s.home.confirm == project.ID {
		ui.Row(c.Key("home-confirm-" + project.ID)).FillWidth().Gap(m.space2).AlignItems(ui.Center).Padding(m.space3).Children(func() {
			ui.Text(c, project.Title+" — 목록에서 뺄까? 폴더는 그대로 둔다.").SingleLine().Ellipsis("…").LineHeight(m.lineHeight).FontSize(s.textControl()).TextColor(s.palette.Fg).FillWidth()
			s.uiButton(c, s.binder.Press(c, "core.home.confirm", "core.home.confirm", project.ID, confirmParam{project.ID, "no"}), "취소", false)
			s.uiButton(c, s.binder.Press(c, "core.home.confirm", "core.home.confirm", project.ID+":yes", confirmParam{project.ID, "yes"}), "빼기", true)
		})
		return
	}
	// The open button and the pin and remove buttons are siblings: a button element keeps no child in the element tree, so a
	// button nested in the open button would not be found by its element name.
	// The selected or hovered background belongs to the line, so it covers the action buttons as the row did before.
	line := ui.Row(c).Role(ui.RoleGroup).Label(project.Title).FillWidth().Radius(s.radiusSmall()).Padding(m.space2, m.space3).Gap(m.space2).AlignItems(ui.Center)
	if selected || line.Hovered() {
		line.Background(s.palette.Card)
	}
	line.Children(func() {
		row := s.binder.Press(c, "core.home.open", "core.home.open", project.ID, projectParam{project.ID})
		row.Grow(1).MinWidth(0).AlignItems(ui.Center).Gap(m.space3).Label(project.Title)
		row.Children(func() {
			s.drawHomeLetter(c, project.Title)
			ui.Column(c).FillWidth().MinWidth(0).Children(func() {
				ui.Row(c).Gap(m.space2).AlignItems(ui.Center).Children(func() {
					ui.Text(c, project.Title).SingleLine().Ellipsis("…").LineHeight(m.lineHeight).FontSize(s.textControl()).TextColor(s.palette.Fg)
					if s.isOpen(project.ID) {
						ui.Text(c, "열림").LineHeight(m.lineHeight).FontSize(s.textCaption()).TextColor(s.palette.Rail)
					}
				})
				ui.Text(c, project.Root).SingleLine().Ellipsis("…").Font(debugMonoFont).Tooltip(project.Root).LineHeight(m.lineHeight).FontSize(s.textSmall()).TextColor(s.palette.Muted)
			})
			ui.Text(c, fmt.Sprintf("스페이스 %d", len(project.Spaces))).LineHeight(m.lineHeight).FontSize(s.textCaption()).TextColor(s.palette.Muted)
			if project.LastOpened > 0 {
				ui.Text(c, s.homeDay(time.UnixMilli(int64(project.LastOpened)))).LineHeight(m.lineHeight).FontSize(s.textCaption()).TextColor(s.palette.Muted)
			}
		})
		if selected || line.Hovered() || project.Pinned {
			s.drawHomePin(c, project)
			s.drawHomeRemove(c, project)
		}
	})
}

// drawHomeLetter draws the square of the first letter of a name in the accent color with the text color of the theme.
func (s *Shell) drawHomeLetter(c *ui.Context, name string) {
	m := s.metrics
	letter := "?"
	for _, r := range name {
		letter = string(r)
		break
	}
	ui.Box(c).Size(m.actW, m.actW).Radius(s.radiusSmall()).Background(s.palette.Rail).Center().Children(func() {
		ui.Text(c, letter).Bold().LineHeight(m.lineHeight).FontSize(s.textControl()).TextColor(s.palette.Card)
	})
}

// drawHomePin draws the pin button, which runs core.home.pin, with the tooltip 위에 고정 or 고정 풀기.
func (s *Shell) drawHomePin(c *ui.Context, project projectRecord) {
	title := "위에 고정"
	if project.Pinned {
		title = "고정 풀기"
	}
	button := s.binder.Press(c, "core.home.pin", "core.home.pin", project.ID, projectParam{project.ID})
	button.Size(s.metrics.actW, s.metrics.actH).Center().Radius(s.radiusSmall()).Label(title).Tooltip(title)
	ui.Text(c, map[bool]string{true: "★", false: "☆"}[project.Pinned]).LineHeight(s.metrics.lineHeight).FontSize(s.textControl()).TextColor(s.palette.Muted)
}

// drawHomeRemove draws the × button, which runs core.home.confirm with the answer ask and does not remove the project.
func (s *Shell) drawHomeRemove(c *ui.Context, project projectRecord) {
	button := s.binder.Press(c, "core.home.remove-ask", "core.home.confirm", project.ID, confirmParam{project.ID, "ask"})
	button.Size(s.metrics.actW, s.metrics.actH).Center().Radius(s.radiusSmall()).Label("목록에서 빼기").Tooltip("목록에서 빼기")
	ui.Text(c, "×").LineHeight(s.metrics.lineHeight).FontSize(s.textControl()).TextColor(s.palette.Muted)
}

// homeDay names the day of an opened project: 오늘, 어제, <n>일 전 within the last week, and <M>월 <D>일 for older days.
func (s *Shell) homeDay(when time.Time) string {
	now := time.Now()
	days := int(now.Sub(when).Hours() / 24)
	switch {
	case sameDay(when, now):
		return "오늘"
	case sameDay(when, now.AddDate(0, 0, -1)):
		return "어제"
	case days < 7:
		return fmt.Sprintf("%d일 전", days)
	}
	return fmt.Sprintf("%d월 %d일", when.Month(), when.Day())
}

func sameDay(a, b time.Time) bool {
	ay, am, ad := a.Date()
	by, bm, bd := b.Date()
	return ay == by && am == bm && ad == bd
}

// drawHomeKeys draws the key hint line. Only the keys that the home binds are named.
func (s *Shell) drawHomeKeys(c *ui.Context) {
	ui.Text(c, "↑↓ 이동, Enter 열기, ⌘⌫ 목록에서 빼기, ⌘, 설정").LineHeight(s.metrics.lineHeight).FontSize(s.textCaption()).TextColor(s.palette.Muted)
}

// storedLayoutFailure returns the reason that the stored layout of the active space of project cannot be opened, or "" when it can.
func (s *Shell) storedLayoutFailure(project *projectRecord) string {
	space, err := layout.SpaceIn(&project.Project, project.ActiveSpaceID)
	if err != nil {
		return ""
	}
	if err := layout.CheckStoredLayout(space.Layout, s.pluginUnits()); err != nil {
		return fmt.Sprintf("projects.json: project %s space %s: %s", project.Root, project.ActiveSpaceID, err)
	}
	var stored storedLayout
	if err := json.Unmarshal(space.Layout, &stored); err != nil {
		return err.Error()
	}
	if _, err := s.readStoredTree(stored); err != nil {
		return fmt.Sprintf("projects.json: project %s space %s: %s", project.Root, project.ActiveSpaceID, err)
	}
	return ""
}

// readStoredTree reads the stored layout of stored on a grid of its own, as loadSpace reads it.
func (s *Shell) readStoredTree(stored storedLayout) (*layout.GroupTree, error) {
	gap := s.palette.PlaneGap()
	grid, err := layout.New(nil, layout.Options{Gap: &gap})
	if err != nil {
		return nil, err
	}
	return layout.ReadTree(stored.State, stored.Groups, stored.Leader, stored.LastCard, s.groupOptions(), grid)
}

// drawnTextField gives a bare text input the look of .text-field: the border follows the pointer and the focus.
func (s *Shell) drawnTextField(field ui.Element) ui.Element {
	m := s.metrics
	edge := s.palette.Edge
	switch {
	case field.Focused():
		edge = s.palette.Focus
	case field.Hovered():
		edge = s.palette.Rail
	}
	return field.Padding(m.fieldPadY, m.space2, m.fieldPadY, m.space2).Border(s.palette.BorderWidth, edge).Radius(s.radiusSmall()).
		Background(s.palette.Bg).TextColor(s.palette.Fg).LineHeight(s.metrics.lineHeight).FontSize(s.textControl())
}

// uiButton gives a pressable element the look of .ui-button, and the primary look of the home buttons with primary.
func (s *Shell) uiButton(c *ui.Context, button ui.Element, label string, primary bool) {
	m := s.metrics
	edge := s.palette.Edge
	if button.Hovered() || primary {
		edge = s.palette.Rail
	}
	fill := s.palette.Bg
	if primary {
		fill = faded(s.palette.Rail, m.chipOnMix)
	}
	button.Padding(m.fieldPadY, m.space3, m.fieldPadY, m.space3).Border(s.palette.BorderWidth, edge).Radius(s.radiusSmall()).Background(fill).
		Label(label).Children(func() {
		ui.Text(c, label).SingleLine().LineHeight(s.metrics.lineHeight).FontSize(s.textControl()).TextColor(s.palette.Fg)
	})
}
