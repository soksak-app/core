//! The index of the event files and the query over them (docs/spec/logging.md#index, docs/spec/logging.md#query): the endpoint method
//! `log.query`, the host call `logQuery`, the index that follows the writer, and the event of an index that is built from the file. The
//! same cases run in the Go host.

#[path = "support/records.rs"]
mod records;

use std::path::{Path, PathBuf};
use std::sync::mpsc::channel;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::value::RawValue;
use serde_json::{json, Map, Value};
use soksak_host_tauriv2::endpoint::{self, raw, Connection, Endpoint, Failure, Service};
use soksak_host_tauriv2::event_log::{EventLog, Level, Options};
use soksak_host_tauriv2::event_record::use_host_event_log;
use soksak_host_tauriv2::log_query::{
    index_reporter, query_event_logs, start_log_indexer, QueryError,
};
use soksak_sok::log_index::{read_log_index, update_log_index};

/// The records of the host are process-wide, so the tests of this file that attach a writer run one at a time.
static SERIAL: Mutex<()> = Mutex::new(());

/// A service that has only the window main and replies null.
struct Fake;

impl Service for Fake {
    fn windows(&self) -> Result<Value, Failure> {
        Ok(json!([{"window": "main", "title": "Main", "project": null, "key": true}]))
    }

    fn exists(&self, window: &str) -> bool {
        window == "main"
    }

    fn call(
        &self,
        _window: &str,
        _method: &str,
        _params: Map<String, Value>,
    ) -> Result<Box<RawValue>, Failure> {
        raw(&Value::Null)
    }
}

/// The lines of an event file of boot b1: `log.open` as seq 1 and then `host.x.y` events up to seq `count`.
fn event_lines(count: i64) -> String {
    let mut text = String::from(
        "{\"ts_us\":1000,\"mono_ns\":1,\"seq\":1,\"level\":\"info\",\"layer\":\"host\",\"event\":\"log.open\",\"fields\":{\"schema\":2,\"pid\":1,\"role\":\"host\",\"boot\":\"b1\"}}\n",
    );
    for seq in 2..=count {
        text.push_str(&format!(
            "{{\"ts_us\":{},\"mono_ns\":{seq},\"seq\":{seq},\"level\":\"debug\",\"layer\":\"host\",\"event\":\"host.x.y\",\"fields\":{{\"n\":{seq}}}}}\n",
            1000 + seq
        ));
    }
    text
}

fn write_event_file(config: &Path, name: &str, text: &str) -> PathBuf {
    let logs = config.join("logs");
    std::fs::create_dir_all(&logs).unwrap();
    let path = logs.join(name);
    std::fs::write(&path, text).unwrap();
    path
}

fn request(connection: &mut Box<dyn Connection>, id: u64, method: &str, params: Value) -> Value {
    endpoint::write_frame(
        connection,
        &json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}),
    )
    .unwrap();
    endpoint::read_frame(connection)
        .unwrap()
        .expect("the endpoint closed the connection")
}

/// Runs `body` with an endpoint on `config` and a connection to it.
fn with_endpoint<T>(config: &Path, body: impl FnOnce(&mut Box<dyn Connection>) -> T) -> T {
    let endpoint = Endpoint::start(
        &config.join("sockets"),
        config,
        "test-log-query",
        Arc::new(Fake),
    )
    .unwrap();
    endpoint.publish("main").unwrap();
    let mut connection = endpoint::connect(endpoint.address()).unwrap();
    connection
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    let result = body(&mut connection);
    endpoint.stop();
    result
}

