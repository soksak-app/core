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
// sees the earlier file or the new one whole. A write that the ordered change of a role drives stores the record between the
// two steps, so the change calls prepareRoleFile and commit itself (docs/spec/agent-roles.md#tab-role-state).
func WriteRoleFile(configDirectory, surface, identifier, text, ko string) (string, error) {
	prepared, err := prepareRoleFile(configDirectory, surface, identifier, text, ko)
	if err != nil {
		return "", err
	}
	if err := prepared.commit(); err != nil {
		return "", err
	}
	return prepared.rolePath, nil
}

// preparedRole is a write of the role files that holds both temporary files and renames them in its commit: step 1 of the
// ordered change of a role, whose step 3 the commit is (docs/spec/agent-roles.md#tab-role-state).
type preparedRole struct {
	folder, rolePath, koPath, roleTemporary, koTemporary string
}

// prepareRoleFile performs step 1 of the ordered change: it creates the folder of the surface, removes the leftover
// temporary files of earlier writes, and writes both contents to temporary files of mode 0600. A failure is refused with
// `role file <path>: write failed: <os error>` or the mode text, removes what it wrote, and stores nothing.
func prepareRoleFile(configDirectory, surface, identifier, text, ko string) (*preparedRole, error) {
	if err := checkSurface(surface); err != nil {
		return nil, err
	}
	system, err := platform.Current()
	if err != nil {
		return nil, err
	}
	folder := filepath.Join(configDirectory, "agents", surface)
	if err := system.CreatePrivateDirectories(folder); err != nil {
		return nil, writeFailed(folder, err)
	}
	leftovers, err := filepath.Glob(filepath.Join(folder, roleTempPattern))
	if err != nil {
		return nil, writeFailed(folder, err)
	}
	for _, leftover := range leftovers {
		if err := os.Remove(leftover); err != nil {
			return nil, writeFailed(leftover, err)
		}
	}
	prepared := &preparedRole{folder: folder, rolePath: filepath.Join(folder, roleFileName), koPath: filepath.Join(folder, roleKoFileName)}
	if prepared.roleTemporary, err = writeRoleTemporary(folder, prepared.rolePath, RoleFileContent(identifier, text)); err != nil {
		return nil, err
	}
	if prepared.koTemporary, err = writeRoleTemporary(folder, prepared.koPath, roleKoFileContent(identifier, text, ko)); err != nil {
		prepared.discard()
		return nil, err
	}
	return prepared, nil
}

// commit performs step 3 of the ordered change: role.md is renamed first and role.ko.md second. A failed rename removes the
// temporary files and is refused with `role file <path>: rename failed: <os error>`.
func (p *preparedRole) commit() error {
	if err := os.Rename(p.roleTemporary, p.rolePath); err != nil {
		return errors.Join(renameFailed(p.rolePath, err), p.discard())
	}
	if err := os.Rename(p.koTemporary, p.koPath); err != nil {
		return errors.Join(renameFailed(p.koPath, err), p.discard())
	}
	return nil
}

// discard removes the temporary files of a write that will not be committed. A file that is already gone is not an error.
func (p *preparedRole) discard() error {
	return errors.Join(removeTemporary(p.roleTemporary), removeTemporary(p.koTemporary))
}

// writeFailed states the refusal of a failed write step: `role file <path>: write failed: <os error>`
// (docs/spec/agent-roles.md#role-file).
func writeFailed(path string, err error) error {
	return fmt.Errorf("role file %s: write failed: %w", path, err)
}

// renameFailed states the refusal of a failed rename of a role file: `role file <path>: rename failed: <os error>`.
func renameFailed(path string, err error) error {
	return fmt.Errorf("role file %s: rename failed: %w", path, err)
}

// writeRoleTemporary writes content to a new temporary file in folder, checks its mode, closes it, and returns its path. A
// failure is refused with the write-failed text of the file that the temporary file replaces, or the mode text of the spec,
// and removes the temporary file.
func writeRoleTemporary(folder, path, content string) (string, error) {
	file, err := os.CreateTemp(folder, roleTempPattern)
	if err != nil {
		return "", writeFailed(path, err)
	}
	temporary := file.Name()
	info, err := writeRoleContent(file, content)
	closeErr := file.Close()
	if err == nil && closeErr == nil && info.Mode().Perm() != 0o600 {
		err = fmt.Errorf("role file %s: mode %o is not 0600", path, info.Mode().Perm())
	}
	if err := errors.Join(err, closeErr); err != nil {
		return "", errors.Join(err, removeTemporary(temporary))
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
