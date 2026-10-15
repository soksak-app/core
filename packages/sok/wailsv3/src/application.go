package sok

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"slices"
	"strings"

	"github.com/soksak-app/core/packages/sok/wailsv3/src/platform"
)

// Located is an installed application that a locate entry found: its executable and the kind of the entry
// (docs/spec/installation.md#applications).
type Located struct {
	Path   string
	Method string
}

// LocateApplication tries each locate entry in order and returns the first application it finds: a bundle identifier
// through the metadata index of the platform, a name on the search path, or an absolute path of an executable file. The
// program, a path inside the installed folder, gives the executable of a found bundle. An entry that finds nothing
// passes to the next one; a failure of the platform is an error.
func LocateApplication(ways []map[string]string, program, search string) (Located, bool, error) {
	for index, way := range ways {
		switch {
		case way["bundle"] != "":
			current, err := platform.Current()
			if err != nil {
				return Located{}, false, fmt.Errorf("locate entry %d: %w", index, err)
			}
			bundle, found, err := current.ApplicationOfBundle(way["bundle"])
			if err != nil {
				return Located{}, false, fmt.Errorf("locate entry %d: %w", index, err)
			}
			if found {
				// The installed folder holds the bundle, so the program names the executable from the parent of the bundle.
				path := filepath.Join(filepath.Dir(bundle), program)
				if executableFile(path) {
					return Located{Path: path, Method: "bundle"}, true, nil
				}
			}
		case way["command"] != "":
			if path, ok := lookPath(way["command"], search); ok {
				return Located{Path: path, Method: "command"}, true, nil
			}
		case way["path"] != "":
			if executableFile(way["path"]) {
				return Located{Path: way["path"], Method: "path"}, true, nil
			}
		default:
			return Located{}, false, fmt.Errorf("locate entry %d is not one of bundle, command or path", index)
		}
	}
	return Located{}, false, nil
}

// lookPath finds an executable of the name in the folders of the search path. exec.LookPath reads PATH of the process
// and takes no search path, so the installer, which passes PATH, and the tests, which pass their own folders, use this.
func lookPath(name, search string) (string, bool) {
	for _, folder := range filepath.SplitList(search) {
		if folder == "" {
			continue
		}
		path := filepath.Join(folder, name)
		if executableFile(path) {
			return path, true
		}
	}
	return "", false
}

// executableFile reports whether the path is a regular file with an execute bit.
func executableFile(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.Mode().IsRegular() && info.Mode().Perm()&0o111 != 0
}

// InstallApplicationRelease installs the application of a release recipe into the folder target, which does not exist
// yet: it downloads the release with the release limit of the fetcher, compares its SHA-256, and unpacks a zip with the
// bundle extraction of the platform, a tar.gz with its folders, files and symbolic links that stay inside the folder, or
// keeps the file as one executable named after the last segment of the address. A step that fails removes what it wrote
// and returns an error that names the step.
func InstallApplicationRelease(fetcher Fetcher, recipe map[string]string, target string) (err error) {
	address := recipe["url"]
	if err := CheckLocation(address); err != nil || !strings.HasPrefix(address, "https://") {
		return fmt.Errorf("application release %s: the address is not an https address", address)
	}
	data, err := fetcher.Read(address, fetcher.Release)
	if err != nil {
		return fmt.Errorf("application release download: %w", err)
	}
	digest := sha256.Sum256(data)
	if got := hex.EncodeToString(digest[:]); got != recipe["sha256"] {
		return fmt.Errorf("application release %s: sha256 %s is not %s", address, got, recipe["sha256"])
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return fileError(filepath.Dir(target), err)
	}
	if _, err := os.Lstat(target); err == nil {
		return fmt.Errorf("application release: %s exists", target)
	}
	temp, err := os.MkdirTemp(filepath.Dir(target), "."+filepath.Base(target)+".*")
	if err != nil {
		return fileError(filepath.Dir(target), err)
	}
	defer func() {
		if err != nil {
			err = withCleanup(err, temp, os.RemoveAll)
		}
	}()
	switch recipe["unpack"] {
	case "zip":
		err = unpackZip(data, temp)
	case "tar.gz":
		err = unpackApplicationTar(data, temp)
	case "none":
		name, nameErr := fileOf(address)
		if nameErr != nil {
			return nameErr
		}
		err = os.WriteFile(filepath.Join(temp, name), data, 0o755)
		if err == nil {
			err = os.Chmod(filepath.Join(temp, name), 0o755)
		}
	default:
		err = fmt.Errorf("unpack %q is not zip, tar.gz or none", recipe["unpack"])
	}
	if err != nil {
		return fmt.Errorf("application release unpack: %w", err)
	}
	if err := os.Rename(temp, target); err != nil {
		return fileError(target, err)
	}
	return nil
}

