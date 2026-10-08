//! Writes plugin releases and sidecar releases (docs/spec/cli.md). Both are gzip-compressed tar files whose entries
//! are in path order with modification time 0, owner 0 and mode 0644 or 0755. A failure leaves no file.

use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use crate::install::{self, check_platform};
use crate::{platform, Error};

/// release 에 넣는 파일 하나. path 는 폴더 기준 상대 경로이며 / 로 나눈다.
struct ReleaseEntry {
    path: String,
    source: PathBuf,
    executable: bool,
}

/// sok 이 실행되는 플랫폼 key.
pub fn current_platform() -> Result<String, String> {
    platform::current()?.key()
}

fn leaves(path: &str) -> bool {
    path.is_empty() || path.starts_with('/') || path.split('/').any(|part| part == "..")
}

/// package.json 과 files 의 경로를 release 항목으로 모은다. 폴더는 그 아래 파일까지 모으고, symbolic link 나 일반
/// 파일도 폴더도 아닌 파일은 거부한다.
fn collect(dir: &Path, listed: &[String]) -> Result<Vec<ReleaseEntry>, String> {
    fn add(
        dir: &Path,
        path: String,
        entries: &mut BTreeMap<String, ReleaseEntry>,
    ) -> Result<(), String> {
        if entries.contains_key(&path) {
            return Ok(());
        }
        let source = dir.join(&path);
        let info = std::fs::symlink_metadata(&source)
            .map_err(|error| crate::files::file_error(&path, &error))?;
        let kind = info.file_type();
        if kind.is_symlink() {
            return Err(format!(
                "{path} is a symbolic link; an release holds no links"
            ));
        }
        if kind.is_dir() {
            let mut children = vec![];
            for child in std::fs::read_dir(&source)
                .map_err(|error| crate::files::file_error(&path, &error))?
            {
                let child = child.map_err(|error| crate::files::file_error(&path, &error))?;
                let name = child
                    .file_name()
                    .into_string()
                    .map_err(|name| format!("{path}/{name:?} is not a UTF-8 name"))?;
                children.push(name);
            }
            children.sort();
            for name in children {
                add(dir, format!("{path}/{name}"), entries)?;
            }
            return Ok(());
        }
        if !kind.is_file() {
            return Err(format!("{path} is neither a regular file nor a directory"));
        }
        let executable = platform::current()?.executable(&info);
        entries.insert(
            path.clone(),
            ReleaseEntry {
                path,
                source,
                executable,
            },
        );
        Ok(())
    }
    let mut entries = BTreeMap::new();
    for path in std::iter::once("package.json").chain(listed.iter().map(String::as_str)) {
        // 기본값: 끝의 / 는 폴더를 가리키는 표기일 뿐이므로 없으면 경로를 그대로 쓴다.
        let path = path.strip_suffix('/').unwrap_or(path);
        if leaves(path) {
            return Err(format!("{path} leaves the directory"));
        }
        add(dir, path.to_string(), &mut entries)?;
    }
    Ok(entries.into_values().collect())
}

/// 같은 폴더의 임시 파일에 쓴 뒤 이름을 바꿔 path 를 한 번에 바꾼다. write 가 실패하면 임시 파일을 지운다.
fn replace_with(
    path: &Path,
    write: impl FnOnce(&mut std::fs::File) -> Result<(), String>,
) -> Result<(), String> {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| format!("{} has no file name", path.display()))?;
    let temp = path.with_file_name(format!(".{file_name}.{}", std::process::id()));
    let result = std::fs::File::create(&temp)
        .map_err(|error| crate::files::file_error(temp.display(), &error))
        .and_then(|mut file| {
            let written = write(&mut file).and_then(|()| {
                file.sync_all()
                    .map_err(|error| crate::files::file_error(temp.display(), &error))
            });
            let closed = crate::platform::current()?.close_file(file, &temp);
            match (written, closed) {
                (Err(error), Err(close)) => Err(format!("{error}; close {close}")),
                (Err(error), Ok(())) => Err(error),
                (Ok(()), closed) => closed,
            }
        })
        .and_then(|()| {
            std::fs::rename(&temp, path)
                .map_err(|error| crate::files::file_error(path.display(), &error))
        });
    result.map_err(|error| {
        crate::files::with_cleanup(error, &temp, |path| std::fs::remove_file(path))
    })
}

