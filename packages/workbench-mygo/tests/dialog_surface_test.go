package workbench_test

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

// The dialog of the window (docs/spec/plugins.md#dialogs): a view opens a declared dialog of its plugin, the window places the dialog
// surface over its content and holds one dialog at a time, the open call replies with the result of the close of the dialog view, and
// every other end of the call removes the dialog.

const dialogSurfaceID = "dialog/textprobe/edit"

// dialogShell is a shell whose plugin textprobe declares the dialog edit, with the surface of the first textprobe tab.
func dialogShell(t *testing.T) (*shellFixture, *surfaceHost, string) {
	t.Helper()
	document := strings.Replace(installedDocument, `"surface": {"menu": [{"title": "닫기"`,
		`"dialogs": {"edit": {"page": "ui/edit.html"}}, "surface": {"menu": [{"title": "닫기"`, 1)
	if document == installedDocument {
		t.Fatal("the installed document holds no textprobe surface to declare the dialog beside")
	}
	f, stored := surfaceShellOf(t, document)
	return f, stored, pluginSurface(t, stored, "textprobe")
}

// dialogCall delivers the view call id of surface and settles the frames that follow it.
func dialogCall(f *shellFixture, surface string, id int, command string, params any) {
	f.shell.Event("view-call", []any{map[string]any{"surface": surface, "plugin": "textprobe", "generation": 1, "id": id, "command": command, "params": params}})
	f.settle()
}

// errorOf returns the message of the error of reply, or "" when it replied without an error.
func errorOf(reply map[string]any) string {
	failure, _ := reply["error"].(map[string]any)
	message, _ := failure["message"].(string)
	return message
}

// replyOf returns the reply of the call id of surface, or nil when it has none.
func replyOf(stored *surfaceHost, surface string, id int) map[string]any {
	for _, reply := range stored.replies {
		if reply["surface"] == surface && reply["id"] == float64(id) {
			return reply
		}
	}
	return nil
}

func TestADialogOpensOverTheWindowAndRepliesWithTheResultOfItsClose(t *testing.T) {
	f, stored, opener := dialogShell(t)
	dialogCall(f, opener, 5, "runtime.dialog.open", map[string]any{"name": "edit", "params": map[string]any{"row": 3}})
	if reply := replyOf(stored, opener, 5); reply != nil {
		t.Fatalf("the open call replied before the dialog closed: %v", reply)
	}
	placed := stored.lastSurfaces(t)[dialogSurfaceID]
	if placed == nil || placed["visible"] != true {
		t.Fatalf("the dialog surface is not placed visible: %v", placed)
	}
	start, _ := json.Marshal(placed["start"].(map[string]any)["dialog"])
	params, _ := json.Marshal(placed["start"].(map[string]any)["params"])
	if string(start) != fmt.Sprintf(`{"name":"edit","opener":%q}`, opener) || string(params) != `{"row":3}` {
		t.Fatalf("the dialog starts with the dialog %s and the params %s", start, params)
	}
	if got, want := f.status("core.modal"), fmt.Sprintf(`{"id":%q,"mode":"dialog","document":null,"plugin":"textprobe"}`, dialogSurfaceID); got != want {
		t.Fatalf("core.modal is %s, want %s", got, want)
	}
	// The workbench blurs its own drawing behind the dialog.
	if !strings.Contains(f.status("core.window.workbench"), `"background":true`) {
		t.Fatalf("the workbench behind the dialog is not blurred: %s", f.status("core.window.workbench"))
	}
	if !strings.Contains(f.status("core.surfaces"), fmt.Sprintf(`"kind":"dialog","sidebar":null,"dialog":{"name":"edit","opener":%q}`, opener)) {
		t.Fatalf("core.surfaces does not list the dialog: %s", f.status("core.surfaces"))
	}
	dialogCall(f, dialogSurfaceID, 6, "runtime.dialog.close", map[string]any{"result": map[string]any{"saved": true}})
	closed := replyOf(stored, dialogSurfaceID, 6)
	if closed == nil || closed["error"] != nil {
		t.Fatalf("the close call replied %v", closed)
	}
	reply := replyOf(stored, opener, 5)
	result, _ := json.Marshal(reply["result"])
	if reply == nil || reply["error"] != nil || string(result) != `{"saved":true}` {
		t.Fatalf("the open call replied %v", reply)
	}
	if _, placed := stored.lastSurfaces(t)[dialogSurfaceID]; placed {
		t.Fatal("the closed dialog surface is still placed")
	}
	if f.status("core.modal") != "null" {
		t.Fatalf("core.modal after the close is %s", f.status("core.modal"))
	}
}

func TestAnUndeclaredDialogASecondDialogAndACloseOfAnotherViewAreRefused(t *testing.T) {
	f, stored, opener := dialogShell(t)
	dialogCall(f, opener, 5, "runtime.dialog.open", map[string]any{"name": "other"})
	if reply := replyOf(stored, opener, 5); reply == nil || errorOf(reply) != "view call runtime.dialog.open other is not a dialog of textprobe" {
		t.Fatalf("the open of an undeclared dialog replied %v", reply)
	}
	dialogCall(f, opener, 6, "runtime.dialog.open", map[string]any{"name": "edit"})
	dialogCall(f, opener, 7, "runtime.dialog.open", map[string]any{"name": "edit"})
	if reply := replyOf(stored, opener, 7); reply == nil || errorOf(reply) != "view call runtime.dialog.open: the window shows the dialog edit of textprobe" {
		t.Fatalf("the second open replied %v", reply)
	}
	dialogCall(f, opener, 8, "runtime.dialog.close", map[string]any{"result": nil})
	if reply := replyOf(stored, opener, 8); reply == nil || errorOf(reply) != "view call runtime.dialog.close is served only to a dialog" {
		t.Fatalf("the close of the opener replied %v", reply)
	}
	if _, placed := stored.lastSurfaces(t)[dialogSurfaceID]; !placed {
		t.Fatal("a refused close removed the dialog")
	}
}

func TestTheCancelOfTheOpenCallRemovesTheDialog(t *testing.T) {
	f, stored, opener := dialogShell(t)
	dialogCall(f, opener, 5, "runtime.dialog.open", map[string]any{"name": "edit"})
	f.shell.Event("view-call", []any{map[string]any{"surface": opener, "plugin": "textprobe", "generation": 1, "id": 5, "command": "runtime.dialog.open", "cancel": true}})
	f.settle()
	if reply := replyOf(stored, opener, 5); reply == nil || errorOf(reply) != "cancelled" {
		t.Fatalf("the cancelled open call replied %v", reply)
	}
	if _, placed := stored.lastSurfaces(t)[dialogSurfaceID]; placed {
		t.Fatal("the dialog of a cancelled open call is still placed")
	}
}

func TestAModalOfTheWorkbenchIsRefusedWhileADialogIsOpen(t *testing.T) {
	f, _, opener := dialogShell(t)
	dialogCall(f, opener, 5, "runtime.dialog.open", map[string]any{"name": "edit"})
	if err := f.later("core.settings.open", map[string]any{}); err == nil || err.Error() != "the window shows the dialog edit of textprobe" {
		t.Fatalf("the settings opened beside the dialog: %v", err)
	}
	if !strings.Contains(f.status("core.modal"), dialogSurfaceID) {
		t.Fatalf("core.modal is %s", f.status("core.modal"))
	}
}
