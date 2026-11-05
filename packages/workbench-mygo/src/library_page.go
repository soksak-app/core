package workbench

import (
	"encoding/json"
	"fmt"
	"math"
	"slices"
	"strings"
	"time"

	"github.com/egoist/mygo/ui"

	"github.com/soksak-app/core/packages/workbench-mygo/src/layout"
)

// The drawing of the library, as packages/workbench/library.js and library.css lay it out: a head with the pages, the sort and the search, the cards
// of the projects in columns, and a footer with the count.

// librarySorts are the orders of the projects, and their labels in the select.
var (
	librarySorts      = []string{"saved", "name", "recent", "open"}
	librarySortLabels = map[string]string{"saved": "저장 순서", "name": "이름", "recent": "최근", "open": "열림"}
)

// previewPane is the place of a pane in a preview of the window, the value of core.library.
type previewPane struct {
	Card string  `json:"card"`
	X    float32 `json:"x"`
	Y    float32 `json:"y"`
	W    float32 `json:"w"`
	H    float32 `json:"h"`
}

// folderReasons are the folder errors of the host (workspace.folder.messages) and the reason that a card shows.
var folderReasons = []struct{ prefix, reason string }{
	{"project directory does not exist: ", "폴더가 없습니다."},
	{"project directory is not readable: ", "폴더를 읽을 권한이 없습니다."},
	{"not a project directory: ", "폴더가 아니라 파일입니다."},
}

func folderReason(message string) string {
	for _, known := range folderReasons {
		if strings.HasPrefix(message, known.prefix) {
			return known.reason
		}
	}
	return "폴더를 확인할 수 없습니다: " + message
}

// inLibrary tells whether the library is shown.
func (s *Shell) inLibrary() bool { return s.plane == nil || s.browsing }

// checkFolders asks the host whether the folder of each project can be read, when the list of the projects changed. Only the answer of the latest
// check of a root replaces what the card shows.
func (s *Shell) checkFolders() {
	roots := make([]string, len(s.projects))
	for i, project := range s.projects {
		roots[i] = project.Root
	}
	list := strings.Join(roots, "\n")
	if s.library.foldersFor == list {
		return
	}
	s.library.foldersFor = list
	for root := range s.library.checks {
		if !slices.Contains(roots, root) {
			delete(s.library.checks, root)
			delete(s.library.folderErrors, root)
			s.errors.Hide("library project " + root)
		}
	}
	for _, root := range roots {
		s.library.checkCount++
		check := s.library.checkCount
		s.library.checks[root] = check
		s.calls.Call("projectFolder", root, func(_ any, err error) {
			if s.library.checks[root] != check {
				return
			}
			if err != nil {
				s.library.folderErrors[root] = err.Error()
				s.errors.Show("library project "+root, folderReason(err.Error()), "")
			} else {
				delete(s.library.folderErrors, root)
				s.errors.Hide("library project " + root)
			}
			s.options.Invalidate()
		})
	}
}

// drawLibrary draws the library screen.
func (s *Shell) drawLibrary(c *ui.Context, width, height float32) {
	m := s.metrics
	s.checkFolders()
	ui.Column(c).Size(width, height).Background(s.palette.Bg).Children(func() {
		ui.Scroll(c).FillWidth().Grow(1).Column().Padding(m.space3).Children(func() {
			s.drawLibraryHead(c, width-2*m.space3)
			DrawErrorBanner(c, s.errors)
			if s.library.page == pluginsPage {
				s.drawPlugins(c, width-2*m.space3)
				return
			}
			if s.library.formMode != "" {
				s.drawLibraryForm(c)
			}
			if len(s.projects) == 0 {
				s.drawLibraryEmpty(c)
			}
			s.drawProjectGrid(c, width-2*m.space3)
		})
		s.drawLibraryFooter(c, width)
	})
}

