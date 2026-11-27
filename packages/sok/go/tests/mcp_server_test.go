package tests

// Checks the MCP server `sok mcp` (docs/spec/cli.md#mcp-server) over real pipes. Each test starts the built sok as `sok mcp` with a
// disposable home, no CLAUDE_CONFIG_DIR and the environment of its case, plays the endpoint frames of an mcp-* case of
// docs/spec/cases/endpoint with the case player, and runs the mcp steps of the case: the MCP messages, the tool calls with the
// results and errors that the case states, and the waits on the endpoint and on the standard error of the server. The Rust test (packages/sok/rust/tests/mcp_server_test.rs)
// runs the same cases.

import (
	"bufio"
	"bytes"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"sync"
	"testing"

	"github.com/soksak-app/core/packages/sok/go/src"
)

// mcpCase is the mcp member of a case.
type mcpCase struct {
	Arguments   []string          `json:"arguments"`
	Environment map[string]string `json:"environment"`
	Endpoint    string            `json:"endpoint"`
	Steps       []json.RawMessage `json:"steps"`
}

// mcpStep is one step of the mcp member.
type mcpStep struct {
	Tool      *string         `json:"tool"`
	Arguments json.RawMessage `json:"arguments"`
	Result    json.RawMessage `json:"result"`
	Error     *string         `json:"error"`
	As        string          `json:"as"`
	Await     string          `json:"await"`
	Cancel    string          `json:"cancel"`
	Received  string          `json:"received"`
	Contains  string          `json:"contains"`
	Line      string          `json:"line"`
	Hex       string          `json:"hex"`
	Stderr    string          `json:"stderr"`
	Start     bool            `json:"start"`
	Client    json.RawMessage `json:"client"`
	Server    json.RawMessage `json:"server"`
}

// mcpSession is one running `sok mcp` with its standard streams.
type mcpSession struct {
	t      *testing.T
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	nextID int

	mu        sync.Mutex
	changed   *sync.Cond
	responses map[string]map[string]any
	stderr    []string
	// ended tells that the standard output and the standard error of the server ended.
	ended bool
	// end closes the standard input and waits until the server ended; the cleanup of the test calls it too.
	end func()
	// failure is the line of standard error with which the server must end with status 1, "" for a server that ends with
	// status 0.
	failure string
}

// startMCP starts the built sok as `sok mcp` with args and the variables of variables in the disposable home that newAgentHome
// sets. The child gets only the variables of environment() and of variables, so it reaches no agent folder, configuration directory
// or surface of the person who runs the test.
func startMCP(t *testing.T, args []string, variables map[string]string) *mcpSession {
	t.Helper()
	cmd := exec.Command(builtSok(t), append([]string{"mcp"}, args...)...)
	var extra []string
	for name, value := range variables {
		extra = append(extra, name+"="+value)
	}
	cmd.Env = environment(extra...)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	s := &mcpSession{t: t, cmd: cmd, stdin: stdin, nextID: 1, responses: map[string]map[string]any{}}
	s.changed = sync.NewCond(&s.mu)
	var readers sync.WaitGroup
	readers.Add(2)
	go func() {
		defer readers.Done()
		lines := bufio.NewScanner(stdout)
		lines.Buffer(make([]byte, 1<<20), 64<<20)
		for lines.Scan() {
			var message map[string]any
			if err := json.Unmarshal(lines.Bytes(), &message); err != nil {
				t.Errorf("sok mcp wrote a line that is no JSON message: %q", lines.Text())
				continue
			}
			s.mu.Lock()
			s.responses[fmt.Sprint(message["id"])] = message
			s.changed.Broadcast()
			s.mu.Unlock()
		}
	}()
	go func() {
		defer readers.Done()
		lines := bufio.NewScanner(stderr)
		for lines.Scan() {
			s.mu.Lock()
			s.stderr = append(s.stderr, lines.Text())
			s.changed.Broadcast()
			s.mu.Unlock()
		}
	}()
	// The waits of the test end with the output of the server, so a server that ends early fails the test instead of holding it.
	go func() {
		readers.Wait()
		s.mu.Lock()
		s.ended = true
		s.changed.Broadcast()
		s.mu.Unlock()
	}()
	s.end = sync.OnceFunc(func() {
		stdin.Close()
		readers.Wait()
		err := cmd.Wait()
		if s.failure != "" {
			var exit *exec.ExitError
			if !errors.As(err, &exit) || exit.ExitCode() != 1 || !slices.Contains(s.stderr, s.failure) {
				t.Errorf("sok mcp ended with %v and the standard error %q, want status 1 and the line %q", err, s.stderr, s.failure)
			}
			return
		}
		if err != nil {
			t.Errorf("sok mcp ended with %v after its standard input closed; standard error: %q", err, s.stderr)
		}
	})
	t.Cleanup(s.end)
	return s
}

