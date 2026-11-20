package sok

// `sok conversation read` (docs/spec/agent-conversation.md): the messages of the conversation of an agent in a working directory,
// read from the session file that the agent wrote. The Rust sok (packages/sok/rust/src/conversation.rs) implements the same command
// with the same rules.

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"time"
	"unicode/utf16"
	"unicode/utf8"
)

// The agents whose session files the command reads.
const (
	agentClaudeCode = "claude-code"
	agentCodex      = "codex"
)

// conversationBooleans and conversationOptions are the flags and values of the command.
var conversationBooleans = map[string]bool{"help": true}
var conversationOptions = map[string]bool{"agent": true, "cwd": true}

// numberedRecord is a record of a session file with the number of its physical line.
type numberedRecord struct {
	line   int
	fields map[string]any
}

// runConversation runs the conversation commands; args are the arguments after the word conversation.
func runConversation(args []string, stdout io.Writer) error {
	if len(args) == 1 && args[0] == "--help" {
		_, err := fmt.Fprintln(stdout, Usage)
		return err
	}
	if len(args) == 0 {
		return usage("conversation requires an action")
	}
	if args[0] != "read" {
		return usage("unknown command: conversation %s", strings.Join(args, " "))
	}
	parsed, err := parseAllowed(args[1:], conversationBooleans, conversationOptions)
	if err != nil {
		return err
	}
	if parsed.flags["help"] {
		_, err := fmt.Fprintln(stdout, Usage)
		return err
	}
	if len(parsed.positionals) > 0 {
		return usage("unexpected argument %s", parsed.positionals[0])
	}
	agent, err := parsed.required("agent")
	if err != nil {
		return err
	}
	if agent != agentClaudeCode && agent != agentCodex {
		return fmt.Errorf("unknown agent %s", agent)
	}
	cwd, err := parsed.required("cwd")
	if err != nil {
		return err
	}
	if !filepath.IsAbs(cwd) {
		return fmt.Errorf("cwd is not an absolute path: %s", cwd)
	}
	home := os.Getenv("HOME")
	if home == "" {
		return fmt.Errorf("HOME is not set")
	}
	if !utf8.ValidString(home) {
		return fmt.Errorf("HOME is not UTF-8: %s", escapedBytes(home))
	}
	file, messages, skipped, err := readConversation(agent, home, cwd)
	if err != nil {
		return err
	}
	encoder := json.NewEncoder(stdout)
	encoder.SetEscapeHTML(false)
	return encoder.Encode(map[string]any{"file": file, "messages": messages, "skipped": skipped})
}

// readConversation selects the session file whose working directory is cwd and returns its path with its messages and the number
// of records that are not messages with text.
func readConversation(agent, home, cwd string) (string, []any, int, error) {
	var candidates []string
	switch agent {
	case agentClaudeCode:
		folder := filepath.Join(home, ".claude", "projects", claudeFolderName(cwd))
		paths, err := listFolder(folder)
		if err != nil {
			return "", nil, 0, err
		}
		for _, path := range paths {
			regular, err := isRegularFile(path)
			if err != nil {
				return "", nil, 0, err
			}
			if regular && hasExtension(path, "jsonl") {
				candidates = append(candidates, path)
			}
		}
	case agentCodex:
		if err := collectRollouts(filepath.Join(home, ".codex", "sessions"), &candidates); err != nil {
			return "", nil, 0, err
		}
	}
	sort.Slice(candidates, func(i, j int) bool { return pathLess(candidates[i], candidates[j]) })

	// The chosen file is the matching one with the latest modification time; a tie keeps the file first in path order.
	var chosen string
	var chosenTime time.Time
	found := false
	for _, path := range candidates {
		sessionDirectory, err := sessionCwd(agent, path)
		if err != nil {
			return "", nil, 0, err
		}
		if sessionDirectory != cwd {
			continue
		}
		info, err := os.Stat(path)
		if err != nil {
			return "", nil, 0, fileError(path, err)
		}
		if !found || info.ModTime().After(chosenTime) {
			chosen, chosenTime, found = path, info.ModTime(), true
		}
	}
	if !found {
		return "", nil, 0, fmt.Errorf("no %s session file has the working directory %s", agent, cwd)
	}
	records, err := readRecords(chosen)
	if err != nil {
		return "", nil, 0, err
	}
	var messages []any
	var skipped int
	if agent == agentClaudeCode {
		messages, skipped, err = claudeMessages(chosen, records)
	} else {
		messages, skipped, err = codexMessages(chosen, records)
	}
	if err != nil {
		return "", nil, 0, err
	}
	return chosen, messages, skipped, nil
}

