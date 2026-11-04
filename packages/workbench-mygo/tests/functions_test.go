package workbench_test

import (
	"encoding/json"
	"slices"
	"testing"

	"github.com/egoist/mygo/ui"
	workbench "github.com/soksak-app/core/packages/workbench-mygo/src"
)

func statusText(t *testing.T, registry *workbench.Registry, name string) string {
	t.Helper()
	value, err := registry.Read(name)
	if err != nil {
		t.Fatal(err)
	}
	text, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return string(text)
}

// The statuses and the commands of the workbench functions answer through the registry, as the host reads and runs them.
func TestFunctionsAnswerTheRegistry(t *testing.T) {
	declared, err := workbench.Declared()
	if err != nil {
		t.Fatal(err)
	}
	steps, err := workbench.TextSteps()
	if err != nil {
		t.Fatal(err)
	}
	place := &textPlace{frame: 1, cards: map[string]float64{"a": 1}}
	focus := workbench.NewFocus(declared, func() {})
	pointer := workbench.NewPointerSequence(func() {})
	registry := workbench.NewRegistry(declared)
	workbench.Functions{
		Text:          workbench.NewTextSize(place, steps),
		Focus:         focus,
		Pointer:       pointer,
		Contributions: workbench.NewContributions(),
		Verification:  workbench.NewVerification(func() {}),
	}.Register(registry)

	commands, statuses := registry.Names()
	if want := []string{"core.focus.set", "core.text.larger", "core.text.reset", "core.text.smaller"}; !slices.Equal(commands, want) {
		t.Fatalf("the commands are %v, want %v", commands, want)
	}
	if want := []string{"core.contributions", "core.focus", "core.pointer", "core.text", "core.verify"}; !slices.Equal(statuses, want) {
		t.Fatalf("the statuses are %v, want %v", statuses, want)
	}

	tester := ui.NewTester(func(c *ui.Context) {
		focus.Frame(c)
		pointer.Frame()
		ui.Column(c).Children(func() {
			focus.Bind(ui.Box(c.Key("first")).Size(100, 30).Focusable().HandleInput(pointer.Handler("core.card")), "core.card")
			focus.Bind(ui.Box(c.Key("second")).Size(100, 30).Focusable(), "core.card")
		})
	}, 200, 200)
	tester.Frame()

	if got, want := statusText(t, registry, "core.contributions"), "[]"; got != want {
		t.Fatalf("core.contributions is %s, want %s", got, want)
	}
	if got, want := statusText(t, registry, "core.verify"), "null"; got != want {
		t.Fatalf("core.verify is %s, want %s", got, want)
	}

	if _, err := registry.Run("core.focus.set", json.RawMessage(`{"name":"core.card","index":1}`)); err != nil {
		t.Fatal(err)
	}
	tester.Frame()
	if got, want := statusText(t, registry, "core.focus"), `{"name":"core.card","index":1,"surface":null}`; got != want {
		t.Fatalf("core.focus is %s, want %s", got, want)
	}
	if _, err := registry.Run("core.focus.set", json.RawMessage(`{"name":"core.card"}`)); err != nil {
		t.Fatal(err)
	}
	tester.Frame()
	if got, want := statusText(t, registry, "core.focus"), `{"name":"core.card","index":0,"surface":null}`; got != want {
		t.Fatalf("core.focus without an index is %s, want %s", got, want)
	}
	for params, want := range map[string]string{
		`{"name":"core.none"}`:           "unknown element core.none",
		`{"name":"core.card","index":9}`: "element core.card has no element at index 9",
		`{"name":3}`:                     "core.focus.set: json: cannot unmarshal number into Go struct field .name of type string",
	} {
		if _, err := registry.Run("core.focus.set", json.RawMessage(params)); err == nil || err.Error() != want {
			t.Errorf("core.focus.set %s failed with %v, want %s", params, err, want)
		}
	}

	larger := steps[slices.Index(steps, 1.0)+1]
	for _, step := range []struct {
		command string
		frame   float64
	}{{"core.text.larger", larger}, {"core.text.smaller", 1}, {"core.text.larger", larger}, {"core.text.reset", 1}} {
		if result, err := registry.Run(step.command, nil); err != nil || result != nil {
			t.Fatalf("%s gave %v, %v", step.command, result, err)
		}
		if place.frame != step.frame {
			t.Fatalf("%s left the frame factor at %v, want %v", step.command, place.frame, step.frame)
		}
	}
	if got, want := statusText(t, registry, "core.text"), `{"scope":{"kind":"frame"},"frame":1,"cards":{"a":1}}`; got != want {
		t.Fatalf("core.text is %s, want %s", got, want)
	}
}

// The scale of the text size is the declared one: a list that has the factor 1 and only rises.
func TestTextStepsAreDeclared(t *testing.T) {
	steps, err := workbench.TextSteps()
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Contains(steps, 1.0) || !slices.IsSorted(steps) || steps[0] != 0.5 {
		t.Fatalf("the steps are %v", steps)
	}
}
