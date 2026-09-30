//! 표면 페이지의 외부 그림 표시 영역. docs/spec/sidecars.md 의 "그림 봉투"와 관련된다.
//!
//! 표면 페이지가 그림을 네이티브 영역에 표시하도록 요청한다. 호스트는 표면 웹뷰 안에
//! 그림 영역을 만들고, 페이지가 알린 여백으로 배치하며, 사이드카가 보낸 그림을 영역에
//! 표시한다. 그림 영역은 표면 웹뷰의 하위 뷰이므로 표면과 함께 옮겨지고 숨겨진다.
//! 표면이 제거되거나 표면 페이지가 다시 읽히면 닫는다.
//!
//! 명령은 메인 스레드 밖에서 실행되고 네이티브 작업은 메인 스레드에서 실행한다. 메인 스레드에서
//! 시작한 정리는 기다리지 않는다.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use base64::Engine;
use serde::{Deserialize, Serialize};
use tauri::{Manager, Webview};

use crate::exposure::{self, on_main};
use crate::log_error;
use crate::platform::{self, Handle};
use crate::surfaces::{require_region, surface_handle};
use crate::windows::{emit_window, window_data};

/// 표면 페이지의 그림 영역 호출.
#[derive(Clone, Debug, Deserialize)]
pub struct Request {
    pub surface: String,
    pub name: String,
    pub sidecar: Option<String>,
}

/// 표면과 그림 이름의 쌍.
pub type Key = (String, String);

/// 그림 영역을 등록한 사이드카 소유자.
pub struct Owner {
    pub sidecar_owner: String,
}

/// 호출한 표면 caller 가 request.surface 이고 그림 이름이 올바른지 확인하고 키를 반환한다.
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

/// 창의 그림 영역.
#[derive(Clone, Default)]
pub struct Images {
    shared: Arc<Shared>,
}

#[derive(Default)]
struct Shared {
    inner: Mutex<Inner>,
    changed: Condvar,
}

struct Inner {
    handles: HashMap<Key, Handle>,
    owners: HashMap<Key, String>,
    sidecars: HashMap<Key, String>, // sidecar name for each image
    states: HashMap<Key, RasterState>,
    generations: HashMap<String, u64>,
    surface_visibility: HashMap<String, bool>,
    next_generation: u64,
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

impl Default for Inner {
    fn default() -> Self {
        Self {
            handles: HashMap::new(),
            owners: HashMap::new(),
            sidecars: HashMap::new(),
            states: HashMap::new(),
            generations: HashMap::new(),
            surface_visibility: HashMap::new(),
            next_generation: 0,
        }
    }
}

impl Images {
    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.shared
            .inner
            .lock()
            // 기본값: 잠금을 쥔 채 멈춘 스레드도 상태를 한 번의 넣기, 빼기, 읽기로만 바꾸므로 상태는 일관되고, 그 멈춤은 패닉 보고로 이미 알려졌다.
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn changed(&self) {
        self.shared.changed.notify_all();
    }

