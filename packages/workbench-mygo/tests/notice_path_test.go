package workbench_test

import (
	"encoding/json"
	"errors"
	"math"
	"slices"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"

	workbench "github.com/soksak-app/core/packages/workbench-mygo/src"
)

// toastStatus is one entry of core.toasts (docs/spec/notifications.md#commands-and-statuses).
type toastStatus struct {
	ID        string `json:"id"`
	Kind      string `json:"kind"`
	Title     string `json:"title"`
	Count     int    `json:"count"`
	Remaining *int64 `json:"remaining"`
}

func shownToasts(t *testing.T, f *shellFixture) []toastStatus {
	t.Helper()
	var state struct {
		Toasts []toastStatus `json:"toasts"`
	}
	if err := json.Unmarshal([]byte(f.status("core.toasts")), &state); err != nil {
		t.Fatalf("core.toasts is %s: %v", f.status("core.toasts"), err)
	}
	return state.Toasts
}

// An error that the application shows is an error notice of core.toasts, with its id, kind, title and count; with the automatic
// dismissal off it has no remaining time (docs/spec/notifications.md#toasts).
func TestAnErrorIsAnErrorNoticeOnCoreToasts(t *testing.T) {
	f := noSidebarShell(t, oneCard(tab("tab-aaaaaa", "plain")))
	const failure = "the first screen failed"
	f.shell.StartFailed(errors.New(failure))
	toasts := shownToasts(t, f.shellFixture)
	if len(toasts) != 1 || toasts[0].Kind != "error" || toasts[0].Title != failure || toasts[0].Count != 1 || toasts[0].Remaining != nil || toasts[0].ID == "" {
		t.Fatalf("core.toasts is %+v, want one error notice titled %q", toasts, failure)
	}
}

// Closing a toast by its id removes it; an id that no shown notice has is refused (docs/spec/notifications.md#commands-and-statuses).
func TestCloseNoticeClosesTheToastByItsId(t *testing.T) {
	f := noSidebarShell(t, oneCard(tab("tab-aaaaaa", "plain")))
	const failure = "the first screen failed"
	f.shell.StartFailed(errors.New(failure))
	f.shownRecords()
	id := shownToasts(t, f.shellFixture)[0].ID
	if err := f.runQuiet("core.notices.close", map[string]any{"id": "notice-none"}); err == nil {
		t.Fatal("closing an unknown notice succeeded")
	}
	f.run(t, "core.notices.close", `{"id":"`+id+`"}`)
	if toasts := shownToasts(t, f.shellFixture); len(toasts) != 0 || f.tester.HasText(failure) {
		t.Fatalf("the closed toast is still shown: %+v", toasts)
	}
}

// An error of another origin whose title matches a shown error merges into it: the count is the number of origins and the title
// reads with the count, and the text is the newest one (docs/spec/notifications.md#notices).
func TestAnErrorWithTheTitleOfAShownErrorMerges(t *testing.T) {
	errs := workbench.NewShownErrors(func(string) {})
	errs.ShowFrom("workbench", "a", "failed", "")
	errs.ShowFrom("workbench", "b", "failed\nmore detail", "")
	statuses := errs.ToastStatuses()
	if len(statuses) != 1 || statuses[0].Count != 2 || statuses[0].Title != "failed ×2" {
		t.Fatalf("core.toasts is %+v, want one merged notice with count 2", statuses)
	}
}

// The count of a notice is the number of occurrences that merged into it, including an occurrence of the same origin with a new text
// (docs/spec/notifications.md#notices).
func TestAMergedNoticeCountsItsMerges(t *testing.T) {
	errs := workbench.NewShownErrors(func(string) {})
	errs.ShowFrom("workbench", "a", "failed", "")
	errs.ShowFrom("workbench", "a", "failed\nmore", "")
	errs.ShowFrom("workbench", "b", "failed", "")
	statuses := errs.ToastStatuses()
	if len(statuses) != 1 || statuses[0].Count != 3 || statuses[0].Title != "failed ×3" {
		t.Fatalf("core.toasts is %+v, want one notice with count 3", statuses)
	}
}

