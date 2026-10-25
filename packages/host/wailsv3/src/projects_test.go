package host

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/wailsapp/wails/v3/pkg/application"
)

func projectOpenFixture(t *testing.T) (*Host, *Surfaces, *channelPlatform, context.Context) {
	return projectOpenFixtureReady(t, true)
}

func projectOpenFixtureReady(t *testing.T, ready bool) (*Host, *Surfaces, *channelPlatform, context.Context) {
	t.Helper()
	fake := &channelPlatform{}
	surfaces, _ := channelSurfaces(t, fake, ready)
	surfaces.projects = map[string]string{}
	surfaces.titles = &titleRecord{}
	surfaces.events = func(string, any) {}
	surfaces.window = &application.WebviewWindow{}
	host := &Host{
		windows: map[uint]*Surfaces{surfaces.window.ID(): surfaces},
		owners:  map[string]*Surfaces{},
	}
	surfaces.host = host
	windowContext := context.WithValue(context.Background(), application.WindowKey, surfaces.window)
	return host, surfaces, fake, windowContext
}

// contract: project.open.prepare-before-show
func TestProjectOpenRegistersOwnershipWithoutCommittingOrPosting(t *testing.T) {
	host, surfaces, fake, ctx := projectOpenFixture(t)
	fake.posted = nil
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
	if got := len(fake.posted); got != 0 {
		t.Fatalf("project-open posted %d messages before page data was ready: %v", got, fake.posted)
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
	host, surfaces, fake, ctx := projectOpenFixture(t)
	fake.posted = nil
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

// contract: project.shown-commits-after-page-ready
func TestProjectShownPostsTheCommittedProjectAndNull(t *testing.T) {
	host, surfaces, fake, ctx := projectOpenFixture(t)
	fake.posted = nil
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
	if got := surfaces.title; got != "One"+titleSuffix {
		t.Fatalf("window title %q, want %q", got, "One"+titleSuffix)
	}
	if len(fake.posted) != 1 || !strings.Contains(fake.posted[0], `"event":"project"`) || !strings.Contains(fake.posted[0], `"id":"prj-one"`) || !strings.Contains(fake.posted[0], `"root":"`+folder.Root+`"`) {
		t.Fatalf("posted project %v, want committed project", fake.posted)
	}
	if err := host.ProjectShown(ctx, json.RawMessage(`{"project":null}`)); err != nil {
		t.Fatalf("clear shown project: %v", err)
	}
	if surfaces.shown != "" || surfaces.root != "" || surfaces.title != windowTitle {
		t.Fatalf("cleared state shown=%q root=%q title=%q", surfaces.shown, surfaces.root, surfaces.title)
	}
	if len(fake.posted) != 2 || !strings.Contains(fake.posted[1], `"event":"project"`) || !strings.Contains(fake.posted[1], `"data":null`) {
		t.Fatalf("posted null project %v", fake.posted)
	}
}

// contract: project.shown-decodes-standard-arguments
func TestProjectShownDecodesStandardArguments(t *testing.T) {
	host, _, _, ctx := projectOpenFixture(t)
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

// contract: project.shown-ready-catch-up
func TestProjectShownIsCaughtUpWhenPluginHostBecomesReady(t *testing.T) {
	host, surfaces, fake, ctx := projectOpenFixtureReady(t, false)
	root := t.TempDir()
	folder, err := ResolveProjectFolder(root)
	if err != nil {
		t.Fatalf("resolve project folder: %v", err)
	}
	surfaces.projects["prj-one"] = folder.Root
	host.owners["prj-one"] = surfaces
	fake.posted = nil
	request, err := json.Marshal(map[string]any{"project": map[string]string{"id": "prj-one", "root": root, "title": "One"}})
	if err != nil {
		t.Fatalf("marshal shown project: %v", err)
	}
	if err := host.ProjectShown(ctx, request); err != nil {
		t.Fatalf("commit project before host ready: %v", err)
	}
	if len(fake.posted) != 0 {
		t.Fatalf("unready plugin host received %v", fake.posted)
	}
	surfaces.pluginHostState("probe", pluginHostNavigationState(true, 1))
	if err := surfaces.pluginHostMessage("probe", hostMessage(`{"event":"view.ready","plugin":"probe","document":"doc-1"}`)); err != nil {
		t.Fatalf("ready plugin host: %v", err)
	}
	if len(fake.posted) != 2 || !strings.Contains(fake.posted[1], `"event":"project"`) || !strings.Contains(fake.posted[1], `"id":"prj-one"`) || !strings.Contains(fake.posted[1], `"root":"`+folder.Root+`"`) {
		t.Fatalf("ready catch-up %v, want theme then committed project", fake.posted)
	}
}

// contract: project.open-ready-shown-order
func TestProjectOpenBeforeReadyKeepsOldProjectUntilShownCommitsNew(t *testing.T) {
	host, surfaces, fake, ctx := projectOpenFixtureReady(t, false)
	oldRoot, err := ResolveProjectFolder(t.TempDir())
	if err != nil {
		t.Fatalf("resolve old project folder: %v", err)
	}
	newRoot, err := ResolveProjectFolder(t.TempDir())
	if err != nil {
		t.Fatalf("resolve new project folder: %v", err)
	}
	surfaces.projects = map[string]string{"prj-old": oldRoot.Root, "prj-new": newRoot.Root}
	surfaces.pendingProjects = map[string]bool{"prj-new": true}
	surfaces.shown, surfaces.root = "prj-old", oldRoot.Root
	surfaces.title = "Old" + titleSuffix
	host.owners["prj-old"] = surfaces
	host.owners["prj-new"] = surfaces
	fake.posted = nil
	openRequest, err := json.Marshal(ProjectOpen{ID: "prj-new", Root: newRoot.Root})
	if err != nil {
		t.Fatalf("marshal project open: %v", err)
	}
	opened, err := host.ProjectOpen(ctx, openRequest)
	if err != nil {
		t.Fatalf("open staged project: %v", err)
	}
	if !opened.Local || !opened.Staged {
		t.Fatalf("project open result %+v, want local staged owner", opened)
	}
	if surfaces.shown != "prj-old" || surfaces.root != oldRoot.Root || surfaces.title != "Old"+titleSuffix {
		t.Fatalf("project-open changed committed state: shown=%q root=%q title=%q", surfaces.shown, surfaces.root, surfaces.title)
	}
	if len(fake.posted) != 0 {
		t.Fatalf("project-open posted before host readiness: %v", fake.posted)
	}
	surfaces.pluginHostState("probe", pluginHostNavigationState(true, 1))
	if err := surfaces.pluginHostMessage("probe", hostMessage(`{"event":"view.ready","plugin":"probe","document":"doc-1"}`)); err != nil {
		t.Fatalf("ready plugin host: %v", err)
	}
	if len(fake.posted) != 2 || !strings.Contains(fake.posted[1], `"id":"prj-old"`) || !strings.Contains(fake.posted[1], `"root":"`+oldRoot.Root+`"`) {
		t.Fatalf("ready catch-up %v, want old committed project", fake.posted)
	}
	shownRequest, err := json.Marshal(map[string]any{"project": map[string]string{"id": "prj-new", "root": newRoot.Root, "title": "New"}})
	if err != nil {
		t.Fatalf("marshal shown project: %v", err)
	}
	if err := host.ProjectShown(ctx, shownRequest); err != nil {
		t.Fatalf("commit new project: %v", err)
	}
	if surfaces.shown != "prj-new" || surfaces.root != newRoot.Root || surfaces.title != "New"+titleSuffix {
		t.Fatalf("ProjectShown did not commit new project: shown=%q root=%q title=%q", surfaces.shown, surfaces.root, surfaces.title)
	}
	if len(fake.posted) != 3 || !strings.Contains(fake.posted[2], `"id":"prj-new"`) || !strings.Contains(fake.posted[2], `"root":"`+newRoot.Root+`"`) {
		t.Fatalf("ProjectShown event %v, want new committed project after old catch-up", fake.posted)
	}
}

// contract: project.open.prepare-before-show
func TestProjectOpenKeepsCommittedRootUntilThePageSelectsTheNewRoot(t *testing.T) {
	host, surfaces, _, ctx := projectOpenFixture(t)
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
	surfaces.title = "Current" + titleSuffix
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
	host, surfaces, fake, ctx := projectOpenFixture(t)
	ownedRoot, err := ResolveProjectFolder(t.TempDir())
	if err != nil {
		t.Fatalf("resolve owned project folder: %v", err)
	}
	otherRoot, err := ResolveProjectFolder(t.TempDir())
	if err != nil {
		t.Fatalf("resolve other project folder: %v", err)
	}
	surfaces.shown, surfaces.root, surfaces.title = "prj-old", "/projects/old", "Old"+titleSuffix
	surfaces.projects["prj-next"] = ownedRoot.Root
	surfaces.pendingProjects = map[string]bool{"prj-next": true}
	host.owners["prj-old"], host.owners["prj-next"] = surfaces, surfaces
	fake.posted = nil
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
	if surfaces.shown != "prj-old" || surfaces.root != "/projects/old" || surfaces.title != "Old"+titleSuffix {
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
	if len(fake.posted) != 0 {
		t.Fatalf("root mismatch published project state: %v", fake.posted)
	}
}

// contract: projects.release-rolls-back-staged-owner
func TestProjectReleaseRollsBackOnlyTheStagedOwner(t *testing.T) {
	host, surfaces, fake, _ := projectOpenFixture(t)
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
	surfaces.shown, surfaces.root, surfaces.title = "prj-old", oldRoot.Root, "Old"+titleSuffix
	surfaces.sidecars = &Sidecars{owners: map[string]SidecarOwner{}}
	host.owners["prj-old"], host.owners["prj-next"], host.owners["prj-other"] = surfaces, surfaces, surfaces
	fake.posted = nil
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
	if surfaces.shown != "prj-old" || surfaces.root != oldRoot.Root || surfaces.title != "Old"+titleSuffix {
		t.Fatalf("release changed committed state: shown=%q root=%q title=%q", surfaces.shown, surfaces.root, surfaces.title)
	}
	if len(fake.posted) != 0 {
		t.Fatalf("release of an unshown project published state: %v", fake.posted)
	}
}

// contract: host-calls.decode.messages, projects.shown.requires-project-field
func TestProjectShownRejectsMalformedArgumentsWithoutMutation(t *testing.T) {
	host, surfaces, fake, ctx := projectOpenFixture(t)
	fake.posted = nil
	surfaces.shown, surfaces.root, surfaces.title = "prj-old", "/projects/old", "Old"+titleSuffix
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
			if surfaces.shown != "prj-old" || surfaces.root != "/projects/old" || surfaces.title != "Old"+titleSuffix {
				t.Fatalf("malformed request changed shown state: shown=%q root=%q title=%q", surfaces.shown, surfaces.root, surfaces.title)
			}
			if !surfaces.pendingProjects["prj-next"] || host.owners["prj-next"] != surfaces {
				t.Fatal("malformed request changed staged project ownership")
			}
			if len(fake.posted) != 0 {
				t.Fatalf("malformed request published project state: %v", fake.posted)
			}
		})
	}
}

// contract: project.shown.ignores-unknown-fields
func TestProjectShownIgnoresUnknownOuterAndNestedFields(t *testing.T) {
	host, surfaces, _, ctx := projectOpenFixture(t)
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
	if surfaces.shown != "prj-one" || surfaces.root != root.Root || surfaces.title != "One"+titleSuffix {
		t.Fatalf("recognized project fields were not committed: shown=%q root=%q title=%q", surfaces.shown, surfaces.root, surfaces.title)
	}
}
