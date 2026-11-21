//! sok is the command line of the Tauri application (docs/spec/cli.md).

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    // The identifier is the name of the default configuration folder (docs/spec/projects.md#persistence).
    let identifier = soksak_sok::identity::identity();
    if let Err(error) = soksak_sok::platform::current() {
        eprintln!("sok: {error}");
        std::process::exit(1);
    }
    // The variables of an agent that a surface started (docs/spec/cli.md#the-window-of-an-agent); a value that is not UTF-8 is
    // refused.
    let variable = |name: &str| match std::env::var(name) {
        Ok(value) => Some(value),
        Err(std::env::VarError::NotPresent) => None,
        Err(std::env::VarError::NotUnicode(_)) => {
            eprintln!("sok: {name} is not valid UTF-8");
            std::process::exit(1);
        }
    };
    let config_dir_variable = variable(soksak_sok::CONFIG_DIR_VARIABLE);
    let options = soksak_sok::Options {
        identifier,
        core_version: soksak_sok::version::CORE_VERSION,
        config_dir_variable: config_dir_variable.as_deref(),
    };
    let code = soksak_sok::run_logged(
        &args,
        &mut std::io::stdout(),
        &mut std::io::stderr(),
        &options,
    );
    std::process::exit(code);
}
