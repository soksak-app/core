// Package sok is the command line of the soksak application (docs/spec/cli.md). It sends requests to the endpoint of a
// running application and prints the result as JSON.
package sok

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"os/signal"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"syscall"
)

// Usage is the usage text.
const Usage = `usage: sok <command> [options]

commands:
  <declared command> [window] [--surface S] [--<parameter> VALUE]... [--params JSON]
  commands [window]
  windows
  exposures [window]
  status NAME [window] [--surface S] [--watch]
  dom rect|click|input|dispatch NAME [window] [--surface S] [--index N] [--value V] [--event JSON]
  input pointer [window] --x X --y Y --phase move|down|drag|up|scroll [--button left|right] [--delta-x N] [--delta-y N] [--activate]
  input key [window] --key K --phase down|up [--text T] [--modifiers shift,control,option,command]
  debug query [--channel C] [--level L] [--class C] [--layer L] [--event E] [--event-prefix P] [--surface S] [--session S] [--cid C] [--run R] [--text T] [--from T] [--to T] [--order asc|desc] [--limit N] [--after CURSOR]
                            prints one page of the events of the event files that pass the filter
  capture [window]          (diagnostic builds) writes a still image of the window without focusing it
  path install|remove       writes or deletes the PATH entry of this application (needs sudo)
  app update --wait PID --bundle PATH --target PATH [-- ARGUMENT...]
                            replaces the application bundle TARGET with BUNDLE after the process PID ended
  plugin pack DIRECTORY OUTPUT [--diagnostics]
                            writes the plugin into OUTPUT; --diagnostics adds diagnostics.json
  sidecar release DIRECTORY OUTPUT [--platform P]
                            writes the sidecar release into OUTPUT and updates SHA256SUMS
  registry build DIRECTORY  checks a registry and writes its index.json
  registry use INDEX        sets the registry index that installation reads
  plugin install|update|remove|enable|disable ID
                            changes the installed plugins of the configuration directory
  plugin list               prints plugins/installed.json

window:
  --window NAME | --project DIRECTORY   without either, the only window of the application

common options:
  --config-dir DIR          configuration directory of the running application (default: this application's)`

// UsageError is a wrongly written command. It is reported with exit status 2 and the usage text.
type UsageError struct{ message string }

func (e UsageError) Error() string { return e.message }

func usage(format string, args ...any) error { return UsageError{fmt.Sprintf(format, args...)} }

// booleans are the flags that take no value.
var booleans = map[string]bool{"watch": true, "activate": true, "help": true, "diagnostics": true}

// options are the flags that take a value.
var options = map[string]bool{
	"config-dir": true, "window": true, "project": true, "surface": true, "index": true, "value": true, "event": true,
	"wait": true, "bundle": true, "target": true, "x": true, "y": true, "phase": true, "platform": true, "button": true, "delta-x": true, "delta-y": true, "key": true, "text": true, "modifiers": true,
	"level": true, "layer": true, "session": true, "cid": true, "from": true, "to": true,
	"channel": true, "class": true, "event-prefix": true, "run": true, "order": true, "limit": true, "after": true,
}

type arguments struct {
	positionals []string
	values      map[string]string
	flags       map[string]bool
}

func parse(args []string) (arguments, error) {
	parsed := arguments{values: map[string]string{}, flags: map[string]bool{}}
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if !strings.HasPrefix(arg, "--") {
			parsed.positionals = append(parsed.positionals, arg)
			continue
		}
		name, value, inline := strings.Cut(arg[2:], "=")
		switch {
		case booleans[name]:
			if inline {
				return parsed, usage("--%s takes no value", name)
			}
			parsed.flags[name] = true
		case options[name]:
			if _, seen := parsed.values[name]; seen {
				return parsed, usage("--%s is given twice", name)
			}
			if !inline {
				if i+1 >= len(args) {
					return parsed, usage("--%s needs a value", name)
				}
				i++
				value = args[i]
			}
			parsed.values[name] = value
		default:
			return parsed, usage("unknown option --%s", name)
		}
	}
	return parsed, nil
}

