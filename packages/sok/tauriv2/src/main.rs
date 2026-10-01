//! sok 은 Tauri 애플리케이션의 command line 이다(docs/spec/cli.md).

/// Tauri 애플리케이션의 식별자이며 기본 설정 폴더의 이름이다(docs/spec/projects.md).
const IDENTIFIER: &str = "com.soksak.tauri";

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let code = soksak_sok::run(
        &args,
        &mut std::io::stdout(),
        &mut std::io::stderr(),
        IDENTIFIER,
    );
    std::process::exit(code);
}
