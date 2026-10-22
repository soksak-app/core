package sok

// The formats of installable plugins (docs/spec/installation.md): versions and ranges, the plugin file, the
// registry index, the sidecar release, the installed layout and the installed state. A wrong format returns an
// error that names what is wrong. Fields are checked in a fixed order, so both implementations return the same error
// when several fields are wrong.

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"slices"
	"strconv"
	"strings"
	"unicode/utf8"

	semver "github.com/Masterminds/semver/v3"
)

// InstallFormat is the format number of the registry index.
const InstallFormat = 1

// Installed is the file that holds the installation state inside the configuration directory.
const Installed = "plugins/installed.json"

// InstalledFormat is the format number of the installation state file. Format 2 records the installation folder as a
// path relative to the configuration directory.
const InstalledFormat = 3

// Platforms are the platform keys (`<os>-<arch>`) of sidecar releases.
var Platforms = []string{"darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "windows-arm64", "windows-x64"}

const descriptionMax = 200

// maxPart is the largest part of a version (docs/spec/installation.md: a version part is at most 4294967295).
const maxPart = math.MaxUint32

// quote writes the value as JSON text. It shows a value taken from an error text unchanged.
func quote(value any) string {
	var out bytes.Buffer
	encoder := json.NewEncoder(&out)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return fmt.Sprint(value)
	}
	return strings.TrimSuffix(out.String(), "\n")
}

// ParseVersion reads an `x.y.z` version with the library. The library reads the text; the specification forms that
// it accepts beyond `x.y.z` are refused here: a pre-release, build metadata, a `v` prefix, a leading zero, another
// number of parts and a part above 4294967295. A refused text reports the same error for each of them.
func ParseVersion(text string) (*semver.Version, error) {
	v, err := semver.StrictNewVersion(text)
	if err != nil || v.Prerelease() != "" || v.Metadata() != "" || v.String() != text ||
		v.Major() > maxPart || v.Minor() > maxPart || v.Patch() > maxPart {
		return nil, fmt.Errorf("invalid version %s: expected x.y.z", quote(text))
	}
	return v, nil
}

// Range is the inclusive lower bound Min and the exclusive upper bound Below. When Below is nil, there is no upper
// bound. The bounds are the forms of docs/spec/installation.md, and the versions are compared with the library.
type Range struct {
	Min   *semver.Version
	Below *semver.Version
}

// Contains reports whether v is inside the range.
func (r Range) Contains(v *semver.Version) bool {
	return v.Compare(r.Min) >= 0 && (r.Below == nil || v.Compare(r.Below) < 0)
}

// ParseRange reads the ranges `*`, `x.y.z`, `^x.y.z`, `~x.y.z`, `>=x.y.z` and `>=x.y.z <a.b.c`. `*` is `>=0.0.0`, that
// is, every version. The forms are matched here before the versions of a form are read by ParseVersion.
func ParseRange(text string) (Range, error) {
	if text == "*" {
		return Range{Min: semver.New(0, 0, 0, "", "")}, nil
	}
	if rest, ok := strings.CutPrefix(text, ">="); ok {
		low, high, found := strings.Cut(rest, " <")
		if found && !strings.ContainsAny(low, " ") && !strings.ContainsAny(high, " ") && low != "" && high != "" {
			min, err := ParseVersion(low)
			if err != nil {
				return Range{}, err
			}
			below, err := ParseVersion(high)
			if err != nil {
				return Range{}, err
			}
			if min.Compare(below) >= 0 {
				return Range{}, fmt.Errorf("invalid version range %s: empty", text)
			}
			return Range{min, below}, nil
		}
		// >=x.y.z has only a lower bound and no upper bound.
		if !found && rest != "" && !strings.ContainsAny(rest, " ") {
			if min, err := ParseVersion(rest); err == nil {
				return Range{Min: min}, nil
			}
		}
	}
	operator := ""
	if strings.HasPrefix(text, "^") || strings.HasPrefix(text, "~") {
		operator = text[:1]
	}
	v, err := ParseVersion(text[len(operator):])
	if err != nil {
		return Range{}, fmt.Errorf("invalid version range %s: expected *, x.y.z, ^x.y.z, ~x.y.z, >=x.y.z or >=x.y.z <a.b.c", quote(text))
	}
	major, minor, patch := v.Major(), v.Minor(), v.Patch()
	var below *semver.Version
	switch {
	case operator == "":
		below = semver.New(major, minor, patch+1, "", "")
	case operator == "~":
		below = semver.New(major, minor+1, 0, "", "")
	case major > 0:
		below = semver.New(major+1, 0, 0, "", "")
	case minor > 0:
		below = semver.New(0, minor+1, 0, "", "")
	default:
		below = semver.New(0, 0, patch+1, "", "")
	}
	return Range{v, below}, nil
}

// Satisfies reports whether the version is inside the range. Both must be values that were already checked.
func Satisfies(version, rng string) bool {
	v, err := ParseVersion(version)
	if err != nil {
		return false
	}
	r, err := ParseRange(rng)
	return err == nil && r.Contains(v)
}

// isIdentifier reports whether the name starts with a lowercase letter and uses only lowercase letters, digits and -.
func isIdentifier(text string) bool {
	if text == "" || text[0] < 'a' || text[0] > 'z' {
		return false
	}
	return isLowerWord(text)
}

func isLowerWord(text string) bool {
	if text == "" {
		return false
	}
	for _, c := range text {
		if !(c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '-') {
			return false
		}
	}
	return true
}

// isPackageJSONName reports whether text has the form of the name of a package.json, `name` or `@scope/name`.
func isPackageJSONName(text string) bool {
	if scoped, ok := strings.CutPrefix(text, "@"); ok {
		scope, name, found := strings.Cut(scoped, "/")
		return found && isLowerWord(scope) && isLowerWord(name)
	}
	return isLowerWord(text)
}

func isSHA256(text string) bool {
	if len(text) != 64 {
		return false
	}
	for _, c := range text {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}

// DecodeJSON reads JSON text into the value that the format check uses. Numbers keep their original text.
func DecodeJSON(data []byte) (any, error) {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return nil, err
	}
	if decoder.More() {
		return nil, fmt.Errorf("unexpected data after the JSON value")
	}
	return value, nil
}

func object(where string, value any) (map[string]any, error) {
	m, ok := value.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("%s: expected an object", where)
	}
	return m, nil
}