func (a arguments) required(name string) (string, error) {
	value, ok := a.values[name]
	if !ok {
		return "", usage("--%s is required", name)
	}
	return value, nil
}

func (a arguments) positional(index int, what string) (string, error) {
	if index >= len(a.positionals) {
		return "", usage("%s is required", what)
	}
	return a.positionals[index], nil
}

func (a arguments) number(name string) (any, error) {
	text, ok := a.values[name]
	if !ok {
		return nil, nil
	}
	value, err := strconv.ParseFloat(strings.TrimSpace(text), 64)
	if strings.TrimSpace(text) == "" || err != nil || math.IsInf(value, 0) || math.IsNaN(value) {
		return nil, usage("--%s must be a number", name)
	}
	return value, nil
}

func (a arguments) requiredNumber(name string) (any, error) {
	if _, err := a.required(name); err != nil {
		return nil, err
	}
	return a.number(name)
}

// compact is the request parameters without the fields that are nil.
func compact(fields ...any) map[string]any {
	params := map[string]any{}
	for i := 0; i+1 < len(fields); i += 2 {
		if value := fields[i+1]; value != nil {
			params[fields[i].(string)] = value
		}
	}
	return params
}

func optional(a arguments, name string) any {
	if value, ok := a.values[name]; ok {
		return value
	}
	return nil
}

// plan turns the command into an endpoint request. window is the function that chooses the window.
// captureRequest is the capture request that diagnostics.go defines in a diagnostic build. It is nil in a regular
// build.
var captureRequest func(window string) (request, error)

type request struct {
	method string
	params map[string]any
	watch  bool
	// field is the field of the result object to print. When it is empty, the whole result is printed.
	field string
}

func plan(a arguments, window func() (string, error)) (request, error) {
	command, err := a.positional(0, "command")
	if err != nil {
		return request{}, err
	}
	withWindow := func(build func(string) (request, error)) (request, error) {
		name, err := window()
		if err != nil {
			return request{}, err
		}
		return build(name)
	}
	switch command {
	case "windows":
		return request{method: "windows.list"}, nil
	case "commands":
		return withWindow(func(w string) (request, error) {
			return request{method: "exposure.list", params: compact("window", w), field: "commands"}, nil
		})
	case "exposures":
		return withWindow(func(w string) (request, error) {
			return request{method: "exposure.list", params: compact("window", w)}, nil
		})
	case "capture":
		// Only the diagnostic build has the capture request (diagnostics.go). The sok of a regular build has no diagnostic
		// methods.
		if captureRequest == nil {
			return request{}, usage("capture needs a diagnostic build of sok")
		}
		return withWindow(captureRequest)
	case "status":
		name, err := a.positional(1, "NAME")
		if err != nil {
			return request{}, err
		}
		return withWindow(func(w string) (request, error) {
			method := "status.get"
			if a.flags["watch"] {
				method = "status.watch"
			}
			return request{method: method, params: compact("window", w, "name", name, "surface", optional(a, "surface")), watch: a.flags["watch"]}, nil
		})
	case "dom":
		action, err := a.positional(1, "dom action")
		if err != nil {
			return request{}, err
		}
		name, err := a.positional(2, "NAME")
		if err != nil {
			return request{}, err
		}
		index, err := a.number("index")
		if err != nil {
			return request{}, err
		}
		return withWindow(func(w string) (request, error) {
			base := []any{"window", w, "name", name, "surface", optional(a, "surface"), "index", index}
			switch action {
			case "rect":
				return request{method: "dom.rect", params: compact(base...)}, nil
			case "click":
				return request{method: "dom.act", params: compact(append(base, "action", "click")...)}, nil
			case "input":
				value, err := a.required("value")
				if err != nil {
					return request{}, err
				}
				return request{method: "dom.act", params: compact(append(base, "action", "input", "value", value)...)}, nil
			case "dispatch":
				text, err := a.required("event")
				if err != nil {
					return request{}, err
				}
				var event map[string]any
				if err := json.Unmarshal([]byte(text), &event); err != nil || event == nil {
					return request{}, usage("--event must be a JSON object with a type")
				}
				if _, ok := event["type"].(string); !ok {
					return request{}, usage("--event must be a JSON object with a type")
				}
				return request{method: "dom.act", params: compact(append(base, "action", "dispatch", "event", event)...)}, nil
			}
			return request{}, usage("unknown dom action: %s", action)
		})
	case "input":
		kind, err := a.positional(1, "input kind")
		if err != nil {
			return request{}, err
		}
		switch kind {
		case "pointer":
			phase, err := a.required("phase")
			if err != nil {
				return request{}, err
			}
			if button, ok := a.values["button"]; ok && button != "left" && button != "right" {
				return request{}, usage("--button must be left or right")
			}
			if a.flags["activate"] && phase != "move" {
				return request{}, usage("--activate applies to --phase move")
			}
			x, err := a.requiredNumber("x")
			if err != nil {
				return request{}, err
			}
			y, err := a.requiredNumber("y")
			if err != nil {
				return request{}, err
			}
			deltaX, err := a.number("delta-x")
			if err != nil {
				return request{}, err
			}
			deltaY, err := a.number("delta-y")
			if err != nil {
				return request{}, err
			}
			var activate any
			if a.flags["activate"] {
				activate = true
			}
			return withWindow(func(w string) (request, error) {
				return request{method: "input.pointer", params: compact("window", w, "x", x, "y", y, "phase", phase,
					"button", optional(a, "button"), "deltaX", deltaX, "deltaY", deltaY, "activate", activate)}, nil
			})
		case "key":
			key, err := a.required("key")
			if err != nil {
				return request{}, err
			}
			phase, err := a.required("phase")
			if err != nil {
				return request{}, err
			}
			var modifiers any
			if text, ok := a.values["modifiers"]; ok {
				list := []string{}
				for _, item := range strings.Split(text, ",") {
					if item != "" {
						list = append(list, item)
					}
				}
				modifiers = list
			}
			return withWindow(func(w string) (request, error) {
				return request{method: "input.key", params: compact("window", w, "key", key, "phase", phase,
					"text", optional(a, "text"), "modifiers", modifiers)}, nil
			})
		}
		return request{}, usage("unknown input kind: %s", kind)
	}
	return request{}, usage("unknown command: %s", command)
}

