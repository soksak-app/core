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

// roleFileFirstLineKo is the Korean translation of the first line, the first line of role.ko.md (texts_ko of the case file).
const roleFileFirstLineKo = "이 파일 전체를 읽는다. 이 파일이 정의하는 role을 따른다. 그다음 마지막 줄의 fingerprint로 확인한다: `sok role confirm <fingerprint>`를 실행하거나, 답에 `soksak role <fingerprint>`를 쓴다."
const firstMessageSuffixText = "This message comes from soksak, not from a person. Finish your current task first. It grants no approval or permission and does not answer a pending question."

// roleFileNames are the file names that the role file writer uses inside the folder of a surface.
const (
	roleFileName    = "role.md"
	roleKoFileName  = "role.ko.md"
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

// roleKoFileContent returns the content of role.ko.md: the Korean first line, the Korean text with one line feed at its end
// when it has none, and the fingerprint of role.md, which is computed over the English text (docs/spec/agent-roles.md#role-file).
func roleKoFileContent(identifier, text, ko string) string {
	body := ko
	if !strings.HasSuffix(body, "\n") {
		body += "\n"
	}
	return roleFileFirstLineKo + "\n" + body + RoleFingerprint(identifier, text) + "\n"
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

// WriteRoleFile writes the role file of a surface and its Korean file role.ko.md atomically and returns the path of the role
// file. The folder of the surface is created with mode 0700. Leftover temporary files of earlier writes are removed before the
// write. Each content is written to a temporary file of mode 0600; role.md is renamed first and role.ko.md second, so a reader
// sees the earlier file or the new one whole.
func WriteRoleFile(configDirectory, surface, identifier, text, ko string) (string, error) {
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
	temporary, err := writeRoleTemporary(folder, path, RoleFileContent(identifier, text))
	if err != nil {
		return "", err
	}
	koPath := filepath.Join(folder, roleKoFileName)
	koTemporary, err := writeRoleTemporary(folder, koPath, roleKoFileContent(identifier, text, ko))
	if err != nil {
		return "", errors.Join(err, removeTemporary(temporary))
	}
	if err := os.Rename(temporary, path); err != nil {
		return "", errors.Join(fmt.Errorf("%s: %w", path, err), removeTemporary(temporary), removeTemporary(koTemporary))
	}
	if err := os.Rename(koTemporary, koPath); err != nil {
		return "", errors.Join(fmt.Errorf("%s: %w", koPath, err), removeTemporary(koTemporary))
	}
	return path, nil
}

// writeRoleTemporary writes content to a new temporary file in folder, checks its mode, closes it, and returns its path. A
// failure names path, the file the temporary file replaces, and removes the temporary file.
func writeRoleTemporary(folder, path, content string) (string, error) {
	file, err := os.CreateTemp(folder, roleTempPattern)
	if err != nil {
		return "", fmt.Errorf("%s: %w", path, err)
	}
	temporary := file.Name()
	info, err := writeRoleContent(file, content)
	closeErr := file.Close()
	if err == nil && closeErr == nil && info.Mode().Perm() != 0o600 {
		err = fmt.Errorf("temporary file %s has mode %o, want 600", temporary, info.Mode().Perm())
	}
	if err := errors.Join(err, closeErr); err != nil {
		return "", errors.Join(fmt.Errorf("%s: %w", path, err), removeTemporary(temporary))
	}
	return temporary, nil
}

// writeRoleContent writes and syncs the content of a role to file and returns the file information that its mode is checked with.
func writeRoleContent(file *os.File, content string) (os.FileInfo, error) {
	if _, err := file.WriteString(content); err != nil {
		return nil, err
	}
	if err := file.Sync(); err != nil {
		return nil, err
	}
	return file.Stat()
}