// send writes one message.
func (s *mcpSession) send(message any) {
	s.t.Helper()
	line, err := json.Marshal(message)
	if err != nil {
		s.t.Fatal(err)
	}
	s.writeLine(line)
}

// writeLine writes one message line as it is. A numeric id of a line that decodes moves the next id of the session past it.
func (s *mcpSession) writeLine(line []byte) {
	s.t.Helper()
	var message struct {
		ID any `json:"id"`
	}
	if json.Unmarshal(line, &message) == nil {
		if id, ok := message.ID.(float64); ok && int(id) >= s.nextID {
			s.nextID = int(id) + 1
		}
	}
	if _, err := s.stdin.Write(append(line, '\n')); err != nil {
		s.t.Fatalf("writing to sok mcp: %v", err)
	}
}

// forget removes the answer with the id key, so a later answer with the same id, such as the null id of a parse error, is
// waited for anew.
func (s *mcpSession) forget(key string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.responses, key)
}

// request sends a request with the next id and returns the id.
func (s *mcpSession) request(method string, params any) string {
	id := s.nextID
	s.nextID++
	message := map[string]any{"jsonrpc": "2.0", "id": id, "method": method}
	if params != nil {
		message["params"] = params
	}
	s.send(message)
	return fmt.Sprint(id)
}

// response waits for the response of id. The wait ends with the response or the end of the output of the server.
func (s *mcpSession) response(id string) map[string]any {
	s.t.Helper()
	s.mu.Lock()
	defer s.mu.Unlock()
	for s.responses[id] == nil {
		if s.ended {
			s.t.Fatalf("sok mcp ended without a response to %s; standard error: %q", id, s.stderr)
		}
		s.changed.Wait()
	}
	return s.responses[id]
}

// initialize opens a session of the revision 2025-11-25.
func (s *mcpSession) initialize() {
	s.t.Helper()
	reply := s.response(s.request("initialize", map[string]any{"protocolVersion": "2025-11-25", "capabilities": map[string]any{}, "clientInfo": map[string]any{"name": "test", "version": "0"}}))
	if reply["result"] == nil {
		s.t.Fatalf("initialize answered %v", reply)
	}
	s.send(map[string]any{"jsonrpc": "2.0", "method": "notifications/initialized"})
}

// toolOutcome is the text of a tool result and whether it is a tool error.
func (s *mcpSession) toolOutcome(id string) (string, bool) {
	s.t.Helper()
	reply := s.response(id)
	result, ok := reply["result"].(map[string]any)
	if !ok {
		s.t.Fatalf("tools/call %s answered %v", id, reply)
	}
	content, _ := result["content"].([]any)
	if len(content) != 1 {
		s.t.Fatalf("tools/call %s answered the content %v, want one text", id, result["content"])
	}
	text, _ := content[0].(map[string]any)["text"].(string)
	isError, _ := result["isError"].(bool)
	return text, isError
}

// stderrLine waits until the server wrote line to its standard error.
func (s *mcpSession) stderrLine(line string) {
	s.t.Helper()
	s.mu.Lock()
	defer s.mu.Unlock()
	for {
		for _, written := range s.stderr {
			if written == line {
				return
			}
		}
		if s.ended {
			s.t.Fatalf("sok mcp ended without writing %q; standard error: %q", line, s.stderr)
		}
		s.changed.Wait()
	}
}

