package host

import (
	"os"
	"path/filepath"
	"testing"
	"unsafe"
)

// queueOnMainThread queues task as a step of the main thread without waiting for it, and returns the channel that closes when the step ran.
// The steps run in the order in which they were queued, so a step that the caller runs next with runOnMainThread runs after task.
func queueOnMainThread(task func()) <-chan struct{} {
	done := make(chan struct{})
	mainThread.Lock()
	mainThread.steps = append(mainThread.steps, func() {
		defer close(done)
		task()
	})
	mainThread.Unlock()
	mainThread.signal(mainThread.source)
	mainThread.wake(mainThread.loop)
	return done
}

// documentAttachSurfaces returns the probe of a real window whose surface probe-surface of the installed plugin probe declares the document
// region page. A task that the test queues with queueOnMainThread runs ahead of the main-thread step of the next attach.
func documentAttachSurfaces(t *testing.T) *viewProbe {
	t.Helper()
	p := newViewProbe(t, Theme{})
	// The data store of the document regions is in the folder of the view store, whose stores the run of the tests ends before it removes
	// the folder: WebKit writes to a data store after its documents closed, until the store ends.
	config, err := os.MkdirTemp(viewStoreDirectory(t), "config-")
	if err != nil {
		t.Fatal(err)
	}
	for name, content := range map[string]string{
		"plugins/installed.json":           `{"format": 3, "plugins": {"probe": {"version": "1.0.0", "path": "plugins/probe/1.0.0", "enabled": true, "sidecars": {}}}, "sidecars": {}}`,
		"plugins/probe/1.0.0/package.json": `{"name": "plugin-probe"}`,
		"plugins/probe/1.0.0/plugin.json":  `{"id": "probe"}`,
	} {
		file := filepath.Join(config, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(file, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	p.s.host.configDir = config
	p.s.surfacePlugins = map[string]string{"probe-surface": "probe"}
	p.s.compositions = map[string]SurfaceComposition{"probe-surface": {Kind: "view", Regions: []SurfaceRegion{
		{Name: "page", Kind: "document"},
	}}}
	return p
}

// contract: documents.attach.one-main-step
func TestAReloadDuringADocumentAttachLeavesNoRegionWithoutAName(t *testing.T) {
	p := documentAttachSurfaces(t)
	surfaces := p.s
	key, request := DocumentKey{Surface: "probe-surface", Name: "page"}, DocumentRequest{Surface: "probe-surface", Document: "page"}
	before := p.webviews(t)
	t.Cleanup(func() { runOnMainThread(func() { surfaces.closeSurfaceDocuments("probe-surface") }) })
	// The reload of the surface and the attach of its new page, which run on the main thread ahead of the main-thread work of the first attach.
	var attachedAgain error
	reloaded := queueOnMainThread(func() {
		surfaces.streams.RemoveSurface("probe-surface")
		for _, handle := range surfaces.documents.RemoveSurface("probe-surface") {
			system.CloseDocument(handle)
		}
		attachedAgain = surfaces.attachDocumentOnMain(key, "")
	})
	if err := surfaces.attachCheckedDocument(key, request); err == nil {
		t.Fatal("two attaches of one name succeeded")
	}
	<-reloaded
	if attachedAgain != nil {
		t.Fatalf("the attach of the new page: %v", attachedAgain)
	}
	if _, err := surfaces.documents.Get(key); err != nil {
		t.Fatalf("the name of the new page: %v", err)
	}
	if after := p.webviews(t); after != before+1 {
		t.Fatalf("the window holds %d web views, want the %d of the new page: a region has no name or the new page has none", after, before+1)
	}
}

// contract: documents.attach.one-main-step
func TestASurfaceCloseDuringADocumentAttachFindsNoNameOfTheAttach(t *testing.T) {
	p := documentAttachSurfaces(t)
	surfaces := p.s
	key, request := DocumentKey{Surface: "probe-surface", Name: "page"}, DocumentRequest{Surface: "probe-surface", Document: "page"}
	before := p.webviews(t)
	var found []unsafe.Pointer
	closed := queueOnMainThread(func() {
		surfaces.streams.RemoveSurface("probe-surface")
		found = surfaces.documents.RemoveSurface("probe-surface")
		delete(surfaces.views, "probe-surface")
		delete(surfaces.compositions, "probe-surface")
	})
	if err := surfaces.attachCheckedDocument(key, request); err == nil {
		t.Fatal("the attach of a closed surface succeeded")
	}
	<-closed
	if after := p.webviews(t); after != before {
		t.Fatalf("the attach created %d regions in a closed surface", after-before)
	}
	if len(found) != 0 {
		t.Fatalf("the close found %d names of an attach that holds them across the steps of the main thread", len(found))
	}
}

// contract: documents.attach.one-main-step
func TestAFailedDocumentAttachTakesBackItsNameAndItsRequestLog(t *testing.T) {
	p := documentAttachSurfaces(t)
	surfaces := p.s
	delete(surfaces.surfacePlugins, "probe-surface")
	key, request := DocumentKey{Surface: "probe-surface", Name: "page"}, DocumentRequest{Surface: "probe-surface", Document: "page"}
	if err := surfaces.attachCheckedDocument(key, request); err == nil {
		t.Fatal("the attach of a surface without a plugin succeeded")
	}
	if err := surfaces.documents.Reserve(key); err != nil {
		t.Fatalf("the failed attach kept its name: %v", err)
	}
	if _, err := surfaces.streams.Attach(key); err != nil {
		t.Fatalf("the failed attach kept its request log: %v", err)
	}
}
