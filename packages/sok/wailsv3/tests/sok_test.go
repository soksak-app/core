package tests

// sok 의 계약(docs/spec/cli.md)을 가짜 엔드포인트로 검사한다. 엔드포인트는 Unix socket 을 열고 endpoint.json 을 쓰며,
// 받은 요청을 기록하고 정한 응답을 돌려준다.

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/min-median-max/soksak/packages/sok/wailsv3/src"
	_ "github.com/min-median-max/soksak/packages/sok/wailsv3/src/platform/darwin"
)

type fakeEndpoint struct {
	configDir string
	mu        sync.Mutex
	requests  []map[string]any
}

// answer 는 method 와 params 에 대한 응답이다. result 는 원래 JSON 이고, code 가 0 이 아니면 오류 응답이다. after 는
// 응답 뒤에 보낼 알림이고, closeAfter 가 참이면 응답(과 알림) 뒤에 연결을 닫는다.
type answer struct {
	result     string
	code       int
	message    string
	after      []string
	closeAfter bool
}

func writeFrame(conn net.Conn, body []byte) {
	header := make([]byte, 4)
	binary.BigEndian.PutUint32(header, uint32(len(body)))
	conn.Write(append(header, body...))
}

func startEndpoint(t *testing.T, respond func(method string, params map[string]any) answer) *fakeEndpoint {
	t.Helper()
	// Unix socket 경로는 104 바이트로 제한되므로 짧은 임시 폴더에 둔다.
	socketDir, err := os.MkdirTemp("/tmp", "sok")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(socketDir) })
	address := filepath.Join(socketDir, "e.sock")
	listener, err := net.Listen("unix", address)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { listener.Close() })
	fake := &fakeEndpoint{configDir: t.TempDir()}
	endpoint, _ := json.Marshal(map[string]any{"transport": "unix", "address": address, "pid": os.Getpid()})
	if err := os.WriteFile(filepath.Join(fake.configDir, "endpoint.json"), endpoint, 0o600); err != nil {
		t.Fatal(err)
	}
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go func() {
				defer conn.Close()
				for {
					header := make([]byte, 4)
					if _, err := io.ReadFull(conn, header); err != nil {
						return
					}
					body := make([]byte, binary.BigEndian.Uint32(header))
					if _, err := io.ReadFull(conn, body); err != nil {
						return
					}
					var request map[string]any
					json.Unmarshal(body, &request)
					fake.mu.Lock()
					fake.requests = append(fake.requests, request)
					fake.mu.Unlock()
					params, _ := request["params"].(map[string]any)
					reply := respond(request["method"].(string), params)
					id := request["id"]
					if reply.code != 0 {
						out, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": id, "error": map[string]any{"code": reply.code, "message": reply.message}})
						writeFrame(conn, out)
					} else {
						writeFrame(conn, []byte(fmt.Sprintf(`{"jsonrpc":"2.0","id":%v,"result":%s}`, id, reply.result)))
					}
					for _, notification := range reply.after {
						writeFrame(conn, []byte(notification))
					}
					if reply.closeAfter {
						return
					}
				}
			}()
		}
	}()
	return fake
}

func (f *fakeEndpoint) methods() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	methods := []string{}
	for _, request := range f.requests {
		methods = append(methods, request["method"].(string))
	}
	return methods
}

func (f *fakeEndpoint) last() map[string]any {
	f.mu.Lock()
	defer f.mu.Unlock()
	params, _ := f.requests[len(f.requests)-1]["params"].(map[string]any)
	return params
}

func run(args ...string) (int, string, string) {
	var stdout, stderr bytes.Buffer
	code := sok.Run(args, &stdout, &stderr, "com.soksak.test")
	return code, stdout.String(), stderr.String()
}

const oneWindow = `[{"window":"main","title":"t","project":null,"key":false,"ready":true}]`

// contract: cli.usage.unknown-command-exits-2
func TestUnknownCommandExitsWithUsage(t *testing.T) {
	code, stdout, stderr := run("nothing", "--config-dir", t.TempDir())
	if code != 2 || stdout != "" || !strings.HasPrefix(stderr, "sok: unknown command: nothing\nusage: sok <command>") {
		t.Fatalf("code %d stdout %q stderr %q", code, stdout, stderr)
	}
}