func array(where string, value any) ([]any, error) {
	a, ok := value.([]any)
	if !ok {
		return nil, fmt.Errorf("%s: expected an array", where)
	}
	return a, nil
}

func sortedKeys(m map[string]any) []string {
	keys := make([]string, 0, len(m))
	for key := range m {
		keys = append(keys, key)
	}
	slices.Sort(keys)
	return keys
}

func only(where string, m map[string]any, keys ...string) error {
	for _, key := range sortedKeys(m) {
		if !slices.Contains(keys, key) {
			return fmt.Errorf("%s: unknown field %s", where, key)
		}
	}
	return nil
}

func text(value any) (string, bool) {
	s, ok := value.(string)
	return s, ok && s != ""
}

func isOne(value any) bool {
	n, ok := value.(json.Number)
	return ok && n.String() == "1"
}

func checkVersion(where string, value any) error {
	s, ok := value.(string)
	if !ok {
		return fmt.Errorf("%s: invalid version %s: expected x.y.z", where, quote(value))
	}
	if _, err := ParseVersion(s); err != nil {
		return fmt.Errorf("%s: %w", where, err)
	}
	return nil
}

// checkedVersion is a version string that passed checkVersion.
func checkedVersion(where string, value any) (string, error) {
	if err := checkVersion(where, value); err != nil {
		return "", err
	}
	return value.(string), nil
}

func checkRange(where string, value any) error {
	s, ok := value.(string)
	if !ok {
		return fmt.Errorf("%s: invalid version range %s", where, quote(value))
	}
	if _, err := ParseRange(s); err != nil {
		return fmt.Errorf("%s: %w", where, err)
	}
	return nil
}

func checkPackageJSONName(where string, value any) error {
	if s, ok := text(value); !ok || !isPackageJSONName(s) {
		return fmt.Errorf("%s: expected a package.json name", where)
	}
	return nil
}

func checkSidecarRanges(where string, value any) error {
	m, err := object(where, value)
	if err != nil {
		return err
	}
	for _, name := range sortedKeys(m) {
		if err := checkPackageJSONName(where+" "+name, name); err != nil {
			return err
		}
		if err := checkRange(where+" "+name, m[name]); err != nil {
			return err
		}
	}
	return nil
}

// FilePath is the local path of an absolute `file:` URL. %XX is read as that byte.
func FilePath(url string) (string, error) {
	rest, ok := strings.CutPrefix(url, "file://")
	if !ok || !strings.HasPrefix(rest, "/") {
		return "", fmt.Errorf("url must be an absolute file: URL")
	}
	if strings.ContainsAny(rest, "?#") {
		return "", fmt.Errorf("url must be an absolute file: URL without a query or fragment")
	}
	var path strings.Builder
	for i := 0; i < len(rest); i++ {
		if rest[i] != '%' {
			path.WriteByte(rest[i])
			continue
		}
		if i+2 >= len(rest) {
			return "", fmt.Errorf("url has an invalid escape")
		}
		b, err := strconv.ParseUint(rest[i+1:i+3], 16, 8)
		if err != nil {
			return "", fmt.Errorf("url has an invalid escape")
		}
		path.WriteByte(byte(b))
		i += 2
	}
	return path.String(), nil
}

func checkReleaseEntry(where string, value any) error {
	m, err := object(where, value)
	if err != nil {
		return err
	}
	if err := only(where, m, "sha256", "url"); err != nil {
		return err
	}
	if sha, ok := m["sha256"].(string); !ok || !isSHA256(sha) {
		return fmt.Errorf("%s: sha256 must be 64 lowercase hexadecimal digits", where)
	}
	url, ok := m["url"].(string)
	if !ok {
		return fmt.Errorf("%s: url must be an https: or absolute file: URL", where)
	}
	if err := CheckLocation(url); err != nil {
		return fmt.Errorf("%s: %w", where, err)
	}
	return nil
}

func checkDescription(where string, value any) error {
	s, ok := text(value)
	if !ok || utf8.RuneCountInString(s) > descriptionMax {
		return fmt.Errorf("%s: description must be 1 to %d characters", where, descriptionMax)
	}
	return nil
}

// ValidatePackageJSON checks the fields of the package.json of a plugin that installation uses. Other npm
// fields belong to the package tools and are not read.
func ValidatePackageJSON(value any) error {
	pkg, err := object("package.json", value)
	if err != nil {
		return err
	}
	engines, err := object("package.json engines", pkg["engines"])
	if err != nil {
		return err
	}
	if err := checkRange("package.json engines.soksak", engines["soksak"]); err != nil {
		return err
	}
	files, err := array("package.json files", pkg["files"])
	if err != nil {
		return err
	}
	listed := false
	for _, file := range files {
		s, ok := text(file)
		if !ok || strings.HasPrefix(s, "/") || slices.Contains(strings.Split(s, "/"), "..") {
			return fmt.Errorf("package.json files: expected paths inside the package")
		}
		listed = listed || s == "plugin.json"
	}
	if !listed {
		return fmt.Errorf("package.json files: plugin.json is not listed")
	}
	if err := checkPackageJSONName("package.json name", pkg["name"]); err != nil {
		return err
	}
	if _, ok := pkg["soksak"]; ok {
		return fmt.Errorf("package.json soksak: the sidecars of a plugin and their ranges are the dependencies of plugin.json")
	}
	return checkVersion("package.json version", pkg["version"])
}

// CheckPluginID checks that the id that plugin.json names is the id of the installation record of the plugin. A release
// whose plugin.json names another plugin is refused at installation and at the reading of the installed state
// (docs/spec/installation.md#installation-layout).
func CheckPluginID(id string, manifest map[string]any) error {
	found, ok := text(manifest["id"])
	if !ok {
		return fmt.Errorf("plugin.json id must be a string")
	}
	if found != id {
		return fmt.Errorf("plugin.json id %s differs from the installed plugin %s", found, id)
	}
	return nil
}

// ManifestDependencies checks the dependencies of plugin.json and returns the version range of each package. A plugin
// that needs no other package has no dependencies.
func ManifestDependencies(manifest map[string]any) (map[string]string, error) {
	ranges := map[string]string{}
	raw, ok := manifest["dependencies"]
	if !ok {
		return ranges, nil
	}
	if err := checkSidecarRanges("plugin.json dependencies", raw); err != nil {
		return nil, err
	}
	for name, rng := range raw.(map[string]any) {
		ranges[name] = rng.(string)
	}
	return ranges, nil
}

