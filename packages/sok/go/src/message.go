package sok

// `sok message send <folder> <text>` (docs/spec/cli.md#commands, docs/spec/messaging.md#message): writes one text as a message of
// the surface that SOKSAK_SURFACE names. The text is written under a temporary name that does not end in `.txt`, and the file is
// renamed to `<from>.<token>.txt`; the rename is the point at which the message becomes visible. The Rust sok
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
	parsed, err := parseAllowed(args[1:], map[string]bool{}, map[string]bool{"config-dir": true})
	if err != nil {
		return err
	}
	if len(parsed.positionals) != 2 {
		return usage("message send requires a folder and a text")
	}
	folder, text := parsed.positionals[0], parsed.positionals[1]
	surface := agentSurface()
	if surface == "" {
		return fmt.Errorf("message send requires %s, which names the sending surface", SurfaceVariable)
	}
	if strings.ContainsAny(surface, "/\\\x00") {
		return fmt.Errorf("%s is not a valid surface identifier: %s", SurfaceVariable, surface)
	}
	name, err := sendMessage(folder, surface, text)
	if err != nil {
		return err
	}
	receiver, err := messageReceiver(folder, parsed.values, options)
	if err != nil {
		return fmt.Errorf("message %s was written; %w", name, err)
	}
	output, err := json.Marshal(map[string]any{"path": name, "receiver": receiver})
	if err != nil {
		return err
	}
	_, err = fmt.Fprintln(stdout, string(output))
	return err
}

// messageReceiver reads the hold of the terminal whose folder is folder (docs/spec/messaging.md#delivery): {surface, plugin, held}
// from surface.window, exposure.snapshot and the status <plugin>.messages of the surface. It returns nil when folder is not
// <root>/.soksak/messages/<surface>, when no application runs, when the surface is in no window and when the status is null.
func messageReceiver(folder string, values map[string]string, options Options) (any, error) {
	clean := filepath.Clean(folder)
	parent := filepath.Dir(clean)
	if filepath.Base(parent) != "messages" || filepath.Base(filepath.Dir(parent)) != ".soksak" {
		return nil, nil
	}
	terminal := filepath.Base(clean)
	client, err := connectTo(values, options)
	if errors.Is(err, ErrNotRunning) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	receiver, err := readReceiver(client, terminal)
	return receiver, errors.Join(err, client.Close())
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

// sendMessage writes text as a message of surface into folder and returns the name of the message file. A text over the limit
// fails before any file is created.
func sendMessage(folder, surface, text string) (string, error) {
	if !filepath.IsAbs(folder) {
		return "", fmt.Errorf("folder is not an absolute path: %s", folder)
	}
	if len(text) > messageLimit {
		return "", fmt.Errorf("message text is %d bytes; the limit is %d bytes (64 KiB)", len(text), messageLimit)
	}
	token := messageToken()
	temporary := filepath.Join(folder, ".tmp-"+token)
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
