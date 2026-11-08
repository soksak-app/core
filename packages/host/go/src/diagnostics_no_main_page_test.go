//go:build diagnostics

package host

import (
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"
)

// namedPagelessFramework is a framework without a main page that names its application.
type namedPagelessFramework struct{ pagelessFramework }

func (namedPagelessFramework) ApplicationName() string { return "fixture" }

// pagelessEndpoint is the endpoint of a host of one window under framework.
func pagelessEndpoint(t *testing.T, use Framework) *Endpoint {
	t.Helper()
	previous := framework
	framework = use
	t.Cleanup(func() { framework = previous })
	h := &Host{windows: map[uint]*Surfaces{}, owners: map[string]*Surfaces{}}
	h.windows[1] = &Surfaces{name: "window-a"}
	return &Endpoint{backend: hostBackend{h: h}}
}

func answerOf(t *testing.T, e *Endpoint, name, params string) error {
	t.Helper()
	method, ok := e.method(name)
	if !ok {
		t.Fatalf("%s is not registered", name)
	}
	_, err := method(e, nil, json.RawMessage(params), nil)
	return err
}

// contract: diagnostics.main-page-methods.answer-no-main-page
func TestAFrameworkWithoutAMainPageAnswersTheMainPageMethods(t *testing.T) {
	e := pagelessEndpoint(t, namedPagelessFramework{})
	for name, params := range map[string]string{
		"diagnostics.page.request": `{"window":"window-a","path":"/index.html"}`,
		"diagnostics.page.calls":   `{"window":"window-a","count":1}`,
		"diagnostics.host.events":  `{"window":"window-a","count":1}`,
		"diagnostics.page.collect": `{"window":"window-a"}`,
	} {
		err := answerOf(t, e, name, params)
		if err == nil || err.Error() != "the fixture host has no main page" {
			t.Errorf("%s answered %v", name, err)
		}
	}
}

// contract: diagnostics.modal-methods.answer-no-modal-web-views
func TestAFrameworkWithoutAMainPageAnswersTheModalMethods(t *testing.T) {
	e := pagelessEndpoint(t, namedPagelessFramework{})
	for name, params := range map[string]string{
		"diagnostics.modal.hold": `{"window":"window-a","on":true}`,
		"diagnostics.modal.held": `{"window":"window-a"}`,
	} {
		err := answerOf(t, e, name, params)
		if err == nil || err.Error() != "the fixture host has no modal web views" {
			t.Errorf("%s answered %v", name, err)
		}
	}
}

// contract: diagnostics.main-page-methods.answer-no-main-page, diagnostics.modal-methods.answer-no-modal-web-views
func TestAMissingWindowIsAnsweredBeforeTheMainPage(t *testing.T) {
	e := pagelessEndpoint(t, namedPagelessFramework{})
	for _, name := range []string{"diagnostics.page.collect", "diagnostics.modal.held"} {
		err := answerOf(t, e, name, `{"window":"window-b"}`)
		if err == nil || err.Error() == "the fixture host has no main page" || err.Error() == "the fixture host has no modal web views" {
			t.Errorf("%s answered a missing window with %v", name, err)
		}
	}
}

// contract: diagnostics.modal-methods.answer-no-modal-web-views
func TestAFrameworkWithAMainPageReachesTheModalMethod(t *testing.T) {
	e := pagelessEndpoint(t, frameworkRecord{})
	err := answerOf(t, e, "diagnostics.modal.held", `{"window":"window-a"}`)
	if err == nil || err.Error() != "modal content answers are not held in this window" {
		t.Fatalf("diagnostics.modal.held answered %v", err)
	}
}

// fakeDragWorkbench answers the record of a drag and writes down what it was asked.
type fakeDragWorkbench struct {
	asked  []string
	params []any
	record string
}

func (f *fakeDragWorkbench) ask(method string, params any) (json.RawMessage, error) {
	f.asked = append(f.asked, method)
	f.params = append(f.params, params)
	if method == "diagnostics.drag.end" {
		return json.RawMessage(f.record), nil
	}
	return json.RawMessage("null"), nil
}

