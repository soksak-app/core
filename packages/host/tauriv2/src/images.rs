//! The external image display region of a surface page. It is related to the "image envelope" of docs/spec/sidecars.md.
//!
//! A surface page requests that an image be displayed in a native region. The host creates an image region inside the
//! surface webview, places it with the insets that the page reported, and shows the image that the sidecar sent in the
//! region. The image region is a subview of the surface webview, so it moves and hides together with the surface. It is
//! closed when the surface is removed or the surface page is loaded again.
//!
//! Commands run outside the main thread and native work runs on the main thread. A cleanup that started on the main
//! thread is not awaited.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use base64::Engine;
use serde::{Deserialize, Serialize};
use tauri::Webview;

use crate::application_log::{log_error, log_failure};
use crate::exposure::{self, on_main};
use crate::platform::{self, Handle};
use crate::surfaces::{require_region, surface_handle};
use crate::windows::{emit_window, window_data};

/// An image region call of a surface page.
#[derive(Clone, Debug, Deserialize)]
pub struct Request {
    pub surface: String,
    pub name: String,
    pub sidecar: Option<String>,
}

/// A pair of a surface and an image name.
pub type Key = (String, String);

/// The sidecar owner that registered the image region.
pub struct Owner {
    pub sidecar_owner: String,
}

/// Checks that the calling surface caller is request.surface and that the image name is valid, and returns the key.
pub fn check(caller: Option<&str>, request: &Request) -> Result<Key, String> {
    if caller != Some(request.surface.as_str()) {
        return Err(format!("this image is not surface {:?}", request.surface));
    }
    let mut chars = request.name.chars();
    let valid = matches!(chars.next(), Some(c) if c.is_ascii_lowercase() || c.is_ascii_digit())
        && request.name.len() <= 64
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if !valid {
        return Err(format!("invalid image name {:?}", request.name));
    }
    Ok((request.surface.clone(), request.name.clone()))
}

/// The image regions of a window.
#[derive(Clone, Default)]
pub struct Images {
    shared: Arc<Shared>,
}

#[derive(Default)]
struct Shared {
    inner: Mutex<Inner>,
    changed: Condvar,
}

#[derive(Default)]
struct Inner {
    handles: HashMap<Key, Handle>,
    owners: HashMap<Key, String>,
    sidecars: HashMap<Key, String>, // sidecar name of each image
    states: HashMap<Key, RasterState>,
    generations: HashMap<String, u64>,
    surface_visibility: HashMap<String, bool>,
    /// The last (generation, raster) that a detached image region used. A region attached again in the same generation
    /// counts from the next raster, because the sidecar treats a configuration whose (generation, raster) did not grow
    /// as an old configuration and ignores it. It is cleared when the generation of the surface changes.
    detached_rasters: HashMap<Key, (u64, u64)>,
    next_generation: u64,
}

impl Inner {
    /// Clears the raster record of the regions detached from a surface. When the generation of the surface changes, the
    /// new generation is larger than the previous configuration, so the record is not needed.
    fn forget_detached_rasters(&mut self, surface: &str) {
        self.detached_rasters.retain(|key, _| key.0 != surface);
    }

    /// Clears the name of a region and keeps the raster from which to continue counting when it is attached again in
    /// the same generation.
    fn detach(&mut self, key: &Key) -> Option<Handle> {
        let handle = self.handles.remove(key)?;
        self.owners.remove(key);
        self.sidecars.remove(key);
        if let Some(state) = self.states.remove(key) {
            self.detached_rasters
                .insert(key.clone(), (state.generation, state.raster));
        }
        Some(handle)
    }
}

#[derive(Clone, Debug, Default)]
struct RasterState {
    generation: u64,
    raster: u64,
    width: u32,
    height: u32,
    scale: f64,
    last_sequence: i32,
    configured: bool,
    visible: bool,
    presented_raster: u64,
    presented_sequence: i32,
    presentation_error: Option<String>,
}

/// The raster, its size and the sequence number to which a frame that a supplier sent belongs.
/// The identity of the frame that an image region presents: the generation, the raster and the sequence of the frame.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PresentedFrame {
    pub generation: u64,
    pub raster: u64,
    pub sequence: i32,
}

#[derive(Clone, Copy, Debug)]
struct FrameIdentity {
    generation: u64,
    raster: u64,
    width: u32,
    height: u32,
    scale: f64,
    sequence: i32,
}

#[derive(Clone, Debug, Serialize)]
pub struct Configure {
    pub name: String,
    pub generation: u64,
    pub raster: u64,
    pub width: u32,
    pub height: u32,
    pub scale: f64,
    #[serde(skip)]
    pub sidecar: String,
}

#[cfg(feature = "diagnostics")]
impl Images {
    /// Returns the number of image regions, including the regions that are being created.
    pub fn count(&self) -> usize {
        self.lock().handles.len()
    }
}

impl Images {
    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.shared
            .inner
            .lock()
            // default: a thread that stopped while holding the lock also changed the state only by one insert, remove
            // or read, so the state is consistent, and that stop was already reported as a panic report.
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn changed(&self) {
        self.shared.changed.notify_all();
    }

    /// Creates a generation that distinguishes frames from the previous frames when a new surface document starts.
    pub fn begin_generation(&self, surface: &str) -> u64 {
        let mut inner = self.lock();
        inner.next_generation += 1;
        let generation = inner.next_generation;
        inner.generations.insert(surface.to_string(), generation);
        inner.forget_detached_rasters(surface);
        for (key, state) in &mut inner.states {
            if key.0 == surface {
                state.generation = generation;
                state.configured = false;
                state.presentation_error = None;
                state.last_sequence = 0;
            }
        }
        generation
    }

