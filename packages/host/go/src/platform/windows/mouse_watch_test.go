package windows

import (
	"errors"
	"reflect"
	"testing"

	"github.com/soksak-app/core/packages/host/go/src/platform"
)

const (
	leftDown, leftUp   uint16 = 0x0001, 0x0002
	rightDown, rightUp uint16 = 0x0004, 0x0008
	wheel              uint16 = 0x0400
)

type fakeMouse struct {
	swap        bool
	window      uintptr
	views       []uintptr
	x, y        float64
	hitErr, err error
	hits        int
}

func (m *fakeMouse) swapped() bool { return m.swap }
func (m *fakeMouse) hit() (uintptr, []uintptr, error) {
	m.hits++
	return m.window, m.views, m.hitErr
}
func (m *fakeMouse) position(uintptr) (float64, float64, error) { return m.x, m.y, m.err }

// newMouseSource makes a source whose tasks wait in the returned queue, as they wait for the UI thread.
func newMouseSource(system mouseSystem) (*mouseSource, *[]func(), *[]error) {
	tasks, errs := &[]func(){}, &[]error{}
	return &mouseSource{
		system: system,
		post:   func(task func()) { *tasks = append(*tasks, task) },
		report: func(err error) { *errs = append(*errs, err) },
	}, tasks, errs
}

func runTasks(tasks *[]func()) {
	for _, task := range *tasks {
		task()
	}
	*tasks = nil
}

type step struct {
	phase int
	x, y  float64
}

// watchSurface watches window 7, in which view is the surface.
func watchSurface(source *mouseSource, surface uintptr) (*[]uintptr, *[]step, uintptr) {
	asked, steps := &[]uintptr{}, &[]step{}
	monitor := source.watch(7, platform.Input{
		Press: func(view uintptr) bool {
			*asked = append(*asked, view)
			return view == surface
		},
		Point: func(phase int, x, y float64) { *steps = append(*steps, step{phase, x, y}) },
	})
	return asked, steps, monitor
}

// contract: platform.windows.mouse.mask-follows-raw-input-buttons
func TestTheMaskFollowsEveryButtonOfARawInput(t *testing.T) {
	for _, test := range []struct {
		flags uint16
		from  uint64
		want  uint64
		named bool
	}{
		{0x0001, 0, 1 << 0, true}, {0x0002, 1 << 0, 0, true},
		{0x0004, 0, 1 << 1, true}, {0x0008, 1 << 1, 0, true},
		{0x0010, 0, 1 << 2, true}, {0x0020, 1 << 2, 0, true},
		{0x0040, 0, 1 << 3, true}, {0x0080, 1 << 3, 0, true},
		{0x0100, 0, 1 << 4, true}, {0x0200, 1 << 4, 0, true},
		{0x0003, 0, 0, true},
		{wheel, 1 << 1, 1 << 1, false},
		{0, 1 << 1, 1 << 1, false},
	} {
		got, named := nextMouseButtons(test.from, test.flags)
		if got != test.want || named != test.named {
			t.Errorf("flags %#x from %#x: %#x %v, want %#x %v", test.flags, test.from, got, named, test.want, test.named)
		}
	}
}

// contract: platform.windows.mouse.held-buttons-name-their-bits
func TestTheHeldButtonsNameTheirBits(t *testing.T) {
	mask := mouseButtonsHeld(func(key int) bool { return key == 0x02 || key == 0x06 })
	if mask != 1<<1|1<<4 {
		t.Fatalf("mask %#x", mask)
	}
}

// contract: platform.windows.mouse.button-watch-reports-mask-from-its-start
func TestEveryButtonInputReportsItsMaskOnTheUIThread(t *testing.T) {
	source, tasks, _ := newMouseSource(&fakeMouse{})
	source.mask = 1 << 1
	var masks []uint64
	if err := source.setChanged(func(mask uint64) { masks = append(masks, mask) }); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(masks, []uint64{1 << 1}) {
		t.Fatalf("the installation reported %v", masks)
	}
	source.receive(rightDown)
	source.receive(leftDown)
	source.receive(0)
	source.receive(wheel)
	source.receive(leftUp)
	if len(masks) != 1 {
		t.Fatalf("a report ran outside the UI thread: %v", masks)
	}
	runTasks(tasks)
	if want := []uint64{1 << 1, 1 << 1, 1<<1 | 1<<0, 1 << 1}; !reflect.DeepEqual(masks, want) {
		t.Fatalf("masks %v, want %v", masks, want)
	}
}

