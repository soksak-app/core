package adapter

import (
	"fmt"

	"github.com/wailsapp/wails/v3/pkg/application"

	host "github.com/soksak-app/core/packages/host/go/src"
	"github.com/soksak-app/core/packages/host/go/src/platform"
)

// Framework is the Wails application as the Framework port of the language host library.
type Framework struct{}

// ApplicationName is the application of endpoint.json.
func (Framework) ApplicationName() string { return "wailsv3" }

// DisplayName is the end of a window title.
func (Framework) DisplayName() string { return "Wails v3" }

// MainPage is true: a window shows the workbench in a main page.
func (Framework) MainPage() bool { return true }

// Step runs task as one step of the main thread and returns when it returned.
func (Framework) Step(task func()) { application.InvokeSync(task) }

// Post runs task as a later step of the main thread.
func (Framework) Post(task func()) { application.InvokeAsync(task) }

// Quit ends the application.
func (Framework) Quit() { application.Get().Quit() }

// ChooseFolder shows the folder panel attached to window.
func (Framework) ChooseFolder(window host.Frontend, title string) (string, error) {
	return application.Get().Dialog.OpenFile().CanChooseFiles(false).CanChooseDirectories(true).
		AttachToWindow(window.(Frontend).window).SetTitle(title).PromptForSingleSelection()
}

// SaveFile shows the save panel attached to window.
func (Framework) SaveFile(window host.Frontend, name, directory string) (string, error) {
	dialog := application.Get().Dialog.SaveFile().SetFilename(name)
	if directory != "" {
		dialog = dialog.SetDirectory(directory)
	}
	return dialog.AttachToWindow(window.(Frontend).window).PromptForSingleSelection()
}

// SetMenu installs the application menu.
func (Framework) SetMenu(menus []host.Menu) error {
	menu, err := applicationMenu(menus)
	if err != nil {
		return err
	}
	application.Get().Menu.Set(menu)
	return nil
}

// InstallDock installs the Dock menu.
func (Framework) InstallDock(newWindow func()) error {
	system, err := platform.Current()
	if err != nil {
		return err
	}
	return system.InstallDock(newWindow)
}

// NewWindow creates a window whose content reaches under a hidden title bar.
func (Framework) NewWindow(options host.WindowOptions) host.Frontend {
	return Frontend{window: application.Get().Window.NewWithOptions(application.WebviewWindowOptions{
		Name: options.Name, Title: options.Title, Width: WailsPixels(options.Width), Height: WailsPixels(options.Height),
		Mac: application.MacWindow{TitleBar: application.MacTitleBarHidden},
		// The window is shown after the first screen is displayed (docs/spec/native-host.md#page-start). When the preparation ends, reveal shows it.
		URL: options.URL, DevToolsEnabled: true, BackgroundColour: application.NewRGB(16, 17, 23), Hidden: true,
	})}
}

// Windows returns the windows that are open.
func (Framework) Windows() []host.Frontend {
	windows := application.Get().Window.GetAll()
	frontends := make([]host.Frontend, 0, len(windows))
	for _, window := range windows {
		webview, ok := window.(*application.WebviewWindow)
		if !ok {
			panic(fmt.Sprintf("the window %s is not a web view window", window.Name()))
		}
		frontends = append(frontends, Frontend{window: webview})
	}
	return frontends
}
