package host

import (
	"testing"
	"unsafe"
)

// contract: view.origin.current-callback-is-dispatched
func TestCurrentViewCallbackEntersDispatch(t *testing.T) {
	isolateTraceRecords(t)
	clock := &fakeClock{}
	s, fake, _ := newLifecycleSurfaces(t, clock)
	s.views = map[string]*nativeWebview{"probe-surface": {}}
	events := recordWindowEvents(s)
	channel, ok := s.documents.view("probe-surface")
	if !ok {
		t.Fatal("the created view has no channel")
	}

	s.viewReceived(
		"probe-surface",
		fake.created[0],
		"probe",
		channel.generation,
		`{"message":{"sok":1,"id":7,"command":"probe.run","params":{}}}`,
	)
	if len(*events) != 1 || (*events)[0].name != "view-call" {
		t.Fatalf("events after a current callback: %+v, want one view-call dispatch", *events)
	}
}

// contract: view.origin.retired-callback-is-cancelled
func TestRetiredViewCallbackDoesNotReachDispatch(t *testing.T) {
	isolateTraceRecords(t)
	clock := &fakeClock{}
	s, fake, _ := newLifecycleSurfaces(t, clock)
	s.views = map[string]*nativeWebview{"probe-surface": {}}
	events := recordWindowEvents(s)
	retired, oldGeneration := retireAndReplaceView(t, s, fake)
	current, ok := s.documents.view("probe-surface")
	if !ok || current.generation == oldGeneration {
		t.Fatalf("replacement view generation: %+v, want a current generation after %d", current, oldGeneration)
	}
	created := len(fake.created)
	beforeCalls := len(*events)

	s.viewReceived(
		"probe-surface",
		retired,
		"probe",
		oldGeneration,
		`{"message":{"sok":1,"id":7,"command":"probe.run","params":{}}}`,
	)
	var calls []windowEvent
	for _, event := range (*events)[beforeCalls:] {
		if event.name == "view-call" {
			calls = append(calls, event)
		}
	}
	if len(calls) != 0 {
		t.Fatalf("view-call events after a retired callback: %+v, want none", calls)
	}
	if len(fake.created) != created || len(fake.closed) != 1 {
		t.Fatalf("views after a retired callback: created %d closed %d, want %d and 1", len(fake.created), len(fake.closed), created)
	}
}

// contract: view.origin.retired-producer-error-is-preserved
func TestRetiredViewCallbackPreservesItsProducerError(t *testing.T) {
	isolateTraceRecords(t)
	clock := &fakeClock{}
	s, fake, _ := newLifecycleSurfaces(t, clock)
	s.views = map[string]*nativeWebview{"probe-surface": {}}
	retired, oldGeneration := retireAndReplaceView(t, s, fake)
	before := len(bufferedTraces(t, "host.record.error"))

	s.viewReceived(
		"probe-surface",
		retired,
		"probe",
		oldGeneration,
		`{"message":{"event":"view.error","plugin":"probe","reason":"uncaught error: origin-test"}}`,
	)
	errors := bufferedTraces(t, "host.record.error")[before:]
	if len(errors) != 1 || errors[0]["where"] != "view probe probe-surface" || errors[0]["text"] != "uncaught error: origin-test" {
		t.Fatalf("retired producer error records: %v, want the original reason with plugin and surface", errors)
	}
}

// contract: view.origin.retired-channel-errors-are-reported
func TestRetiredViewCallbackPreservesMalformedAndTransportErrors(t *testing.T) {
	for _, test := range []struct {
		name, value, where, text string
	}{
		{
			name:  "malformed message",
			value: "{malformed",
			where: "view channel",
			text:  "view probe probe-surface: message is not JSON:",
		},
		{
			name:  "transport error",
			value: `{"error":"native producer failed"}`,
			where: "view channel",
			text:  "view probe probe-surface: native producer failed",
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			isolateTraceRecords(t)
			clock := &fakeClock{}
			s, fake, _ := newLifecycleSurfaces(t, clock)
			s.views = map[string]*nativeWebview{"probe-surface": {}}
			retired, oldGeneration := retireAndReplaceView(t, s, fake)
			before := len(bufferedTraces(t, "host.record.error"))

			s.viewReceived("probe-surface", retired, "probe", oldGeneration, test.value)
			errors := bufferedTraces(t, "host.record.error")[before:]
			if len(errors) != 1 || errors[0]["where"] != test.where {
				t.Fatalf("retired %s records: %v, want one record at %q", test.name, errors, test.where)
			}
			got, _ := errors[0]["text"].(string)
			if got != test.text && !(len(got) > len(test.text) && got[:len(test.text)] == test.text) {
				t.Fatalf("retired %s text: %q, want %q or a parser detail after it", test.name, got, test.text)
			}
		})
	}
}

