//! 애플리케이션 식별자와 이전 설정 폴더를 옮기는 규칙(docs/spec/projects.md#persistence)을 검사한다.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

use soksak_sok::identity::{identity, move_former_config_dir};

static NEXT: AtomicUsize = AtomicUsize::new(0);

/// 검사마다 고유한 임시 폴더.
struct Dir(PathBuf);

impl Dir {
    fn new() -> Dir {
        let path = std::env::temp_dir().join(format!(
            "sok-identity{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::SeqCst)
        ));
        std::fs::create_dir_all(&path).expect("create temporary directory");
        Dir(path.canonicalize().expect("canonical temporary directory"))
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for Dir {
    fn drop(&mut self) {
        // 테스트 뒤 정리다. 지우지 못한 폴더는 다음 테스트에 영향을 주지 않는 고유 이름이다.
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

// contract: cli.identity.build-identifier
#[test]
fn the_build_identifier_follows_the_build() {
    if cfg!(feature = "diagnostics") {
        assert_eq!(identity(), ("app.soksak.tauri.dev", None));
    } else {
        assert_eq!(identity(), ("app.soksak.tauri", Some("com.soksak.tauri")));
    }
}

// contract: cli.identity.moves-only-the-former-directory
#[test]
fn the_former_directory_moves_once() {
    let base = Dir::new();
    let former = base.path().join("com.soksak.former");
    let current = base.path().join("app.soksak.current");
    std::fs::create_dir(&former).expect("former");
    std::fs::write(former.join("projects.json"), "{}").expect("projects.json");
    let moved =
        move_former_config_dir(base.path(), Some("com.soksak.former"), "app.soksak.current");
    assert_eq!(moved, Ok(Some(former.clone())));
    assert_eq!(
        std::fs::read_to_string(current.join("projects.json")).expect("current projects.json"),
        "{}"
    );
    assert!(!former.exists(), "the former directory remains");
    // 두 번째 시작은 옮길 것이 없다.
    let moved =
        move_former_config_dir(base.path(), Some("com.soksak.former"), "app.soksak.current");
    assert_eq!(moved, Ok(None));
    // 이전 식별자가 없는 build 는 아무것도 옮기지 않는다.
    std::fs::create_dir(&former).expect("former again");
    assert_eq!(
        move_former_config_dir(base.path(), None, "app.soksak.current"),
        Ok(None)
    );
}

// contract: cli.identity.refuses-both-directories
#[test]
fn both_directories_are_refused() {
    let base = Dir::new();
    let former = base.path().join("com.soksak.former");
    let current = base.path().join("app.soksak.current");
    std::fs::create_dir(&former).expect("former");
    std::fs::create_dir(&current).expect("current");
    let moved =
        move_former_config_dir(base.path(), Some("com.soksak.former"), "app.soksak.current");
    assert_eq!(
        moved,
        Err(format!(
            "{} and {} both exist; move or remove {}",
            former.display(),
            current.display(),
            former.display()
        ))
    );
    assert!(former.is_dir() && current.is_dir());
}

// contract: cli.config-dir.refuses-an-unmoved-former-directory
#[test]
fn sok_refuses_an_unmoved_former_directory() {
    // 이 실행 파일에서 HOME 을 읽는 검사는 이것뿐이다.
    let home = Dir::new();
    std::env::set_var("HOME", home.path());
    let base = soksak_sok::platform::current()
        .expect("platform")
        .config_dir()
        .expect("configuration directory");
    let former = base.join("com.soksak.former");
    let current = base.join("app.soksak.current");
    std::fs::create_dir_all(&former).expect("former");
    let paths = Dir::new();
    let run = |args: &[&str]| -> (i32, String) {
        let args: Vec<String> = args.iter().map(|arg| arg.to_string()).collect();
        let (mut stdout, mut stderr) = (Vec::new(), Vec::new());
        let options = soksak_sok::Options {
            identifier: "app.soksak.current",
            former: Some("com.soksak.former"),
            paths_dir: paths.path(),
            core_version: "0.0.2",
        };
        let code = soksak_sok::run(&args, &mut stdout, &mut stderr, &options);
        (code, String::from_utf8(stderr).expect("stderr"))
    };
    let want = format!(
        "sok: {} has not been moved; start the application once to move it to {}\n",
        former.display(),
        current.display()
    );
    for args in [&["windows"][..], &["plugin", "list"], &["core.page.audit"]] {
        assert_eq!(run(args), (1, want.clone()), "{args:?}");
    }
    assert!(!current.exists(), "sok created the current directory");
    std::fs::create_dir(&current).expect("current");
    let (code, stderr) = run(&["windows"]);
    assert_eq!(code, 1);
    assert!(
        stderr.starts_with(&format!(
            "sok: {} and {} both exist; move or remove {}\n",
            former.display(),
            current.display(),
            former.display()
        )),
        "{stderr}"
    );
}

// contract: cli.identity.refuses-a-former-directory-in-use
#[test]
fn a_former_directory_in_use_is_refused() {
    let base = Dir::new();
    let former = base.path().join("com.soksak.former");
    let current = base.path().join("app.soksak.current");
    std::fs::create_dir(&former).expect("former");
    // 이 테스트 프로세스는 실행 중이다.
    let lock = former.join("process.lock");
    std::fs::write(&lock, std::process::id().to_string()).expect("lock");
    let moved =
        move_former_config_dir(base.path(), Some("com.soksak.former"), "app.soksak.current");
    assert_eq!(
        moved,
        Err(format!(
            "{} is in use by process {}; quit that application first",
            former.display(),
            std::process::id()
        ))
    );
    assert!(!current.exists(), "the current directory exists");
    // 끝난 프로세스의 lock 은 폴더와 함께 옮겨진다.
    let mut ended = std::process::Command::new("true").spawn().expect("true");
    let pid = ended.id();
    ended.wait().expect("wait");
    std::fs::write(&lock, pid.to_string()).expect("ended lock");
    let moved =
        move_former_config_dir(base.path(), Some("com.soksak.former"), "app.soksak.current");
    assert_eq!(moved, Ok(Some(former.clone())));
    assert!(
        current.join("process.lock").exists(),
        "the ended lock did not move"
    );
}
