package host

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

func projectOpenFixture(t *testing.T) (*Host, *Surfaces, context.Context) {
	t.Helper()
	savedFramework := framework
	framework = frameworkRecord{}
	t.Cleanup(func() { framework = savedFramework })
	surfaces := &Surfaces{invoke: func(task func()) { task() }, theme: Theme{Tokens: map[string]string{}}, events: func(string, any) {}}
	surfaces.projects = map[string]string{}
	surfaces.titles = &titleRecord{}
	surfaces.window = &frontendRecord{}
	host := &Host{
		windows: map[uint]*Surfaces{surfaces.window.ID(): surfaces},
		owners:  map[string]*Surfaces{},
	}
	surfaces.host = host
	windowContext := WithFrontend(context.Background(), surfaces.window)
	return host, surfaces, windowContext
}

// contract: project.open.registers-owner-without-commit
func TestProjectOpenRegistersOwnershipWithoutCommittingOrPosting(t *testing.T) {
	host, surfaces, ctx := projectOpenFixture(t)
	root := t.TempDir()
	folder, err := ResolveProjectFolder(root)
	if err != nil {
		t.Fatalf("resolve test project folder: %v", err)
	}
	host.owners["prj-one"] = surfaces
	surfaces.shown, surfaces.root = "prj-old", t.TempDir()
	shown, shownRoot := surfaces.shown, surfaces.root
	request, err := json.Marshal(ProjectOpen{ID: "prj-one", Root: root})
	if err != nil {
		t.Fatalf("marshal project open: %v", err)
	}
	opened, err := host.ProjectOpen(ctx, request)
	if err != nil {
		t.Fatalf("open project: %v", err)
	}
	if !opened.Local {
		t.Fatal("opened project is not local")
	}
	if opened.Staged {
		t.Fatal("committed project was reported as staged")
	}
	if surfaces.shown != shown || surfaces.root != shownRoot {
		t.Fatalf("project-open changed committed shown state before page data was ready: %q %q", surfaces.shown, surfaces.root)
	}
	if got := surfaces.projects["prj-one"]; got != folder.Root {
		t.Fatalf("project-open ownership root %q, want %q", got, folder.Root)
	}
}

// contract: project.open.staged-until-shown
func TestProjectOpenKeepsPendingReservationStagedUntilShown(t *testing.T) {
	host, surfaces, ctx := projectOpenFixture(t)
	root := t.TempDir()
	folder, err := ResolveProjectFolder(root)
	if err != nil {
		t.Fatalf("resolve project folder: %v", err)
	}
	surfaces.projects["prj-one"] = folder.Root
	surfaces.pendingProjects = map[string]bool{"prj-one": true}
	host.owners["prj-one"] = surfaces
	request, err := json.Marshal(ProjectOpen{ID: "prj-one", Root: root})
	if err != nil {
		t.Fatalf("marshal project open: %v", err)
	}
	opened, err := host.ProjectOpen(ctx, request)
	if err != nil {
		t.Fatalf("reopen staged project: %v", err)
	}
	if !opened.Local || !opened.Staged {
		t.Fatalf("staged reopen result %+v, want local and staged", opened)
	}
	shown, err := json.Marshal(map[string]any{"project": map[string]string{"id": "prj-one", "root": root, "title": "One"}})
	if err != nil {
		t.Fatalf("marshal shown project: %v", err)
	}
	if err := host.ProjectShown(ctx, shown); err != nil {
		t.Fatalf("commit shown project: %v", err)
	}
	if surfaces.pendingProjects["prj-one"] {
		t.Fatal("ProjectShown retained the staged reservation")
	}
	opened, err = host.ProjectOpen(ctx, request)
	if err != nil {
		t.Fatalf("reopen committed project: %v", err)
	}
	if !opened.Local || opened.Staged {
		t.Fatalf("committed reopen result %+v, want local and not staged", opened)
	}
}

