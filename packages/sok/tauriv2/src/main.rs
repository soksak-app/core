//! sok 은 Tauri 애플리케이션의 command line 이다(docs/spec/cli.md).

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    // 식별자는 기본 설정 폴더와 경로 항목의 이름이다(docs/spec/projects.md#persistence).
    let (identifier, former) = soksak_sok::identity::identity();
    let paths = match soksak_sok::platform::current() {
        Ok(platform) => platform.paths_dir(),
        Err(error) => {
            eprintln!("sok: {error}");
            std::process::exit(1);
        }
    };
    let options = soksak_sok::Options {
        identifier,
        former,
        paths_dir: paths.as_deref().map_err(Clone::clone),
        core_version: soksak_sok::version::CORE_VERSION,
    };
    let code = soksak_sok::run(
        &args,
        &mut std::io::stdout(),
        &mut std::io::stderr(),
        &options,
    );
    std::process::exit(code);
}