    /// 새 표면 문서가 시작될 때 이전 프레임과 구별할 세대를 만든다.
    pub fn begin_generation(&self, surface: &str) -> u64 {
        let mut inner = self.lock();
        inner.next_generation += 1;
        let generation = inner.next_generation;
        inner.generations.insert(surface.to_string(), generation);
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

    /// 제거한 표면의 현재 세대를 끝낸다. 번호는 다시 쓰지 않는다.
    pub fn end_generation(&self, surface: &str) {
        let mut inner = self.lock();
        inner.generations.remove(surface);
        if inner.states.keys().any(|key| key.0 == surface) {
            inner.surface_visibility.insert(surface.to_string(), false);
        } else {
            inner.surface_visibility.remove(surface);
        }
        self.changed();
    }

    /// 바깥 SurfaceHost의 표시 상태를 기록한다.
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
                    // Hiding a surface releases its native pixels. The same
                    // raster must be configured again when the surface returns.
                    // Advance the revision so frames from the hidden generation
                    // cannot be accepted after the surface is shown.
                    state.raster += 1;
                    state.configured = false;
                    state.last_sequence = 0;
                }
            }
        }
        self.changed();
    }

    /// 이름을 차지한다. sidecar 가 없거나 빈 문자열이면 오류를 반환한다.
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
        inner.states.insert(
            key.clone(),
            RasterState {
                generation,
                ..RasterState::default()
            },
        );
        self.changed();
        Ok(())
    }

    /// 차지한 이름에 만든 그림 영역의 주소를 적는다.
    pub fn set(&self, key: &Key, handle: Handle) -> bool {
        match self.lock().handles.get_mut(key) {
            Some(slot) => {
                *slot = handle;
                true
            }
            None => false,
        }
    }

    /// 만들어진 그림 영역의 주소를 반환한다.
    pub fn get(&self, key: &Key) -> Result<Handle, String> {
        match self.lock().handles.get(key) {
            Some(&handle) if handle != 0 => Ok(handle),
            _ => Err(format!("image {:?} is not attached", key.1)),
        }
    }

    /// 그림 영역을 등록한 사이드카 소유자를 반환한다.
    pub fn get_owner(&self, key: &Key) -> Result<String, String> {
        let inner = self.lock();
        // 기본값: 등록하지 않은 영역에는 주소가 없고, 주소 0 은 만드는 중이라 붙지 않은 영역이다.
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

    /// 그림 영역을 등록한 사이드카 이름을 반환한다.
    pub fn get_sidecar(&self, key: &Key) -> Result<String, String> {
        let inner = self.lock();
        // 기본값: 등록하지 않은 영역에는 주소가 없고, 주소 0 은 만드는 중이라 붙지 않은 영역이다.
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

    /// 이름을 제거하고 그 그림 영역의 주소를 반환한다.
    pub fn remove(&self, key: &Key) -> Result<Handle, String> {
        let mut inner = self.lock();
        match inner.handles.remove(key) {
            Some(handle) => {
                inner.owners.remove(key);
                inner.sidecars.remove(key);
                inner.states.remove(key);
                self.changed();
                Ok(handle)
            }
            None => Err(format!("image {:?} is not attached", key.1)),
        }
    }

    /// 표면의 이름을 모두 제거하고 만들어진 그림 영역의 주소를 반환한다.
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
            if let Some(handle) = inner.handles.remove(&key) {
                inner.owners.remove(&key);
                inner.sidecars.remove(&key);
                inner.states.remove(&key);
                if handle != 0 {
                    removed.push(handle);
                }
            }
        }
        // 문서 영역의 정리는 바깥 SurfaceHost의 표시 상태를 바꾸지 않는다.
        // 표면 자체가 닫힐 때 end_generation이 그 상태를 제거한다.
        self.changed();
        removed
    }

    /// 만들어진 그림 영역의 주소별 키.
    pub fn names(&self) -> HashMap<Handle, Key> {
        let inner = self.lock();
        inner
            .handles
            .iter()
            .filter(|(_, &handle)| handle != 0)
            .map(|(key, &handle)| (handle, key.clone()))
            .collect()
    }

    /// 재로드 전에 표면이 사용하는 사이드카를 반환한다.
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

    /// 만들어진 그림 영역의 주소.
    pub fn all(&self) -> Vec<Handle> {
        self.lock()
            .handles
            .values()
            .copied()
            .filter(|&handle| handle != 0)
            .collect()
    }

    /// 영역 자체와 바깥 표면이 모두 표시된 그림의 핸들을 반환한다.
    pub fn visible(&self) -> Vec<(Key, Handle)> {
        self.visible_where(|_, _| true)
    }

    /// 그 사이드카가 그리는 보이는 영역. 영속 사이드카의 연결이 다시 맺혔을 때 그
    /// 사이드카의 configure 를 다시 보내는 데 쓴다(V5-106).
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
                    // 기본값: 숨김을 알리지 않은 표면은 보인다(숨길 때만 surface_visibility 에 적는다).
                    .unwrap_or(true);
                // 기본값: 등록하지 않은 영역의 주소는 0 이며 붙지 않은 영역과 같다.
                let handle = inner.handles.get(key).copied().unwrap_or_default();
                (state.visible && outer && handle != 0).then(|| (key.clone(), handle))
            })
            .collect()
    }

    /// 그 사이드카의 연결이 끊겼다고 표시한다(V5-106). configure 를 받아든 연결이 죽었으므로
    /// configure 상태도 함께 죽는다 — 같은 크기라도 다시 보내야 새 연결의 서비스가 그림
    /// 상태를 만든다. 표시 순서 기록도 지운다 — 새 연결의 프레임은 순번을 처음부터 센다.
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

    /// 적용된 네이티브 래스터가 달라졌을 때 리비전을 올리고 보낼 설정을 반환한다.
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
            // 기본값: 숨김을 알리지 않은 표면은 보인다(숨길 때만 surface_visibility 에 적는다).
            .unwrap_or(true);
        // 기본값: 등록하지 않은 영역의 주소는 0 이며 붙지 않은 영역과 같다.
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

    /// 래스터가 없는 0 크기 배치에서도 영역의 표시 상태를 기록한다.
    pub fn set_visible(&self, key: &Key, visible: bool) -> Result<(), String> {
        let mut inner = self.lock();
        // 기본값: 등록하지 않은 영역의 주소는 0 이며 붙지 않은 영역과 같다.
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
        if let Some(state) = inner.states.get_mut(key) {
            if state.generation == generation && state.raster == raster {
                state.configured = false;
                state.presentation_error = None;
            }
        }
    }

    /// 현재 공급자와 정확한 래스터에 속하며 증가하는 프레임인지 확인한다.
    fn authorize_frame(
        &self,
        key: &Key,
        sender: &str,
        generation: u64,
        raster: u64,
        width: u32,
        height: u32,
        scale: f64,
        sequence: i32,
    ) -> Result<(), &'static str> {
        let mut inner = self.lock();
        // 기본값: 등록하지 않은 영역의 주소는 0 이며 붙지 않은 영역과 같다.
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

    /// 프레임이 메인 스레드에서 표시되기 직전에도 현재 래스터인지 검사한다.
    fn frame_status(
        &self,
        key: &Key,
        generation: u64,
        raster: u64,
        sequence: i32,
    ) -> Result<(), &'static str> {
        let inner = self.lock();
        // 기본값: 등록하지 않은 영역의 주소는 0 이며 붙지 않은 영역과 같다.
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

    /// 현재 래스터의 프레임이 네이티브 표시 저장소에 복사되었음을 기록한다.
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
                // 기본값: 숨김을 알리지 않은 표면은 보인다(숨길 때만 surface_visibility 에 적는다).
                .unwrap_or(true);
            // 기본값: 등록하지 않은 영역의 주소는 0 이며 붙지 않은 영역과 같다.
            inner.handles.get(key).copied().unwrap_or_default() == 0
                || !state.visible
                || !surface_visible
                || state.raster == 0
                || (state.last_sequence > 0
                    && state.presented_raster == state.raster
                    && state.presented_sequence == state.last_sequence)
        })
    }

    /// 보이는 모든 그림 영역이 현재 래스터를 표시했는지 반환한다.
    pub fn current_presented(&self) -> bool {
        Self::current_presented_locked(&self.lock())
    }

    /// 보이는 모든 그림 영역이 현재 래스터를 표시하거나 제한 시간이 끝날 때까지 기다린다.
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
                // 기본값: 잠금을 쥔 채 멈춘 스레드도 상태를 한 번의 넣기, 빼기, 읽기로만 바꾸므로 상태는 일관되고, 그 멈춤은 패닉 보고로 이미 알려졌다.
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            inner = next;
            if result.timed_out() && !Self::current_presented_locked(&inner) {
                let pending: Vec<_> = inner
                    .states
                    .iter()
                    .filter_map(|(key, state)| {
                        let surface_visible = inner
                            .surface_visibility
                            .get(&key.0)
                            .copied()
                            // 기본값: 숨김을 알리지 않은 표면은 보인다(숨길 때만 surface_visibility 에 적는다).
                            .unwrap_or(true);
                        // 기본값: 등록하지 않은 영역의 주소는 0 이며 붙지 않은 영역과 같다.
                        let handle = inner.handles.get(key).copied().unwrap_or_default();
                        let waiting = handle != 0
                            && state.visible
                            && surface_visible
                            && state.raster != 0
                            && !(state.last_sequence > 0
                                && state.presented_raster == state.raster
                                && state.presented_sequence == state.last_sequence);
                        waiting.then(|| format!(
                            "surface={} name={} generation={} raster={} sequence={} configured={} presentedRaster={} presentedSequence={} handle={}",
                            key.0,
                            key.1,
                            state.generation,
                            state.raster,
                            state.last_sequence,
                            state.configured,
                            state.presented_raster,
                            state.presented_sequence,
                            handle,
                        ))
                    })
                    .collect();
                eprintln!("image presentation timeout pending: {}", pending.join("; "));
                return Err("presentationTimeout".to_string());
            }
        }
    }
}