// ReleaseName is the file name of a plugin release.
func ReleaseName(id, version string) string { return id + "-" + version + ".tgz" }

// SidecarFileName turns a sidecar name into the form used for file names and folder names. `@scope/name` becomes
// `scope-name`.
func SidecarFileName(name string) (string, error) {
	if err := checkPackageJSONName("sidecar", name); err != nil {
		return "", err
	}
	if scoped, ok := strings.CutPrefix(name, "@"); ok {
		return strings.Replace(scoped, "/", "-", 1), nil
	}
	return name, nil
}

func checkPlatform(platform string) error {
	if !slices.Contains(Platforms, platform) {
		return fmt.Errorf("unknown platform %s", platform)
	}
	return nil
}

// SidecarReleaseName is the file name of a sidecar release.
func SidecarReleaseName(name, version, platform string) (string, error) {
	if err := checkVersion("sidecar "+name+" version", version); err != nil {
		return "", err
	}
	if err := checkPlatform(platform); err != nil {
		return "", err
	}
	file, err := SidecarFileName(name)
	if err != nil {
		return "", err
	}
	return file + "-" + version + "-" + platform + ".tar.gz", nil
}

// PluginInstallPath is the folder inside the configuration directory into which one plugin version is extracted.
func PluginInstallPath(id, version string) (string, error) {
	if !isIdentifier(id) {
		return "", fmt.Errorf("invalid plugin id %s", id)
	}
	// The core root is the reserved host `core` (docs/spec/plugin-processes.md rule 4), so no plugin may be installed under that id.
	if id == "core" {
		return "", fmt.Errorf("plugin id %s is reserved for the core root", id)
	}
	if err := checkVersion("plugin "+id+" version", version); err != nil {
		return "", err
	}
	return "plugins/" + id + "/" + version, nil
}

// SidecarInstallPath is the folder in the configuration directory that the release of one sidecar version and platform is extracted into.
func SidecarInstallPath(name, version, platform string) (string, error) {
	if err := checkVersion("sidecar "+name+" version", version); err != nil {
		return "", err
	}
	if err := checkPlatform(platform); err != nil {
		return "", err
	}
	file, err := SidecarFileName(name)
	if err != nil {
		return "", err
	}
	return "sidecars/" + file + "/" + version + "/" + platform, nil
}

// Release is the address and hash of a release.
type Release struct {
	URL    string `json:"url"`
	SHA256 string `json:"sha256"`
}

// PluginVersion is one plugin version of the registry.
type PluginVersion struct {
	Version string  `json:"version"`
	Release Release `json:"release"`
	Engines struct {
		Soksak string `json:"soksak"`
	} `json:"engines"`
	Sidecars map[string]string `json:"sidecars"`
}

// RegistryPlugin is a plugin entry of the registry.
type RegistryPlugin struct {
	ID          string          `json:"id"`
	Package     string          `json:"package"`
	Name        string          `json:"name"`
	Description string          `json:"description"`
	License     string          `json:"license"`
	Repository  string          `json:"repository"`
	Versions    []PluginVersion `json:"versions"`
}

// SidecarVersion is one sidecar version of the registry.
type SidecarVersion struct {
	Version  string             `json:"version"`
	Protocol int                `json:"protocol"`
	Releases map[string]Release `json:"releases"`
}

// RegistrySidecar is a sidecar entry of the registry.
type RegistrySidecar struct {
	Name       string           `json:"name"`
	Repository string           `json:"repository"`
	Versions   []SidecarVersion `json:"versions"`
}

// RegistryPack is a set of plugins that are installed together.
type RegistryPack struct {
	Name        string   `json:"name"`
	Description string   `json:"description"`
	Plugins     []string `json:"plugins"`
}

// RevokedPlugin is a plugin version that must not be installed.
type RevokedPlugin struct {
	ID      string `json:"id"`
	Version string `json:"version"`
	Reason  string `json:"reason"`
}

// RevokedSidecar is a sidecar version that must not be installed or run.
type RevokedSidecar struct {
	Name    string `json:"name"`
	Version string `json:"version"`
	Reason  string `json:"reason"`
}

// Revoked is a version that must not be installed or run.
type Revoked struct {
	Plugins  []RevokedPlugin  `json:"plugins"`
	Sidecars []RevokedSidecar `json:"sidecars"`
	Core     []RevokedCore    `json:"core,omitempty"`
}

// Index is a registry index that was checked.
type Index struct {
	Format   int               `json:"format"`
	Plugins  []RegistryPlugin  `json:"plugins"`
	Sidecars []RegistrySidecar `json:"sidecars"`
	// Core lists the core releases; an index without it lists none (docs/spec/installation.md#application-update).
	Core    *RegistryCore  `json:"core,omitempty"`
	Packs   []RegistryPack `json:"packs"`
	Revoked Revoked        `json:"revoked"`
}

// CoreHosts are the hosts of an application release.
var CoreHosts = []string{"tauriv2", "wailsv3"}

// CoreRelease is one core release of the registry: the zip of the application bundle for each platform and host.
type CoreRelease struct {
	Version  string             `json:"version"`
	Releases map[string]Release `json:"releases"`
}

// RegistryCore lists the core releases of the registry.
type RegistryCore struct {
	Versions []CoreRelease `json:"versions"`
}

// RevokedCore is a core version that an application must not update to.
type RevokedCore struct {
	Version string `json:"version"`
	Reason  string `json:"reason"`
}

// entryWhere is the location of an entry with its name appended when the name is a string.
func entryWhere(kind string, m map[string]any, key string) string {
	if name, ok := m[key].(string); ok {
		return kind + " " + name
	}
	return kind
}

