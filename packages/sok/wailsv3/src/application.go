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
		name := path.Base(strings.SplitN(address, "?", 2)[0])
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
