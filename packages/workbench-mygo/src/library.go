package workbench

import (
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"

	"github.com/egoist/mygo/ui"
)

// The library: the screen of the saved projects and the form that adds one, as packages/workbench/library.js draws them. The plugin
// page belongs to the plugin screen.

// libraryState is the state of the library of a window.
type libraryState struct {
	page, query, order string
	pluginQuery        string
	// revealUpdates brings the update list into view in the next frame of the plugin page.
	revealUpdates bool
	formMode      string // create, open, or "" while the form is closed.
	name, parent  string
}

func newLibraryState() libraryState { return libraryState{page: "projects", order: "saved"} }

// shownProjects returns the projects of the search in the order of the library.
func (s *Shell) shownProjects() []projectRecord {
	shown := make([]projectRecord, 0, len(s.projects))
	query := strings.ToLower(s.library.query)
	for _, project := range s.projects {
		if strings.Contains(strings.ToLower(project.Title), query) || strings.Contains(strings.ToLower(project.Root), query) {
			shown = append(shown, project)
		}
	}
	switch s.library.order {
	case "name":
		slices.SortStableFunc(shown, func(a, b projectRecord) int { return strings.Compare(a.Title, b.Title) })
	case "recent":
		slices.SortStableFunc(shown, func(a, b projectRecord) int { return int(b.LastOpened - a.LastOpened) })
	}
	slices.SortStableFunc(shown, func(a, b projectRecord) int {
		switch {
		case a.Pinned == b.Pinned:
			return 0
		case a.Pinned:
			return -1
		}
		return 1
	})
	return shown
}

type libraryField struct {
	Field string `json:"field"`
	Value string `json:"value"`
}

// registerLibrary adds the commands of the library.
func (s *Shell) registerLibrary() {
	act(s, "core.library.page", func(value struct {
		Page string `json:"page"`
	}) error {
		return s.showLibraryPage(value.Page)
	})
	act(s, "core.library.search", func(value struct {
		Query string `json:"query"`
	}) error {
		s.library.query = value.Query
		s.options.Invalidate()
		return nil
	})
	act(s, "core.library.search.focus", func(struct{}) error {
		if !s.libraryShown() {
			return errors.New("the library is not shown")
		}
		switch s.library.page {
		case "projects":
			return s.keyboard.Set("core.library.search", 0)
		case pluginsPage:
			return s.keyboard.Set("core.library.plugins.search", 0)
		}
		return fmt.Errorf("unknown library page %q", s.library.page)
	})
	later(s, "core.folder.create", func(value struct {
		Parent string `json:"parent"`
		Name   string `json:"name"`
	}, answer func(any, error)) {
		s.calls.Call("projectCreate", map[string]string{"parent": value.Parent, "name": value.Name}, func(got any, err error) {
			if err != nil {
				answer(nil, err)
				return
			}
			folder, err := decode[ProjectFolderValue](got)
			if err != nil {
				answer(nil, err)
				return
			}
			answer(folder, nil)
		})
	})
	act(s, "core.library.sort", func(value struct {
		Order string `json:"order"`
	}) error {
		s.library.order = value.Order
		s.options.Invalidate()
		return nil
	})
	act(s, "core.library.open", func(value idParam) error { s.activate(value.ID); return nil })
	later(s, "core.library.pin", func(value pinParam, answer func(any, error)) {
		s.pinProject(value.ID, value.Pinned, answerNull(answer))
	})
	act(s, "core.library.remove", func(value idParam) error { s.removeProject(value.ID); return nil })
	act(s, "core.library.return", func(struct{}) error {
		if s.opened() == nil {
			return fmt.Errorf("there is no workspace to return to")
		}
		s.browsing = false
		s.options.Invalidate()
		return nil
	})
	newWindow := func(struct{}) error {
		cids := s.events.BeginOperation("workbench.window.operation", map[string]any{"action": "new"})
		s.calls.Caused(cids).Call("windowNew", nil, func(_ any, err error) {
			if err != nil {
				s.fail(err)
			}
		})
		return nil
	}
	act(s, "core.library.window", newWindow)
	act(s, "core.window.new", newWindow)
	act(s, "core.library.form.open", func(value struct {
		Mode string `json:"mode"`
	}) error {
		if value.Mode != "create" && value.Mode != "open" {
			return fmt.Errorf("unknown form mode %s", value.Mode)
		}
		s.library.formMode = value.Mode
		s.options.Invalidate()
		return nil
	})
	act(s, "core.library.form.cancel", func(struct{}) error {
		if s.library.formMode == "" {
			return fmt.Errorf("the form is not open")
		}
		s.library.formMode = ""
		s.options.Invalidate()
		return nil
	})
	act(s, "core.library.form.set", func(value libraryField) error {
		switch value.Field {
		case "name":
			s.library.name = value.Value
		case "parent":
			s.library.parent = value.Value
		default:
			return fmt.Errorf("the form has no %s field", value.Field)
		}
		s.options.Invalidate()
		return nil
	})
	act(s, "core.library.form.submit", func(struct{}) error { return s.submitForm() })
	act(s, "core.library.choose-folder", func(struct{}) error {
		s.calls.Call("folderChoose", nil, func(value any, err error) {
			if err != nil {
				s.fail(err)
				return
			}
			if chosen, err := decode[string](value); err == nil && chosen != "" {
				s.library.parent = chosen
				s.options.Invalidate()
			}
		})
		return nil
	})
}

