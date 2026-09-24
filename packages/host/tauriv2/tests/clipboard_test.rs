use soksak_host_tauriv2::clipboard::{validate_png_payload, validate_read_request};

// contract: clipboard.read.requires-user-initiated, clipboard.read.rejects-unknown-type, clipboard.read.accepts-known-types
#[test]
fn clipboard_requires_explicit_user_paste_and_known_type() {
    assert!(validate_read_request("text", true).is_ok());
    assert!(validate_read_request("text", false).is_err());
    assert!(validate_read_request("unknown", true).is_err());
    assert!(validate_read_request("fileURLs", true).is_ok());
}

/// 1x1 RGBA PNG. IHDR 의 CRC 는 0x1F15C489 다.
const PNG: &[u8] = &[
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4,
    0x89, 0x00, 0x00, 0x00, 0x0A, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0x00, 0x01, 0x00, 0x00,
    0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE,
    0x42, 0x60, 0x82,
];

// contract: clipboard.png.rejects-oversize, clipboard.png.rejects-empty, clipboard.png.accepts-valid-within-bound
#[test]
fn clipboard_png_payload_is_bounded() {
    assert!(validate_png_payload(PNG).is_ok());
    assert!(validate_png_payload(&[]).is_err());
    let mut large = PNG.to_vec();
    large.resize(16 * 1024 * 1024 + 1, 0);
    assert!(validate_png_payload(&large).is_err());
}

// contract: clipboard.png.rejects-bad-signature, clipboard.png.rejects-bad-header
#[test]
fn clipboard_png_payload_needs_the_signature_and_a_valid_header() {
    let error = validate_png_payload(b"png").unwrap_err();
    assert!(error.contains("PNG signature"), "{error}");
    let mut header = PNG.to_vec();
    header[12] = b'X';
    let mut crc = PNG.to_vec();
    crc[29] ^= 0xFF;
    let mut width = PNG.to_vec();
    width[16..20].copy_from_slice(&[0, 0, 0, 0]);
    let mut depth = PNG.to_vec();
    depth[24] = 3;
    for bytes in [&PNG[..20], &header[..], &crc[..], &width[..], &depth[..]] {
        let error = validate_png_payload(bytes).unwrap_err();
        assert!(error.contains("PNG header"), "{error}");
    }
}