// contract: cli.endpoint.missing-file-reports-not-running
func TestMissingEndpointReportsTheApplicationIsNotRunning(t *testing.T) {
	dir := t.TempDir()
	code, _, stderr := run("windows", "--config-dir", dir)
	want := fmt.Sprintf("sok: %s does not exist; the application is not running\n", filepath.Join(dir, "endpoint.json"))
	if code != 1 || stderr != want {
		t.Fatalf("code %d stderr %q", code, stderr)
	}
}

// contract: cli.output.indents-result-keeping-key-order
func TestResultIsIndentedInTheEndpointKeyOrder(t *testing.T) {
	fake := startEndpoint(t, func(method string, _ map[string]any) answer {
		return answer{result: `{"zeta":1,"alpha":[],"mid":{"b":true,"a":null},"list":[1,"x"],"empty":{}}`}
	})
	code, stdout, stderr := run("windows", "--config-dir", fake.configDir)
	want := "{\n  \"zeta\": 1,\n  \"alpha\": [],\n  \"mid\": {\n    \"b\": true,\n    \"a\": null\n  },\n  \"list\": [\n    1,\n    \"x\"\n  ],\n  \"empty\": {}\n}\n"
	if code != 0 || stdout != want {
		t.Fatalf("code %d stderr %q stdout %q", code, stderr, stdout)
	}
}

// contract: cli.window.single-window-is-default, cli.requests.carry-command-parameters
func TestTheOnlyWindowIsUsedAndParametersAreSent(t *testing.T) {
	fake := startEndpoint(t, func(method string, _ map[string]any) answer {
		if method == "windows.list" {
			return answer{result: oneWindow}
		}
		return answer{result: "null"}
	})
	cases := []struct {
		args   []string
		method string
		params string
	}{
		{[]string{"status", "core.screen", "--surface", "tab-1"}, "status.get", `{"name":"core.screen","surface":"tab-1","window":"main"}`},
		{[]string{"exposures"}, "exposure.list", `{"window":"main"}`},
		{[]string{"capture"}, "diagnostics.capture.still", `{"window":"main"}`},
		{[]string{"dom", "rect", "core.card", "--index", "2"}, "dom.rect", `{"index":2,"name":"core.card","window":"main"}`},
		{[]string{"dom", "input", "fixture.input", "--value", "ls"}, "dom.act", `{"action":"input","name":"fixture.input","value":"ls","window":"main"}`},
		{[]string{"dom", "dispatch", "x.y", "--event", `{"type":"keydown","key":"a"}`}, "dom.act", `{"action":"dispatch","event":{"key":"a","type":"keydown"},"name":"x.y","window":"main"}`},
		{[]string{"input", "pointer", "--x", "1.5", "--y", "2", "--phase", "move", "--activate"}, "input.pointer", `{"activate":true,"phase":"move","window":"main","x":1.5,"y":2}`},
		{[]string{"input", "key", "--key", "a", "--phase", "down", "--modifiers", "shift,,command"}, "input.key", `{"key":"a","modifiers":["shift","command"],"phase":"down","window":"main"}`},
	}
	for _, c := range cases {
		code, stdout, stderr := run(append(c.args, "--config-dir", fake.configDir)...)
		if code != 0 || stdout != "null\n" {
			t.Fatalf("%v: code %d stdout %q stderr %q", c.args, code, stdout, stderr)
		}
		methods := fake.methods()
		got, _ := json.Marshal(fake.last())
		if methods[len(methods)-1] != c.method || string(got) != c.params {
			t.Fatalf("%v: sent %s %s, want %s %s", c.args, methods[len(methods)-1], got, c.method, c.params)
		}
	}
}

