package host

// The role file of a tab (docs/spec/agent-roles.md#role-file). Stubs of the Red state: each function answers its empty value.

// RoleFingerprint returns the fingerprint of a role: the identifier and the definition text (docs/spec/agent-roles.md#role-file).
func RoleFingerprint(identifier, text string) string { return "" }

// RoleFileContent returns the content of the role file of a role (docs/spec/agent-roles.md#role-file).
func RoleFileContent(identifier, text string) string { return "" }

// RoleTexts returns the texts of the role file, the identity, the change message, the reread request and the first message suffix
// for the role file at roleFile (docs/spec/agent-roles.md#stable-identity).
func RoleTexts(roleFile string) map[string]string { return nil }

// WriteRoleFile writes the role file of a surface atomically and returns its path.
func WriteRoleFile(configDirectory, surface, identifier, text string) (string, error) { return "", nil }