// contract: diagnostics.drag.no-main-page-delivers-native
func TestADragOfAWindowWithoutAMainPageDeliversNativeInputAndReadsTheWorkbench(t *testing.T) {
	plan := dragPlan{Axis: "x", Line: 2, DX: -30, MS: 16, Times: 1}
	workbench := &fakeDragWorkbench{record: `{"boundary":[100,70,100]}`}
	var hear func(StepRecord)
	ended := false
	result, err := workbenchDrag(plan, workbench.ask, func(report func(StepRecord)) func() {
		hear = report
		return func() { ended = true }
	}, func() (map[string]any, error) {
		if !reflect.DeepEqual(workbench.asked, []string{"diagnostics.drag"}) {
			t.Fatalf("the delivery began after %v", workbench.asked)
		}
		hear(StepRecord{Kind: "selector", Callback: "mouseDown:", Entry: 0, Return: 9_000_000})
		hear(StepRecord{Kind: "selector", Callback: "mouseDragged:", Entry: 1_000_000, Return: 3_500_000})
		hear(StepRecord{Kind: "block", Callback: "frame", Entry: 0, Return: 9_000_000})
		hear(StepRecord{Kind: "selector", Callback: "mouseDragged:", Entry: 5_000_000, Return: 6_000_000})
		return map[string]any{"steps": 2}, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if !ended {
		t.Fatal("the listener of the steps did not end")
	}
	if !reflect.DeepEqual(workbench.asked, []string{"diagnostics.drag", "diagnostics.drag.end"}) {
		t.Fatalf("the workbench was asked %v", workbench.asked)
	}
	if want := map[string]any{"axis": plan.Axis, "line": plan.Line}; !reflect.DeepEqual(workbench.params[0], want) {
		t.Fatalf("the workbench was asked for %v, want %v", workbench.params[0], want)
	}
	if !reflect.DeepEqual(result["boundary"], []float64{100, 70, 100}) {
		t.Fatalf("boundary = %v", result["boundary"])
	}
	if !reflect.DeepEqual(result["handled"], []float64{2.5, 1}) {
		t.Fatalf("handled = %v", result["handled"])
	}
	if result["steps"] != 2 {
		t.Fatalf("the reply lost the steps of the delivery: %v", result)
	}
}

// contract: diagnostics.drag.no-main-page-delivers-native
func TestAFailedDragOfAWindowWithoutAMainPageEndsTheRecordOfTheWorkbench(t *testing.T) {
	plan := dragPlan{Axis: "x", Line: 2, DX: -30, MS: 16, Times: 1}
	workbench := &fakeDragWorkbench{record: `{"boundary":[100]}`}
	failure := errors.New("native drag step 1: no input")
	_, err := workbenchDrag(plan, workbench.ask, func(func(StepRecord)) func() { return func() {} },
		func() (map[string]any, error) { return nil, failure })
	if !errors.Is(err, failure) {
		t.Fatalf("the drag failed with %v", err)
	}
	if !reflect.DeepEqual(workbench.asked, []string{"diagnostics.drag", "diagnostics.drag.end"}) {
		t.Fatalf("the workbench was asked %v", workbench.asked)
	}
}

// contract: diagnostics.drag.no-main-page-delivers-native
func TestADragThatRecordedFewerStepsThanItDeliveredFails(t *testing.T) {
	plan := dragPlan{Axis: "x", Line: 2, DX: -30, MS: 16, Times: 1}
	for name, steps := range map[string][]StepRecord{
		"no callback":  {},
		"one callback": {{Callback: "mouseDragged:"}},
	} {
		workbench := &fakeDragWorkbench{record: `{"boundary":[100,70,100]}`}
		var hear func(StepRecord)
		_, err := workbenchDrag(plan, workbench.ask, func(report func(StepRecord)) func() {
			hear = report
			return func() {}
		}, func() (map[string]any, error) {
			for _, step := range steps {
				hear(step)
			}
			return map[string]any{"steps": 2}, nil
		})
		if err == nil || !strings.HasPrefix(err.Error(), "the drag delivered 2 steps and recorded") {
			t.Fatalf("%s: the drag answered %v", name, err)
		}
	}
}

// A press goes where the last frame drew, so a boundary that a change just made takes the press only after the window presented it.
// contract: diagnostics.drag.native-reads-boundary-after-presentation
func TestANativeDragAsksForItsBoundaryAfterTheWindowPresentedIt(t *testing.T) {
	order := []string{}
	from, err := presentedBoundary(func() (float64, error) {
		order = append(order, "presented")
		return 0, nil
	}, func() (point, error) {
		order = append(order, "boundary")
		return point{X: 7, Y: 9}, nil
	})
	if err != nil || from != (point{X: 7, Y: 9}) || !reflect.DeepEqual(order, []string{"presented", "boundary"}) {
		t.Fatalf("the point is %+v, the error %v, the order %v", from, err, order)
	}
	failure := errors.New("the window did not present")
	_, err = presentedBoundary(func() (float64, error) { return 0, failure }, func() (point, error) {
		t.Fatal("a window that did not present was asked for its boundary")
		return point{}, nil
	})
	if !errors.Is(err, failure) {
		t.Fatalf("the failure of the wait answered %v", err)
	}
}

// contract: diagnostics.drag.waits-for-the-last-placement
func TestADragAsksTheWindowForItsLastPlacementBeforeItWaitsForTheRun(t *testing.T) {
	var order []string
	settled := func() <-chan struct{} {
		order = append(order, "settled")
		done := make(chan struct{})
		close(done)
		return done
	}
	err := lastLayoutPresented(func(time.Duration) error {
		order = append(order, "placed")
		return nil
	}, settled, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(order, []string{"placed", "settled"}) {
		t.Fatalf("the drag waited in the order %v", order)
	}
	order = nil
	failure := errors.New("surface presentation failed")
	if err := lastLayoutPresented(func(time.Duration) error { return failure }, settled, time.Second); !errors.Is(err, failure) {
		t.Fatalf("a failed placement answered %v", err)
	}
	if len(order) != 0 {
		t.Fatalf("a failed placement went on to %v", order)
	}
}

// contract: diagnostics.drag.waits-for-the-last-placement
func TestADragFailsWhenTheWindowDoesNotAnswerItsLastPlacement(t *testing.T) {
	const limit = 20 * time.Millisecond
	relay := NewRelay[string]()
	var asked time.Duration
	err := lastLayoutPresented(func(within time.Duration) error {
		asked = within
		// The window takes the request and answers nothing.
		return relay.Request("window", within, func(uint64) error { return nil }).Error
	}, func() <-chan struct{} {
		t.Fatal("the drag went on without the answer of the window")
		return nil
	}, limit)
	if asked != limit {
		t.Fatalf("the drag asked the window with the limit %s", asked)
	}
	var failure *RPCError
	if !errors.As(err, &failure) || failure.Code != codeTimeout {
		t.Fatalf("a window that does not answer failed the drag with %v", err)
	}
	if !strings.Contains(err.Error(), "the last placement of the drag") {
		t.Fatalf("the failure does not name the last placement: %v", err)
	}
}