// contract: project.shown-commits-after-page-ready, projects.shown.requires-project-field
func TestProjectShownCommitsTheProjectAndNull(t *testing.T) {
	host, surfaces, ctx := projectOpenFixture(t)
	root := t.TempDir()
	folder, err := ResolveProjectFolder(root)
	if err != nil {
		t.Fatalf("resolve project folder: %v", err)
	}
	surfaces.projects["prj-one"] = folder.Root
	host.owners["prj-one"] = surfaces
	request, err := json.Marshal(map[string]any{"unknown": true, "project": map[string]string{"id": "prj-one", "root": root, "title": "One", "unknown": "ignored"}})
	if err != nil {
		t.Fatalf("marshal shown project: %v", err)
	}
	if err := host.ProjectShown(ctx, request); err != nil {
		t.Fatalf("commit shown project: %v", err)
	}
	if surfaces.shown != "prj-one" || surfaces.root != folder.Root {
		t.Fatalf("shown state %q %q, want project and canonical root", surfaces.shown, surfaces.root)
	}
	if got := surfaces.title; got != "One"+titleSuffix() {
		t.Fatalf("window title %q, want %q", got, "One"+titleSuffix())
	}
	if err := host.ProjectShown(ctx, json.RawMessage(`{"project":null}`)); err != nil {
		t.Fatalf("clear shown project: %v", err)
	}
	if surfaces.shown != "" || surfaces.root != "" || surfaces.title != windowTitle() {
		t.Fatalf("cleared state shown=%q root=%q title=%q", surfaces.shown, surfaces.root, surfaces.title)
	}
}

// contract: host-calls.decode.messages
func TestProjectShownDecodesStandardArguments(t *testing.T) {
	host, _, ctx := projectOpenFixture(t)
	cases := []struct {
		name string
		raw  string
		want string
	}{
		{"non-object request", `true`, "argument request must be an object, not a boolean"},
		{"missing project", `{}`, "argument request.project is missing"},
		{"malformed nested project", `{"project":{"id":5,"root":"/tmp","title":"One"}}`, "argument request.project.id must be a string, not a number"},
		{"missing nested title", `{"project":{"id":"prj-one","root":"/tmp"}}`, "argument request.project.title is missing"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if err := host.ProjectShown(ctx, json.RawMessage(c.raw)); err == nil || err.Error() != c.want {
				t.Fatalf("ProjectShown(%s) error = %v, want %q", c.raw, err, c.want)
			}
		})
	}
}

// contract: project.open.prepare-before-show
func TestProjectOpenKeepsCommittedRootUntilThePageSelectsTheNewRoot(t *testing.T) {
	host, surfaces, ctx := projectOpenFixture(t)
	oldRoot, err := ResolveProjectFolder(t.TempDir())
	if err != nil {
		t.Fatalf("resolve old project folder: %v", err)
	}
	newRoot, err := ResolveProjectFolder(t.TempDir())
	if err != nil {
		t.Fatalf("resolve new project folder: %v", err)
	}
	surfaces.projects = map[string]string{"prj-current": oldRoot.Root}
	surfaces.shown, surfaces.root = "prj-current", oldRoot.Root
	surfaces.title = "Current" + titleSuffix()
	host.owners["prj-current"] = surfaces
	request, err := json.Marshal(ProjectOpen{ID: "prj-current", Root: newRoot.Root})
	if err != nil {
		t.Fatalf("marshal project open: %v", err)
	}
	opened, err := host.ProjectOpen(ctx, request)
	if err != nil {
		t.Fatalf("reopen shown project: %v", err)
	}
	if !opened.Local || opened.Staged {
		t.Fatalf("reopen result %+v, want local and not staged", opened)
	}
	if surfaces.shown != "prj-current" || surfaces.root != oldRoot.Root {
		t.Fatalf("reopen changed committed project: shown=%q root=%q, want old root %q", surfaces.shown, surfaces.root, oldRoot.Root)
	}
	if surfaces.projects["prj-current"] != newRoot.Root {
		t.Fatalf("reopen root %q, want requested root %q", surfaces.projects["prj-current"], newRoot.Root)
	}
}

