#import <Foundation/Foundation.h>

// Reads the body of an upload request of the binary store of a document region (docs/spec/native-surfaces.md#document-regions).
// The body is the HTTPBody of the request, returned without a copy, or the bytes of HTTPBodyStream, which WebKit sets when it
// sends the body as a stream. A stream is read to one chunk past limit at most, so a body over limit has a length over limit
// and the caller refuses it. Returns nil and sets error with the reason when the request has neither body or the stream fails
// to read; the error's localizedDescription is the reason.
NSData *sp_document_upload_body(NSURLRequest *request, NSUInteger limit, NSError **error);