/// data 로 path 를 한 번에 바꾼다.
pub fn replace_file(path: &Path, data: &[u8]) -> Result<(), String> {
    replace_with(path, |file| {
        file.write_all(data).map_err(|error| error.to_string())
    })
}

/// 항목을 output 에 쓰고 그 sha256 을 돌려준다.
fn write_release(entries: &[ReleaseEntry], output: &Path) -> Result<String, String> {
    let mut sum = String::new();
    replace_with(output, |file| {
        let hashing = HashingWriter {
            inner: file,
            hash: Sha256::new(),
        };
        let zipped = flate2::GzBuilder::new()
            .mtime(0)
            .write(hashing, flate2::Compression::default());
        let mut release = tar::Builder::new(zipped);
        for entry in entries {
            let data = std::fs::read(&entry.source)
                .map_err(|error| crate::files::file_error(&entry.path, &error))?;
            let mut header = tar::Header::new_ustar();
            header.set_entry_type(tar::EntryType::Regular);
            header.set_size(data.len() as u64);
            header.set_mode(if entry.executable { 0o755 } else { 0o644 });
            header.set_mtime(0);
            header.set_uid(0);
            header.set_gid(0);
            release
                .append_data(&mut header, &entry.path, data.as_slice())
                .map_err(|error| crate::files::file_error(&entry.path, &error))?;
        }
        let zipped = release.into_inner().map_err(|error| error.to_string())?;
        let hashing = zipped.finish().map_err(|error| error.to_string())?;
        sum = hex(&hashing.hash.finalize());
        Ok(())
    })?;
    Ok(sum)
}

/// 쓴 byte 의 sha256 을 함께 계산한다.
struct HashingWriter<'a> {
    inner: &'a mut std::fs::File,
    hash: Sha256,
}

impl Write for HashingWriter<'_> {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let written = self.inner.write(buf)?;
        self.hash.update(&buf[..written]);
        Ok(written)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.inner.flush()
    }
}

/// byte 를 소문자 16진수로 쓴다.
pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// 폴더의 JSON 파일 하나를 읽는다.
pub fn read_json_file(dir: &Path, name: &str) -> Result<Value, String> {
    let path = dir.join(name);
    let text = std::fs::read_to_string(&path)
        .map_err(|error| crate::files::file_error(path.display(), &error))?;
    serde_json::from_str(&text)
        .map_err(|error| format!("{} is not valid JSON: {error}", path.display()))
}

/// 결과를 두 칸 들여쓰기로 쓴다.
pub fn print_json<T: serde::Serialize + ?Sized>(
    stdout: &mut dyn Write,
    value: &T,
) -> Result<(), String> {
    let text = serde_json::to_string_pretty(value).map_err(|error| error.to_string())?;
    writeln!(stdout, "{text}").map_err(|error| error.to_string())
}

/// 출력 폴더를 만들고 그 안의 절대 경로를 돌려준다.
fn output_path(dir: &str, name: &str) -> Result<PathBuf, String> {
    let absolute = std::path::absolute(dir).map_err(|error| format!("{dir}: {error}"))?;
    std::fs::create_dir_all(&absolute)
        .map_err(|error| crate::files::file_error(absolute.display(), &error))?;
    Ok(absolute.join(name))
}

fn listed_files(pkg: &Map<String, Value>) -> Result<Vec<String>, String> {
    let files = pkg
        .get("files")
        .and_then(Value::as_array)
        .ok_or("package.json files: expected an array")?;
    let mut listed = vec![];
    for file in files {
        match file.as_str() {
            Some(path) if !leaves(path) => listed.push(path.to_string()),
            _ => return Err("package.json files: expected paths inside the package".into()),
        }
    }
    Ok(listed)
}

/// plugin 폴더를 검사하고 `<id>-<version>.tgz` 를 쓴다.
/// files 의 경로 하나가 path 이거나 path 를 담은 폴더인지.
fn covers(listed: &[String], path: &str) -> bool {
    listed.iter().any(|file| {
        // 기본값: 끝의 / 는 폴더를 가리키는 표기일 뿐이므로 없으면 경로를 그대로 쓴다.
        let folder = format!("{}/", file.strip_suffix('/').unwrap_or(file));
        path == file || path.starts_with(&folder)
    })
}

