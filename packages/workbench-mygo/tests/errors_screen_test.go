package workbench_test

import (
	"errors"
	"slices"
	"testing"

	"github.com/egoist/mygo/ui"

	workbench "github.com/soksak-app/core/packages/workbench-mygo/src"
)

func TestWorkbenchErrorsWithTheSameTextKeepTheirOrigins(t *testing.T) {
	var lines []string
	errors := workbench.NewShownErrors(func(line string) { lines = append(lines, line) })
	errors.ShowFrom("workbench", "placement", "failed", " @ placement")
	errors.ShowFrom("workbench", "activity tab-a", "failed", " @ activity")
	errors.ShowFrom("workbench", "placement", "failed", " @ placement")
	want := []string{"workbench: failed @ placement", "workbench: failed @ activity"}
	if !slices.Equal(lines, want) {
		t.Errorf("records are %q, want %q", lines, want)
	}
	if got := errors.Toasts(); !slices.Equal(got, []string{"failed"}) {
		t.Fatalf("toasts for the two origins are %q", got)
	}
	if errors.HideFrom("workbench", "activity tab-b") {
		t.Error("a source that never showed an error withdrew an occurrence")
	}
	if !errors.HideFrom("workbench", "placement") {
		t.Error("the placement source did not withdraw its occurrence")
	}
	if got := errors.Toasts(); !slices.Equal(got, []string{"failed"}) {
		t.Fatalf("withdrawing the placement removed the activity toast: %q", got)
	}
	if !errors.HideFrom("workbench", "activity tab-a") {
		t.Error("the activity source did not withdraw its occurrence")
	}
	if got := errors.Toasts(); len(got) != 0 {
		t.Fatalf("withdrawing both sources left toasts %q", got)
	}
}

func TestWorkbenchRecoveryKeepsOtherOrigins(t *testing.T) {
	errors := workbench.NewShownErrors(func(string) {})
	errors.ShowFrom("workbench", "placement", "layout failed", "")
	errors.ShowFrom("workbench", "activity tab-a", "activity failed", "")
	if !errors.ShownFrom("workbench", "placement") || !errors.HideFrom("workbench", "placement") {
		t.Error("the activity error replaced the outstanding placement occurrence")
	}
	if got := errors.Toasts(); !slices.Equal(got, []string{"activity failed"}) {
		t.Errorf("placement recovery left toasts %q", got)
	}
	errors.Show("workbench", "activity failed", "")
	if !errors.HideFrom("workbench", "activity tab-a") {
		t.Error("the generic error replaced the outstanding activity occurrence")
	}
	if got := errors.Toasts(); !slices.Equal(got, []string{"activity failed"}) {
		t.Errorf("activity recovery left toasts %q", got)
	}
}

func TestDismissedWorkbenchErrorReopensOnlyForANewOccurrence(t *testing.T) {
	var lines []string
	errors := workbench.NewShownErrors(func(line string) { lines = append(lines, line) })
	errors.ShowFrom("workbench", "placement", "failed", " @ placement")
	errors.ShowFrom("workbench", "activity tab-a", "failed", " @ activity")
	if !errors.DismissToast("failed") {
		t.Fatal("the grouped toast did not close")
	}
	errors.ShowFrom("workbench", "placement", "failed", " @ placement")
	errors.ShowFrom("workbench", "activity tab-a", "failed", " @ activity")
	if got := errors.Toasts(); len(got) != 0 {
		t.Fatalf("repeating the dismissed occurrences opened toasts %q", got)
	}
	if !errors.HideFrom("workbench", "placement") {
		t.Error("dismissing the toast lost the active placement occurrence")
	}
	errors.ShowFrom("workbench", "placement", "failed", " @ placement")
	if got := errors.Toasts(); !slices.Equal(got, []string{"failed"}) {
		t.Errorf("a new placement failure opened toasts %q", got)
	}
	want := []string{"workbench: failed @ placement", "workbench: failed @ activity", "workbench: failed @ placement"}
	if !slices.Equal(lines, want) {
		t.Errorf("records are %q, want %q", lines, want)
	}
}

