package host

// The one entrance of the host calls of a page (docs/spec/logging.md#entrances): the page calls the single bound method
// `Bindings.Call` with the name of a method of the host and its arguments, and the method that runs is looked up by name.
// Every call is the event `host.binding.call`, whether or not the performance trace is on, and a method that is added to
// the host is reachable and recorded without a second declaration.

import (
	"context"
	"encoding/json"
	"fmt"
	"reflect"
	"regexp"
	"strings"
	"time"
)

// bindingService is the name that Wails derives from the Go package path and the type name of the bound service.
const bindingService = "github.com/soksak-app/core/packages/host/wailsv3/src.Bindings"

var (
	contextType = reflect.TypeOf((*context.Context)(nil)).Elem()
	errorType   = reflect.TypeOf((*error)(nil)).Elem()
	rawType     = reflect.TypeOf(json.RawMessage(nil))
)

// binding is one method of the target: its function and whether its first parameter is the context.
type binding struct {
	fn           reflect.Value
	needsContext bool
}

// Bindings is the service that Wails binds. Its only bound method is Call.
type Bindings struct {
	methods map[string]binding
}

// NewBindings reads the exported methods of target. A method must take an optional context and then json.RawMessage
// arguments, and return nothing, an error, a value or a value and an error; another shape is an error that names the
// method, so a host with a method that the entrance cannot call does not start.
func NewBindings(target any) (*Bindings, error) {
	value := reflect.ValueOf(target)
	b := &Bindings{methods: map[string]binding{}}
	for i := 0; i < value.NumMethod(); i++ {
		name := value.Type().Method(i).Name
		kind := value.Method(i).Type()
		entry := binding{fn: value.Method(i)}
		for p := 0; p < kind.NumIn(); p++ {
			switch {
			case p == 0 && kind.In(p) == contextType:
				entry.needsContext = true
			case kind.In(p) == rawType && !kind.IsVariadic():
			default:
				return nil, fmt.Errorf("host method %s takes %s, which the call entrance does not pass", name, kind.In(p))
			}
		}
		last := kind.NumOut() - 1
		if kind.NumOut() > 2 || (kind.NumOut() == 2 && kind.Out(last) != errorType) {
			return nil, fmt.Errorf("host method %s returns %d values, which the call entrance does not read", name, kind.NumOut())
		}
		b.methods[name] = entry
	}
	return b, nil
}

// Call runs the method `method` of the target with args and returns its value, and stores the event `host.binding.call`
// for the call. A call that names no method, or passes another number of arguments than the method takes, is an error. A
// method that panics is stored as a call that ended without a result, and the panic goes on to the caller.
func (b *Bindings) Call(ctx context.Context, method string, args []json.RawMessage) (result any, err error) {
	started := time.Now()
	returned := false
	defer func() { recordBindingCall(snakeName(method), args, started, err, returned) }()
	result, err = b.run(ctx, method, args)
	returned = true
	return result, err
}

func (b *Bindings) run(ctx context.Context, method string, args []json.RawMessage) (any, error) {
	entry, ok := b.methods[method]
	if !ok {
		return nil, fmt.Errorf("unknown host call: %s", method)
	}
	kind := entry.fn.Type()
	count := len(args)
	if entry.needsContext {
		count++
	}
	if count != kind.NumIn() {
		return nil, fmt.Errorf("%s.%s expects %d arguments, got %d", bindingService, method, kind.NumIn(), count)
	}
	in := make([]reflect.Value, 0, count)
	if entry.needsContext {
		in = append(in, reflect.ValueOf(ctx))
	}
	for _, arg := range args {
		in = append(in, reflect.ValueOf(arg))
	}
	out := entry.fn.Call(in)
	var result any
	var err error
	for _, value := range out {
		if value.Type() == errorType {
			if !value.IsNil() {
				err = value.Interface().(error)
			}
		} else {
			result = value.Interface()
		}
	}
	return result, err
}

var (
	snakeLower = regexp.MustCompile(`([a-z0-9])([A-Z])`)
	snakeUpper = regexp.MustCompile(`([A-Z])([A-Z][a-z])`)
)

// snakeName is the form in which both hosts name a call in an event: the Go method name `ClipboardPersistPNG` is
// `clipboard_persist_png`, the name of the command of the Tauri host.
func snakeName(name string) string {
	return strings.ToLower(snakeUpper.ReplaceAllString(snakeLower.ReplaceAllString(name, "${1}_${2}"), "${1}_${2}"))
}

// boundedArguments returns the JSON array of args, which is the arguments of the call in the order of the call, cut to
// CallTextBytes on a character boundary, and whether it was cut. Only the bytes that are kept are copied.
func boundedArguments(args []json.RawMessage) (string, bool) {
	var text strings.Builder
	text.WriteByte('[')
	for i, arg := range args {
		if i > 0 {
			text.WriteByte(',')
		}
		if text.Len() >= CallTextBytes {
			return text.String(), true
		}
		room := CallTextBytes - text.Len()
		if len(arg) > room {
			// silent: the length of arg is over room, so the cut is known and the event says truncated.
			part, _ := cutText(arg, room)
			text.WriteString(part)
			return text.String(), true
		}
		text.Write(arg)
	}
	if text.Len() >= CallTextBytes {
		return text.String(), true
	}
	text.WriteByte(']')
	return text.String(), false
}

// recordBindingCall stores the event `host.binding.call` of one call: the name, the arguments cut before they are
// copied, the result and the microseconds since started. A call that failed or ended without a result is at the level
// `warn`, and its error text is the text that the caller receives, cut the same way.
func recordBindingCall(name string, args []json.RawMessage, started time.Time, err error, returned bool) {
	micros := time.Since(started).Microseconds()
	text, truncated := boundedArguments(args)
	if returned && err == nil {
		EmitHost(LevelDebug, "host.binding.call", map[string]any{
			"name": name, "args": text, "micros": micros, "ok": true, "truncated": truncated,
		})
		return
	}
	message := "the call ended without a result"
	if err != nil {
		message = err.Error()
	}
	message, cut := cutText(message, CallTextBytes)
	EmitHost(LevelWarn, "host.binding.call", map[string]any{
		"name": name, "args": text, "micros": micros, "ok": false, "truncated": truncated || cut, "error": message,
	})
}