/// 호출한 표면 caller 의 웹뷰와 요청된 표면을 확인하고 window 를 반환한다.
fn owner(webview: &Webview, request: &Request) -> Result<(Key, tauri::Window), String> {
    let window = webview.window();
    crate::exposure::authorize_main_caller(webview.label(), window.label(), "surface operations")?;
    let key = check(Some(request.surface.as_str()), request)?;
    Ok((key, window))
}

/// 만든 그림 영역을 창에 등록하고 핸들을 반환한다. 만드는 동안 표면이 제거되면 닫는다.
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
            // 네이티브 입력은 소유 표면에만 보낸다. 파싱·전송 실패는 숨기지 않는다.
            let event_surface = surface_id.clone();
            let event_name = event_name.clone();
            let result = (|| {
                let event: serde_json::Value = serde_json::from_str(&json).map_err(|error| {
                    format!("image event {event_surface}/{event_name}: {error}")
                })?;
                // 포커스 전이는 성능 트레이스의 타임라인에도 남는다(V5-114, performance-trace
                // 스펙이 약속한 창 이벤트 줄). 트레이스가 꺼져 있으면 line 이 아무 것도 쓰지
                // 않는다.
                if event.get("type").and_then(|value| value.as_str()) == Some("focus") {
                    if let Some(workspace) = host.try_state::<crate::workspace::Workspace>() {
                        crate::performance::observe(workspace.directory(), "host", || {
                            serde_json::json!({
                                "event": "focus",
                                "surface": event_surface,
                                "name": event_name,
                                "focused": event.get("focused"),
                            })
                        });
                    }
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
                                format!("image event {deferred_surface}/{deferred_name}: {error}")
                            });
                        log_error(sent);
                        exposure::window_changed(&deferred_host);
                    }))
                    .map_err(|error| {
                        format!(
                            "image event {report_surface}/{report_name} scheduling failed: {error}"
                        )
                    })
            })();
            log_error(result);
        });
        let handle = platform.create_image(surface, &name, event)?;
        Ok(handle)
    })
}

