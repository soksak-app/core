//! 설정 폴더에 설치된 plugin 을 페이지에 제공하고 그 sidecar 를 찾는다(docs/spec/installation.md 의 설치된 plugin
//! 제공). 파일은 설치가 installed.json 에 기록한 폴더에서만 읽는다. 설치 상태는 요청마다 읽으므로 변경 뒤에 불러온
//! 페이지는 그 변경을 본다. 형식 검사는 command line sok 의 구현을 쓴다.

use std::borrow::Cow;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

use serde::Serialize;
use serde_json::value::RawValue;
use soksak_sok::install::{self, InstalledState, INSTALLED};

use crate::sidecars::SidecarDeclaration;

/// 페이지가 설치된 plugin 목록을 읽는 경로.
pub const INSTALLED_PLUGINS_PATH: &str = "/installed-plugins.json";

/// 켜진 설치 plugin 하나와 그 파일 폴더.
struct InstalledPlugin {
    id: String,
    package: String,
    version: String,
    dir: PathBuf,
}

/// plugins/installed.json 을 읽고 검사한다. 파일이 없으면 아무것도 설치하지 않은 상태다.
fn read_installed_state(config_dir: &Path) -> Result<InstalledState, String> {
    let file = config_dir.join(INSTALLED);
    let text = match std::fs::read_to_string(&file) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(InstalledState::empty())
        }
        Err(error) => return Err(format!("{}: {error}", file.display())),
    };
    let value: serde_json::Value = serde_json::from_str(&text)
        .map_err(|error| format!("{} is not valid JSON: {error}", file.display()))?;
    install::validate_installed(&value).map_err(|error| format!("{}: {error}", file.display()))
}

/// 켜진 설치 plugin 을 id 순서로 돌려준다.
fn enabled_plugins(config_dir: &Path) -> Result<(Vec<InstalledPlugin>, InstalledState), String> {
    let state = read_installed_state(config_dir)?;
    let mut plugins = vec![];
    for (id, plugin) in &state.plugins {
        if !plugin.enabled {
            continue;
        }
        plugins.push(InstalledPlugin {
            id: id.clone(),
            package: plugin.package.clone(),
            version: plugin.version.clone(),
            dir: PathBuf::from(&plugin.path),
        });
    }
    plugins.sort_by(|a, b| a.id.cmp(&b.id));
    Ok((plugins, state))
}

/// JSON 텍스트에서 문자열 밖의 공백을 지운다. 키 순서와 문자열은 그대로 둔다.
fn compact(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let (mut quoted, mut escaped) = (false, false);
    for c in text.chars() {
        if quoted {
            out.push(c);
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == '"' {
                quoted = false;
            }
        } else if c == '"' {
            quoted = true;
            out.push(c);
        } else if !c.is_whitespace() {
            out.push(c);
        }
    }
    out
}

/// /installed-plugins.json 의 내용. plugin 마다 설치된 plugin.json 을 manifest 로 담아 page 가 첫 화면 전에 plugin 을
/// 등록하게 한다. 설치 상태를 읽을 수 없으면 { "error" } 문서다.
pub fn installed_plugins_document(config_dir: &Path, diagnostics: bool) -> Vec<u8> {
    #[derive(Serialize)]
    struct Entry {
        id: String,
        package: String,
        version: String,
        manifest: Box<RawValue>,
        #[serde(skip_serializing_if = "Option::is_none")]
        diagnostics: Option<Box<RawValue>>,
    }
    let failure = |error: String| {
        serde_json::to_vec(&serde_json::json!({ "error": error }))
            // 기본값: 문자열 하나의 직렬화는 실패하지 않으며, 실패하면 고정된 오류 문서를 쓴다.
            .unwrap_or_else(|_| br#"{"error":"the error text cannot be encoded"}"#.to_vec())
    };
    let plugins = match enabled_plugins(config_dir) {
        Ok((plugins, _)) => plugins,
        Err(error) => return failure(error),
    };
    let mut entries = vec![];
    for plugin in plugins {
        let manifest_file = plugin.dir.join("plugin.json");
        let manifest = match std::fs::read_to_string(&manifest_file) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return failure(format!(
                    "{}: the plugin manifest is missing",
                    manifest_file.display()
                ));
            }
            Err(error) => return failure(format!("{}: {error}", manifest_file.display())),
            Ok(text) => match RawValue::from_string(compact(&text)) {
                Ok(raw) if serde_json::from_str::<serde_json::Value>(raw.get()).is_ok() => raw,
                _ => return failure(format!("{} is not valid JSON", manifest_file.display())),
            },
        };
        let mut entry = Entry {
            id: plugin.id,
            package: plugin.package,
            version: plugin.version,
            manifest,
            diagnostics: None,
        };
        if diagnostics {
            let file = plugin.dir.join("diagnostics.json");
            match std::fs::read_to_string(&file) {
                // 기본값: diagnostics.json 이 없는 plugin 은 진단 선언이 없다.
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return failure(format!("{}: {error}", file.display())),
                Ok(text) => match RawValue::from_string(compact(&text)) {
                    Ok(raw) if serde_json::from_str::<serde_json::Value>(raw.get()).is_ok() => {
                        entry.diagnostics = Some(raw)
                    }
                    _ => return failure(format!("{} is not valid JSON", file.display())),
                },
            }
        }
        entries.push(entry);
    }
    #[derive(Serialize)]
    struct Document {
        plugins: Vec<Entry>,
    }
    match serde_json::to_vec(&Document { plugins: entries }) {
        Ok(data) => data,
        Err(error) => failure(error.to_string()),
    }
}

