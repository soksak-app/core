#import <CoreGraphics/CoreGraphics.h>
#import <Foundation/Foundation.h>

typedef struct {
    uint64_t generation;
    uint64_t raster;
    uint64_t sequence;
} SPCaptureFrameIdentity;

// Parses a canonical, nonzero decimal uint64 field used by the current identity artifact format.
bool sp_capture_frame_identity_parse_canonical_uint64(NSString *field, uint64_t *value);

// Creates the canonical nonce and source identity payload without rendering an image. On success, payload is
// caller-owned and error is NULL. On failure, payload is NULL and error is caller-owned.
bool sp_capture_frame_identity_payload(NSString *nonce, SPCaptureFrameIdentity identity,
    NSString **payload, NSString **error);

// Adds a diagnostic QR identity to a copied BGRA raster inside an integer top-left pixel ROI. The nonce must be
// unique to one capture and region. The caller retains its original bytes and color metadata separately. On success,
// image, immutable instrumentedBGRA, and payload are owned by the caller; on failure, error is caller-owned.
bool sp_capture_frame_identity_encode(const uint8_t *bgra, size_t width, size_t height, size_t row_bytes,
    CGColorSpaceRef color_space, CGRect roi, NSString *nonce, SPCaptureFrameIdentity identity,
    CGImageRef *image, NSData **instrumented_bgra, NSString **payload, NSString **error);

// Decodes only complete QR codes inside an integer top-left pixel ROI from a BGRA raster. issued_payloads contains
// only canonical payloads issued for the expected capture and region. Success writes identity. Unknown or ambiguous
// results return false with caller-owned unknown_reason; API failures return false with caller-owned error.
bool sp_capture_frame_identity_decode(const uint8_t *bgra, size_t byte_length, size_t width, size_t height,
    size_t row_bytes, CGRect roi, NSSet<NSString *> *issued_payloads,
    SPCaptureFrameIdentity *identity, NSString **unknown_reason, NSString **error);
#ifdef SOKSAK_DIAGNOSTIC
void sp_capture_frame_identity_test_set_decode_hook(bool (*hook)(void));
#endif