    /// Ends the current generation of a removed surface. The number is not reused.
    pub fn end_generation(&self, surface: &str) {
        let mut inner = self.lock();
        inner.generations.remove(surface);
        inner.forget_detached_rasters(surface);
        if inner.states.keys().any(|key| key.0 == surface) {
            inner.surface_visibility.insert(surface.to_string(), false);
        } else {
            inner.surface_visibility.remove(surface);
        }
        self.changed();
    }

    /// Records the visibility state of the outer SurfaceHost.
    pub fn set_surface_visible(&self, surface: &str, visible: bool) {
        let mut inner = self.lock();
        if inner.surface_visibility.get(surface).copied() == Some(visible) {
            return;
        }
        inner
            .surface_visibility
            .insert(surface.to_string(), visible);
        if visible {
            for (key, state) in inner.states.iter_mut() {
                if key.0 == surface {
                    // Hiding the surface releases the native pixels. When the surface returns, the same raster must be
                    // configured again. The revision is increased so that a frame of a hidden generation is not
                    // accepted after the surface is shown.
                    state.raster += 1;
                    state.configured = false;
                    state.last_sequence = 0;
                }
            }
        }
        self.changed();
    }

    /// Takes a name. It returns an error when there is no sidecar or it is an empty string.
    pub fn reserve(&self, key: &Key, owner: &str, sidecar: &str) -> Result<(), String> {
        if sidecar.is_empty() {
            return Err(format!("image {:?}: reserve requires a sidecar", key.1));
        }
        let mut inner = self.lock();
        if inner.handles.contains_key(key) {
            return Err(format!("image {:?} is already attached", key.1));
        }
        inner.handles.insert(key.clone(), 0);
        inner.owners.insert(key.clone(), owner.to_string());
        inner.sidecars.insert(key.clone(), sidecar.to_string());
        let generation = match inner.generations.get(&key.0).copied() {
            Some(generation) => generation,
            None => {
                inner.next_generation += 1;
                let generation = inner.next_generation;
                inner.generations.insert(key.0.clone(), generation);
                generation
            }
        };
        let raster = match inner.detached_rasters.remove(key) {
            Some((detached_generation, raster)) if detached_generation == generation => raster,
            _ => 0,
        };
        inner.states.insert(
            key.clone(),
            RasterState {
                generation,
                raster,
                ..RasterState::default()
            },
        );
        self.changed();
        Ok(())
    }

    /// Writes the address of the created image region to the taken name.
    pub fn set(&self, key: &Key, handle: Handle) -> bool {
        match self.lock().handles.get_mut(key) {
            Some(slot) => {
                *slot = handle;
                true
            }
            None => false,
        }
    }

    /// Returns the address of a created image region.
    pub fn get(&self, key: &Key) -> Result<Handle, String> {
        match self.lock().handles.get(key) {
            Some(&handle) if handle != 0 => Ok(handle),
            _ => Err(format!("image {:?} is not attached", key.1)),
        }
    }

    /// Returns the sidecar owner that registered the image region.
    pub fn get_owner(&self, key: &Key) -> Result<String, String> {
        let inner = self.lock();
        // default: a region that is not registered has no address, and address 0 is a region that is being created and
        // not attached.
        if inner.handles.get(key).map(|&h| h != 0).unwrap_or(false) {
            inner
                .owners
                .get(key)
                .cloned()
                .ok_or_else(|| format!("image {:?} has no recorded owner", key.1))
        } else {
            Err(format!("image {:?} is not attached", key.1))
        }
    }

    /// Returns the name of the sidecar that registered the image region.
    pub fn get_sidecar(&self, key: &Key) -> Result<String, String> {
        let inner = self.lock();
        // default: a region that is not registered has no address, and address 0 is a region that is being created and
        // not attached.
        if inner.handles.get(key).map(|&h| h != 0).unwrap_or(false) {
            inner
                .sidecars
                .get(key)
                .cloned()
                .ok_or_else(|| format!("image {:?} has no recorded sidecar", key.1))
        } else {
            Err(format!("image {:?} is not attached", key.1))
        }
    }

    /// Removes a name and returns the address of its image region.
    pub fn remove(&self, key: &Key) -> Result<Handle, String> {
        let mut inner = self.lock();
        match inner.detach(key) {
            Some(handle) => {
                self.changed();
                Ok(handle)
            }
            None => Err(format!("image {:?} is not attached", key.1)),
        }
    }

    /// Removes every name of a surface and returns the addresses of the created image regions.
    pub fn remove_surface(&self, surface: &str) -> Vec<Handle> {
        let mut removed = Vec::new();
        let mut inner = self.lock();
        let keys: Vec<_> = inner
            .handles
            .keys()
            .filter(|k| k.0 == surface)
            .cloned()
            .collect();
        for key in keys {
            if let Some(handle) = inner.detach(&key)
                && handle != 0
            {
                removed.push(handle);
            }
        }
        // The cleanup of document regions does not change the visibility state of the outer SurfaceHost. end_generation
        // removes that state when the surface itself closes.
        self.changed();
        removed
    }

    /// The key of each address of a created image region.
    pub fn names(&self) -> HashMap<Handle, Key> {
        let inner = self.lock();
        inner
            .handles
            .iter()
            .filter(|&(_, &handle)| handle != 0)
            .map(|(key, &handle)| (handle, key.clone()))
            .collect()
    }

    /// Returns the sidecar that the surface uses before the reload.
    pub fn sidecars_for_surface(&self, surface: &str) -> Vec<String> {
        let inner = self.lock();
        let mut sidecars = HashSet::new();
        for key in inner.handles.keys().filter(|key| key.0 == surface) {
            if let Some(sidecar) = inner.sidecars.get(key) {
                sidecars.insert(sidecar.clone());
            }
        }
        sidecars.into_iter().collect()
    }