// contract: platform.windows.mouse.second-button-watch-is-refused
func TestASecondButtonWatchIsRefused(t *testing.T) {
	source, _, _ := newMouseSource(&fakeMouse{})
	if err := source.setChanged(func(uint64) {}); err != nil {
		t.Fatal(err)
	}
	if err := source.setChanged(func(uint64) {}); err == nil {
		t.Fatal("a second watch was accepted")
	}
}

// contract: platform.windows.mouse.drag-over-surface-reaches-window-in-order
func TestADragThatStartsOverASurfaceReachesItsWindowInOrder(t *testing.T) {
	system := &fakeMouse{window: 7, views: []uintptr{30, 20, 10}, x: 1, y: 2}
	source, tasks, _ := newMouseSource(system)
	asked, steps, _ := watchSurface(source, 20)
	source.receive(leftDown)
	if len(*asked) != 0 {
		t.Fatalf("the press ran outside the UI thread: %v", *asked)
	}
	runTasks(tasks)
	if want := []uintptr{30, 20}; !reflect.DeepEqual(*asked, want) {
		t.Fatalf("asked %v, want the views up to the surface %v", *asked, want)
	}
	system.x, system.y = 3, 4
	source.receive(0)
	system.x, system.y = 5, 6
	source.receive(leftUp)
	runTasks(tasks)
	if want := []step{{0, 1, 2}, {1, 3, 4}, {2, 5, 6}}; !reflect.DeepEqual(*steps, want) {
		t.Fatalf("steps %v, want %v", *steps, want)
	}
	system.x = 9
	source.receive(0)
	runTasks(tasks)
	if len(*steps) != 3 {
		t.Fatalf("a move after the release arrived: %v", *steps)
	}
}

// contract: platform.windows.mouse.fast-click-still-ends-its-drag
func TestAClickFasterThanTheUIThreadStillEndsItsDrag(t *testing.T) {
	system := &fakeMouse{window: 7, views: []uintptr{20}}
	source, tasks, _ := newMouseSource(system)
	_, steps, _ := watchSurface(source, 20)
	source.receive(leftDown)
	source.receive(leftUp)
	runTasks(tasks)
	if want := []step{{0, 0, 0}, {2, 0, 0}}; !reflect.DeepEqual(*steps, want) {
		t.Fatalf("steps %v, want %v", *steps, want)
	}
}

// contract: platform.windows.mouse.page-drag-never-wakes-ui-thread
func TestADragOfThePageNeverWakesTheUIThread(t *testing.T) {
	system := &fakeMouse{window: 7, views: []uintptr{30}}
	source, tasks, _ := newMouseSource(system)
	_, steps, _ := watchSurface(source, 20)
	source.receive(leftDown)
	runTasks(tasks)
	system.x = 1
	source.receive(0)
	if len(*tasks) != 0 {
		t.Fatalf("a move queued %d tasks", len(*tasks))
	}
	source.receive(leftUp)
	runTasks(tasks)
	if len(*steps) != 0 {
		t.Fatalf("steps %v", *steps)
	}
}

// contract: platform.windows.mouse.move-without-position-change-wakes-nothing
func TestAMoveWithoutAPositionChangeWakesNothing(t *testing.T) {
	system := &fakeMouse{window: 7, views: []uintptr{20}, x: 1}
	source, tasks, _ := newMouseSource(system)
	watchSurface(source, 20)
	source.receive(leftDown)
	runTasks(tasks)
	source.receive(0)
	source.receive(wheel)
	if len(*tasks) != 0 {
		t.Fatalf("queued %d tasks", len(*tasks))
	}
}