// drawLibraryHead draws the pages of the library, and the sort and the search of the shown page. A narrow window gives the search a row of its own.
func (s *Shell) drawLibraryHead(c *ui.Context, width float32) {
	m := s.metrics
	narrow := width+2*m.space3 < m.libraryNarrowW
	search := func() {
		place := func(field ui.Element) ui.Element {
			field = s.drawnTextField(field)
			if narrow {
				return field.FillWidth()
			}
			return field.Width(m.librarySearchW)
		}
		if s.library.page == pluginsPage {
			DrawPluginSearch(c, s.binder, s.library.pluginQuery, place)
			return
		}
		run := s.binder.Control(c, "core.library.search", "core.library.search", "")
		query := s.library.query
		field := place(s.binder.Bound(ui.TextInputBase(c, &query), "core.library.search")).Label("프로젝트 검색").Placeholder("이름 또는 폴더 검색")
		if field.Changed() {
			run(map[string]string{"query": query})
		}
	}
	ui.Column(c).FillWidth().Gap(m.space2).Margin(0, 0, m.space3, 0).Children(func() {
		ui.Row(c).FillWidth().MinHeight(m.chromeRowH).AlignItems(ui.Center).Gap(m.space3).Children(func() {
			ui.Row(c).Gap(m.space1).Children(func() {
				for _, page := range []struct{ id, label string }{{"projects", "프로젝트"}, {pluginsPage, "플러그인"}} {
					color := s.palette.Muted
					if s.library.page == page.id {
						color = s.palette.Fg
					}
					button := s.binder.Press(c, "core.library.page", "core.library.page", page.id, map[string]string{"page": page.id})
					button.PaddingX(m.space1).Label(page.label).Children(func() {
						ui.Text(c, page.label).Bold().LineHeight(s.metrics.lineHeight).FontSize(float32(s.settings.Value("size").(float64))).TextColor(color)
					})
				}
			})
			if s.library.page != pluginsPage {
				s.drawLibrarySort(c)
			}
			if !narrow {
				ui.Spacer(c).Grow(1)
				search()
			}
		})
		if narrow {
			search()
		}
	})
}