// contract: cli.window.several-windows-need-selection, cli.window.project-selects-by-canonical-folder
func TestSeveralWindowsNeedSelection(t *testing.T) {
	project := t.TempDir()
	alias := filepath.Join(t.TempDir(), "alias")
	if err := os.Symlink(project, alias); err != nil {
		t.Fatal(err)
	}
	windows, _ := json.Marshal([]map[string]any{{"window": "main", "project": nil}, {"window": "project-a", "project": project}})
	fake := startEndpoint(t, func(method string, _ map[string]any) answer {
		if method == "windows.list" {
			return answer{result: string(windows)}
		}
		return answer{result: `"ok"`}
	})
	code, _, stderr := run("status", "core.screen", "--config-dir", fake.configDir)
	if code != 2 || !strings.HasPrefix(stderr, "sok: the application has 2 windows (main, project-a); select one with --window or --project\n") {
		t.Fatalf("code %d stderr %q", code, stderr)
	}
	code, stdout, stderr := run("status", "core.screen", "--project", alias, "--config-dir", fake.configDir)
	if code != 0 || stdout != "\"ok\"\n" || fake.last()["window"] != "project-a" {
		t.Fatalf("code %d stdout %q stderr %q params %v", code, stdout, stderr, fake.last())
	}
	code, _, stderr = run("status", "core.screen", "--window", "main", "--project", project, "--config-dir", fake.configDir)
	if code != 2 || !strings.HasPrefix(stderr, "sok: --window and --project select the window in two ways; give one\n") {
		t.Fatalf("code %d stderr %q", code, stderr)
	}
}

// contract: cli.error.reports-endpoint-code
func TestEndpointErrorsCarryTheirCode(t *testing.T) {
	fake := startEndpoint(t, func(method string, _ map[string]any) answer {
		return answer{code: 1003, message: "page entries are not ready"}
	})
	code, stdout, stderr := run("status", "core.screen", "--window", "main", "--config-dir", fake.configDir)
	if code != 1 || stdout != "" || stderr != "sok: page entries are not ready (1003)\n" {
		t.Fatalf("code %d stdout %q stderr %q", code, stdout, stderr)
	}
}

// contract: cli.status.watch-prints-value-and-changes
func TestWatchPrintsTheValueAndEachChange(t *testing.T) {
	changed := func(name, value string) string {
		return fmt.Sprintf(`{"jsonrpc":"2.0","method":"status.changed","params":{"window":"main","name":%q,"value":%s}}`, name, value)
	}
	fake := startEndpoint(t, func(method string, _ map[string]any) answer {
		switch method {
		case "status.watch":
			return answer{result: "null"}
		case "status.get":
			return answer{result: `{"screen": "library"}`, after: []string{changed("other", "1"), changed("core.screen", `{"screen": "workspace"}`)}, closeAfter: true}
		}
		return answer{code: -32601, message: "unexpected " + method}
	})
	code, stdout, stderr := run("status", "core.screen", "--window", "main", "--watch", "--config-dir", fake.configDir)
	if stdout != "{\"screen\":\"library\"}\n{\"screen\":\"workspace\"}\n" || code != 1 || stderr != "sok: endpoint connection closed\n" {
		t.Fatalf("code %d stdout %q stderr %q", code, stdout, stderr)
	}
	if got := strings.Join(fake.methods(), ","); got != "status.watch,status.get" {
		t.Fatalf("methods %s", got)
	}
}

// contract: cli.config-dir.default-uses-application-identifier
func TestTheDefaultConfigurationDirectoryIsTheApplications(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", "")
	base, err := os.UserConfigDir()
	if err != nil {
		t.Fatal(err)
	}
	code, _, stderr := run("windows")
	want := fmt.Sprintf("sok: %s does not exist; the application is not running\n", filepath.Join(base, "com.soksak.test", "endpoint.json"))
	if code != 1 || stderr != want || !strings.HasPrefix(base, home) {
		t.Fatalf("code %d stderr %q want %q", code, stderr, want)
	}
}

// declared 는 선언된 command 하나를 보고하는 가짜 엔드포인트다. exposure.list 는 그 command 를, command.run 은 받은
// 매개변수를 돌려준다.
func declared(t *testing.T) *fakeEndpoint {
	exposures := `{"status":[],"commands":[{"name":"fixture.do","description":"d","params":{"type":"object","properties":{` +
		`"text":{"type":"string"},"count":{"type":"number"},"whole":{"type":"integer"},"flag":{"type":"boolean"},` +
		`"choice":{"enum":["one","two"]},"maybe":{"type":["string","null"]},"object":{"type":"object"},"list":{"type":"array"}}},` +
		`"result":{"type":"object"}},{"name":"fixture.none","description":"n","params":{"type":"object","properties":{}}}],"dom":[]}`
	return startEndpoint(t, func(method string, params map[string]any) answer {
		switch method {
		case "windows.list":
			return answer{result: oneWindow}
		case "exposure.list":
			return answer{result: exposures}
		case "command.run":
			out, _ := json.Marshal(params)
			return answer{result: string(out)}
		}
		return answer{code: -32601, message: "unexpected " + method}
	})
}

