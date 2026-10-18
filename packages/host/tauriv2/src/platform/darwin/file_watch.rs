//! The watch of a file through the kqueue of the kernel (docs/spec/logging.md#classes-and-policy): the folder of the file is watched
//! for the creation and the replacement of the entry, and the file for the writes in place, so no timer reads the file.
//! No library meets this contract: the FSEvents watcher of notify 8.2 delivered no event of the folder while a writer appended to
//! a file of its `logs` subfolder, its kqueue watcher left a rename undelivered until a later kernel event and watched a new
//! subfolder recursively, and the kqueue crate 1.2 has no user event that ends a blocked wait (S54 of the terminal sidecar).

use std::ffi::CString;
use std::os::unix::ffi::OsStrExt;
use std::path::Path;
use std::sync::Arc;

/// O_EVTONLY: the descriptor is only for the notifications of the kernel and keeps neither the volume busy nor the file open
/// for reading.
const OPEN_EVENT_ONLY: libc::c_int = 0x8000;

/// The identifier of the user event that ends the watch.
const STOP_IDENT: libc::uintptr_t = 1;

/// The changes of a file or a folder that the watch reports: a write or an extension, a change of the attributes (a truncation, a
/// mode), and the removal, the rename or the revocation of the entry.
const VNODE_EVENTS: u32 = libc::NOTE_WRITE
    | libc::NOTE_EXTEND
    | libc::NOTE_ATTRIB
    | libc::NOTE_DELETE
    | libc::NOTE_RENAME
    | libc::NOTE_REVOKE;

fn event(ident: libc::uintptr_t, filter: i16, flags: u16, fflags: u32) -> libc::kevent {
    libc::kevent {
        ident,
        filter,
        flags,
        fflags,
        data: 0,
        udata: std::ptr::null_mut(),
    }
}

fn register(queue: libc::c_int, change: &libc::kevent) -> Result<(), String> {
    let result =
        unsafe { libc::kevent(queue, change, 1, std::ptr::null_mut(), 0, std::ptr::null()) };
    if result < 0 {
        Err(std::io::Error::last_os_error().to_string())
    } else {
        Ok(())
    }
}

fn vnode(descriptor: libc::c_int) -> libc::kevent {
    event(
        descriptor as libc::uintptr_t,
        libc::EVFILT_VNODE,
        libc::EV_ADD | libc::EV_CLEAR,
        VNODE_EVENTS,
    )
}

/// Opens `path` for notifications. `Ok(None)` is a path that does not exist.
fn open_event_only(path: &Path) -> Result<Option<libc::c_int>, String> {
    let text = CString::new(path.as_os_str().as_bytes())
        .map_err(|_| format!("{} holds a NUL character", path.display()))?;
    let descriptor = unsafe { libc::open(text.as_ptr(), OPEN_EVENT_ONLY | libc::O_CLOEXEC) };
    if descriptor >= 0 {
        return Ok(Some(descriptor));
    }
    let error = std::io::Error::last_os_error();
    if error.kind() == std::io::ErrorKind::NotFound {
        Ok(None)
    } else {
        Err(error.to_string())
    }
}