// unpackZip writes the zip next to the folder and extracts it with the bundle extraction of the platform, which keeps
// the modes, the symbolic links and the signature of an application bundle.
func unpackZip(data []byte, folder string) (err error) {
	file, err := os.CreateTemp(filepath.Dir(folder), ".release-*.zip")
	if err != nil {
		return fileError(filepath.Dir(folder), err)
	}
	defer func() {
		if removeErr := os.Remove(file.Name()); removeErr != nil && err == nil {
			err = fileError(file.Name(), removeErr)
		}
	}()
	if _, err := file.Write(data); err != nil {
		file.Close()
		return fileError(file.Name(), err)
	}
	if err := file.Close(); err != nil {
		return fileError(file.Name(), err)
	}
	current, err := platform.Current()
	if err != nil {
		return err
	}
	return current.ExtractBundle(file.Name(), folder)
}

// unpackApplicationTar extracts folders, regular files and symbolic links whose target stays inside the folder. An
// application release, unlike a plugin release, holds the symbolic links of its bundle.
func unpackApplicationTar(data []byte, folder string) error {
	zipped, err := gzip.NewReader(bytes.NewReader(data))
	if err != nil {
		return err
	}
	reader := tar.NewReader(zipped)
	for {
		header, err := reader.Next()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return err
		}
		name := strings.TrimSuffix(header.Name, "/")
		if name == "" || strings.HasPrefix(name, "/") || slices.Contains(strings.Split(name, "/"), "..") {
			return fmt.Errorf("release entry %s leaves the folder", header.Name)
		}
		where := filepath.Join(folder, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(where), 0o755); err != nil {
			return fileError(filepath.Dir(where), err)
		}
		switch header.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(where, 0o755); err != nil {
				return fileError(where, err)
			}
		case tar.TypeReg:
			mode := os.FileMode(0o644)
			if header.Mode&0o111 != 0 {
				mode = 0o755
			}
			file, err := os.OpenFile(where, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
			if err != nil {
				return fileError(where, err)
			}
			err = file.Chmod(mode)
			if err == nil {
				_, err = io.Copy(file, reader)
			}
			if closeErr := file.Close(); err == nil {
				err = closeErr
			}
			if err != nil {
				return fileError(where, err)
			}
		case tar.TypeSymlink:
			resolved := path.Clean(path.Join(path.Dir(name), header.Linkname))
			if path.IsAbs(header.Linkname) || resolved == ".." || strings.HasPrefix(resolved, "../") {
				return fmt.Errorf("release entry %s links outside the folder", name)
			}
			if err := os.Symlink(header.Linkname, where); err != nil {
				return fileError(where, err)
			}
		default:
			return fmt.Errorf("release entry %s is neither a folder, a regular file nor a symbolic link", header.Name)
		}
	}
}