// contract: projects.shown-validates-before-commit
func TestProjectShownRootMismatchDoesNotMutateProjectState(t *testing.T) {
	host, surfaces, ctx := projectOpenFixture(t)
	ownedRoot, err := ResolveProjectFolder(t.TempDir())
	if err != nil {
		t.Fatalf("resolve owned project folder: %v", err)
	}
	otherRoot, err := ResolveProjectFolder(t.TempDir())
	if err != nil {
		t.Fatalf("resolve other project folder: %v", err)
	}
	surfaces.shown, surfaces.root, surfaces.title = "prj-old", "/projects/old", "Old"+titleSuffix()
	surfaces.projects["prj-next"] = ownedRoot.Root
	surfaces.pendingProjects = map[string]bool{"prj-next": true}
	host.owners["prj-old"], host.owners["prj-next"] = surfaces, surfaces
	request, err := json.Marshal(map[string]any{"project": map[string]string{
		"id": "prj-next", "root": otherRoot.Root, "title": "Next",
	}})
	if err != nil {
		t.Fatalf("marshal shown project: %v", err)
	}

	err = host.ProjectShown(ctx, request)
	if err == nil || !strings.Contains(err.Error(), "root does not match") {
		t.Fatalf("ProjectShown root mismatch error = %v", err)
	}
	if surfaces.shown != "prj-old" || surfaces.root != "/projects/old" || surfaces.title != "Old"+titleSuffix() {
		t.Fatalf("root mismatch changed shown state: shown=%q root=%q title=%q", surfaces.shown, surfaces.root, surfaces.title)
	}
	if got := surfaces.projects["prj-next"]; got != ownedRoot.Root {
		t.Fatalf("root mismatch changed owner root to %q, want %q", got, ownedRoot.Root)
	}
	if !surfaces.pendingProjects["prj-next"] {
		t.Fatal("root mismatch removed the staged project")
	}
	if host.owners["prj-next"] != surfaces {
		t.Fatal("root mismatch removed the project owner")
	}
}

// contract: projects.release-rolls-back-staged-owner
func TestProjectReleaseRollsBackOnlyTheStagedOwner(t *testing.T) {
	host, surfaces, _ := projectOpenFixture(t)
	oldRoot, err := ResolveProjectFolder(t.TempDir())
	if err != nil {
		t.Fatalf("resolve committed project folder: %v", err)
	}
	nextRoot, err := ResolveProjectFolder(t.TempDir())
	if err != nil {
		t.Fatalf("resolve staged project folder: %v", err)
	}
	otherRoot, err := ResolveProjectFolder(t.TempDir())
	if err != nil {
		t.Fatalf("resolve other staged project folder: %v", err)
	}
	surfaces.projects = map[string]string{"prj-old": oldRoot.Root, "prj-next": nextRoot.Root, "prj-other": otherRoot.Root}
	surfaces.pendingProjects = map[string]bool{"prj-next": true, "prj-other": true}
	surfaces.shown, surfaces.root, surfaces.title = "prj-old", oldRoot.Root, "Old"+titleSuffix()
	surfaces.sidecars = &Sidecars{owners: map[string]SidecarOwner{}}
	host.owners["prj-old"], host.owners["prj-next"], host.owners["prj-other"] = surfaces, surfaces, surfaces
	// This owner-state case has no registered window to receive workspace events.
	host.windows = map[uint]*Surfaces{}
	id, err := json.Marshal("prj-next")
	if err != nil {
		t.Fatalf("marshal project id: %v", err)
	}

	if err := host.ProjectRelease(id); err != nil {
		t.Fatalf("release staged project: %v", err)
	}
	if _, ok := host.owners["prj-next"]; ok {
		t.Fatal("release retained staged project ownership")
	}
	if got, ok := surfaces.projects["prj-next"]; ok {
		t.Fatalf("release retained staged project root %q", got)
	}
	if surfaces.pendingProjects["prj-next"] {
		t.Fatal("release retained staged project reservation")
	}
	if got := host.owners["prj-old"]; got != surfaces || surfaces.projects["prj-old"] != oldRoot.Root {
		t.Fatal("release removed the other committed project")
	}
	if got := host.owners["prj-other"]; got != surfaces || surfaces.projects["prj-other"] != otherRoot.Root || !surfaces.pendingProjects["prj-other"] {
		t.Fatal("release changed another staged project owner")
	}
	if surfaces.shown != "prj-old" || surfaces.root != oldRoot.Root || surfaces.title != "Old"+titleSuffix() {
		t.Fatalf("release changed committed state: shown=%q root=%q title=%q", surfaces.shown, surfaces.root, surfaces.title)
	}
}