// claudeFolderName is the folder name of a Claude Code session: each UTF-16 code unit that is not an ASCII letter or digit is
// written as `-`. A name longer than 200 characters is its first 200 characters, `-` and the base-36 text of the absolute value of
// the hash of the working directory (docs/spec/agent-conversation.md#claude-code; the length rule is unverified).
func claudeFolderName(cwd string) string {
	units := utf16.Encode([]rune(cwd))
	name := make([]byte, 0, len(units))
	for _, unit := range units {
		if unit < utf8.RuneSelf && isASCIIAlphanumeric(byte(unit)) {
			name = append(name, byte(unit))
		} else {
			name = append(name, '-')
		}
	}
	if len(name) <= 200 {
		return string(name)
	}
	hash := claudeHash(units)
	magnitude := uint32(hash)
	if hash < 0 {
		magnitude = uint32(-hash)
	}
	return string(name[:200]) + "-" + base36(magnitude)
}

// claudeHash is the hash of a working directory of Claude Code: `hash = (hash << 5) - hash + unit` over its UTF-16 code units, each
// step wrapped to a signed 32-bit integer.
func claudeHash(units []uint16) int32 {
	var hash int32
	for _, unit := range units {
		hash = hash<<5 - hash + int32(unit)
	}
	return hash
}

// base36 is the base-36 text of value with lowercase digits.
func base36(value uint32) string {
	const digits = "0123456789abcdefghijklmnopqrstuvwxyz"
	var reversed []byte
	for {
		reversed = append(reversed, digits[value%36])
		value /= 36
		if value == 0 {
			break
		}
	}
	slices.Reverse(reversed)
	return string(reversed)
}

func isASCIIAlphanumeric(b byte) bool {
	return b >= '0' && b <= '9' || b >= 'a' && b <= 'z' || b >= 'A' && b <= 'Z'
}

// listFolder returns the paths of the entries of a folder, or none when the folder does not exist: an agent that wrote no session has
// no folder.
func listFolder(folder string) ([]string, error) {
	entries, err := os.ReadDir(folder)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fileError(folder, err)
	}
	paths := make([]string, 0, len(entries))
	for _, entry := range entries {
		path := filepath.Join(folder, entry.Name())
		if !utf8.ValidString(path) {
			return nil, fmt.Errorf("%s: the path is not UTF-8", escapedBytes(path))
		}
		paths = append(paths, path)
	}
	return paths, nil
}

// collectRollouts adds the rollout files of a Codex sessions folder at any depth to out. A symbolic link is neither followed nor a
// candidate.
func collectRollouts(folder string, out *[]string) error {
	paths, err := listFolder(folder)
	if err != nil {
		return err
	}
	for _, path := range paths {
		info, err := os.Lstat(path)
		if err != nil {
			return fileError(path, err)
		}
		if info.IsDir() {
			if err := collectRollouts(path, out); err != nil {
				return err
			}
		} else if strings.HasPrefix(filepath.Base(path), "rollout-") && hasExtension(path, "jsonl") && info.Mode().IsRegular() {
			*out = append(*out, path)
		}
	}
	return nil
}

// isRegularFile reports whether the path is a regular file. A symbolic link is not a regular file.
func isRegularFile(path string) (bool, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return false, fileError(path, err)
	}
	return info.Mode().IsRegular(), nil
}

// hasExtension reports whether the file name has the extension, which has a name before its dot as Path::extension does.
func hasExtension(path, extension string) bool {
	name := filepath.Base(path)
	return len(name) > len(extension)+1 && strings.HasSuffix(name, "."+extension)
}

// pathLess orders paths by their components, as the path order of the Rust sok does.
func pathLess(a, b string) bool {
	left := strings.Split(a, string(filepath.Separator))
	right := strings.Split(b, string(filepath.Separator))
	for i := 0; i < len(left) && i < len(right); i++ {
		if left[i] != right[i] {
			return left[i] < right[i]
		}
	}
	return len(left) < len(right)
}