/// /modules/<package>/<path> 가 무엇을 가리키는지.
#[derive(Debug, PartialEq)]
pub enum Module {
    /// 애플리케이션 frontend 의 package 다.
    Frontend,
    /// 켜진 설치 plugin 의 package 지만 파일이 없거나 경로가 틀렸다.
    Missing,
    /// 켜진 설치 plugin 의 파일이다.
    File(PathBuf),
}

/// /modules/<package>/<path> 가 켜진 설치 plugin 의 파일이면 그 경로를 돌려준다.
pub fn installed_module(config_dir: &Path, url_path: &str) -> Result<Module, String> {
    let Some(rest) = url_path.strip_prefix("/modules/") else {
        return Ok(Module::Frontend);
    };
    let parts: Vec<&str> = rest.split('/').collect();
    let count = if parts[0].starts_with('@') { 2 } else { 1 };
    if parts.len() <= count {
        return Ok(Module::Frontend);
    }
    let name = parts[..count].join("/");
    let (plugins, _) = enabled_plugins(config_dir)?;
    let Some(plugin) = plugins.iter().find(|plugin| plugin.package == name) else {
        return Ok(Module::Frontend);
    };
    let inside = &parts[count..];
    if inside
        .iter()
        .any(|part| part.is_empty() || *part == "." || *part == "..")
    {
        return Ok(Module::Missing);
    }
    let file = inside
        .iter()
        .fold(plugin.dir.clone(), |path, part| path.join(part));
    if file.is_file() {
        Ok(Module::File(file))
    } else {
        Ok(Module::Missing)
    }
}

/// 켜진 설치 plugin 의 plugin.json 이 지정한 sidecar 를 설치가 기록한 폴더와 함께 돌려준다.
pub fn installed_sidecars(config_dir: &Path) -> Result<Vec<SidecarDeclaration>, String> {
    #[derive(serde::Deserialize)]
    struct Manifest {
        // 기본값: sidecar 를 쓰지 않는 plugin 의 plugin.json 에는 sidecars 가 없다.
        #[serde(default)]
        sidecars: Vec<String>,
    }
    let (plugins, state) = enabled_plugins(config_dir)?;
    let mut declarations: Vec<SidecarDeclaration> = vec![];
    for plugin in plugins {
        let file = plugin.dir.join("plugin.json");
        let text = std::fs::read_to_string(&file)
            .map_err(|error| format!("{}: {error}", file.display()))?;
        let manifest: Manifest =
            serde_json::from_str(&text).map_err(|error| format!("{}: {error}", file.display()))?;
        for name in manifest.sidecars {
            if declarations.iter().any(|item| item.name == name) {
                continue;
            }
            let sidecar = state.sidecars.get(&name).ok_or_else(|| {
                format!(
                    "{}: sidecar {name} has no installed version",
                    file.display()
                )
            })?;
            let folder = PathBuf::from(&sidecar.path);
            let declaration = folder.join("sidecar.json");
            let data = std::fs::read(&declaration)
                .map_err(|error| format!("{}: {error}", declaration.display()))?;
            declarations.push(SidecarDeclaration { name, folder, data });
        }
    }
    Ok(declarations)
}

/// 아무 asset 도 없는 provider. frontend asset 을 InstalledAssets 로 옮기는 동안 Context 에 둔다.
pub struct NoAssets;

impl<R: tauri::Runtime> tauri::Assets<R> for NoAssets {
    fn get(&self, _key: &tauri::utils::assets::AssetKey) -> Option<Cow<'_, [u8]>> {
        None
    }

    fn iter(&self) -> Box<tauri::utils::assets::AssetsIter<'_>> {
        Box::new(std::iter::empty())
    }

    fn csp_hashes(
        &self,
        _html_path: &tauri::utils::assets::AssetKey,
    ) -> Box<dyn Iterator<Item = tauri::utils::assets::CspHash<'_>> + '_> {
        Box::new(std::iter::empty())
    }
}

/// 설치된 plugin 을 제공하는 asset provider. 다른 경로는 애플리케이션 frontend 가 제공한다. 설정 폴더는 host 의
/// setup 이 정한다.
pub struct InstalledAssets<R: tauri::Runtime> {
    pub frontend: Box<dyn tauri::Assets<R>>,
    pub config_dir: Arc<OnceLock<PathBuf>>,
    pub diagnostics: bool,
}

impl<R: tauri::Runtime> tauri::Assets<R> for InstalledAssets<R> {
    fn get(&self, key: &tauri::utils::assets::AssetKey) -> Option<Cow<'_, [u8]>> {
        let path = key.as_ref();
        let Some(config_dir) = self.config_dir.get() else {
            eprintln!("{path}: the configuration directory is not ready");
            return None;
        };
        if path == INSTALLED_PLUGINS_PATH {
            return Some(Cow::Owned(installed_plugins_document(
                config_dir,
                self.diagnostics,
            )));
        }
        match installed_module(config_dir, path) {
            Ok(Module::Frontend) => self.frontend.get(key),
            Ok(Module::Missing) => None,
            Ok(Module::File(file)) => match std::fs::read(&file) {
                Ok(data) => Some(Cow::Owned(data)),
                Err(error) => {
                    eprintln!("{path}: {}: {error}", file.display());
                    None
                }
            },
            Err(error) => {
                eprintln!("{path}: {error}");
                None
            }
        }
    }

    fn iter(&self) -> Box<tauri::utils::assets::AssetsIter<'_>> {
        self.frontend.iter()
    }

    fn csp_hashes(
        &self,
        html_path: &tauri::utils::assets::AssetKey,
    ) -> Box<dyn Iterator<Item = tauri::utils::assets::CspHash<'_>> + '_> {
        self.frontend.csp_hashes(html_path)
    }
}
