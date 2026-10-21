package host

import (
	"testing"
)

// contract: view.exposure.register
// The caller of a registration is either the page view of the surface itself or the main page of the window registering
// for a surface with a view (docs/spec/exposure.md#relay).
func TestRegistrationCallerAcceptsTheSurfacePageAndTheMainPageOfAView(t *testing.T) {
	if err := CheckRegistrationCaller("probe-surface", "probe-surface", false, false); err != nil {
		t.Fatalf("the page view of the surface: %v", err)
	}
	if err := CheckRegistrationCaller("other-surface", "probe-surface", false, true); err == nil || err.Error() != `this document is not surface "probe-surface"` {
		t.Fatalf("the page view of another surface: %v, want a surface mismatch error", err)
	}
	if err := CheckRegistrationCaller("", "probe-surface", true, true); err != nil {
		t.Fatalf("the main page for a surface with a view: %v", err)
	}
	if err := CheckRegistrationCaller("", "probe-surface", true, false); err == nil || err.Error() != `this document is not surface "probe-surface"` {
		t.Fatalf("the main page for a surface without a view: %v, want a surface mismatch error", err)
	}
	if err := CheckRegistrationCaller("", "probe-surface", false, true); err == nil || err.Error() != `this document is not surface "probe-surface"` {
		t.Fatalf("an unknown caller: %v, want a surface mismatch error", err)
	}
}

// contract: view.exposure.register
// A relayed registration is recorded with the window and announced to the main page, and a repeated relay records it once.
func TestRelayedViewRegistrationIsRecordedAndAnnounced(t *testing.T) {
	s := NewSurfaces(nil, nil)
	announced := []any{}
	s.events = func(name string, data any) {
		announced = append(announced, map[string]any{"name": name, "data": data})
	}
	req := SurfaceRegistration{Surface: "probe-surface", Kind: "status", Name: "probe.lines"}
	if err := s.recordRegistration(req); err != nil {
		t.Fatalf("record: %v", err)
	}
	if len(s.registrations["probe-surface"]) != 1 || s.registrations["probe-surface"][0] != req {
		t.Fatalf("recorded registrations %v, want one entry for probe-surface", s.registrations)
	}
	if len(announced) != 1 {
		t.Fatalf("announced events %v, want one exposure-registered event", announced)
	}
	// A repeated relay records nothing again.
	if err := s.recordRegistration(req); err != nil {
		t.Fatalf("re-record: %v", err)
	}
	if len(s.registrations["probe-surface"]) != 1 || len(announced) != 2 {
		t.Fatalf("repeat: registrations %d, announcements %d, want the entry kept once and the event announced again",
			len(s.registrations["probe-surface"]), len(announced))
	}
}

// contract: view.exposure.register
// A registration of an unknown kind, of a host name, of a core name or of an invalid name is refused and records nothing.
func TestRelayedViewRegistrationRefusalsRecordNothing(t *testing.T) {
	for _, test := range []struct{ name, kind, want string }{
		{"probe.lines", "entry", `unknown exposure kind "entry"`},
		{"host.buttons", "status", `a surface cannot register "host.buttons"`},
		{"core.grid", "status", `a surface cannot register "core.grid"`},
		{"core.surface.document", "status", ""},
		{"Probe Lines", "status", `a surface cannot register "Probe Lines"`},
	} {
		s := NewSurfaces(nil, nil)
		s.events = func(string, any) {}
		err := s.recordRegistration(SurfaceRegistration{Surface: "probe-surface", Kind: test.kind, Name: test.name})
		if test.want == "" {
			if err != nil {
				t.Fatalf("%s %s: %v, want accepted", test.kind, test.name, err)
			}
			continue
		}
		if err == nil || err.Error() != test.want {
			t.Fatalf("%s %s: %v, want %s", test.kind, test.name, err, test.want)
		}
		if len(s.registrations["probe-surface"]) != 0 {
			t.Fatalf("%s %s recorded %v, want nothing", test.kind, test.name, s.registrations["probe-surface"])
		}
	}
}
