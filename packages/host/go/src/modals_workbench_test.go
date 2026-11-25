package host

import (
	"testing"
	"unsafe"
)

// A dialog that the workbench draws itself blurs the documents of the window and each document created while it is open.
// contract: modal.dialog-blurs-each-document-and-image-region
func TestAWorkbenchDialogBlursTheDocuments(t *testing.T) {
	probe := newRegionsProbe(t)
	s := &Surfaces{invoke: func(work func()) { work() }, documents: NewDocuments(), images: NewImages()}
	key := DocumentKey{Surface: "tab-1", Name: "page"}
	if err := s.documents.Reserve(key); err != nil {
		t.Fatal(err)
	}
	s.documents.Set(key, probe.document)
	if s.dialog() {
		t.Fatal("a dialog is open before the workbench tells of one")
	}
	runOnMainThread(func() { s.setWorkbenchDialog(true) })
	if !s.dialog() || !probe.documentBlurred(t) {
		t.Fatalf("with a dialog open the state is %v and the document has the background %v", s.dialog(), probe.documentBlurred(t))
	}
	runOnMainThread(func() { s.setWorkbenchDialog(false) })
	if s.dialog() || probe.documentBlurred(t) {
		t.Fatalf("after the dialog the state is %v and the document has the background %v", s.dialog(), probe.documentBlurred(t))
	}
}

// A workbench's dialog claim belongs to that workbench, not to the persistent
// native window. Its successor must not inherit a claim that no longer exists.
// contract: modal.workbench-dialog.new-workbench-ends-the-claim
func TestAWorkbenchStartingEndsItsPredecessorsDialogBackground(t *testing.T) {
	probe := newRegionsProbe(t)
	s := NewSurfaces(nil, sidecarSessionSurfaces(t).sidecars)
	s.invoke = func(work func()) { work() }
	s.reloadCancelLayout = func() error { return nil }
	s.reloadKeysPageEnded = func() {}
	s.reloadHideSurface = func(unsafe.Pointer, bool) {}
	s.reloadCloseImage = func(unsafe.Pointer) {}
	s.events = func(string, any) {}
	owner := &Host{windows: map[uint]*Surfaces{1: s}, workspace: NewWorkspace(t.TempDir()),
		relay: &Relay[relayTarget]{waiting: map[uint64]*relayWaiter[relayTarget]{}}}
	s.host = owner
	key := DocumentKey{Surface: "tab-old", Name: "page"}
	if err := s.documents.Reserve(key); err != nil {
		t.Fatal(err)
	}
	s.documents.Set(key, probe.document)
	imageKey := ImageKey{Surface: "tab-old", Name: "view"}
	if err := s.images.Reserve(imageKey, &ImageOwner{SidecarName: "fixture-sidecar", SidecarOwner: s}); err != nil {
		t.Fatal(err)
	}
	if !s.images.Set(imageKey, probe.image) {
		t.Fatal("image registration failed")
	}
	runOnMainThread(func() { s.setWorkbenchDialog(true) })
	if !s.dialog() || !probe.documentBlurred(t) || !probe.imageBlurred(t) {
		t.Fatal("the predecessor's dialog did not own the initial native backgrounds")
	}
	var starting error
	runOnMainThread(func() { starting = owner.pageStarting(s) })
	if starting != nil {
		t.Fatal(starting)
	}
	if s.dialog() {
		t.Error("the successor inherited its predecessor's dialog claim")
	}
	if probe.documentBlurred(t) || probe.imageBlurred(t) {
		t.Error("the predecessor's native document/image backgrounds were not cleared")
	}
	newImage := probe.moreImage(t, "successor")
	newKey := ImageKey{Surface: "tab-new", Name: "view"}
	if err := s.images.Reserve(newKey, &ImageOwner{SidecarName: "fixture-sidecar", SidecarOwner: s}); err != nil {
		t.Fatal(err)
	}
	if !s.images.Set(newKey, newImage) {
		t.Fatal("successor image registration failed")
	}
	// This is the same registration-time policy call as attachImage, after Set.
	runOnMainThread(func() { s.seatImageBackground("tab-1", newImage) })
	var blurred bool
	runOnMainThread(func() { blurred = nativeImageBlurred(t, newImage) })
	if blurred {
		t.Error("the successor's new image was blurred without a dialog")
	}
}

// contract: modal.workbench-dialog.end-keeps-a-modal-dialog-background
func TestEndingAWorkbenchDialogPreservesACurrentNativeDialogBackground(t *testing.T) {
	probe := newRegionsProbe(t)
	s := &Surfaces{invoke: func(work func()) { work() }, documents: NewDocuments(), images: NewImages()}
	key := ImageKey{Surface: "tab-current", Name: "view"}
	if err := s.images.Reserve(key, &ImageOwner{SidecarName: "fixture-sidecar", SidecarOwner: s}); err != nil {
		t.Fatal(err)
	}
	if !s.images.Set(key, probe.image) {
		t.Fatal("image registration failed")
	}
	s.modal = &modal{content: OverlayContent{Mode: "dialog"}}
	runOnMainThread(func() {
		s.setWorkbenchDialog(true)
		s.setWorkbenchDialog(false)
	})
	if !s.dialog() {
		t.Error("the native dialog lost its independent background claim")
	}
	if !probe.imageBlurred(t) {
		t.Error("ending the workbench dialog unblurred the image under a current native dialog")
	}
}