// CheckApplicationPackage asks the package manager, found on the search path, whether it has the package of a package
// recipe as a cask or as a formula, as the recipe declares, before anything is installed. brew answers through
// `brew info --json=v2`; a package that brew does not know, or knows as the other kind, is an error that names it.
func CheckApplicationPackage(manager, name string, cask bool, search string) error {
	program, err := packageManager(manager, search)
	if err != nil {
		return err
	}
	kind, list := "--formula", "formulae"
	if cask {
		kind, list = "--cask", "casks"
	}
	output, err := runStep("application package "+manager+" info "+kind+" "+name, "", search, nil, program, "info", "--json=v2", kind, name)
	if err != nil {
		return err
	}
	var answer map[string][]map[string]any
	if err := json.Unmarshal([]byte(output), &answer); err != nil {
		return fmt.Errorf("application package %s info %s %s: the answer is not JSON: %w", manager, kind, name, err)
	}
	if len(answer[list]) != 1 {
		return fmt.Errorf("application package %s has %d %s named %s", manager, len(answer[list]), list, name)
	}
	return nil
}

// InstallApplicationPackage installs the package of a package recipe with its manager, found on the search path, as a
// cask or as a formula. Where the application is afterwards is found by the locate entries of the application, not
// guessed from the manager.
func InstallApplicationPackage(manager, name string, cask bool, search string) error {
	program, err := packageManager(manager, search)
	if err != nil {
		return err
	}
	arguments := []string{"install"}
	if cask {
		arguments = append(arguments, "--cask")
	}
	arguments = append(arguments, name)
	_, err = runStep("application package "+manager+" "+strings.Join(arguments, " "), "", search, nil, program, arguments...)
	return err
}

// packageManager is the executable of the manager on the search path; brew is the one manager of the specification.
func packageManager(manager, search string) (string, error) {
	if manager != "brew" {
		return "", fmt.Errorf("application package manager %q is not brew", manager)
	}
	program, found := lookPath(manager, search)
	if !found {
		return "", fmt.Errorf("application package: %s is not on the search path", manager)
	}
	return program, nil
}

// InstallApplicationSource clones the repository of a source recipe at the ref into the folder target, which does not
// exist yet, and runs each command in it with the search path and the environment entries ("KEY=value"); the clone is the
// installed folder. A step that fails
// removes the folder and returns an error that names the step with its output.
func InstallApplicationSource(repository, ref string, commands [][]string, target, search string, environment []string) (err error) {
	if err := CheckLocation(repository); err != nil || !strings.HasPrefix(repository, "https://") {
		return fmt.Errorf("application source %s: the repository is not an https address", repository)
	}
	if _, err := os.Lstat(target); err == nil {
		return fmt.Errorf("application source: %s exists", target)
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return fileError(filepath.Dir(target), err)
	}
	git, found := lookPath("git", search)
	if !found {
		return errors.New("application source: git is not on the search path")
	}
	temp, err := os.MkdirTemp(filepath.Dir(target), "."+filepath.Base(target)+".*")
	if err != nil {
		return fileError(filepath.Dir(target), err)
	}
	defer func() {
		if err != nil {
			err = withCleanup(err, temp, os.RemoveAll)
		}
	}()
	if _, err := runStep("application source clone "+repository, "", search, environment, git, "clone", "--quiet", repository, temp); err != nil {
		return err
	}
	if _, err := runStep("application source checkout "+ref, temp, search, environment, git, "checkout", "--quiet", ref); err != nil {
		return err
	}
	for _, command := range commands {
		program, ok := lookPath(command[0], search)
		if !ok {
			if inside := filepath.Join(temp, command[0]); executableFile(inside) {
				program, ok = inside, true
			}
		}
		if !ok {
			return fmt.Errorf("application source command %s: %s is not on the search path or in the clone", strings.Join(command, " "), command[0])
		}
		if _, err := runStep("application source command "+strings.Join(command, " "), temp, search, environment, program, command[1:]...); err != nil {
			return err
		}
	}
	if err := os.Rename(temp, target); err != nil {
		return fileError(target, err)
	}
	return nil
}

