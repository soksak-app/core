package workbench

import (
	"encoding/json"
	"fmt"
	"slices"

	"github.com/egoist/mygo/ui"
)

// The plugin screen in a window: the commands and statuses of the plugin operations and the events of the host that change them.

const pluginsPage = "plugins"

type pluginParam struct {
	Plugin string `json:"plugin"`
}

// libraryPlugins is `plugins` of `core.library`.
type libraryPlugins struct {
	Query   string         `json:"query"`
	Shown   []string       `json:"shown"`
	Actions []PluginAction `json:"actions"`
}

// libraryForm is `formState` of `core.library`.
type libraryForm struct {
	Mode   string  `json:"mode"`
	Name   *string `json:"name"`
	Parent *string `json:"parent"`
}

// libraryStatus is the value of `core.library`.
type libraryStatus struct {
	Page          string            `json:"page"`
	Plugins       libraryPlugins    `json:"plugins"`
	Shown         []string          `json:"shown"`
	Pinned        []string          `json:"pinned"`
	Count         string            `json:"count"`
	Query         string            `json:"query"`
	Sort          string            `json:"sort"`
	Form          bool              `json:"form"`
	FormState     *libraryForm      `json:"formState"`
	ReturnVisible bool              `json:"returnVisible"`
	Pending       bool              `json:"pending"`
	Empty         bool              `json:"empty"`
	NoResults     bool              `json:"noResults"`
	Error         *string           `json:"error"`
	Previews      map[string]any    `json:"previews"`
	PreviewErrors map[string]string `json:"previewErrors"`
	FolderErrors  map[string]string `json:"folderErrors"`
}

// pluginPage returns what the plugin page draws.
func (s *Shell) pluginPage() PluginPage {
	status := s.pluginOperations.Status()
	page := PluginPage{Hosted: true, Core: status.Core, Query: s.library.pluginQuery, Failure: s.pluginOperations.Failure(), Plugins: status.Plugins,
		Operation: status.Operation, Updates: status.Updates, Outdated: status.Outdated, App: s.appUpdates.Status()}
	for _, entry := range s.contributions.Status() {
		contribution := PluginContribution{Plugin: entry.Plugin, Point: entry.Point, Index: entry.Index, State: entry.State}
		if entry.Reason != nil {
			contribution.Reason = *entry.Reason
		}
		page.Contributions = append(page.Contributions, contribution)
	}
	return page
}

// drawPlugins draws the plugin page, which brings the update list into view once after core.plugins.show-updates.
func (s *Shell) drawPlugins(c *ui.Context) {
	page := s.pluginPage()
	page.Reveal, s.library.revealUpdates = s.library.revealUpdates, false
	DrawPluginPage(c, s.binder, page, s.errors)
}

func (s *Shell) libraryStatus() libraryStatus {
	page := s.pluginPage()
	shown, pinned := []string{}, []string{}
	for _, project := range s.shownProjects() {
		shown = append(shown, project.ID)
		if project.Pinned {
			pinned = append(pinned, project.ID)
		}
	}
	status := libraryStatus{Page: s.library.page, Plugins: libraryPlugins{Query: page.Query, Shown: ShownPlugins(page), Actions: PluginPageActions(page)},
		Shown: shown, Pinned: pinned, Count: fmt.Sprintf("프로젝트 %d · 열림 %d", len(s.projects), s.openCount()), Query: s.library.query, Sort: s.library.order,
		Form: s.library.formMode != "", ReturnVisible: s.opened() != nil, Empty: len(s.projects) == 0 && s.library.formMode == "",
		NoResults: len(s.projects) > 0 && len(shown) == 0, Previews: map[string]any{}, PreviewErrors: map[string]string{}, FolderErrors: map[string]string{}}
	if text, ok := s.errors.Text(workbenchErrorPlace); ok {
		status.Error = &text
	}
	if status.Form {
		parent := s.library.parent
		status.FormState = &libraryForm{Mode: s.library.formMode, Parent: &parent}
		if s.library.formMode == "create" {
			name := s.library.name
			status.FormState.Name = &name
		}
	}
	return status
}

func (s *Shell) openCount() int {
	if s.opened() != nil {
		return 1
	}
	return 0
}

// showLibraryPage shows a page of the library. The plugin page reads the state of the host when it is shown.
func (s *Shell) showLibraryPage(page string) error {
	if page != "projects" && page != pluginsPage {
		return Refuse(InvalidParams, "unknown library page %s", page)
	}
	s.library.page = page
	if page == pluginsPage {
		s.pluginOperations.Refresh(func() {})
		s.pluginOperations.RefreshOutdated(func() {})
		s.appUpdates.Refresh()
	}
	s.options.Invalidate()
	return nil
}

// browsePlugins closes the settings window and shows the plugin page of the library.
func (s *Shell) browsePlugins() error {
	s.settingsWindow.open = false
	s.browse()
	return s.showLibraryPage(pluginsPage)
}