// forEachLine calls visit with the physical number and the text of each line of the file, without the line break, until visit
// reports that it stopped. A line that is not valid UTF-8 fails the read with the path.
func forEachLine(path string, visit func(number int, line string) (bool, error)) error {
	file, err := os.Open(path)
	if err != nil {
		return fileError(path, err)
	}
	defer file.Close()
	reader := bufio.NewReader(file)
	for number := 1; ; number++ {
		text, readErr := reader.ReadString('\n')
		if readErr != nil && readErr != io.EOF {
			return fileError(path, readErr)
		}
		if text == "" && readErr == io.EOF {
			return nil
		}
		line := strings.TrimSuffix(strings.TrimSuffix(text, "\n"), "\r")
		if !utf8.ValidString(line) {
			return fmt.Errorf("%s: stream did not contain valid UTF-8", path)
		}
		stop, err := visit(number, line)
		if err != nil || stop {
			return err
		}
		if readErr == io.EOF {
			return nil
		}
	}
}

// parseRecord returns the JSON object of a line, or none for a blank line. Any other line is refused with its number.
func parseRecord(path string, number int, line string) (map[string]any, bool, error) {
	if strings.TrimSpace(line) == "" {
		return nil, false, nil
	}
	var value any
	if err := json.Unmarshal([]byte(line), &value); err != nil {
		return nil, false, fmt.Errorf("%s: line %d is not a JSON object", path, number)
	}
	record, ok := value.(map[string]any)
	if !ok {
		return nil, false, fmt.Errorf("%s: line %d is not a JSON object", path, number)
	}
	return record, true, nil
}

// readRecords returns the records of a session file with their line numbers. Every line that is not blank must be a JSON object.
func readRecords(path string) ([]numberedRecord, error) {
	var records []numberedRecord
	err := forEachLine(path, func(number int, line string) (bool, error) {
		record, isRecord, err := parseRecord(path, number, line)
		if err != nil {
			return true, err
		}
		if isRecord {
			records = append(records, numberedRecord{line: number, fields: record})
		}
		return false, nil
	})
	return records, err
}

// sessionCwd returns the session working directory of a candidate, read from the lines up to the record that gives it: for Claude
// Code the `cwd` of the first record that has one, for Codex the `payload.cwd` of the first record, which must be a session_meta
// record. A file without that value, or whose value is not a string, is refused.
func sessionCwd(agent, path string) (string, error) {
	refused := fmt.Errorf("%s: the session working directory is missing or not a string", path)
	var cwd string
	found := false
	err := forEachLine(path, func(number int, line string) (bool, error) {
		record, isRecord, err := parseRecord(path, number, line)
		if err != nil || !isRecord {
			return false, err
		}
		var value any
		var present bool
		if agent == agentClaudeCode {
			value, present = record["cwd"]
			if !present {
				return false, nil
			}
		} else {
			payload, isObject := record["payload"].(map[string]any)
			if !isObject {
				return true, refused
			}
			value = payload["cwd"]
			if record["type"] != "session_meta" {
				return true, refused
			}
		}
		text, isString := value.(string)
		if !isString {
			return true, refused
		}
		cwd, found = text, true
		return true, nil
	})
	if err != nil {
		return "", err
	}
	if !found {
		return "", refused
	}
	return cwd, nil
}

// lineError is the refusal of a line of the file at path, with its number and the reason.
func lineError(path string, line int, reason string) error {
	return fmt.Errorf("%s: line %d %s", path, line, reason)
}

// contentItem returns the object of a content item and its `type`. A content item that is not a JSON object with a string type
// is refused with its line number.
func contentItem(path string, line int, item any) (map[string]any, string, error) {
	object, isObject := item.(map[string]any)
	kind, isString := object["type"].(string)
	if !isObject || !isString {
		return nil, "", lineError(path, line, "has a content item that is not an object with a string type")
	}
	return object, kind, nil
}

// countItems returns the number of items whose `type` is kind. A content item that is not an object with a string type is refused.
func countItems(path string, line int, items []any, kind string) (int, error) {
	count := 0
	for _, item := range items {
		_, itemKind, err := contentItem(path, line, item)
		if err != nil {
			return 0, err
		}
		if itemKind == kind {
			count++
		}
	}
	return count, nil
}