// ValidateRegistryPlugin checks one plugin entry of the registry (`plugins/<id>.json`).
func ValidateRegistryPlugin(value any) error {
	entry, err := object("registry plugin", value)
	if err != nil {
		return err
	}
	where := entryWhere("registry plugin", entry, "id")
	if err := only(where, entry, "description", "id", "license", "name", "package", "repository", "versions"); err != nil {
		return err
	}
	if err := checkDescription(where, entry["description"]); err != nil {
		return err
	}
	if id, ok := text(entry["id"]); !ok || !isIdentifier(id) {
		return fmt.Errorf("%s: id must be a lowercase identifier", where)
	}
	if _, ok := text(entry["license"]); !ok {
		return fmt.Errorf("%s: license is required", where)
	}
	if _, ok := text(entry["name"]); !ok {
		return fmt.Errorf("%s: name is required", where)
	}
	if err := checkPackageJSONName(where+" package", entry["package"]); err != nil {
		return err
	}
	if _, ok := text(entry["repository"]); !ok {
		return fmt.Errorf("%s: repository is required", where)
	}
	versions, err := array(where+" versions", entry["versions"])
	if err != nil {
		return err
	}
	seen := map[string]bool{}
	for _, raw := range versions {
		item, err := object(where+" version", raw)
		if err != nil {
			return err
		}
		if err := only(where+" version", item, "engines", "release", "sidecars", "version"); err != nil {
			return err
		}
		if err := checkVersion(where+" version", item["version"]); err != nil {
			return err
		}
		version := item["version"].(string)
		if seen[version] {
			return fmt.Errorf("%s: version %s appears twice", where, version)
		}
		seen[version] = true
		engines, err := object(where+" "+version+" engines", item["engines"])
		if err != nil {
			return err
		}
		if err := only(where+" "+version+" engines", engines, "soksak"); err != nil {
			return err
		}
		if err := checkRange(where+" "+version+" engines.soksak", engines["soksak"]); err != nil {
			return err
		}
		if err := checkReleaseEntry(where+" "+version+" release", item["release"]); err != nil {
			return err
		}
		if err := checkSidecarRanges(where+" "+version+" sidecars", item["sidecars"]); err != nil {
			return err
		}
	}
	if len(seen) == 0 {
		return fmt.Errorf("%s: versions is empty", where)
	}
	return nil
}

// ValidateRegistrySidecar checks one sidecar entry of the registry (`sidecars/<file name>.json`).
func ValidateRegistrySidecar(value any) error {
	entry, err := object("registry sidecar", value)
	if err != nil {
		return err
	}
	where := entryWhere("registry sidecar", entry, "name")
	if err := only(where, entry, "name", "repository", "versions"); err != nil {
		return err
	}
	if err := checkPackageJSONName(where+" name", entry["name"]); err != nil {
		return err
	}
	if _, ok := text(entry["repository"]); !ok {
		return fmt.Errorf("%s: repository is required", where)
	}
	versions, err := array(where+" versions", entry["versions"])
	if err != nil {
		return err
	}
	seen := map[string]bool{}
	for _, raw := range versions {
		item, err := object(where+" version", raw)
		if err != nil {
			return err
		}
		if err := only(where+" version", item, "protocol", "releases", "version"); err != nil {
			return err
		}
		if err := checkVersion(where+" version", item["version"]); err != nil {
			return err
		}
		version := item["version"].(string)
		if seen[version] {
			return fmt.Errorf("%s: version %s appears twice", where, version)
		}
		seen[version] = true
		releases, err := object(where+" "+version+" releases", item["releases"])
		if err != nil {
			return err
		}
		if len(releases) == 0 {
			return fmt.Errorf("%s %s: releases is empty", where, version)
		}
		for _, platform := range sortedKeys(releases) {
			if err := checkPlatform(platform); err != nil {
				return fmt.Errorf("%s %s: %w", where, version, err)
			}
			if err := checkReleaseEntry(where+" "+version+" "+platform, releases[platform]); err != nil {
				return err
			}
		}
		if !isOne(item["protocol"]) {
			return fmt.Errorf("%s %s: protocol must be 1", where, version)
		}
	}
	if len(seen) == 0 {
		return fmt.Errorf("%s: versions is empty", where)
	}
	return nil
}

// splitCoreKey splits the key of a core release into its platform and host.
func splitCoreKey(key string) (platform, host string, err error) {
	at := strings.LastIndex(key, "-")
	if at < 0 {
		return "", "", fmt.Errorf("%s is not <platform>-<host>", key)
	}
	platform, host = key[:at], key[at+1:]
	// The last part of a platform key is an architecture, so it is not a host: the key lacks the host.
	if slices.Contains(Platforms, key) {
		return "", "", fmt.Errorf("%s is not <platform>-<host>", key)
	}
	if err := checkPlatform(platform); err != nil {
		return "", "", err
	}
	if !slices.Contains(CoreHosts, host) {
		return "", "", fmt.Errorf("unknown host %s", host)
	}
	return platform, host, nil
}

// ValidateRegistryCore checks the core list of the registry (`core.json`): each version has releases of platform and
// host keys.
func ValidateRegistryCore(value any) error {
	core, err := object("registry core", value)
	if err != nil {
		return err
	}
	if err := only("registry core", core, "versions"); err != nil {
		return err
	}
	versions, err := array("registry core versions", core["versions"])
	if err != nil {
		return err
	}
	seen := map[string]bool{}
	for _, raw := range versions {
		item, err := object("registry core version", raw)
		if err != nil {
			return err
		}
		if err := only("registry core version", item, "releases", "version"); err != nil {
			return err
		}
		if err := checkVersion("registry core version", item["version"]); err != nil {
			return err
		}
		version := item["version"].(string)
		if seen[version] {
			return fmt.Errorf("registry core: version %s appears twice", version)
		}
		seen[version] = true
		releases, err := object("registry core "+version+" releases", item["releases"])
		if err != nil {
			return err
		}
		if len(releases) == 0 {
			return fmt.Errorf("registry core %s: releases is empty", version)
		}
		for _, key := range sortedKeys(releases) {
			if _, _, err := splitCoreKey(key); err != nil {
				return fmt.Errorf("registry core %s: %w", version, err)
			}
			if err := checkReleaseEntry("registry core "+version+" "+key, releases[key]); err != nil {
				return err
			}
		}
	}
	return nil
}

// ValidateRegistryPack checks one pack entry of the registry (`packs/<name>.json`).
func ValidateRegistryPack(value any) error {
	entry, err := object("registry pack", value)
	if err != nil {
		return err
	}
	where := entryWhere("registry pack", entry, "name")
	if err := only(where, entry, "description", "name", "plugins"); err != nil {
		return err
	}
	if err := checkDescription(where, entry["description"]); err != nil {
		return err
	}
	if name, ok := text(entry["name"]); !ok || !isIdentifier(name) {
		return fmt.Errorf("%s: name must be a lowercase identifier", where)
	}
	ids, err := array(where+" plugins", entry["plugins"])
	if err != nil {
		return err
	}
	seen := map[string]bool{}
	for _, raw := range ids {
		id, ok := text(raw)
		if !ok || !isIdentifier(id) {
			return fmt.Errorf("%s: plugins must be plugin ids", where)
		}
		if seen[id] {
			return fmt.Errorf("%s: duplicate plugin", where)
		}
		seen[id] = true
	}
	if len(ids) == 0 {
		return fmt.Errorf("%s: plugins must be plugin ids", where)
	}
	return nil
}

