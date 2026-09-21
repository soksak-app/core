use soksak_host_tauriv2::clipboard::{validate_png_payload, validate_read_request};

#[test]
fn clipboard_requires_explicit_user_paste_and_known_type() {
    assert!(validate_read_request("text", true).is_ok());
    assert!(validate_read_request("text", false).is_err());
    assert!(validate_read_request("unknown", true).is_err());
    assert!(validate_read_request("fileURLs", true).is_ok());
}

#[test]
fn clipboard_png_payload_is_bounded() {
    assert!(validate_png_payload(b"png").is_ok());
    assert!(validate_png_payload(&[]).is_err());
    assert!(validate_png_payload(&vec![0; 16 * 1024 * 1024 + 1]).is_err());
}