// mcpValues are the texts that stand for a value of the run in the mcp steps of a case.
func mcpValues(t *testing.T, configDir string) map[string]any {
	t.Helper()
	var definition struct {
		Instructions string `json:"instructions"`
		Tools        any    `json:"tools"`
	}
	if err := json.Unmarshal(agentSource(t, "mcp.json"), &definition); err != nil {
		t.Fatal(err)
	}
	return map[string]any{"$config": configDir, "$version": sok.CoreVersion, "$instructions": definition.Instructions, "$tools": definition.Tools}
}

// agentSource reads a file of the agent sources, packages/sok/go/src/agents.
func agentSource(t *testing.T, name string) []byte {
	t.Helper()
	data, err := os.ReadFile(repositoryFile(t, "packages/sok/go/src/agents/"+name))
	if err != nil {
		t.Fatal(err)
	}
	return data
}

// stated tells whether actual holds every member that want states with the same value; arrays have the same length.
func stated(want, actual any) bool {
	switch w := want.(type) {
	case map[string]any:
		a, ok := actual.(map[string]any)
		if !ok {
			return false
		}
		for key, member := range w {
			if value, present := a[key]; !present || !stated(member, value) {
				return false
			}
		}
		return true
	case []any:
		a, ok := actual.([]any)
		if !ok || len(a) != len(w) {
			return false
		}
		for n := range w {
			if !stated(w[n], a[n]) {
				return false
			}
		}
		return true
	}
	return reflect.DeepEqual(want, actual)
}

// decoded is a JSON text as the values that encoding/json gives it.
func decoded(t *testing.T, raw []byte) any {
	t.Helper()
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		t.Fatalf("%s is no JSON: %v", raw, err)
	}
	return value
}

// mcpRun is the run of one case: the player, the server and the calls that run without a wait.
type mcpRun struct {
	t       *testing.T
	name    string
	player  *casePlayer
	session *mcpSession
	values  map[string]any
	started map[string]string
	// results are the texts of the tool results of the run, in order, for the checks that a case does not state.
	results []string
}

// runMCPCase plays the case of name against `sok mcp` and runs its mcp steps.
func runMCPCase(t *testing.T, name string, options ...caseOption) *mcpRun {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(caseDirectory(t), name+".json"))
	if err != nil {
		t.Fatal(err)
	}
	var kase struct {
		MCP *mcpCase `json:"mcp"`
	}
	if err := json.Unmarshal(data, &kase); err != nil || kase.MCP == nil {
		t.Fatalf("%s has no mcp member: %v", name, err)
	}
	settings := caseSettings{texts: map[string]string{}}
	for _, option := range options {
		option(&settings)
	}
	newAgentHome(t)
	configDir := t.TempDir()
	run := &mcpRun{t: t, name: name, started: map[string]string{}}
	startPlayer := func() {
		p, err := startCasePlayer(configDir, caseDirectory(t), name, settings)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() {
			if err := p.close(); err != nil {
				t.Error(err)
			}
		})
		run.player = p
	}
	if kase.MCP.Endpoint != "later" {
		startPlayer()
	}
	args := append([]string{"--config-dir", configDir}, kase.MCP.Arguments...)
	run.session = startMCP(t, args, kase.MCP.Environment)
	run.values = mcpValues(t, configDir)
	steps := make([]mcpStep, len(kase.MCP.Steps))
	for n, raw := range kase.MCP.Steps {
		if err := json.Unmarshal(raw, &steps[n]); err != nil {
			t.Fatalf("%s: mcp step %d: %v", name, n, err)
		}
	}
	if len(steps) > 0 && steps[0].Client == nil {
		run.session.initialize()
	}
	for n, step := range steps {
		where := fmt.Sprintf("%s: mcp step %d", name, n)
		switch {
		case step.Client != nil:
			message := run.bound(step.Client).(map[string]any)
			run.session.send(message)
			if step.Server == nil {
				continue
			}
			want := run.bound(step.Server)
			got := run.session.response(fmt.Sprint(message["id"]))
			if !stated(want, any(got)) {
				t.Errorf("%s: the server answered %v, the case states %v", where, got, want)
			}
		case step.Line != "" || step.Hex != "":
			line := []byte(step.Line)
			if step.Hex != "" {
				var err error
				if line, err = hex.DecodeString(step.Hex); err != nil {
					t.Fatalf("%s: hex: %v", where, err)
				}
			}
			if step.Server == nil {
				run.session.writeLine(line)
				continue
			}
			// The answer is keyed by the id that the case states, because the server answers a line that it cannot read with
			// the id null.
			want := run.bound(step.Server)
			key := fmt.Sprint(want.(map[string]any)["id"])
			run.session.forget(key)
			run.session.writeLine(line)
			got := run.session.response(key)
			if !stated(want, any(got)) {
				t.Errorf("%s: the server answered %v, the case states %v", where, got, want)
			}
		case step.Tool != nil:
			arguments := map[string]any{}
			if step.Arguments != nil {
				arguments = run.bound(step.Arguments).(map[string]any)
			}
			id := run.session.request("tools/call", map[string]any{"name": *step.Tool, "arguments": arguments})
			if step.As != "" {
				run.started[step.As] = id
				continue
			}
			run.check(where, id, step)
		case step.Await != "":
			run.check(where, run.started[step.Await], step)
		case step.Cancel != "":
			id := run.started[step.Cancel]
			run.session.send(map[string]any{"jsonrpc": "2.0", "method": "notifications/cancelled", "params": map[string]any{"requestId": json.Number(id), "reason": "the case cancels the call"}})
			t.Cleanup(func() {
				run.session.mu.Lock()
				defer run.session.mu.Unlock()
				if reply, ok := run.session.responses[id]; ok {
					t.Errorf("%s: the cancelled call %s was answered with %v", where, id, reply)
				}
			})
		case step.Received != "":
			count := 0
			for _, earlier := range steps[:n+1] {
				if earlier.Received == step.Received {
					count++
				}
			}
			run.player.waitForMethod(step.Received, count)
			if text := run.player.lastText(step.Received); !strings.Contains(text, step.Contains) {
				t.Errorf("%s: the last request of %s is %s, which does not hold %s", where, step.Received, text, step.Contains)
			}
		case step.Stderr != "":
			run.session.stderrLine(step.Stderr)
		case step.Start:
			startPlayer()
		default:
			t.Fatalf("%s has no kind", where)
		}
	}
	return run
}