    /// The addresses of created image regions.
    pub fn all(&self) -> Vec<Handle> {
        self.lock()
            .handles
            .values()
            .copied()
            .filter(|&handle| handle != 0)
            .collect()
    }

    /// Returns the handles of images whose region itself and outer surface are both shown.
    pub fn visible(&self) -> Vec<(Key, Handle)> {
        self.visible_where(|_, _| true)
    }

    /// The visible regions that the sidecar draws. They are used to send the configure of the sidecar again when the
    /// connection of a persistent sidecar is established again (V5-106).
    pub fn visible_for_sidecar(&self, sidecar: &str) -> Vec<(Key, Handle)> {
        self.visible_where(|inner, key| {
            inner.sidecars.get(key).map(String::as_str) == Some(sidecar)
        })
    }

    fn visible_where(&self, belongs: impl Fn(&Inner, &Key) -> bool) -> Vec<(Key, Handle)> {
        let inner = self.lock();
        inner
            .states
            .iter()
            .filter_map(|(key, state)| {
                if !belongs(&inner, key) {
                    return None;
                }
                let outer = inner
                    .surface_visibility
                    .get(&key.0)
                    .copied()
                    // default: a surface that did not report hiding is visible (it is written to surface_visibility
                    // only when it is hidden).
                    .unwrap_or(true);
                // default: the address of a region that is not registered is 0, the same as a region that is not
                // attached.
                let handle = inner.handles.get(key).copied().unwrap_or_default();
                (state.visible && outer && handle != 0).then(|| (key.clone(), handle))
            })
            .collect()
    }

    /// Marks that the connection of the sidecar was lost (V5-106). The connection that received configure died, so the
    /// configure state dies with it: even for the same size, configure must be sent again so that the service of the
    /// new connection creates the image state. The record of the presentation order is also cleared, because the frames
    /// of the new connection count the sequence number from the start.
    pub fn invalidate_sidecar(&self, sidecar: &str) -> usize {
        let mut inner = self.lock();
        let mut invalidated = 0;
        let keys: Vec<Key> = inner
            .sidecars
            .iter()
            .filter(|(_, owner)| owner.as_str() == sidecar)
            .map(|(key, _)| key.clone())
            .collect();
        for key in keys {
            let Some(state) = inner.states.get_mut(&key) else {
                continue;
            };
            state.configured = false;
            state.last_sequence = 0;
            state.presented_sequence = 0;
            state.presentation_error = None;
            invalidated += 1;
        }
        if invalidated > 0 {
            self.changed();
        }
        invalidated
    }

    /// Increases the revision when the applied native raster changed, and returns the configuration to send.
    pub fn configure_raster(
        &self,
        key: &Key,
        width: u32,
        height: u32,
        scale: f64,
        visible: bool,
    ) -> Result<Option<Configure>, String> {
        let mut inner = self.lock();
        let surface_visible = inner
            .surface_visibility
            .get(&key.0)
            .copied()
            // default: a surface that did not report hiding is visible (it is written to surface_visibility only when
            // it is hidden).
            .unwrap_or(true);
        // default: the address of a region that is not registered is 0, the same as a region that is not attached.
        if inner.handles.get(key).copied().unwrap_or_default() == 0 {
            return Err(format!("image {:?} is not attached", key.1));
        }
        let sidecar = inner
            .sidecars
            .get(key)
            .cloned()
            .ok_or_else(|| format!("image {:?} is not attached", key.1))?;
        let state = inner
            .states
            .get_mut(key)
            .ok_or_else(|| format!("image {:?} is not attached", key.1))?;
        if state.visible != visible {
            state.visible = visible;
            self.changed();
        }
        if width == 0 || height == 0 || !scale.is_finite() || scale <= 0.0 {
            return Ok(None);
        }
        if state.width != width || state.height != height || (state.scale - scale).abs() > 0.000001
        {
            state.raster += 1;
            state.width = width;
            state.height = height;
            state.scale = scale;
            state.last_sequence = 0;
            state.configured = false;
            state.presented_sequence = 0;
            state.presentation_error = None;
            self.changed();
        }
        if !visible || !surface_visible || state.configured {
            return Ok(None);
        }
        state.configured = true;
        Ok(Some(Configure {
            name: key.1.clone(),
            generation: state.generation,
            raster: state.raster,
            width,
            height,
            scale,
            sidecar,
        }))
    }

    /// Records the visibility state of a region even for a placement of size 0 that has no raster.
    pub fn set_visible(&self, key: &Key, visible: bool) -> Result<(), String> {
        let mut inner = self.lock();
        // default: the address of a region that is not registered is 0, the same as a region that is not attached.
        if inner.handles.get(key).copied().unwrap_or_default() == 0 {
            return Err(format!("image {:?} is not attached", key.1));
        }
        let state = inner
            .states
            .get_mut(key)
            .ok_or_else(|| format!("image {:?} is not attached", key.1))?;
        if state.visible != visible {
            state.visible = visible;
            self.changed();
        }
        Ok(())
    }

    pub fn retry_configure(&self, key: &Key, generation: u64, raster: u64) {
        let mut inner = self.lock();
        if let Some(state) = inner.states.get_mut(key)
            && state.generation == generation
            && state.raster == raster
        {
            state.configured = false;
            state.presentation_error = None;
        }
    }

