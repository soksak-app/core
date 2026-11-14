// The transfer images of the fixture: global IOSurfaces of BGRA pixels that carry their 16-byte nonce under the key soksak.frame
// and declare the sRGB color space (docs/spec/sidecars.md#image-envelope, docs/spec/native-surfaces.md#image-regions). The host
// looks a surface up by its global id and compares the nonce before it presents it.
use std::ffi::{CString, c_char, c_void};

use crate::raster::{Scene, paint};

type CFTypeRef = *const c_void;
type CFStringRef = *const c_void;
type CFDictionaryRef = *const c_void;
type IOSurfaceRef = *mut c_void;

#[repr(C)]
struct Opaque([u8; 0]);

#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    static kCFTypeDictionaryKeyCallBacks: Opaque;
    static kCFTypeDictionaryValueCallBacks: Opaque;
    static kCFBooleanTrue: CFTypeRef;
    fn CFDictionaryCreate(
        allocator: CFTypeRef,
        keys: *const CFTypeRef,
        values: *const CFTypeRef,
        count: isize,
        key_callbacks: *const Opaque,
        value_callbacks: *const Opaque,
    ) -> CFDictionaryRef;
    fn CFNumberCreate(allocator: CFTypeRef, kind: isize, value: *const c_void) -> CFTypeRef;
    fn CFDataCreate(allocator: CFTypeRef, bytes: *const u8, length: isize) -> CFTypeRef;
    fn CFStringCreateWithCString(allocator: CFTypeRef, text: *const c_char, encoding: u32) -> CFStringRef;
    fn CFRelease(value: CFTypeRef);
}

#[link(name = "IOSurface", kind = "framework")]
unsafe extern "C" {
    static kIOSurfaceWidth: CFStringRef;
    static kIOSurfaceHeight: CFStringRef;
    static kIOSurfaceBytesPerElement: CFStringRef;
    static kIOSurfacePixelFormat: CFStringRef;
    static kIOSurfaceIsGlobal: CFStringRef;
    static kIOSurfaceColorSpace: CFStringRef;
    fn IOSurfaceCreate(properties: CFDictionaryRef) -> IOSurfaceRef;
    fn IOSurfaceGetID(surface: IOSurfaceRef) -> u32;
    fn IOSurfaceLock(surface: IOSurfaceRef, options: u32, seed: *mut u32) -> i32;
    fn IOSurfaceUnlock(surface: IOSurfaceRef, options: u32, seed: *mut u32) -> i32;
    fn IOSurfaceGetBaseAddress(surface: IOSurfaceRef) -> *mut c_void;
    fn IOSurfaceGetBytesPerRow(surface: IOSurfaceRef) -> usize;
    fn IOSurfaceGetHeight(surface: IOSurfaceRef) -> usize;
    fn IOSurfaceSetValue(surface: IOSurfaceRef, key: CFStringRef, value: CFTypeRef);
    fn IOSurfaceIsInUse(surface: IOSurfaceRef) -> u8;
}

const NUMBER_SINT64: isize = 4;
const UTF8: u32 = 0x0800_0100;
const BGRA: i64 = 0x4247_5241;

fn string(text: &str) -> CFStringRef {
    let text = CString::new(text).expect("the key holds no NUL");
    // SAFETY: the text is a NUL-terminated UTF-8 string that outlives the call.
    unsafe { CFStringCreateWithCString(std::ptr::null(), text.as_ptr(), UTF8) }
}

fn number(value: i64) -> CFTypeRef {
    // SAFETY: the value is a live i64 of the declared number type.
    unsafe { CFNumberCreate(std::ptr::null(), NUMBER_SINT64, (&raw const value).cast()) }
}

/// One global IOSurface that the service owns until it drops it.
pub struct Surface {
    surface: IOSurfaceRef,
    id: u32,
    nonce: [u8; 16],
    width: u32,
    height: u32,
}