// bound is a raw value of a step with the values of the run and the variables of the case: a string $<name> is the value of the
// run of that name, else the text that the test gave the variable or its example, and $config inside a string is the
// configuration directory.
func (r *mcpRun) bound(raw json.RawMessage) any {
	r.t.Helper()
	return r.resolve(decoded(r.t, raw))
}

func (r *mcpRun) resolve(value any) any {
	switch v := value.(type) {
	case string:
		if replaced, ok := r.values[v]; ok {
			return replaced
		}
		if match := caseVariablePattern.FindStringSubmatch(v); match != nil && r.player != nil {
			if _, declared := r.player.variables[match[1]]; declared {
				var buffer bytes.Buffer
				if err := writeValue(&buffer, r.player.bind(v)); err != nil {
					r.t.Fatal(err)
				}
				return decoded(r.t, buffer.Bytes())
			}
		}
		return strings.ReplaceAll(v, "$config", r.values["$config"].(string))
	case []any:
		out := make([]any, len(v))
		for n, item := range v {
			out[n] = r.resolve(item)
		}
		return out
	case map[string]any:
		out := make(map[string]any, len(v))
		for key, item := range v {
			out[key] = r.resolve(item)
		}
		return out
	}
	return value
}

// check compares the outcome of a tool call with the result or the error that the step states.
func (r *mcpRun) check(where, id string, step mcpStep) {
	r.t.Helper()
	text, isError := r.session.toolOutcome(id)
	r.results = append(r.results, text)
	switch {
	case step.Error != nil:
		want := r.resolve(*step.Error).(string)
		if !isError || text != want {
			r.t.Errorf("%s: the call answered %q (error %v), the case states the error %q", where, text, isError, want)
		}
	case step.Result != nil:
		want := r.bound(step.Result)
		if isError || !reflect.DeepEqual(decoded(r.t, []byte(text)), want) {
			r.t.Errorf("%s: the call answered %s (error %v), the case states %v", where, text, isError, want)
		}
	default:
		if isError {
			r.t.Errorf("%s: the call answered the error %q", where, text)
		}
	}
}

