// Private Launch Services declarations used only by process-label checks.
// The intended call sequence and scope are listed in docs/operations/private-native-apis.md.
#import <ApplicationServices/ApplicationServices.h>
#import <CoreServices/CoreServices.h>

typedef const struct CF_BRIDGED_TYPE(id) __LSASN *SPLSASNRef;
typedef int32_t SPLSSessionID;

static const SPLSSessionID SPLSDefaultSessionID = -2;

extern OSStatus _RegisterApplication(CFDictionaryRef applicationInfo, ProcessSerialNumber *processSerialNumber);
extern SPLSASNRef _LSGetCurrentApplicationASN(void);
extern OSStatus _LSSetApplicationInformationItem(SPLSSessionID sessionID, SPLSASNRef asn, CFStringRef key,
    CFTypeRef value, CFDictionaryRef *newInformation);
extern CFTypeRef _LSCopyApplicationInformationItem(SPLSSessionID sessionID, SPLSASNRef asn, CFTypeRef key);
extern const CFStringRef _kLSDisplayNameKey;