// submitForm opens the folder of the form: a new folder in create mode, an existing folder otherwise.
func (s *Shell) submitForm() error {
	if s.library.formMode == "" {
		return fmt.Errorf("the form is not open")
	}
	opened := func(value any, err error) {
		if err != nil {
			s.fail(err)
			return
		}
		folder, err := decode[ProjectFolderValue](value)
		if err != nil {
			s.fail(err)
			return
		}
		s.library.formMode, s.library.name, s.library.parent = "", "", ""
		s.openFolder(folder, s.freeTint(), func(_ json.RawMessage, err error) {
			if err != nil {
				s.fail(err)
			}
		})
	}
	if s.library.formMode == "create" {
		s.calls.Call("projectCreate", map[string]string{"parent": s.library.parent, "name": s.library.name}, opened)
		return nil
	}
	s.calls.Call("projectFolder", s.library.parent, opened)
	return nil
}

// libraryShown tells whether the window shows the library.
func (s *Shell) libraryShown() bool { return s.browsing || s.opened() == nil }

// drawLibrarySearch draws the search field of the projects, which filters the list as it is typed.
func (s *Shell) drawLibrarySearch(c *ui.Context) {
	const name = "core.library.search"
	search := s.binder.Control(c, name, name, "")
	query := s.library.query
	s.binder.Focusable(ui.TextInput(c, &query).Label("프로젝트 검색").Placeholder("이름 또는 폴더 검색").Width(s.frameLength(s.metrics.librarySearchW)), name)
	if query != s.library.query {
		search(map[string]string{"query": query})
	}
}

// drawLibrary draws the library screen.
func (s *Shell) drawLibrary(c *ui.Context, width, height float32) {
	ui.Column(c).Size(width, height).Padding(s.chromeHeight()).Gap(s.metrics.tabsPad * 3).Children(func() {
		ui.Row(c).AlignItems(ui.Center).Gap(s.metrics.tabsGap).Children(func() {
			for _, page := range []struct{ id, label string }{{"projects", "프로젝트"}, {"plugins", "플러그인"}} {
				s.barText(c, s.binder.Press(c, "core.library.page", "core.library.page", page.id, map[string]string{"page": page.id}), page.label,
					s.library.page == page.id)
			}
			ui.Spacer(c).Grow(1)
			if s.library.page != pluginsPage {
				s.drawLibrarySearch(c)
			}
			s.barText(c, s.binder.Press(c, "core.library.add", "core.library.form.open", "", map[string]string{"mode": "create"}), "＋ 프로젝트 만들기", false)
		})
		DrawErrorBanner(c, s.errors)
		if s.library.page == pluginsPage {
			ui.Box(c).FillWidth().Grow(1).Children(func() { s.drawPlugins(c) })
		} else {
			if s.library.formMode != "" {
				s.drawLibraryForm(c)
			}
			s.drawProjectList(c)
		}
		if s.opened() != nil {
			s.barText(c, s.binder.Press(c, "core.library.return", "core.library.return", "", nil), "돌아가기", false)
		}
	})
}