func TestAnErrorIsWrittenWhenTheErrorOfItsPlaceChanges(t *testing.T) {
	var lines []string
	errors := workbench.NewShownErrors(func(line string) { lines = append(lines, line) })
	errors.Show("workbench", "layout failed", " @ grid.go:1")
	errors.Show("workbench", "layout failed", " @ grid.go:1")
	errors.Show("workbench", "another failure", "")
	errors.Show("debug", "layout failed", "")
	want := []string{"workbench: layout failed @ grid.go:1", "workbench: another failure", "debug: layout failed"}
	if !slices.Equal(lines, want) {
		t.Fatalf("written lines %q, want %q", lines, want)
	}
}

func TestAWithdrawnErrorIsWrittenAgainWhenItIsShownAgain(t *testing.T) {
	var lines []string
	errors := workbench.NewShownErrors(func(line string) { lines = append(lines, line) })
	errors.Show("debug", "no file", "")
	errors.Hide("debug")
	if text, shown := errors.Text("debug"); shown {
		t.Fatalf("a withdrawn error still shows %q", text)
	}
	errors.Show("debug", "no file", "")
	if len(lines) != 2 {
		t.Fatalf("written lines %q, want the error twice", lines)
	}
}

func TestTheErrorToastShowsAndDismissesThroughTheWorkbench(t *testing.T) {
	f := layoutShell(t, oneCard(tab("tab-aaaaaa", "plain")))
	const failure = "the first screen failed"
	f.shell.StartFailed(errors.New(failure))
	want := []shownRecord{{"workbench", failure}}
	if got := f.shownRecords(); !slices.Equal(got, want) {
		t.Fatalf("the workbench recorded %q, want %q", got, want)
	}
	if !hasStatusLabel(f.tester.ElementTree(), failure) {
		t.Fatalf("the toast has no status label for %q", failure)
	}
	close := element(t, f.tester, "core.error.dismiss", failure)
	if close.Inert || close.Actions&ui.ActionPress == 0 {
		t.Fatalf("the toast close control cannot be pressed: %+v", close)
	}
	press(t, f.tester, "core.error.dismiss", failure)
	f.settle()
	if f.tester.HasText(failure) || f.status("core.workbench.error") != "null" {
		t.Fatalf("the closed toast is still visible or reported")
	}
}

func hasStatusLabel(nodes []ui.ElementNode, label string) bool {
	for _, node := range nodes {
		if node.Role == ui.RoleStatus && node.Label == label || hasStatusLabel(node.Children, label) {
			return true
		}
	}
	return false
}

func TestApplicationToastMovesIntoTheActiveNativeModal(t *testing.T) {
	for _, modal := range []struct {
		name, open, close, scrim string
	}{
		{"settings", "core.settings.open", "core.settings.close", "core.settings-modal.scrim"},
		{"debug", "core.debug.open", "core.debug.close", "core.debug.scrim"},
	} {
		t.Run(modal.name, func(t *testing.T) {
			f, _ := surfaceShell(t)
			const failure = "the application could not finish the operation"
			f.shell.StartFailed(errors.New(failure))
			want := []shownRecord{{"workbench", failure}}
			if got := f.shownRecords(); !slices.Equal(got, want) {
				t.Fatalf("the application recorded %q, want %q", got, want)
			}
			assertOnlyToastClose(t, f.tester.ElementTree(), failure)

			f.do(modal.open, nil)
			scrim := element(t, f.tester, modal.scrim, "")
			close := assertOnlyToastClose(t, f.tester.ElementTree(), failure)
			if child, ok := keyed(scrim.Children, "core.error.dismiss", failure); !ok || child.ID != close.ID {
				t.Fatalf("the toast close control is outside the %s focus scope", modal.name)
			}

			f.do(modal.close, nil)
			assertOnlyToastClose(t, f.tester.ElementTree(), failure)

			f.do(modal.open, nil)
			press(t, f.tester, "core.error.dismiss", failure)
			f.settle()
			if got := f.status("core.workbench.error"); got != "null" {
				t.Fatalf("clicking the modal toast close left the error %s", got)
			}
			element(t, f.tester, modal.scrim, "")
			f.do(modal.close, nil)
			if _, shown := keyed(f.tester.ElementTree(), "core.error.dismiss", failure); shown {
				t.Fatal("the dismissed error returned outside the modal")
			}
		})
	}
}

