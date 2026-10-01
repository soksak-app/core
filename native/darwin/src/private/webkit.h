// 이 라이브러리와 검사가 사용하는 WebKit 비공개 선언이다.
// 목록과 사용 조건: docs/operations/private-native-apis.md
#import <WebKit/WebKit.h>

// _WKInspector.h
@protocol SPInspector <NSObject>
- (void)connect;
- (void)show;
- (void)attach;
- (void)close;
@property (nonatomic, readonly, getter=isVisible) BOOL visible;
@property (nonatomic, readonly, getter=isConnected) BOOL connected;
@property (nonatomic, readonly) WKWebView *inspectorWebView;
@end

// _WKFeature.h
@interface _WKFeature : NSObject
@property (nonatomic, readonly, copy) NSString *key;
@end

@interface WKPreferences (SPPrivate)
// WKPreferencesPrivate.h
+ (NSArray<_WKFeature *> *)_features;
- (BOOL)_isEnabledForFeature:(_WKFeature *)feature;
- (void)_setEnabled:(BOOL)value forFeature:(_WKFeature *)feature;
@end

@interface WKWebView (SPPrivate)
@property(nonatomic, readonly) pid_t _webProcessIdentifier;
// WKWebViewPrivate.h: terminate the current WebContent process so a reload can start a fresh process.
- (void)_killWebContentProcessAndResetState;
// WKWebViewPrivate.h
- (void)_setOverrideDeviceScaleFactor:(double)scale;
- (void)_doAfterNextPresentationUpdate:(void (^)(void))completion;
// WKWebViewPrivate.h (mac)
- (void)_setIgnoresMouseMoveEvents:(BOOL)ignore;
@property (nonatomic, setter=_setWindowOcclusionDetectionEnabled:) BOOL _windowOcclusionDetectionEnabled;
- (void)_setShouldSuppressFirstResponderChanges:(BOOL)suppress;
// WKWebViewPrivate.h: 인스펙터 검사 전용
@property (nonatomic, readonly) id<SPInspector> _inspector;
// WKWebViewPrivateForTesting.h
- (void)_doAfterActivityStateUpdate:(void (^)(void))completion;
- (void)_doAfterProcessingAllPendingMouseEvents:(void (^)(void))completion;
@end

// _WKWebsiteDataStoreConfiguration.h
@interface _WKWebsiteDataStoreConfiguration : NSObject
- (instancetype)initWithDirectory:(NSURL *)directory;
@end

// WKWebsiteDataStorePrivate.h
@interface WKWebsiteDataStore (SPPrivate)
- (instancetype)_initWithConfiguration:(_WKWebsiteDataStoreConfiguration *)configuration;
@end