// contract: log.endpoint.query-answers-one-page
#[test]
fn the_endpoint_method_log_query_answers_one_page() {
    let config = tempfile::tempdir().unwrap();
    let path = write_event_file(config.path(), "host-b1.jsonl", &event_lines(5));
    with_endpoint(config.path(), |connection| {
        let reply = request(
            connection,
            1,
            "log.query",
            json!({"channel": "all", "limit": 3}),
        );
        assert!(reply.get("error").is_none(), "log.query failed: {reply}");
        let page = &reply["result"];
        let seqs: Vec<i64> = page["rows"]
            .as_array()
            .unwrap()
            .iter()
            .map(|row| row["event"]["seq"].as_i64().unwrap())
            .collect();
        assert_eq!(seqs, vec![1, 2, 3], "{page}");
        let first = &page["rows"][0];
        assert_eq!(
            (
                first["file"].as_str(),
                first["role"].as_str(),
                first["boot"].as_str()
            ),
            (Some("logs/host-b1.jsonl"), Some("host"), Some("b1"))
        );
        assert_eq!(page["next"]["seq"], 3, "{page}");
        assert_eq!(page["tail"]["host-b1"], 5, "{page}");
        assert_eq!(
            (
                page["scanned"]["logs"].as_i64(),
                page["scanned"]["rebuilt"].as_i64()
            ),
            (Some(1), Some(1)),
            "{page}"
        );

        let refused = request(connection, 2, "log.query", json!({"level": "loud"}));
        assert_eq!(refused["error"]["code"], -32602, "{refused}");
        assert_eq!(
            refused["error"]["message"],
            r#"log query level "loud" is not one of error, warn, info, debug, trace"#
        );
        let none = request(connection, 3, "log.query", Value::Null);
        assert_eq!(
            (
                none["error"]["code"].as_i64(),
                none["error"]["message"].as_str()
            ),
            (Some(-32602), Some("params must be an object")),
            "{none}"
        );

        let mut appended = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap();
        std::io::Write::write_all(&mut appended, b"not json\n").unwrap();
        let broken = request(connection, 4, "log.query", json!({}));
        assert_eq!(broken["error"]["code"], -32000, "{broken}");
        assert!(
            broken["error"]["message"]
                .as_str()
                .unwrap()
                .contains("logs/host-b1.jsonl:6: not JSON: not json"),
            "{broken}"
        );
    });
}

