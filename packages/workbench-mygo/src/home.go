package workbench

import (
	"cmp"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
)

// The project home (docs/spec/projects.md#project-home): the launcher of the saved projects. The home shows the rows of the projects,
// the search, the two form buttons and the confirm state of a removal. Its state is the homeState of the window.

// homeState is the state of the project home of a window.
type homeState struct {
	query string
	// selected is the project id of the row that Enter opens, and confirm the project id of the row in the removal confirm state.
	selected, confirm string
	formMode          string // create, open, or "" while the form is closed.
	name, parent      string
	// folderErrors holds the reason of each project folder that cannot be read, checks the latest check of each root, and foldersFor the
	// roots that were last checked.
	folderErrors map[string]string
	checks       map[string]int
	checkCount   int
	foldersFor   string
}

func newHomeState() homeState {
	return homeState{folderErrors: map[string]string{}, checks: map[string]int{}}
}

// inHome tells whether the project home is shown.
func (s *Shell) inHome() bool { return s.plane == nil || s.browsing }

// checkFolders asks the host whether the folder of each project can be read, when the list of the projects changed. Only the answer of the
// latest check of a root replaces what the row shows.
func (s *Shell) checkFolders() {
	roots := make([]string, len(s.projects))
	for i, project := range s.projects {
		roots[i] = project.Root
	}
	list := strings.Join(roots, "\n")
	if s.home.foldersFor == list {
		return
	}
	s.home.foldersFor = list
	for root := range s.home.checks {
		if !slices.Contains(roots, root) {
			delete(s.home.checks, root)
			delete(s.home.folderErrors, root)
			s.errors.Hide("home project " + root)
		}
	}
	for _, root := range roots {
		s.home.checkCount++
		check := s.home.checkCount
		s.home.checks[root] = check
		s.calls.Call("projectFolder", root, func(_ any, err error) {
			if s.home.checks[root] != check {
				return
			}
			if err != nil {
				s.home.folderErrors[root] = err.Error()
				s.errors.Show("home project "+root, folderReason(err.Error()), "")
			} else {
				delete(s.home.folderErrors, root)
				s.errors.Hide("home project " + root)
			}
			s.options.Invalidate()
		})
	}
}

// folderReasons are the folder errors of the host (workspace.folder.messages) and the reason that a row shows.
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

// homeRows returns the projects of the rows of the home: the pinned projects first, then the others, each group by its last-opened
// time, newest first. The search matches a project by its name and its path (docs/spec/projects.md#project-home).
func (s *Shell) homeRows() []projectRecord {
	query := strings.ToLower(strings.TrimSpace(s.home.query))
	var pinned, others []projectRecord
	for _, project := range s.projects {
		if query != "" && !strings.Contains(strings.ToLower(project.Title+" "+project.Root), query) {
			continue
		}
		if project.Pinned {
			pinned = append(pinned, project)
		} else {
			others = append(others, project)
		}
	}
	newest := func(a, b projectRecord) int { return cmp.Compare(b.LastOpened, a.LastOpened) }
	slices.SortStableFunc(pinned, newest)
	slices.SortStableFunc(others, newest)
	return append(pinned, others...)
}

// selectedRow returns the id of the row that Enter opens: the selected row when it is shown, else the first row, and "" for no row.
func (s *Shell) selectedRow(rows []projectRecord) string {
	for _, row := range rows {
		if row.ID == s.home.selected {
			return row.ID
		}
	}
	if len(rows) == 0 {
		return ""
	}
	return rows[0].ID
}

// homeStatus is the value of core.home.
type homeStatus struct {
	Query         string            `json:"query"`
	Selected      *string           `json:"selected"`
	Rows          []string          `json:"rows"`
	PreviewErrors map[string]string `json:"previewErrors"`
	FolderErrors  map[string]string `json:"folderErrors"`
}

