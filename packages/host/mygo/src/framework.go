package adapter

import (
	"path/filepath"
	"sync"
	"sync/atomic"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"

	host "github.com/soksak-app/core/packages/host/go/src"
	"github.com/soksak-app/core/packages/host/go/src/platform"
)

// Framework is the mygo application as the Framework port of the language host library.
type Framework struct {
	workbench Workbench
	// host is the prepared host, which starts each workbench.
	host      atomic.Pointer[host.Host]
	mu        sync.Mutex
	frontends map[*mygo.Window]*Frontend
	// transaction belongs to the main thread: whether a surface layout transaction is open.
	transaction bool
}

// NewFramework returns the framework that draws the windows with workbench.
func NewFramework(workbench Workbench) *Framework {
	return &Framework{workbench: workbench, frontends: map[*mygo.Window]*Frontend{}}
}

// Serve connects the framework to the prepared host, before the first window exists.
func (f *Framework) Serve(h *host.Host) {
	f.host.Store(h)
	f.workbench.Prepared(h)
}

// ApplicationName is the application of endpoint.json.
func (*Framework) ApplicationName() string { return "mygo" }

// DisplayName is the end of a window title.
func (*Framework) DisplayName() string { return "mygo" }

// MainPage is false: the workbench draws in native UI.
func (*Framework) MainPage() bool { return false }

// Step runs task as one step of the main thread and returns when it returned.
func (*Framework) Step(task func()) { mygo.RunOnMain(task) }

// Post runs task as a later step of the main thread. The application is ready when the host posts, and WhenReady then queues task.
func (*Framework) Post(task func()) { mygo.App.WhenReady(task) }

// Quit ends the application.
func (*Framework) Quit() { mygo.App.Quit() }

// FolderDialog is the folder panel attached to window.
func FolderDialog(window *mygo.Window, title string) mygo.OpenDialogOptions {
	return mygo.OpenDialogOptions{Parent: window, Title: title, Directory: true, CreateDirectories: true}
}

// SaveDialog is the save panel of name attached to window, in directory when it is not "".
func SaveDialog(window *mygo.Window, name, directory string) mygo.SaveDialogOptions {
	path := name
	if directory != "" {
		path = filepath.Join(directory, name)
	}
	return mygo.SaveDialogOptions{Parent: window, DefaultPath: path, CreateDirectories: true}
}

// ChooseFolder shows the folder panel attached to window.
func (*Framework) ChooseFolder(window host.Frontend, title string) (string, error) {
	paths, err := mygo.Dialog.Open(FolderDialog(window.(*Frontend).window, title))
	if err != nil || len(paths) == 0 {
		return "", err
	}
	return paths[0], nil
}

// SaveFile shows the save panel attached to window.
func (*Framework) SaveFile(window host.Frontend, name, directory string) (string, error) {
	return mygo.Dialog.Save(SaveDialog(window.(*Frontend).window, name, directory))
}

// SetMenu installs the application menu.
func (*Framework) SetMenu(menus []host.Menu) error {
	menu, err := applicationMenu(menus)
	if err != nil {
		return err
	}
	mygo.App.SetMenu(menu)
	return nil
}

// DockNewWindow is the title of the new window item of the Dock menu.
const DockNewWindow = "새 창"

// InstallDock installs the Dock menu. The application delegate of mygo answers the Dock menu request, so the menu is a menu of
// the framework (docs/operations/private-native-apis.md#mygo-host).
func (*Framework) InstallDock(newWindow func()) error {
	mygo.App.Dock.SetMenu(mygo.NewMenu([]*mygo.MenuItem{
		{Label: DockNewWindow, Click: func(*mygo.MenuItem, *mygo.Window) { newWindow() }},
	}))
	return nil
}

// NewWindow creates a hidden window whose content reaches under a hidden title bar and draws while it is occluded, because the
// layout transaction and the captures of an occluded window wait for a presented frame (docs/spec/hosts.md#framework-changes). The
// window is made in one step, so its view first runs when the frontend is complete, and its native view is in the window before any
// surface of the window exists.
func (f *Framework) NewWindow(options host.WindowOptions) host.Frontend {
	frontend := &Frontend{name: options.Name, framework: f, address: options.URL, frames: host.NewWindowFrames(options.Name)}
	mygo.RunOnMain(func() {
		frontend.content = ui.View(func(c *ui.Context) {
			if view := frontend.view.Load(); view != nil {
				(*view)(c)
			}
		})
		frontend.content.RecordFrames(FrameRecorder(frontend.frames))
		frontend.window = mygo.NewWindow(mygo.WindowOptions{
			Title: options.Title, Width: Pixels(options.Width), Height: Pixels(options.Height), Hidden: true,
			TitleBarStyle: mygo.TitleBarHidden, BackgroundColor: "#101117", DrawWhileOccluded: true,
			Content: frontend.content,
		})
		frontend.placeNativeView()
		frontend.started()
		f.mu.Lock()
		f.frontends[frontend.window] = frontend
		f.mu.Unlock()
		// The Core Animation transaction of the main thread holds every frame that presents with it, the frame of a new window among them.
		if f.transaction {
			frontend.window.TransactionOpened()
			frontend.hold()
		}
	})
	return frontend
}

// ObserveLayout makes the surface layout transactions hold the frames of the windows (docs/spec/hosts.md#operation-groups).
func (f *Framework) ObserveLayout() error {
	system, err := platform.Current()
	if err != nil {
		return err
	}
	mygo.RunOnMain(func() { err = system.ObserveLayout(f.layoutStarted, f.layoutEnded) })
	return err
}

// layoutStarted holds the frames of every window from the start of a preparation of window. The preparation releases the hold of
// window when it asks for its frame (AfterPresentation).
//
// The transaction stays open across passes of the run loop, and a frame of any window presents with it, so every window learns
// of it: a frame presented meanwhile keeps its drawable until the commit, and a later frame waits for the commit instead of
// waiting on the main thread for a drawable that only the commit returns. A frame of window drawn before the preparation asks
// for its frame would take the drawable of the transaction and place the native views of window in it, so the frame of the
// transaction would wait for the commit that waits for it, and the native views would show the frames after it at the commit.
func (f *Framework) layoutStarted(platform.Window) {
	f.transaction = true
	for _, frontend := range f.windows() {
		frontend.window.TransactionOpened()
		frontend.hold()
	}
}

// layoutEnded releases every hold when the transaction ends, before the next waiting transaction starts.
func (f *Framework) layoutEnded(platform.Window) {
	f.transaction = false
	for _, frontend := range f.windows() {
		frontend.window.TransactionCommitted()
		frontend.release()
	}
}

// windows returns the frontends of the open windows.
func (f *Framework) windows() []*Frontend {
	f.mu.Lock()
	defer f.mu.Unlock()
	frontends := make([]*Frontend, 0, len(f.frontends))
	for _, frontend := range f.frontends {
		frontends = append(frontends, frontend)
	}
	return frontends
}

// Windows returns the windows that are open.
func (f *Framework) Windows() []host.Frontend {
	f.mu.Lock()
	defer f.mu.Unlock()
	windows := mygo.Windows()
	frontends := make([]host.Frontend, 0, len(windows))
	for _, window := range windows {
		if frontend := f.frontends[window]; frontend != nil {
			frontends = append(frontends, frontend)
		}
	}
	return frontends
}

// closed forgets a window that closed.
func (f *Framework) closed(frontend *Frontend) {
	f.mu.Lock()
	delete(f.frontends, frontend.window)
	f.mu.Unlock()
}
