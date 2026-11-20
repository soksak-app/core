package sok

// The session restart hook (docs/spec/agent-roles.md#session-restart-hook): the command `sok role identity` that the hook runs,
// and the setup part `hook`, which writes the hook entries of the user agent folders and removes them.
//
// A hook file is read with the path reads of github.com/tidwall/gjson and edited with the path writes of
// github.com/tidwall/sjson, so every member and entry that soksak does not own keeps its bytes and its order. The result is then
// written in the two-space form of encoding/json.Indent, which keeps the order of every member.

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"github.com/tidwall/gjson"
	"github.com/tidwall/sjson"
)

// hookGuard starts the command of the hook. The command runs sok only where the host sets SOKSAK_CONFIG_DIR, which every process of
// a surface carries (docs/spec/sidecars.md#processes-of-a-surface); elsewhere it exits 0 before sok starts.
const hookGuard = `[ -n "$SOKSAK_CONFIG_DIR" ] || exit 0; exec `

// hookMark ends the command of every hook entry that soksak registered. An install removes every entry whose command ends with it,
// under every event, so a stale entry never survives.
const hookMark = " role identity --soksak-hook"

// hookEvent is the event whose hook starts the identity of a session.
const hookEvent = "SessionStart"

// identityText is the stable identity of a tab (docs/spec/agent-roles.md#stable-identity) with the path of its role file.
const identityText = "[soksak role] Your role is defined in the file %s. Read the whole file before your first answer. Read the file again when a message starts with [soksak role] and says that the role changed. Do not save your role in any persistent memory. The role file is the only record of your role."

// hookCommand is the command of the hook for <sok>: the guard, then sok with the mark.
func hookCommand(sok string) string {
	return hookGuard + StepOf(sok) + hookMark
}

