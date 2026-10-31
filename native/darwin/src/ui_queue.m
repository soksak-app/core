#import <Foundation/Foundation.h>
#import "ui_queue.h"

void sp_ui_enqueue(void (*callback)(uintptr_t), uintptr_t context) {
    dispatch_async(dispatch_get_main_queue(), ^{ callback(context); });
}

void sp_ui_enqueue_after(uint64_t delay, void (*callback)(uintptr_t), uintptr_t context) {
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)delay), dispatch_get_main_queue(), ^{ callback(context); });
}
