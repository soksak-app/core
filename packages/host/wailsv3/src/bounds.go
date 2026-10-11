package host

// The bound on text that an event carries (docs/spec/logging.md#bounds). A producer cuts a value to its bound before it
// copies or serializes the value, so the cost of recording does not depend on the size of the value.

import "unicode/utf8"

// CallTextBytes is the bound in bytes of the arguments and of the error text that a call event stores.
const CallTextBytes = 1024

// The bounds of the event writer and of the buffers of the host (docs/spec/logging.md#bounds).
const (
	// EventFieldsLimitBytes is the largest size in bytes of the fields of an event; an event over it is stored cut.
	EventFieldsLimitBytes = 1 << 20
	// EventHeadBytes is the number of bytes of the fields text that a cut event keeps.
	EventHeadBytes = 4096
	// PendingMessages and PendingBytes bound each list of pending messages of a sidecar (replies and closes).
	PendingMessages = 1024
	PendingBytes    = 4 << 20
)

// cutText returns the first limit bytes of text, backed up to a rune boundary, and whether text was longer. Only the bytes
// that are kept are copied.
func cutText[T ~string | ~[]byte](text T, limit int) (string, bool) {
	if len(text) <= limit {
		return string(text), false
	}
	end := limit
	for end > 0 && !utf8.RuneStart(text[end]) {
		end--
	}
	return string(text[:end]), true
}
