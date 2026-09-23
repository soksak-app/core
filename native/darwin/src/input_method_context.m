// 입력기 이벤트를 전달하는 동안을 알려 주는 텍스트 입력 컨텍스트.

#import "input_method_context.h"
#import "private/appkit.h"

@implementation SPInputMethodContext {
    NSUInteger depth;
}

+ (BOOL)observesInputMethodEvents {
    return [NSTextInputContext instancesRespondToSelector:@selector(handleTSMEvent:completionHandler:)];
}

- (BOOL)handlingInputMethodEvent {
    return depth > 0;
}

- (void)performInputMethodEvent:(void (^)(void))event {
    depth++;
    event();
    depth--;
}

// 입력기 이벤트의 전달은 바꾸지 않고, 전달하는 동안만 표시한다.
- (void)handleTSMEvent:(void *)event completionHandler:(id)completion {
    [self performInputMethodEvent:^{
        [super handleTSMEvent:event completionHandler:completion];
    }];
}

@end
