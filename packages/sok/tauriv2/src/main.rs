//! sok is the command line of the Tauri application (docs/spec/cli.md).

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    // The identifier is the name of the default configuration folder and of the path entry (docs/spec/projects.md#persistence).
    let identifier = soksak_sok::identity::identity();
    let paths = match soksak_sok::platform::current() {
        Ok(platform) => platform.paths_dir(),
        Err(error) => {
            eprintln!("sok: {error}");
            std::process::exit(1);
        }
    };
    let options = soksak_sok::Options {
        identifier,
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