/// 만들어진 그림 영역에 대해 메인 스레드에서 run 을 실행한다.
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

/// 호출한 표면 페이지의 요소에 그림 영역을 붙인다.
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

    // 이름을 먼저 차지한다. 네이티브 작업을 기다리는 동안 잠금을 쥐지 않는다.
    data.images.reserve(&key, "", sidecar)?;
    let handle = match create(webview, &window, &key, platform) {
        Ok(handle) => handle,
        Err(error) => {
            if let Err(e) = data.images.remove(&key) {
                eprintln!("failed to remove reserved image {}: {}", key.1, e);
            }
            return Err(error);
        }
    };
    if !data.images.set(&key, handle) {
        if let Err(e) = on_main(&window, move || {
            let platform = platform::current()?;
            platform.close_image(handle)
        }) {
            eprintln!("failed to close image on main thread: {}", e);
        }
        if let Err(e) = data.images.remove(&key) {
            eprintln!("failed to remove image after failed set: {}", e);
        }
        return Err(format!(
            "surface {:?} closed while its image was created",
            key.0
        ));
    }
    exposure::window_changed(&window);
    Ok(())
}

/// 그림 영역을 첫 응답자로 만들고 포커스 이벤트를 보낸다.
pub(crate) fn focus(webview: &Webview, request: Request) -> Result<(), String> {
    let platform = platform::current()?;
    with_image(webview, &request, move |handle| {
        platform.focus_image(handle)
    })?;
    exposure::window_changed(&webview.window());
    Ok(())
}

