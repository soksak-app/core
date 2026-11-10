#import <Foundation/Foundation.h>
#import "ui_queue.h"

void sp_ui_enqueue(void (*callback)(uintptr_t), uintptr_t context) {
    dispatch_async(dispatch_get_main_queue(), ^{ callback(context); });
}