    /// Checks that the frame belongs to the current supplier and the exact raster and is increasing.
    fn authorize_frame(
        &self,
        key: &Key,
        sender: &str,
        frame: FrameIdentity,
    ) -> Result<(), &'static str> {
        let FrameIdentity {
            generation,
            raster,
            width,
            height,
            scale,
            sequence,
        } = frame;
        let mut inner = self.lock();
        // default: the address of a region that is not registered is 0, the same as a region that is not attached.
        let attached = inner.handles.get(key).copied().unwrap_or_default() != 0;
        let sender_matches = inner
            .sidecars
            .get(key)
            .is_some_and(|sidecar| sidecar == sender);
        let Some(state) = inner.states.get_mut(key) else {
            return Err("notAttached");
        };
        if !attached || !sender_matches || state.generation != generation {
            return Err("notAttached");
        }
        if !state.configured
            || state.raster != raster
            || state.width != width
            || state.height != height
            || (state.scale - scale).abs() > 0.000001
            || sequence <= 0
            || sequence <= state.last_sequence
        {
            return Err("stale");
        }
        state.last_sequence = sequence;
        Ok(())
    }

    /// Checks that the frame is still the current raster just before it is presented on the main thread.
    fn frame_status(
        &self,
        key: &Key,
        generation: u64,
        raster: u64,
        sequence: i32,
    ) -> Result<(), &'static str> {
        let inner = self.lock();
        // default: the address of a region that is not registered is 0, the same as a region that is not attached.
        let attached = inner.handles.get(key).copied().unwrap_or_default() != 0;
        let Some(state) = inner.states.get(key) else {
            return Err("notAttached");
        };
        if !attached || state.generation != generation {
            return Err("notAttached");
        }
        if !state.configured || state.raster != raster || state.last_sequence != sequence {
            return Err("stale");
        }
        Ok(())
    }

    /// Returns the current frame state of a region as text so that it can be compared with a rejected frame.
    fn frame_state(&self, key: &Key) -> String {
        let inner = self.lock();
        match inner.states.get(key) {
            Some(state) => format!(
                "generation={} raster={} sequence={} configured={} size={}x{}@{} presented raster={} sequence={}",
                state.generation,
                state.raster,
                state.last_sequence,
                state.configured,
                state.width,
                state.height,
                state.scale,
                state.presented_raster,
                state.presented_sequence
            ),
            None => "none".into(),
        }
    }

    /// Records that the frame of the current raster was copied to the native display storage.
    fn mark_presented(&self, key: &Key, generation: u64, raster: u64, sequence: i32) {
        let mut inner = self.lock();
        let Some(state) = inner.states.get_mut(key) else {
            return;
        };
        if state.generation != generation
            || state.raster != raster
            || state.last_sequence != sequence
        {
            return;
        }
        if state.presented_raster != raster || state.presented_sequence != sequence {
            state.presented_raster = raster;
            state.presented_sequence = sequence;
            state.presentation_error = None;
            self.changed();
        }
    }

    fn mark_presentation_failed(
        &self,
        key: &Key,
        generation: u64,
        raster: u64,
        sequence: i32,
        reason: &str,
    ) {
        let mut inner = self.lock();
        let Some(state) = inner.states.get_mut(key) else {
            return;
        };
        if state.generation != generation
            || state.raster != raster
            || state.last_sequence != sequence
        {
            return;
        }
        state.configured = false;
        state.presentation_error = Some(reason.to_string());
        self.changed();
    }

    fn current_presented_locked(inner: &Inner) -> bool {
        inner.states.iter().all(|(key, state)| {
            let surface_visible = inner
                .surface_visibility
                .get(&key.0)
                .copied()
                // default: a surface that did not report hiding is visible (it is written to surface_visibility only
                // when it is hidden).
                .unwrap_or(true);
            // default: the address of a region that is not registered is 0, the same as a region that is not attached.
            inner.handles.get(key).copied().unwrap_or_default() == 0
                || !state.visible
                || !surface_visible
                || state.raster == 0
                || (state.last_sequence > 0
                    && state.presented_raster == state.raster
                    && state.presented_sequence == state.last_sequence)
        })
    }

    /// Lists the image regions that the presentation barrier still waits for, in the order of surface and name. When
    /// the barrier times out, the list is attached to the error to report which regions were not presented. It is
    /// "none" when no region is waited for.
    pub fn pending_rasters(&self) -> String {
        let inner = self.lock();
        let mut pending: Vec<String> = inner
            .states
            .iter()
            .filter_map(|(key, state)| {
                let known = inner.surface_visibility.get(&key.0).copied();
                // default: the address of a region that is not registered is 0, the same as a region that is not
                // attached.
                let attached = inner.handles.get(key).copied().unwrap_or_default() != 0;
                let presented = state.last_sequence > 0
                    && state.presented_raster == state.raster
                    && state.presented_sequence == state.last_sequence;
                if !attached
                    || !state.visible
                    || known == Some(false)
                    || state.raster == 0
                    || presented
                {
                    return None;
                }
                let surface = if known.is_some() {
                    "visible"
                } else {
                    "unknown"
                };
                Some(format!(
                    "{}/{} generation {} raster {} sequence {} presented {}/{} surface {surface}",
                    key.0,
                    key.1,
                    state.generation,
                    state.raster,
                    state.last_sequence,
                    state.presented_raster,
                    state.presented_sequence
                ))
            })
            .collect();
        if pending.is_empty() {
            return "none".into();
        }
        pending.sort();
        pending.join(", ")
    }

    /// Returns whether all visible image regions presented the current raster.
    pub fn current_presented(&self) -> bool {
        Self::current_presented_locked(&self.lock())
    }

    /// Returns the frame that the image region presents, or None while no frame of the current raster is presented. A newer frame
    /// that the host accepted and has not presented yet does not change it.
    pub fn presented_frame(&self, key: &Key) -> Option<PresentedFrame> {
        let inner = self.lock();
        let state = inner.states.get(key)?;
        (state.presented_sequence > 0 && state.presented_raster == state.raster).then_some(
            PresentedFrame {
                generation: state.generation,
                raster: state.presented_raster,
                sequence: state.presented_sequence,
            },
        )
    }

    /// Waits until all visible image regions present the current raster or the time limit ends.
    pub fn wait_current(&self, timeout: Duration) -> Result<(), String> {
        let deadline = Instant::now() + timeout;
        let mut inner = self.lock();
        loop {
            if let Some(error) = inner
                .states
                .values()
                .find_map(|state| state.presentation_error.clone())
            {
                return Err(error);
            }
            if Self::current_presented_locked(&inner) {
                return Ok(());
            }
            let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
                return Err("presentationTimeout".to_string());
            };
            let (next, result) = self
                .shared
                .changed
                .wait_timeout(inner, remaining)
                // default: a thread that stopped while holding the lock also changed the state only by one insert,
                // remove or read, so the state is consistent, and that stop was already reported as a panic report.
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            inner = next;
            // The failure of the time limit answers that request with the regions that the caller waited for
            // (docs/spec/hosts.md#application-log).
            if result.timed_out() && !Self::current_presented_locked(&inner) {
                return Err("presentationTimeout".to_string());
            }
        }
    }
}

