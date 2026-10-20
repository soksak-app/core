package sok

import (
	"bytes"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync/atomic"
)

// The migration definitions of the stored files of this repository, as one source that both command lines embed
// (docs/spec/installation.md#stored-data-migration). The file is a tracked copy of packages/sok/migrations; make
// migrations-sync refreshes it and make migrations-check refuses a difference.
//
//go:embed migrations/installed.json migrations/settings.json migrations/projects.json
var migrationFS embed.FS

// migrationDefinition is one step of the chain of one stored file: the file it migrates, the format it comes from and
// goes to, and the named operations the engine applies in order.
type migrationDefinition struct {
	File       string               `json:"file"`
	From       int                  `json:"from"`
	To         int                  `json:"to"`
	Operations []migrationOperation `json:"operations"`
}

// migrationOperation is one named operation with the scope it applies to.
type migrationOperation struct {
	Op     string `json:"op"`
	Scope  string `json:"scope"`
	Field  string `json:"field"`
	Member string `json:"member"`
	From   string `json:"from"`
	// To is the target of the operation: the format number of setFormat, the field name of renameField.
	To any `json:"to"`
}

// migrationChain is the ordered chain of one file, from its floor to the current format.
type migrationChain struct {
	file  string
	steps []migrationDefinition
}

// migrationChains parses the embedded definitions and refuses a set that is not a chain of one file: a definition that
// names a second file, two definitions of one step, a gap, or a step that does not start where the earlier one ends.
func migrationChains() (map[string]migrationChain, error) {
	chains := map[string]migrationChain{}
	for _, name := range []string{"migrations/installed.json", "migrations/settings.json", "migrations/projects.json"} {
		if err := appendChain(chains, name); err != nil {
			return nil, err
		}
	}
	return chains, nil
}

// appendChain parses one definitions file of one stored file into the chains.
func appendChain(chains map[string]migrationChain, name string) error {
	data, err := migrationFS.ReadFile(name)
	if err != nil {
		return err
	}
	var definitions []migrationDefinition
	decoder := json.NewDecoder(bytes.NewReader(data))
	// Numbers keep their text, so the target of setFormat stays the number the definition names.
	decoder.UseNumber()
	if err := decoder.Decode(&definitions); err != nil {
		return fmt.Errorf("%s is not valid JSON: %w", name, err)
	}
	for _, definition := range definitions {
		chain, ok := chains[definition.File]
		if !ok {
			chains[definition.File] = migrationChain{file: definition.File, steps: []migrationDefinition{definition}}
			continue
		}
		last := chain.steps[len(chain.steps)-1]
		if definition.From != last.To {
			return fmt.Errorf("%s: %s migrates from format %d, but the earlier step ends at %d", name, definition.File, definition.From, last.To)
		}
		chain.steps = append(chain.steps, definition)
		chains[definition.File] = chain
	}
	return nil
}

// ProjectsFormat is the current format number of projects.json, the end of its definition chain.
func ProjectsFormat() int {
	return formatOf("projects.json")
}

// SettingsFormat is the current format number of settings.json, the end of its definition chain.
func SettingsFormat() int {
	return formatOf("settings.json")
}

// formatOf is the current format of one file of the definitions, or 0 without a chain.
func formatOf(file string) int {
	chains, err := migrationChains()
	if err != nil {
		return 0
	}
	return chains[file].current()
}

// MigrationChainsForTest exposes the parsed chains for the owning tests: the chain of each file as the steps the engine
// applies, so a test holds the engine to the definitions it embeds.
func MigrationChainsForTest() (map[string][]migrationStepForTest, error) {
	chains, err := migrationChains()
	if err != nil {
		return nil, err
	}
	out := map[string][]migrationStepForTest{}
	for file, chain := range chains {
		steps := make([]migrationStepForTest, 0, len(chain.steps))
		for _, step := range chain.steps {
			steps = append(steps, migrationStepForTest{From: step.From, To: step.To})
		}
		out[file] = steps
	}
	return out, nil
}

// migrationStepForTest is one step of a chain as the owning tests read it.
type migrationStepForTest struct {
	From int
	To   int
}

// MigrateInstalled applies the migration definitions of plugins/installed.json at the entry of its shared reader: a
// missing file is left missing, a file at the current format is left untouched, a form of the chain migrates step by
// step through the one writer of this package, and a form outside the chain — below the floor, above the current
// format, or not JSON — is refused with an error that names the file and the format it holds (docs/spec/installation.md).
// It returns the format the applied step ended at, or 0 when it applied nothing.
func MigrateInstalled(configDir string) (int, error) {
	return migrate(configDir, Installed)
}

// MigrateSettings applies the migration definitions of settings.json at the entry of its shared reader, the host
// workspace layer (docs/spec/installation.md#stored-data-migration). A file with no format member is the form 0.
func MigrateSettings(configDir string) (int, error) {
	return migrate(configDir, "settings.json")
}

// MigrateProjects applies the migration definitions of projects.json at the entry of its shared reader, the host
// workspace layer. A file that is a bare array of projects is the form 0.
func MigrateProjects(configDir string) (int, error) {
	return migrate(configDir, "projects.json")
}