// An occurrence whose title differs opens its own notice.
func TestAnOccurrenceWithAnotherTitleOpensItsOwnNotice(t *testing.T) {
	errs := workbench.NewShownErrors(func(string) {})
	errs.ShowFrom("workbench", "a", "failed", "")
	errs.ShowFrom("workbench", "b", "other", "")
	if got := errs.Toasts(); len(got) != 2 {
		t.Fatalf("toasts are %q, want two notices", got)
	}
}

// A held toast keeps its remaining time while it is held and runs for that time after the hold (docs/spec/notifications.md#places).
func TestAHeldToastStopsItsRemainingTime(t *testing.T) {
	now := time.Unix(0, 0)
	errs := workbench.NewShownErrors(func(string) {})
	errs.UseClock(func() time.Time { return now })
	errs.ConfigureToastDeadline(true, 5000)
	errs.ShowFrom("workbench", "a", "failed", "")
	id := errs.ToastStatuses()[0].ID
	var scheduled []int64
	cancels := 0
	errs.StartToastExpiry(func(ms int64, expire func()) func() {
		scheduled = append(scheduled, ms)
		return func() { cancels++ }
	}, func() {})
	now = now.Add(2 * time.Second)
	errs.Hold(id, true)
	if cancels != 1 {
		t.Fatalf("holding the toast cancelled %d timers, want 1", cancels)
	}
	if got := *errs.ToastStatuses()[0].Remaining; got != 3000 {
		t.Fatalf("the remaining time when held is %d, want 3000", got)
	}
	now = now.Add(time.Second)
	if got := *errs.ToastStatuses()[0].Remaining; got != 3000 {
		t.Fatalf("the remaining time moved while held: %d, want 3000", got)
	}
	errs.Hold(id, false)
	if !slices.Equal(scheduled, []int64{5000, 3000}) {
		t.Fatalf("the timers started for %v, want the first deadline and then the remaining 3000 ms", scheduled)
	}
}

// keyedCount counts the elements of the tree that carry the exposed name.
func keyedCount(nodes []ui.ElementNode, name string) int {
	count := 0
	for _, node := range nodes {
		if key, ok := node.Key.(workbench.Exposed); ok && key.Name == name {
			count++
		}
		count += keyedCount(node.Children, name)
	}
	return count
}

// noticeShell opens the layout fixture with the common settings of the test and shows one error per text.
// noSidebarsEnvironment is the environment of the notice tests, which have no sidebar set, and whose new space is one empty card, the
// grid that environment.json requires (docs/spec/plugins.md#environmentjson). A sidebar set that names a plugin which is not loaded shows the
// warning of that plugin as a notice (docs/spec/plugins.md#missing-plugins), so such a set would add a toast to each test.
const noSidebarsEnvironment = `{"workspace":{"focus":"main","grid":{"root":{"card":"main","tabs":[]}}},"sidebars":{"sets":[],"links":[]}}`

// noSidebarShell is layoutShell with the environment of the notice tests (noSidebarsEnvironment).
func noSidebarShell(t *testing.T, spaces ...map[string]any) *tabShell {
	t.Helper()
	f := newTabShell(t, &storedHost{installed: layoutPlugins, environment: []byte(noSidebarsEnvironment), projects: []map[string]any{gridProject(spaces...)}})
	f.open(t)
	return f
}

func noticeShell(t *testing.T, common map[string]any, texts ...string) *tabShell {
	t.Helper()
	f := newTabShell(t, &storedHost{installed: layoutPlugins, environment: []byte(noSidebarsEnvironment), projects: []map[string]any{gridProject(oneCard(tab("tab-aaaaaa", "plain")))}, common: common})
	f.open(t)
	for _, text := range texts {
		f.shell.StartFailed(errors.New(text))
	}
	f.shownRecords()
	f.settle()
	return f
}

