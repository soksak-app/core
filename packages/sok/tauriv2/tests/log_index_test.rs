//! The index beside an event file (docs/spec/logging.md#index): its bytes for the golden files, its follow of appended lines, its rebuild
//! of a file that is not the one it indexed, its refusal of damage, and its move with the generations of a rotation.

#[path = "log_support_test.rs"]
mod log_support;

use std::io::Write;
use std::path::Path;
use std::time::{Duration, SystemTime};

use log_support::*;
use serde_json::Value;
use soksak_sok::log_index::{read_log_index, rotate_log_indexes, update_log_index};
use soksak_sok::log_query::{parse_log_query, query_logs};

/// A change of the bytes of an index file.
type Damage = Box<dyn Fn(&mut Vec<u8>)>;

fn digests() -> Value {
    let text = std::fs::read_to_string(Path::new(QUERY_FIXTURES).join("digests.json"))
        .expect("digests.json");
    serde_json::from_str(&text).expect("digests are JSON")
}

// contract: log.index.matches-the-golden-digest
#[test]
fn index_matches_the_golden_digest() {
    let want = digests();
    let config = fixture_config("index-digest");
    let files = want["logs"].as_object().expect("logs");
    assert_eq!(
        files.len(),
        5,
        "the golden digests hold {} files",
        files.len()
    );
    for (name, digest) in files {
        let path = config.join("logs").join(name);
        let update = update_log_index(&path).expect("update");
        assert!(update.changed && update.rebuilt, "{name}: {update:?}");
        let index = path.with_file_name(format!("{name}.idx"));
        assert_eq!(
            &digest_of(&index),
            digest.as_str().expect("digest"),
            "{name}: the digest of the index"
        );
        let again = update_log_index(&path).expect("update again");
        assert!(
            !again.changed,
            "{name}: an update of a current index changed it: {again:?}"
        );
        assert_eq!(
            &digest_of(&index),
            digest.as_str().expect("digest"),
            "{name}: an update of a current index changed its digest"
        );
    }
    let (_config, path, _events) = write_big("index-digest-big");
    assert_eq!(
        digest_of(&path),
        want["big"]["source"].as_str().expect("source"),
        "the generated log"
    );
    update_log_index(&path).expect("update the generated log");
    let index = path.with_file_name("host-big.jsonl.idx");
    assert_eq!(
        digest_of(&index),
        want["big"]["index"].as_str().expect("index"),
        "the index of the generated log"
    );
    let info = read_log_index(&path).expect("info");
    assert_eq!(
        (
            info.events,
            info.full_segments,
            info.tail_events,
            info.first_seq,
            info.last_seq
        ),
        (
            BIG_COUNT as i64,
            2,
            BIG_COUNT as i64 - 2 * 4096,
            1,
            BIG_COUNT as i64
        ),
        "{info:?}"
    );
}

fn event_line_of(seq: i64) -> String {
    if seq == 1 {
        return r#"{"ts_us":1000,"mono_ns":1,"seq":1,"level":"info","layer":"host","event":"log.open","fields":{"schema":2,"pid":1,"role":"host","boot":"a"}}"#.to_string();
    }
    format!(
        r#"{{"ts_us":{},"mono_ns":{seq},"seq":{seq},"level":"debug","layer":"host","event":"host.x.y","fields":{{"n":{seq}}}}}"#,
        1000 + seq
    )
}

fn lines_of(from: i64, to: i64) -> String {
    (from..=to).map(|seq| event_line_of(seq) + "\n").collect()
}

fn temp_file(name: &str) -> std::path::PathBuf {
    temp_dir(name).join("logs").join("host-a.jsonl")
}