// windowEntry is one window of the windows.list result.
type windowEntry struct {
	Window  string  `json:"window"`
	Project *string `json:"project"`
}

// selectWindow chooses the window to request with --window, --project or the only window.
func selectWindow(a arguments, client *Client) (string, error) {
	name, byName := a.values["window"]
	project, byProject := a.values["project"]
	if byName && byProject {
		return "", usage("--window and --project select the window in two ways; give one")
	}
	if byName {
		return name, nil
	}
	result, err := client.Request("windows.list", nil)
	if err != nil {
		return "", err
	}
	var windows []windowEntry
	if err := json.Unmarshal(result, &windows); err != nil {
		return "", fmt.Errorf("windows.list returned an unexpected value: %w", err)
	}
	names := make([]string, 0, len(windows))
	for _, entry := range windows {
		names = append(names, entry.Window)
	}
	sort.Strings(names)
	if byProject {
		target, err := filepath.EvalSymlinks(project)
		if err != nil {
			return "", fmt.Errorf("project directory %s: %w", project, err)
		}
		for _, entry := range windows {
			if entry.Project == nil {
				continue
			}
			if open, err := filepath.EvalSymlinks(*entry.Project); err == nil && open == target {
				return entry.Window, nil
			}
		}
		return "", fmt.Errorf("no window shows the project %s; windows: %s", target, strings.Join(names, ", "))
	}
	if len(windows) != 1 {
		return "", usage("the application has %d windows (%s); select one with --window or --project", len(windows), strings.Join(names, ", "))
	}
	return windows[0].Window, nil
}

// indent indents JSON by two spaces and keeps the key order.
func indent(raw json.RawMessage) ([]byte, error) {
	var out bytes.Buffer
	if err := json.Indent(&out, raw, "", "  "); err != nil {
		return nil, fmt.Errorf("endpoint returned invalid JSON: %w", err)
	}
	out.WriteByte('\n')
	return out.Bytes(), nil
}