// contract: host-calls.decode.messages, projects.shown.requires-project-field
func TestProjectShownRejectsMalformedArgumentsWithoutMutation(t *testing.T) {
	host, surfaces, ctx := projectOpenFixture(t)
	surfaces.shown, surfaces.root, surfaces.title = "prj-old", "/projects/old", "Old"+titleSuffix()
	surfaces.projects["prj-next"] = "/projects/next"
	surfaces.pendingProjects = map[string]bool{"prj-next": true}
	host.owners["prj-next"] = surfaces
	cases := []struct {
		name string
		raw  string
		want string
	}{
		{"non-object request", `true`, "argument request must be an object, not a boolean"},
		{"missing project", `{}`, "argument request.project is missing"},
		{"malformed project id", `{"project":{"id":5,"root":"/tmp","title":"Next"}}`, "argument request.project.id must be a string, not a number"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if err := host.ProjectShown(ctx, json.RawMessage(tc.raw)); err == nil || err.Error() != tc.want {
				t.Fatalf("ProjectShown(%s) error = %v, want %q", tc.raw, err, tc.want)
			}
			if surfaces.shown != "prj-old" || surfaces.root != "/projects/old" || surfaces.title != "Old"+titleSuffix() {
				t.Fatalf("malformed request changed shown state: shown=%q root=%q title=%q", surfaces.shown, surfaces.root, surfaces.title)
			}
			if !surfaces.pendingProjects["prj-next"] || host.owners["prj-next"] != surfaces {
				t.Fatal("malformed request changed staged project ownership")
			}
		})
	}
}

// contract: project.shown.ignores-unknown-fields
func TestProjectShownIgnoresUnknownOuterAndNestedFields(t *testing.T) {
	host, surfaces, ctx := projectOpenFixture(t)
	root, err := ResolveProjectFolder(t.TempDir())
	if err != nil {
		t.Fatalf("resolve project folder: %v", err)
	}
	surfaces.projects["prj-one"] = root.Root
	host.owners["prj-one"] = surfaces
	request, err := json.Marshal(map[string]any{
		"unknown": true,
		"project": map[string]any{"id": "prj-one", "root": root.Root, "title": "One", "extra": true},
	})
	if err != nil {
		t.Fatalf("marshal shown project: %v", err)
	}

	if err := host.ProjectShown(ctx, request); err != nil {
		t.Fatalf("ProjectShown rejected unknown fields: %v", err)
	}
	if surfaces.shown != "prj-one" || surfaces.root != root.Root || surfaces.title != "One"+titleSuffix() {
		t.Fatalf("recognized project fields were not committed: shown=%q root=%q title=%q", surfaces.shown, surfaces.root, surfaces.title)
	}
}

// contract: projects.shown-command-is-registered
func TestProjectShownIsExposedThroughTheBindingEntrance(t *testing.T) {
	bindings, err := NewBindings(&Host{}, "Bindings")
	if err != nil {
		t.Fatalf("create host bindings: %v", err)
	}
	_, err = bindings.Call(context.Background(), "ProjectShown", []json.RawMessage{json.RawMessage(`true`)}, nil)
	if err == nil || err.Error() != "argument request must be an object, not a boolean" {
		t.Fatalf("ProjectShown binding error = %v", err)
	}
}

// contract: project.open-ready-shown-order
func TestProjectOpenKeepsTheCommittedProjectUntilThePageSelectsTheNewOne(t *testing.T) {
	host, surfaces, ctx := projectOpenFixture(t)
	oldFolder, err := ResolveProjectFolder(t.TempDir())
	if err != nil {
		t.Fatalf("resolve old project folder: %v", err)
	}
	surfaces.shown, surfaces.root = "prj-old", oldFolder.Root
	host.owners["prj-next"] = surfaces
	nextRoot := t.TempDir()
	request, err := json.Marshal(ProjectOpen{ID: "prj-next", Root: nextRoot})
	if err != nil {
		t.Fatalf("marshal project open: %v", err)
	}
	opened, err := host.ProjectOpen(ctx, request)
	if err != nil {
		t.Fatalf("open project: %v", err)
	}
	if !opened.Local {
		t.Fatalf("project open result %+v, want a local project", opened)
	}
	if surfaces.shown != "prj-old" || surfaces.root != oldFolder.Root {
		t.Fatalf("project open changed the committed project before the page selected it: %q %q", surfaces.shown, surfaces.root)
	}
	shown, err := json.Marshal(map[string]any{"project": map[string]string{"id": "prj-next", "root": nextRoot, "title": "Next"}})
	if err != nil {
		t.Fatalf("marshal shown project: %v", err)
	}
	if err := host.ProjectShown(ctx, shown); err != nil {
		t.Fatalf("commit the selected project: %v", err)
	}
	if surfaces.shown != "prj-next" {
		t.Fatalf("committed project after the page selection is %q, want prj-next", surfaces.shown)
	}
}

