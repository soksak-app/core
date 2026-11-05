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