/// plugin.json 이 불러오는 module 과 그 이름: surface, section 마다의 module, state.
fn manifest_modules(manifest: &Value) -> Vec<(String, String)> {
    let mut modules = vec![];
    let mut add = |what: String, value: &Value| {
        if let Some(module) = value.as_str() {
            modules.push((what, module.to_string()));
        }
    };
    add("surface module".into(), &manifest["surface"]["module"]);
    for section in manifest["sections"].as_array().into_iter().flatten() {
        let what = match section["id"].as_str() {
            Some(id) => format!("section {id} module"),
            None => "section module".to_string(),
        };
        if section["module"].is_object() {
            add(what.clone(), &section["module"]["horizontal"]);
            add(what, &section["module"]["vertical"]);
        } else {
            add(what, &section["module"]);
        }
    }
    add("state module".into(), &manifest["state"]["module"]);
    modules
}

/// plugin 폴더의 diagnostics.json 과 그 module 경로. diagnostics.json 이 없으면 비어 있다. 두 파일은 files 에
/// 나열하지 않는다(docs/spec/plugins.md).
fn diagnostic_files(dir: &Path, listed: &[String]) -> Result<Vec<String>, String> {
    if !dir.join("diagnostics.json").exists() {
        return Ok(vec![]);
    }
    let declared = read_json_file(dir, "diagnostics.json")?;
    if !declared.is_object() {
        return Err("diagnostics.json: expected an object".into());
    }
    let Some(module) = declared["module"]
        .as_str()
        .filter(|module| !leaves(module) && module.ends_with(".js"))
    else {
        return Err("diagnostics.json: module must be a JavaScript path inside the package".into());
    };
    for path in ["diagnostics.json", module] {
        if covers(listed, path) {
            return Err(format!(
                "package.json files: {path} is diagnostic and must not be listed"
            ));
        }
    }
    Ok(vec!["diagnostics.json".into(), module.to_string()])
}

/// plugin 폴더를 검사하고 `<id>-<version>.tgz` 를 쓴다. diagnostics 가 참이면 진단 선언도 담는다.
fn run_pack(dir: &str, out: &str, diagnostics: bool, stdout: &mut dyn Write) -> Result<(), String> {
    let dir = Path::new(dir);
    let pkg = read_json_file(dir, "package.json")?;
    install::validate_package_json(&pkg)?;
    let manifest = read_json_file(dir, "plugin.json")?;
    if !manifest.is_object() {
        return Err("plugin.json: expected an object".into());
    }
    let Some(id) = manifest["id"]
        .as_str()
        .filter(|id| install::is_identifier(id))
    else {
        return Err("plugin.json: id must be a lowercase identifier".into());
    };
    install::manifest_dependencies(&manifest)?;
    let object = pkg.as_object().ok_or("package.json: expected an object")?;
    let mut listed = listed_files(object)?;
    for (what, module) in manifest_modules(&manifest) {
        if !covers(&listed, &module) {
            return Err(format!(
                "plugin.json: {what} {module} must be listed in files"
            ));
        }
    }
    let extra = diagnostic_files(dir, &listed)?;
    if diagnostics {
        listed.extend(extra);
    }
    let entries = collect(dir, &listed)?;
    let version = pkg["version"]
        .as_str()
        .ok_or("package.json version: expected x.y.z")?;
    let output = output_path(out, &install::release_name(id, version))?;
    let sum = write_release(&entries, &output)?;
    print_json(
        stdout,
        &json!({"id": id, "version": version, "release": output.display().to_string(), "sha256": sum}),
    )
}

