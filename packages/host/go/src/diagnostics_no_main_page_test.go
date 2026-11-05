//go:build diagnostics

package host

import (
	"encoding/json"
	"testing"
)

// namedPagelessFramework is a framework without a main page that names its application.
type namedPagelessFramework struct{ pagelessFramework }

func (namedPagelessFramework) ApplicationName() string { return "mygo" }

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
	_, err := method(e, nil, json.RawMessage(params))
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
		if err == nil || err.Error() != "the mygo host has no main page" {
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
		if err == nil || err.Error() != "the mygo host has no modal web views" {
			t.Errorf("%s answered %v", name, err)
		}
	}
}

// contract: diagnostics.main-page-methods.answer-no-main-page, diagnostics.modal-methods.answer-no-modal-web-views
func TestAMissingWindowIsAnsweredBeforeTheMainPage(t *testing.T) {
	e := pagelessEndpoint(t, namedPagelessFramework{})
	for _, name := range []string{"diagnostics.page.collect", "diagnostics.modal.held"} {
		err := answerOf(t, e, name, `{"window":"window-b"}`)
		if err == nil || err.Error() == "the mygo host has no main page" || err.Error() == "the mygo host has no modal web views" {
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
