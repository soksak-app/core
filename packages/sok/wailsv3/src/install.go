package sok

// 설치형 plugin 의 형식(docs/spec/installation.md): version 과 범위, plugin package, registry index, sidecar release
// asset, 설치 배치와 설치 상태. 형식이 틀리면 어디가 틀렸는지 담은 오류를 돌려준다. 필드는 정해진 순서로 검사하므로
// 여러 필드가 틀려도 두 구현이 같은 오류를 낸다.

import (
	"bytes"
	"encoding/json"
	"fmt"
	"slices"
	"strconv"
	"strings"
	"unicode/utf8"
)

// InstallFormat 은 registry index 의 형식 번호다.
const InstallFormat = 1

// Installed 는 설정 폴더 안에서 설치 상태를 담는 파일이다.
const Installed = "plugins/installed.json"

// InstalledFormat 은 설치 상태 파일의 형식 번호다. 형식 2 는 설치 폴더를 설정 폴더에 대한 상대 경로로 기록한다.
const InstalledFormat = 2

// Platforms 는 sidecar release asset 이 쓰는 플랫폼 key(`<os>-<arch>`)다.
var Platforms = []string{"darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "windows-arm64", "windows-x64"}

const descriptionMax = 200

// Version 은 `x.y.z` version 이다.
type Version [3]uint64

func (v Version) String() string { return fmt.Sprintf("%d.%d.%d", v[0], v[1], v[2]) }

// Compare 는 v 가 o 보다 앞이면 음수, 같으면 0, 뒤면 양수다.
func (v Version) Compare(o Version) int {
	for i := range 3 {
		if v[i] != o[i] {
			if v[i] < o[i] {
				return -1
			}
			return 1
		}
	}
	return 0
}

// quote 는 값을 JSON 텍스트로 쓴다. 오류 문구에서 받은 값을 그대로 보이게 한다.
func quote(value any) string {
	var out bytes.Buffer
	encoder := json.NewEncoder(&out)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return fmt.Sprint(value)
	}
	return strings.TrimSuffix(out.String(), "\n")
}

// ParseVersion 은 숫자 세 자리를 점으로 이은 version 을 읽는다. 앞자리 0 과 uint32 를 넘는 수는 거부하므로 범위의
// 상한을 계산할 때 넘치지 않는다.
func ParseVersion(text string) (Version, error) {
	var v Version
	parts := strings.Split(text, ".")
	if len(parts) != 3 {
		return v, fmt.Errorf("invalid version %s: expected x.y.z", quote(text))
	}
	for i, part := range parts {
		if part == "" || strings.Trim(part, "0123456789") != "" || (len(part) > 1 && part[0] == '0') {
			return v, fmt.Errorf("invalid version %s: expected x.y.z", quote(text))
		}
		n, err := strconv.ParseUint(part, 10, 32)
		if err != nil {
			return v, fmt.Errorf("invalid version %s: expected x.y.z", quote(text))
		}
		v[i] = n
	}
	return v, nil
}

// Range 는 포함하는 하한 Min 과 포함하지 않는 상한 Below 다.
type Range struct{ Min, Below Version }

// Contains 는 v 가 범위 안에 있는지 알려 준다.
func (r Range) Contains(v Version) bool { return v.Compare(r.Min) >= 0 && v.Compare(r.Below) < 0 }

// ParseRange 는 `x.y.z`, `^x.y.z`, `~x.y.z`, `>=x.y.z <a.b.c` 범위를 읽는다.
func ParseRange(text string) (Range, error) {
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
	}
	operator := ""
	if strings.HasPrefix(text, "^") || strings.HasPrefix(text, "~") {
		operator = text[:1]
	}
	v, err := ParseVersion(text[len(operator):])
	if err != nil {
		return Range{}, fmt.Errorf("invalid version range %s: expected x.y.z, ^x.y.z, ~x.y.z or >=x.y.z <a.b.c", quote(text))
	}
	switch {
	case operator == "":
		return Range{v, Version{v[0], v[1], v[2] + 1}}, nil
	case operator == "~":
		return Range{v, Version{v[0], v[1] + 1, 0}}, nil
	case v[0] > 0:
		return Range{v, Version{v[0] + 1, 0, 0}}, nil
	case v[1] > 0:
		return Range{v, Version{0, v[1] + 1, 0}}, nil
	}
	return Range{v, Version{0, 0, v[2] + 1}}, nil
}

// Satisfies 는 version 이 범위 안에 있는지 알려 준다. 둘 다 이미 검사한 값이어야 한다.
func Satisfies(version, rng string) bool {
	v, err := ParseVersion(version)
	if err != nil {
		return false
	}
	r, err := ParseRange(rng)
	return err == nil && r.Contains(v)
}

