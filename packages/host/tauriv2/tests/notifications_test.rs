use soksak_host_tauriv2::notifications::{validate_notification, NotificationRequest};

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
