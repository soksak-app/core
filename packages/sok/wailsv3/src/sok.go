// Package sok 은 soksak 애플리케이션의 command line(docs/spec/cli.md)이다. 실행 중인 애플리케이션의 엔드포인트에
// 요청을 보내고 결과를 JSON 으로 출력한다.
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

// Usage 는 사용법이다.
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
  capture [window]          (diagnostic builds) writes a still image of the window without focusing it
  path install|remove       writes or deletes the PATH entry of this application (needs sudo)
  plugin pack DIRECTORY OUTPUT [--diagnostics]
                            writes the plugin into OUTPUT; --diagnostics adds diagnostics.json
  sidecar release DIRECTORY OUTPUT [--platform P]
                            writes the sidecar release asset into OUTPUT and updates SHA256SUMS
  registry build DIRECTORY  checks a registry and writes its index.json
  registry use INDEX        sets the registry index that installation reads
  plugin install|update|remove|enable|disable ID
                            changes the installed plugins of the configuration directory
  plugin list               prints plugins/installed.json

window:
  --window NAME | --project DIRECTORY   without either, the only window of the application

common options:
  --config-dir DIR          configuration directory of the running application (default: this application's)`

// UsageError 는 잘못 쓴 명령이다. 종료 상태 2 와 사용법으로 보고한다.
type UsageError struct{ message string }

func (e UsageError) Error() string { return e.message }

func usage(format string, args ...any) error { return UsageError{fmt.Sprintf(format, args...)} }

// booleans 는 값을 받지 않는 flag 다.
var booleans = map[string]bool{"watch": true, "activate": true, "help": true, "diagnostics": true}

// options 는 값을 받는 flag 다.
var options = map[string]bool{
	"config-dir": true, "window": true, "project": true, "surface": true, "index": true, "value": true, "event": true,
	"x": true, "y": true, "phase": true, "platform": true, "button": true, "delta-x": true, "delta-y": true, "key": true, "text": true, "modifiers": true,
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

// compact 는 nil 인 필드를 뺀 요청 매개변수다.
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

// plan 은 명령을 엔드포인트 요청으로 바꾼다. window 는 창을 고르는 함수다.
// captureRequest 는 진단 build 에서 diagnostics.go 가 정하는 capture 요청이다. 일반 build 에서는 nil 이다.
var captureRequest func(window string) (request, error)

type request struct {
	method string
	params map[string]any
	watch  bool
	// field 는 결과 객체에서 출력할 필드다. 비어 있으면 결과 전체를 출력한다.
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
		// 진단 build 만 capture 요청을 둔다(diagnostics.go). 일반 build 의 sok 에는 진단 method 가 없다.
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

// windowEntry 는 windows.list 결과의 창 하나다.
type windowEntry struct {
	Window  string  `json:"window"`
	Project *string `json:"project"`
}

// selectWindow 는 --window, --project 또는 하나뿐인 창으로 요청할 창을 고른다.
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

// indent 는 JSON 을 키 순서를 그대로 두고 두 칸으로 들여 쓴다.
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

// watch 는 status 값과 그 뒤의 변경을 한 줄씩 출력한다. SIGINT 나 SIGTERM 이 오면 연결을 닫고 성공으로 끝난다.
func watch(client *Client, params map[string]any, stdout io.Writer) error {
	stopped := make(chan struct{})
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM)
	defer signal.Stop(signals)
	// 중단 신호를 받은 goroutine 은 연결을 닫은 결과를 보낸다. 닫기에 실패하면 watch 는 그 오류로 끝난다.
	closed := make(chan error, 1)
	go func() {
		if _, ok := <-signals; ok {
			close(stopped)
			closed <- client.Close()
		}
	}()
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
		// 기본값: surface 가 없는 감시는 페이지 status 이며 surface 는 빈 문자열이고, 아래 비교는 nil 로 가린다.
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

// Options 는 command line 이 속한 애플리케이션과 운영체제 자리다.
type Options struct {
	// Identifier 는 애플리케이션의 식별자이며 --config-dir 이 없을 때 설정 폴더 이름이고 경로 항목의 파일 이름이다.
	Identifier string
	// PathsDir 는 경로 항목을 두는 폴더다(macOS 는 /etc/paths.d).
	PathsDir string
	// PathsError 는 이 운영체제에 경로 항목 폴더가 없는 까닭이다. 있으면 sok path 가 그 오류로 실패한다.
	PathsError error
	// CoreVersion 은 plugin 을 고를 때 쓰는 core version 이다. 실행 파일은 이 package 의 CoreVersion 을 준다.
	CoreVersion string
}

// Run 은 명령 하나를 실행하고 종료 상태를 돌려준다.
func Run(args []string, stdout, stderr io.Writer, options Options) int {
	err := run(args, stdout, stderr, options)
	if err == nil {
		return 0
	}
	// 표준 오류에 오류를 쓰지 못하면 알릴 곳이 없으므로 종료 상태 3 으로 알린다(docs/spec/cli.md).
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

// connectTo 는 --config-dir 이나 이 애플리케이션의 설정 폴더에서 엔드포인트를 찾아 연결한다.
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
	// 점이 있는 명령 단어는 선언된 command 다(docs/spec/cli.md).
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
	// 명령이 성공했으면 연결을 닫은 결과도 보고한다. 실패했으면 그 실패가 결과다.
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

// runFiles 는 실행 중인 애플리케이션 없이 파일을 쓰는 plugin, sidecar 명령을 실행한다.
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