// A dialog surface that a placement shows is a dialog of the window: the host blurs every document and image region of the other
// surfaces and none of the dialog surface, and a placement without the dialog surface ends the blur (docs/spec/plugins.md#dialogs).
// contract: modal.dialog-surface-blurs-the-other-documents
func TestAPlacedDialogSurfaceBlursTheOtherDocumentsButNotItsOwn(t *testing.T) {
	probe := newRegionsProbe(t)
	s := &Surfaces{invoke: func(work func()) { work() }, documents: NewDocuments(), images: NewImages()}
	documentKey := DocumentKey{Surface: "tab-1", Name: "page"}
	if err := s.documents.Reserve(documentKey); err != nil {
		t.Fatal(err)
	}
	s.documents.Set(documentKey, probe.document)
	imageKey := ImageKey{Surface: "dialog/probe/edit", Name: "viewer"}
	if err := s.images.Reserve(imageKey, &ImageOwner{SidecarName: "viewer-sidecar", SidecarOwner: imageStatusTestOwner{}}); err != nil {
		t.Fatal(err)
	}
	s.images.Set(imageKey, probe.image)
	runOnMainThread(func() {
		s.placedDialog([]Placement{{ID: "tab-1", Visible: true}, {ID: "dialog/probe/edit", Visible: true}})
	})
	if !s.dialog() || !probe.documentBlurred(t) || probe.imageBlurred(t) {
		t.Fatalf("with the dialog surface shown the state is %v, the other document has the background %v and the region of the dialog %v",
			s.dialog(), probe.documentBlurred(t), probe.imageBlurred(t))
	}
	if s.backgroundOf("dialog/probe/edit") || !s.backgroundOf("tab-1") {
		t.Fatal("a region made for the dialog surface is blurred or a region made for another surface is not")
	}
	runOnMainThread(func() {
		s.placedDialog([]Placement{{ID: "tab-1", Visible: true}, {ID: "dialog/probe/edit", Visible: false}})
	})
	if s.dialog() || probe.documentBlurred(t) {
		t.Fatalf("with the dialog surface hidden the state is %v and the document has the background %v", s.dialog(), probe.documentBlurred(t))
	}
}

// F1128-2: the settings surface is a part of the settings window, so the background of the settings window blurs every other region
// and none of the settings surface (docs/spec/native-modals.md#settings-surface).
func TestTheBackgroundOfTheSettingsWindowLeavesTheSettingsSurfaceUnblurred(t *testing.T) {
	probe := newRegionsProbe(t)
	s := &Surfaces{invoke: func(work func()) { work() }, documents: NewDocuments(), images: NewImages()}
	documentKey := DocumentKey{Surface: "settings/probe", Name: "login"}
	if err := s.documents.Reserve(documentKey); err != nil {
		t.Fatal(err)
	}
	s.documents.Set(documentKey, probe.document)
	imageKey := ImageKey{Surface: "tab-1", Name: "viewer"}
	if err := s.images.Reserve(imageKey, &ImageOwner{SidecarName: "viewer-sidecar", SidecarOwner: imageStatusTestOwner{}}); err != nil {
		t.Fatal(err)
	}
	s.images.Set(imageKey, probe.image)
	s.mu.Lock()
	s.workbenchDialog = true
	s.mu.Unlock()
	runOnMainThread(func() { s.setBackground() })
	if probe.documentBlurred(t) || !probe.imageBlurred(t) {
		t.Fatalf("with the settings window open the region of the settings surface has the background %v and the region of a tab %v",
			probe.documentBlurred(t), probe.imageBlurred(t))
	}
	if s.backgroundOf("settings/probe") || !s.backgroundOf("tab-1") {
		t.Fatal("a region made for the settings surface is blurred or a region made for a tab is not")
	}
}

// The placement that first shows a dialog surface starts a key wait of the window, which the keyboard of the dialog surface ends, so the
// keys that waited go to the dialog; a placement that hides the dialog before it took the keyboard ends the wait too
// (docs/spec/plugins.md#dialogs).
// contract: keyboard.dialog-surface-key-wait
func TestTheKeysWaitForTheDialogSurfaceUntilItTakesTheKeyboard(t *testing.T) {
	s := &Surfaces{invoke: func(work func()) { work() }, documents: NewDocuments(), images: NewImages()}
	shown := []Placement{{ID: "tab-1", Visible: true}, {ID: "dialog/probe/edit", Visible: true}}
	s.placedDialog(shown)
	if !s.dialogKeys {
		t.Fatal("the first placement of the dialog surface starts no key wait")
	}
	s.placedDialog(shown)
	s.dialogKeysFocused("tab-1")
	if !s.dialogKeys {
		t.Fatal("a placement of the shown dialog or the keyboard of another surface ended the key wait")
	}
	s.dialogKeysFocused("dialog/probe/edit")
	if s.dialogKeys {
		t.Fatal("the keyboard of the dialog surface does not end the key wait")
	}
	s.placedDialog(shown)
	if s.dialogKeys {
		t.Fatal("a later placement of the same dialog starts another key wait")
	}
	s.placedDialog(nil)
	s.placedDialog(shown)
	s.placedDialog(nil)
	if s.dialogKeys {
		t.Fatal("a placement without the dialog surface leaves its key wait")
	}
}
