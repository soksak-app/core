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
	request, err := json.Marshal(map[string]any{"project": map[string]string{"id": "prj-one", "root": root, "title": "One"}})
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