/// 캐럿(입력 커서) 위치를 받아 둔다.
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

/// 접근성 값으로 보일 문자열을 받아 둔다.
pub(crate) fn text(webview: &Webview, request: Request, text: String) -> Result<(), String> {
    let platform = platform::current()?;
    with_image(webview, &request, move |handle| {
        platform.text_image(handle, &text)
    })?;
    Ok(())
}

/// 그림 영역을 닫는다.
pub(crate) fn detach(webview: &Webview, request: Request) -> Result<(), String> {
    let (key, window) = owner(webview, &request)?;
    let Ok(data) = window_data(&window) else {
        return Err("cannot get window data".to_string());
    };
    require_region(&data.compositions, &key.0, &key.1, "image", None)?;
    let platform = platform::current()?;

    // 등록 해제와 닫기를 메인 스레드의 한 작업에서 한다.
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

/// 표면의 그림 영역을 모두 닫는다. 등록부 제거는 즉시 하고 native close만 메인 스레드에서 실행한다.
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

    log_error(
        window
            .run_on_main_thread(move || {
                if handles.is_empty() {
                    return;
                }
                for handle in handles {
                    log_error(platform.close_image(handle));
                }
                exposure::window_changed(&host);
            })
            .map_err(|e| e.to_string()),
    );
}

/// 이미지 봉투 의사 결정의 결과.
#[derive(Debug)]
pub enum Decision {
    /// 본문에 이미지 필드가 없음. 호출자가 페이지로 전달해야 함.
    NotImage,
    /// 응답을 사이드카에 보낼 오류.
    Reply {
        name: String,
        json: serde_json::Value,
    },
    /// 표시할 이미지.
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
    }
}