// drawLibrarySort draws the select of the order of the projects.
func (s *Shell) drawLibrarySort(c *ui.Context) {
	m := s.metrics
	order := s.library.order
	run := s.binder.Control(c, "core.library.sort", "core.library.sort", "")
	selector := ui.SelectBase(c, &order)
	s.binder.Bound(selector.Trigger, "core.library.sort")
	edge := s.palette.Edge
	switch {
	case selector.Trigger.Focused():
		edge = s.palette.Focus
	case selector.Trigger.Hovered():
		edge = s.palette.Rail
	}
	// .select-field select:focus-visible: the focus color on the border, without an outline.
	selector.Trigger.FocusRing(false).Width(m.librarySortW).Padding(m.fieldPadY, m.selectArrowRoom, m.fieldPadY, m.space2).Radius(s.radiusSmall()).
		Border(s.palette.BorderWidth, edge).Background(s.palette.Bg).AlignItems(ui.Center).Justify(ui.Start).Label("프로젝트 정렬").Children(func() {
		ui.Text(c, librarySortLabels[order]).SingleLine().LineHeight(s.metrics.lineHeight).FontSize(s.textControl()).TextColor(s.palette.Fg)
		ui.Row(c).Absolute().Right(m.selectArrowInset).Top(0).Bottom(0).AlignItems(ui.Center).Children(func() {
			ui.Text(c, "▾").LineHeight(s.metrics.lineHeight).FontSize(s.textCaption()).TextColor(s.palette.Muted)
		})
	})
	selector.Popup(func(panel ui.Element) {
		panel.Padding(m.space1).Background(s.palette.Card).Border(s.palette.BorderWidth, s.palette.Edge).Radius(s.radiusSmall())
		for _, id := range librarySorts {
			item := selector.Item(id).PaddingX(m.space2).Height(m.spaceTabH).AlignItems(ui.Center)
			if item.Highlighted() {
				item.Background(s.palette.Rule)
			}
			item.Children(func() {
				ui.Text(c, librarySortLabels[id]).LineHeight(s.metrics.lineHeight).FontSize(s.textControl()).TextColor(s.palette.Fg)
			})
		}
	})
	if order != s.library.order {
		run(map[string]string{"order": order})
	}
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

// drawLibraryEmpty draws the start of an empty library. The heading and the line keep the margins of a browser, which the page leaves to them: .83em
// around a heading and 1em around a line, where the margin between the two is the larger of them.
func (s *Shell) drawLibraryEmpty(c *ui.Context) {
	m := s.metrics
	const headingMargin = .83
	size := float32(s.settings.Value("size").(float64))
	between := max(size*headingMargin, s.textControl())
	ui.Column(s.binder.Name(c, "core.library.empty", "")).Role(ui.RoleGroup).Label("프로젝트를 시작하세요").FillWidth().AlignItems(ui.Center).PaddingY(m.space4).Children(func() {
		ui.Text(c, "프로젝트를 시작하세요").Bold().LineHeight(m.lineHeight).FontSize(size).TextColor(s.palette.Fg).Margin(size*headingMargin, 0, between, 0)
		ui.Text(c, "새 프로젝트를 만들거나 기존 폴더를 여세요.").LineHeight(m.lineHeight).FontSize(s.textControl()).TextColor(s.palette.Muted).Margin(0, 0, s.textControl(), 0)
	})
}

// drawProjectGrid draws the cards of the shown projects and the card that adds one, in as many columns of the least card width as width takes.
func (s *Shell) drawProjectGrid(c *ui.Context, width float32) {
	m := s.metrics
	shown := s.shownProjects()
	if len(shown) == 0 && len(s.projects) > 0 {
		ui.Text(s.binder.Name(c, "core.library.no-results", ""), "일치하는 프로젝트가 없습니다.").LineHeight(s.metrics.lineHeight).FontSize(s.textControl()).
			TextColor(s.palette.Muted).Margin(0, 0, 2*s.palette.Gap, 0)
	}
	least := m.libraryCardMinW
	if width+2*m.space3 < m.libraryNarrowW {
		least = m.libraryCardMinWNarrow
	}
	gap := 2 * s.palette.Gap
	columns := max(1, int((width+gap)/(least+gap)))
	cardWidth := (width - float32(columns-1)*gap) / float32(columns)
	previews := map[string][]previewPane{}
	errors := map[string]string{}
	count := len(shown) + 1
	ui.Column(c).FillWidth().Gap(gap).Children(func() {
		for start := 0; start < count; start += columns {
			ui.Row(c.Key(start)).FillWidth().Gap(gap).AlignItems(ui.Stretch).Children(func() {
				for index := start; index < min(start+columns, count); index++ {
					if index == len(shown) {
						s.drawLibraryAdd(c, cardWidth)
						continue
					}
					project := shown[index]
					panes, failure := s.drawProjectCard(c, &project, cardWidth)
					previews[project.ID] = panes
					if failure != "" {
						errors[project.ID] = failure
					}
				}
			})
		}
	})
	s.library.previews, s.library.previewErrors = previews, errors
}

func (s *Shell) drawLibraryAdd(c *ui.Context, width float32) {
	m := s.metrics
	const label = "＋ 프로젝트 만들기"
	button := s.binder.Press(c, "core.library.add", "core.library.form.open", "", map[string]string{"mode": "create"})
	color := s.palette.Muted
	if button.Hovered() {
		color = s.palette.Fg
		button.Background(faded(s.palette.Fg, m.chipHoverMix))
	}
	button.Width(width).MinHeight(m.libraryAddH).Padding(m.space3).Center().Radius(s.palette.Radius).BorderStyle(ui.BorderDashed).
		Border(s.palette.BorderWidth, s.palette.Edge).Label(label).Children(func() {
		ui.Text(c, label).LineHeight(s.metrics.lineHeight).FontSize(s.textControl()).TextColor(color)
	})
}

// drawProjectCard draws the card of project, and returns the panes of its preview and the reason its stored layout cannot be opened.
func (s *Shell) drawProjectCard(c *ui.Context, project *projectRecord, width float32) ([]previewPane, string) {
	m := s.metrics
	var panes []previewPane
	failure := ""
	_, folderFailed := s.library.folderErrors[project.Root]
	open := s.isOpen(project.ID)
	card := ui.Box(c.Key("library-" + project.ID)).Width(width).Radius(s.palette.Radius).Clip().Background(s.palette.Card)
	edge := s.palette.Edge
	switch {
	case card.Hovered() && !folderFailed:
		edge = s.palette.Focus
	case open:
		edge = s.palette.Rail
	}
	card.Border(s.palette.BorderWidth, edge).Children(func() {
		choose := s.binder.Press(c, "core.library.open", "core.library.open", project.ID, idParam{project.ID})
		choose.FillWidth().Column().Disabled(folderFailed).Label(project.Title + " 열기").Tooltip(project.Root).Children(func() {
			panes, failure = s.drawPreview(c, project, width-2*s.palette.BorderWidth)
			ui.Column(c).FillWidth().Padding(m.space2, m.space3, m.space2, m.space3).BorderWidth(s.palette.BorderWidth, 0, 0, 0).
				BorderColor(s.palette.Edge).Children(func() {
				ui.Text(c, project.Title).SingleLine().Ellipsis("…").LineHeight(s.metrics.lineHeight).FontSize(s.textControl()).TextColor(s.palette.Fg).Margin(0, 0, m.space1, 0)
				ui.Text(c, project.Root).SingleLine().Ellipsis("…").LineHeight(s.metrics.lineHeight).FontSize(s.textSmall()).TextColor(s.palette.Muted).Margin(0, 0, m.space2, 0)
				ui.Row(c).Gap(m.space2).Children(func() {
					size := s.textCaption()
					ui.Text(c, fmt.Sprintf("스페이스 %d", len(project.Spaces))).LineHeight(s.metrics.lineHeight).FontSize(size).TextColor(s.palette.Muted)
					if open {
						ui.Text(c, "열림").LineHeight(s.metrics.lineHeight).FontSize(size).TextColor(s.palette.Rail)
					}
					if project.LastOpened > 0 {
						when := time.UnixMilli(int64(project.LastOpened))
						ui.Text(c, fmt.Sprintf("%d월 %d일", when.Month(), when.Day())).LineHeight(s.metrics.lineHeight).FontSize(size).TextColor(s.palette.Muted).Tooltip(when.Format(time.DateTime))
					}
				})
				DrawError(c, s.errors, "library project "+project.Root)
			})
		})
		ui.Row(c).Absolute().Right(m.space2).Top(m.space2).Gap(m.space1).Children(func() {
			title := project.Title + " 라이브러리에서 제거"
			s.libraryAct(c, s.binder.Press(c, "core.library.remove", "core.library.remove", project.ID, idParam{project.ID}), "close", title, "라이브러리에서 제거", false)
			title = "프로젝트 고정"
			if project.Pinned {
				title = "고정 해제"
			}
			s.libraryAct(c, s.binder.Press(c, "core.library.pin", "core.library.pin", project.ID, map[string]any{"id": project.ID, "pinned": !project.Pinned}),
				"star", title, title, project.Pinned)
		})
	})
	return panes, failure
}

// libraryIcons are the stroke icons of a card, as packages/workbench/icons.js holds them.
var libraryIcons = map[string]string{
	"star":  `<path d="m12 3 2.8 5.7 6.3.9-4.6 4.4 1.1 6.3-5.6-3-5.6 3 1.1-6.3-4.6-4.4 6.3-.9Z"/>`,
	"close": `<path d="M18 6 6 18"/><path d="m6 6 12 12"/>`,
}

// libraryAct draws an icon button over a card, an .act with the card color behind it.
func (s *Shell) libraryAct(c *ui.Context, button ui.Element, icon, label, title string, on bool) {
	m := s.metrics
	color := s.palette.Muted
	button.Size(m.actW, m.actH).Center().Radius(s.radiusSmall()).Background(s.palette.Card).Label(label).Tooltip(title)
	if button.Hovered() {
		color = s.palette.Fg
	}
	if on {
		color = s.palette.Focus
	}
	paint := fmt.Sprintf(`fill="none" stroke="currentColor" stroke-width="%g"`, m.actStroke)
	button.Children(func() {
		ui.Icon(c, s.declaredIcon("0 0 24 24", paint, libraryIcons[icon])).Size(m.actIcon, m.actIcon).TextColor(color)
	})
}

// drawPreview draws the stored layout of the active space of project as a grid of panes. A column that holds only window sidebars is narrower, and a
// layout that cannot be opened by the check that opens it shows the reason.
func (s *Shell) drawPreview(c *ui.Context, project *projectRecord, width float32) ([]previewPane, string) {
	m := s.metrics
	margin := s.palette.Gap
	height := m.libraryPreviewH
	padX, padY := 2*m.space4, m.space4
	var panes []previewPane
	failure := ""
	frame := ui.Box(c).Size(width-2*margin, height).Margin(margin).Radius(s.radiusSmall()).Clip().Background(s.palette.Bg)
	frame.Children(func() {
		space, err := layout.SpaceIn(&project.Project, project.ActiveSpaceID)
		if err != nil {
			return
		}
		if err := layout.CheckStoredLayout(space.Layout, s.pluginUnits()); err != nil {
			failure = fmt.Sprintf("projects.json: project %s space %s: %s", project.Root, project.ActiveSpaceID, err)
			ui.Text(c, failure).Wrap().LineHeight(s.metrics.lineHeight).FontSize(s.textCaption()).TextColor(s.palette.No).Margin(padY, padX, padY, padX)
			return
		}
		var stored storedLayout
		if err := json.Unmarshal(space.Layout, &stored); err != nil {
			failure = err.Error()
			return
		}
		columns, rows := previewTracks(stored.State, width-2*margin-2*padX, height-2*padY, m.space2)
		for _, card := range stored.State.Cards {
			x, y := padX+columns[card.C0].at, padY+rows[card.R0].at
			w := columns[card.C1-1].at + columns[card.C1-1].size - columns[card.C0].at
			h := rows[card.R1-1].at + rows[card.R1-1].size - rows[card.R0].at
			pane := s.drawPreviewPane(c, card, x, y, w, h)
			bounds := pane.Bounds()
			panes = append(panes, previewPane{Card: card.ID, X: bounds.X, Y: bounds.Y, W: bounds.W, H: bounds.H})
		}
	})
	return panes, failure
}

// previewTrack is a column or a row of a preview.
type previewTrack struct{ at, size float32 }

// previewTracks shares length among the columns of state, where a column with only window sidebars takes less, and height among its rows.
func previewTracks(state layout.State, length, height, gap float32) (columns, rows []previewTrack) {
	const sidebarShare = .22
	shares := make([]float32, len(state.Xs)-1)
	total := float32(0)
	for column := range shares {
		shares[column] = sidebarShare
		for _, card := range state.Cards {
			if !isPlace(card.ID) && card.C0 <= column && column < card.C1 {
				shares[column] = 1
			}
		}
		total += shares[column]
	}
	room := length - gap*float32(len(shares)-1)
	at := float32(0)
	for _, share := range shares {
		size := room * share / total
		columns = append(columns, previewTrack{at, size})
		at += size + gap
	}
	count := len(state.Ys) - 1
	size := (height - gap*float32(count-1)) / float32(count)
	for row := range count {
		rows = append(rows, previewTrack{float32(row) * (size + gap), size})
	}
	return columns, rows
}

// drawPreviewPane draws a pane: the mark of the plugin of its active tab and two lines, or a line for a window sidebar. A tab of a plugin that is not
// loaded has no mark.
func (s *Shell) drawPreviewPane(c *ui.Context, card layout.Card, x, y, w, h float32) ui.Element {
	m := s.metrics
	ink := s.palette.Muted
	var mark *ui.SVG
	aside := isPlace(card.ID)
	if !aside {
		if data, err := layout.DecodeCardData(card.Data); err == nil {
			if active := data.ActiveTab(); active != nil {
				if unit := s.loadedPlugin(active.Plugin); unit != nil {
					ink = s.inkColor(unit.Ink)
					paint := fmt.Sprintf(`fill="none" stroke="currentColor" stroke-width="%g"`, m.libraryMarkStroke)
					mark = s.declaredIcon("0 0 16 16", paint, unit.Icon)
				}
			}
		}
	}
	padding := m.space2
	if aside {
		padding = m.space1
	}
	color := mixed(ink, s.palette.Card, m.previewInkMix)
	pane := ui.Column(c.Key(card.ID)).Absolute().Left(x).Top(y).Size(w, h).Clip().Padding(padding).Radius(s.radiusSmall()).
		Border(s.palette.BorderWidth, mixed(ink, s.palette.Card, m.previewBorderMix)).Background(mixed(ink, s.palette.Card, m.previewFillMix))
	pane.Children(func() {
		if aside {
			ui.Box(c).FillWidth().Height(m.space1).Margin(m.space1, 0, 0, 0).Radius(s.radiusSmall()).Background(faded(color, m.previewSidebarOpacity))
		}
		if mark != nil {
			ui.Icon(c, mark).Size(m.libraryMark, m.libraryMark).TextColor(color)
		}
		line := func(top float32) {
			ui.Box(c).Width((w-2*padding)*m.previewLineW).Height(m.previewLineH).Margin(top, 0, 0, 0).Radius(s.radiusSmall()).Background(faded(color, m.previewLineOpacity))
		}
		line(m.space2)
		line(m.previewLineStep - m.previewLineH)
	})
	return pane
}

// inkColor is the color of a theme token that a plugin names for its preview, and the muted color for the absent token.
func (s *Shell) inkColor(token string) ui.Color {
	switch token {
	case "--fg":
		return s.palette.Fg
	case "--rail":
		return s.palette.Rail
	case "--focus":
		return s.palette.Focus
	case "--no":
		return s.palette.No
	}
	return s.palette.Muted
}

// mixed is a color with share of color and the rest of base, as color-mix in srgb.
func mixed(color, base ui.Color, share float32) ui.Color {
	blend := func(a, b uint8) uint8 {
		return uint8(math.Round(float64(a)*float64(share) + float64(b)*float64(1-share)))
	}
	return ui.Color{R: blend(color.R, base.R), G: blend(color.G, base.G), B: blend(color.B, base.B), A: blend(color.A, base.A)}
}

// pluginUnits is the plugins of the window as the check of a stored layout reads them.
func (s *Shell) pluginUnits() []layout.PluginUnit {
	units := make([]layout.PluginUnit, 0, len(s.plugins))
	for _, plugin := range s.plugins {
		units = append(units, layout.PluginUnit{ID: plugin.ID, Surface: plugin.Surface})
	}
	return units
}

// drawLibraryFooter draws the count of the projects, the way back to the work screen and the new window.
func (s *Shell) drawLibraryFooter(c *ui.Context, width float32) {
	m := s.metrics
	size := s.textCaption()
	text := func(button ui.Element, label string) {
		button.PaddingX(m.space1).Label(label).Children(func() {
			ui.Text(c, label).SingleLine().LineHeight(s.metrics.lineHeight).FontSize(size).TextColor(s.palette.Muted)
		})
	}
	ui.Row(c).Size(width, m.libraryFooterH).PaddingX(m.space3).Gap(m.space3).AlignItems(ui.Center).Background(s.palette.Card).
		BorderWidth(s.palette.BorderWidth, 0, 0, 0).BorderColor(s.palette.Edge).Children(func() {
		ui.Text(c, fmt.Sprintf("프로젝트 %d · 열림 %d", len(s.projects), s.openCount())).SingleLine().LineHeight(s.metrics.lineHeight).FontSize(size).TextColor(s.palette.Muted)
		if s.opened() != nil {
			text(s.binder.Press(c, "core.library.return", "core.library.return", "", nil), "작업 화면으로 돌아가기")
		}
		ui.Spacer(c).Grow(1)
		text(s.binder.Press(c, "core.library.window", "core.library.window", "", nil), "＋ 새 창")
	})
}

// pluginLook is the theme and the lengths of the plugin page at width.
func (s *Shell) pluginLook(width float32) PluginLook {
	m, p := s.metrics, s.palette
	least := m.libraryCardMinW
	if width+2*m.space3 < m.libraryNarrowW {
		least = m.libraryCardMinWNarrow
	}
	return PluginLook{Bg: p.Bg, Card: p.Card, Fg: p.Fg, Muted: p.Muted, Edge: p.Edge, Rail: p.Rail, No: p.No, Control: s.textControl(), Small: s.textSmall(),
		Caption: s.textCaption(), LineHeight: m.lineHeight, Radius: p.Radius, RadiusSmall: s.radiusSmall(), BorderWidth: p.BorderWidth, Gap: p.Gap, Space1: m.space1,
		Space2: m.space2, Space3: m.space3, FieldPadY: m.fieldPadY, Width: width, LeastCard: least}
}

// uiButton gives a pressable element the look of .ui-button, and of .library-primary with primary.
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

// drawLibraryForm draws the form of a new project.
func (s *Shell) drawLibraryForm(c *ui.Context) {
	m := s.metrics
	creates := s.library.formMode == "create"
	heading := "기존 폴더로 프로젝트 만들기"
	newMark, existingMark := "○", "●"
	if creates {
		heading, newMark, existingMark = "새 폴더로 프로젝트 만들기", "●", "○"
	}
	ui.Column(c).FillWidth().MaxWidth(m.libraryFormW).Padding(m.space4).Margin(0, 0, m.space3, 0).Radius(s.radiusSmall()).
		Border(s.palette.BorderWidth, s.palette.Edge).Background(s.palette.Card).Children(func() {
		ui.Text(c, heading).Bold().LineHeight(m.lineHeight).FontSize(s.textControl()).TextColor(s.palette.Fg).Margin(0, 0, m.space3, 0)
		ui.Row(c).Children(func() {
			s.uiButton(c, s.binder.Press(c, "core.library.form.mode-new", "core.library.form.open", "", map[string]string{"mode": "create"}), newMark+" 새 폴더 만들기", false)
			s.uiButton(c, s.binder.Press(c, "core.library.form.mode-existing", "core.library.form.open", "", map[string]string{"mode": "open"}), existingMark+" 기존 폴더 선택", false)
		})
		ui.Column(c).FillWidth().Gap(m.space3).Children(func() {
			label := "폴더 경로"
			if creates {
				s.drawFormField(c, "core.library.form.name", "name", &s.library.name, "프로젝트 폴더 이름", "my-project", true, nil)
				label = "생성 위치"
			}
			s.drawFormField(c, "core.library.form.parent", "parent", &s.library.parent, label, "/Users/…", !creates, func() {
				s.uiButton(c, s.binder.Press(c, "core.library.form.choose", "core.library.choose-folder", "", nil).AlignSelf(ui.Start), "폴더 선택", false)
			})
			ui.Row(c).FillWidth().Gap(m.space2).Justify(ui.End).Children(func() {
				s.uiButton(c, s.binder.Press(c, "core.library.form.cancel", "core.library.form.cancel", "", nil), "취소", false)
				submit := "프로젝트로 열기"
				if creates {
					submit = "생성 후 열기"
				}
				s.uiButton(c, s.binder.Press(c, "core.library.form.submit", "core.library.form.submit", "", nil), submit, true)
			})
		})
	})
}

// drawFormField draws a field of the form with its title over it and after under it. Enter submits the form, and the first field takes the focus as
// the form opens.
func (s *Shell) drawFormField(c *ui.Context, name, field string, value *string, title, placeholder string, first bool, after func()) {
	m := s.metrics
	ui.Column(c).FillWidth().Gap(m.space2).Children(func() {
		ui.Text(c, title).LineHeight(s.metrics.lineHeight).FontSize(s.textControl()).TextColor(s.palette.Muted)
		set := s.binder.Control(c, name, "core.library.form.set", field)
		input := s.drawnTextField(s.binder.Bound(ui.TextInputBase(c, value), name)).FillWidth().Label(title).Placeholder(placeholder)
		if first {
			input.AutoFocus()
		}
		if input.Changed() {
			set(libraryField{Field: field, Value: *value})
		}
		if input.Submitted() {
			s.binder.run("core.library.form.submit", nil)
		}
		if after != nil {
			after()
		}
	})
}