/// Checks the webview of the calling surface caller and the requested surface, and returns the window.
fn owner(webview: &Webview, request: &Request) -> Result<(Key, tauri::Window), String> {
    let window = webview.window();
    crate::exposure::authorize_main_caller(webview.label(), window.label(), "surface operations")?;
    let key = check(Some(request.surface.as_str()), request)?;
    Ok((key, window))
}

/// Registers the created image region in the window and returns the handle. When the surface is removed during
/// creation, it is closed.
fn create(
    _webview: &Webview,
    window: &tauri::Window,
    key: &Key,
    platform: &'static dyn platform::Platform,
) -> Result<Handle, String> {
    let surface = surface_handle(window, &key.0)?;
    let (surface_id, name) = key.clone();
    let host = window.clone();
    let event_name = name.clone();

    on_main(window, move || {
        let event = Box::new(move |json: String| {
            // Native input is sent only to the owning surface. A parse or send failure is not hidden.
            let event_surface = surface_id.clone();
            let event_name = event_name.clone();
            let result = (|| {
                let event: serde_json::Value = serde_json::from_str(&json)
                    .map_err(|error| format!("{event_surface}/{event_name}: {error}"))?;
                crate::event_record::record_input_relay(&event_surface, &event_name, &json);
                // Every event of a native region is recorded with its whole body before it is relayed
                // (docs/spec/diagnostics.md). It writes nothing while the performance trace is off.
                crate::performance::observe("host", || {
                    serde_json::json!({
                        "event": "region",
                        "surface": event_surface,
                        "name": event_name,
                        "body": event,
                    })
                });
                // A focus transition is also left in the timeline of the performance trace (V5-114, the window event
                // line that the performance-trace specification promises). When the trace is off, line writes nothing.
                if event.get("type").and_then(|value| value.as_str()) == Some("focus") {
                    crate::performance::observe("host", || {
                        serde_json::json!({
                            "event": "focus",
                            "surface": event_surface,
                            "name": event_name,
                            "focused": event.get("focused"),
                        })
                    });
                }
                let report_surface = event_surface.clone();
                let report_name = event_name.clone();
                let payload = serde_json::json!({
                    "surface": event_surface, "name": event_name, "event": event,
                });
                let deferred_surface = report_surface.clone();
                let deferred_name = report_name.clone();
                let deferred_host = host.clone();
                platform
                    .enqueue_ui(Box::new(move || {
                        let sent = emit_window(&deferred_host, "image-event", payload)
                            .map_err(|error| error.to_string())
                            .map_err(|error| {
                                format!("{deferred_surface}/{deferred_name}: {error}")
                            });
                        log_failure("image event", sent);
                        exposure::window_changed(&deferred_host);
                    }))
                    .map_err(|error| {
                        format!("{report_surface}/{report_name}: scheduling failed: {error}")
                    })
            })();
            log_failure("image event", result);
        });
        let handle = platform.create_image(surface, &name, event)?;
        Ok(handle)
    })
}

/// Runs run on the main thread for a created image region.
fn with_image<T: Send + 'static>(
    webview: &Webview,
    request: &Request,
    run: impl Fn(Handle) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let window = webview.window();
    crate::exposure::authorize_main_caller(webview.label(), window.label(), "surface operations")?;
    let key = check(Some(request.surface.as_str()), request)?;

    let Ok(data) = window_data(&window) else {
        return Err("cannot get window data".to_string());
    };
    require_region(&data.compositions, &key.0, &key.1, "image", None)?;

    on_main(&window, move || {
        let handle = data.images.get(&key)?;
        run(handle)
    })
}

/// Returns the failure of the image region call call (docs/spec/native-host.md#host-calls).
pub fn image_call_error(call: &str, error: String) -> String {
    format!("{call}: {error}")
}