// ValidateRevoked checks the revoked list of the registry (`revoked.json`).
func ValidateRevoked(value any) error {
	revoked, err := object("registry revoked", value)
	if err != nil {
		return err
	}
	if err := only("registry revoked", revoked, "core", "plugins", "sidecars"); err != nil {
		return err
	}
	// A revoked list without core withdraws no core version.
	if raw, ok := revoked["core"]; ok {
		items, err := array("registry revoked core", raw)
		if err != nil {
			return err
		}
		for _, raw := range items {
			item, err := object("registry revoked core", raw)
			if err != nil {
				return err
			}
			if err := only("registry revoked core", item, "reason", "version"); err != nil {
				return err
			}
			if err := checkVersion("registry revoked core", item["version"]); err != nil {
				return err
			}
			if _, ok := text(item["reason"]); !ok {
				return fmt.Errorf("registry revoked core %v: reason is required", item["version"])
			}
		}
	}
	for _, kind := range [][2]string{{"plugins", "id"}, {"sidecars", "name"}} {
		where := "registry revoked " + kind[0]
		items, err := array(where, revoked[kind[0]])
		if err != nil {
			return err
		}
		for _, raw := range items {
			item, err := object(where, raw)
			if err != nil {
				return err
			}
			if err := only(where, item, kind[1], "reason", "version"); err != nil {
				return err
			}
			name, ok := text(item[kind[1]])
			if !ok {
				return fmt.Errorf("%s: %s is required", where, kind[1])
			}
			if _, ok := text(item["reason"]); !ok {
				return fmt.Errorf("%s %s: reason is required", where, name)
			}
			if err := checkVersion(where+" "+name, item["version"]); err != nil {
				return err
			}
		}
	}
	return nil
}

// typed moves a checked value into the format structure.
func typed(value any, target any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return json.Unmarshal(data, target)
}

// ValidateRegistryIndex checks the registry index. It checks the format of each entry, that names do not repeat, that
// packs and revoked entries refer to existing plugins and sidecars, and that every plugin version has a sidecar version
// that satisfies the sidecar ranges it needs.
func ValidateRegistryIndex(value any) (*Index, error) {
	root, err := object("registry index", value)
	if err != nil {
		return nil, err
	}
	if err := only("registry index", root, "core", "format", "packs", "plugins", "revoked", "sidecars"); err != nil {
		return nil, err
	}
	if raw, ok := root["core"]; ok {
		if err := ValidateRegistryCore(raw); err != nil {
			return nil, err
		}
	}
	if !isOne(root["format"]) {
		return nil, fmt.Errorf("registry index: format must be %d", InstallFormat)
	}
	for _, list := range []struct {
		name     string
		validate func(any) error
	}{{"packs", ValidateRegistryPack}, {"plugins", ValidateRegistryPlugin}, {"sidecars", ValidateRegistrySidecar}} {
		items, err := array("registry index "+list.name, root[list.name])
		if err != nil {
			return nil, err
		}
		for _, item := range items {
			if err := list.validate(item); err != nil {
				return nil, err
			}
		}
	}
	if err := ValidateRevoked(root["revoked"]); err != nil {
		return nil, err
	}
	var index Index
	if err := typed(root, &index); err != nil {
		return nil, err
	}
	plugins := map[string]*RegistryPlugin{}
	packages := map[string]bool{}
	for i := range index.Plugins {
		entry := &index.Plugins[i]
		if plugins[entry.ID] != nil {
			return nil, fmt.Errorf("registry index: plugin %s appears twice", entry.ID)
		}
		if packages[entry.Package] {
			return nil, fmt.Errorf("registry index: package %s appears twice", entry.Package)
		}
		plugins[entry.ID] = entry
		packages[entry.Package] = true
	}
	sidecars := map[string]*RegistrySidecar{}
	for i := range index.Sidecars {
		entry := &index.Sidecars[i]
		if sidecars[entry.Name] != nil {
			return nil, fmt.Errorf("registry index: sidecar %s appears twice", entry.Name)
		}
		sidecars[entry.Name] = entry
	}
	packs := map[string]bool{}
	for _, entry := range index.Packs {
		if packs[entry.Name] {
			return nil, fmt.Errorf("registry index: pack %s appears twice", entry.Name)
		}
		packs[entry.Name] = true
		for _, id := range entry.Plugins {
			if plugins[id] == nil {
				return nil, fmt.Errorf("registry index: pack %s names unknown plugin %s", entry.Name, id)
			}
		}
	}
	for _, plugin := range index.Plugins {
		for _, item := range plugin.Versions {
			for _, name := range sortedNames(item.Sidecars) {
				rng := item.Sidecars[name]
				sidecar := sidecars[name]
				if sidecar == nil {
					return nil, fmt.Errorf("registry index: plugin %s %s needs unknown sidecar %s", plugin.ID, item.Version, name)
				}
				if !slices.ContainsFunc(sidecar.Versions, func(candidate SidecarVersion) bool { return Satisfies(candidate.Version, rng) }) {
					return nil, fmt.Errorf("registry index: plugin %s %s needs %s %s, which no version satisfies", plugin.ID, item.Version, name, rng)
				}
			}
		}
	}
	for _, item := range index.Revoked.Plugins {
		if plugin := plugins[item.ID]; plugin == nil || !slices.ContainsFunc(plugin.Versions, func(candidate PluginVersion) bool { return candidate.Version == item.Version }) {
			return nil, fmt.Errorf("registry index: revoked plugin %s %s is not listed", item.ID, item.Version)
		}
	}
	for _, item := range index.Revoked.Sidecars {
		if sidecar := sidecars[item.Name]; sidecar == nil || !slices.ContainsFunc(sidecar.Versions, func(candidate SidecarVersion) bool { return candidate.Version == item.Version }) {
			return nil, fmt.Errorf("registry index: revoked sidecar %s %s is not listed", item.Name, item.Version)
		}
	}
	for _, item := range index.Revoked.Core {
		if index.Core == nil || !slices.ContainsFunc(index.Core.Versions, func(candidate CoreRelease) bool { return candidate.Version == item.Version }) {
			return nil, fmt.Errorf("registry index: revoked core %s is not listed", item.Version)
		}
	}
	return &index, nil
}