// startPlugins reads the plugin state of a window that started and runs the starter job of a first run. The window then loads what
// the job installed.
func (s *Shell) startPlugins(done func(installed bool)) {
	s.pluginOperations.Refresh(func() {
		s.pluginOperations.RefreshOutdated(func() {
			s.pluginOperations.InstallStarter(s.starter.Pack, s.starter.Registry, func(text string) {
				s.fail(fmt.Errorf("%s", text))
			}, done)
		})
	})
}

// laterCommand registers a command that the plugin operations answer.
func laterCommand[T any](s *Shell, name string, run func(value T, answer func(err error)) error) {
	s.registry.CommandLater(name, func(raw json.RawMessage, answer func(any, error)) {
		value, err := params[T](raw)
		if err != nil {
			answer(nil, Refuse(InvalidParams, "%s: %s", name, err))
			return
		}
		if err := run(value, func(err error) { answer(nil, err) }); err != nil {
			answer(nil, err)
		}
	})
}

// registerPlugins adds the statuses and the commands of the plugin operations.
func (s *Shell) registerPlugins() {
	s.registry.Status("core.plugins", func() any { return s.pluginOperations.Status() })
	s.registry.Status("core.library", func() any { return s.libraryStatus() })
	s.registry.Status("core.app", func() any { return s.appUpdates.Status() })
	for _, action := range PluginActions {
		laterCommand(s, "core.plugins."+action, func(value pluginParam, answer func(err error)) error {
			if value.Plugin == "" {
				return Refuse(InvalidParams, "plugin must be a non-empty string")
			}
			s.pluginOperations.Run(action, value.Plugin, answer)
			return nil
		})
	}
	laterCommand(s, "core.plugins.update-all", func(_ struct{}, answer func(err error)) error {
		s.pluginOperations.UpdateAll(answer)
		return nil
	})
	laterCommand(s, "core.plugins.replace", func(value struct {
		Sidecar string `json:"sidecar"`
	}, answer func(err error)) error {
		if value.Sidecar == "" {
			return Refuse(InvalidParams, "sidecar must be a non-empty string")
		}
		s.pluginOperations.Replace(value.Sidecar, answer)
		return nil
	})
	laterCommand(s, "core.plugins.registry", func(value struct {
		Index string `json:"index"`
	}, answer func(err error)) error {
		if value.Index == "" {
			return Refuse(InvalidParams, "index must be a non-empty string")
		}
		s.pluginOperations.UseRegistry(value.Index, func(err error) {
			s.appUpdates.Refresh()
			answer(err)
		})
		return nil
	})
	laterCommand(s, "core.app.update", func(_ struct{}, answer func(err error)) error {
		s.appUpdates.Update(answer)
		return nil
	})
	laterCommand(s, "core.app.release", func(_ struct{}, answer func(err error)) error {
		s.appUpdates.OpenRelease(answer)
		return nil
	})
	act(s, "core.plugins.browse", func(struct{}) error { return s.browsePlugins() })
	act(s, "core.plugins.show-updates", func(struct{}) error {
		s.library.revealUpdates = true
		return s.browsePlugins()
	})
	act(s, "core.library.plugins.search", func(value struct {
		Query string `json:"query"`
	}) error {
		s.library.pluginQuery = value.Query
		s.options.Invalidate()
		return nil
	})
}

// pluginStarter is what the environment declaration says of the first run: the starter pack and the default registry index.
type pluginStarter struct {
	Pack     *string `json:"starter"`
	Registry *string `json:"registry"`
}

// drawPluginPlaceholder draws a tab of a plugin that the window did not load: the reason, and the install or enable button when
// that is what the tab waits for.
func (s *Shell) drawPluginPlaceholder(c *ui.Context, plugin string) {
	line, action, label := s.placeholderOf(plugin)
	ui.Column(c).Fill().Gap(s.metrics.tabsGap).Center().Children(func() {
		ui.Text(c, line).FontSize(12).TextColor(s.palette.Muted)
		if action != "" {
			s.binder.Button(c, "core.card.placeholder-action", "core.plugins."+action, plugin, label, pluginParam{plugin})
		}
	})
}

// placeholderOf returns the line of the placeholder of plugin, and its action and the label of the action when it has one.
func (s *Shell) placeholderOf(plugin string) (line, action, label string) {
	if failure := s.pluginOperations.Failure(); failure != nil && failure.Kind == "state" {
		return plugin + " 플러그인의 설치 상태를 읽지 못했습니다.", "", ""
	}
	rows := s.pluginOperations.Status().Plugins
	index := slices.IndexFunc(rows, func(row PluginRow) bool { return row.ID == plugin })
	switch {
	case index < 0 || rows[index].Installed == nil:
		if index >= 0 && rows[index].Latest != nil {
			return plugin + " 플러그인이 설치되어 있지 않습니다.", "install", "설치"
		}
		return plugin + " 플러그인이 설치되어 있지 않습니다.", "", ""
	case rows[index].State == "refused":
		return plugin + " 플러그인의 설치된 버전을 불러오지 못했습니다.", "", ""
	case rows[index].Installed.Enabled:
		return "창을 다시 불러오면 " + plugin + " 플러그인이 열립니다.", "", ""
	}
	return plugin + " 플러그인을 사용하지 않습니다.", "enable", "사용"
}