// contract: cli.mcp.replays-the-endpoint-cases
func TestTheMCPServerReplaysTheEndpointCases(t *testing.T) {
	for _, name := range []string{
		"mcp-exposure-search", "mcp-exposure-without-element", "mcp-exposure-without-params", "mcp-input-pointer-inactive",
		"mcp-tools-call", "mcp-watch-connection-closed", "mcp-watch-current-value", "mcp-watch-next-change", "mcp-agent-context",
		"mcp-window-describe", "mcp-tools-call-rejected", "mcp-messages", "mcp-status-window-fallback",
	} {
		t.Run(name, func(t *testing.T) { runMCPCase(t, name) })
	}
}

// contract: cli.mcp.lists-the-fixed-tools
func TestTheMCPServerListsTheFixedTools(t *testing.T) {
	// The only endpoint request of the case is agent.surface of its call of agent_context; tools/list sends none.
	run := runMCPCase(t, "mcp-protocol-2025-11-25")
	if methods := run.player.methods(); fmt.Sprint(methods) != "[agent.surface]" {
		t.Fatalf("the case sent the endpoint requests %v", methods)
	}
	reply := run.session.response(run.session.request("tools/list", nil))
	if methods := run.player.methods(); fmt.Sprint(methods) != "[agent.surface]" {
		t.Fatalf("tools/list sent endpoint requests: %v", methods)
	}
	tools := reply["result"].(map[string]any)["tools"]
	if !reflect.DeepEqual(tools, run.values["$tools"]) {
		t.Fatalf("tools/list answered %v, want the tools of mcp.json", tools)
	}
	if _, declared := reply["result"].(map[string]any)["nextCursor"]; declared {
		t.Fatalf("tools/list answered a second page: %v", reply)
	}
}

// contract: cli.mcp.answers-the-protocol-revisions
func TestTheMCPServerAnswersTheProtocolRevisions(t *testing.T) {
	for _, name := range []string{"mcp-protocol-2026-07-28", "mcp-protocol-2025-11-25", "mcp-protocol-unsupported"} {
		t.Run(name, func(t *testing.T) { runMCPCase(t, name) })
	}
}

// contract: cli.mcp.discovery-reads-the-exposure-at-each-call, cli.mcp.search-lists-the-whole-exposure
func TestEachSearchReadsTheExposureOfThatCall(t *testing.T) {
	runMCPCase(t, "mcp-exposure-pages")
}

// contract: cli.mcp.serves-without-an-application
func TestTheMCPServerServesWithoutAnApplication(t *testing.T) {
	runMCPCase(t, "mcp-reconnect")
}

// contract: cli.mcp.watch-calls-share-and-cancel
func TestWatchCallsShareOneWatchAndACancelledCallEnds(t *testing.T) {
	runMCPCase(t, "mcp-watch-shared")
}

// contract: cli.describe.oversized-row-is-a-page, cli.describe.pages-follow-a-changing-window
func TestAnOversizedRowIsAPageAndPagesFollowAChangingWindow(t *testing.T) {
	big := strings.Repeat("x", 50000)
	run := runMCPCase(t, "mcp-window-describe-pages", withText("big", big))
	var first struct {
		Rows  []map[string]any `json:"rows"`
		Total int              `json:"total"`
		Next  any              `json:"next"`
	}
	if err := json.Unmarshal([]byte(run.results[0]), &first); err != nil {
		t.Fatal(err)
	}
	if len(run.results[0]) > 40000 || len(first.Rows) != 1 || first.Total != 4 || first.Next != "core status core.big" {
		t.Fatalf("the first page has %d bytes, %d rows, total %d and next %v; want at most 40000 bytes and the one row core.big", len(run.results[0]), len(first.Rows), first.Total, first.Next)
	}
	row := first.Rows[0]
	value, _ := row["value"].(string)
	if row["key"] != "core status core.big" || row["cut"] != true || value == "" || !strings.HasPrefix(`"`+big+`"`, value) {
		t.Fatalf("the oversized row is %v, want core.big with a cut prefix of its value", row["key"])
	}
	var compact struct {
		Rows []map[string]any `json:"rows"`
		Next any              `json:"next"`
	}
	if err := json.Unmarshal([]byte(run.results[2]), &compact); err != nil {
		t.Fatal(err)
	}
	if len(compact.Rows) != 4 || compact.Next != nil {
		t.Fatalf("the compact page has %d rows and next %v, want 4 rows and no next", len(compact.Rows), compact.Next)
	}
	if text := compact.Rows[0]["value"].(string); len([]rune(text)) != 200 || compact.Rows[0]["cut"] != true {
		t.Fatalf("the compact value has %d characters and cut %v, want 200 and true", len([]rune(text)), compact.Rows[0]["cut"])
	}
	many := compact.Rows[3]
	if items := many["items"].([]any); len(items) != 20 || many["cut"] != true || many["itemsTotal"] != float64(25) {
		t.Fatalf("the compact element has %d items, cut %v and itemsTotal %v, want 20, true and 25", len(items), many["cut"], many["itemsTotal"])
	}
}