pub(crate) fn attach(webview: &Webview, request: Request) -> Result<(), String> {
    let sidecar = request
        .sidecar
        .as_deref()
        .ok_or_else(|| format!("image {:?}: attach requires a sidecar", request.name))?;
    if sidecar.is_empty() {
        return Err(format!(
            "image {:?}: attach requires a sidecar",
            request.name
        ));
    }

    let (key, window) = owner(webview, &request)?;
    let platform = platform::current()?;
    let Ok(data) = window_data(&window) else {
        return Err("cannot get window data".to_string());
    };
    require_region(&data.compositions, &key.0, &key.1, "image", Some(sidecar))?;

    // The name is taken first. The lock is not held while waiting for native work.
    data.images.reserve(&key, "", sidecar)?;
    let handle = match create(webview, &window, &key, platform) {
        Ok(handle) => handle,
        Err(error) => {
            if let Err(e) = data.images.remove(&key) {
                log_error(
                    &format!("image {}", key.1),
                    format!("remove the reserved image: {e}"),
                );
            }
            return Err(error);
        }
    };
    if !data.images.set(&key, handle) {
        if let Err(e) = on_main(&window, move || {
            let platform = platform::current()?;
            platform.close_image(handle)
        }) {
            log_error(
                &format!("image {}", key.1),
                format!("close the image on the main thread: {e}"),
            );
        }
        if let Err(e) = data.images.remove(&key) {
            log_error(
                &format!("image {}", key.1),
                format!("remove the image after a failed set: {e}"),
            );
        }
        return Err(format!(
            "surface {:?} closed while its image was created",
            key.0
        ));
    }
    exposure::window_changed(&window);
    Ok(())
}

/// Makes the image region the first responder and sends the focus event.
pub(crate) fn focus(webview: &Webview, request: Request) -> Result<(), String> {
    let platform = platform::current()?;
    with_image(webview, &request, move |handle| {
        platform.focus_image(handle)
    })?;
    exposure::window_changed(&webview.window());
    Ok(())
}

/// Stores the caret (text cursor) position.
pub(crate) fn caret(
    webview: &Webview,
    request: Request,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) -> Result<(), String> {
    let platform = platform::current()?;
    with_image(webview, &request, move |handle| {
        platform.caret_image(handle, x, y, w, h)
    })?;
    Ok(())
}

/// Stores the string that is shown as the accessibility value.
pub(crate) fn text(webview: &Webview, request: Request, text: String) -> Result<(), String> {
    let platform = platform::current()?;
    with_image(webview, &request, move |handle| {
        platform.text_image(handle, &text)
    })?;
    Ok(())
}

/// Closes an image region.
pub(crate) fn detach(webview: &Webview, request: Request) -> Result<(), String> {
    let (key, window) = owner(webview, &request)?;
    let Ok(data) = window_data(&window) else {
        return Err("cannot get window data".to_string());
    };
    require_region(&data.compositions, &key.0, &key.1, "image", None)?;
    let platform = platform::current()?;

    // The unregistration and the close happen in one task of the main thread.
    on_main(&window, move || {
        let handle = data.images.remove(&key)?;
        if handle != 0 {
            platform.close_image(handle)?;
        }
        Ok(())
    })?;
    exposure::window_changed(&window);
    Ok(())
}

/// Closes every image region of a surface. The registry is removed at once, and only the native close runs on the main
/// thread.
pub(crate) fn close_surface(window: &tauri::Window, surface: &str) {
    let Ok(data) = window_data(window) else {
        return;
    };
    let Ok(platform) = platform::current() else {
        return;
    };
    let host = window.clone();
    let surface = surface.to_string();
    data.images.begin_generation(&surface);
    let handles = data.images.remove_surface(&surface);

    log_failure(
        "image close",
        window
            .run_on_main_thread(move || {
                if handles.is_empty() {
                    return;
                }
                for handle in handles {
                    log_failure("image close", platform.close_image(handle));
                }
                exposure::window_changed(&host);
            })
            .map_err(|e| e.to_string()),
    );
}

/// The result of the decision on an image envelope.
#[derive(Debug)]
pub enum Decision {
    /// The body has no image field. The caller must pass it to the page.
    NotImage,
    /// The error to send to the sidecar as the response.
    Reply {
        name: String,
        json: serde_json::Value,
        /// A rejected frame: the rejection reason and the generation, raster and sequence.
        reason: String,
        generation: u64,
        raster: u64,
        sequence: i32,
    },
    /// The image to display.
    Present {
        id: u32,
        nonce: [u8; 16],
        width: u32,
        height: u32,
        scale: f64,
        name: String,
        generation: u64,
        raster: u64,
        sequence: i32,
    },
}

fn image_reply(reason: &str, name: &str, generation: u64, raster: u64, sequence: i32) -> Decision {
    Decision::Reply {
        name: name.to_string(),
        json: serde_json::json!({
            "image": {
                "error": reason, "name": name, "generation": generation,
                "raster": raster, "sequence": sequence
            }
        }),
        reason: reason.to_string(),
        generation,
        raster,
        sequence,
    }
}