func compactLine(raw json.RawMessage) ([]byte, error) {
	var out bytes.Buffer
	if err := json.Compact(&out, raw); err != nil {
		return nil, fmt.Errorf("endpoint returned invalid JSON: %w", err)
	}
	out.WriteByte('\n')
	return out.Bytes(), nil
}

// watch prints the status value and each later change, one per line. On SIGINT or SIGTERM it closes the connection and
// ends successfully.
func watch(client *Client, params map[string]any, stdout io.Writer) error {
	stopped := make(chan struct{})
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM)
	defer signal.Stop(signals)
	// The goroutine that receives the interrupt signal sends the result of closing the connection. When the close fails,
	// watch ends with that error.
	closed := make(chan error, 1)
	Go("interrupt", func() {
		if _, ok := <-signals; ok {
			close(stopped)
			closed <- client.Close()
		}
	})
	matches := func(raw json.RawMessage) (json.RawMessage, bool, error) {
		var changed struct {
			Window  string          `json:"window"`
			Name    string          `json:"name"`
			Surface *string         `json:"surface"`
			Value   json.RawMessage `json:"value"`
		}
		if err := json.Unmarshal(raw, &changed); err != nil {
			return nil, false, fmt.Errorf("status.changed has unexpected params: %w", err)
		}
		// default: a watch without a surface is the page status and its surface is the empty string; the comparison below
		// masks it with nil.
		surface, _ := params["surface"].(string)
		same := changed.Window == params["window"] && changed.Name == params["name"] &&
			((changed.Surface == nil && params["surface"] == nil) || (changed.Surface != nil && *changed.Surface == surface))
		return changed.Value, same, nil
	}
	print := func(raw json.RawMessage) error {
		line, err := compactLine(raw)
		if err != nil {
			return err
		}
		_, err = stdout.Write(line)
		return err
	}
	client.Notify = func(method string, raw json.RawMessage) error {
		if method != "status.changed" {
			return nil
		}
		value, same, err := matches(raw)
		if err != nil || !same {
			return err
		}
		return print(value)
	}
	finish := func(err error) error {
		select {
		case <-stopped:
			return <-closed
		default:
			return err
		}
	}
	if _, err := client.Request("status.watch", params); err != nil {
		return finish(err)
	}
	target := map[string]any{"window": params["window"], "name": params["name"]}
	if surface, ok := params["surface"]; ok {
		target["surface"] = surface
	}
	value, err := client.Request("status.get", target)
	if err != nil {
		return finish(err)
	}
	if err := print(value); err != nil {
		return err
	}
	return finish(client.Listen())
}

// Options are the application and the operating system slots that the command line belongs to.
type Options struct {
	// Identifier is the identifier of the application. It is the name of the configuration directory when --config-dir is
	// absent and the file name of the path entry.
	Identifier string
	// PathsDir is the folder that holds path entries (/etc/paths.d on macOS).
	PathsDir string
	// PathsError is the reason this operating system has no path entry folder. When it is set, sok path fails with that
	// error.
	PathsError error
	// CoreVersion is the core version used to choose plugins. The executable passes the CoreVersion of this Go package.
	CoreVersion string
}

// Run runs one command and returns the exit status.
func Run(args []string, stdout, stderr io.Writer, options Options) int {
	err := run(args, stdout, stderr, options)
	if err == nil {
		return 0
	}
	// When the error cannot be written to the standard error, there is no place to report it, so it is reported with exit
	// status 3 (docs/spec/cli.md).
	var invalid UsageError
	if errors.As(err, &invalid) {
		if _, writeErr := fmt.Fprintf(stderr, "sok: %s\n%s\n", err, Usage); writeErr != nil {
			return 3
		}
		return 2
	}
	if _, writeErr := fmt.Fprintf(stderr, "sok: %s\n", err); writeErr != nil {
		return 3
	}
	return 1
}