// messageValue is a message with its role and text, and with `items` holding one {"type": "image"} for each of its image items.
func messageValue(role, text string, images int) map[string]any {
	message := map[string]any{"role": role, "text": text}
	if images > 0 {
		kinds := make([]any, images)
		for i := range kinds {
			kinds[i] = map[string]any{"type": "image"}
		}
		message["items"] = kinds
	}
	return message
}

// joinedText joins the `text` fields of the items whose `type` is one of kinds with a newline in their order. A matching item whose
// `text` is not a string is refused with its line number.
func joinedText(path string, line int, items []any, kinds ...string) (string, error) {
	var texts []string
	for _, item := range items {
		object, kind, err := contentItem(path, line, item)
		if err != nil {
			return "", err
		}
		if !slices.Contains(kinds, kind) {
			continue
		}
		text, ok := object["text"].(string)
		if !ok {
			return "", lineError(path, line, "has a text that is not a string")
		}
		texts = append(texts, text)
	}
	return strings.Join(texts, "\n"), nil
}

// claudeMessages returns the messages of Claude Code records and the number of records that are not messages with text.
func claudeMessages(path string, records []numberedRecord) ([]any, int, error) {
	messages := []any{}
	skipped := 0
	for _, record := range records {
		role, _ := record.fields["type"].(string) // silent: a record whose type is not a string is not a user or assistant message, and is counted in skipped.
		if role != "user" && role != "assistant" {
			skipped++
			continue
		}
		message, isObject := record.fields["message"].(map[string]any)
		if !isObject {
			return nil, 0, lineError(path, record.line, "has a message content that is neither a string nor a list")
		}
		var text string
		images := 0
		switch content := message["content"].(type) {
		case string:
			text = content
		case []any:
			joined, err := joinedText(path, record.line, content, "text")
			if err != nil {
				return nil, 0, err
			}
			text = joined
			images, err = countItems(path, record.line, content, "image")
			if err != nil {
				return nil, 0, err
			}
		default:
			return nil, 0, lineError(path, record.line, "has a message content that is neither a string nor a list")
		}
		if text == "" && images == 0 {
			skipped++
		} else {
			messages = append(messages, messageValue(role, text, images))
		}
	}
	return messages, skipped, nil
}

// codexMessages returns the messages of Codex records and the number of records that are not messages with text.
func codexMessages(path string, records []numberedRecord) ([]any, int, error) {
	messages := []any{}
	skipped := 0
	for _, record := range records {
		payload, _ := record.fields["payload"].(map[string]any) // silent: a record without a payload object is not a message, and is counted in skipped.
		payloadType, _ := payload["type"].(string)              // silent: a payload whose type is not a string is not a message, and is counted in skipped.
		if record.fields["type"] != "response_item" || payloadType != "message" {
			skipped++
			continue
		}
		items, ok := payload["content"].([]any)
		if !ok {
			return nil, 0, lineError(path, record.line, "has a message content that is not a list")
		}
		text, err := joinedText(path, record.line, items, "input_text", "output_text")
		if err != nil {
			return nil, 0, err
		}
		images, err := countItems(path, record.line, items, "input_image")
		if err != nil {
			return nil, 0, err
		}
		role, _ := payload["role"].(string) // silent: a message without a string role is neither user nor assistant, and is counted in skipped.
		if (role == "user" || role == "assistant") && (text != "" || images > 0) {
			messages = append(messages, messageValue(role, text, images))
		} else {
			skipped++
		}
	}
	return messages, skipped, nil
}

// escapedBytes writes bytes for a message: each byte from 0x20 to 0x7e other than `\` as itself, `\` as `\\`, and every other
// byte as `\x` with two lowercase hexadecimal digits (docs/spec/agent-conversation.md#refusals).
func escapedBytes(text string) string {
	var out strings.Builder
	for index := 0; index < len(text); index++ {
		b := text[index]
		switch {
		case b == '\\':
			out.WriteString(`\\`)
		case b >= 0x20 && b <= 0x7e:
			out.WriteByte(b)
		default:
			fmt.Fprintf(&out, `\x%02x`, b)
		}
	}
	return out.String()
}