// contract: debug.log-query.answers-the-query-of-the-endpoint
#[test]
fn the_host_call_log_query_answers_the_query_of_the_endpoint() {
    let config = tempfile::tempdir().unwrap();
    write_event_file(config.path(), "host-b1.jsonl", &event_lines(8));
    let params = json!({"order": "desc", "limit": 4, "event_prefix": "host.x"});
    let from_endpoint = with_endpoint(config.path(), |connection| {
        let reply = request(connection, 1, "log.query", params.clone());
        assert!(reply.get("error").is_none(), "log.query failed: {reply}");
        reply["result"].clone()
    });
    let page =
        query_event_logs(config.path(), &params.to_string()).expect("the query of the host call");
    let mut from_call = serde_json::to_value(&page).unwrap();
    let mut from_endpoint = from_endpoint;
    // The second query found the index built by the first one.
    from_call["scanned"]
        .as_object_mut()
        .unwrap()
        .remove("rebuilt");
    from_endpoint["scanned"]
        .as_object_mut()
        .unwrap()
        .remove("rebuilt");
    assert_eq!(from_call, from_endpoint);
    // Its error is the text of the query.
    let error = query_event_logs(config.path(), r#"{"level":"loud"}"#).unwrap_err();
    assert_eq!(
        error,
        QueryError::Invalid(
            r#"log query level "loud" is not one of error, warn, info, debug, trace"#.into()
        )
    );
}

fn writer_options(logs: &Path) -> Options {
    Options {
        directory: logs.to_path_buf(),
        role: "host".into(),
        boot: "b1".into(),
        queue_events: 64,
        queue_bytes: 64 * 1024,
        batch_interval: Duration::from_millis(20),
        rotate_bytes: 6 << 10,
        pull: None,
        pull_loss: None,
        policy_path: None,
        retention_bytes: 1 << 40,
    }
}

fn lines(path: &Path) -> i64 {
    std::fs::read_to_string(path).unwrap().matches('\n').count() as i64
}

// contract: log.writer.indexes-each-batch-it-wrote
#[test]
fn the_index_covers_each_batch_the_writer_wrote() {
    let config = tempfile::tempdir().unwrap();
    let log = EventLog::start(writer_options(&config.path().join("logs"))).unwrap();
    let (results, updates) = channel();
    let (observe, stop) = start_log_indexer(move |_path, result| {
        let _ = results.send(result);
    });
    log.set_on_write(observe);
    for index in 0..80 {
        // The queue holds 64 events, so the writer is given time between the bursts.
        while !log.emit(
            Level::Info,
            "host.x.y",
            &json!({"n": index, "text": "x".repeat(120)}),
        ) {
            std::thread::sleep(Duration::from_millis(5));
        }
    }
    log.flush(Duration::from_secs(5)).unwrap();
    let path = log.path().to_path_buf();
    // The index of the file covers the lines of the batches without a query: wait for the updates that the writes caused.
    loop {
        if read_log_index(&path).is_ok_and(|info| info.events == lines(&path)) {
            break;
        }
        let result = updates
            .recv_timeout(Duration::from_secs(10))
            .expect("no update of the index followed the writes");
        assert!(result.is_ok(), "an update of the index failed: {result:?}");
    }
    // The writer rotated at least once, and the index of each closed generation covers its whole file without a build.
    let mut closed = 0;
    for generation in 1..=3 {
        let mut name = path.clone().into_os_string();
        name.push(format!(".{generation}"));
        let file = PathBuf::from(name);
        if !file.exists() {
            continue;
        }
        closed += 1;
        let info = read_log_index(&file)
            .unwrap_or_else(|error| panic!("generation {generation}: {error}"));
        assert_eq!(info.events, lines(&file), "generation {generation}");
        assert!(
            !update_log_index(&file).unwrap().changed,
            "generation {generation} needed a build"
        );
    }
    assert!(closed > 0, "the writer did not rotate");
    stop();
}

// contract: log.writer.stores-an-event-for-each-index-built-from-the-file
#[test]
fn an_index_built_from_the_file_is_an_event_and_an_append_is_not() {
    let _serial = SERIAL.lock().unwrap_or_else(|poison| poison.into_inner());
    let writer_config = tempfile::tempdir().unwrap();
    let log: Arc<EventLog> = records::start_writer(writer_config.path());
    let config = tempfile::tempdir().unwrap();
    let path = write_event_file(config.path(), "host-x1.jsonl", &event_lines(6));
    let rebuilt = |log: &EventLog| -> Vec<Value> {
        log.flush(Duration::from_secs(5)).unwrap();
        records::read_events(&records::event_log_path(writer_config.path()))
            .into_iter()
            .filter(|event| {
                event["event"] == "host.log.index_rebuilt"
                    && event["fields"]["file"] == "logs/host-x1.jsonl"
            })
            .collect()
    };
    query_event_logs(config.path(), "{}").expect("query");
    let found = rebuilt(&log);
    assert_eq!(found.len(), 1, "{found:?}");
    let fields = &found[0]["fields"];
    assert!(
        found[0]["level"] == "info"
            && fields["reason"] == "the index did not exist"
            && fields["lines"] == 6
            && fields["bytes"].as_i64().unwrap() > 0
            && fields["micros"].as_i64().unwrap() >= 0,
        "{}",
        found[0]
    );
    let mut appended = std::fs::OpenOptions::new()
        .append(true)
        .open(&path)
        .unwrap();
    std::io::Write::write_all(
        &mut appended,
        b"{\"ts_us\":2000,\"mono_ns\":9,\"seq\":7,\"level\":\"info\",\"layer\":\"host\",\"event\":\"host.x.y\",\"fields\":{}}\n",
    )
    .unwrap();
    drop(appended);
    assert_eq!(
        query_event_logs(config.path(), "{}")
            .expect("query after the append")
            .rows
            .len(),
        7
    );
    assert_eq!(
        rebuilt(&log).len(),
        1,
        "an incremental update stored an event"
    );

    // A failed update is shown once for each distinct text as an error record of the place `log index`.
    let mut report = index_reporter();
    report(&path, Err("first".into()));
    report(&path, Err("first".into()));
    report(&path, Err("second".into()));
    report(&path, Ok(Default::default()));
    report(&path, Err("first".into()));
    log.flush(Duration::from_secs(5)).unwrap();
    let texts: Vec<String> = records::read_events(&records::event_log_path(writer_config.path()))
        .into_iter()
        .filter(|event| {
            event["event"] == "host.record.error" && event["fields"]["where"] == "log index"
        })
        .map(|event| event["fields"]["text"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(texts, vec!["first", "second", "first"]);
    use_host_event_log(None);
}
