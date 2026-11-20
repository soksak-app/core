package sok

// `sok message send [--reply] <folder> <text>` (docs/spec/cli.md#commands, docs/spec/messaging.md#message): writes one text as a
// message of the surface of the process of sok, which it asks the running application with agent.surface
// (docs/spec/sidecars.md#process-identity). A message carries the request for a report to the folder of the sender, and a
// report (--reply) carries the text alone under the token prefix `report-` (docs/spec/messaging.md#report-request). The text is
// written under a temporary name that does not end in `.txt`, and the file is renamed to `<from>.<token>.txt`; the rename is the
// point at which the message becomes visible. The Rust sok
// (packages/sok/rust/src/message.rs) implements the same command with the same rules.

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"time"
)

// messageLimit is the largest text of a message, in bytes; a larger text is refused before a file is created
// (docs/spec/messaging.md#message).
const messageLimit = 64 * 1024

// noDaemonHint ends a refusal of agent.surface when CODEX_THREAD_ID is in the environment: codex runs the commands of its agent in a
// shared server that detaches from the terminal, which is no process of a surface (docs/spec/cli.md#commands).
const noDaemonHint = "; start codex with --no-daemon, so that the commands of its agent run in processes of the surface"

// messageCounter makes each token of this process unique when two sends start in the same nanosecond.
var messageCounter atomic.Uint64

// runMessage runs the message commands; args are the arguments after the word message.
func runMessage(args []string, stdout io.Writer, options Options) error {
	if len(args) == 1 && args[0] == "--help" {
		_, err := fmt.Fprintln(stdout, Usage)
		return err
	}
	if len(args) == 0 {
		return usage("message requires an action")
	}
	if args[0] != "send" {
		return usage("unknown command: message %s", strings.Join(args, " "))
	}
	parsed, err := parseAllowed(args[1:], map[string]bool{"reply": true}, map[string]bool{"config-dir": true})
	if err != nil {
		return err
	}
	if len(parsed.positionals) != 2 {
		return usage("message send requires a folder and a text")
	}
	folder, text := parsed.positionals[0], parsed.positionals[1]
	client, err := connectTo(parsed.values, options)
	if errors.Is(err, ErrNotRunning) {
		return errors.New("message send requires a running application, which answers the surface of this process")
	}
	if err != nil {
		return err
	}
	name, receiver, err := writeMessage(client, folder, text, parsed.flags["reply"])
	if err = errors.Join(err, client.Close()); err != nil {
		return err
	}
	output, err := json.Marshal(map[string]any{"path": name, "receiver": receiver})
	if err != nil {
		return err
	}
	_, err = fmt.Fprintln(stdout, string(output))
	return err
}

// writeMessage asks the application for the surface of this process, writes the message of that surface into folder and reads the hold
// of its receiver. A refusal of agent.surface writes no file.
func writeMessage(client *Client, folder, text string, report bool) (string, any, error) {
	surface, refused, err := ownSurface(client.Request)
	if err != nil {
		return "", nil, err
	}
	if refused != nil {
		hint := ""
		if os.Getenv("CODEX_THREAD_ID") != "" {
			hint = noDaemonHint
		}
		return "", nil, fmt.Errorf("message send: %s%s", refused.Message, hint)
	}
	if strings.ContainsAny(surface, "/\\\x00") {
		return "", nil, fmt.Errorf("agent.surface answered %s, which is not a valid surface identifier", surface)
	}
	if !report {
		request, err := reportRequest(folder, surface)
		if err != nil {
			return "", nil, err
		}
		text += request
	}
	name, err := sendMessage(folder, surface, text, report)
	if err != nil {
		return "", nil, err
	}
	receiver, err := messageReceiver(client, folder)
	if err != nil {
		return "", nil, fmt.Errorf("message %s was written; %w", name, err)
	}
	return name, receiver, nil
}

// messageReceiver reads the hold of the terminal whose folder is folder (docs/spec/messaging.md#delivery): {surface, plugin, held}
// from surface.window, exposure.snapshot and the status <plugin>.messages of the surface. It returns nil when folder is not
// <root>/.soksak/messages/<surface>, when the surface is in no window and when the status is null.
func messageReceiver(client *Client, folder string) (any, error) {
	clean := filepath.Clean(folder)
	parent := filepath.Dir(clean)
	if filepath.Base(parent) != "messages" || filepath.Base(filepath.Dir(parent)) != ".soksak" {
		return nil, nil
	}
	return readReceiver(client, filepath.Base(clean))
}

