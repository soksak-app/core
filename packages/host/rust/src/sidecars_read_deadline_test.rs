//! Checks the read deadline of a persistent connection after its hello: the connection of a silent service has none,
//! so its read thread does not wake and a silence does not end the connection.

use std::io::{Read, Write};
use std::os::unix::net::UnixListener;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::platform::{PersistentStream, current};

use super::end_hello_deadline;

/// A stream that records the deadlines that it receives.
struct RecordingStream {
    deadlines: Arc<Mutex<Vec<Option<Duration>>>>,
}

impl Read for RecordingStream {
    fn read(&mut self, _buffer: &mut [u8]) -> std::io::Result<usize> {
        Ok(0)
    }
}

impl Write for RecordingStream {
    fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
        Ok(buffer.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl PersistentStream for RecordingStream {
    fn try_clone(&self) -> Result<Box<dyn PersistentStream>, String> {
        Ok(Box::new(RecordingStream {
            deadlines: Arc::clone(&self.deadlines),
        }))
    }

    fn shutdown(&self) -> std::io::Result<()> {
        Ok(())
    }

    fn set_read_deadline(&self, timeout: Option<Duration>) -> Result<(), String> {
        self.deadlines.lock().unwrap().push(timeout);
        Ok(())
    }
}

// contract: sidecars-transport.hello.deadline-ends-with-its-answer
#[test]
fn a_connection_after_its_hello_has_no_read_deadline() {
    let deadlines = Arc::new(Mutex::new(Vec::new()));
    let stream = RecordingStream {
        deadlines: Arc::clone(&deadlines),
    };
    end_hello_deadline(&stream, "service").unwrap();
    assert_eq!(*deadlines.lock().unwrap(), vec![None]);
}

// contract: sidecars-transport.hello.deadline-ends-with-its-answer
#[test]
fn a_read_after_the_hello_deadline_waits_past_that_deadline() {
    let folder = tempfile::tempdir().unwrap();
    let address = folder.path().join("service.sock");
    let listener = UnixListener::bind(&address).unwrap();
    let mut stream = current()
        .unwrap()
        .connect_service(address.to_str().unwrap())
        .unwrap();
    let (mut service, _) = listener.accept().unwrap();
    let deadline = Duration::from_millis(50);
    stream.set_read_deadline(Some(deadline)).unwrap();
    let mut byte = [0u8; 1];
    let expired = stream.read(&mut byte).unwrap_err();
    assert_eq!(expired.kind(), std::io::ErrorKind::WouldBlock);

    end_hello_deadline(&*stream, "service").unwrap();
    let silence = deadline * 4;
    let writer = std::thread::spawn(move || {
        std::thread::sleep(silence);
        service.write_all(b"x").unwrap();
    });
    let began = Instant::now();
    assert_eq!(stream.read(&mut byte).unwrap(), 1);
    assert_eq!(&byte, b"x");
    assert!(began.elapsed() >= silence);
    writer.join().unwrap();
}