// runStep runs one program of a recipe in the folder with PATH set to the search path and the environment entries, and
// returns its standard output;
// a failure names the step with the exit and the last kilobyte of the combined output.
func runStep(step, folder, search string, environment []string, program string, arguments ...string) (string, error) {
	command := exec.Command(program, arguments...)
	command.Dir = folder
	command.Env = append(append(os.Environ(), "PATH="+search), environment...)
	var stdout, combined bytes.Buffer
	command.Stdout = io.MultiWriter(&stdout, &combined)
	command.Stderr = &combined
	if err := command.Run(); err != nil {
		output := combined.String()
		if len(output) > 1024 {
			output = output[len(output)-1024:]
		}
		return "", fmt.Errorf("%s: %v: %s", step, err, strings.TrimSpace(output))
	}
	return stdout.String(), nil
}

// Applications is the place of the record of connected applications inside the configuration directory.
const Applications = "plugins/applications.json"

// ApplicationRecord is one connected application: its version, its executable, located or installed, and the locate kind
// or recipe kind that gave it (docs/spec/installation.md#applications).
type ApplicationRecord struct {
	Version string `json:"version"`
	Path    string `json:"path"`
	How     string `json:"how"`
	Method  string `json:"method"`
}

// ApplicationsState is plugins/applications.json.
type ApplicationsState struct {
	Format       int                          `json:"format"`
	Applications map[string]ApplicationRecord `json:"applications"`
}

// ReadApplications reads plugins/applications.json; an absent file is an empty record, and another form is an error that
// names the file and what it found.
func ReadApplications(configDir string) (*ApplicationsState, error) {
	path := filepath.Join(configDir, Applications)
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return &ApplicationsState{Format: 1, Applications: map[string]ApplicationRecord{}}, nil
	}
	if err != nil {
		return nil, fileError(path, err)
	}
	value, err := DecodeJSON(data)
	if err != nil {
		return nil, fmt.Errorf("%s is not valid JSON: %w", path, err)
	}
	state, err := validateApplications(value)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	return state, nil
}

func validateApplications(value any) (*ApplicationsState, error) {
	root, err := object("applications.json", value)
	if err != nil {
		return nil, err
	}
	if err := only("applications.json", root, "format", "applications"); err != nil {
		return nil, err
	}
	if !isOne(root["format"]) {
		return nil, fmt.Errorf("format must be 1, not %s", quote(root["format"]))
	}
	entries, err := object("applications", root["applications"])
	if err != nil {
		return nil, err
	}
	state := &ApplicationsState{Format: 1, Applications: map[string]ApplicationRecord{}}
	for _, id := range sortedKeys(entries) {
		entry, err := object("application "+id, entries[id])
		if err != nil {
			return nil, err
		}
		if err := only("application "+id, entry, "version", "path", "how", "method"); err != nil {
			return nil, err
		}
		record := ApplicationRecord{}
		var ok bool
		if record.Version, ok = text(entry["version"]); !ok {
			return nil, fmt.Errorf("application %s version must be text", id)
		}
		if record.Path, ok = text(entry["path"]); !ok || !filepath.IsAbs(record.Path) {
			return nil, fmt.Errorf("application %s path must be an absolute path", id)
		}
		if record.How, ok = text(entry["how"]); !ok || (record.How != "located" && record.How != "installed") {
			return nil, fmt.Errorf("application %s how must be located or installed, not %s", id, quote(entry["how"]))
		}
		if record.Method, ok = text(entry["method"]); !ok {
			return nil, fmt.Errorf("application %s method must be text", id)
		}
		state.Applications[id] = record
	}
	return state, nil
}

// RecordApplication writes the application into plugins/applications.json in one step.
func RecordApplication(configDir, id string, record ApplicationRecord) error {
	state, err := ReadApplications(configDir)
	if err != nil {
		return err
	}
	state.Applications[id] = record
	return writeApplications(configDir, state)
}

