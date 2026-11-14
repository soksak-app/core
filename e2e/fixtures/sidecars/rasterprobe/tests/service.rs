// The protocol of the persistent service (docs/spec/persistent-services.md, docs/spec/sidecars.md#messages and #image-envelope,
// docs/spec/native-surfaces.md#image-regions), judged on the real `sok-rasterprobe` executable as the host runs it: the test starts
// the service with a service folder and a log folder, reads its ready line and endpoint.json, connects to its unix socket, sends
// hello and then the lines of the host and of the page. A transfer image is judged by the global IOSurface that its token names:
// the test looks it up by id, reads its nonce and its pixels, and holds its use count as the window server does. The ids of the
// tokens are judged by their relations, and the events of the service are read from its event files.
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::net::UnixStream;
use std::os::unix::process::ExitStatusExt;
use std::path::PathBuf;
use std::process::{Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, TryRecvError};
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde_json::{Value, json};

/// The number of input sequences that the service keeps for the next frame of an image that does not draw.
const PENDING_INPUTS: u64 = 256;
/// The limit of every wait of a test: a line of the service, the exit of the service.
const WAIT: Duration = Duration::from_secs(20);

mod surface {
    use std::ffi::{CString, c_char, c_void};

    type CFTypeRef = *const c_void;
    type IOSurfaceRef = *mut c_void;

    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFStringCreateWithCString(allocator: CFTypeRef, text: *const c_char, encoding: u32) -> CFTypeRef;
        fn CFDataGetLength(data: CFTypeRef) -> isize;
        fn CFDataGetBytePtr(data: CFTypeRef) -> *const u8;
        fn CFRelease(value: CFTypeRef);
    }

    #[link(name = "IOSurface", kind = "framework")]
    unsafe extern "C" {
        fn IOSurfaceLookup(id: u32) -> IOSurfaceRef;
        fn IOSurfaceIncrementUseCount(surface: IOSurfaceRef);
        fn IOSurfaceDecrementUseCount(surface: IOSurfaceRef);
        fn IOSurfaceLock(surface: IOSurfaceRef, options: u32, seed: *mut u32) -> i32;
        fn IOSurfaceUnlock(surface: IOSurfaceRef, options: u32, seed: *mut u32) -> i32;
        fn IOSurfaceGetBaseAddress(surface: IOSurfaceRef) -> *mut c_void;
        fn IOSurfaceGetBytesPerRow(surface: IOSurfaceRef) -> usize;
        fn IOSurfaceGetWidth(surface: IOSurfaceRef) -> usize;
        fn IOSurfaceGetHeight(surface: IOSurfaceRef) -> usize;
        fn IOSurfaceCopyValue(surface: IOSurfaceRef, key: CFTypeRef) -> CFTypeRef;
    }

    const UTF8: u32 = 0x0800_0100;
    const LOCK_READ_ONLY: u32 = 1;

    /// The global IOSurface that a token names, looked up by its id as the host does.
    pub struct Image(IOSurfaceRef);

    impl Image {
        pub fn lookup(id: u32) -> Image {
            // SAFETY: the call takes an id and returns a retained surface or null.
            let surface = unsafe { IOSurfaceLookup(id) };
            assert!(!surface.is_null(), "the global IOSurface {id} does not exist");
            Image(surface)
        }

        pub fn size(&self) -> (u32, u32) {
            // SAFETY: the surface is alive while self is.
            unsafe { (IOSurfaceGetWidth(self.0) as u32, IOSurfaceGetHeight(self.0) as u32) }
        }

        /// The 16-byte nonce that the service stores under the key soksak.frame.
        pub fn nonce(&self) -> Vec<u8> {
            let key = CString::new("soksak.frame").unwrap();
            // SAFETY: the key is a NUL-terminated UTF-8 string; the data that the copy returns is released after its bytes are read.
            unsafe {
                let key = CFStringCreateWithCString(std::ptr::null(), key.as_ptr(), UTF8);
                let data = IOSurfaceCopyValue(self.0, key);
                CFRelease(key);
                assert!(!data.is_null(), "the surface holds no soksak.frame value");
                let bytes = std::slice::from_raw_parts(CFDataGetBytePtr(data), CFDataGetLength(data) as usize).to_vec();
                CFRelease(data);
                bytes
            }
        }

        /// The color (red, green, blue) of the pixel at x, y; the pixels are opaque BGRA.
        pub fn pixel(&self, x: u32, y: u32) -> (u8, u8, u8) {
            // SAFETY: the surface is locked read-only while its base address is read within its width and height.
            unsafe {
                assert_eq!(IOSurfaceLock(self.0, LOCK_READ_ONLY, std::ptr::null_mut()), 0, "IOSurfaceLock");
                let stride = IOSurfaceGetBytesPerRow(self.0);
                let base = IOSurfaceGetBaseAddress(self.0).cast::<u8>();
                let at = y as usize * stride + x as usize * 4;
                assert!(x < IOSurfaceGetWidth(self.0) as u32 && y < IOSurfaceGetHeight(self.0) as u32, "the pixel {x},{y} is outside");
                let bgra = std::slice::from_raw_parts(base.add(at), 4).to_vec();
                assert_eq!(IOSurfaceUnlock(self.0, LOCK_READ_ONLY, std::ptr::null_mut()), 0, "IOSurfaceUnlock");
                assert_eq!(bgra[3], 255, "the pixel {x},{y} is not opaque");
                (bgra[2], bgra[1], bgra[0])
            }
        }

        /// Raises the use count of the surface, as the window server does while it presents the image; the use ends when the
        /// returned value drops.
        pub fn hold(self) -> Hold {
            // SAFETY: the surface is alive while self is.
            unsafe { IOSurfaceIncrementUseCount(self.0) };
            Hold(self)
        }
    }

    impl Drop for Image {
        fn drop(&mut self) {
            // SAFETY: the lookup returned one retained reference, released once here.
            unsafe { CFRelease(self.0.cast_const()) };
        }
    }

    pub struct Hold(Image);

    impl Drop for Hold {
        fn drop(&mut self) {
            // SAFETY: the Hold keeps its reference to the surface, so it is alive.
            unsafe { IOSurfaceDecrementUseCount((self.0).0) };
        }
    }
}