// The card form shows three toasts at the top right under the bell and counts the rest in the line +<n> more
// (docs/spec/notifications.md#toasts).
func TestTheCardFormShowsThreeToastsAndCountsTheRest(t *testing.T) {
	f := noticeShell(t, nil, "first failed", "second failed", "third failed", "fourth failed")
	if got := keyedCount(f.tester.ElementTree(), "core.notices.close"); got != 3 {
		t.Fatalf("the card form shows %d toasts, want 3", got)
	}
	if !f.tester.HasText("+1개 더") {
		t.Fatalf("the card form does not count the rest as +1개 더: %q", f.tester.Texts())
	}
}

// The line form shows one toast and the number of the others (docs/spec/notifications.md#toasts).
func TestTheLineFormShowsOneToastAndItsCount(t *testing.T) {
	f := noticeShell(t, map[string]any{"toastStyle": "line"}, "first failed", "second failed", "third failed")
	if got := keyedCount(f.tester.ElementTree(), "core.notices.close"); got != 1 {
		t.Fatalf("the line form shows %d toasts, want 1", got)
	}
	if !f.tester.HasText("2") {
		t.Fatalf("the line form does not count the others as 2")
	}
}

// The toasts lie under the bell at the top right of the window (docs/spec/notifications.md#toasts).
func TestTheToastsLieAtTheTopRightOfTheWindow(t *testing.T) {
	f := noticeShell(t, nil, "first failed")
	close := element(t, f.tester, "core.notices.close", f.noticeFor("first failed"))
	if close.Bounds.X < 1200/2 || close.Bounds.Y > 120 {
		t.Fatalf("the toast close control lies at %+v, want the top right of the 1200 px window", close.Bounds)
	}
}

// The deck form packs its toasts by toast-deck-offset and spreads them while the pointer is on the stack.
func TestTheDeckFormSpreadsOnPointerOver(t *testing.T) {
	f := noticeShell(t, map[string]any{"toastStyle": "deck"}, "first failed", "second failed")
	first := element(t, f.tester, "core.notices.close", f.noticeFor("first failed"))
	second := element(t, f.tester, "core.notices.close", f.noticeFor("second failed"))
	packed := second.Bounds.Y - first.Bounds.Y
	f.tester.Move(first.Bounds.X+first.Bounds.W/2, first.Bounds.Y+first.Bounds.H/2)
	f.settle()
	first = element(t, f.tester, "core.notices.close", f.noticeFor("first failed"))
	second = element(t, f.tester, "core.notices.close", f.noticeFor("second failed"))
	spread := second.Bounds.Y - first.Bounds.Y
	// The stack grows upward. Packed, a toast after the first has the margin toast-deck-lift (-10 px); spread, it has the margin toast-gap
	// (8 px). Each step is the height and the flex gap of 8 px plus that margin, so the step grows by 8 - (-10) = 18 px. The scale of 0.96 moves the close control by under 1 px, so the check allows 1 px. The scale of 0.96 moves the close control by under 1 px, so the check allows 1 px.
	if grow := math.Abs(float64(spread)) - math.Abs(float64(packed)); math.Abs(grow-18) > 1 {
		t.Fatalf("the deck form grows its step by %v px, want 18 px (packed %v, spread %v)", grow, packed, spread)
	}
}

// A toast under the pointer holds its deadline: it stays open while the pointer rests on it and closes after the pointer leaves
// (docs/spec/notifications.md#places).
func TestAHoveredToastKeepsItsDeadline(t *testing.T) {
	f := noticeShell(t, map[string]any{"autoDismissProblemToasts": true, "problemToastDismissSeconds": 5.0}, "first failed")
	close := element(t, f.tester, "core.notices.close", f.noticeFor("first failed"))
	f.tester.Move(close.Bounds.X+close.Bounds.W/2, close.Bounds.Y+close.Bounds.H/2)
	f.settle()
	f.timers.tick(10000)
	f.settle()
	if f.noticeFor("first failed") == "" {
		t.Fatal("the hovered toast closed while the pointer was on it")
	}
	f.tester.Move(0, 0)
	f.settle()
	f.timers.tick(10000)
	f.settle()
	if f.noticeFor("first failed") != "" {
		t.Fatal("the toast stayed open after the pointer left it and its deadline passed")
	}
}