// homeStatusValue reads the value of core.home: the rows in the order shown, the selected row, and the reasons of the rows whose folder or
// stored layout cannot be read.
func (s *Shell) homeStatusValue() homeStatus {
	rows := s.homeRows()
	status := homeStatus{Query: s.home.query, Rows: make([]string, 0, len(rows)), PreviewErrors: map[string]string{}, FolderErrors: map[string]string{}}
	for _, row := range rows {
		status.Rows = append(status.Rows, row.ID)
		if reason, failed := s.home.folderErrors[row.Root]; failed {
			status.FolderErrors[row.ID] = reason
		}
		if failure := s.storedLayoutFailure(&row); failure != "" {
			status.PreviewErrors[row.ID] = failure
		}
	}
	if id := s.selectedRow(rows); id != "" {
		status.Selected = &id
	}
	return status
}

type homeField struct {
	Field string `json:"field"`
	Value string `json:"value"`
}

// selectParam is the parameter of core.home.select: the step of the selection, −1 for the row above and 1 for the row below.
type selectParam struct {
	Step int `json:"step"`
}

// projectParam is the parameter of the commands that act on one project; an empty project is the selected row of core.home.open.
type projectParam struct {
	Project string `json:"project"`
}

// confirmParam is the parameter of core.home.confirm: ask puts the row into the confirm state, no leaves it, and yes removes the project.
type confirmParam struct {
	Project string `json:"project"`
	Answer  string `json:"answer"`
}

// registerHome adds the statuses and the commands of the project home.
func (s *Shell) registerHome() {
	s.registry.Status("core.home", func() any { return s.homeStatusValue() })
	// core.folder.create creates a folder in the parent of a new project; the form of the home calls it through projectCreate.
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
	act(s, "core.home.show", func(struct{}) error { return s.browse() })
	// The button back of the status line restores the work screen of the window (docs/spec/projects.md#project-home).
	act(s, "core.home.back", func(struct{}) error {
		project := s.returnable()
		if project == nil {
			return errors.New("there is no work screen to return to")
		}
		s.activate(project.ID)
		return nil
	})
	act(s, "core.home.search", func(value struct {
		Query string `json:"query"`
	}) error {
		// A query that the home already holds changes nothing, so the command asks for no frame.
		if value.Query == s.home.query {
			return nil
		}
		s.home.query = value.Query
		s.home.selected = ""
		s.options.Invalidate()
		return nil
	})
	act(s, "core.home.search.focus", func(struct{}) error {
		if !s.inHome() {
			return fmt.Errorf("the project home is not shown")
		}
		return s.exposedFocus.Set("core.home.search", 0)
	})
	act(s, "core.home.select", func(value selectParam) error {
		if value.Step != -1 && value.Step != 1 {
			return fmt.Errorf("the selection step is %d, not -1 or 1", value.Step)
		}
		rows := s.homeRows()
		if len(rows) == 0 {
			return nil
		}
		at := 0
		for i, row := range rows {
			if row.ID == s.selectedRow(rows) {
				at = i
			}
		}
		s.home.selected = rows[(at+value.Step+len(rows))%len(rows)].ID
		s.options.Invalidate()
		return nil
	})
	// The opening reads the geometry store before it shows the project, so the command answers when the project is shown.
	later(s, "core.home.open", func(value projectParam, answer func(any, error)) {
		id := value.Project
		if id == "" {
			id = s.selectedRow(s.homeRows())
		}
		if id == "" {
			answer(nil, fmt.Errorf("no project row is selected"))
			return
		}
		s.performHome(func(done func(error)) { s.activateThen(id, done) }, func() { answer(nil, nil) })
	})
	later(s, "core.home.pin", func(value projectParam, answer func(any, error)) {
		project, ok := s.projectByID(value.Project)
		if !ok {
			answer(nil, fmt.Errorf("the project %s is not in the project home", value.Project))
			return
		}
		s.performHome(func(done func(error)) { s.pinProject(project.ID, !project.Pinned, done) }, func() { answer(nil, nil) })
	})
	act(s, "core.home.confirm", func(value confirmParam) error {
		// An empty project is the selected row, as core.home.open takes it (docs/spec/projects.md#project-home).
		if value.Project == "" {
			value.Project = s.selectedRow(s.homeRows())
		}
		if value.Project == "" {
			return fmt.Errorf("no project row is selected")
		}
		if _, ok := s.projectByID(value.Project); !ok {
			return fmt.Errorf("the project %s is not in the project home", value.Project)
		}
		switch value.Answer {
		case "ask":
			s.home.confirm = value.Project
		case "no":
			s.home.confirm = ""
		case "yes":
			s.home.confirm = ""
			s.options.Invalidate()
			s.removeHomeProject(value.Project, func() {})
			return nil
		default:
			return fmt.Errorf("the confirm answer %s is not ask, no or yes", value.Answer)
		}
		s.options.Invalidate()
		return nil
	})
	later(s, "core.home.remove", func(value projectParam, answer func(any, error)) {
		s.removeHomeProject(value.Project, func() { answer(nil, nil) })
	})
	act(s, "core.home.form.open", func(value struct {
		Mode string `json:"mode"`
	}) error {
		if value.Mode != "create" && value.Mode != "open" {
			return fmt.Errorf("unknown form mode %s", value.Mode)
		}
		s.home.formMode = value.Mode
		s.options.Invalidate()
		return nil
	})
	act(s, "core.home.form.cancel", func(struct{}) error {
		if s.home.formMode == "" {
			return fmt.Errorf("the form is not open")
		}
		s.home.formMode = ""
		s.options.Invalidate()
		return nil
	})
	act(s, "core.home.form.set", func(value homeField) error {
		switch value.Field {
		case "name":
			s.home.name = value.Value
		case "parent":
			s.home.parent = value.Value
		default:
			return fmt.Errorf("the form has no %s field", value.Field)
		}
		s.options.Invalidate()
		return nil
	})
	act(s, "core.home.form.submit", func(struct{}) error { return s.submitForm() })
	act(s, "core.home.choose-folder", func(struct{}) error {
		s.performHome(func(done func(error)) {
			s.calls.Call("folderChoose", nil, func(value any, err error) {
				if err != nil {
					done(err)
					return
				}
				if chosen, err := decode[string](value); err == nil && chosen != "" {
					s.home.parent = chosen
					s.options.Invalidate()
				}
				done(nil)
			})
		}, func() {})
		return nil
	})
}

