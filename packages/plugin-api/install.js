// 설치형 plugin 의 형식(docs/spec/installation.md): version 과 범위, plugin package, registry index, sidecar release
// asset, 설치 배치와 설치 상태. 형식이 틀리면 어디가 틀렸는지 담은 예외를 던지고, 맞으면 받은 값을 반환한다.

/** Registry index 와 설치 상태 파일의 형식 번호. */
export const INSTALL_FORMAT = 1;

/** Sidecar release asset 이 쓰는 플랫폼 key. `<os>-<arch>` 이다. */
export const PLATFORMS = Object.freeze([
  "darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "windows-arm64", "windows-x64",
]);

/** 설정 폴더 안에서 설치 상태를 담는 파일. */
export const INSTALLED = "plugins/installed.json";

const ID = /^[a-z][a-z0-9-]*$/;
const PACKAGE = /^(@[a-z0-9-]+\/)?[a-z0-9-]+$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHA256 = /^[0-9a-f]{64}$/;
const DESCRIPTION_MAX = 200;

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const isText = (value) => typeof value === "string" && value.length > 0;

function only(where, value, keys) {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw new Error(`${where}: unknown field ${key}`);
  }
}

function object(where, value) {
  if (!isObject(value)) throw new Error(`${where}: expected an object`);
  return value;
}

function array(where, value) {
  if (!Array.isArray(value)) throw new Error(`${where}: expected an array`);
  return value;
}

