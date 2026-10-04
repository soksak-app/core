//! 이 command line 의 경로 항목(docs/spec/cli.md)을 쓰고 지운다. 항목은 paths.d 폴더의 <identifier> 파일이며 sok
//! 이 있는 폴더를 한 줄로 담는다.

use std::io::{ErrorKind, Write};

use serde_json::json;

use crate::{Error, Options};

pub(crate) fn run_path(
    action: &str,
    stdout: &mut dyn Write,
    options: &Options,
) -> Result<(), Error> {
    let file = options.paths_dir.clone()?.join(options.identifier);
    match action {
        "install" => {
            let executable = std::env::current_exe()
                .and_then(|path| path.canonicalize())
                .map_err(|error| format!("the location of sok is unknown: {error}"))?;
            let directory = executable
                .parent()
                .ok_or_else(|| "the location of sok has no directory".to_string())?
                .display()
                .to_string();
            std::fs::write(&file, format!("{directory}\n")).map_err(|error| {
                format!(
                    "cannot write {}; run sudo sok path install",
                    crate::files::file_error(file.display(), &error)
                )
            })?;
            let out = serde_json::to_string_pretty(
                &json!({"path": file.display().to_string(), "directory": directory}),
            )
            .map_err(|error| error.to_string())?;
            writeln!(stdout, "{out}").map_err(|error| error.to_string())?;
            Ok(())
        }
        "remove" => {
            match std::fs::remove_file(&file) {
                Ok(()) => {}
                Err(error) if error.kind() == ErrorKind::NotFound => {}
                Err(error) => {
                    return Err(Error::Failed(format!(
                        "cannot remove {}; run sudo sok path remove",
                        crate::files::file_error(file.display(), &error)
                    )))
                }
            }
            writeln!(stdout, "null").map_err(|error| error.to_string())?;
            Ok(())
        }
        _ => Err(Error::Usage(format!("unknown path action: {action}"))),
    }
}
