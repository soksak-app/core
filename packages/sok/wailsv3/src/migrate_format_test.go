package sok

import (
	"testing"
	"testing/fstest"
)

// A format number cannot be read when the definitions cannot be read: the error reaches the caller, so no format number is written
// for a file whose definitions are missing.
func TestAFormatWithoutReadableDefinitionsIsAnError(t *testing.T) {
	saved := definitionSource
	definitionSource = fstest.MapFS{}
	t.Cleanup(func() { definitionSource = saved })
	if format, err := ProjectsFormat(); err == nil {
		t.Fatalf("ProjectsFormat returned %d without an error for missing definitions", format)
	}
	if format, err := SettingsFormat(); err == nil {
		t.Fatalf("SettingsFormat returned %d without an error for missing definitions", format)
	}
}

// A file without a chain has no current format, so its format is an error and no number is stamped.
func TestAFileWithoutAChainHasNoFormat(t *testing.T) {
	if format, err := formatOf("no-such-file.json"); err == nil {
		t.Fatalf("formatOf returned %d without an error for a file without a chain", format)
	}
}