// projectByID returns the saved project with id.
func (s *Shell) projectByID(id string) (projectRecord, bool) {
	for _, project := range s.projects {
		if project.ID == id {
			return project, true
		}
	}
	return projectRecord{}, false
}

// removeHomeProject removes the record and the spaces of a project and leaves its folder, then runs ended.
func (s *Shell) removeHomeProject(id string, ended func()) {
	s.home.confirm = ""
	s.performHome(func(done func(error)) {
		s.removeProjectThen(id, func(_ bool, err error) { done(err) })
	}, ended)
}

// performHome runs an action, withdraws its previous error, presents a failure as a toast, and then runs ended.
// It requests a frame when the error changes.
func (s *Shell) performHome(action func(done func(error)), ended func()) {
	if _, shown := s.errors.Text(homeErrorPlace); shown {
		s.errors.Hide(homeErrorPlace)
		s.options.Invalidate()
	}
	action(func(err error) {
		if err != nil {
			s.errors.ShowToast(homeErrorPlace, err.Error(), "")
			s.options.Invalidate()
		}
		ended()
	})
}

// submitForm opens the folder of the form: a new folder in create mode, an existing folder otherwise.
func (s *Shell) submitForm() error {
	if s.home.formMode == "" {
		return fmt.Errorf("the form is not open")
	}
	s.performHome(func(done func(error)) {
		opened := func(value any, err error) {
			if err != nil {
				done(err)
				return
			}
			folder, err := decode[ProjectFolderValue](value)
			if err != nil {
				done(err)
				return
			}
			s.home.formMode, s.home.name, s.home.parent = "", "", ""
			s.openFolder(folder, s.freeTint(), func(_ json.RawMessage, err error) { done(err) })
		}
		if s.home.formMode == "create" {
			s.calls.Call("projectCreate", map[string]string{"parent": s.home.parent, "name": s.home.name}, opened)
			return
		}
		s.calls.Call("projectFolder", s.home.parent, opened)
	}, func() {})
	return nil
}
