// Private WebKit declarations that this library and its checks use.
// List and conditions of use: docs/operations/private-native-apis.md
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

#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
@interface WKProcessPool (SPPrivate)
// WKProcessPoolPrivate.h: makes the WebContent processes of the pool collect JavaScript objects (for tests).
- (void)_garbageCollectJavaScriptObjectsForTesting;
@end
#pragma clang diagnostic pop

// WKNavigationDelegatePrivate.h: policy that makes a navigation proceed in a new WebContent process.
static const WKNavigationActionPolicy SPNavigationActionPolicyAllowInNewProcess = (WKNavigationActionPolicy)(WKNavigationActionPolicyAllow + 3);

@interface WKWebView (SPPrivate)
@property(nonatomic, readonly) pid_t _webProcessIdentifier;
// WKWebViewPrivate.h: terminates the current WebContent process so that a reload starts a new process.
- (void)_killWebContentProcessAndResetState;
// WKWebViewPrivate.h
- (void)_setOverrideDeviceScaleFactor:(double)scale;
- (void)_doAfterNextPresentationUpdate:(void (^)(void))completion;
// WKWebViewPrivate.h: releases the previous document and its process that were kept paused for back and forward navigation.
- (void)_clearBackForwardCache;
// WKWebViewPrivate.h (mac)
- (void)_setIgnoresMouseMoveEvents:(BOOL)ignore;
@property (nonatomic, setter=_setWindowOcclusionDetectionEnabled:) BOOL _windowOcclusionDetectionEnabled;
- (void)_setShouldSuppressFirstResponderChanges:(BOOL)suppress;
// WKWebViewPrivate.h: for inspector checks only
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
