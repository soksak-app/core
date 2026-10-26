#import <Foundation/Foundation.h>

// Encodes one view-channel body in its message envelope. The result is autoreleased;
// the callback borrows its UTF-8 bytes while delivering the message.
NSString *sp_document_view_message_json(id body);
