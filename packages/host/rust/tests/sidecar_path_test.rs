// Checks the record of the folder that the environment of every sidecar puts first on PATH (docs/spec/sidecars.md#processes-of-a-surface).
// The test is the only test of its binary, so no other test of the process records the event while it reads the log.
#[path = "support/folder.rs"]
mod folder;
#[path = "support/records.rs"]
mod records;

use serde_json::{Value, json};
use soksak_host::installed;
use soksak_host::sidecars::{Failure, Message, Owner};

#[derive(Clone)]
struct Window;

impl Owner for Window {
    fn key(&self) -> String {
        "a".into()
    }
    fn root(&self) -> Result<String, String> {
        Ok("/projects/a".into())
    }
    fn deliver(&self, _message: Message) {}
    fn deliver_failure(&self, failure: Failure) {
        panic!("unexpected sidecar failure: {failure:?}");
    }
}

// contract: sidecars.environment.start-records-the-sok-folder
#[test]
fn the_start_records_the_folder_that_the_sidecars_put_first_on_path() {
    let logs = folder::Folder::new();
    let log = records::start_writer(logs.path());
    let executable = std::env::current_exe().unwrap();
    let folder = executable.parent().unwrap();
    let config = folder::Folder::new();
    let sidecars = installed::new_installed_sidecars::<Window>(config.path().to_path_buf())
        .unwrap_or_else(|error| panic!("the start failed: {error}"));
    sidecars.stop();
    log.flush().unwrap();
    soksak_host::event_record::use_host_event_log(None);
    let recorded: Vec<Value> = records::read_events(&records::event_log_path(logs.path()))
        .into_iter()
        .filter(|event| event["event"] == "host.sidecar.path")
        .map(|event| json!([event["level"], event["fields"]]))
        .collect();
    assert_eq!(
        recorded,
        [json!([
            "info",
            {
                "folder": folder.display().to_string(),
                "sok": folder.join("sok").display().to_string()
            }
        ])]
    );
}
