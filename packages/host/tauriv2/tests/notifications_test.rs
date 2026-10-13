#[path = "support/records.rs"]
mod records;

use soksak_host_tauriv2::notifications::{
    NotificationRequest, record_event, validate_notification,
};

fn request(surface: &str, title: &str, body: &str) -> NotificationRequest {
    NotificationRequest {
        surface: surface.into(),
        title: title.into(),
        body: body.into(),
    }
}

// contract: notifications.request.accepts-tab-notices
#[test]
fn notification_accepts_tab_notices() {
    let notice = request("tab-1", &"t".repeat(256), &"한".repeat(1024));
    assert!(
        validate_notification(&notice, false).is_ok(),
        "a tab notice was rejected"
    );
    assert!(
        validate_notification(&request("tab-1", "", ""), true).is_ok(),
        "a removal with only the surface was rejected"
    );
}

// contract: notifications.request.rejects-invalid-fields
#[test]
fn notification_rejects_invalid_fields() {
    let long_title = "t".repeat(257);
    for (field, invalid) in [
        ("surface", request("", "title", "body")),
        ("title", request("tab-1", &long_title, "body")),
        ("body", request("tab-1", "title", "a\nb")),
    ] {
        let error = validate_notification(&invalid, false).expect_err(field);
        assert!(
            error.contains(field),
            "an invalid {field} was not rejected by name: {error}"
        );
    }
    let error =
        validate_notification(&request(&"s".repeat(257), "", ""), true).expect_err("surface");
    assert!(error.contains("surface"), "{error}");
    assert!(validate_notification(&request("tab-1", "title", &"b".repeat(1025)), false).is_err());
}

// contract: notifications.event.records-each-event-and-failure
#[test]
fn each_notification_event_and_failure_is_recorded() {
    // The writer of the records belongs to the process, so the scenario runs in a child process.
    if let Some(config) = std::env::var_os("SOKSAK_NOTIFICATION_CHILD") {
        let config = std::path::PathBuf::from(config);
        let writer = records::start_writer(&config);
        for raw in [
            r#"{"type":"state","authorization":"granted","error":null}"#,
            r#"{"type":"state","authorization":"denied","error":"post refused"}"#,
            r#"{"type":"posted","identifier":"[\"w1\",\"tab-1\"]"}"#,
            r#"{"type":"activated","identifier":"nope"}"#,
            "not json",
            r#"{"type":"other"}"#,
        ] {
            let _ = record_event(raw);
        }
        writer.flush(std::time::Duration::from_secs(5)).unwrap();
        return;
    }
    let config = tempfile::tempdir().unwrap();
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "each_notification_event_and_failure_is_recorded",
            "--nocapture",
        ])
        .env("SOKSAK_NOTIFICATION_CHILD", config.path())
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "the child check failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let events = records::read_events(&records::event_log_path(config.path()));
    let seen: Vec<String> = events
        .iter()
        .filter(|event| event["event"] == "host.notification.event")
        .map(|event| {
            let fields = &event["fields"];
            ["type", "authorization", "window", "surface"]
                .map(|name| fields[name].as_str().unwrap())
                .join("|")
        })
        .collect();
    assert_eq!(
        seen,
        ["state|granted||", "state|denied||", "posted||w1|tab-1"]
    );
    let failures: Vec<&str> = events
        .iter()
        .filter(|event| {
            event["event"] == "host.record.error" && event["fields"]["where"] == "notification"
        })
        .map(|event| event["fields"]["text"].as_str().unwrap())
        .collect();
    let wants = [
        "post refused",
        "activated notification \"nope\" has no window and surface",
        "notification event \"not json\"",
        "has an unknown type",
    ];
    assert_eq!(
        failures.len(),
        wants.len(),
        "notification failures {failures:?}"
    );
    for (failure, want) in failures.iter().zip(wants) {
        assert!(
            failure.contains(want),
            "{failure:?} does not contain {want:?}"
        );
    }
}