// connectTo finds the endpoint in --config-dir or the configuration directory of this application and connects to it.
func connectTo(values map[string]string, options Options) (*Client, error) {
	configDir, err := configDirOf(values, options)
	if err != nil {
		return nil, err
	}
	endpoint, err := ReadEndpoint(configDir)
	if err != nil {
		return nil, err
	}
	return Dial(endpoint)
}

func run(args []string, stdout, stderr io.Writer, options Options) (err error) {
	// The arguments after -- are those of the application that starts again, so the command parses its own.
	if len(args) > 0 && args[0] == "app" {
		return runApp(args[1:], stdout)
	}
	// A command word with a dot is a declared command (docs/spec/cli.md).
	if strings.Contains(commandWord(args), ".") {
		return runCommand(args, stdout, options)
	}
	a, err := parse(args)
	if err != nil {
		return err
	}
	if a.flags["help"] {
		_, err := fmt.Fprintln(stdout, Usage)
		return err
	}
	if len(a.positionals) > 1 && (a.positionals[0] == "plugin" && a.positionals[1] != "pack" || a.positionals[0] == "registry" && a.positionals[1] == "use") {
		return runPlugins(a, stdout, options)
	}
	if len(a.positionals) > 0 && a.positionals[0] == "registry" {
		return runRegistry(a, stdout)
	}
	if len(a.positionals) > 0 && (a.positionals[0] == "plugin" || a.positionals[0] == "sidecar") {
		return runFiles(a, stdout)
	}
	if len(a.positionals) > 0 && a.positionals[0] == "debug" {
		return runDebug(a, stdout, stderr, options)
	}
	if len(a.positionals) > 0 && a.positionals[0] == "path" {
		action, err := a.positional(1, "path action")
		if err != nil {
			return err
		}
		return runPath(action, stdout, options)
	}
	var client *Client
	connect := func() (*Client, error) {
		if client != nil {
			return client, nil
		}
		var err error
		client, err = connectTo(a.values, options)
		return client, err
	}
	// When the command succeeded, the result of closing the connection is also reported. When it failed, that failure is
	// the result.
	defer func() {
		if client != nil {
			if closeErr := client.Close(); closeErr != nil && err == nil {
				err = closeErr
			}
		}
	}()
	req, err := plan(a, func() (string, error) {
		c, err := connect()
		if err != nil {
			return "", err
		}
		return selectWindow(a, c)
	})
	if err != nil {
		return err
	}
	c, err := connect()
	if err != nil {
		return err
	}
	if req.watch {
		return watch(c, req.params, stdout)
	}
	var params any
	if req.params != nil {
		params = req.params
	}
	result, err := c.Request(req.method, params)
	if err != nil {
		return err
	}
	if req.field != "" {
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(result, &fields); err != nil || fields[req.field] == nil {
			return fmt.Errorf("%s returned no %s", req.method, req.field)
		}
		result = fields[req.field]
	}
	out, err := indent(result)
	if err != nil {
		return err
	}
	_, err = stdout.Write(out)
	return err
}

// runFiles runs the plugin and sidecar commands that write files without a running application.
func runFiles(a arguments, stdout io.Writer) error {
	action, err := a.positional(1, a.positionals[0]+" action")
	if err != nil {
		return err
	}
	command := a.positionals[0] + " " + action
	if command != "plugin pack" && command != "sidecar release" {
		return usage("unknown command: %s", command)
	}
	dir, err := a.positional(2, "directory")
	if err != nil {
		return err
	}
	out, err := a.positional(3, "output directory")
	if err != nil {
		return err
	}
	if len(a.positionals) > 4 {
		return usage("unexpected argument %s", a.positionals[4])
	}
	if command == "plugin pack" {
		return runPack(dir, out, a.flags["diagnostics"], stdout)
	}
	if a.flags["diagnostics"] {
		return usage("--diagnostics belongs to plugin pack")
	}
	platform, given := a.values["platform"]
	if !given {
		if platform, err = CurrentPlatform(); err != nil {
			return err
		}
	} else if err := checkPlatform(platform); err != nil {
		return usage("--platform: %s", err)
	}
	return runRelease(dir, out, platform, stdout)
}
