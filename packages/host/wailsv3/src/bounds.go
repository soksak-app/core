package host

// The bound on text that an event carries (docs/spec/logging.md#bounds). A producer cuts a value to its bound before it
// copies or serializes the value, so the cost of recording does not depend on the size of the value.

import (
	"encoding/json"
	"errors"
	"reflect"
	"sort"
	"unicode/utf8"
)

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
	// StartBufferBytes bounds the start buffer of the records of the host in bytes, besides StartBufferRecords.
	StartBufferBytes = 4 << 20
	// RecordTextBytes and RecordPlaceBytes are the bounds of the text and of the place of a record in an event.
	RecordTextBytes  = 8192
	RecordPlaceBytes = 1024
	// EndpointTopicChanges bounds the subscription changes that wait for the page for one topic of the endpoint.
	EndpointTopicChanges = 256
	// EndpointOutputFrames and EndpointOutputBytes bound the frames that wait for the socket of one connection.
	EndpointOutputFrames = 256
	EndpointOutputBytes  = 16 << 20
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

// The bounded serialization of the fields of an event: the walk of the value ends when the text is longer than the bound, so
// the cost of recording an event does not depend on the size of its value.

// errFull ends the walk of a value whose text reached the bound.
var errFull = errors.New("the text reached the bound")

// boundedMarshal returns the JSON text of v. When the text is longer than limit, the walk ends there: the first result is the
// first limit bytes of the text, and produced is the number of bytes that the walk had written when it stopped, which is
// greater than limit; otherwise produced is 0. The containers (maps, slices, arrays, pointers, interfaces) and the strings are
// walked, a json.RawMessage is copied only up to the room left, and a value of another kind (a struct, a number, a type that
// marshals itself) is marshaled as one element, so the elements of a container are read only up to the bound.
func boundedMarshal(v any, limit int) (text []byte, produced int, err error) {
	w := &boundedText{limit: limit}
	err = w.walk(reflect.ValueOf(v))
	if errors.Is(err, errFull) {
		// A string cut on a character boundary can leave the text short of the bound; the walk still ended there.
		return w.buf[:min(len(w.buf), limit)], max(len(w.buf), limit+1), nil
	}
	if err != nil {
		return nil, 0, err
	}
	return w.buf, 0, nil
}

type boundedText struct {
	buf   []byte
	limit int
}

// add appends text and reports errFull when the text is longer than the bound.
func (w *boundedText) add(text ...byte) error {
	w.buf = append(w.buf, text...)
	if len(w.buf) > w.limit {
		return errFull
	}
	return nil
}

var (
	marshalerType = reflect.TypeOf((*json.Marshaler)(nil)).Elem()
	rawMessage    = reflect.TypeOf(json.RawMessage(nil))
)

// leaf appends the text of one value that is marshaled as a whole.
func (w *boundedText) leaf(v reflect.Value) error {
	text, err := json.Marshal(v.Interface())
	if err != nil {
		return err
	}
	return w.add(text...)
}

func (w *boundedText) walk(v reflect.Value) error {
	if !v.IsValid() {
		return w.add('n', 'u', 'l', 'l')
	}
	if v.Type() == rawMessage {
		raw := v.Bytes()
		if len(raw) == 0 {
			return w.add('n', 'u', 'l', 'l')
		}
		room := w.limit - len(w.buf) + 1
		if len(raw) > room {
			raw = raw[:room]
		}
		return w.add(raw...)
	}
	if v.Type().Implements(marshalerType) && v.Kind() != reflect.Interface {
		if (v.Kind() == reflect.Pointer || v.Kind() == reflect.Map || v.Kind() == reflect.Slice) && v.IsNil() {
			return w.add('n', 'u', 'l', 'l')
		}
		return w.leaf(v)
	}
	switch v.Kind() {
	case reflect.Interface, reflect.Pointer:
		if v.IsNil() {
			return w.add('n', 'u', 'l', 'l')
		}
		return w.walk(v.Elem())
	case reflect.String:
		return w.text(v.String())
	case reflect.Slice:
		if v.IsNil() {
			return w.add('n', 'u', 'l', 'l')
		}
		if v.Type().Elem().Kind() == reflect.Uint8 {
			return w.leaf(v)
		}
		return w.list(v)
	case reflect.Array:
		return w.list(v)
	case reflect.Map:
		if v.IsNil() {
			return w.add('n', 'u', 'l', 'l')
		}
		if v.Type().Key().Kind() != reflect.String {
			return w.leaf(v)
		}
		return w.object(v)
	default:
		return w.leaf(v)
	}
}

// text appends a string, escaped. A string longer than the room left is cut before it is escaped, because the escaped text is
// at least as long as the string.
func (w *boundedText) text(s string) error {
	room := w.limit - len(w.buf) + 1
	if len(s) > room {
		// silent: the length of s is over room, so the cut is known and the walk ends with errFull.
		head, _ := cutText(s, room)
		encoded, err := json.Marshal(head)
		if err != nil {
			return err
		}
		// The closing quote is not written: the text is cut inside the string.
		w.buf = append(w.buf, encoded[:len(encoded)-1]...)
		return errFull
	}
	encoded, err := json.Marshal(s)
	if err != nil {
		return err
	}
	return w.add(encoded...)
}

func (w *boundedText) list(v reflect.Value) error {
	if err := w.add('['); err != nil {
		return err
	}
	for i := 0; i < v.Len(); i++ {
		if i > 0 {
			if err := w.add(','); err != nil {
				return err
			}
		}
		if err := w.walk(v.Index(i)); err != nil {
			return err
		}
	}
	return w.add(']')
}

// maxSortedKeys is the largest map whose keys are written in sorted order; the keys of a larger map are written as the map
// yields them, so a map of any size is not sorted before it is cut.
const maxSortedKeys = 1024

func (w *boundedText) object(v reflect.Value) error {
	if err := w.add('{'); err != nil {
		return err
	}
	var keys []reflect.Value
	if v.Len() <= maxSortedKeys {
		keys = v.MapKeys()
		sort.Slice(keys, func(i, j int) bool { return keys[i].String() < keys[j].String() })
	}
	member := func(index int, key, value reflect.Value) error {
		if index > 0 {
			if err := w.add(','); err != nil {
				return err
			}
		}
		if err := w.text(key.String()); err != nil {
			return err
		}
		if err := w.add(':'); err != nil {
			return err
		}
		return w.walk(value)
	}
	if keys != nil {
		for i, key := range keys {
			if err := member(i, key, v.MapIndex(key)); err != nil {
				return err
			}
		}
		return w.add('}')
	}
	index := 0
	for it := v.MapRange(); it.Next(); index++ {
		if err := member(index, it.Key(), it.Value()); err != nil {
			return err
		}
	}
	return w.add('}')
}
