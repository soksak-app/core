package host

// The bound on text that an event carries (docs/spec/logging.md#bounds). A producer cuts a value to its bound before it
// copies or serializes the value, so the cost of recording does not depend on the size of the value.

import "unicode/utf8"

// CallTextBytes is the bound in bytes of the arguments and of the error text that a call event stores.
const CallTextBytes = 1024

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
