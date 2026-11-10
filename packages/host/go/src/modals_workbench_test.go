package host

import (
	"reflect"
	"testing"
	"unsafe"
)

// A dialog that the workbench draws itself blurs the documents of the window and each document created while it is open.
// contract: modal.dialog-blurs-each-document-and-image-region
func TestAWorkbenchDialogBlursTheDocuments(t *testing.T) {
	fake := &creationPlatform{}
	useCreationPlatform(t, fake)
	s := &Surfaces{invoke: func(work func()) { work() }, documents: NewDocuments(), images: NewImages()}
	key := DocumentKey{Surface: "tab-1", Name: "page"}
	if err := s.documents.Reserve(key); err != nil {
		t.Fatal(err)
	}
	s.documents.Set(key, unsafe.Pointer(new(int)))
	if s.dialog() {
		t.Fatal("a dialog is open before the workbench tells of one")
	}
	s.setWorkbenchDialog(true)
	if !s.dialog() || !reflect.DeepEqual(fake.steps, []string{"background"}) {
		t.Fatalf("with a dialog open the state is %v and the document ran %v", s.dialog(), fake.steps)
	}
	s.setWorkbenchDialog(false)
	if s.dialog() || !reflect.DeepEqual(fake.steps, []string{"background", "background"}) {
		t.Fatalf("after the dialog the state is %v and the document ran %v", s.dialog(), fake.steps)
	}
}

// A workbench's dialog claim belongs to that workbench, not to the persistent
// native window. Its successor must not inherit a claim that no longer exists.
// contract: modal.workbench-dialog.new-workbench-ends-the-claim
func TestAWorkbenchStartingEndsItsPredecessorsDialogBackground(t *testing.T) {
	saved := system
	t.Cleanup(func() { system = saved })
	recorder := &blurPlatform{documents: map[unsafe.Pointer]bool{}, images: map[unsafe.Pointer]bool{}}
	system = recorder
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
	document := unsafe.Pointer(new(byte))
	image := unsafe.Pointer(new(byte))
	key := DocumentKey{Surface: "tab-old", Name: "page"}
	if err := s.documents.Reserve(key); err != nil {
		t.Fatal(err)
	}
	s.documents.Set(key, document)
	imageKey := ImageKey{Surface: "tab-old", Name: "view"}
	if err := s.images.Reserve(imageKey, &ImageOwner{SidecarName: "fixture-sidecar", SidecarOwner: s}); err != nil {
		t.Fatal(err)
	}
	if !s.images.Set(imageKey, image) {
		t.Fatal("image registration failed")
	}
	s.setWorkbenchDialog(true)
	if !s.dialog() || !recorder.documents[document] || !recorder.images[image] {
		t.Fatal("the predecessor's dialog did not own the initial native backgrounds")
	}
	if err := owner.pageStarting(s); err != nil {
		t.Fatal(err)
	}
	if s.dialog() {
		t.Error("the successor inherited its predecessor's dialog claim")
	}
	if recorder.documents[document] || recorder.images[image] {
		t.Error("the predecessor's native document/image backgrounds were not cleared")
	}
	newImage := unsafe.Pointer(new(byte))
	newKey := ImageKey{Surface: "tab-new", Name: "view"}
	if err := s.images.Reserve(newKey, &ImageOwner{SidecarName: "fixture-sidecar", SidecarOwner: s}); err != nil {
		t.Fatal(err)
	}
	if !s.images.Set(newKey, newImage) {
		t.Fatal("successor image registration failed")
	}
	// This is the same registration-time policy call as attachImage, after Set.
	s.seatImageBackground(newImage)
	if blurred, seen := recorder.images[newImage]; !seen || blurred {
		t.Errorf("the successor's new image was blurred without a dialog: seen=%t blurred=%t", seen, blurred)
	}
}

// contract: modal.workbench-dialog.end-keeps-a-modal-dialog-background
func TestEndingAWorkbenchDialogPreservesACurrentNativeDialogBackground(t *testing.T) {
	saved := system
	t.Cleanup(func() { system = saved })
	recorder := &blurPlatform{documents: map[unsafe.Pointer]bool{}, images: map[unsafe.Pointer]bool{}}
	system = recorder
	s := &Surfaces{invoke: func(work func()) { work() }, documents: NewDocuments(), images: NewImages()}
	image := unsafe.Pointer(new(byte))
	key := ImageKey{Surface: "tab-current", Name: "view"}
	if err := s.images.Reserve(key, &ImageOwner{SidecarName: "fixture-sidecar", SidecarOwner: s}); err != nil {
		t.Fatal(err)
	}
	if !s.images.Set(key, image) {
		t.Fatal("image registration failed")
	}
	s.modal = &modal{content: OverlayContent{Mode: "dialog"}}
	s.setWorkbenchDialog(true)
	s.setWorkbenchDialog(false)
	if !s.dialog() {
		t.Error("the native dialog lost its independent background claim")
	}
	if !recorder.images[image] {
		t.Error("ending the workbench dialog unblurred the image under a current native dialog")
	}
}
