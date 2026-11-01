package support

// Writes a plugin release in the layout that `pnpm pack` writes (docs/spec/installation.md#plugin-release): a gzip tar
// with `package/package.json` and `package/<path>` for each file that `files` of `package.json` lists, named
// `<scope>-<name>-<version>.tgz` for the package `@<scope>/<name>`.

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// ReleaseEntry is one regular file of a release.
type ReleaseEntry struct {
	Name    string
	Content string
	Mode    int64
}

// PackPlugin writes the release of the plugin in dir into out and returns {release, sha256}.
func PackPlugin(t *testing.T, dir, out string) map[string]string {
	t.Helper()
	text, err := os.ReadFile(filepath.Join(dir, "package.json"))
	if err != nil {
		t.Fatal(err)
	}
	var pkg struct {
		Name    string   `json:"name"`
		Version string   `json:"version"`
		Files   []string `json:"files"`
	}
	if err := json.Unmarshal(text, &pkg); err != nil {
		t.Fatal(err)
	}
	paths := []string{"package.json"}
	for _, listed := range pkg.Files {
		err := filepath.WalkDir(filepath.Join(dir, listed), func(path string, entry fs.DirEntry, err error) error {
			if err != nil || entry.IsDir() {
				return err
			}
			relative, err := filepath.Rel(dir, path)
			paths = append(paths, filepath.ToSlash(relative))
			return err
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	var entries []ReleaseEntry
	for _, path := range paths {
		info, err := os.Stat(filepath.Join(dir, path))
		if err != nil {
			t.Fatal(err)
		}
		content, err := os.ReadFile(filepath.Join(dir, path))
		if err != nil {
			t.Fatal(err)
		}
		entries = append(entries, ReleaseEntry{Name: "package/" + path, Content: string(content), Mode: int64(info.Mode().Perm())})
	}
	release := filepath.Join(out, strings.ReplaceAll(strings.TrimPrefix(pkg.Name, "@"), "/", "-")+"-"+pkg.Version+".tgz")
	sum := WriteRelease(t, release, entries)
	return map[string]string{"release": release, "sha256": sum}
}

// WriteRelease writes a gzip tar at path with each entry as a regular file and returns its sha256.
func WriteRelease(t *testing.T, path string, entries []ReleaseEntry) string {
	t.Helper()
	var data bytes.Buffer
	zipped := gzip.NewWriter(&data)
	release := tar.NewWriter(zipped)
	for _, entry := range entries {
		header := &tar.Header{Typeflag: tar.TypeReg, Name: entry.Name, Mode: entry.Mode, Size: int64(len(entry.Content))}
		if err := release.WriteHeader(header); err != nil {
			t.Fatal(err)
		}
		if _, err := release.Write([]byte(entry.Content)); err != nil {
			t.Fatal(err)
		}
	}
	if err := release.Close(); err != nil {
		t.Fatal(err)
	}
	if err := zipped.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(data.Bytes())
	return hex.EncodeToString(sum[:])
}