// RemoveApplication deletes the folder of an installed application and its entry, and only the entry of a located one; an
// application without an entry is nothing to remove.
func RemoveApplication(configDir, id string) error {
	state, err := ReadApplications(configDir)
	if err != nil {
		return err
	}
	record, found := state.Applications[id]
	if !found {
		return nil
	}
	if record.How == "installed" {
		folder := filepath.Join(configDir, "applications", id)
		if err := os.RemoveAll(folder); err != nil {
			return fileError(folder, err)
		}
	}
	delete(state.Applications, id)
	return writeApplications(configDir, state)
}

func writeApplications(configDir string, state *ApplicationsState) error {
	var out bytes.Buffer
	if err := printJSON(&out, state); err != nil {
		return err
	}
	path := filepath.Join(configDir, Applications)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return fileError(filepath.Dir(path), err)
	}
	return replaceFile(path, out.Bytes())
}

// installedApplication reads the application that the plugin.json in the folder of an installed plugin declares; a
// plugin without one has none.
func installedApplication(configDir, folder string) (map[string]any, bool, error) {
	file := filepath.Join(configDir, folder, "plugin.json")
	data, err := os.ReadFile(file)
	if err != nil {
		return nil, false, fileError(file, err)
	}
	value, err := DecodeJSON(data)
	if err != nil {
		return nil, false, fmt.Errorf("%s is not valid JSON: %w", file, err)
	}
	manifest, err := object("plugin.json", value)
	if err != nil {
		return nil, false, fmt.Errorf("%s: %w", file, err)
	}
	if manifest["application"] == nil {
		return nil, false, nil
	}
	application, err := object(file+" application", manifest["application"])
	return application, err == nil, err
}

// ConnectApplication connects the application of a connector plugin on the platform: an application that a locate entry
// finds is recorded as located, and otherwise the recipe installs it and the place it gives is recorded as installed
// (docs/spec/installation.md#applications). search is PATH, for the locate entries and the programs of the recipes.
func ConnectApplication(configDir, platform string, application map[string]any, search string) error {
	id, err := field("application", application, "id")
	if err != nil {
		return err
	}
	version, err := field("application "+id, application, "version")
	if err != nil {
		return err
	}
	platforms, err := object("application "+id+" platforms", application["platforms"])
	if err != nil {
		return err
	}
	if platforms[platform] == nil {
		return fmt.Errorf("application %s does not support %s", id, platform)
	}
	entry, err := object("application "+id+" "+platform, platforms[platform])
	if err != nil {
		return err
	}
	program, err := field("application "+id+" "+platform, entry, "program")
	if err != nil {
		return err
	}
	ways, err := locateWays(id, entry["locate"])
	if err != nil {
		return err
	}
	located, found, err := LocateApplication(ways, program, search)
	if err != nil {
		return fmt.Errorf("application %s: %w", id, err)
	}
	if found {
		return RecordApplication(configDir, id, ApplicationRecord{Version: version, Path: located.Path, How: "located", Method: located.Method})
	}
	recipe, err := object("application "+id+" recipe", entry["recipe"])
	if err != nil {
		return err
	}
	kind, err := field("application "+id+" recipe", recipe, "kind")
	if err != nil {
		return err
	}
	target := filepath.Join(configDir, "applications", id, version)
	switch kind {
	case "release":
		fields := map[string]string{}
		for _, key := range []string{"kind", "url", "sha256", "unpack"} {
			if fields[key], err = field("application "+id+" recipe", recipe, key); err != nil {
				return err
			}
		}
		if err := InstallApplicationRelease(DefaultFetcher, fields, target); err != nil {
			return fmt.Errorf("application %s: %w", id, err)
		}
	case "source":
		repository, err := field("application "+id+" recipe", recipe, "repository")
		if err != nil {
			return err
		}
		ref, err := field("application "+id+" recipe", recipe, "ref")
		if err != nil {
			return err
		}
		commands, err := commandList(id, recipe["commands"])
		if err != nil {
			return err
		}
		if err := InstallApplicationSource(repository, ref, commands, target, search, nil); err != nil {
			return fmt.Errorf("application %s: %w", id, err)
		}
	case "package":
		manager, err := field("application "+id+" recipe", recipe, "manager")
		if err != nil {
			return err
		}
		name, err := field("application "+id+" recipe", recipe, "name")
		if err != nil {
			return err
		}
		cask, ok := recipe["cask"].(bool)
		if !ok {
			return fmt.Errorf("application %s recipe cask must be true or false", id)
		}
		if err := CheckApplicationPackage(manager, name, cask, search); err != nil {
			return fmt.Errorf("application %s: %w", id, err)
		}
		if err := InstallApplicationPackage(manager, name, cask, search); err != nil {
			return fmt.Errorf("application %s: %w", id, err)
		}
		// The manager decides where the application goes, so the locate entries give its place.
		located, found, err := LocateApplication(ways, program, search)
		if err != nil {
			return fmt.Errorf("application %s: %w", id, err)
		}
		if !found {
			return fmt.Errorf("application %s: the package %s is installed, and no locate entry finds the application", id, name)
		}
		return RecordApplication(configDir, id, ApplicationRecord{Version: version, Path: located.Path, How: "installed", Method: "package"})
	default:
		return fmt.Errorf("application %s recipe kind %q is not release, package or source", id, kind)
	}
	executable := filepath.Join(target, filepath.FromSlash(program))
	if !executableFile(executable) {
		return withCleanup(fmt.Errorf("application %s: the recipe installed no executable %s", id, program), filepath.Join(configDir, "applications", id), os.RemoveAll)
	}
	return RecordApplication(configDir, id, ApplicationRecord{Version: version, Path: executable, How: "installed", Method: kind})
}

