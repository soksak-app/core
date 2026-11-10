package workbench

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

// The diagnostic transcript and the diagnostic hold of surface replies, which act on the workbench of the window on every host
// (docs/spec/endpoint.md): they are the Go form of transcript.js and surface-reply-hold.js of packages/workbench, so the three
// applications write the same lines in the same order.

// Transcript records each host call of the workbench that was answered, with its answer, as one line `host <name> <argument> ->
// <answer>` while it is on (diagnostics.transcript). A host can answer calls on several goroutines at once, so a line is sent only
// after the sending of the line before it ended, in the order of the answers.
type Transcript struct {
	send      func(line string, sent func())
	recording bool
	waiting   []string
	sending   bool
}

// NewTranscript returns a transcript that is off. send sends one line and calls sent when its sending ended.
func NewTranscript(send func(line string, sent func())) *Transcript {
	return &Transcript{send: send}
}

// Set turns the recording on or off; a line recorded before it still goes out.
func (t *Transcript) Set(on bool) { t.recording = on }

// Record records the call name with its argument and its answer value. A failed call is reported by its caller, and a call of
// unrecordedCalls is not recorded, because the line of the log call that sends a line would record itself.
func (t *Transcript) Record(name string, argument, value any, failure error) {
	if !t.recording || failure != nil || unrecordedCalls[name] {
		return
	}
	t.waiting = append(t.waiting, fmt.Sprintf("host %s %s -> %s", name, transcriptValue(argument), transcriptValue(value)))
	t.next()
}

// next sends the first waiting line unless a line is being sent.
func (t *Transcript) next() {
	if t.sending || len(t.waiting) == 0 {
		return
	}
	line := t.waiting[0]
	t.waiting = t.waiting[1:]
	t.sending = true
	t.send(line, func() {
		t.sending = false
		t.next()
	})
}

// transcriptValue is the text of a value in a line: an empty answer, which each framework gives in its own form, is null in one
// form, and any other value is its JSON text as JSON.stringify writes it, without escaping HTML characters.
func transcriptValue(value any) string {
	var text bytes.Buffer
	encoder := json.NewEncoder(&text)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return fmt.Sprintf("%q", fmt.Sprint(value))
	}
	encoded := strings.TrimSuffix(text.String(), "\n")
	if encoded == "{}" {
		return "null"
	}
	return encoded
}

// registerTranscript answers diagnostics.transcript, which the host sends at the first subscription and the last release of the
// transcript of the window: the workbench sends each line with the action transcript of the host call log and the start of the
// workbench (docs/spec/logging.md).
func (s *Shell) registerTranscript() {
	s.transcript = NewTranscript(func(line string, sent func()) {
		s.calls.Call("log", map[string]any{"action": "transcript", "start": s.events.Start(), "line": line}, func(_ any, err error) {
			if err != nil {
				s.options.Report(fmt.Sprintf("transcript send failed: %v", err))
			}
			sent()
		})
	})
	s.calls.Transcribe(s.transcript.Record)
	s.registry.Method("diagnostics.transcript", func(raw json.RawMessage, answer func(any, error)) {
		value, err := params[struct {
			On bool `json:"on"`
		}](raw)
		if err != nil {
			answer(nil, Refuse(InvalidParams, "diagnostics.transcript: %s", err))
			return
		}
		s.transcript.Set(value.On)
		answer(nil, nil)
	})
}

// SurfaceReplyHold holds the exposure replies of a surface until the host reports the surface removed (diagnostics.surface.hold):
// the host ended the requests of the surface with 1003 then, so each held reply arrives after its request ended.
type SurfaceReplyHold struct {
	log   func(line string)
	holds map[string]*surfaceHold
}

// surfaceHold holds the sends of the replies of one surface and the waiters of diagnostics.surface.held.
type surfaceHold struct {
	sends   []func(sent func())
	waiters []func(err error)
}

// NewSurfaceReplyHold returns a hold that holds no surface. log writes one observation line to the application log.
func NewSurfaceReplyHold(log func(line string)) *SurfaceReplyHold {
	return &SurfaceReplyHold{log: log, holds: map[string]*surfaceHold{}}
}