/// Calls `changed` on a thread of the watch after the file at `path` was created, written, replaced, renamed or removed. A
/// notification can follow another that already led to a read, so the reader of `changed` compares what it reads with what it
/// holds. The result stops the watch and waits until its thread ended.
pub fn watch_file(
    path: &Path,
    changed: Arc<dyn Fn() + Send + Sync>,
) -> Result<Box<dyn FnOnce() + Send>, String> {
    let fail = |error: String| format!("watch {}: {error}", path.display());
    let queue = unsafe { libc::kqueue() };
    if queue < 0 {
        return Err(fail(format!("kqueue: {}", std::io::Error::last_os_error())));
    }
    let directory = path
        .parent()
        .ok_or_else(|| fail("the path has no folder".into()))?;
    let setup = (|| -> Result<(libc::c_int, libc::c_int), String> {
        register(
            queue,
            &event(
                STOP_IDENT,
                libc::EVFILT_USER,
                libc::EV_ADD | libc::EV_CLEAR,
                0,
            ),
        )?;
        let directory_descriptor = open_event_only(directory)?
            .ok_or_else(|| format!("{} does not exist", directory.display()))?;
        if let Err(error) = register(queue, &vnode(directory_descriptor)) {
            unsafe { libc::close(directory_descriptor) };
            return Err(error);
        }
        let file = match open_event_only(path) {
            Ok(Some(descriptor)) => match register(queue, &vnode(descriptor)) {
                Ok(()) => descriptor,
                Err(error) => {
                    unsafe { libc::close(descriptor) };
                    unsafe { libc::close(directory_descriptor) };
                    return Err(error);
                }
            },
            Ok(None) => -1,
            Err(error) => {
                unsafe { libc::close(directory_descriptor) };
                return Err(error);
            }
        };
        Ok((directory_descriptor, file))
    })();
    let (directory_descriptor, mut file) = match setup {
        Ok(descriptors) => descriptors,
        Err(error) => {
            unsafe { libc::close(queue) };
            return Err(fail(error));
        }
    };
    let watched = path.to_path_buf();
    #[cfg(feature = "diagnostics")]
    let watched_directory = directory.to_path_buf();
    let handle = crate::routine::spawn_named("file-watch", move || {
        let mut events: [libc::kevent; 8] = unsafe { std::mem::zeroed() };
        loop {
            let count = unsafe {
                libc::kevent(
                    queue,
                    std::ptr::null(),
                    0,
                    events.as_mut_ptr(),
                    events.len() as libc::c_int,
                    std::ptr::null(),
                )
            };
            if count < 0 {
                let error = std::io::Error::last_os_error();
                if error.raw_os_error() == Some(libc::EINTR) {
                    continue;
                }
                eprintln!("watch {}: {error}", watched.display());
                break;
            }
            let mut replaced = false;
            let mut stopped = false;
            for event in &events[..count as usize] {
                if event.filter == libc::EVFILT_USER {
                    stopped = true;
                } else if event.filter == libc::EVFILT_VNODE
                    && event.ident == file as libc::uintptr_t
                    && event.fflags & (libc::NOTE_DELETE | libc::NOTE_RENAME | libc::NOTE_REVOKE)
                        != 0
                {
                    replaced = true;
                }
            }
            if stopped {
                break;
            }
            // The file at the path is another file after a replacement, and a removed file has none: the descriptor is renewed.
            if replaced || file < 0 {
                if file >= 0 {
                    unsafe { libc::close(file) };
                    file = -1;
                }
                match open_event_only(&watched) {
                    Ok(Some(descriptor)) => match register(queue, &vnode(descriptor)) {
                        Ok(()) => file = descriptor,
                        Err(error) => {
                            unsafe { libc::close(descriptor) };
                            eprintln!("watch {}: {error}", watched.display());
                        }
                    },
                    Ok(None) => {}
                    Err(error) => eprintln!("watch {}: {error}", watched.display()),
                }
            }
            #[cfg(feature = "diagnostics")]
            {
                let mut held = vec![watched_directory.clone()];
                if file >= 0 {
                    held.push(watched.clone());
                }
                crate::log_policy_watch_hook::observe(&held);
            }
            changed();
        }
        if file >= 0 {
            unsafe { libc::close(file) };
        }
    });
    let stop_path = path.to_path_buf();
    Ok(Box::new(move || {
        let trigger = event(STOP_IDENT, libc::EVFILT_USER, 0, libc::NOTE_TRIGGER);
        if let Err(error) = register(queue, &trigger) {
            eprintln!(
                "watch {}: the stop was not delivered: {error}",
                stop_path.display()
            );
            return;
        }
        if handle.join().is_err() {
            eprintln!(
                "watch {}: the thread of the watch ended with a panic",
                stop_path.display()
            );
        }
        unsafe {
            libc::close(directory_descriptor);
            libc::close(queue);
        }
    }))
}
