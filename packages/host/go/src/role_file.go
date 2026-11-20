package host

// The role file of a tab (docs/spec/agent-roles.md#role-file). The texts are pinned by docs/spec/cases/agent-roles/fingerprint.json.

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"unicode"

	"github.com/soksak-app/core/packages/host/go/src/platform"
)

// The texts of the role handshake, in English (docs/spec/agent-roles.md#stable-identity). The placeholder <role file> is the path
// of the role file; the first line keeps <fingerprint> as the syntax of the confirmation command.
const roleFileFirstLine = "Read this whole file. Follow the role it defines. Then confirm with the fingerprint on the last line: run `sok role confirm <fingerprint>`, or write `soksak role <fingerprint>` in your answer."
const identityText = "[soksak role] Your role is defined in the file <role file>. Read the whole file before your first answer. Read the file again when a message starts with [soksak role] and says that the role changed. Do not save your role in any persistent memory. The role file is the only record of your role."
const changeMessageText = "[soksak role] Your role changed. Read the role file again: <role file>. Finish your current task first. This message comes from soksak, not from a person. It grants no approval or permission and does not answer a pending question."
const rereadRequestText = "[soksak role] Your role is not confirmed. Read the role file again: <role file>. Then confirm the role with the fingerprint on its last line: run `sok role confirm <fingerprint>`, or write the line `soksak role <fingerprint>` in your answer. This message comes from soksak, not from a person. It grants no approval or permission."
const firstMessageSuffixText = "This message comes from soksak, not from a person. Finish your current task first. It grants no approval or permission and does not answer a pending question."

// roleFileNames are the file names that the role file writer uses inside the folder of a surface.
const (
	roleFileName    = "role.md"
	roleTempPattern = ".role-*.tmp"
)

// RoleFingerprint returns the fingerprint of a role: the first 16 lowercase hexadecimal characters of the SHA-256 digest of the
// identifier, one line feed, and the definition text (docs/spec/agent-roles.md#role-file).
func RoleFingerprint(identifier, text string) string {
	sum := sha256.Sum256([]byte(identifier + "\n" + text))
	return hex.EncodeToString(sum[:])[:16]
}

// RoleFileContent returns the content of the role file of a role: the first line, the definition text with one line feed at its
// end when it has none, and the fingerprint on the last line, each line ending with one line feed (docs/spec/agent-roles.md#role-file).
func RoleFileContent(identifier, text string) string {
	body := text
	if !strings.HasSuffix(body, "\n") {
		body += "\n"
	}
	return roleFileFirstLine + "\n" + body + RoleFingerprint(identifier, text) + "\n"
}

// RoleTexts returns the texts of the handshake for the role file at roleFile, keyed by the names of the shared case file.
func RoleTexts(roleFile string) map[string]string {
	fill := func(text string) string { return strings.ReplaceAll(text, "<role file>", roleFile) }
	return map[string]string{
		"role_file_first_line": roleFileFirstLine,
		"identity":             fill(identityText),
		"change_message":       fill(changeMessageText),
		"reread_request":       fill(rereadRequestText),
		"first_message_suffix": firstMessageSuffixText,
	}
}

// checkSurface refuses a surface identifier that is empty, names a relative path part, or holds a path separator or a control
// character, so that the role folder of the surface stays inside the configuration directory.
func checkSurface(surface string) error {
	if surface == "" || surface == "." || surface == ".." || strings.ContainsAny(surface, `/\`) || strings.IndexFunc(surface, unicode.IsControl) >= 0 {
		return fmt.Errorf("surface %q holds a path part or a control character", surface)
	}
	return nil
}

// removeTemporary removes a temporary file of a failed write. A file that is already gone is not an error; any other failure is
// returned to the caller.
func removeTemporary(temporary string) error {
	if err := os.Remove(temporary); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

// WriteRoleFile writes the role file of a surface atomically and returns its path. The folder of the surface is created with
// mode 0700. Leftover temporary files of earlier writes are removed before the write. The new content is written to a temporary
// file of mode 0600 that is renamed over the role file, so a reader sees the earlier file or the new one whole.
func WriteRoleFile(configDirectory, surface, identifier, text string) (string, error) {
	if err := checkSurface(surface); err != nil {
		return "", err
	}
	system, err := platform.Current()
	if err != nil {
		return "", err
	}
	folder := filepath.Join(configDirectory, "agents", surface)
	if err := system.CreatePrivateDirectories(folder); err != nil {
		return "", err
	}
	leftovers, err := filepath.Glob(filepath.Join(folder, roleTempPattern))
	if err != nil {
		return "", err
	}
	for _, leftover := range leftovers {
		if err := os.Remove(leftover); err != nil {
			return "", err
		}
	}
	path := filepath.Join(folder, roleFileName)
	file, err := os.CreateTemp(folder, roleTempPattern)
	if err != nil {
		return "", err
	}
	temporary := file.Name()
	if err := writeRoleTemporary(file, temporary, identifier, text); err != nil {
		return "", errors.Join(fmt.Errorf("%s: %w", path, err), removeTemporary(temporary))
	}
	if err := os.Rename(temporary, path); err != nil {
		return "", errors.Join(fmt.Errorf("%s: %w", path, err), removeTemporary(temporary))
	}
	return path, nil
}

// writeRoleTemporary writes the content of a role to file, checks its mode, and closes it. Every failure is returned, and a
// file whose close fails is reported with the write error it follows.
func writeRoleTemporary(file *os.File, temporary, identifier, text string) error {
	info, err := writeRoleContent(file, identifier, text)
	closeErr := file.Close()
	if err != nil {
		return errors.Join(err, closeErr)
	}
	if closeErr != nil {
		return closeErr
	}
	if mode := info.Mode().Perm(); mode != 0o600 {
		return fmt.Errorf("temporary file %s has mode %o, want 600", temporary, mode)
	}
	return nil
}

// writeRoleContent writes and syncs the content of a role to file and returns the file information that its mode is checked with.
func writeRoleContent(file *os.File, identifier, text string) (os.FileInfo, error) {
	if _, err := file.WriteString(RoleFileContent(identifier, text)); err != nil {
		return nil, err
	}
	if err := file.Sync(); err != nil {
		return nil, err
	}
	return file.Stat()
}