/** `x.y.z` version 을 [x, y, z] 로 읽는다. */
export function parseVersion(text) {
  const match = typeof text === "string" ? VERSION.exec(text) : null;
  if (!match) throw new Error(`invalid version ${JSON.stringify(text)}: expected x.y.z`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** 두 version 의 순서. a 가 앞이면 음수, 같으면 0, 뒤면 양수다. */
export function compareVersions(a, b) {
  const [x, y] = [parseVersion(a), parseVersion(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

const format = ([major, minor, patch]) => `${major}.${minor}.${patch}`;

/**
 * Version 범위를 { min, below } 로 읽는다. min 은 포함하는 하한, below 는 포함하지 않는 상한이다. 받는 형식은
 * `x.y.z`(그 version 만), `^x.y.z`(첫 0 이 아닌 자리가 같은 version), `~x.y.z`(major 와 minor 가 같은 version),
 * `>=x.y.z <a.b.c` 다.
 */
export function parseRange(text) {
  if (typeof text !== "string") throw new Error(`invalid version range ${JSON.stringify(text)}`);
  const bounded = /^>=(\S+) <(\S+)$/.exec(text);
  if (bounded) {
    parseVersion(bounded[1]);
    parseVersion(bounded[2]);
    if (compareVersions(bounded[1], bounded[2]) >= 0) throw new Error(`invalid version range ${text}: empty`);
    return { min: bounded[1], below: bounded[2] };
  }
  const operator = text[0] === "^" || text[0] === "~" ? text[0] : "";
  let parts;
  try {
    parts = parseVersion(text.slice(operator.length));
  } catch (error) {
    throw new Error(`invalid version range ${JSON.stringify(text)}: expected x.y.z, ^x.y.z, ~x.y.z or >=x.y.z <a.b.c`, { cause: error });
  }
  const [major, minor, patch] = parts;
  const min = format(parts);
  if (operator === "") return { min, below: format([major, minor, patch + 1]) };
  if (operator === "~") return { min, below: format([major, minor + 1, 0]) };
  if (major > 0) return { min, below: format([major + 1, 0, 0]) };
  if (minor > 0) return { min, below: format([0, minor + 1, 0]) };
  return { min, below: format([0, 0, patch + 1]) };
}

/** version 이 범위 안에 있는지. */
export function satisfies(version, range) {
  const { min, below } = parseRange(range);
  return compareVersions(version, min) >= 0 && compareVersions(version, below) < 0;
}

function checkVersion(where, value) {
  try {
    parseVersion(value);
  } catch (error) {
    throw new Error(`${where}: ${error.message}`, { cause: error });
  }
}

function checkRange(where, value) {
  try {
    parseRange(value);
  } catch (error) {
    throw new Error(`${where}: ${error.message}`, { cause: error });
  }
}

function checkPackageName(where, value) {
  if (!isText(value) || !PACKAGE.test(value)) throw new Error(`${where}: expected a package name`);
}

function checkSidecarRanges(where, sidecars) {
  object(where, sidecars);
  for (const [name, range] of Object.entries(sidecars)) {
    checkPackageName(`${where} ${name}`, name);
    checkRange(`${where} ${name}`, range);
  }
}

/** archive 의 주소. 0.0.2 는 local release 의 `file:` 과 게시한 release 의 `https:` 만 받는다. */
function checkArchive(where, archive) {
  object(where, archive);
  only(where, archive, ["url", "sha256"]);
  let url;
  try {
    url = new URL(archive.url);
  } catch (error) {
    throw new Error(`${where}: url is not a URL`, { cause: error });
  }
  if (url.protocol !== "file:" && url.protocol !== "https:") throw new Error(`${where}: url must be file: or https:`);
  if (typeof archive.sha256 !== "string" || !SHA256.test(archive.sha256)) {
    throw new Error(`${where}: sha256 must be 64 lowercase hexadecimal digits`);
  }
}

/**
 * Plugin package 의 `package.json` 에서 설치에 쓰는 필드를 검사한다. 다른 npm 필드는 package 도구의 것이므로 보지
 * 않는다.
 *
 *   name             package 이름. 설치한 파일은 `/modules/<name>/` 에 놓인다
 *   version          plugin version
 *   engines.soksak   plugin 이 지원하는 core API version 범위
 *   soksak.sidecars  plugin.json `sidecars` 의 각 sidecar 와 그 version 범위
 *   files            archive 에 넣는 파일과 폴더. plugin.json 을 포함한다
 */
export function validatePluginPackage(pkg) {
  object("package.json", pkg);
  checkPackageName("package.json name", pkg.name);
  checkVersion("package.json version", pkg.version);
  object("package.json engines", pkg.engines);
  checkRange("package.json engines.soksak", pkg.engines.soksak);
  if (pkg.soksak !== undefined) {
    object("package.json soksak", pkg.soksak);
    only("package.json soksak", pkg.soksak, ["sidecars"]);
    checkSidecarRanges("package.json soksak.sidecars", pkg.soksak.sidecars);
  }
  array("package.json files", pkg.files);
  if (pkg.files.some((file) => !isText(file) || file.startsWith("/") || file.split("/").includes(".."))) {
    throw new Error("package.json files: expected paths inside the package");
  }
  if (!pkg.files.includes("plugin.json")) throw new Error("package.json files: plugin.json is not listed");
  return pkg;
}

/**
 * Package 와 그 plugin.json 이 서로 맞는지 검사한다. plugin.json 이 쓰는 sidecar 마다 version 범위가 있어야 하고,
 * 범위만 있고 쓰지 않는 sidecar 는 없어야 한다.
 */
export function checkPackageManifest(pkg, manifest) {
  // 기본값: sidecar 를 쓰지 않는 plugin 은 plugin.json `sidecars` 와 package.json `soksak` 이 없다.
  const used = [...(manifest.sidecars ?? [])].sort();
  // 기본값: sidecar 를 쓰지 않는 plugin 은 package.json `soksak.sidecars` 가 없다.
  const ranged = Object.keys(pkg.soksak?.sidecars ?? {}).sort();
  if (JSON.stringify(used) !== JSON.stringify(ranged)) {
    throw new Error(`${pkg.name}: plugin.json sidecars ${JSON.stringify(used)} differ from package.json soksak.sidecars ${JSON.stringify(ranged)}`);
  }
}

/** Plugin package archive 의 파일 이름. */
export const pluginArchiveName = (id, version) => `${id}-${version}.tgz`;

/** Sidecar 이름을 파일 이름과 폴더 이름에 쓰는 형태로 바꾼다. `@scope/name` 은 `scope-name` 이 된다. */
export function sidecarFileName(name) {
  checkPackageName("sidecar", name);
  return name.startsWith("@") ? name.slice(1).replace("/", "-") : name;
}

/** Sidecar release asset 의 파일 이름. */
export function sidecarAssetName(name, version, platform) {
  checkVersion(`sidecar ${name} version`, version);
  if (!PLATFORMS.includes(platform)) throw new Error(`unknown platform ${platform}`);
  return `${sidecarFileName(name)}-${version}-${platform}.tar.gz`;
}

/** 설정 폴더 안에서 plugin version 하나를 푸는 폴더. */
export function pluginInstallPath(id, version) {
  if (!ID.test(id)) throw new Error(`invalid plugin id ${id}`);
  checkVersion(`plugin ${id} version`, version);
  return `plugins/${id}/${version}`;
}

/** 설정 폴더 안에서 sidecar version 하나의 플랫폼 asset 을 푸는 폴더. */
export function sidecarInstallPath(name, version, platform) {
  checkVersion(`sidecar ${name} version`, version);
  if (!PLATFORMS.includes(platform)) throw new Error(`unknown platform ${platform}`);
  return `sidecars/${sidecarFileName(name)}/${version}/${platform}`;
}

/** Registry 의 plugin 항목 하나(`plugins/<id>.json`). */
export function validateRegistryPlugin(entry) {
  object("registry plugin", entry);
  const where = `registry plugin ${entry.id}`;
  only(where, entry, ["id", "package", "name", "description", "license", "repository", "versions"]);
  if (!isText(entry.id) || !ID.test(entry.id)) throw new Error(`${where}: id must be a lowercase identifier`);
  checkPackageName(`${where} package`, entry.package);
  if (!isText(entry.name)) throw new Error(`${where}: name is required`);
  if (!isText(entry.description) || entry.description.length > DESCRIPTION_MAX) {
    throw new Error(`${where}: description must be 1 to ${DESCRIPTION_MAX} characters`);
  }
  if (!isText(entry.license)) throw new Error(`${where}: license is required`);
  if (!isText(entry.repository)) throw new Error(`${where}: repository is required`);
  const versions = new Set();
  for (const item of array(`${where} versions`, entry.versions)) {
    object(`${where} version`, item);
    only(`${where} version`, item, ["version", "package", "engines", "sidecars"]);
    checkVersion(`${where} version`, item.version);
    if (versions.has(item.version)) throw new Error(`${where}: version ${item.version} appears twice`);
    versions.add(item.version);
    checkArchive(`${where} ${item.version} package`, item.package);
    object(`${where} ${item.version} engines`, item.engines);
    only(`${where} ${item.version} engines`, item.engines, ["soksak"]);
    checkRange(`${where} ${item.version} engines.soksak`, item.engines.soksak);
    checkSidecarRanges(`${where} ${item.version} sidecars`, item.sidecars);
  }
  if (versions.size === 0) throw new Error(`${where}: versions is empty`);
  return entry;
}

/** Registry 의 sidecar 항목 하나(`sidecars/<name>.json`). */
export function validateRegistrySidecar(entry) {
  object("registry sidecar", entry);
  const where = `registry sidecar ${entry.name}`;
  only(where, entry, ["name", "repository", "versions"]);
  checkPackageName(`${where} name`, entry.name);
  if (!isText(entry.repository)) throw new Error(`${where}: repository is required`);
  const versions = new Set();
  for (const item of array(`${where} versions`, entry.versions)) {
    object(`${where} version`, item);
    only(`${where} version`, item, ["version", "protocol", "assets"]);
    checkVersion(`${where} version`, item.version);
    if (versions.has(item.version)) throw new Error(`${where}: version ${item.version} appears twice`);
    versions.add(item.version);
    if (item.protocol !== 1) throw new Error(`${where} ${item.version}: protocol must be 1`);
    object(`${where} ${item.version} assets`, item.assets);
    if (Object.keys(item.assets).length === 0) throw new Error(`${where} ${item.version}: assets is empty`);
    for (const [platform, asset] of Object.entries(item.assets)) {
      if (!PLATFORMS.includes(platform)) throw new Error(`${where} ${item.version}: unknown platform ${platform}`);
      checkArchive(`${where} ${item.version} ${platform}`, asset);
    }
  }
  if (versions.size === 0) throw new Error(`${where}: versions is empty`);
  return entry;
}

/** Registry 의 pack 항목 하나(`packs/<name>.json`). 함께 설치하는 plugin 의 id 를 담는다. */
export function validateRegistryPack(entry) {
  object("registry pack", entry);
  const where = `registry pack ${entry.name}`;
  only(where, entry, ["name", "description", "plugins"]);
  if (!isText(entry.name) || !ID.test(entry.name)) throw new Error(`${where}: name must be a lowercase identifier`);
  if (!isText(entry.description) || entry.description.length > DESCRIPTION_MAX) {
    throw new Error(`${where}: description must be 1 to ${DESCRIPTION_MAX} characters`);
  }
  const ids = array(`${where} plugins`, entry.plugins);
  if (ids.length === 0 || ids.some((id) => !isText(id) || !ID.test(id))) throw new Error(`${where}: plugins must be plugin ids`);
  if (new Set(ids).size !== ids.length) throw new Error(`${where}: duplicate plugin`);
  return entry;
}

function checkRevoked(revoked) {
  object("registry revoked", revoked);
  only("registry revoked", revoked, ["plugins", "sidecars"]);
  for (const [kind, key] of [["plugins", "id"], ["sidecars", "name"]]) {
    for (const item of array(`registry revoked ${kind}`, revoked[kind])) {
      object(`registry revoked ${kind}`, item);
      only(`registry revoked ${kind}`, item, [key, "version", "reason"]);
      if (!isText(item[key])) throw new Error(`registry revoked ${kind}: ${key} is required`);
      checkVersion(`registry revoked ${kind} ${item[key]}`, item.version);
      if (!isText(item.reason)) throw new Error(`registry revoked ${kind} ${item[key]}: reason is required`);
    }
  }
}

/**
 * Registry index 를 검사한다. 항목마다 형식을 보고, 이름이 겹치지 않는지, pack 과 revoked 가 있는 plugin 과 sidecar
 * 를 가리키는지, plugin version 마다 필요한 sidecar 범위를 채우는 sidecar version 이 있는지 본다.
 */
export function validateRegistryIndex(index) {
  object("registry index", index);
  only("registry index", index, ["format", "plugins", "sidecars", "packs", "revoked"]);
  if (index.format !== INSTALL_FORMAT) throw new Error(`registry index: format must be ${INSTALL_FORMAT}`);
  const plugins = new Map();
  const packages = new Set();
  for (const entry of array("registry index plugins", index.plugins)) {
    validateRegistryPlugin(entry);
    if (plugins.has(entry.id)) throw new Error(`registry index: plugin ${entry.id} appears twice`);
    if (packages.has(entry.package)) throw new Error(`registry index: package ${entry.package} appears twice`);
    plugins.set(entry.id, entry);
    packages.add(entry.package);
  }
  const sidecars = new Map();
  for (const entry of array("registry index sidecars", index.sidecars)) {
    validateRegistrySidecar(entry);
    if (sidecars.has(entry.name)) throw new Error(`registry index: sidecar ${entry.name} appears twice`);
    sidecars.set(entry.name, entry);
  }
  const packs = new Set();
  for (const entry of array("registry index packs", index.packs)) {
    validateRegistryPack(entry);
    if (packs.has(entry.name)) throw new Error(`registry index: pack ${entry.name} appears twice`);
    packs.add(entry.name);
    for (const id of entry.plugins) {
      if (!plugins.has(id)) throw new Error(`registry index: pack ${entry.name} names unknown plugin ${id}`);
    }
  }
  for (const plugin of plugins.values()) {
    for (const item of plugin.versions) {
      for (const [name, range] of Object.entries(item.sidecars)) {
        const sidecar = sidecars.get(name);
        if (!sidecar) throw new Error(`registry index: plugin ${plugin.id} ${item.version} needs unknown sidecar ${name}`);
        if (!sidecar.versions.some((candidate) => satisfies(candidate.version, range))) {
          throw new Error(`registry index: plugin ${plugin.id} ${item.version} needs ${name} ${range}, which no version satisfies`);
        }
      }
    }
  }
  checkRevoked(index.revoked);
  for (const item of index.revoked.plugins) {
    if (!plugins.get(item.id)?.versions.some((candidate) => candidate.version === item.version)) {
      throw new Error(`registry index: revoked plugin ${item.id} ${item.version} is not listed`);
    }
  }
  for (const item of index.revoked.sidecars) {
    if (!sidecars.get(item.name)?.versions.some((candidate) => candidate.version === item.version)) {
      throw new Error(`registry index: revoked sidecar ${item.name} ${item.version} is not listed`);
    }
  }
  return index;
}

const revokedPlugin = (index, id, version) => index.revoked.plugins.some((item) => item.id === id && item.version === version);
const revokedSidecar = (index, name, version) => index.revoked.sidecars.some((item) => item.name === name && item.version === version);
const newest = (items) => items.reduce((best, item) => (compareVersions(item.version, best.version) > 0 ? item : best));

/**
 * 설치할 plugin version 과 그 sidecar version 을 고른다. Plugin 은 engines.soksak 이 core 를 포함하고 revoked 가
 * 아닌 가장 새 version 이고, sidecar 는 그 범위를 채우고 platform asset 이 있으며 revoked 가 아닌 가장 새 version
 * 이다. 고를 수 없으면 이유를 담은 예외를 던진다. 반환값은 { plugin, version, sidecars: [{ name, version, asset }] } 다.
 */
export function resolveInstall(index, id, core, platform) {
  const plugin = index.plugins.find((entry) => entry.id === id);
  if (!plugin) throw new Error(`plugin ${id} is not in the registry`);
  const usable = plugin.versions.filter((item) => satisfies(core, item.engines.soksak) && !revokedPlugin(index, id, item.version));
  if (usable.length === 0) throw new Error(`plugin ${id} has no version for core ${core}`);
  const chosen = newest(usable);
  const sidecars = Object.entries(chosen.sidecars).map(([name, range]) => {
    const entry = index.sidecars.find((item) => item.name === name);
    const candidates = entry.versions.filter((item) => satisfies(item.version, range) && !revokedSidecar(index, name, item.version)
      && Object.hasOwn(item.assets, platform));
    if (candidates.length === 0) throw new Error(`plugin ${id} ${chosen.version} needs ${name} ${range}, which has no version for ${platform}`);
    const version = newest(candidates);
    return { name, version: version.version, asset: version.assets[platform] };
  });
  return { plugin, version: chosen, sidecars };
}

/**
 * 설치 상태 파일(`plugins/installed.json`). plugin id 마다 package 이름, 쓰는 version, 켜짐 여부, 되돌릴 이전
 * version 을 담는다.
 */
export function validateInstalled(installed) {
  object(INSTALLED, installed);
  only(INSTALLED, installed, ["format", "plugins"]);
  if (installed.format !== INSTALL_FORMAT) throw new Error(`${INSTALLED}: format must be ${INSTALL_FORMAT}`);
  object(`${INSTALLED} plugins`, installed.plugins);
  const packages = new Set();
  for (const [id, item] of Object.entries(installed.plugins)) {
    const where = `${INSTALLED} ${id}`;
    if (!ID.test(id)) throw new Error(`${where}: id must be a lowercase identifier`);
    object(where, item);
    only(where, item, ["package", "version", "enabled", "previous"]);
    checkPackageName(`${where} package`, item.package);
    if (packages.has(item.package)) throw new Error(`${where}: package ${item.package} is installed twice`);
    packages.add(item.package);
    checkVersion(`${where} version`, item.version);
    if (typeof item.enabled !== "boolean") throw new Error(`${where}: enabled must be true or false`);
    if (item.previous !== undefined) checkVersion(`${where} previous`, item.previous);
  }
  return installed;
}