// contract: log.index.follows-appended-lines-and-is-rebuilt-when-stale
#[test]
fn index_follows_appended_lines_and_is_rebuilt_when_stale() {
    let path = temp_file("index-follow");
    let complete = lines_of(1, 4);
    let partial = event_line_of(5);
    std::fs::write(&path, format!("{complete}{}", &partial[..20])).expect("write");
    let update = update_log_index(&path).expect("first update");
    assert!(
        update.changed && update.rebuilt && update.reason == "the index did not exist",
        "{update:?}"
    );
    let info = read_log_index(&path).expect("info");
    assert_eq!(
        (
            info.events,
            info.indexed_bytes,
            info.full_segments,
            info.tail_events
        ),
        (4, complete.len() as i64, 0, 4),
        "the bytes after the last line feed must not be indexed: {info:?}"
    );

    // The line is finished and 5,000 lines follow: the update indexes from the partial segment on.
    let mut file = std::fs::OpenOptions::new()
        .append(true)
        .open(&path)
        .expect("append");
    write!(file, "{}\n{}", &partial[20..], lines_of(6, 5005)).expect("write");
    drop(file);
    let update = update_log_index(&path).expect("append update");
    assert!(
        update.changed && !update.rebuilt,
        "the appended lines must be indexed without a rebuild: {update:?}"
    );
    let info = read_log_index(&path).expect("info");
    assert_eq!(
        (
            info.events,
            info.full_segments,
            info.tail_events,
            info.last_seq
        ),
        (5005, 1, 5005 - 4096, 5005),
        "{info:?}"
    );

    // The same size with another modification time is not the file that was indexed.
    let later = SystemTime::now() + Duration::from_secs(3600);
    std::fs::OpenOptions::new()
        .write(true)
        .open(&path)
        .expect("open")
        .set_modified(later)
        .expect("set");
    let update = update_log_index(&path).expect("modification time update");
    assert!(
        update.rebuilt && update.reason == "the modification time changed at the same size",
        "{update:?}"
    );

    // A smaller file.
    std::fs::write(&path, lines_of(1, 10)).expect("write");
    let update = update_log_index(&path).expect("smaller update");
    assert!(
        update.rebuilt && update.reason == "the file is smaller than the indexed part",
        "{update:?}"
    );
    assert_eq!(read_log_index(&path).expect("info").events, 10);

    // Another first line in a larger file.
    std::fs::write(
        &path,
        lines_of(1, 40).replacen(r#""boot":"a""#, r#""boot":"b""#, 1),
    )
    .expect("write");
    let update = update_log_index(&path).expect("first line update");
    assert!(
        update.rebuilt && update.reason == "the first line changed",
        "{update:?}"
    );
    assert_eq!(read_log_index(&path).expect("info").events, 40);
}

// contract: log.index.refuses-a-damaged-index-and-a-broken-line
#[test]
fn index_refuses_a_damaged_index_and_a_broken_line() {
    let (config, path, _events) = write_big("index-damage");
    update_log_index(&path).expect("update");
    let name = "logs/host-big.jsonl.idx";
    let index = path.with_file_name("host-big.jsonl.idx");
    let original = std::fs::read(&index).expect("read the index");
    let damaged: Vec<(&str, Damage, String)> = vec![
        (
            "version",
            Box::new(|data| data[STATE_BLOCK_BYTES + 4] = 2),
            format!("{name}: version 2 is not 1"),
        ),
        (
            "state checksum",
            Box::new(|data| data[STATE_BLOCK_BYTES + 100] ^= 0xff),
            format!("{name}: neither state block has a valid checksum"),
        ),
        (
            "shorter than the blocks",
            Box::new(|data| data.truncate(100)),
            format!("{name}: 100 bytes are fewer than the two state blocks of 40960"),
        ),
        (
            "fewer records than the block",
            Box::new(|data| data.truncate(2 * STATE_BLOCK_BYTES + RECORD_BYTES)),
            format!("{name}: 1 records follow the state blocks, and the state block counts 2"),
        ),
    ];
    for (title, change, want) in damaged {
        let mut data = original.clone();
        change(&mut data);
        std::fs::write(&index, &data).expect("write the damaged index");
        let error = update_log_index(&path).expect_err(title);
        assert!(
            error.contains(&want),
            "{title}: error {error:?}, want {want:?}"
        );
    }

    // A record whose checksum does not match is found when a query reads it.
    let mut broken = original.clone();
    broken[2 * STATE_BLOCK_BYTES + 100] ^= 0xff;
    std::fs::write(&index, &broken).expect("write");
    let query = parse_log_query(r#"{"cid":"c500"}"#).expect("query");
    let error = query_logs(&config, &query, None).expect_err("record checksum");
    assert!(
        error.contains(&format!(
            "{name}: segment 0 has a record whose checksum does not match"
        )),
        "{error}"
    );
    std::fs::write(&index, &original).expect("restore");

    // A source that breaks the structure stops the update and the index keeps its earlier state.
    let good = temp_dir("index-keeps").join("logs").join("host-g.jsonl");
    std::fs::write(&good, lines_of(1, 10)).expect("write");
    update_log_index(&good).expect("update");
    let good_index = good.with_file_name("host-g.jsonl.idx");
    let before = digest_of(&good_index);
    let mut file = std::fs::OpenOptions::new()
        .append(true)
        .open(&good)
        .expect("append");
    write!(
        file,
        "{}\nnot json\n{}\n",
        event_line_of(11),
        event_line_of(13)
    )
    .expect("write");
    drop(file);
    let error = update_log_index(&good).expect_err("broken line");
    assert!(
        error.contains("logs/host-g.jsonl:12: not JSON: not json"),
        "{error}"
    );
    assert_eq!(
        digest_of(&good_index),
        before,
        "a failed update changed the index"
    );
    assert_eq!(read_log_index(&good).expect("info").events, 10);

    let open = event_line_of(1);
    let cases: Vec<(&str, String, &str)> = vec![
        ("first line", r#"{"ts_us":1,"mono_ns":1,"seq":1,"level":"info","layer":"host","event":"host.x"}"#.to_string() + "\n", r#"logs/host-f.jsonl: the first line is not log.open: "host.x""#),
        ("schema", r#"{"ts_us":1,"mono_ns":1,"seq":1,"level":"info","layer":"host","event":"log.open","fields":{"schema":1}}"#.to_string() + "\n", "logs/host-f.jsonl: schema 1 is not 2"),
        ("layer", format!("{open}\n{{\"ts_us\":1,\"mono_ns\":1,\"seq\":2,\"level\":\"info\",\"layer\":\"x\",\"event\":\"a\"}}\n"), r#"logs/host-f.jsonl:2: layer "x" is not one of native, host, page, plugin, sidecar, sok"#),
        ("class", format!("{open}\n{{\"ts_us\":1,\"mono_ns\":1,\"seq\":2,\"level\":\"info\",\"layer\":\"host\",\"event\":\"a\",\"class\":\"loud\"}}\n"), r#"logs/host-f.jsonl:2: class "loud" is not one of lifecycle, input, call, io, frame"#),
        ("null surface", format!("{open}\n{{\"ts_us\":1,\"mono_ns\":1,\"seq\":2,\"level\":\"info\",\"layer\":\"host\",\"event\":\"a\",\"surface\":null}}\n"), "logs/host-f.jsonl:2: surface must be a string, found null"),
        ("null cids", format!("{open}\n{{\"ts_us\":1,\"mono_ns\":1,\"seq\":2,\"level\":\"info\",\"layer\":\"host\",\"event\":\"a\",\"cids\":null}}\n"), "logs/host-f.jsonl:2: cids must be an array of strings, found null"),
        ("null class", format!("{open}\n{{\"ts_us\":1,\"mono_ns\":1,\"seq\":2,\"level\":\"info\",\"layer\":\"host\",\"event\":\"a\",\"class\":null}}\n"), "logs/host-f.jsonl:2: class null is not one of lifecycle, input, call, io, frame"),
        ("null fields", format!("{open}\n{{\"ts_us\":1,\"mono_ns\":1,\"seq\":2,\"level\":\"info\",\"layer\":\"host\",\"event\":\"a\",\"fields\":null}}\n"), "logs/host-f.jsonl:2: fields must be an object, found null"),
        ("numeric window", format!("{open}\n{{\"ts_us\":1,\"mono_ns\":1,\"seq\":2,\"level\":\"info\",\"layer\":\"host\",\"event\":\"a\",\"window\":4}}\n"), "logs/host-f.jsonl:2: window must be a string, found 4"),
    ];
    for (title, text, want) in cases {
        let target = temp_dir("index-first").join("logs").join("host-f.jsonl");
        std::fs::write(&target, text).expect("write");
        let error = update_log_index(&target).expect_err(title);
        assert!(
            error.contains(want),
            "{title}: error {error:?}, want {want:?}"
        );
        // An index that was created for a file that failed holds no state block.
        let created = target.with_file_name("host-f.jsonl.idx");
        if created.exists() {
            assert!(
                read_log_index(&target).is_err(),
                "{title}: the failed update left a readable index"
            );
        }
    }
}
// contract: log.index.moves-with-the-generations-of-a-rotation
#[test]
fn index_moves_with_the_generations_of_a_rotation() {
    let dir = temp_dir("index-rotate");
    let path = dir.join("logs").join("host-r.jsonl");
    let generation = |n: u32| dir.join("logs").join(format!("host-r.jsonl.{n}"));
    // The rotation of the writer: the file becomes generation `n` and a new file starts. No generation is removed or renamed.
    let rotate_to = |n: u32| {
        let (path, target) = (path.clone(), generation(n));
        move || -> Result<(), String> {
            std::fs::rename(&path, &target).map_err(|error| error.to_string())?;
            std::fs::write(&path, lines_of(1, 3)).map_err(|error| error.to_string())
        }
    };
    std::fs::write(&path, lines_of(1, 7)).expect("write");
    update_log_index(&path).expect("update");
    // Lines are appended and the index is not brought up to date before the rotation: the rotation does it.
    let mut file = std::fs::OpenOptions::new()
        .append(true)
        .open(&path)
        .expect("append");
    write!(file, "{}", lines_of(8, 12)).expect("write");
    drop(file);
    rotate_log_indexes(&path, 1, rotate_to(1)).expect("rotate");
    let info =
        read_log_index(&generation(1)).expect("the closed generation answers from its index");
    assert_eq!((info.events, info.last_seq), (12, 12), "{info:?}");
    assert!(
        !dir.join("logs").join("host-r.jsonl.idx").exists(),
        "the index of the new file must not exist yet"
    );
    assert!(
        !update_log_index(&generation(1)).expect("update").changed,
        "the closed generation is current without a build"
    );
    // A second rotation closes generation 2 and leaves generation 1 and its index where they are.
    update_log_index(&path).expect("update");
    rotate_log_indexes(&path, 2, rotate_to(2)).expect("rotate again");
    assert_eq!(
        read_log_index(&generation(1)).expect("generation 1").events,
        12
    );
    assert_eq!(
        read_log_index(&generation(2)).expect("generation 2").events,
        3
    );
    // An index that cannot be brought up to date does not stop the rotation of the file: the file and its index file move, and the
    // error says that the index of the closed file is not complete.
    update_log_index(&path).expect("update");
    let mut broken = std::fs::OpenOptions::new()
        .append(true)
        .open(&path)
        .expect("append");
    broken.write_all(b"not json\n").expect("write");
    drop(broken);
    let error =
        rotate_log_indexes(&path, 3, rotate_to(3)).expect_err("a rotation with a broken line");
    assert!(
        error.contains(
            "the index of the closed file is not complete: logs/host-r.jsonl:4: not JSON: not json"
        ),
        "{error}"
    );
    assert_eq!(
        read_log_index(&generation(3))
            .expect("the index of the closed file moved with it")
            .events,
        3
    );
    assert_eq!(
        read_log_index(&generation(2))
            .expect("the index of the earlier generation stayed")
            .events,
        3
    );
    // A rotation that fails leaves the index files where they are.
    std::fs::write(&path, lines_of(1, 3)).expect("write");
    update_log_index(&path).expect("update");
    let error = rotate_log_indexes(&path, 4, || Err("rename refused".to_string()))
        .expect_err("failing rotation");
    assert_eq!(error, "rename refused");
    assert!(
        dir.join("logs").join("host-r.jsonl.idx").exists(),
        "a failed rotation moved the index"
    );
}