/// Parses and validates an image envelope and returns the decision.
/// body must be a JSON object that holds an "image" field.
/// It returns NotImage when it is not an image envelope.
/// It returns Reply when it is not valid.
/// It returns Present when it is valid and registered.
pub fn decide(body_str: &str, sender: &str, surface: &str, images: &Images) -> Decision {
    // Parses the event body and checks the image field.
    let obj: serde_json::Value = match serde_json::from_str(body_str) {
        Ok(obj) => obj,
        Err(_) => return Decision::NotImage,
    };

    let Some(image_val) = obj.get("image") else {
        return Decision::NotImage;
    };

    // Defines the structure of the image envelope.
    #[derive(Deserialize)]
    struct ImageEnvelope {
        name: String,
        token: TokenInfo,
        width: u32,
        height: u32,
        scale: f64,
        format: String,
        generation: u64,
        raster: u64,
        sequence: i32,
    }

    #[derive(Deserialize)]
    struct TokenInfo {
        kind: String,
        id: u32,
        nonce: String,
    }

    let envelope: ImageEnvelope = match serde_json::from_value(image_val.clone()) {
        Ok(e) => e,
        Err(_) => {
            log_error(
                "image frame",
                format!("surface={surface} sender={sender} malformed image envelope: {image_val}"),
            );
            return Decision::NotImage;
        }
    };

    // Validates the format and the token kind.
    if envelope.format != "bgra8" || envelope.token.kind != "iosurface-global" {
        return image_reply(
            "unsupported",
            &envelope.name,
            envelope.generation,
            envelope.raster,
            envelope.sequence,
        );
    }

    // Decodes the nonce from base64 into a [u8; 16] array.
    let decoded_nonce =
        match base64::engine::general_purpose::STANDARD.decode(&envelope.token.nonce) {
            Ok(bytes) => bytes,
            Err(_) => {
                return image_reply(
                    "unsupported",
                    &envelope.name,
                    envelope.generation,
                    envelope.raster,
                    envelope.sequence,
                );
            }
        };

    // The decoded nonce must be exactly 16 bytes.
    if decoded_nonce.len() != 16 {
        return image_reply(
            "unsupported",
            &envelope.name,
            envelope.generation,
            envelope.raster,
            envelope.sequence,
        );
    }

    // Converts the nonce into a [u8; 16] array.
    let mut nonce: [u8; 16] = [0; 16];
    nonce.copy_from_slice(&decoded_nonce[..16]);

    let key = (surface.to_string(), envelope.name.clone());
    let frame = FrameIdentity {
        generation: envelope.generation,
        raster: envelope.raster,
        width: envelope.width,
        height: envelope.height,
        scale: envelope.scale,
        sequence: envelope.sequence,
    };
    if let Err(reason) = images.authorize_frame(&key, sender, frame) {
        return image_reply(
            reason,
            &envelope.name,
            envelope.generation,
            envelope.raster,
            envelope.sequence,
        );
    }
    Decision::Present {
        id: envelope.token.id,
        nonce,
        width: envelope.width,
        height: envelope.height,
        scale: envelope.scale,
        name: envelope.name,
        generation: envelope.generation,
        raster: envelope.raster,
        sequence: envelope.sequence,
    }
}

/// Creates the response after an image is presented.
/// It returns the consumed response when it was presented, and the reason as an error when it failed.
pub fn after_present(
    outcome: Result<(), &str>,
    name: &str,
    generation: u64,
    raster: u64,
    sequence: i32,
) -> serde_json::Value {
    match outcome {
        Ok(()) => serde_json::json!({
            "image": {
                "consumed": {
                    "name": name, "generation": generation, "raster": raster, "sequence": sequence
                }
            }
        }),
        Err(reason) => serde_json::json!({
            "image": {
                "error": reason, "name": name,
                "generation": generation, "raster": raster, "sequence": sequence
            }
        }),
    }
}

/// Handles an image envelope. It takes the work to run on the main thread and the way to send the response as
/// arguments. It returns true when the envelope was handled and false otherwise.
pub fn handle_envelope<OnMain, SendResponse>(
    body_str: &str,
    sender: &str,
    surface: &str,
    images: &Images,
    on_main: OnMain,
    send_response: SendResponse,
) -> bool
where
    OnMain: Fn(Box<dyn Fn() -> Result<(), String> + Send>) -> Result<(), String>,
    SendResponse: Fn(&str, serde_json::Value) -> Result<(), crate::sidecars::ResponseError>,
{
    handle_envelope_with_recovery(
        body_str,
        sender,
        surface,
        images,
        on_main,
        send_response,
        |_| Ok(()),
        || true,
    )
}

