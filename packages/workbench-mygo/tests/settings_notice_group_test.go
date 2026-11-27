package workbench_test

import (
	"encoding/json"
	"reflect"
	"testing"
)

// notificationControl is a control of core.settings-tab that the Notifications group test reads.
type notificationControl struct {
	Name     string   `json:"name"`
	Key      *string  `json:"key"`
	On       *bool    `json:"on"`
	Value    *string  `json:"value"`
	Options  []string `json:"options"`
	Disabled bool     `json:"disabled"`
}

// notificationControls reads the controls of the shown settings tab by key.
func notificationControls(f *shellFixture) map[string]*notificationControl {
	f.t.Helper()
	value, err := f.shell.Registry().Read("core.settings-tab")
	if err != nil {
		f.t.Fatal(err)
	}
	text, err := json.Marshal(value)
	if err != nil {
		f.t.Fatal(err)
	}
	var status struct {
		Controls []notificationControl `json:"controls"`
	}
	if err := json.Unmarshal(text, &status); err != nil {
		f.t.Fatal(err)
	}
	controls := map[string]*notificationControl{}
	for i := range status.Controls {
		if key := status.Controls[i].Key; key != nil {
			controls[*key] = &status.Controls[i]
		}
	}
	return controls
}

// The group Notifications of the behavior page draws the rows of the workbench declaration as the web draws them: each label, description,
// control, default and dependency, in the declared order (docs/spec/notifications.md#settings).
func TestTheNotificationGroupDrawsItsDeclaredRows(t *testing.T) {
	f := opened(t)
	f.run("core.settings-tab.nav", map[string]any{"page": "behavior"})
	f.tester.SetSize(1200, 3200)
	f.settle()

	for _, text := range []string{
		"알림은 세 곳에 나온다: 카드 상태줄(그 카드의 알림), 토스트(앱 알림), 알림 센터(전부).",
		"토스트 모양", "앱 알림과, 보고 있지 않은 카드의 오류·경고가 뜨는 모양. 종 아래에 나타난다.", "카드", "한 줄", "덱",
		"알림 센터 모양", "제목줄 종을 누르면 여는 모양.", "팝오버", "서랍",
		"조용히", "켜면 오류만 토스트로 띄우고 나머지는 알림 센터에만 쌓는다.",
		"오류·경고 자동 닫힘", "끄면 오류·경고 토스트는 ×로만 닫힌다. 성공·정보는 4초 뒤 늘 닫힌다.",
		"닫힐 때까지", "초",
	} {
		if !f.tester.HasText(text) {
			t.Errorf("the group 알림 draws no %q; the texts are %q", text, f.tester.Texts())
		}
	}

	previous := float32(-1)
	for _, label := range []string{"토스트 모양", "알림 센터 모양", "조용히", "오류·경고 자동 닫힘", "닫힐 때까지"} {
		rect, ok := f.tester.Find(label)
		if !ok {
			t.Fatalf("no label %s in %q", label, f.tester.Texts())
		}
		if rect.Y <= previous {
			t.Errorf("the row %s is not drawn below the row before it", label)
		}
		previous = rect.Y
	}

	controls := notificationControls(f)
	choice := func(key string, options []string, value string) {
		t.Helper()
		control, ok := controls[key]
		if !ok {
			t.Fatalf("the group 알림 has no control for %s", key)
		}
		if control.Name != "core.settings-tab.choice" || !reflect.DeepEqual(control.Options, options) {
			t.Errorf("the control %s is %s with options %v, want a choice with %v", key, control.Name, control.Options, options)
		}
		if control.Value == nil || *control.Value != value {
			t.Errorf("the control %s holds %v, want %s", key, control.Value, value)
		}
	}
	choice("toastStyle", []string{"card", "line", "deck"}, "card")
	choice("noticeCenterStyle", []string{"popover", "drawer"}, "popover")
	for _, key := range []string{"quietToasts", "autoDismissProblemToasts"} {
		control, ok := controls[key]
		if !ok || control.Name != "core.settings-tab.set" || control.On == nil || *control.On {
			t.Errorf("the control %s is not a switch that is off by default: %+v", key, control)
		}
	}
	seconds, ok := controls["problemToastDismissSeconds"]
	if !ok || seconds.Name != "core.settings-tab.step" || seconds.Value == nil || *seconds.Value != "5" {
		t.Fatalf("the control problemToastDismissSeconds is %+v, want a stepper of 5", seconds)
	}
	if !seconds.Disabled {
		t.Error("problemToastDismissSeconds is enabled while autoDismissProblemToasts is off")
	}
	f.click("core.settings-tab.set", "autoDismissProblemToasts")
	if notificationControls(f)["problemToastDismissSeconds"].Disabled {
		t.Error("problemToastDismissSeconds stays disabled after autoDismissProblemToasts is switched on")
	}
	f.click("core.settings-tab.set", "quietToasts")
	if on := notificationControls(f)["quietToasts"].On; on == nil || !*on {
		t.Error("quietToasts is not on after its switch was pressed")
	}
}