// SAFETY: an IOSurfaceRef is a thread-safe CoreFoundation object, and the service uses each surface under its one lock.
unsafe impl Send for Surface {}

impl Surface {
    pub fn create(width: u32, height: u32) -> Result<Surface, String> {
        if width == 0 || height == 0 {
            return Err(format!("an image of {width}x{height} has no pixels"));
        }
        let mut nonce = [0u8; 16];
        // SAFETY: the buffer holds 16 bytes.
        unsafe { libc::arc4random_buf(nonce.as_mut_ptr().cast(), nonce.len()) };
        // SAFETY: every key is a CoreFoundation string constant of the IOSurface framework and every value is created here and
        // released after the dictionary retains it.
        unsafe {
            let values = [number(i64::from(width)), number(i64::from(height)), number(4), number(BGRA)];
            let keys = [kIOSurfaceWidth, kIOSurfaceHeight, kIOSurfaceBytesPerElement, kIOSurfacePixelFormat, kIOSurfaceIsGlobal];
            let all = [values[0], values[1], values[2], values[3], kCFBooleanTrue];
            let properties = CFDictionaryCreate(
                std::ptr::null(),
                keys.as_ptr(),
                all.as_ptr(),
                keys.len() as isize,
                &raw const kCFTypeDictionaryKeyCallBacks,
                &raw const kCFTypeDictionaryValueCallBacks,
            );
            for value in values {
                CFRelease(value);
            }
            if properties.is_null() {
                return Err("CFDictionaryCreate returned no dictionary".into());
            }
            let surface = IOSurfaceCreate(properties);
            CFRelease(properties);
            if surface.is_null() {
                return Err(format!("IOSurfaceCreate {width}x{height} returned no surface"));
            }
            let key = string("soksak.frame");
            let data = CFDataCreate(std::ptr::null(), nonce.as_ptr(), nonce.len() as isize);
            IOSurfaceSetValue(surface, key, data);
            CFRelease(data);
            CFRelease(key);
            let space = string("kCGColorSpaceSRGB");
            IOSurfaceSetValue(surface, kIOSurfaceColorSpace, space);
            CFRelease(space);
            Ok(Surface { surface, id: IOSurfaceGetID(surface), nonce, width, height })
        }
    }

    pub fn id(&self) -> u32 {
        self.id
    }

    pub fn nonce(&self) -> [u8; 16] {
        self.nonce
    }

    pub fn size(&self) -> (u32, u32) {
        (self.width, self.height)
    }

    pub fn in_use(&self) -> bool {
        // SAFETY: the surface is alive while self is.
        unsafe { IOSurfaceIsInUse(self.surface) != 0 }
    }

    pub fn paint(&mut self, scene: &Scene) -> Result<(), String> {
        if (scene.width, scene.height) != (self.width, self.height) {
            return Err(format!("a scene of {}x{} does not fit a surface of {}x{}", scene.width, scene.height, self.width, self.height));
        }
        // SAFETY: the surface is locked while its base address is written, within its bytes per row and height.
        unsafe {
            let status = IOSurfaceLock(self.surface, 0, std::ptr::null_mut());
            if status != 0 {
                return Err(format!("IOSurfaceLock: {status}"));
            }
            let stride = IOSurfaceGetBytesPerRow(self.surface);
            let rows = IOSurfaceGetHeight(self.surface);
            let base = IOSurfaceGetBaseAddress(self.surface).cast::<u8>();
            let buffer = std::slice::from_raw_parts_mut(base, stride * rows);
            paint(buffer, stride, scene);
            let status = IOSurfaceUnlock(self.surface, 0, std::ptr::null_mut());
            if status != 0 {
                return Err(format!("IOSurfaceUnlock: {status}"));
            }
        }
        Ok(())
    }
}

impl Drop for Surface {
    fn drop(&mut self) {
        // SAFETY: the service holds one reference from IOSurfaceCreate, released once here.
        unsafe { CFRelease(self.surface.cast_const()) };
    }
}
