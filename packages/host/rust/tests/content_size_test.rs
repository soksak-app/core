//! The content size of host.window.resize (docs/spec/exposure.md#host-entries).

use serde_json::Value;
use soksak_host::exposure::content_size;

/// Reads the params of each case of docs/spec/cases/window-resize.json as host.window.resize reads them.
// contract: exposure.window-resize.bound-and-text
#[test]
fn the_content_size_of_each_case() {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../docs/spec/cases/window-resize.json"
    );
    let file: Value = serde_json::from_str(
        &std::fs::read_to_string(path).expect("window-resize.json is readable"),
    )
    .expect("window-resize.json is JSON");
    let mut failures = Vec::new();
    for case in file["cases"].as_array().expect("cases is a list") {
        let name = case["name"].as_str().expect("a case has a name");
        let params = case["params"].as_object().expect("a case has params");
        let got = content_size(params);
        match case["error"].as_str() {
            None => {
                let want = (
                    params["width"].as_f64().unwrap(),
                    params["height"].as_f64().unwrap(),
                );
                if got.as_ref().ok() != Some(&want) {
                    failures.push(format!(
                        "{name}: read {:?}, want {want:?}",
                        got.map_err(|f| f.message)
                    ));
                }
            }
            Some(text) => match got {
                Err(failure) if failure.code == -32602 && failure.message == text => {}
                other => failures.push(format!(
                    "{name}: read {:?}, want -32602 {text:?}",
                    other.map_err(|f| f.message)
                )),
            },
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