func (s *Shell) drawProjectList(c *ui.Context) {
	if len(s.projects) == 0 {
		ui.Column(s.binder.Name(c, "core.library.empty", "")).Role(ui.RoleGroup).Label("빈 라이브러리").FillWidth().AlignItems(ui.Center).PaddingY(s.metrics.space4).Gap(s.metrics.tabsGap).Children(func() {
			ui.Text(c, "프로젝트를 시작하세요").FontWeight(600)
			ui.Text(c, "새 프로젝트를 만들거나 기존 폴더를 여세요.").TextColor(s.palette.Muted)
		})
		return
	}
	shown := s.shownProjects()
	if len(shown) == 0 {
		ui.Text(s.binder.Name(c, "core.library.no-results", ""), "일치하는 프로젝트가 없습니다.").TextColor(s.palette.Muted)
		return
	}
	ui.Scroll(c).FillWidth().Grow(1).Children(func() {
		ui.Column(c).FillWidth().Gap(s.metrics.tabsGap).Children(func() {
			for _, project := range shown {
				ui.Row(c.Key("library-" + project.ID)).FillWidth().Gap(s.metrics.tabsGap).AlignItems(ui.Center).Children(func() {
					open := s.binder.Press(c, "core.library.open", "core.library.open", project.ID, idParam{project.ID})
					open.Grow(1).Padding(s.metrics.tabsPad * 2).Radius(s.palette.Radius).Background(s.palette.Card).Label(project.Title).Children(func() {
						ui.Column(c).Children(func() {
							ui.Text(c, project.Title).Bold().TextColor(ui.Hex(project.Color))
							ui.Text(c, project.Root).FontSize(11).TextColor(s.palette.Muted)
						})
					})
					pin := "고정"
					if project.Pinned {
						pin = "고정 해제"
					}
					s.barText(c, s.binder.Press(c, "core.library.pin", "core.library.pin", project.ID,
						map[string]any{"id": project.ID, "pinned": !project.Pinned}), pin, false)
					s.barText(c, s.binder.Press(c, "core.library.remove", "core.library.remove", project.ID, idParam{project.ID}), "제거", false)
				})
			}
		})
	})
}

func (s *Shell) drawLibraryForm(c *ui.Context) {
	creates := s.library.formMode == "create"
	ui.Column(c).FillWidth().Gap(s.metrics.tabsGap).Padding(s.metrics.tabsPad * 2).Radius(s.palette.Radius).Background(s.palette.Card).Children(func() {
		ui.Row(c).Gap(s.metrics.tabsGap).Children(func() {
			s.barText(c, s.binder.Press(c, "core.library.form.mode-new", "core.library.form.open", "", map[string]string{"mode": "create"}), "새 폴더", creates)
			s.barText(c, s.binder.Press(c, "core.library.form.mode-existing", "core.library.form.open", "", map[string]string{"mode": "open"}), "기존 폴더", !creates)
		})
		if creates {
			s.drawFormField(c, "core.library.form.name", "name", &s.library.name, "프로젝트 폴더 이름")
		}
		label := "폴더 경로"
		if creates {
			label = "생성 위치"
		}
		s.drawFormField(c, "core.library.form.parent", "parent", &s.library.parent, label)
		ui.Row(c).Gap(s.metrics.tabsGap).Children(func() {
			s.barText(c, s.binder.Press(c, "core.library.form.choose", "core.library.choose-folder", "", nil), "폴더 선택", false)
			ui.Spacer(c).Grow(1)
			s.barText(c, s.binder.Press(c, "core.library.form.cancel", "core.library.form.cancel", "", nil), "취소", false)
			submit := "프로젝트로 열기"
			if creates {
				submit = "생성 후 열기"
			}
			s.barText(c, s.binder.Press(c, "core.library.form.submit", "core.library.form.submit", "", nil), submit, true)
		})
	})
}

func (s *Shell) drawFormField(c *ui.Context, name, field string, value *string, label string) {
	set := s.binder.Control(c, name, "core.library.form.set", field)
	before := *value
	ui.TextInput(c, value).FillWidth().Label(label).Placeholder(label)
	if *value != before {
		set(libraryField{Field: field, Value: *value})
	}
}