// projectActivityWindow is a second window of a test host, which records the events that it receives.
func projectActivityWindow(t *testing.T, h *Host, name string, id uint) (*Surfaces, *[]ProjectActivityRecord) {
	t.Helper()
	received := &[]ProjectActivityRecord{}
	s := &Surfaces{name: name, invoke: func(task func()) { task() }, theme: Theme{Tokens: map[string]string{}}, projects: map[string]string{},
		events: func(event string, data any) {
			if event == "project-activity" {
				*received = append(*received, data.(ProjectActivityRecord))
			}
		}}
	s.titles = &titleRecord{}
	s.window = &frontendNumbered{id: id}
	s.host = h
	h.windows[id] = s
	return s, received
}

// The window that holds a project publishes the activities of its spaces, the host sends the record to every window, and the
// release of the project removes its entry (docs/spec/activity.md#activity-of-a-project).
// contract: project-activity.publish.held-by-the-window
func TestTheProjectActivityOfTheHoldingWindowReachesEveryWindow(t *testing.T) {
	h, _, _ := projectOpenFixture(t)
	h.windows = map[uint]*Surfaces{}
	first, toFirst := projectActivityWindow(t, h, "main", 1)
	second, toSecond := projectActivityWindow(t, h, "project-p2", 2)
	h.owners["p1"], h.owners["p2"] = first, second
	publish := func(window *Surfaces, request string) error {
		return h.ProjectActivity(WithFrontend(context.Background(), window.window), json.RawMessage(request))
	}
	spaces := `{"s1":{"activity":"failed","cards":{"card-1":"failed"},"groups":{}}}`
	if err := publish(second, `{"id":"p2","spaces":`+spaces+`}`); err != nil {
		t.Fatalf("the holding window was refused: %v", err)
	}
	want := ProjectActivityRecord{Revision: 1, Projects: map[string]ProjectActivityState{"p2": {Activity: "failed", Spaces: map[string]SpaceActivity{
		"s1": {Activity: "failed", Cards: map[string]string{"card-1": "failed"}, Groups: map[string]string{}}}}}}
	for name, received := range map[string]*[]ProjectActivityRecord{"the first window": toFirst, "the second window": toSecond} {
		if len(*received) != 1 || !equalRecords((*received)[0], want) {
			t.Fatalf("%s received %+v, want %+v", name, *received, want)
		}
	}
	if err := publish(first, `{"id":"p2","spaces":`+spaces+`}`); err == nil || err.Error() != "project p2 is not owned by this window" {
		t.Fatalf("a window that does not hold the project was answered %v", err)
	}
	if len(*toFirst) != 1 {
		t.Fatalf("a refused publication sent %+v", *toFirst)
	}
	id, err := json.Marshal("p2")
	if err != nil {
		t.Fatal(err)
	}
	if err := h.ProjectRelease(id); err != nil {
		t.Fatal(err)
	}
	empty := ProjectActivityRecord{Revision: 2, Projects: map[string]ProjectActivityState{}}
	if len(*toFirst) != 2 || !equalRecords((*toFirst)[1], empty) {
		t.Fatalf("the release sent %+v, want %+v", *toFirst, empty)
	}
	// The end of the page of a window removes what it published.
	if err := publish(first, `{"id":"p1","spaces":`+spaces+`}`); err != nil {
		t.Fatal(err)
	}
	h.endProjectActivities(first)
	if got := h.activities.Record(); got.Revision != 4 || len(got.Projects) != 0 || len(*toSecond) != 4 {
		t.Fatalf("after the end of the page the record is %+v and the second window received %d records", got, len(*toSecond))
	}
}

// frontendNumbered is the window of a test with its own identifier; a call that needs a native window panics.
type frontendNumbered struct {
	frontendRecord
	id uint
}

func (f *frontendNumbered) ID() uint { return f.id }

// Emit takes the notices that the host sends to the window without its events function, such as workspace-changed; the window of a
// test has no page that reads them.
func (f *frontendNumbered) Emit(string, ...any) {}

func equalRecords(a, b ProjectActivityRecord) bool {
	left, err := json.Marshal(a)
	if err != nil {
		return false
	}
	right, err := json.Marshal(b)
	return err == nil && string(left) == string(right)
}

// frameworkRecord is the framework of a test: it names the host, and a call that needs a framework panics.
type frameworkRecord struct{ Framework }

func (frameworkRecord) DisplayName() string { return "Test" }

func (frameworkRecord) MainPage() bool { return true }

// frontendRecord is the window of a test: it has no native window, and a call that needs one panics.
type frontendRecord struct{ Frontend }

func (*frontendRecord) ID() uint { return 0 }

func (*frontendRecord) Frames() *WindowFrames { return nil }

func (*frontendRecord) Name() string { return "" }