func locateWays(id string, value any) ([]map[string]string, error) {
	list, err := array("application "+id+" locate", value)
	if err != nil {
		return nil, err
	}
	ways := make([]map[string]string, 0, len(list))
	for index, item := range list {
		way, err := object(fmt.Sprintf("application %s locate entry %d", id, index), item)
		if err != nil {
			return nil, err
		}
		fields := map[string]string{}
		for key := range way {
			if fields[key], err = field(fmt.Sprintf("application %s locate entry %d", id, index), way, key); err != nil {
				return nil, err
			}
		}
		ways = append(ways, fields)
	}
	return ways, nil
}

func commandList(id string, value any) ([][]string, error) {
	list, err := array("application "+id+" commands", value)
	if err != nil {
		return nil, err
	}
	commands := make([][]string, 0, len(list))
	for index, item := range list {
		parts, err := array(fmt.Sprintf("application %s command %d", id, index), item)
		if err != nil {
			return nil, err
		}
		command := make([]string, 0, len(parts))
		for _, part := range parts {
			word, ok := text(part)
			if !ok {
				return nil, fmt.Errorf("application %s command %d holds a part that is not text", id, index)
			}
			command = append(command, word)
		}
		commands = append(commands, command)
	}
	return commands, nil
}

// field is the text of the key of a declaration; a missing or empty value is an error that names the key.
func field(where string, declaration map[string]any, key string) (string, error) {
	value, ok := text(declaration[key])
	if !ok {
		return "", fmt.Errorf("%s %s must be text, not %s", where, key, quote(declaration[key]))
	}
	return value, nil
}

// fileOf is the last segment of the path of an address, without its query; an address whose path ends without a segment
// names no file and is an error.
func fileOf(address string) (string, error) {
	// silent: the query and whether the address has one do not name the file.
	location, _, _ := strings.Cut(address, "?")
	slash := strings.LastIndex(location, "/")
	if slash < 0 || slash == len(location)-1 {
		return "", fmt.Errorf("application release %s: the address names no file", address)
	}
	return location[slash+1:], nil
}