static RUNS: AtomicU32 = AtomicU32::new(0);

/// One run of the real executable with its own temporary folder, which holds its service folder, its event files, its socket
/// folder (TMPDIR) and its standard error. Dropping it ends the process when it still runs and removes the folder.
struct Service {
    root: PathBuf,
    directory: PathBuf,
    pid: u32,
    token: String,
    version: String,
    exit: Receiver<std::io::Result<ExitStatus>>,
    exited: bool,
    socket: PathBuf,
}

impl Service {
    fn start() -> Service {
        let root = std::env::temp_dir().join(format!("rasterprobe-service-{}-{}", std::process::id(), RUNS.fetch_add(1, Ordering::Relaxed)));
        let directory = root.join("service");
        std::fs::create_dir_all(&directory).unwrap();
        // Every class stores its events at the level that the assertions read: the lifecycle at info, the requests and the frames at debug.
        std::fs::write(
            root.join("log-policy.json"),
            r#"{"schema":1,"classes":{"lifecycle":"info","input":"error","call":"error","io":"debug","frame":"debug"}}"#,
        )
        .unwrap();
        let stderr = std::fs::File::create(root.join("stderr.log")).unwrap();
        let mut child = Command::new(env!("CARGO_BIN_EXE_sok-rasterprobe"))
            .arg("--service-dir")
            .arg(&directory)
            .arg("--log-dir")
            .arg(root.join("logs"))
            .env("TMPDIR", &root)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(stderr)
            .spawn()
            .expect("start sok-rasterprobe");
        let pid = child.id();
        let mut ready = String::new();
        BufReader::new(child.stdout.take().unwrap()).read_line(&mut ready).expect("read the ready line");
        let (sender, exit) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            // The receiver is gone only when the test ended.
            let _ = sender.send(child.wait());
        });
        let mut service = Service { root, directory, pid, token: String::new(), version: String::new(), exit, exited: false, socket: PathBuf::new() };
        let line: Value = serde_json::from_str(&ready).unwrap_or_else(|error| panic!("the ready line {ready:?} is not JSON: {error}"));
        let published: Value = serde_json::from_slice(&std::fs::read(service.directory.join("endpoint.json")).unwrap()).unwrap();
        assert_eq!(line, published, "the ready line is the content of endpoint.json");
        assert_eq!((line["protocol"].as_u64(), line["pid"].as_u64()), (Some(1), Some(u64::from(pid))));
        service.token = line["token"].as_str().unwrap().to_string();
        service.socket = PathBuf::from(line["socket"].as_str().unwrap());
        let package: Value = serde_json::from_slice(&std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/package.json")).unwrap()).unwrap();
        service.version = package["version"].as_str().unwrap().to_string();
        service
    }

    fn connect(&self) -> Client {
        let stream = UnixStream::connect(&self.socket).unwrap_or_else(|error| panic!("{}: {error}", self.socket.display()));
        stream.set_read_timeout(Some(WAIT)).unwrap();
        Client { reader: BufReader::new(stream.try_clone().unwrap()), stream, barriers: 0 }
    }

    /// A client that sent hello with the token of the service.
    fn client(&self) -> Client {
        let mut client = self.connect();
        client.write(&json!({"operation": "hello", "protocol": 1, "token": self.token, "client": "/config"}));
        assert_eq!(client.read(), json!({"operation": "hello", "protocol": 1, "version": self.version, "ok": true}));
        client
    }

    /// The status of the process once it ended.
    fn wait_exit(&mut self) -> ExitStatus {
        let status = self.exit.recv_timeout(WAIT).unwrap_or_else(|error| panic!("the service did not end: {error}")).unwrap();
        self.exited = true;
        status
    }

    /// Whether the process has not ended.
    fn running(&mut self) -> bool {
        match self.exit.try_recv() {
            Err(TryRecvError::Empty) => true,
            _ => {
                self.exited = true;
                false
            }
        }
    }

    /// The events of the service from its event files, in the order of their seq.
    fn events(&self, name: &str) -> Vec<Value> {
        let mut events = Vec::new();
        for entry in std::fs::read_dir(self.root.join("logs")).unwrap() {
            let text = std::fs::read_to_string(entry.unwrap().path()).unwrap();
            events.extend(text.lines().map(|line| serde_json::from_str::<Value>(line).unwrap()).filter(|event| event["event"] == name));
        }
        events.sort_by_key(|event| event["seq"].as_u64().unwrap());
        events
    }

    fn event_fields(&self, name: &str) -> Vec<Value> {
        self.events(name).into_iter().map(|event| event["fields"].clone()).collect()
    }
}

