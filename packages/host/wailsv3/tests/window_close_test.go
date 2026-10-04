package host_test

import (
	"errors"
	"reflect"
	"strings"
	"testing"
	"unsafe"

	host "github.com/soksak-app/core/packages/host/wailsv3/src"
)

// contract: window-close.surfaces.closes-regions-then-surface
func TestClosingAWindowClosesEachSurfaceAfterItsRegions(t *testing.T) {
	var document1, image1, surface1, document2, surface2 int
	documents := host.NewDocuments()
	images := host.NewImages()
	for key, handle := range map[host.DocumentKey]unsafe.Pointer{
		{Surface: "tab-1", Name: "page"}: unsafe.Pointer(&document1),
		{Surface: "tab-2", Name: "page"}: unsafe.Pointer(&document2),
	} {
		if err := documents.Reserve(key); err != nil {
			t.Fatal(err)
		}
		if !documents.Set(key, handle) {
			t.Fatalf("document %v was not attached", key)
		}
	}
	// 만드는 중인 문서 영역은 닫을 핸들이 없다.
	pending := host.DocumentKey{Surface: "tab-2", Name: "pending"}
	if err := documents.Reserve(pending); err != nil {
		t.Fatal(err)
	}
	view := host.ImageKey{Surface: "tab-1", Name: "view"}
	if err := images.Reserve(view, &host.ImageOwner{SidecarName: "sidecar", SidecarOwner: newFakeImageOwner("")}); err != nil {
		t.Fatal(err)
	}
	if !images.Set(view, unsafe.Pointer(&image1)) {
		t.Fatal("the image was not attached")
	}
	surfaces := map[string]unsafe.Pointer{"tab-2": unsafe.Pointer(&surface2), "tab-1": unsafe.Pointer(&surface1)}
	var closed []host.WindowNative
	err := host.CloseWindowSurfaces(surfaces, documents, images, func(native host.WindowNative) error {
		closed = append(closed, native)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	want := []host.WindowNative{
		{Kind: host.WindowNativeDocument, Handle: unsafe.Pointer(&document1)},
		{Kind: host.WindowNativeImage, Handle: unsafe.Pointer(&image1)},
		{Kind: host.WindowNativeSurface, Handle: unsafe.Pointer(&surface1)},
		{Kind: host.WindowNativeDocument, Handle: unsafe.Pointer(&document2)},
		{Kind: host.WindowNativeSurface, Handle: unsafe.Pointer(&surface2)},
	}
	if !reflect.DeepEqual(closed, want) {
		t.Fatalf("closed %v, want %v", closed, want)
	}
	if names := documents.Names(); len(names) != 0 {
		t.Fatalf("the closed surfaces keep document names %v", names)
	}
	if err := documents.Reserve(pending); err != nil {
		t.Fatalf("the closed surface keeps its pending document name: %v", err)
	}
	if left := images.RemoveSurface("tab-1"); len(left) != 0 {
		t.Fatalf("the closed surface keeps %d images", len(left))
	}
}

// contract: window-close.surfaces.reports-every-failure
func TestClosingAWindowReportsEveryFailureAndClosesTheRest(t *testing.T) {
	var document1, surface1, surface2 int
	documents := host.NewDocuments()
	images := host.NewImages()
	key := host.DocumentKey{Surface: "tab-1", Name: "page"}
	if err := documents.Reserve(key); err != nil {
		t.Fatal(err)
	}
	if !documents.Set(key, unsafe.Pointer(&document1)) {
		t.Fatal("the document was not attached")
	}
	surfaces := map[string]unsafe.Pointer{"tab-1": unsafe.Pointer(&surface1), "tab-2": unsafe.Pointer(&surface2)}
	var closed []host.WindowNative
	err := host.CloseWindowSurfaces(surfaces, documents, images, func(native host.WindowNative) error {
		closed = append(closed, native)
		switch {
		case native.Kind == host.WindowNativeDocument:
			return errors.New("document failed")
		case native.Handle == unsafe.Pointer(&surface2):
			return errors.New("surface failed")
		}
		return nil
	})
	want := []host.WindowNative{
		{Kind: host.WindowNativeDocument, Handle: unsafe.Pointer(&document1)},
		{Kind: host.WindowNativeSurface, Handle: unsafe.Pointer(&surface1)},
		{Kind: host.WindowNativeSurface, Handle: unsafe.Pointer(&surface2)},
	}
	if !reflect.DeepEqual(closed, want) {
		t.Fatalf("closed %v, want %v", closed, want)
	}
	if err == nil || !strings.Contains(err.Error(), "document failed") || !strings.Contains(err.Error(), "surface failed") {
		t.Fatalf("error %v, want both failures", err)
	}
}