func sortedNames(m map[string]string) []string {
	names := make([]string, 0, len(m))
	for name := range m {
		names = append(names, name)
	}
	slices.Sort(names)
	return names
}

// InstalledPlugin is one installed plugin. Path is the folder into which the version that the installation uses is
// extracted, relative to the configuration directory.
type InstalledPlugin struct {
	Version  string            `json:"version"`
	Path     string            `json:"path"`
	Enabled  bool              `json:"enabled"`
	Sidecars map[string]string `json:"sidecars"`
	Previous string            `json:"previous,omitempty"`
}

// InstalledSidecar is one installed sidecar. Path is the folder that installation extracted its platform release into,
// relative to the configuration directory.
type InstalledSidecar struct {
	Version string `json:"version"`
	Path    string `json:"path"`
}

// InstalledState is the installation state file (`plugins/installed.json`). For each plugin id it holds the version in
// use, the extracted folder, whether the plugin is enabled, the sidecar ranges of that version and the previous version
// to return to. For each sidecar it holds the one version that all plugins share and its folder. The installation
// records the folders and the host reads only the recorded folders.
type InstalledState struct {
	Format   int                         `json:"format"`
	Plugins  map[string]InstalledPlugin  `json:"plugins"`
	Sidecars map[string]InstalledSidecar `json:"sidecars"`
}

// checkPluginFolder checks that the path of a plugin is the folder plugins/<id>/<version> of the installation rule.
func checkPluginFolder(where, id, version string, value any) error {
	folder, err := PluginInstallPath(id, version)
	if err != nil {
		return err
	}
	if path, ok := text(value); !ok || path != folder {
		return fmt.Errorf("%s: path must be %s", where, folder)
	}
	return nil
}

// checkSidecarFolder checks that the path of a sidecar is the folder sidecars/<file name>/<version>/<platform> of the
// installation rule.
func checkSidecarFolder(where, name, version string, value any) error {
	file, err := SidecarFileName(name)
	if err != nil {
		return err
	}
	prefix := "sidecars/" + file + "/" + version + "/"
	path, ok := text(value)
	if !ok || !strings.HasPrefix(path, prefix) || checkPlatform(strings.TrimPrefix(path, prefix)) != nil {
		return fmt.Errorf("%s: path must be %s<platform>", where, prefix)
	}
	return nil
}

// ValidateInstalled checks the installation state file.
func ValidateInstalled(value any) (*InstalledState, error) {
	root, err := object(Installed, value)
	if err != nil {
		return nil, err
	}
	if err := only(Installed, root, "format", "plugins", "sidecars"); err != nil {
		return nil, err
	}
	if format, ok := root["format"].(json.Number); !ok || format.String() != strconv.Itoa(InstalledFormat) {
		return nil, fmt.Errorf("%s: format must be %d", Installed, InstalledFormat)
	}
	plugins, err := object(Installed+" plugins", root["plugins"])
	if err != nil {
		return nil, err
	}
	for _, id := range sortedKeys(plugins) {
		where := Installed + " " + id
		if !isIdentifier(id) {
			return nil, fmt.Errorf("%s: id must be a lowercase identifier", where)
		}
		item, err := object(where, plugins[id])
		if err != nil {
			return nil, err
		}
		if err := only(where, item, "enabled", "path", "previous", "sidecars", "version"); err != nil {
			return nil, err
		}
		if _, ok := item["enabled"].(bool); !ok {
			return nil, fmt.Errorf("%s: enabled must be true or false", where)
		}
		if previous, ok := item["previous"]; ok {
			if err := checkVersion(where+" previous", previous); err != nil {
				return nil, err
			}
		}
		if err := checkSidecarRanges(where+" sidecars", item["sidecars"]); err != nil {
			return nil, err
		}
		version, err := checkedVersion(where+" version", item["version"])
		if err != nil {
			return nil, err
		}
		if err := checkPluginFolder(where, id, version, item["path"]); err != nil {
			return nil, err
		}
	}
	sidecars, err := object(Installed+" sidecars", root["sidecars"])
	if err != nil {
		return nil, err
	}
	var state InstalledState
	named := map[string]bool{}
	for _, id := range sortedKeys(plugins) {
		for name := range plugins[id].(map[string]any)["sidecars"].(map[string]any) {
			named[name] = true
		}
	}
	for _, name := range sortedKeys(sidecars) {
		where := Installed + " sidecar " + name
		item, err := object(where, sidecars[name])
		if err != nil {
			return nil, err
		}
		if err := only(where, item, "path", "version"); err != nil {
			return nil, err
		}
		version, err := checkedVersion(where+" version", item["version"])
		if err != nil {
			return nil, err
		}
		if err := checkSidecarFolder(where, name, version, item["path"]); err != nil {
			return nil, err
		}
		if !named[name] {
			return nil, fmt.Errorf("%s: sidecar %s is named by no installed plugin", Installed, name)
		}
	}
	if err := typed(root, &state); err != nil {
		return nil, err
	}
	for _, id := range sortedKeys(plugins) {
		item := state.Plugins[id]
		for _, name := range sortedNames(item.Sidecars) {
			sidecar, ok := state.Sidecars[name]
			version := sidecar.Version
			if !ok {
				return nil, fmt.Errorf("%s %s: sidecar %s has no version in use", Installed, id, name)
			}
			if !Satisfies(version, item.Sidecars[name]) {
				return nil, fmt.Errorf("%s %s: sidecar %s %s does not satisfy %s", Installed, id, name, version, item.Sidecars[name])
			}
		}
	}
	return &state, nil
}

// ClassifyDependencies splits the dependencies of a plugin version into plugin dependencies, which name the package of
// a plugin of the registry index, and sidecar dependencies, which name a sidecar of the index. A dependency that is
// neither is an error.
func ClassifyDependencies(index *Index, id, version string, dependencies map[string]string) (plugins, sidecars map[string]string, err error) {
	plugins, sidecars = map[string]string{}, map[string]string{}
	for _, name := range sortedNames(dependencies) {
		switch {
		case slices.ContainsFunc(index.Plugins, func(entry RegistryPlugin) bool { return entry.Package == name }):
			plugins[name] = dependencies[name]
		case slices.ContainsFunc(index.Sidecars, func(entry RegistrySidecar) bool { return entry.Name == name }):
			sidecars[name] = dependencies[name]
		default:
			return nil, nil, fmt.Errorf("%s %s: dependency %s is neither a plugin nor a sidecar of the registry", id, version, name)
		}
	}
	return plugins, sidecars, nil
}