// Hold starts holding the replies of surface.
func (h *SurfaceReplyHold) Hold(surface string) error {
	if surface == "" {
		return errors.New("diagnostics.surface.hold requires surface")
	}
	if h.holds[surface] != nil {
		return fmt.Errorf("exposure replies of surface %q are already held", surface)
	}
	h.holds[surface] = &surfaceHold{}
	return nil
}

// Held calls done once surface holds a reply, with an error when surface is not held or closes first.
func (h *SurfaceReplyHold) Held(surface string, done func(err error)) {
	if surface == "" {
		done(errors.New("diagnostics.surface.held requires surface"))
		return
	}
	hold := h.holds[surface]
	switch {
	case hold == nil:
		done(fmt.Errorf("exposure replies of surface %q are not held", surface))
	case len(hold.sends) > 0:
		done(nil)
	default:
		hold.waiters = append(hold.waiters, done)
	}
}

// Gate sends a reply of surface with send, which calls sent when the host answered it, or holds it while surface is held.
func (h *SurfaceReplyHold) Gate(surface string, send func(sent func())) {
	hold := h.holds[surface]
	if hold == nil {
		send(func() {})
		return
	}
	hold.sends = append(hold.sends, send)
	waiters := hold.waiters
	hold.waiters = nil
	for _, waiter := range waiters {
		waiter(nil)
	}
}

// Closed ends the hold of surface when the host removed it: it sends the held replies in the order they were held and writes the
// observation line once the host answered each of them.
func (h *SurfaceReplyHold) Closed(surface string) {
	h.end(surface, fmt.Errorf("surface %q closed before it held an exposure reply", surface), "were sent after the surface closed")
}

// Released ends the hold of surface before the host removed it, when the endpoint connection that asked for the hold closed (the
// host event diagnostics-surface-released). It sends the held replies as Closed does (docs/spec/endpoint.md).
func (h *SurfaceReplyHold) Released(surface string) {
	h.end(surface, fmt.Errorf("the hold of surface %q ended before it held an exposure reply", surface), "were sent after their hold ended")
}

// end ends the hold of surface: each waiter of Held fails with refusal, the held replies are sent in order, and the line
// `held exposure replies of surface "<surface>" <ended> (<count>)` is written once the host answered each.
func (h *SurfaceReplyHold) end(surface string, refusal error, ended string) {
	hold := h.holds[surface]
	if hold == nil {
		return
	}
	delete(h.holds, surface)
	for _, waiter := range hold.waiters {
		waiter(refusal)
	}
	count := len(hold.sends)
	line := fmt.Sprintf("held exposure replies of surface %q %s (%d)", surface, ended, count)
	if count == 0 {
		h.log(line)
		return
	}
	left := count
	for _, send := range hold.sends {
		send(func() {
			left--
			if left == 0 {
				h.log(line)
			}
		})
	}
}

// registerSurfaceHold answers diagnostics.surface.hold and diagnostics.surface.held for the surfaces of the workbench.
func (s *Shell) registerSurfaceHold() {
	s.replyHold = NewSurfaceReplyHold(s.events.Info)
	s.registry.Method("diagnostics.surface.hold", func(raw json.RawMessage, answer func(any, error)) {
		value, err := params[struct {
			Surface string `json:"surface"`
		}](raw)
		if err != nil {
			answer(nil, Refuse(InvalidParams, "diagnostics.surface.hold: %s", err))
			return
		}
		if value.Surface != "" && s.surfaces.held[value.Surface] == nil {
			answer(nil, fmt.Errorf("surface %s is not mounted", value.Surface))
			return
		}
		answer(nil, s.replyHold.Hold(value.Surface))
	})
	s.registry.Method("diagnostics.surface.held", func(raw json.RawMessage, answer func(any, error)) {
		value, err := params[struct {
			Surface string `json:"surface"`
		}](raw)
		if err != nil {
			answer(nil, Refuse(InvalidParams, "diagnostics.surface.held: %s", err))
			return
		}
		s.replyHold.Held(value.Surface, func(err error) { answer(nil, err) })
	})
}