// contract: cli.mcp.ends-at-a-line-over-the-limit
func TestALineOverTheLimitEndsTheMCPServer(t *testing.T) {
	newAgentHome(t)
	session := startMCP(t, []string{"--config-dir", t.TempDir()}, nil)
	session.initialize()
	// A line of 16777216 bytes before its line feed is over the limit, which the server reads in full before it ends.
	if _, err := session.stdin.Write(bytes.Repeat([]byte("x"), 16*1024*1024)); err != nil {
		t.Fatalf("writing to sok mcp: %v", err)
	}
	session.failure = "sok: mcp message exceeds 16777216 bytes"
	session.end()
}

// contract: cli.mcp.brings-the-skill-current-at-start
func TestTheMCPServerBringsTheSkillCurrentAtStart(t *testing.T) {
	// A differing file and a missing file of existing agent folders hold the skill before the answer to initialize.
	h := newAgentHome(t)
	differing := filepath.Join(h.home, ".claude", "skills", "soksak", "SKILL.md")
	missing := filepath.Join(h.home, ".agents", "skills", "soksak", "SKILL.md")
	writeText(t, differing, "an earlier skill\n")
	mkdirs(t, filepath.Join(h.home, ".agents"))
	session := startMCP(t, []string{"--config-dir", t.TempDir()}, nil)
	session.initialize()
	if fileText(t, differing) != skillSource(t) || fileText(t, missing) != skillSource(t) {
		t.Fatalf("after initialize the skill files hold %q and %q", fileText(t, differing), fileText(t, missing))
	}
	session.end()
	if len(session.stderr) != 0 {
		t.Fatalf("standard error %q", session.stderr)
	}
	// Without an agent folder the server writes nothing and serves.
	h = newAgentHome(t)
	session = startMCP(t, []string{"--config-dir", t.TempDir()}, nil)
	session.initialize()
	session.end()
	if names := folderNames(t, h.home); len(names) != 0 || len(session.stderr) != 0 {
		t.Fatalf("the home holds %v; standard error %q", names, session.stderr)
	}
	// Each skill folder that cannot be written is reported on standard error and as sok.skill in the order of the agent folders,
	// and the server still serves.
	h = newAgentHome(t)
	var files []any
	for _, folder := range []string{".claude", ".agents"} {
		locked := filepath.Join(h.home, folder, "skills", "soksak")
		mkdirs(t, locked)
		if err := os.Chmod(locked, 0o555); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { os.Chmod(locked, 0o755) })
		files = append(files, filepath.Join(locked, "SKILL.md"))
	}
	config := t.TempDir()
	session = startMCP(t, []string{"--config-dir", config}, nil)
	session.initialize()
	session.end()
	for _, file := range files {
		session.stderrLine("sok: skill: " + file.(string) + ": permission denied")
	}
	events := storedEvents(t, config, "sok.skill")
	if len(events) != 2 || events[0]["file"] != files[0] || events[1]["file"] != files[1] || events[0]["reason"] != "permission denied" || events[1]["reason"] != "permission denied" {
		t.Fatalf("sok.skill events %v", events)
	}
}
