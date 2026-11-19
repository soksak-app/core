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
func runMessage(args []string, stdout io.Writer) error {
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
	if len(args) != 3 {
		return usage("message send requires a folder and a text")
	}
	folder, text := args[1], args[2]
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
	output, err := json.Marshal(map[string]string{"path": name})
	if err != nil {
		return err
	}
	_, err = fmt.Fprintln(stdout, string(output))
	return err
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
