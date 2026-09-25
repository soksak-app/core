use soksak_host_tauriv2::link::validate_link;

// contract: links.open.accepts-web-and-mail-schemes
#[test]
fn link_open_accepts_web_and_mail_urls() {
    for value in [
        "http://example.test/a",
        "https://example.test/a?b=c#d",
        "mailto:someone@example.test",
    ] {
        assert!(validate_link(value).is_ok(), "{value} was rejected");
    }
}

// contract: links.open.rejects-other-schemes
#[test]
fn link_open_rejects_other_urls() {
    let long = format!("https://example.test/{}", "a".repeat(8192));
    for value in [
        "file:///etc/hosts",
        "javascript:alert(1)",
        "ssh://host",
        "relative/path",
        "",
        "https://",
        "mailto:",
        "http://%zz",
        long.as_str(),
    ] {
        assert!(validate_link(value).is_err(), "{value:?} was accepted");
    }
}