// Need is the range that one installed plugin requires of a plugin or a sidecar. Who is `<id> <version>`.
type Need struct {
	Who, Range string
}

func needsText(needs []Need) string {
	texts := make([]string, len(needs))
	for i, n := range needs {
		texts[i] = n.Who + " needs " + n.Range
	}
	return strings.Join(texts, ", ")
}

// SelectedSidecar is one sidecar version to install with its platform release.
type SelectedSidecar struct {
	Name    string
	Version string
	Release Release
}

// Selection is the plugin version to install and its sidecar versions.
type Selection struct {
	Plugin   *RegistryPlugin
	Version  *PluginVersion
	Sidecars []SelectedSidecar
}

func revokedPlugin(index *Index, id, version string) bool {
	return slices.ContainsFunc(index.Revoked.Plugins, func(item RevokedPlugin) bool { return item.ID == id && item.Version == version })
}

func revokedSidecar(index *Index, name, version string) bool {
	return slices.ContainsFunc(index.Revoked.Sidecars, func(item RevokedSidecar) bool { return item.Name == name && item.Version == version })
}

// newer reports whether a is newer than the other of two versions of the checked index.
func newer(a, b string) bool {
	x, errA := ParseVersion(a)
	y, errB := ParseVersion(b)
	// default: only versions of the checked index are compared, so reading cannot fail; a version that cannot be read is
	// not treated as newer.
	return errA == nil && errB == nil && x.Compare(y) > 0
}

// ResolveInstall selects the plugin version to install and its sidecar versions. The plugin version is the newest one
// whose engines.soksak contains core, that is not revoked, and that satisfies every range of needs, the ranges of the
// installed plugins that name the plugin. An installation has one version of a sidecar, so it satisfies the range of
// the selected version and the ranges that the other installed plugins name. The version in use is kept when it
// satisfies every range, is not revoked and has a release for the platform; otherwise the newest such version is selected.
func ResolveInstall(index *Index, id, core, platform string, installed *InstalledState, needs []Need) (*Selection, error) {
	var plugin *RegistryPlugin
	for i := range index.Plugins {
		if index.Plugins[i].ID == id {
			plugin = &index.Plugins[i]
		}
	}
	if plugin == nil {
		return nil, fmt.Errorf("plugin %s is not in the registry", id)
	}
	var chosen *PluginVersion
	for i := range plugin.Versions {
		item := &plugin.Versions[i]
		fits := !slices.ContainsFunc(needs, func(n Need) bool { return !Satisfies(item.Version, n.Range) })
		if Satisfies(core, item.Engines.Soksak) && !revokedPlugin(index, id, item.Version) && fits && (chosen == nil || newer(item.Version, chosen.Version)) {
			chosen = item
		}
	}
	if chosen == nil && len(needs) > 0 {
		return nil, fmt.Errorf("plugin %s has no version for core %s that satisfies every installed plugin: %s", id, core, needsText(needs))
	}
	if chosen == nil {
		return nil, fmt.Errorf("plugin %s has no version for core %s", id, core)
	}
	selection := &Selection{Plugin: plugin, Version: chosen}
	for _, name := range sortedNames(chosen.Sidecars) {
		needs := []Need{{id + " " + chosen.Version, chosen.Sidecars[name]}}
		for _, other := range sortedPluginIDs(installed.Plugins) {
			item := installed.Plugins[other]
			if rng, ok := item.Sidecars[name]; ok && other != id {
				needs = append(needs, Need{other + " " + item.Version, rng})
			}
		}
		var entry *RegistrySidecar
		for i := range index.Sidecars {
			if index.Sidecars[i].Name == name {
				entry = &index.Sidecars[i]
			}
		}
		var best, kept *SidecarVersion
		var candidates []SidecarVersion
		if entry != nil {
			candidates = entry.Versions
		}
		for i := range candidates {
			item := &candidates[i]
			_, hasRelease := item.Releases[platform]
			fits := !slices.ContainsFunc(needs, func(n Need) bool { return !Satisfies(item.Version, n.Range) })
			if !hasRelease || !fits || revokedSidecar(index, name, item.Version) {
				continue
			}
			if item.Version == installed.Sidecars[name].Version {
				kept = item
			}
			if best == nil || newer(item.Version, best.Version) {
				best = item
			}
		}
		if best == nil {
			return nil, fmt.Errorf("sidecar %s has no version for %s that satisfies every installed plugin: %s", name, platform, needsText(needs))
		}
		if kept != nil {
			best = kept
		}
		selection.Sidecars = append(selection.Sidecars, SelectedSidecar{Name: name, Version: best.Version, Release: best.Releases[platform]})
	}
	return selection, nil
}

func sortedPluginIDs(m map[string]InstalledPlugin) []string {
	ids := make([]string, 0, len(m))
	for id := range m {
		ids = append(ids, id)
	}
	slices.Sort(ids)
	return ids
}

// PluginFiles are the declarations of an installed plugin that the granted item rule reads: the name of its package
// (package.json) and the content of its plugin.json.
type PluginFiles struct {
	Package  string
	Manifest any
}

// grantedPoint is an extension point that a plugin declares in extends. Version is nil when the point has no version.
type grantedPoint struct {
	version *semver.Version
	modules map[string]string
}

// grantedItem is an item that a plugin contributes to the point `point` of the plugin `provider`.
type grantedItem struct {
	provider string
	point    string
	rng      Range
	module   string
}

// grantedPlugin holds the declarations that the granted item rule reads from one plugin.
type grantedPlugin struct {
	pkg    string
	points map[string]grantedPoint
	items  []grantedItem
}

// checkModulePath checks that a module path names a file inside the package: a relative path whose segments are
// neither empty, `.` nor `..`. It returns the path.
func checkModulePath(where string, value any) (string, error) {
	path, ok := text(value)
	if !ok || strings.HasPrefix(path, "/") || slices.ContainsFunc(strings.Split(path, "/"), func(segment string) bool {
		return segment == "" || segment == "." || segment == ".."
	}) {
		return "", fmt.Errorf("%s: module must be a relative path inside the package, got %s", where, quote(value))
	}
	return path, nil
}