// migrate applies the definitions of one stored file.
func migrate(configDir, file string) (int, error) {
	path := filepath.Join(configDir, file)
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return 0, nil
	}
	if err != nil {
		return 0, fileError(path, err)
	}
	chains, err := migrationChains()
	if err != nil {
		return 0, err
	}
	chain, ok := chains[file]
	if !ok {
		return 0, fmt.Errorf("the embedded migration definitions hold no chain for %s", file)
	}
	value, err := DecodeJSON(data)
	if err != nil {
		return 0, fmt.Errorf("%s is not valid JSON", path)
	}
	// A document that is a list is the form 0 of a file whose first definition wraps it (the bare array of
	// projects.json); the wrap operation of that definition names the member it goes under.
	bare, isList := value.([]any)
	if _, isObject := value.(map[string]any); !isObject && !isList {
		return 0, fmt.Errorf("%s: the file is neither an object nor a list", path)
	}
	var document map[string]any
	if isList {
		document = map[string]any{}
	} else {
		document = value.(map[string]any)
	}
	format := 0
	if !isList {
		if _, held := document["format"]; held {
			var err error
			if format, err = installedFormatOf(document); err != nil {
				return 0, fmt.Errorf("%s: %w", path, err)
			}
		}
	}
	current := chain.current()
	if format == current {
		return 0, nil
	}
	step, ok := chain.stepFrom(format)
	if !ok {
		return 0, fmt.Errorf("%s: the file holds format %d; the definitions migrate formats %d to %d", path, format, chain.floor(), current)
	}
	from := format
	for _, operation := range step.Operations {
		if operation.Op == "wrapDocument" {
			// The earlier form is the bare list; the operation names the member it becomes under the format member.
			if !isList {
				return 0, fmt.Errorf("%s: the operation wrapDocument needs the bare list of the earlier form", path)
			}
			document = map[string]any{operation.Member: bare}
			continue
		}
		if err := applyMigrationOperation(document, operation); err != nil {
			return 0, fmt.Errorf("%s: %w", path, err)
		}
	}
	if file == Installed {
		state, err := ValidateInstalled(jsonOf(document))
		if err != nil {
			return 0, fmt.Errorf("%s: the migration of format %d produced a file the reader refuses: %w", path, from, err)
		}
		if err := writeInstalled(configDir, state); err != nil {
			return 0, err
		}
	} else {
		text, err := json.Marshal(document)
		if err != nil {
			return 0, fmt.Errorf("%s: the migrated file cannot be written: %w", path, err)
		}
		if err := replaceFile(path, text); err != nil {
			return 0, err
		}
	}
	recordMigration(file, from, step.To)
	return step.To, nil
}

// stepFrom returns the step that starts at format, or none when the chain does not cover the format.
func (c migrationChain) stepFrom(format int) (migrationDefinition, bool) {
	for _, step := range c.steps {
		if step.From == format {
			return step, true
		}
	}
	return migrationDefinition{}, false
}

// floor is the format the chain starts from.
func (c migrationChain) floor() int {
	return c.steps[0].From
}

// current is the format the chain ends at.
func (c migrationChain) current() int {
	return c.steps[len(c.steps)-1].To
}

// installedFormatOf reads the format member of the document.
func installedFormatOf(document map[string]any) (int, error) {
	value, ok := document["format"]
	if !ok {
		return 0, fmt.Errorf("the file holds no format")
	}
	number, ok := value.(json.Number)
	if !ok {
		return 0, fmt.Errorf("format must be a number, found %v", value)
	}
	format, err := number.Int64()
	if err != nil {
		return 0, fmt.Errorf("format must be a number, found %v", value)
	}
	return int(format), nil
}

// applyMigrationOperation applies one named operation to the document in place.
func applyMigrationOperation(document map[string]any, operation migrationOperation) error {
	switch operation.Op {
	case "setFormat":
		number, ok := operation.To.(json.Number)
		if !ok {
			return fmt.Errorf("setFormat needs the format number it sets, found %v", operation.To)
		}
		document["format"] = number
		return nil
	case "removeField", "renameField":
		entries, ok := document["plugins"].(map[string]any)
		if operation.Scope != "plugins" || !ok {
			return fmt.Errorf("the operation %s of scope %q does not name the plugin entries of the file", operation.Op, operation.Scope)
		}
		for _, entry := range entries {
			object, ok := entry.(map[string]any)
			if !ok {
				continue
			}
			if operation.Op == "removeField" {
				delete(object, operation.Field)
				continue
			}
			name, ok := operation.To.(string)
			if !ok {
				return fmt.Errorf("renameField needs the field name it sets, found %v", operation.To)
			}
			if value, held := object[operation.From]; held {
				delete(object, operation.From)
				object[name] = value
			}
		}
		return nil
	default:
		return fmt.Errorf("the operation %q is not one the engine implements", operation.Op)
	}
}

// jsonOf converts the document back to a value that ValidateInstalled reads.
func jsonOf(document map[string]any) any {
	text, err := json.Marshal(document)
	if err != nil {
		return nil
	}
	value, err := DecodeJSON(text)
	if err != nil {
		return nil
	}
	return value
}

// migrationLog is the event writer of the process that runs the engine: a host registers it after its event log starts,
// and a tool run stores its own event file in it.
var migrationLog atomic.Pointer[EventLog]

// UseMigrationLog registers the event writer of this process for the records of the migration engine; a nil writer
// registers none.
func UseMigrationLog(log *EventLog) {
	migrationLog.Store(log)
}

// recordMigration stores the applied step as the event `log.migrated` through the event writer of this process. A migration
// happens once, at the install moment, so its record passes every gate like the events of the writer itself
// (docs/spec/logging.md#policy); a record the full queue refuses is counted as lost by the writer.
func recordMigration(file string, from, to int) {
	log := migrationLog.Load()
	if log == nil {
		return
	}
	fields, err := json.Marshal(map[string]any{"file": file, "from": from, "to": to})
	if err != nil {
		panic(fmt.Sprintf("the fields of log.migrated do not encode: %v", err))
	}
	log.enqueueWriterEvent(LevelInfo, "log.migrated", fields)
}