// readReceiver asks the application for the window, the plugin and the status <plugin>.messages of the surface terminal.
func readReceiver(client *Client, terminal string) (any, error) {
	result, err := client.Request("surface.window", map[string]any{"surface": terminal})
	var endpointErr *EndpointError
	if errors.As(err, &endpointErr) && endpointErr.Code == 1012 {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var home surfaceHome
	if json.Unmarshal(result, &home) != nil || home.Window == "" {
		return nil, fmt.Errorf("surface.window returned an unexpected value: %s", result)
	}
	result, err = client.Request("exposure.snapshot", map[string]any{"window": home.Window, "surface": terminal})
	if err != nil {
		return nil, err
	}
	var snapshot struct {
		Groups []struct {
			Owner   string `json:"owner"`
			Surface string `json:"surface"`
			Plugin  string `json:"plugin"`
		} `json:"groups"`
	}
	if json.Unmarshal(result, &snapshot) != nil {
		return nil, fmt.Errorf("exposure.snapshot returned an unexpected value: %s", result)
	}
	for _, group := range snapshot.Groups {
		if group.Owner != "surface" || group.Surface != terminal {
			continue
		}
		name := group.Plugin + ".messages"
		value, err := client.Request("status.get", map[string]any{"name": name, "surface": terminal, "window": home.Window})
		if err != nil {
			return nil, err
		}
		if string(value) == "null" {
			return nil, nil
		}
		var status map[string]json.RawMessage
		held, present := json.RawMessage(nil), false
		if json.Unmarshal(value, &status) == nil {
			held, present = status["held"]
		}
		if !present {
			return nil, fmt.Errorf("the status %s of surface %s is not {folder, registration, held, last}: %s", name, terminal, value)
		}
		return map[string]any{"surface": terminal, "plugin": group.Plugin, "held": held}, nil
	}
	return nil, fmt.Errorf("exposure.snapshot of window %s holds no group of surface %s", home.Window, terminal)
}

// reportRequest returns the request for a report that a message carries after its text: the folder of the sender is
// <root>/.soksak/messages/<surface>, beside the folder of the receiver, <root>/.soksak/messages/<receiver>
// (docs/spec/messaging.md#report-request). A folder of another form names no root, and the send is refused.
func reportRequest(folder, surface string) (string, error) {
	messages := filepath.Dir(filepath.Clean(folder))
	if filepath.Base(messages) != "messages" || filepath.Base(filepath.Dir(messages)) != ".soksak" {
		return "", fmt.Errorf("message send: %s is not the folder of a terminal, <root>/.soksak/messages/<surface>, so it names no folder of the sender for the report; a report is sent with --reply", folder)
	}
	return ` (끝나면 결과를 sok message send --reply ` + filepath.Join(messages, surface) + ` "<보고>"로 보고하라)`, nil
}

// sendMessage writes text as a message of surface into folder and returns the name of the message file; the token of a report starts
// with `report-`. A text over the limit fails before any file is created.
func sendMessage(folder, surface, text string, report bool) (string, error) {
	if !filepath.IsAbs(folder) {
		return "", fmt.Errorf("folder is not an absolute path: %s", folder)
	}
	if len(text) > messageLimit {
		return "", fmt.Errorf("message text is %d bytes; the limit is %d bytes (64 KiB)", len(text), messageLimit)
	}
	token := messageToken()
	temporary := filepath.Join(folder, ".tmp-"+token)
	if report {
		token = "report-" + token
	}
	name := surface + "." + token + ".txt"
	file, err := os.OpenFile(temporary, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		return "", fileError(temporary, err)
	}
	// The file was created by this call and holds no message until the rename, so a failure removes it.
	fail := func(err error) (string, error) {
		if removal := os.Remove(temporary); removal != nil {
			return "", fmt.Errorf("%w; the temporary file was not removed: %v", err, removal)
		}
		return "", err
	}
	if _, err := file.WriteString(text); err != nil {
		return fail(errors.Join(fileError(temporary, err), file.Close()))
	}
	if err := file.Close(); err != nil {
		return fail(fileError(temporary, err))
	}
	if err := os.Rename(temporary, filepath.Join(folder, name)); err != nil {
		return fail(fileError(filepath.Join(folder, name), err))
	}
	return name, nil
}

// messageToken returns a token that holds no dot and is unique for this process and time.
func messageToken() string {
	return fmt.Sprintf("%x-%x-%x", os.Getpid(), time.Now().UnixNano(), messageCounter.Add(1))
}