// isIdentifier 는 소문자로 시작하고 소문자, 숫자, - 만 쓰는 이름인지 알려 준다.
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

// isPackageName 은 `name` 이나 `@scope/name` 형태인지 알려 준다.
func isPackageName(text string) bool {
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

// DecodeJSON 은 JSON 텍스트를 형식 검사에 쓰는 값으로 읽는다. 수는 원래 텍스트를 지킨다.
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

// checkedVersion 은 checkVersion 을 통과한 version 문자열이다.
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

func checkPackageName(where string, value any) error {
	if s, ok := text(value); !ok || !isPackageName(s) {
		return fmt.Errorf("%s: expected a package name", where)
	}
	return nil
}

func checkSidecarRanges(where string, value any) error {
	m, err := object(where, value)
	if err != nil {
		return err
	}
	for _, name := range sortedKeys(m) {
		if err := checkPackageName(where+" "+name, name); err != nil {
			return err
		}
		if err := checkRange(where+" "+name, m[name]); err != nil {
			return err
		}
	}
	return nil
}

// FilePath 는 절대 `file:` URL 의 local 경로다. %XX 는 그 byte 로 읽는다.
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

func checkArchive(where string, value any) error {
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

// ValidatePluginPackage 는 plugin package 의 package.json 에서 설치에 쓰는 필드를 검사한다. 다른 npm 필드는
// package 도구의 것이므로 보지 않는다.
func ValidatePluginPackage(value any) error {
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
	if err := checkPackageName("package.json name", pkg["name"]); err != nil {
		return err
	}
	if _, ok := pkg["soksak"]; ok {
		return fmt.Errorf("package.json soksak: the sidecars of a plugin and their ranges are the dependencies of plugin.json")
	}
	return checkVersion("package.json version", pkg["version"])
}

// ManifestSidecars 는 plugin.json dependencies 를 검사하고 sidecar 마다 version 범위를 돌려준다. sidecar 를 쓰지 않는
// plugin 은 dependencies 가 없다.
func ManifestSidecars(manifest map[string]any) (map[string]string, error) {
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

// PluginArchiveName 은 plugin package archive 의 파일 이름이다.
func PluginArchiveName(id, version string) string { return id + "-" + version + ".tgz" }

// SidecarFileName 은 sidecar 이름을 파일 이름과 폴더 이름에 쓰는 형태로 바꾼다. `@scope/name` 은 `scope-name` 이다.
func SidecarFileName(name string) (string, error) {
	if err := checkPackageName("sidecar", name); err != nil {
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

// SidecarAssetName 은 sidecar release asset 의 파일 이름이다.
func SidecarAssetName(name, version, platform string) (string, error) {
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

// PluginInstallPath 는 설정 폴더 안에서 plugin version 하나를 푸는 폴더다.
func PluginInstallPath(id, version string) (string, error) {
	if !isIdentifier(id) {
		return "", fmt.Errorf("invalid plugin id %s", id)
	}
	if err := checkVersion("plugin "+id+" version", version); err != nil {
		return "", err
	}
	return "plugins/" + id + "/" + version, nil
}

// SidecarInstallPath 는 설정 폴더 안에서 sidecar version 하나의 플랫폼 asset 을 푸는 폴더다.
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

// Archive 는 release archive 의 주소와 hash 다.
type Archive struct {
	URL    string `json:"url"`
	SHA256 string `json:"sha256"`
}

// PluginVersion 은 registry 의 plugin version 하나다.
type PluginVersion struct {
	Version string  `json:"version"`
	Package Archive `json:"package"`
	Engines struct {
		Soksak string `json:"soksak"`
	} `json:"engines"`
	Sidecars map[string]string `json:"sidecars"`
}

// RegistryPlugin 은 registry 의 plugin 항목이다.
type RegistryPlugin struct {
	ID          string          `json:"id"`
	Package     string          `json:"package"`
	Name        string          `json:"name"`
	Description string          `json:"description"`
	License     string          `json:"license"`
	Repository  string          `json:"repository"`
	Versions    []PluginVersion `json:"versions"`
}

// SidecarVersion 은 registry 의 sidecar version 하나다.
type SidecarVersion struct {
	Version  string             `json:"version"`
	Protocol int                `json:"protocol"`
	Assets   map[string]Archive `json:"assets"`
}

// RegistrySidecar 는 registry 의 sidecar 항목이다.
type RegistrySidecar struct {
	Name       string           `json:"name"`
	Repository string           `json:"repository"`
	Versions   []SidecarVersion `json:"versions"`
}

// RegistryPack 은 함께 설치하는 plugin 묶음이다.
type RegistryPack struct {
	Name        string   `json:"name"`
	Description string   `json:"description"`
	Plugins     []string `json:"plugins"`
}

// RevokedPlugin 은 설치하면 안 되는 plugin version 이다.
type RevokedPlugin struct {
	ID      string `json:"id"`
	Version string `json:"version"`
	Reason  string `json:"reason"`
}

// RevokedSidecar 는 설치하거나 실행하면 안 되는 sidecar version 이다.
type RevokedSidecar struct {
	Name    string `json:"name"`
	Version string `json:"version"`
	Reason  string `json:"reason"`
}

// Revoked 는 설치하거나 실행하면 안 되는 version 이다.
type Revoked struct {
	Plugins  []RevokedPlugin  `json:"plugins"`
	Sidecars []RevokedSidecar `json:"sidecars"`
}

// Index 는 검사한 registry index 다.
type Index struct {
	Format   int               `json:"format"`
	Plugins  []RegistryPlugin  `json:"plugins"`
	Sidecars []RegistrySidecar `json:"sidecars"`
	Packs    []RegistryPack    `json:"packs"`
	Revoked  Revoked           `json:"revoked"`
}

// entryWhere 는 항목의 이름이 문자열이면 그것을 붙인 위치다.
func entryWhere(kind string, m map[string]any, key string) string {
	if name, ok := m[key].(string); ok {
		return kind + " " + name
	}
	return kind
}

// ValidateRegistryPlugin 은 registry 의 plugin 항목 하나(`plugins/<id>.json`)를 검사한다.
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
	if err := checkPackageName(where+" package", entry["package"]); err != nil {
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
		if err := only(where+" version", item, "engines", "package", "sidecars", "version"); err != nil {
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
		if err := checkArchive(where+" "+version+" package", item["package"]); err != nil {
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

// ValidateRegistrySidecar 는 registry 의 sidecar 항목 하나(`sidecars/<file name>.json`)를 검사한다.
func ValidateRegistrySidecar(value any) error {
	entry, err := object("registry sidecar", value)
	if err != nil {
		return err
	}
	where := entryWhere("registry sidecar", entry, "name")
	if err := only(where, entry, "name", "repository", "versions"); err != nil {
		return err
	}
	if err := checkPackageName(where+" name", entry["name"]); err != nil {
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
		if err := only(where+" version", item, "assets", "protocol", "version"); err != nil {
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
		assets, err := object(where+" "+version+" assets", item["assets"])
		if err != nil {
			return err
		}
		if len(assets) == 0 {
			return fmt.Errorf("%s %s: assets is empty", where, version)
		}
		for _, platform := range sortedKeys(assets) {
			if err := checkPlatform(platform); err != nil {
				return fmt.Errorf("%s %s: %w", where, version, err)
			}
			if err := checkArchive(where+" "+version+" "+platform, assets[platform]); err != nil {
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

// ValidateRegistryPack 은 registry 의 pack 항목 하나(`packs/<name>.json`)를 검사한다.
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

// ValidateRevoked 는 registry 의 revoked 목록(`revoked.json`)을 검사한다.
func ValidateRevoked(value any) error {
	revoked, err := object("registry revoked", value)
	if err != nil {
		return err
	}
	if err := only("registry revoked", revoked, "plugins", "sidecars"); err != nil {
		return err
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

// typed 는 검사한 값을 형식 구조체로 옮긴다.
func typed(value any, target any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return json.Unmarshal(data, target)
}

// ValidateRegistryIndex 는 registry index 를 검사한다. 항목마다 형식을 보고, 이름이 겹치지 않는지, pack 과
// revoked 가 있는 plugin 과 sidecar 를 가리키는지, plugin version 마다 필요한 sidecar 범위를 채우는 sidecar
// version 이 있는지 본다.
func ValidateRegistryIndex(value any) (*Index, error) {
	root, err := object("registry index", value)
	if err != nil {
		return nil, err
	}
	if err := only("registry index", root, "format", "packs", "plugins", "revoked", "sidecars"); err != nil {
		return nil, err
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

// InstalledPlugin 은 설치한 plugin 하나다. Path 는 설치가 쓰는 version 을 푼 폴더이며 설정 폴더에 대한 상대 경로다.
type InstalledPlugin struct {
	Package  string            `json:"package"`
	Version  string            `json:"version"`
	Path     string            `json:"path"`
	Enabled  bool              `json:"enabled"`
	Sidecars map[string]string `json:"sidecars"`
	Previous string            `json:"previous,omitempty"`
}

// InstalledSidecar 는 설치한 sidecar 하나다. Path 는 설치가 그 플랫폼 asset 을 푼 폴더이며 설정 폴더에 대한 상대
// 경로다.
type InstalledSidecar struct {
	Version string `json:"version"`
	Path    string `json:"path"`
}

// InstalledState 는 설치 상태 파일(`plugins/installed.json`)이다. plugin id 마다 package 이름, 쓰는 version, 푼
// 폴더, 켜짐 여부, 그 version 의 sidecar 범위, 되돌릴 이전 version 을 담고, sidecar 마다 모든 plugin 이 함께 쓰는
// version 하나와 그 폴더를 담는다. 폴더는 설치가 기록하며 host 는 기록된 폴더만 읽는다.
type InstalledState struct {
	Format   int                         `json:"format"`
	Plugins  map[string]InstalledPlugin  `json:"plugins"`
	Sidecars map[string]InstalledSidecar `json:"sidecars"`
}

// checkPluginFolder 는 plugin 의 path 가 설치 규칙의 폴더 plugins/<id>/<version> 인지 검사한다.
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

// checkSidecarFolder 는 sidecar 의 path 가 설치 규칙의 폴더 sidecars/<file name>/<version>/<platform> 인지 검사한다.
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

// ValidateInstalled 는 설치 상태 파일을 검사한다.
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
	packages := map[string]bool{}
	for _, id := range sortedKeys(plugins) {
		where := Installed + " " + id
		if !isIdentifier(id) {
			return nil, fmt.Errorf("%s: id must be a lowercase identifier", where)
		}
		item, err := object(where, plugins[id])
		if err != nil {
			return nil, err
		}
		if err := only(where, item, "enabled", "package", "path", "previous", "sidecars", "version"); err != nil {
			return nil, err
		}
		if _, ok := item["enabled"].(bool); !ok {
			return nil, fmt.Errorf("%s: enabled must be true or false", where)
		}
		if err := checkPackageName(where+" package", item["package"]); err != nil {
			return nil, err
		}
		name := item["package"].(string)
		if packages[name] {
			return nil, fmt.Errorf("%s: package %s is installed twice", where, name)
		}
		packages[name] = true
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

// SelectedSidecar 는 설치할 sidecar version 하나와 그 플랫폼 asset 이다.
type SelectedSidecar struct {
	Name    string
	Version string
	Asset   Archive
}

// Selection 은 설치할 plugin version 과 그 sidecar version 이다.
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

// newer 는 검사한 index 의 두 version 중 a 가 더 새 것인지 알려 준다.
func newer(a, b string) bool {
	x, errA := ParseVersion(a)
	y, errB := ParseVersion(b)
	// 기본값: 검사한 index 의 version 만 비교하므로 읽기 실패는 없으며, 읽지 못한 version 은 더 새 것으로 보지 않는다.
	return errA == nil && errB == nil && x.Compare(y) > 0
}

// ResolveInstall 은 설치할 plugin version 과 그 sidecar version 을 고른다. Plugin 은 engines.soksak 이 core 를
// 포함하고 revoked 가 아닌 가장 새 version 이다. Sidecar 는 한 설치에 version 하나이므로, 그 version 의 범위와
// installed 의 다른 plugin 이 지정한 범위를 모두 채워야 한다. 쓰고 있는 version 이 범위를 모두 채우고 revoked 가
// 아니며 platform asset 이 있으면 그대로 두고, 아니면 그런 version 중 가장 새 것을 고른다.
func ResolveInstall(index *Index, id, core, platform string, installed *InstalledState) (*Selection, error) {
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
		if Satisfies(core, item.Engines.Soksak) && !revokedPlugin(index, id, item.Version) && (chosen == nil || newer(item.Version, chosen.Version)) {
			chosen = item
		}
	}
	if chosen == nil {
		return nil, fmt.Errorf("plugin %s has no version for core %s", id, core)
	}
	selection := &Selection{Plugin: plugin, Version: chosen}
	for _, name := range sortedNames(chosen.Sidecars) {
		type need struct{ who, rng string }
		needs := []need{{id + " " + chosen.Version, chosen.Sidecars[name]}}
		for _, other := range sortedPluginIDs(installed.Plugins) {
			item := installed.Plugins[other]
			if rng, ok := item.Sidecars[name]; ok && other != id {
				needs = append(needs, need{other + " " + item.Version, rng})
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
			_, hasAsset := item.Assets[platform]
			fits := !slices.ContainsFunc(needs, func(n need) bool { return !Satisfies(item.Version, n.rng) })
			if !hasAsset || !fits || revokedSidecar(index, name, item.Version) {
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
			texts := make([]string, len(needs))
			for i, n := range needs {
				texts[i] = n.who + " needs " + n.rng
			}
			return nil, fmt.Errorf("sidecar %s has no version for %s that satisfies every installed plugin: %s", name, platform, strings.Join(texts, ", "))
		}
		if kept != nil {
			best = kept
		}
		selection.Sidecars = append(selection.Sidecars, SelectedSidecar{Name: name, Version: best.Version, Asset: best.Assets[platform]})
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