/// Handles the image envelope and, after a temporary native presentation failure, requests a new raster when needed.
/// The recovery callback is deliberately separate from the response. The caller can therefore configure the sidecar
/// again over its own transport without hiding the original error. `declared` reports whether a plugin still declares
/// the sending sidecar: the failure of a frame of a sidecar that no plugin declares is the end of its process, so the
/// frame is invalidated without recovery (docs/spec/native-surfaces.md#image-regions).
#[allow(clippy::too_many_arguments)]
pub fn handle_envelope_with_recovery<OnMain, SendResponse, Recover, Declared>(
    body_str: &str,
    sender: &str,
    surface: &str,
    images: &Images,
    on_main: OnMain,
    send_response: SendResponse,
    recover: Recover,
    declared: Declared,
) -> bool
where
    OnMain: Fn(Box<dyn Fn() -> Result<(), String> + Send>) -> Result<(), String>,
    SendResponse: Fn(&str, serde_json::Value) -> Result<(), crate::sidecars::ResponseError>,
    Recover: Fn(&str) -> Result<(), String>,
    Declared: Fn() -> bool,
{
    let decision = decide(body_str, sender, surface, images);

    match decision {
        Decision::NotImage => false,
        Decision::Reply {
            name,
            json,
            reason,
            generation,
            raster,
            sequence,
        } => {
            log_refused_frame(
                surface, sender, images, &name, generation, raster, sequence, &reason,
            );
            log_answer_error(&format!("image reply {name}"), send_response(&name, json));
            true
        }
        Decision::Present {
            id,
            nonce,
            width,
            height,
            scale,
            name,
            generation,
            raster,
            sequence,
        } => {
            if !declared() {
                // No plugin declares the sidecar any more: the buffer of the frame ended with its process, and a native
                // presentation would report the missing buffer to the page (docs/spec/native-surfaces.md#image-regions).
                crate::application_log::log_info(
                    "image present",
                    format!(
                        "frame of sidecar {sender}, which no plugin declares, invalidated: surface={surface} name={name} sequence={sequence}"
                    ),
                );
                log_answer_error(
                    &format!("image response {name}"),
                    send_response(
                        &name,
                        after_present(Err("stale"), &name, generation, raster, sequence),
                    ),
                );
                return true;
            }
            let key = (surface.to_string(), name.clone());
            match images.get(&key) {
                Ok(handle) => {
                    let current_images = images.clone();
                    let current_key = key.clone();
                    let presentation = on_main(Box::new(move || {
                        current_images
                            .frame_status(&current_key, generation, raster, sequence)
                            .map_err(str::to_string)?;
                        let platform = platform::current()?;
                        // When the native raster differs from the frame, that frame belongs to the previous raster. The
                        // record keeps the native raster and the sender is answered with stale.
                        let actual = platform
                            .image_raster(handle)?
                            .ok_or_else(|| "staleRaster native=none".to_string())?;
                        if actual.width != width
                            || actual.height != height
                            || (actual.scale - scale).abs() > 0.000001
                        {
                            return Err(format!(
                                "staleRaster native={}x{}@{} frame={}x{}@{}",
                                actual.width, actual.height, actual.scale, width, height, scale
                            ));
                        }
                        platform
                            .present_image(handle, id, nonce, width as f64, height as f64, scale)
                            .and_then(|presented| {
                                presented
                                    .then_some(())
                                    .ok_or_else(|| "presentFailed".to_string())
                            })
                    }));
                    let reason = match presentation {
                        Ok(()) => None,
                        Err(detail) if !declared() => {
                            // No plugin declares the sidecar any more: its process ended with its buffers.
                            crate::application_log::log_info(
                                "image present",
                                format!(
                                    "frame of sidecar {sender}, which no plugin declares, invalidated: surface={} name={name} sequence={sequence} reason={detail}",
                                    key.0
                                ),
                            );
                            Some("stale")
                        }
                        Err(detail) => {
                            let (reason, _, entry) = presentation_outcome(
                                &key.0,
                                &name,
                                generation,
                                raster,
                                sequence,
                                id,
                                &detail,
                                &images.frame_state(&key),
                            );
                            entry.log();
                            Some(reason)
                        }
                    };

                    if let Some(reason) = reason.filter(|reason| *reason != "stale") {
                        images.mark_presentation_failed(&key, generation, raster, sequence, reason);
                        if reason == "notFound"
                            && let Err(error) = recover(reason)
                        {
                            log_error(
                                "image recovery",
                                format!(
                                    "surface={} name={} reason={} error={}",
                                    key.0, name, reason, error
                                ),
                            );
                        }
                    }

                    let response = match reason {
                        None => {
                            images.mark_presented(&key, generation, raster, sequence);
                            after_present(Ok(()), &name, generation, raster, sequence)
                        }
                        Some(reason) => {
                            after_present(Err(reason), &name, generation, raster, sequence)
                        }
                    };
                    log_answer_error(
                        &format!("image response {name}"),
                        send_response(&name, response),
                    );
                }
                Err(_) => {
                    log_refused_frame(
                        surface,
                        sender,
                        images,
                        &name,
                        generation,
                        raster,
                        sequence,
                        "notAttached",
                    );
                    let response =
                        after_present(Err("notAttached"), &name, generation, raster, sequence);
                    log_answer_error(
                        &format!("image notAttached {name}"),
                        send_response(&name, response),
                    );
                }
            }
            true
        }
    }
}

/// Records the error of an answer to a frame: an answer that cannot reach a sidecar that ended needs no receiver,
/// because the frames of a sidecar end with its process, and any other failure is an error.
fn log_answer_error(place: &str, result: Result<(), crate::sidecars::ResponseError>) {
    match result {
        Ok(()) => {}
        Err(crate::sidecars::ResponseError::Ended(error)) => {
            crate::application_log::log_info(place, format!("not sent: {error}"))
        }
        Err(crate::sidecars::ResponseError::Failed(error)) => log_error(place, error),
    }
}

/// Records a frame that the host rejected together with the rejection reason and the current frame state of the region.
/// An unsupported frame is a defect of the sidecar, so it is an error, and a detached or replaced frame is a normal
/// race, so it is an observation.
#[allow(clippy::too_many_arguments)]
fn log_refused_frame(
    surface: &str,
    sender: &str,
    images: &Images,
    name: &str,
    generation: u64,
    raster: u64,
    sequence: i32,
    reason: &str,
) {
    let level = if reason == "unsupported" {
        "error"
    } else {
        "info"
    };
    crate::application_log::log_record(
        level,
        "host",
        "image frame",
        format!(
            "surface={surface} name={name} sender={sender} generation={generation} raster={raster} sequence={sequence} refused: {reason} current {}",
            images.frame_state(&(surface.to_string(), name.to_string()))
        ),
    );
}

/// Converts the detail of a frame that could not be presented into the response reason and the log line. A replaced
/// frame (stale, notAttached, staleRaster ...) is an invalidated frame and not a presentation failure, so the second
/// value is true. current is the current frame state of the failed region and is kept only in the line of a
/// presentation failure.
#[allow(clippy::too_many_arguments)]
pub fn presentation_outcome(
    surface: &str,
    name: &str,
    generation: u64,
    raster: u64,
    sequence: i32,
    token: u32,
    detail: &str,
    current: &str,
) -> (&'static str, bool, crate::application_log::Entry) {
    let frame = format!(
        "surface={surface} name={name} generation={generation} raster={raster} sequence={sequence} token={token} reason={detail}"
    );
    let reason = match detail {
        "stale" | "notAttached" => "stale",
        detail if detail.starts_with("staleRaster") => "stale",
        "notFound" => "notFound",
        "forbidden" => "forbidden",
        "size" => "size",
        "scale" => "scale",
        "unsupported" => "unsupported",
        _ => "presentFailed",
    };
    if reason == "stale" {
        return (
            reason,
            true,
            crate::application_log::Entry::new(
                "info",
                "host",
                "image present",
                format!("frame invalidated before native presentation: {frame}"),
            ),
        );
    }
    (
        reason,
        false,
        crate::application_log::Entry::new(
            "error",
            "host",
            "image present",
            format!("{frame} current {current}"),
        ),
    )
}