func assertOnlyToastClose(t *testing.T, tree []ui.ElementNode, text string) ui.ElementNode {
	t.Helper()
	var controls []ui.ElementNode
	var collect func([]ui.ElementNode)
	collect = func(nodes []ui.ElementNode) {
		for _, node := range nodes {
			if key, ok := node.Key.(workbench.Exposed); ok && key.Name == "core.error.dismiss" && key.Item == text {
				controls = append(controls, node)
			}
			collect(node.Children)
		}
	}
	collect(tree)
	if len(controls) != 1 {
		t.Fatalf("the frame has %d toast close controls for %q", len(controls), text)
	}
	close := controls[0]
	if close.Inert || close.Actions&ui.ActionPress == 0 || close.Bounds.W <= 0 || close.Bounds.H <= 0 {
		t.Fatalf("the toast close control is outside the active focus scope: %+v", close)
	}
	return close
}

func TestAnErrorToastExpiresWithoutRestartingForModalOrRepaint(t *testing.T) {
	f := layoutShell(t, oneCard(tab("tab-aaaaaa", "plain")))
	const failure = "the operation could not finish"
	f.shellFixture.run("core.focus.set", map[string]string{"name": "core.chrome.settings"})
	workbenchFocus := f.status("core.focus")
	if workbenchFocus == "null" {
		t.Fatal("the workbench settings button has no focus")
	}

	f.shell.StartFailed(errors.New(failure))
	want := []shownRecord{{"workbench", failure}}
	if got := f.shownRecords(); !slices.Equal(got, want) {
		t.Fatalf("the workbench recorded %q, want %q", got, want)
	}
	if got := f.status("core.focus"); got != workbenchFocus {
		t.Fatalf("opening the toast moved focus from %s to %s", workbenchFocus, got)
	}
	assertOnlyToastClose(t, f.tester.ElementTree(), failure)

	f.timers.tick(2000)
	f.do("core.settings.open", nil)
	f.shellFixture.run("core.focus.set", map[string]string{"name": "core.settings-modal.close"})
	modalFocus := f.status("core.focus")
	if modalFocus == "null" || modalFocus == workbenchFocus {
		t.Fatalf("the settings close button did not take focus: %s", modalFocus)
	}
	f.timers.tick(1999)
	f.tester.Frame()
	f.tester.Frame()
	assertOnlyToastClose(t, f.tester.ElementTree(), failure)
	f.timers.tick(1)
	f.settle()
	if got := f.status("core.workbench.error"); got != "null" {
		t.Fatalf("the toast is still open after its original 4000ms: %s", got)
	}
	if _, shown := keyed(f.tester.ElementTree(), "core.error.dismiss", failure); shown {
		t.Fatal("the expired toast still has a close control")
	}
	if got := f.status("core.focus"); got != modalFocus {
		t.Fatalf("expiring the toast moved focus from %s to %s", modalFocus, got)
	}
}

func TestAClosedToastDeadlineDoesNotExpireANewerEqualToast(t *testing.T) {
	f := layoutShell(t, oneCard(tab("tab-aaaaaa", "plain")))
	const failure = "the operation could not finish"
	f.shell.StartFailed(errors.New(failure))
	f.shownRecords()
	f.timers.tick(1000)
	press(t, f.tester, "core.error.dismiss", failure)
	f.settle()

	// A different workbench occurrence allows the failed operation to open a new toast with the same text.
	f.shell.StartFailed(errors.New("another operation failed"))
	f.shell.StartFailed(errors.New(failure))
	f.shownRecords()
	f.timers.tick(3000)
	f.settle()
	assertOnlyToastClose(t, f.tester.ElementTree(), failure)

	f.timers.tick(1000)
	f.settle()
	if got := f.status("core.workbench.error"); got != "null" {
		t.Fatalf("the newer toast did not expire at its own deadline: %s", got)
	}
}