/// 이미지 봉투를 파싱하고 유효성을 검사하여 의사 결정을 반환한다.
/// body 는 "image" 필드를 포함하는 JSON 객체여야 한다.
/// 이미지 봉투가 아니면 NotImage 를 반환한다.
/// 유효하지 않으면 Reply 를 반환한다.
/// 유효하고 등록되어 있으면 Present 를 반환한다.
pub fn decide(body_str: &str, sender: &str, surface: &str, images: &Images) -> Decision {
    // 이벤트 본문을 파싱하여 image 필드 확인
    let obj: serde_json::Value = match serde_json::from_str(body_str) {
        Ok(obj) => obj,
        Err(_) => return Decision::NotImage,
    };

    let Some(image_val) = obj.get("image") else {
        return Decision::NotImage;
    };

    // 이미지 봉투 구조 정의
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
        Err(_) => return Decision::NotImage,
    };

    // 포맷과 토큰 종류 검증
    if envelope.format != "bgra8" || envelope.token.kind != "iosurface-global" {
        return image_reply(
            "unsupported",
            &envelope.name,
            envelope.generation,
            envelope.raster,
            envelope.sequence,
        );
    }

    // nonce 를 base64 에서 디코딩하여 [u8; 16] 배열로 변환
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

    // 디코딩된 nonce 가 정확히 16바이트여야 함
    if decoded_nonce.len() != 16 {
        return image_reply(
            "unsupported",
            &envelope.name,
            envelope.generation,
            envelope.raster,
            envelope.sequence,
        );
    }

    // nonce 를 [u8; 16] 배열로 변환
    let mut nonce: [u8; 16] = [0; 16];
    nonce.copy_from_slice(&decoded_nonce[..16]);

    let key = (surface.to_string(), envelope.name.clone());
    if let Err(reason) = images.authorize_frame(
        &key,
        sender,
        envelope.generation,
        envelope.raster,
        envelope.width,
        envelope.height,
        envelope.scale,
        envelope.sequence,
    ) {
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

/// 이미지 표시 후 응답을 생성한다.
/// 표시가 되었으면 consumed 응답을, 실패했으면 그 까닭을 오류로 반환한다.
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

/// 이미지 봉투를 처리한다. 메인 스레드에서 실행할 작업과 응답 전송 방식을 인자로 받는다.
/// 봉투를 처리했으면 true, 아니면 false를 반환한다.
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
    SendResponse: Fn(&str, serde_json::Value) -> Result<(), String>,
{
    handle_envelope_with_recovery(
        body_str,
        sender,
        surface,
        images,
        on_main,
        send_response,
        |_| Ok(()),
    )
}

/// Handle an image envelope and optionally request a fresh raster after a transient native
/// presentation failure. The recovery callback is deliberately separate from the response so the
/// caller can reconfigure the sidecar through its own transport without hiding the original error.
pub fn handle_envelope_with_recovery<OnMain, SendResponse, Recover>(
    body_str: &str,
    sender: &str,
    surface: &str,
    images: &Images,
    on_main: OnMain,
    send_response: SendResponse,
    recover: Recover,
) -> bool
where
    OnMain: Fn(Box<dyn Fn() -> Result<(), String> + Send>) -> Result<(), String>,
    SendResponse: Fn(&str, serde_json::Value) -> Result<(), String>,
    Recover: Fn(&str) -> Result<(), String>,
{
    let decision = decide(body_str, sender, surface, images);

    match decision {
        Decision::NotImage => false,
        Decision::Reply { name, json } => {
            if let Err(e) = send_response(&name, json) {
                eprintln!("image reply {}: {}", name, e);
            }
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
                        let actual = platform
                            .image_raster(handle)?
                            .ok_or_else(|| "stale".to_string())?;
                        if actual.width != width
                            || actual.height != height
                            || (actual.scale - scale).abs() > 0.000001
                        {
                            return Err("stale".to_string());
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
                        Err(e) => {
                            if e == "notAttached" {
                                eprintln!(
                                    "image frame invalidated before native presentation: surface={} name={} generation={} raster={} sequence={} token={} reason=stale",
                                    key.0, name, generation, raster, sequence, id
                                );
                            } else {
                                eprintln!(
                                    "image present on main thread error: surface={} name={} generation={} raster={} sequence={} token={} reason={}",
                                    key.0, name, generation, raster, sequence, id, e
                                );
                            }
                            let reason = match e.as_str() {
                                "stale" => "stale",
                                // The image registry can be detached after decide() but before
                                // this main-thread closure runs. That is an invalidated frame,
                                // not a failed presentation of the current surface.
                                "notAttached" => "stale",
                                "notFound" => "notFound",
                                "forbidden" => "forbidden",
                                "size" => "size",
                                "scale" => "scale",
                                "unsupported" => "unsupported",
                                "presentFailed" => "presentFailed",
                                _ => "presentFailed",
                            };
                            Some(reason)
                        }
                    };

                    if let Some(reason) = reason.as_deref().filter(|reason| *reason != "stale") {
                        images.mark_presentation_failed(&key, generation, raster, sequence, reason);
                        if reason == "notFound" {
                            if let Err(error) = recover(reason) {
                                eprintln!(
                                    "image recovery failed: surface={} name={} reason={} error={}",
                                    key.0, name, reason, error
                                );
                            }
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
                    if let Err(e) = send_response(&name, response) {
                        eprintln!("image response {}: {}", name, e);
                    }
                }
                Err(_) => {
                    let response =
                        after_present(Err("notAttached"), &name, generation, raster, sequence);
                    if let Err(e) = send_response(&name, response) {
                        eprintln!("image notAttached {}: {}", name, e);
                    }
                }
            }
            true
        }
    }
}