/// SHA256SUMS 를 release 이름마다 sha256 으로 읽는다. 파일이 없으면 빈 목록이다.
fn read_sums(path: &Path) -> Result<BTreeMap<String, String>, String> {
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(BTreeMap::new()),
        Err(error) => return Err(crate::files::file_error(path.display(), &error)),
    };
    let mut sums = BTreeMap::new();
    // 기본값: 마지막 줄 끝의 줄바꿈은 선택이므로 없으면 텍스트를 그대로 나눈다.
    let body = text.strip_suffix('\n').unwrap_or(&text);
    for (i, line) in body.split('\n').enumerate() {
        match line.split_once("  ") {
            Some((hash, name)) if install::is_sha256(hash) && !name.is_empty() => {
                sums.insert(name.to_string(), hash.to_string());
            }
            _ => {
                return Err(format!(
                    "{} line {} is not \"<sha256>  <release name>\"",
                    path.display(),
                    i + 1
                ))
            }
        }
    }
    Ok(sums)
}

/// SHA256SUMS 를 release 이름 순서로 쓴다.
fn write_sums(path: &Path, sums: &BTreeMap<String, String>) -> Result<(), String> {
    let text: String = sums
        .iter()
        .map(|(name, hash)| format!("{hash}  {name}\n"))
        .collect();
    replace_with(path, |file| {
        file.write_all(text.as_bytes())
            .map_err(|error| error.to_string())
    })
}

/// Checks a sidecar folder, writes its release and updates SHA256SUMS.
fn run_release(dir: &str, out: &str, platform: &str, stdout: &mut dyn Write) -> Result<(), String> {
    let dir = Path::new(dir);
    let pkg = read_json_file(dir, "package.json")?;
    let object = pkg.as_object().ok_or("package.json: expected an object")?;
    let name = install::check_package_json_name("package.json name", object.get("name"))?;
    let version = install::check_version("package.json version", object.get("version"))?;
    let listed = listed_files(object)?;
    let declaration = read_json_file(dir, "sidecar.json")?;
    if !declaration.is_object() {
        return Err("sidecar.json: expected an object".into());
    }
    let Some(executable) = declaration["executable"]
        .as_str()
        .filter(|path| !path.is_empty())
    else {
        return Err("sidecar.json: executable is required".into());
    };
    for required in ["sidecar.json", executable] {
        if !listed.iter().any(|path| path == required) {
            return Err(format!("package.json files: {required} is not listed"));
        }
    }
    let asset = install::sidecar_asset_name(name, version, platform)?;
    let entries = collect(dir, &listed)?;
    let output = output_path(out, &asset)?;
    // SHA256SUMS 를 먼저 읽으므로 그 파일이 틀리면 release 를 쓰지 않는다.
    let sums_path = output.with_file_name("SHA256SUMS");
    let mut sums = read_sums(&sums_path)?;
    let sum = write_release(&entries, &output)?;
    sums.insert(asset, sum.clone());
    write_sums(&sums_path, &sums)?;
    print_json(
        stdout,
        &json!({"name": name, "version": version, "platform": platform,
            "release": output.display().to_string(), "sha256": sum}),
    )
}

/// 실행 중인 애플리케이션 없이 파일을 쓰는 plugin, sidecar 명령을 실행한다.
pub(crate) fn run_files(
    positionals: &[String],
    values: &std::collections::HashMap<String, String>,
    stdout: &mut dyn Write,
    diagnostics: bool,
) -> Result<(), Error> {
    let kind = &positionals[0];
    let action = positionals
        .get(1)
        .ok_or_else(|| Error::Usage(format!("{kind} action is required")))?;
    let command = format!("{kind} {action}");
    if command != "plugin pack" && command != "sidecar release" {
        return Err(Error::Usage(format!("unknown command: {command}")));
    }
    let dir = positionals
        .get(2)
        .ok_or_else(|| Error::Usage("directory is required".into()))?;
    let out = positionals
        .get(3)
        .ok_or_else(|| Error::Usage("output directory is required".into()))?;
    if let Some(extra) = positionals.get(4) {
        return Err(Error::Usage(format!("unexpected argument {extra}")));
    }
    if command == "plugin pack" {
        return Ok(run_pack(dir, out, diagnostics, stdout)?);
    }
    if diagnostics {
        return Err(Error::Usage("--diagnostics belongs to plugin pack".into()));
    }
    let platform = match values.get("platform") {
        Some(platform) => {
            check_platform(platform)
                .map_err(|error| Error::Usage(format!("--platform: {error}")))?;
            platform.clone()
        }
        None => current_platform()?,
    };
    Ok(run_release(dir, out, &platform, stdout)?)
}