// pathKey escapes a key for a path of sjson, which reads the characters . * ? | # @ and the backslash as syntax.
func pathKey(key string) string {
	return strings.NewReplacer(`\`, `\\`, `.`, `\.`, `*`, `\*`, `?`, `\?`, `|`, `\|`, `#`, `\#`, `@`, `\@`).Replace(key)
}

// hookFiles are the hook files of the user agent folders that exist (docs/spec/agent-roles.md#session-restart-hook): settings.json of
// each Claude folder, <home>/.claude and CLAUDE_CONFIG_DIR, and hooks.json of the Codex folder, CODEX_HOME or <home>/.codex.
func (s Setup) hookFiles() ([]string, error) {
	home, err := s.Environment.home()
	if err != nil {
		return nil, err
	}
	var files []string
	claude := []string{filepath.Join(home, ".claude")}
	if dir := s.Environment.claudeConfigDir(); dir != "" && dir != claude[0] {
		claude = append(claude, dir)
	}
	for _, dir := range claude {
		if isDirectory(dir) {
			files = append(files, filepath.Join(dir, "settings.json"))
		}
	}
	codex := filepath.Join(home, ".codex")
	if dir := s.Environment.Variables["CODEX_HOME"]; dir != "" {
		codex = dir
	}
	if isDirectory(codex) {
		files = append(files, filepath.Join(codex, "hooks.json"))
	}
	return files, nil
}

// isDirectory reports whether path is a directory.
func isDirectory(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.IsDir()
}

// hookDocument checks that data is a JSON object whose hooks member, when present, is an object whose events are arrays.
func hookDocument(file string, data []byte) error {
	if !gjson.ValidBytes(data) {
		return fmt.Errorf("%s: hook file does not parse as JSON", file)
	}
	root := gjson.ParseBytes(data)
	if !root.IsObject() {
		return fmt.Errorf("%s: hook file must hold a JSON object", file)
	}
	hooks := root.Get("hooks")
	if !hooks.Exists() {
		return nil
	}
	if !hooks.IsObject() {
		return fmt.Errorf("%s: hooks must be an object", file)
	}
	var err error
	hooks.ForEach(func(event, value gjson.Result) bool {
		if !value.IsArray() {
			err = fmt.Errorf("%s: hooks.%s must be an array", file, event.String())
			return false
		}
		return true
	})
	return err
}

// isSoksakHook reports whether a hook entry carries the mark of soksak.
func isSoksakHook(hook gjson.Result) bool {
	return hook.IsObject() && hook.Get("type").String() == "command" && strings.HasSuffix(hook.Get("command").String(), hookMark)
}

// withoutSoksakHooks returns doc without the entries that soksak registered under every event. A group whose hooks the removal
// emptied is dropped, and so is an event or the hooks member that the removal emptied; every other member keeps its bytes.
func withoutSoksakHooks(doc []byte) ([]byte, error) {
	hooks := gjson.GetBytes(doc, "hooks")
	if !hooks.Exists() {
		return doc, nil
	}
	type edit struct {
		event  string
		value  string
		remove bool
	}
	var edits []edit
	var err error
	hooks.ForEach(func(event, events gjson.Result) bool {
		var kept []string
		changed := false
		events.ForEach(func(_, group gjson.Result) bool {
			inner := group.Get("hooks")
			if !group.IsObject() || !inner.IsArray() {
				err = fmt.Errorf("hooks.%s holds a group that is not an object with an array of hooks", event.String())
				return false
			}
			var keep []string
			owned := false
			inner.ForEach(func(_, hook gjson.Result) bool {
				if isSoksakHook(hook) {
					owned = true
				} else {
					keep = append(keep, hook.Raw)
				}
				return true
			})
			if !owned {
				kept = append(kept, group.Raw)
				return true
			}
			changed = true
			if len(keep) == 0 {
				return true
			}
			group2, serr := sjson.SetRaw(group.Raw, "hooks", "["+strings.Join(keep, ",")+"]")
			if serr != nil {
				err = serr
				return false
			}
			kept = append(kept, group2)
			return true
		})
		if err != nil {
			return false
		}
		if changed {
			edits = append(edits, edit{event: event.String(), value: "[" + strings.Join(kept, ",") + "]", remove: len(kept) == 0})
		}
		return true
	})
	if err != nil {
		return nil, err
	}
	out := doc
	for _, e := range edits {
		if e.remove {
			out, err = sjson.DeleteBytes(out, "hooks."+pathKey(e.event))
		} else {
			out, err = sjson.SetRawBytes(out, "hooks."+pathKey(e.event), []byte(e.value))
		}
		if err != nil {
			return nil, err
		}
	}
	if len(edits) > 0 {
		if remaining := gjson.GetBytes(out, "hooks"); remaining.IsObject() && len(remaining.Map()) == 0 {
			out, err = sjson.DeleteBytes(out, "hooks")
			if err != nil {
				return nil, err
			}
		}
	}
	return out, nil
}

// withSoksakHook returns doc with the group of the command added to the SessionStart array, which it creates when it is absent.
func withSoksakHook(doc []byte, command string) ([]byte, error) {
	quoted, err := json.Marshal(command)
	if err != nil {
		return nil, err
	}
	group := `{"matcher":"","hooks":[{"type":"command","command":` + string(quoted) + `}]}`
	hooks := gjson.GetBytes(doc, "hooks")
	if !hooks.Exists() {
		return sjson.SetRawBytes(doc, "hooks", []byte(`{"`+hookEvent+`":[`+group+`]}`))
	}
	if !hooks.Get(pathKey(hookEvent)).Exists() {
		return sjson.SetRawBytes(doc, "hooks."+pathKey(hookEvent), []byte("["+group+"]"))
	}
	return sjson.SetRawBytes(doc, "hooks."+pathKey(hookEvent)+".-1", []byte(group))
}

// formatHookDocument writes doc in the two-space form with a final line feed.
func formatHookDocument(doc []byte) ([]byte, error) {
	var buf bytes.Buffer
	if err := json.Indent(&buf, doc, "", "  "); err != nil {
		return nil, err
	}
	return append(bytes.TrimRight(buf.Bytes(), " \t\r\n"), '\n'), nil
}

// soksakHookEntries returns the event and the command of each entry that soksak registered in the document.
func soksakHookEntries(doc []byte) []struct{ event, command string } {
	var entries []struct{ event, command string }
	gjson.GetBytes(doc, "hooks").ForEach(func(event, events gjson.Result) bool {
		events.ForEach(func(_, group gjson.Result) bool {
			group.Get("hooks").ForEach(func(_, hook gjson.Result) bool {
				if isSoksakHook(hook) {
					entries = append(entries, struct{ event, command string }{event.String(), hook.Get("command").String()})
				}
				return true
			})
			return true
		})
		return true
	})
	return entries
}

// hookPart reads the state of the hook file for <sok>: ok when the file holds exactly the current soksak entry under SessionStart.
func hookPart(file, sok string) (SetupPart, error) {
	command := hookCommand(sok)
	part := SetupPart{Part: "hook", File: file, Step: StepOf(sok) + " setup install hook"}
	data, err := os.ReadFile(file)
	if errors.Is(err, fs.ErrNotExist) {
		part.State, part.Reason = "missing", "absent"
		return part, nil
	}
	if err != nil {
		part.State, part.Error = "error", fileError(file, err).Error()
		return part, nil
	}
	if err := hookDocument(file, data); err != nil {
		part.State, part.Error = "error", err.Error()
		return part, nil
	}
	entries := soksakHookEntries(data)
	switch {
	case len(entries) == 0:
		part.State, part.Reason = "missing", "absent"
	case len(entries) == 1 && entries[0].event == hookEvent && entries[0].command == command:
		part.State = "ok"
	default:
		part.State, part.Reason = "missing", "differs"
	}
	return part, nil
}

// installHookFile writes the current soksak entry into file, creating a missing file and keeping the other entries, and reports
// whether the file changed.
func installHookFile(file, command string) (bool, error) {
	info, statErr := os.Stat(file)
	created := errors.Is(statErr, fs.ErrNotExist)
	var data []byte
	if created {
		data = []byte("{}")
	} else {
		var err error
		data, err = os.ReadFile(file)
		if err != nil {
			return false, fileError(file, err)
		}
	}
	if err := hookDocument(file, data); err != nil {
		return false, err
	}
	stripped, err := withoutSoksakHooks(data)
	if err != nil {
		return false, fmt.Errorf("%s: %w", file, err)
	}
	added, err := withSoksakHook(stripped, command)
	if err != nil {
		return false, fmt.Errorf("%s: %w", file, err)
	}
	out, err := formatHookDocument(added)
	if err != nil {
		return false, fmt.Errorf("%s: %w", file, err)
	}
	if !created && bytes.Equal(out, data) {
		return false, nil
	}
	if err := replaceFile(file, out); err != nil {
		return false, err
	}
	if !created {
		if err := os.Chmod(file, info.Mode().Perm()); err != nil {
			return true, fileError(file, err)
		}
	}
	return true, nil
}

// removeHookFile removes the soksak entries of file, which it leaves untouched when it is absent or holds none, and reports whether
// the file changed.
func removeHookFile(file string) (bool, error) {
	data, err := os.ReadFile(file)
	if errors.Is(err, fs.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, fileError(file, err)
	}
	if err := hookDocument(file, data); err != nil {
		return false, err
	}
	stripped, err := withoutSoksakHooks(data)
	if err != nil {
		return false, fmt.Errorf("%s: %w", file, err)
	}
	out, err := formatHookDocument(stripped)
	if err != nil {
		return false, fmt.Errorf("%s: %w", file, err)
	}
	if bytes.Equal(out, data) {
		return false, nil
	}
	info, err := os.Stat(file)
	if err != nil {
		return false, fileError(file, err)
	}
	if err := replaceFile(file, out); err != nil {
		return false, err
	}
	if err := os.Chmod(file, info.Mode().Perm()); err != nil {
		return true, fileError(file, err)
	}
	return true, nil
}

// hookParts reads the hook part of each hook file that exists for this Setup.
func (s Setup) hookParts() ([]SetupPart, error) {
	files, err := s.hookFiles()
	if err != nil {
		return nil, err
	}
	var parts []SetupPart
	for _, file := range files {
		part, err := hookPart(file, s.Sok)
		if err != nil {
			return nil, err
		}
		parts = append(parts, part)
	}
	return parts, nil
}

// InstallHooks writes the current soksak entry into each hook file that exists, and returns the hook files that changed.
func (s Setup) InstallHooks() (map[string]bool, error) {
	files, err := s.hookFiles()
	if err != nil {
		return nil, err
	}
	changed := map[string]bool{}
	var failures []string
	for _, file := range files {
		ok, err := installHookFile(file, hookCommand(s.Sok))
		changed[file] = ok
		if err != nil {
			failures = append(failures, err.Error())
		}
	}
	if failures != nil {
		return changed, errors.New(strings.Join(failures, "; "))
	}
	return changed, nil
}

// RemoveHooks removes the soksak entries of each hook file that exists, and returns the hook files that changed.
func (s Setup) RemoveHooks() (map[string]bool, error) {
	files, err := s.hookFiles()
	if err != nil {
		return nil, err
	}
	changed := map[string]bool{}
	var failures []string
	for _, file := range files {
		ok, err := removeHookFile(file)
		changed[file] = ok
		if err != nil {
			failures = append(failures, err.Error())
		}
	}
	if failures != nil {
		return changed, errors.New(strings.Join(failures, "; "))
	}
	return changed, nil
}

// hookOutput is the JSON that a SessionStart hook prints on standard output: its members keep this order.
type hookOutput struct {
	HookSpecificOutput hookSpecificOutput `json:"hookSpecificOutput"`
}

// hookSpecificOutput is the event and the context that the hook adds to the model context.
type hookSpecificOutput struct {
	HookEventName     string `json:"hookEventName"`
	AdditionalContext string `json:"additionalContext"`
}

// runRoleIdentity is `sok role identity`: it prints the identity of the tab of this process as the additionalContext of a
// SessionStart hook, and prints nothing when the process is outside a tab, the tab has no role, or the environment has no
// configuration directory (docs/spec/agent-roles.md#session-restart-hook).
func runRoleIdentity(stdout io.Writer, options Options, values map[string]string) (err error) {
	if os.Getenv(ConfigDirVariable) == "" {
		return nil
	}
	configDir, err := configDirOf(values, options)
	if err != nil {
		return err
	}
	if strings.ContainsAny(configDir, `"'`+"`"+`\`) || hasControlCharacter(configDir) {
		return fmt.Errorf("configuration directory %s holds a quote or a control character", configDir)
	}
	client, err := connectTo(values, options)
	if err != nil {
		return err
	}
	defer func() {
		if closeErr := client.Close(); closeErr != nil && err == nil {
			err = closeErr
		}
	}()
	surface, refused, err := ownSurface(client.Request)
	if err != nil || refused != nil {
		return err
	}
	if strings.ContainsAny(surface, `/\`) || surface == ".." || hasControlCharacter(surface) {
		return fmt.Errorf("surface %q holds a path part or a control character", surface)
	}
	file := filepath.Join(configDir, "agents", surface, "role.md")
	if _, err := os.Stat(file); errors.Is(err, fs.ErrNotExist) {
		return nil
	} else if err != nil {
		return fileError(file, err)
	}
	data, err := json.Marshal(hookOutput{HookSpecificOutput: hookSpecificOutput{HookEventName: hookEvent, AdditionalContext: fmt.Sprintf(identityText, file)}})
	if err != nil {
		return err
	}
	_, err = stdout.Write(append(data, '\n'))
	return err
}

// runRoleCommand parses the arguments after the word `role`, which accepts only the action `identity`, with the mark of the hook
// and the options of the configuration directory.
func runRoleCommand(args []string, stdout io.Writer, opts Options) error {
	a, err := parseAllowed(args, map[string]bool{"soksak-hook": true}, options)
	if err != nil {
		return err
	}
	if len(a.positionals) != 1 || a.positionals[0] != "identity" {
		return usage("role takes the action identity")
	}
	return runRoleIdentity(stdout, opts, a.values)
}

// hasControlCharacter reports whether text holds a control character.
func hasControlCharacter(text string) bool {
	for _, r := range text {
		if r < 0x20 || r == 0x7f {
			return true
		}
	}
	return false
}