impl Drop for Service {
    fn drop(&mut self) {
        if !self.exited && self.exit.try_recv().is_err() {
            // SAFETY: the call signals the process that this test started and that no wait has reaped.
            unsafe { libc::kill(self.pid as i32, libc::SIGKILL) };
            if let Err(RecvTimeoutError::Timeout) = self.exit.recv_timeout(WAIT) {
                eprintln!("the service {} did not end after SIGKILL", self.pid);
            }
        }
        // The folder holds only what this run made.
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

/// One connection to the service. The service answers the lines of a connection in order, so a line that has a known answer
/// follows each sent line: its answer ends the lines that the sent line caused, also when they are none.
struct Client {
    stream: UnixStream,
    reader: BufReader<UnixStream>,
    barriers: u32,
}

impl Client {
    fn write(&mut self, line: &Value) {
        self.stream.write_all(format!("{line}\n").as_bytes()).unwrap();
    }

    fn read(&mut self) -> Value {
        let mut line = String::new();
        let bytes = self.reader.read_line(&mut line).unwrap_or_else(|error| panic!("no line of the service within {WAIT:?}: {error}"));
        assert!(bytes > 0, "the service closed the connection");
        serde_json::from_str(&line).unwrap_or_else(|error| panic!("the line {line:?} is not JSON: {error}"))
    }

    /// Sends a line and returns the lines that the service wrote for it.
    fn send(&mut self, line: Value) -> Vec<Value> {
        self.write(&line);
        // A retain without surfaces is refused without changing the state of the service.
        self.barriers += 1;
        let request = format!("barrier-{}", self.barriers);
        self.write(&json!({"operation": "retain", "request": request}));
        let mut lines = Vec::new();
        loop {
            let answer = self.read();
            if answer["operation"] == "retained" && answer["request"] == request {
                assert_eq!(answer["ok"], false);
                return lines;
            }
            lines.push(answer);
        }
    }

    /// Sends a line and returns the lines that the service wrote until it closed the connection.
    fn send_until_closed(&mut self, line: Value) -> Vec<Value> {
        self.write(&line);
        self.read_until_closed()
    }

    fn read_until_closed(&mut self) -> Vec<Value> {
        let mut text = String::new();
        self.reader.read_to_string(&mut text).unwrap_or_else(|error| panic!("the connection did not end within {WAIT:?}: {error}"));
        text.lines().map(|line| serde_json::from_str(line).unwrap()).collect()
    }

    /// Ends the connection and returns once the service has handled its end: the service closes its side of the socket after it.
    fn end(mut self) {
        self.stream.shutdown(std::net::Shutdown::Write).unwrap();
        let lines = self.read_until_closed();
        assert!(lines.is_empty(), "the end of a connection writes nothing: {lines:?}");
    }
}

fn page(surface: &str, body: Value) -> Value {
    json!({"surface": surface, "root": "/project", "cids": ["b.1"], "body": body})
}

fn host(surface: &str, image: Value) -> Value {
    json!({"surface": surface, "root": "/project", "body": {"image": image}})
}

fn bodies(lines: &[Value]) -> Vec<Value> {
    lines.iter().map(|line| line["body"].clone()).collect()
}

fn drawing(generation: u64, drawing: bool) -> Value {
    json!({"drawing": {"name": "raster", "generation": generation, "drawing": drawing, "hidden": !drawing}})
}

fn configure(generation: u64, raster: u64) -> Value {
    json!({"configure": {"name": "raster", "generation": generation, "raster": raster, "width": 8, "height": 16, "scale": 1.0}})
}

fn answer(kind: &str, sequence: u64) -> Value {
    json!({kind: {"name": "raster", "generation": 1, "raster": 1, "sequence": sequence}})
}

fn token_id(line: &Value) -> u32 {
    line["body"]["image"]["token"]["id"].as_u64().unwrap_or_else(|| panic!("the line is no frame: {line}")) as u32
}

fn alive(pid: u64) -> bool {
    // SAFETY: signal 0 only checks that the process exists.
    unsafe { libc::kill(pid as i32, 0) == 0 }
}

#[test]
fn hello_needs_the_token_and_protocol_and_reports_the_version() {
    let service = Service::start();
    let refused = service.connect().send_until_closed(json!({"operation": "hello", "protocol": 1, "token": "wrong", "client": "/c"}));
    assert_eq!(refused, [json!({"operation": "hello", "ok": false, "error": "authentication failed"})]);
    let refused = service.connect().send_until_closed(json!({"operation": "hello", "protocol": 2, "token": service.token, "client": "/c"}));
    assert_eq!(refused[0]["error"], "protocol must be 1");
    service.client();
}

#[test]
fn an_open_with_an_image_draws_once_the_region_draws_at_its_configured_raster() {
    let service = Service::start();
    let mut client = service.client();
    let lines = client.send(page("tab-1", json!({"operation": "open", "image": "raster", "rows": 3, "color": "#102030"})));
    assert_eq!(lines.len(), 1);
    assert_eq!(lines[0]["cids"], json!(["b.1"]));
    let session = &lines[0]["body"];
    assert_eq!((session["event"].as_str(), session["session"].as_str(), session["created"].as_bool()), (Some("session"), Some("s1"), Some(true)));
    assert_eq!(session["service"], json!({"pid": service.pid, "version": service.version, "directory": service.directory.display().to_string()}));
    assert_eq!((session["mode"].as_str(), session["rows"].as_u64()), (Some("image"), Some(3)));
    let child = session["child"].as_u64().unwrap();
    assert!(child != u64::from(service.pid) && alive(child), "the session has its own running process: {child}");

    assert!(client.send(host("tab-1", json!({"drawing": {"name": "raster", "generation": 2, "drawing": true, "hidden": false}}))).is_empty(),
        "nothing is drawn before the raster is configured");
    let lines = client.send(host("tab-1",
        json!({"configure": {"name": "raster", "generation": 2, "raster": 5, "width": 160, "height": 96, "scale": 2.0}})));
    let bodies = bodies(&lines);
    let id = token_id(&lines[0]);
    let image = surface::Image::lookup(id);
    assert_eq!(bodies[0]["image"], json!({"name": "raster", "generation": 2, "raster": 5,
        "token": {"kind": "iosurface-global", "id": id, "nonce": STANDARD.encode(image.nonce())},
        "width": 160, "height": 96, "scale": 2.0, "format": "bgra8", "sequence": 1}));
    assert_eq!(image.nonce().len(), 16);
    assert_eq!(image.size(), (160, 96));
    assert_eq!(bodies[1]["event"], "frame");
    assert_eq!(bodies[1]["surface"], id);
    assert_eq!(bodies[1]["grid"], json!({"rows": 3, "cols": 10, "cellWidth": 16, "cellHeight": 32}));
    assert_eq!((bodies[1]["rows"].as_u64(), bodies[1]["color"].as_str(), bodies[1]["marker"].as_str()), (Some(3), Some("#102030"), Some("#020001")));
    assert!(bodies[1]["draw_us"].is_u64(), "the frame reports its paint time: {}", bodies[1]);

    // The painted pixels: three row bands that each end in a line of the session color, and the marker of generation 2, sequence 1.
    let (band, color) = ((255, 255, 255), (16, 32, 48));
    for top in [0, 32, 64] {
        assert_eq!(image.pixel(0, top), band, "the band at {top}");
        assert_eq!(image.pixel(0, top + 30), band, "the band at {top} reaches its last line but one");
        assert_eq!(image.pixel(0, top + 31), color, "the band at {top} ends in a line of the session color");
    }
    assert_eq!(image.pixel(159, 95), (2, 0, 1), "the marker carries the generation and the sequence");
    assert_eq!(image.pixel(128, 64), (2, 0, 1));
    assert_eq!(image.pixel(127, 64), band);
}

#[test]
fn a_frame_waits_for_the_answer_of_the_frame_in_flight_and_reuses_released_images() {
    let service = Service::start();
    let mut client = service.client();
    client.send(host("tab-1", drawing(1, true)));
    client.send(host("tab-1", configure(1, 1)));
    let opened = client.send(page("tab-1", json!({"operation": "open", "image": "raster"})));
    assert_eq!(opened[1]["body"]["image"]["sequence"], 1, "the open draws the configured raster");
    let first = token_id(&opened[1]);
    let rows = client.send(page("tab-1", json!({"operation": "rows", "count": 1})));
    assert_eq!(bodies(&rows), [json!({"event": "rows", "count": 1})], "a frame in flight holds the next frame");
    let next = client.send(host("tab-1", answer("leased", 1)));
    assert_eq!(next[0]["body"]["image"]["sequence"], 2);
    let second = token_id(&next[0]);
    assert_ne!(second, first, "the leased image is held, so another is created");
    client.send(host("tab-1", answer("released", 1)));
    client.send(host("tab-1", answer("leased", 2)));
    let in_use = surface::Image::lookup(first).hold();
    let third = client.send(page("tab-1", json!({"operation": "rows", "count": 0})));
    let third = token_id(&third[1]);
    assert!(third != first && third != second, "an image in use by the window server is not written: {first} {second} {third}");
    client.send(host("tab-1", answer("consumed", 3)));
    drop(in_use);
    let fourth = client.send(page("tab-1", json!({"operation": "color", "color": "#ffffff"})));
    assert_eq!(token_id(&fourth[1]), first, "a released image that left use is written again");
}

#[test]
fn a_region_that_does_not_draw_gets_no_frame_until_it_draws() {
    let service = Service::start();
    let mut client = service.client();
    client.send(page("tab-1", json!({"operation": "open", "image": "raster"})));
    client.send(host("tab-1", drawing(1, false)));
    let lines = client.send(host("tab-1", configure(1, 1)));
    assert!(lines.is_empty());
    let lines = client.send(host("tab-1", drawing(1, true)));
    assert_eq!(lines[0]["body"]["image"]["sequence"], 1);
}

#[test]
fn a_refused_frame_ends_its_wait_and_the_new_raster_is_drawn() {
    // A shown region is announced as drawing before its new raster, so the frame of the old raster is in flight when the
    // configure arrives; the host refuses it with the error answer of docs/spec/sidecars.md#image-envelope, whose member
    // error is the reason beside the identity of the frame.
    let service = Service::start();
    let mut client = service.client();
    client.send(page("tab-1", json!({"operation": "open", "image": "raster"})));
    client.send(host("tab-1", drawing(1, true)));
    client.send(host("tab-1", configure(1, 1)));
    client.send(host("tab-1", answer("leased", 1)));
    client.send(host("tab-1", drawing(1, false)));
    let shown = client.send(host("tab-1", drawing(1, true)));
    assert_eq!((shown[0]["body"]["image"]["raster"].as_u64(), shown[0]["body"]["image"]["sequence"].as_u64()), (Some(1), Some(2)));
    let configured = client.send(host("tab-1", configure(1, 2)));
    assert!(configured.is_empty(), "the frame in flight holds the frame of the new raster");
    let refused = client.send(host("tab-1", json!({"error": "stale", "name": "raster", "generation": 1, "raster": 1, "sequence": 2})));
    assert_eq!(refused.len(), 2, "the refusal ends the wait and the due frame is drawn: {refused:?}");
    assert_eq!((refused[0]["body"]["image"]["raster"].as_u64(), refused[0]["body"]["image"]["sequence"].as_u64()), (Some(2), Some(1)));
    let state = client.send(page("tab-1", json!({"operation": "state"})));
    assert_eq!(state[0]["body"]["error"], Value::Null, "a stale frame is no failure of the region");
    let failed = client.send(host("tab-1", json!({"error": "presentFailed", "name": "raster", "generation": 1, "raster": 2, "sequence": 1})));
    assert!(failed.is_empty(), "a failed frame draws nothing until the host configures again: {failed:?}");
    let state = client.send(page("tab-1", json!({"operation": "state"})));
    assert_eq!(state[0]["body"]["error"], "presentFailed", "the session reports the reason of a failed frame");
}

#[test]
fn a_detach_leaves_the_session_headless_and_follows_the_result_table() {
    let service = Service::start();
    let mut client = service.client();
    client.send(page("tab-1", json!({"operation": "open", "image": "raster"})));
    client.send(host("tab-1", configure(3, 1)));
    let detach = |client: &mut Client, request: &str, name: &str, generation: u64| {
        let lines = client.send(host("tab-1", json!({"detach": {"request": request, "name": name, "generation": generation}})));
        lines[0]["body"]["image"]["detached"].clone()
    };
    assert_eq!(detach(&mut client, "r0", "other", 3), json!({"request": "r0", "name": "other", "generation": 3, "ok": false, "error": "imageNameMismatch"}));
    assert_eq!(detach(&mut client, "r1", "raster", 2)["error"], "staleGeneration");
    assert_eq!(detach(&mut client, "r1", "raster", 2)["currentGeneration"], 3, "a replayed request keeps its result while no newer owner exists");
    assert_eq!(detach(&mut client, "r2", "raster", 4), json!({"request": "r2", "name": "raster", "generation": 4, "ok": false, "error": "futureGeneration", "currentGeneration": 3}));
    assert_eq!(detach(&mut client, "r3", "raster", 3), json!({"request": "r3", "name": "raster", "generation": 3, "ok": true, "result": "detached"}));
    assert_eq!(detach(&mut client, "r3", "raster", 3)["result"], "detached", "the same request replays its result");
    assert_eq!(detach(&mut client, "r3", "raster", 9)["error"], "requestMismatch");
    assert_eq!(detach(&mut client, "r4", "raster", 3)["result"], "alreadyDetached");
    assert_eq!(detach(&mut client, "r5", "raster", 1)["error"], "staleGeneration");
    let state = client.send(page("tab-1", json!({"operation": "state"})));
    assert_eq!((state[0]["body"]["mode"].as_str(), state[0]["body"]["session"].as_str()), (Some("headless"), Some("s1")));
    let headless = client.send(page("tab-1", json!({"operation": "open"})));
    assert_eq!((headless[0]["body"]["created"].as_bool(), headless[0]["body"]["mode"].as_str()), (Some(false), Some("headless")));
    let late = client.send(host("tab-1", json!({"configure": {"name": "raster", "generation": 3, "raster": 2, "width": 8, "height": 16, "scale": 1.0}})));
    assert!(late.is_empty(), "a configure of the detached generation is refused");
    let opened: Vec<Value> = service.event_fields("sidecar.rasterprobe.session").into_iter().filter(|fields| fields["action"] == "open").collect();
    assert_eq!(opened.len(), 1, "the detach and the headless open start no process: {opened:?}");
    assert_eq!(service.events("sidecar.rasterprobe.session")[0]["session"], "s1");
    assert_eq!(service.event_fields("sidecar.rasterprobe.surface_mode"),
        [json!({"mode": "image", "cause": "open"}), json!({"mode": "image", "cause": "configure"}),
         json!({"mode": "headless", "cause": "detach"}), json!({"mode": "headless", "cause": "open"})]);

    client.send(host("tab-1", drawing(5, true)));
    assert_eq!(detach(&mut client, "r6", "raster", 5)["result"], "detached", "a requested image without configuration detaches");
    let fresh = Service::start();
    let mut fresh_client = fresh.client();
    assert_eq!(detach(&mut fresh_client, "r7", "raster", 1)["result"], "alreadyAbsent");
}

#[test]
fn an_open_without_image_is_refused_while_the_surface_holds_one() {
    let service = Service::start();
    let mut client = service.client();
    client.send(page("tab-1", json!({"operation": "open", "image": "raster"})));
    let lines = client.send(page("tab-1", json!({"operation": "open"})));
    assert_eq!(lines[0]["body"]["error"], "imageAttached");
    assert!(lines[0]["body"]["reason"].as_str().unwrap().contains("holds image raster"));
}

#[test]
fn requests_are_recorded_with_their_cids_and_unknown_operations_fail() {
    let service = Service::start();
    let mut client = service.client();
    let lines = client.send(page("tab-1", json!({"operation": "rows", "count": 2})));
    assert_eq!(bodies(&lines), [json!({"error": "no session for surface tab-1"})]);
    client.send(page("tab-1", json!({"operation": "open"})));
    let lines = client.send(page("tab-1", json!({"operation": "dance"})));
    assert_eq!(bodies(&lines), [json!({"error": "unknown operation dance"})]);
    let refused = client.send(page("tab-1", json!({"operation": "input", "text": "a"})));
    assert_eq!(bodies(&refused), [json!({"error": "input requires a non-negative integer sequence"})]);
    let input = client.send(page("tab-1", json!({"operation": "input", "sequence": 1, "text": "a"})));
    assert_eq!(input[0]["cids"], json!(["b.1"]));
    let requests = service.events("sidecar.rasterprobe.request");
    assert_eq!(requests.len(), 5);
    assert_eq!(requests[4]["cids"], json!(["b.1"]));
    assert_eq!(requests[4]["fields"]["operation"], "input");
    assert_eq!(requests[4]["surface"], "tab-1");
}

#[test]
fn sessions_outlive_their_connection_and_close_by_closed_retain_and_owner_close() {
    let mut service = Service::start();
    let mut client = service.client();
    let mut children = Vec::new();
    for surface in ["tab-1", "tab-2", "tab-3"] {
        let opened = client.send(page(surface, json!({"operation": "open"})));
        children.push(opened[0]["body"]["child"].as_u64().unwrap());
    }
    client.end();
    assert!(children.iter().all(|child| alive(*child)), "the sessions outlive their connection: {children:?}");
    let mut client = service.client();
    let again = client.send(page("tab-1", json!({"operation": "open"})));
    assert_eq!((again[0]["body"]["session"].as_str(), again[0]["body"]["created"].as_bool()), (Some("s1"), Some(false)));
    let closed = client.send(json!({"surface": "tab-1", "root": "/project", "closed": true}));
    assert_eq!(closed, [json!({"surface": "tab-1", "closed": true})]);
    let retained = client.send(json!({"operation": "retain", "request": "k1", "surfaces": [{"surface": "tab-2", "root": "/project"}]}));
    assert_eq!(retained, [json!({"operation": "retained", "request": "k1", "ok": true, "closed": 1})]);
    let refused = client.send(json!({"operation": "retain", "request": "k2", "surfaces": [{"surface": "tab-2"}]}));
    assert_eq!(refused[0]["ok"], false);
    let early = client.send(json!({"operation": "shutdown", "request": "q0"}));
    assert_eq!(early[0]["error"], "shutdown is accepted only after close-owner");
    let owner = client.send(json!({"operation": "close-owner", "request": "o1"}));
    assert_eq!(owner, [json!({"operation": "closed-owner", "request": "o1", "ok": true})]);
    let shutdown = client.send(json!({"operation": "shutdown", "request": "q1"}));
    assert_eq!(shutdown, [json!({"operation": "shutdown", "request": "q1", "ok": true})]);
    let closes: Vec<Value> =
        service.events("sidecar.rasterprobe.session").into_iter().filter(|event| event["fields"]["action"] == "close").map(|event| event["session"].clone()).collect();
    assert_eq!(closes, ["s1", "s3", "s2"]);
    assert!(children.iter().all(|child| !alive(*child)), "each closed session ended its process: {children:?}");
    assert!(service.running(), "the service runs until the shut-down client is gone");
    client.end();
    assert!(service.wait_exit().success(), "the service exits once the shut-down client is gone");
}

#[test]
fn the_end_of_a_connection_ends_its_images_and_a_new_configure_draws_again() {
    let service = Service::start();
    let mut client = service.client();
    client.send(page("tab-1", json!({"operation": "open", "image": "raster"})));
    client.send(host("tab-1", drawing(1, true)));
    client.send(host("tab-1", configure(1, 1)));
    client.end();
    let mut client = service.client();
    client.send(host("tab-1", drawing(1, true)));
    let lines = client.send(host("tab-1", configure(1, 1)));
    assert_eq!(lines[0]["body"]["image"]["sequence"], 1, "the new connection draws from the first sequence");
}

#[test]
fn each_input_makes_a_frame_whose_event_names_the_inputs_it_presents() {
    let service = Service::start();
    let mut client = service.client();
    client.send(page("tab-1", json!({"operation": "open", "image": "raster"})));
    client.send(host("tab-1", drawing(1, true)));
    let first = client.send(host("tab-1", configure(1, 1)));
    assert_eq!(bodies(&first)[1]["inputs"], json!([]), "a frame that follows no input names none");
    let input = |sequence: u64| page("tab-1", json!({"operation": "input", "sequence": sequence, "actions": [], "preedit": null}));
    // The frame of the configure is in flight, so the inputs wait for its answer and the next frame presents both.
    let held = client.send(input(1));
    assert_eq!(bodies(&held), [json!({"event": "input", "received": {"operation": "input", "sequence": 1, "actions": [], "preedit": null}})]);
    client.send(input(2));
    let next = client.send(host("tab-1", answer("leased", 1)));
    let next = bodies(&next);
    assert_eq!((next[0]["image"]["sequence"].as_u64(), next[1]["event"].as_str(), next[1]["sequence"].as_u64()), (Some(2), Some("frame"), Some(2)));
    assert_eq!(next[1]["inputs"], json!([1, 2]));
    // With no frame in flight, an input draws its own frame right after its answer.
    client.send(host("tab-1", answer("leased", 2)));
    let own = bodies(&client.send(input(3)));
    assert_eq!((own[0]["event"].as_str(), own[1]["image"]["sequence"].as_u64(), own[2]["inputs"].clone()), (Some("input"), Some(3), json!([3])));
    let rows = bodies(&client.send(host("tab-1", answer("leased", 3))));
    assert!(rows.is_empty(), "no input and no change makes no frame: {rows:?}");
    assert_eq!(service.events("sidecar.rasterprobe.frame").len(), 3);

    // A region that does not draw keeps the last PENDING_INPUTS inputs for its next frame.
    client.send(host("tab-1", drawing(1, false)));
    for sequence in 4..(4 + PENDING_INPUTS + 2) {
        client.send(input(sequence));
    }
    let shown = bodies(&client.send(host("tab-1", drawing(1, true))));
    let inputs: Vec<u64> = shown[1]["inputs"].as_array().unwrap().iter().filter_map(Value::as_u64).collect();
    assert_eq!(inputs, (6..(6 + PENDING_INPUTS)).collect::<Vec<u64>>());
}

#[test]
fn a_headless_session_answers_input_without_a_frame() {
    let service = Service::start();
    let mut client = service.client();
    client.send(page("tab-1", json!({"operation": "open"})));
    let lines = client.send(page("tab-1", json!({"operation": "input", "sequence": 1, "actions": [], "preedit": null})));
    assert_eq!(bodies(&lines), [json!({"event": "input", "received": {"operation": "input", "sequence": 1, "actions": [], "preedit": null}})]);
}

#[test]
fn only_a_frame_and_a_detach_answer_carry_the_member_image() {
    let service = Service::start();
    let mut client = service.client();
    let mut lines = Vec::new();
    lines.extend(client.send(page("tab-1", json!({"operation": "open", "image": "raster"}))));
    lines.extend(client.send(host("tab-1", drawing(1, true))));
    lines.extend(client.send(host("tab-1", configure(1, 1))));
    for body in [json!({"operation": "state"}), json!({"operation": "rows", "count": 1}), json!({"operation": "color", "color": "#101010"}),
        json!({"operation": "textSize", "factor": 1.5}), json!({"operation": "input", "sequence": 1, "actions": [], "preedit": null}),
        json!({"operation": "open", "image": "raster"}), json!({"operation": "open"}), json!({"operation": "dance"})] {
        lines.extend(client.send(page("tab-1", body)));
    }
    lines.extend(client.send(host("tab-1", answer("leased", 1))));
    lines.extend(client.send(host("tab-1", json!({"detach": {"request": "d1", "name": "raster", "generation": 1}}))));
    lines.extend(client.send(page("tab-1", json!({"operation": "state"}))));
    lines.extend(client.send(page("tab-1", json!({"operation": "close"}))));
    let sessions: Vec<&Value> = lines.iter().map(|line| &line["body"]).filter(|body| body["event"] == "session" || body["event"] == "state").collect();
    assert!(sessions.len() >= 3, "the reports of the session were sent: {lines:?}");
    assert!(sessions.iter().all(|body| body.get("region").is_some()), "a session report names its region: {sessions:?}");
    let mut frames = 0;
    for line in &lines {
        let Some(image) = line["body"].get("image") else { continue };
        let image = image.as_object().unwrap_or_else(|| panic!("the member image is not an envelope: {line}"));
        if image.contains_key("detached") {
            assert_eq!(image.len(), 1, "a detach answer holds only detached: {line}");
        } else {
            assert!(image.contains_key("token") && image.contains_key("sequence"), "the member image is not a frame: {line}");
            frames += 1;
        }
    }
    assert!(frames >= 2, "the frames were sent: {lines:?}");
}

#[test]
fn kill_ends_the_service_without_an_answer() {
    let mut service = Service::start();
    let mut client = service.client();
    let lines = client.send_until_closed(page("tab-1", json!({"operation": "kill"})));
    assert!(lines.is_empty(), "the kill is not answered: {lines:?}");
    assert_eq!(service.wait_exit().signal(), Some(libc::SIGKILL));
}