// grantedDeclarations reads the extends and contributes declarations of plugin id and checks each one that the granted
// item rule uses. A malformed declaration is an error, not a missing grant.
func grantedDeclarations(id string, files PluginFiles) (grantedPlugin, error) {
	where := id + " plugin.json"
	if files.Package == "" {
		return grantedPlugin{}, fmt.Errorf("installed plugin %s has no package name", id)
	}
	manifest, err := object(where, files.Manifest)
	if err != nil {
		return grantedPlugin{}, err
	}
	plugin := grantedPlugin{pkg: files.Package, points: map[string]grantedPoint{}}
	if value, ok := manifest["extends"]; ok {
		extends, err := object(where+" extends", value)
		if err != nil {
			return grantedPlugin{}, err
		}
		for _, name := range sortedKeys(extends) {
			at := where + " extends " + name
			point, err := object(at, extends[name])
			if err != nil {
				return grantedPlugin{}, err
			}
			var entry grantedPoint
			if value, ok := point["version"]; ok {
				version, err := checkedVersion(at+" version", value)
				if err != nil {
					return grantedPlugin{}, err
				}
				if entry.version, err = ParseVersion(version); err != nil {
					return grantedPlugin{}, fmt.Errorf("%s version: %w", at, err)
				}
			}
			if value, ok := point["modules"]; ok {
				modules, err := object(at+" modules", value)
				if err != nil {
					return grantedPlugin{}, err
				}
				entry.modules = map[string]string{}
				for _, specifier := range sortedKeys(modules) {
					path, err := checkModulePath(at+" modules "+specifier, modules[specifier])
					if err != nil {
						return grantedPlugin{}, err
					}
					entry.modules[specifier] = path
				}
			}
			plugin.points[name] = entry
		}
	}
	if value, ok := manifest["contributes"]; ok {
		contributes, err := object(where+" contributes", value)
		if err != nil {
			return grantedPlugin{}, err
		}
		for _, key := range sortedKeys(contributes) {
			provider, point, found := strings.Cut(key, ".")
			if !found || provider == "" || point == "" {
				return grantedPlugin{}, fmt.Errorf("%s contributes %s: the key must be <plugin id>.<point>", where, key)
			}
			at := where + " contributes " + key
			raws, err := array(at, contributes[key])
			if err != nil {
				return grantedPlugin{}, err
			}
			for _, raw := range raws {
				item, err := object(at+" item", raw)
				if err != nil {
					return grantedPlugin{}, err
				}
				if err := checkRange(at+" range", item["range"]); err != nil {
					return grantedPlugin{}, err
				}
				rng, err := ParseRange(item["range"].(string))
				if err != nil {
					return grantedPlugin{}, fmt.Errorf("%s range: %w", at, err)
				}
				module, err := checkModulePath(at+" module", item["module"])
				if err != nil {
					return grantedPlugin{}, err
				}
				plugin.items = append(plugin.items, grantedItem{provider: provider, point: point, rng: rng, module: module})
			}
		}
	}
	return plugin, nil
}

// GrantedFiles returns the files that a view of the requester may read, in the core root form (docs/spec/installation.md):
// `/modules/<package>/<module>` for the module of each granted item that another plugin contributes to a point of the
// requester, and `/shared/<plugin id>.<point>/<specifier>.js` for each shared module of a point that has a granted item
// of another plugin, whether the requester provides the point or contributes to it. An item is granted when its
// contributor and its provider are installed and the provider is enabled, the point declares a version, and the range
// of the item contains that version. The requester must be installed; its own enabled state is not checked. Every
// enabled plugin and the requester must have files, and each declaration that the rule reads must be well formed, or
// an error names it. The result is sorted and has no repeated path.
func GrantedFiles(state *InstalledState, files map[string]PluginFiles, requester string) ([]string, error) {
	if _, ok := state.Plugins[requester]; !ok {
		return nil, fmt.Errorf("plugin %s is not installed", requester)
	}
	plugins := map[string]grantedPlugin{}
	for _, id := range sortedPluginIDs(state.Plugins) {
		if !state.Plugins[id].Enabled && id != requester {
			continue
		}
		entry, ok := files[id]
		if !ok {
			return nil, fmt.Errorf("installed plugin %s has no package.json and plugin.json", id)
		}
		plugin, err := grantedDeclarations(id, entry)
		if err != nil {
			return nil, err
		}
		plugins[id] = plugin
	}
	paths := map[string]bool{}
	self := plugins[requester]
	// The requester provides the points. A granted item of another plugin adds its module and the shared modules of its point.
	provided := map[string]bool{}
	for _, id := range sortedPluginIDs(state.Plugins) {
		contributor, ok := plugins[id]
		if !ok || id == requester {
			continue
		}
		for _, item := range contributor.items {
			if item.provider != requester || !grantedBy(self.points[item.point], item.rng) {
				continue
			}
			paths["/modules/"+contributor.pkg+"/"+item.module] = true
			provided[item.point] = true
		}
	}
	for point := range provided {
		addShared(paths, requester, point, self.points[point])
	}
	// The requester contributes to the points of other plugins. Each point with a granted item adds its shared modules.
	contributed := map[sharedPoint]grantedPoint{}
	for _, item := range self.items {
		provider, ok := plugins[item.provider]
		if !ok || item.provider == requester {
			continue
		}
		point := provider.points[item.point]
		if grantedBy(point, item.rng) {
			contributed[sharedPoint{item.provider, item.point}] = point
		}
	}
	for key, entry := range contributed {
		addShared(paths, key.id, key.point, entry)
	}
	out := make([]string, 0, len(paths))
	for path := range paths {
		out = append(out, path)
	}
	slices.Sort(out)
	return out, nil
}

// grantedBy reports whether a point declares a version and the range of an item contains it.
func grantedBy(point grantedPoint, rng Range) bool {
	return point.version != nil && rng.Contains(point.version)
}

// addShared adds the core root path of each shared module of the point `id.point`.
func addShared(paths map[string]bool, id, point string, entry grantedPoint) {
	for specifier := range entry.modules {
		paths["/shared/"+id+"."+point+"/"+specifier+".js"] = true
	}
}

// sharedPoint names the point `point` of the plugin `id`.
type sharedPoint struct {
	id    string
	point string
}
