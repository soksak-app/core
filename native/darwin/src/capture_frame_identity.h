#import <CoreGraphics/CoreGraphics.h>
#import <Foundation/Foundation.h>

typedef struct {
    uint64_t generation;
    uint64_t raster;
    uint64_t sequence;
} SPCaptureFrameIdentity;

// Adds a diagnostic QR identity to a copied BGRA raster inside roi. The caller retains its original bytes and
// color metadata separately. On success, image and instrumentedBGRA are owned by the caller; on failure, error
// contains a caller-owned description.
bool sp_capture_frame_identity_encode(const uint8_t *bgra, size_t width, size_t height, size_t row_bytes,
    CGColorSpaceRef color_space, CGRect roi, NSString *nonce, SPCaptureFrameIdentity identity,
    CGImageRef *image, NSData **instrumented_bgra, NSString **payload, NSString **error);

// Decodes only a complete QR code wholly contained in roi. issued_payloads contains the canonical payload strings
// issued for the recording. An absent or ambiguous identity returns false with unknown_reason; API failures return
// false with error.
bool sp_capture_frame_identity_decode(CGImageRef image, CGRect roi, NSSet<NSString *> *issued_payloads,
    SPCaptureFrameIdentity *identity, NSString **unknown_reason, NSString **error);
