package host

import (
	"errors"
	"reflect"
	"testing"
	"unsafe"

	"github.com/soksak-app/core/packages/host/wailsv3/src/platform"
)

// contract: exposure.host-window.reads-during-surface-close
func TestSurfaceNameIsForgottenInTheStepThatClosesItsNativeView(t *testing.T) {
	s := &Surfaces{named: map[uintptr]string{}}
	// A view without a native handle closes without calling the native code.
	view := &nativeWebview{owner: s}
	s.named[uintptr(view.handle)] = "tab-2"
	namesAfterStep := -1
	// The step runs at once, as the UI thread would run it. The names are read after the step returns, which is when a
	// window status reading on the UI thread that follows the close would see them.
	run := func(step func()) {
		step()
		namesAfterStep = len(s.named)
	}
	s.closeRegisteredSurface(run, view)
	if namesAfterStep != 0 {
		t.Fatalf("names after the close step: got %d, want 0 (tab-2 is still named after its native view closed)", namesAfterStep)
	}
}

// contract: exposure.host-window.reads-during-surface-creation
func TestSurfaceIsNamedWhenItsNativeViewIsCreated(t *testing.T) {
	s := &Surfaces{named: map[uintptr]string{}}
	native := new(int)
	// The creation runs its step at once, as the UI thread would run it.
	view, err := s.createRegisteredSurface(func(step func()) { step() }, "tab-4leevm", func() (unsafe.Pointer, error) {
		return unsafe.Pointer(native), nil
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if got := s.viewNames()[uint64(uintptr(view.handle))]; got != "tab-4leevm" {
		t.Fatalf("native view of tab-4leevm is named %q after creation", got)
	}
	// A failed creation names nothing.
	_, err = s.createRegisteredSurface(func(step func()) { step() }, "tab-6", func() (unsafe.Pointer, error) {
		return nil, errors.New("no window")
	})
	if err == nil || len(s.named) != 1 {
		t.Fatalf("failed creation: err %v, names %d", err, len(s.named))
	}
}

// contract: exposure.host-window.unregistered-surface-named
func TestUnregisteredNativeSurfaceViewFailsWithItsAddress(t *testing.T) {
	named := map[uint64]string{7: "tab-2"}
	id, err := registeredSurface(named, 7)
	if err != nil || id != "tab-2" {
		t.Fatalf("registered view: id %q, err %v; want tab-2 and no error", id, err)
	}
	_, err = registeredSurface(named, 9)
	if err == nil || err.Error() != "unregistered native surface 9" {
		t.Fatalf("unregistered view: err %v; want unregistered native surface 9", err)
	}
}

// viewPlatform is the platform of the view tests. It records the document web views that are created with their configuration and
// the addresses that they load. Every other operation of the platform interface is not implemented by it.
type viewPlatform struct {
	platform.Platform
	created []viewCreation
	loaded  []string
}

type viewCreation struct {
	folder, plugin string
	view           bool
}

func (p *viewPlatform) CreateDocument(surface unsafe.Pointer, directory, folder, plugin string, view bool, changed func(state string)) (unsafe.Pointer, error) {
	p.created = append(p.created, viewCreation{folder: folder, plugin: plugin, view: view})
	return unsafe.Pointer(new(int)), nil
}

func (p *viewPlatform) LoadDocument(document unsafe.Pointer, url string) bool {
	p.loaded = append(p.loaded, url)
	return true
}

func (p *viewPlatform) PlaceDocument(document unsafe.Pointer, left, top, right, bottom float64, visible bool) {
}

func (p *viewPlatform) CloseDocument(document unsafe.Pointer) {}

// contract: view.create-loads-page
func TestViewSurfaceCreatesViewConfigurationAndLoadsItsPage(t *testing.T) {
	fake := &viewPlatform{}
	saved := system
	system = fake
	t.Cleanup(func() { system = saved })
	s := &Surfaces{documents: NewDocuments()}
	if err := s.attachView("probe-surface", unsafe.Pointer(new(int)), "/config/document-data", "/plugins/probe", "probe", "ui/page.html"); err != nil {
		t.Fatalf("attach view: %v", err)
	}
	if len(fake.created) != 1 || !fake.created[0].view || fake.created[0].plugin != "probe" || fake.created[0].folder != "/plugins/probe" {
		t.Fatalf("created documents: %+v, want one view configuration of plugin probe in its folder", fake.created)
	}
	if want := []string{"sok://probe/ui/page.html"}; !reflect.DeepEqual(fake.loaded, want) {
		t.Fatalf("loaded addresses: %v, want %v", fake.loaded, want)
	}
	if _, err := s.documents.Get(DocumentKey{Surface: "probe-surface", Name: viewRegionName}); err != nil {
		t.Fatalf("the view is not recorded for its surface: %v", err)
	}
}

func TestViewCompositionDeclaresPageWithOptionalRegions(t *testing.T) {
	if err := validateComposition(SurfaceComposition{Kind: "view", Page: "ui/page.html"}); err != nil {
		t.Fatalf("view without regions: %v", err)
	}
	document := SurfaceRegion{Name: "page", Kind: "document", Input: "native"}
	if err := validateComposition(SurfaceComposition{Kind: "view", Page: "ui/page.html", Regions: []SurfaceRegion{document}, Overlays: []string{}}); err != nil {
		t.Fatalf("view with a region: %v", err)
	}
	for _, composition := range []SurfaceComposition{
		{Kind: "view"},
		{Kind: "view", Page: "../page.html"},
		{Kind: "view", Page: "ui/page.js"},
		{Kind: "view", Page: "ui/.binary/page.html"},
		{Kind: "hybrid", Page: "ui/page.html", Regions: []SurfaceRegion{document}, Overlays: []string{}},
	} {
		if err := validateComposition(composition); err == nil {
			t.Fatalf("composition %+v is accepted", composition)
		}
	}
}
