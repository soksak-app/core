package host

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/soksak-app/core/packages/host/wailsv3/src/platform"
	sok "github.com/soksak-app/core/packages/sok/wailsv3/src"
	"github.com/wailsapp/wails/v3/pkg/application"
)

// The debug view lists, records and saves the diagnostic files of the application, which are all under
// <config-dir>/logs/ (docs/spec/debug.md).

// DebugFile is a file under <config-dir>/logs/: its path relative to the configuration folder, its size in bytes and
// its modification time in milliseconds since the epoch.
type DebugFile struct {
	Path     string `json:"path"`
	Size     int64  `json:"size"`
	Modified int64  `json:"modified"`
}

// debugCaptures writes a still capture of each window into logs/captures and returns their paths. Only a diagnostic
// build sets it, because the capture code exists only there.
var debugCaptures func(h *Host) ([]string, error)

// DebugFiles returns every file under <config-dir>/logs/, sorted by path.
func DebugFiles(configDir string) ([]DebugFile, error) {
	files := []DebugFile{}
	root := filepath.Join(configDir, "logs")
	err := filepath.WalkDir(root, func(full string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		relative, err := filepath.Rel(configDir, full)
		if err != nil {
			return err
		}
		files = append(files, DebugFile{Path: filepath.ToSlash(relative), Size: info.Size(), Modified: info.ModTime().UnixMilli()})
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("debug: list logs: %w", err)
	}
	sort.Slice(files, func(i, j int) bool { return files[i].Path < files[j].Path })
	return files, nil
}

// debugLogFile returns the full path of the file relative that is under <config-dir>/logs/, or an error that names it.
func debugLogFile(configDir, relative string) (string, error) {
	refused := fmt.Errorf("debug: %s is not a file under logs/", relative)
	clean := path.Clean(relative)
	if clean != relative || !strings.HasPrefix(clean, "logs/") {
		return "", refused
	}
	full := filepath.Join(configDir, filepath.FromSlash(clean))
	info, err := os.Stat(full)
	if err != nil || !info.Mode().IsRegular() {
		return "", refused
	}
	return full, nil
}

// DebugCopy copies the file relative under <config-dir>/logs/ to destination.
func DebugCopy(configDir, relative, destination string) error {
	source, err := debugLogFile(configDir, relative)
	if err != nil {
		return err
	}
	in, err := os.Open(source)
	if err != nil {
		return fmt.Errorf("debug: %s: %w", relative, err)
	}
	defer in.Close()
	out, err := os.Create(destination)
	if err != nil {
		return fmt.Errorf("debug: %s: %w", destination, err)
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return fmt.Errorf("debug: copy %s to %s: %w", relative, destination, err)
	}
	if err := out.Close(); err != nil {
		return fmt.Errorf("debug: %s: %w", destination, err)
	}
	return nil
}

// debugReadLimit is the number of bytes of the end of a file that DebugRead returns.
const debugReadLimit = 262144

// debugImageLimit is the largest PNG file that DebugRead returns, in bytes.
const debugImageLimit = 16 * 1024 * 1024

// debugPNGSignature starts every PNG file.
const debugPNGSignature = "\x89PNG\r\n\x1a\n"

// DebugReadResult is the answer of the debugRead call: the content of a text file, or its last debugReadLimit bytes
// from a character boundary with Truncated true, or the data address of a PNG file.
type DebugReadResult struct {
	Path      string `json:"path"`
	Size      int64  `json:"size"`
	Truncated bool   `json:"truncated"`
	Kind      string `json:"kind"`
	Text      string `json:"text"`
	Image     string `json:"image,omitempty"`
}

// DebugRead returns the end of the text file relative under <config-dir>/logs/. A file whose content is not UTF-8 text
// is refused with an error that names it.
func DebugRead(configDir, relative string) (DebugReadResult, error) {
	full, err := debugLogFile(configDir, relative)
	if err != nil {
		return DebugReadResult{}, err
	}
	file, err := os.Open(full)
	if err != nil {
		return DebugReadResult{}, fmt.Errorf("debug: %s: %w", relative, err)
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return DebugReadResult{}, fmt.Errorf("debug: %s: %w", relative, err)
	}
	size := info.Size()
	if strings.EqualFold(path.Ext(relative), ".png") {
		return debugReadImage(file, relative, size)
	}
	start := int64(0)
	if size > debugReadLimit {
		start = size - debugReadLimit
	}
	data := make([]byte, size-start)
	read, err := file.ReadAt(data, start)
	if err != nil && err != io.EOF {
		return DebugReadResult{}, fmt.Errorf("debug: %s: %w", relative, err)
	}
	data = data[:read]
	if start > 0 {
		// The cut may divide a character; the text starts at the next character boundary.
		for len(data) > 0 && !utf8.RuneStart(data[0]) {
			data = data[1:]
		}
	}
	if !utf8.Valid(data) || bytes.IndexByte(data, 0) >= 0 {
		return DebugReadResult{}, fmt.Errorf("debug: %s is not text", relative)
	}
	return DebugReadResult{Path: relative, Size: size, Truncated: start > 0, Kind: "text", Text: string(data)}, nil
}

// debugReadImage returns the PNG file as a data address.
func debugReadImage(file *os.File, relative string, size int64) (DebugReadResult, error) {
	if size > debugImageLimit {
		return DebugReadResult{}, fmt.Errorf("debug: %s is larger than 16 MB", relative)
	}
	data := make([]byte, size)
	if _, err := io.ReadFull(file, data); err != nil {
		return DebugReadResult{}, fmt.Errorf("debug: %s: %w", relative, err)
	}
	if !bytes.HasPrefix(data, []byte(debugPNGSignature)) {
		return DebugReadResult{}, fmt.Errorf("debug: %s is not a PNG file", relative)
	}
	return DebugReadResult{Path: relative, Size: size, Kind: "image", Image: "data:image/png;base64," + base64.StdEncoding.EncodeToString(data)}, nil
}

// DebugWriteLogsTar writes every file under <config-dir>/logs/ into a gzip-compressed tar file at destination, with
// the paths of DebugFiles.
func DebugWriteLogsTar(configDir, destination string) (err error) {
	files, err := DebugFiles(configDir)
	if err != nil {
		return err
	}
	out, err := os.Create(destination)
	if err != nil {
		return fmt.Errorf("debug: %s: %w", destination, err)
	}
	defer func() {
		if closeErr := out.Close(); err == nil && closeErr != nil {
			err = fmt.Errorf("debug: %s: %w", destination, closeErr)
		}
	}()
	compressed := gzip.NewWriter(out)
	writer := tar.NewWriter(compressed)
	for _, file := range files {
		if err := debugTarFile(writer, configDir, file); err != nil {
			return err
		}
	}
	if err := writer.Close(); err != nil {
		return fmt.Errorf("debug: %s: %w", destination, err)
	}
	if err := compressed.Close(); err != nil {
		return fmt.Errorf("debug: %s: %w", destination, err)
	}
	return nil
}

// debugTarFile writes one file of the logs folder into writer.
func debugTarFile(writer *tar.Writer, configDir string, file DebugFile) error {
	in, err := os.Open(filepath.Join(configDir, filepath.FromSlash(file.Path)))
	if err != nil {
		return fmt.Errorf("debug: %s: %w", file.Path, err)
	}
	defer in.Close()
	header := &tar.Header{Name: file.Path, Mode: 0o644, Size: file.Size, ModTime: time.UnixMilli(file.Modified), Typeflag: tar.TypeReg}
	if err := writer.WriteHeader(header); err != nil {
		return fmt.Errorf("debug: %s: %w", file.Path, err)
	}
	// A log that grows while the tar is written keeps the size of its header.
	if _, err := io.CopyN(writer, in, file.Size); err != nil {
		return fmt.Errorf("debug: %s: %w", file.Path, err)
	}
	return nil
}

// debugTime is the UTC time at in the form YYYYMMDDTHHMMSSZ.
func debugTime(at time.Time) string {
	return at.UTC().Format("20060102T150405Z")
}

// DebugWriteState writes state with its time into <config-dir>/logs/state-<time>.json and returns its path relative
// to the configuration folder.
func DebugWriteState(configDir string, at time.Time, state map[string]any) (string, error) {
	stamp := debugTime(at)
	record := map[string]any{"time": stamp}
	for key, value := range state {
		record[key] = value
	}
	data, err := json.MarshalIndent(record, "", "  ")
	if err != nil {
		return "", fmt.Errorf("debug: state: %w", err)
	}
	relative := "logs/state-" + stamp + ".json"
	full := filepath.Join(configDir, filepath.FromSlash(relative))
	if err := os.MkdirAll(filepath.Dir(full), 0o700); err != nil {
		return "", fmt.Errorf("debug: %s: %w", relative, err)
	}
	if err := os.WriteFile(full, data, 0o600); err != nil {
		return "", fmt.Errorf("debug: %s: %w", relative, err)
	}
	return relative, nil
}

// DebugRecordRequest is the argument of the debugRecord call: the status values that the page collected.
type DebugRecordRequest struct {
	Page json.RawMessage `json:"page"`
}

// DebugSaveRequest is the argument of the debugSave call.
type DebugSaveRequest struct {
	Path string `json:"path"`
}

// DebugSaved is the answer of debugSave and debugSaveAll: the chosen path, or nil when the person cancelled.
type DebugSaved struct {
	Saved *string `json:"saved"`
}

// DebugFiles is the page's debugFiles call.
func (h *Host) DebugFiles() ([]DebugFile, error) {
	return DebugFiles(h.configDir)
}

// DebugRead is the page's debugRead call.
func (h *Host) DebugRead(requestJSON json.RawMessage) (DebugReadResult, error) {
	request, err := argument[DebugSaveRequest]("request", requestJSON)
	if err != nil {
		return DebugReadResult{}, err
	}
	return DebugRead(h.configDir, request.Path)
}

// DebugRecord is the page's debugRecord call. It writes the state file of every window and, in a diagnostic build,
// a still capture of each window.
func (h *Host) DebugRecord(requestJSON json.RawMessage) (map[string]any, error) {
	request, err := argument[DebugRecordRequest]("request", requestJSON)
	if err != nil {
		return nil, err
	}
	backend := hostBackend{h}
	windows := []map[string]any{}
	for _, entry := range backend.Windows() {
		record := map[string]any{"entry": entry}
		for _, name := range []string{"host.window", "host.sidecars", "host.screens"} {
			value, err := backend.HostStatus(entry.Window, name)
			if err != nil {
				value = map[string]string{"error": err.Error()}
			}
			record[name] = value
		}
		windows = append(windows, record)
	}
	versions := map[string]any{"core": sok.CoreVersion}
	if system, err := platform.Current(); err != nil {
		versions["macos"] = map[string]string{"error": err.Error()}
	} else if version, err := system.OSVersion(); err != nil {
		versions["macos"] = map[string]string{"error": err.Error()}
	} else {
		versions["macos"] = version
	}
	if installed, err := os.ReadFile(filepath.Join(h.configDir, "plugins", "installed.json")); err != nil {
		versions["installed"] = map[string]string{"error": err.Error()}
	} else {
		versions["installed"] = json.RawMessage(installed)
	}
	path, err := DebugWriteState(h.configDir, time.Now(), map[string]any{
		"host": "wailsv3", "versions": versions, "windows": windows, "page": request.Page,
	})
	if err != nil {
		return nil, err
	}
	answer := map[string]any{"path": path}
	if debugCaptures != nil {
		captures, err := debugCaptures(h)
		if err != nil {
			return nil, fmt.Errorf("debug: captures: %w", err)
		}
		answer["captures"] = captures
	}
	return answer, nil
}

// debugSaveTo shows the save panel with name attached to the window of the call and returns the chosen path, or nil
// when the person cancelled.
func (h *Host) debugSaveTo(ctx context.Context, name string) (*string, error) {
	s, err := h.surface(ctx)
	if err != nil {
		return nil, err
	}
	chosen, err := application.Get().Dialog.SaveFile().SetFilename(name).AttachToWindow(s.window).PromptForSingleSelection()
	if err != nil {
		return nil, fmt.Errorf("debug: save panel: %w", err)
	}
	if chosen == "" {
		return nil, nil
	}
	return &chosen, nil
}

// DebugSave is the page's debugSave call: it saves one file of the logs folder where the person chooses.
func (h *Host) DebugSave(ctx context.Context, requestJSON json.RawMessage) (DebugSaved, error) {
	request, err := argument[DebugSaveRequest]("request", requestJSON)
	if err != nil {
		return DebugSaved{}, err
	}
	if _, err := debugLogFile(h.configDir, request.Path); err != nil {
		return DebugSaved{}, err
	}
	chosen, err := h.debugSaveTo(ctx, path.Base(request.Path))
	if err != nil || chosen == nil {
		return DebugSaved{}, err
	}
	if err := DebugCopy(h.configDir, request.Path, *chosen); err != nil {
		return DebugSaved{}, err
	}
	return DebugSaved{Saved: chosen}, nil
}

// DebugSaveAll is the page's debugSaveAll call: it saves the logs folder as one gzip-compressed tar file.
func (h *Host) DebugSaveAll(ctx context.Context) (DebugSaved, error) {
	chosen, err := h.debugSaveTo(ctx, "soksak-wailsv3-debug-"+debugTime(time.Now())+".tar.gz")
	if err != nil || chosen == nil {
		return DebugSaved{}, err
	}
	if err := DebugWriteLogsTar(h.configDir, *chosen); err != nil {
		return DebugSaved{}, err
	}
	return DebugSaved{Saved: chosen}, nil
}
