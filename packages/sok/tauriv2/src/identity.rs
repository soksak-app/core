//! 애플리케이션 식별자와 이전 설정 폴더(docs/spec/projects.md#persistence). 식별자는 기본 설정 폴더의 이름이고
//! 경로 항목의 파일 이름이다. 진단 build 는 release 애플리케이션의 데이터를 쓰지 않도록 .dev 를 붙인다.

use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use crate::files::{file_error, os_reason};

/// release build 의 식별자이며 번들 식별자.
pub const RELEASE_IDENTIFIER: &str = "app.soksak.tauri";
/// 0.0.2 까지의 release 설정 폴더 이름.
pub const FORMER_IDENTIFIER: &str = "com.soksak.tauri";

/// 이 build 의 식별자와, release host 가 시작할 때 옮기는 이전 식별자. 진단 build 는 이전 식별자가 없다.
pub fn identity() -> (&'static str, Option<&'static str>) {
    if cfg!(feature = "diagnostics") {
        ("app.soksak.tauri.dev", None)
    } else {
        (RELEASE_IDENTIFIER, Some(FORMER_IDENTIFIER))
    }
}

/// base 아래 former 폴더만 있으면 그것을 identifier 폴더로 이름을 바꾸고 이전 경로를 돌려준다. 옮길 것이 없으면
/// None 이고, 두 폴더가 모두 있으면 오류다. former 가 None 이면 아무것도 하지 않는다.
pub fn move_former_config_dir(
    base: &Path,
    former: Option<&str>,
    identifier: &str,
) -> Result<Option<PathBuf>, String> {
    let Some(former) = former else {
        return Ok(None);
    };
    let (from, to) = (base.join(former), base.join(identifier));
    if !former_exists(&from, &to)? {
        return Ok(None);
    }
    former_in_use(&from)?;
    std::fs::rename(&from, &to).map_err(|error| {
        format!(
            "cannot move {} to {}: {}",
            from.display(),
            to.display(),
            os_reason(&error)
        )
    })?;
    Ok(Some(from))
}

/// sok 이 기본 설정 폴더를 쓰기 전에 옮기지 않은 이전 폴더가 없는지 확인한다. sok 은 폴더를 옮기거나 만들지 않는다.
pub(crate) fn check_former_config_dir(
    base: &Path,
    former: Option<&str>,
    identifier: &str,
) -> Result<(), String> {
    let Some(former) = former else {
        return Ok(());
    };
    let (from, to) = (base.join(former), base.join(identifier));
    if former_exists(&from, &to)? {
        return Err(format!(
            "{} has not been moved; start the application once to move it to {}",
            from.display(),
            to.display()
        ));
    }
    Ok(())
}

/// 이전 폴더만 있는지 알려 준다. 두 폴더가 모두 있으면 오류다.
fn former_exists(from: &Path, to: &Path) -> Result<bool, String> {
    if !path_exists(from)? {
        return Ok(false);
    }
    if path_exists(to)? {
        return Err(format!(
            "{} and {} both exist; move or remove {}",
            from.display(),
            to.display(),
            from.display()
        ));
    }
    Ok(true)
}

/// 이전 폴더의 process.lock 이 실행 중인 프로세스를 가리키면 오류다. 끝난 프로세스의 lock 은 폴더와 함께 옮겨지고
/// 엔드포인트가 교체한다(docs/spec/endpoint.md).
fn former_in_use(from: &Path) -> Result<(), String> {
    let lock = from.join("process.lock");
    let contents = match std::fs::read_to_string(&lock) {
        Ok(contents) => contents,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(file_error(lock.display(), &error)),
    };
    let pid = contents
        .trim()
        .parse::<i32>()
        .ok()
        .filter(|pid| *pid > 0)
        .ok_or_else(|| format!("{}: invalid process lock", lock.display()))?;
    if crate::platform::current()?.process_running(pid).is_ok() {
        return Err(format!(
            "{} is in use by process {pid}; quit that application first",
            from.display()
        ));
    }
    Ok(())
}

fn path_exists(path: &Path) -> Result<bool, String> {
    match std::fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(false),
        Err(error) => Err(file_error(path.display(), &error)),
    }
}