// contract: view.origin.retired-malformed-envelope-is-reported
func TestRetiredGenerationMalformedInnerEnvelopeKeepsItsChannelError(t *testing.T) {
	isolateTraceRecords(t)
	clock := &fakeClock{}
	s, fake, _ := newLifecycleSurfaces(t, clock)
	s.views = map[string]*nativeWebview{"probe-surface": {}}
	_, retiredGeneration := retireAndReplaceView(t, s, fake)
	current, ok := s.documents.view("probe-surface")
	if !ok || current.generation == retiredGeneration {
		t.Fatalf("replacement generation: %+v, want a generation newer than %d", current, retiredGeneration)
	}

	for _, value := range []string{
		`{"message":"not-an-object"}`,
		`{"message":{}}`,
		`{"message":{"event":"","command":"probe.run"}}`,
	} {
		accepted, err := s.viewMessageFrom("probe-surface", "probe", retiredGeneration, value)
		if !accepted || err == nil {
			t.Fatalf("retired malformed envelope %s: accepted %t, error %v; want the channel error without dispatch", value, accepted, err)
		}
		retiredError := err.Error()
		accepted, err = s.viewMessageFrom("probe-surface", "probe", current.generation, value)
		if !accepted || err == nil {
			t.Fatalf("current malformed envelope %s: accepted %t, error %v; want the current channel error", value, accepted, err)
		}
		if err.Error() != retiredError {
			t.Fatalf("current malformed envelope error %q differs from retired error %q", err, retiredError)
		}
	}

	accepted, err := s.viewMessageFrom("probe-surface", "probe", retiredGeneration, `{"message":{"sok":1,"id":7,"command":"probe.run","params":{}}}`)
	if accepted || err != nil {
		t.Fatalf("valid retired call: accepted %t, error %v; want cancellation without error", accepted, err)
	}
}

// contract: view.channel.overflow-closes
func TestViewChannelOverflowClosesTheViewAndCreatesItAgain(t *testing.T) {
	clock := &fakeClock{}
	s, fake, _ := newLifecycleSurfaces(t, clock)
	first := fake.created[0]
	full := `{"message":{"event":"view.error","plugin":"probe","reason":"queue full for probe"}}`
	channel, _ := s.documents.view("probe-surface")
	s.viewReceived("probe-surface", first, channel.plugin, channel.generation, full)
	if len(fake.closed) != 1 || fake.closed[0] != first {
		t.Fatalf("closed views after the overflow: %d, want the overflowed view", len(fake.closed))
	}
	if len(fake.created) != 2 {
		t.Fatalf("created views after the overflow: %d, want the view created again", len(fake.created))
	}
	// A message that arrives from the view closed by the overflow is a late message and closes nothing.
	s.viewReceived("probe-surface", first, channel.plugin, channel.generation, full)
	if len(fake.closed) != 1 || len(fake.created) != 2 {
		t.Fatalf("a message of the closed view changed the views: closed %d, created %d", len(fake.closed), len(fake.created))
	}
}

func retireAndReplaceView(t *testing.T, s *Surfaces, fake *lifecyclePlatform) (unsafe.Pointer, uint64) {
	t.Helper()
	old, ok := s.documents.view("probe-surface")
	if !ok || len(fake.created) != 1 {
		t.Fatalf("initial view state: channel %v, created %d", ok, len(fake.created))
	}
	retired := fake.created[0]
	endView(t, s, fake)
	current, ok := s.documents.view("probe-surface")
	if !ok || current.generation == old.generation || len(fake.created) != 2 {
		t.Fatalf("replacement view: channel %+v, created %d; want a new generation and one new view", current, len(fake.created))
	}
	return retired, old.generation
}