// contract: platform.windows.mouse.press-over-another-window-is-not-delivered
func TestAPressOverAnotherWindowIsNotDelivered(t *testing.T) {
	for _, window := range []uintptr{8, 0} {
		system := &fakeMouse{window: window, views: []uintptr{20}}
		source, tasks, _ := newMouseSource(system)
		asked, steps, _ := watchSurface(source, 20)
		source.receive(leftDown)
		source.receive(leftUp)
		runTasks(tasks)
		if len(*asked) != 0 || len(*steps) != 0 {
			t.Fatalf("window %d: asked %v, steps %v", window, *asked, *steps)
		}
	}
}

// contract: platform.windows.mouse.primary-button-follows-system-exchange
func TestThePrimaryButtonFollowsTheSystemExchange(t *testing.T) {
	system := &fakeMouse{window: 7, views: []uintptr{20}, swap: true}
	source, tasks, _ := newMouseSource(system)
	_, steps, _ := watchSurface(source, 20)
	source.receive(leftDown)
	source.receive(leftUp)
	if system.hits != 0 {
		t.Fatal("the secondary button was read as a press")
	}
	source.receive(rightDown)
	source.receive(rightUp)
	runTasks(tasks)
	if want := []step{{0, 0, 0}, {2, 0, 0}}; !reflect.DeepEqual(*steps, want) {
		t.Fatalf("steps %v, want %v", *steps, want)
	}
	if system.hits != 1 {
		t.Fatalf("read %d hits", system.hits)
	}
}

// contract: platform.windows.mouse.secondary-button-is-no-drag
func TestASecondaryButtonIsNoDrag(t *testing.T) {
	system := &fakeMouse{window: 7, views: []uintptr{20}}
	source, tasks, _ := newMouseSource(system)
	asked, _, _ := watchSurface(source, 20)
	source.receive(rightDown)
	runTasks(tasks)
	if len(*asked) != 0 {
		t.Fatalf("asked %v", *asked)
	}
}

// contract: platform.windows.mouse.removed-watch-takes-no-input
func TestAnEndedWatchTakesNoStepThatWasSentToIt(t *testing.T) {
	system := &fakeMouse{window: 7, views: []uintptr{20}}
	source, tasks, _ := newMouseSource(system)
	asked, steps, monitor := watchSurface(source, 20)
	source.receive(leftDown)
	source.unwatch(monitor)
	runTasks(tasks)
	source.receive(leftUp)
	runTasks(tasks)
	source.receive(leftDown)
	runTasks(tasks)
	if len(*asked) != 0 || len(*steps) != 0 {
		t.Fatalf("asked %v, steps %v", *asked, *steps)
	}
}

// contract: platform.windows.mouse.read-failure-is-reported-and-release-ends-drag
func TestAReadFailureIsReportedAndAReleaseStillEndsTheDrag(t *testing.T) {
	system := &fakeMouse{window: 7, views: []uintptr{20}, x: 1, y: 2}
	source, tasks, errs := newMouseSource(system)
	_, steps, _ := watchSurface(source, 20)
	source.receive(leftDown)
	runTasks(tasks)
	system.err = errors.New("the window is gone")
	source.receive(0)
	source.receive(leftUp)
	runTasks(tasks)
	if want := []step{{0, 1, 2}, {2, 1, 2}}; !reflect.DeepEqual(*steps, want) {
		t.Fatalf("steps %v, want %v", *steps, want)
	}
	if len(*errs) != 2 {
		t.Fatalf("errors %v", *errs)
	}
}

// contract: platform.windows.mouse.unreadable-hit-is-reported
func TestAHitThatCannotBeReadIsReported(t *testing.T) {
	system := &fakeMouse{window: 7, hitErr: errors.New("no position")}
	source, tasks, errs := newMouseSource(system)
	asked, _, _ := watchSurface(source, 20)
	source.receive(leftDown)
	runTasks(tasks)
	if len(*errs) != 1 || len(*asked) != 0 {
		t.Fatalf("errors %v, asked %v", *errs, *asked)
	}
}