// contract: cli.command.flags-from-schema
func TestDeclaredCommandFlagsFollowTheSchema(t *testing.T) {
	fake := declared(t)
	code, stdout, stderr := run("fixture.do", "--text=--x", "--count=1.5", "--whole", "3", "--flag", "--choice", "two",
		"--maybe", "null", "--object", `{"a":1}`, "--list", "[1]", "--surface", "tab-1", "--config-dir", fake.configDir)
	if code != 0 {
		t.Fatalf("code %d stderr %q", code, stderr)
	}
	sent, _ := json.Marshal(fake.last())
	want := `{"name":"fixture.do","params":{"choice":"two","count":1.5,"flag":true,"list":[1],"maybe":null,"object":{"a":1},"text":"--x","whole":3},"surface":"tab-1","window":"main"}`
	if string(sent) != want || !strings.HasPrefix(stdout, "{\n  \"name\": \"fixture.do\"") {
		t.Fatalf("sent %s stdout %q", sent, stdout)
	}
	code, _, stderr = run("fixture.do", "--params", `{"text":"x"}`, "--config-dir", fake.configDir)
	sent, _ = json.Marshal(fake.last())
	if code != 0 || string(sent) != `{"name":"fixture.do","params":{"text":"x"},"window":"main"}` {
		t.Fatalf("code %d stderr %q sent %s", code, stderr, sent)
	}
}

// contract: cli.command.rejects-undeclared-or-invalid-values
func TestDeclaredCommandRejectsBadFlagsBeforeSending(t *testing.T) {
	fake := declared(t)
	cases := map[string][]string{
		"sok: --nope is not a parameter of fixture.do; its parameters are choice, count, flag, list, maybe, object, text, whole\n": {"fixture.do", "--nope", "1"},
		"sok: --choice must be one of one, two\n": {"fixture.do", "--choice", "three"},
		"sok: --whole must be integer\n":          {"fixture.do", "--whole", "1.5"},
		"sok: --count must be number\n":           {"fixture.do", "--count", "x"},
		"sok: --object must be object\n":          {"fixture.do", "--object", "[1]"},
		"sok: unexpected argument yes\n":          {"fixture.do", "--flag", "yes"},
		"sok: --text needs a value\n":             {"fixture.do", "--text"},
		"sok: --params gives the whole parameter object and cannot be combined with parameter flags\n": {"fixture.do", "--params", "{}", "--text", "x"},
		"sok: fixture.gone is not a declared command of window main; sok commands lists them\n":        {"fixture.gone"},
	}
	for want, args := range cases {
		code, stdout, stderr := run(append(args, "--config-dir", fake.configDir)...)
		if code != 2 || stdout != "" || !strings.HasPrefix(stderr, want) {
			t.Fatalf("%v: code %d stdout %q stderr %q", args, code, stdout, stderr)
		}
	}
	for _, method := range fake.methods() {
		if method == "command.run" {
			t.Fatalf("a rejected command was sent: %v", fake.methods())
		}
	}
}

// contract: cli.commands.lists-declared-commands
func TestCommandsListsTheDeclaredCommandsInOrder(t *testing.T) {
	fake := declared(t)
	code, stdout, stderr := run("commands", "--config-dir", fake.configDir)
	var commands []map[string]any
	if err := json.Unmarshal([]byte(stdout), &commands); err != nil || code != 0 {
		t.Fatalf("code %d stderr %q stdout %q", code, stderr, stdout)
	}
	if len(commands) != 2 || commands[0]["name"] != "fixture.do" || commands[1]["name"] != "fixture.none" {
		t.Fatalf("commands %v", commands)
	}
}
