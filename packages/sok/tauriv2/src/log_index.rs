//! The index beside an event file (docs/spec/logging.md#index). It is derived from the file: it says which segments of 4,096 lines can hold
//! an event of a query. The Go implementation (packages/sok/wailsv3/src/log_index.go) writes the same bytes for the same file, and the
//! golden digests of packages/log-contract/fixtures/query check it.

use std::borrow::Cow;
use std::fmt;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::Path;
use std::time::{Instant, UNIX_EPOCH};

use serde::de::{Deserialize, Deserializer, IgnoredAny, MapAccess, SeqAccess, Visitor};

use crate::debug;
use crate::files::file_error;
use crate::platform::{self, Platform};

pub(crate) const SEGMENT_EVENTS: u64 = 4096;
const VERSION: u32 = 1;
pub(crate) const BLOCK_BYTES: usize = 20480;
pub(crate) const RECORD_BYTES: usize = 18760;
const MEMBERS_BYTES: usize = 64;
/// The size of one read of the file while it is indexed.
const CHUNK_BYTES: usize = 8 << 20;
/// The bound of one line: a writer stores at most 1,048,576 bytes of fields (docs/spec/logging.md#bounds).
const LINE_LIMIT: usize = 64 << 20;

/// The five Bloom filters of a record in the order of the specification: bytes and number of hashes.
pub(crate) const BLOOM_SHAPES: [(usize, u32); 5] =
    [(1024, 4), (512, 4), (512, 4), (256, 4), (16384, 5)];
pub(crate) const BLOOM_EVENT: usize = 0;
pub(crate) const BLOOM_SURFACE: usize = 1;
pub(crate) const BLOOM_SESSION: usize = 2;
pub(crate) const BLOOM_RUN: usize = 3;
pub(crate) const BLOOM_CIDS: usize = 4;

/// The offset of each filter inside a record.
fn bloom_offset(kind: usize) -> usize {
    MEMBERS_BYTES
        + BLOOM_SHAPES[..kind]
            .iter()
            .map(|(bytes, _)| bytes)
            .sum::<usize>()
}

pub(crate) const LEVELS: [&str; 5] = ["error", "warn", "info", "debug", "trace"];
pub(crate) const LAYERS: [&str; 6] = ["native", "host", "page", "plugin", "sidecar", "sok"];
pub(crate) const CLASSES: [&str; 5] = ["lifecycle", "input", "call", "io", "frame"];

/// FNV-1a 64 over the bytes.
fn fnv1a(data: &[u8]) -> u64 {
    let mut hash = 0xcbf29ce484222325u64;
    for byte in data {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

/// Sets the bits of the item in a filter.
fn bloom_add(filter: &mut [u8], hashes: u32, item: &str) {
    let hash = fnv1a(item.as_bytes());
    let step = hash.rotate_left(32) | 1;
    let mask = (filter.len() * 8 - 1) as u64;
    for i in 0..hashes as u64 {
        let bit = hash.wrapping_add(i.wrapping_mul(step)) & mask;
        filter[(bit >> 3) as usize] |= 1 << (bit & 7);
    }
}

/// Whether the filter may hold the item.
pub(crate) fn bloom_has(filter: &[u8], hashes: u32, item: &str) -> bool {
    let hash = fnv1a(item.as_bytes());
    let step = hash.rotate_left(32) | 1;
    let mask = (filter.len() * 8 - 1) as u64;
    (0..hashes as u64).all(|i| {
        let bit = hash.wrapping_add(i.wrapping_mul(step)) & mask;
        filter[(bit >> 3) as usize] & (1 << (bit & 7)) != 0
    })
}

fn u32_at(data: &[u8], at: usize) -> u32 {
    u32::from_le_bytes(data[at..at + 4].try_into().expect("four bytes"))
}

fn u64_at(data: &[u8], at: usize) -> u64 {
    u64::from_le_bytes(data[at..at + 8].try_into().expect("eight bytes"))
}

fn put_u32(data: &mut [u8], at: usize, value: u32) {
    data[at..at + 4].copy_from_slice(&value.to_le_bytes());
}

fn put_u64(data: &mut [u8], at: usize, value: u64) {
    data[at..at + 8].copy_from_slice(&value.to_le_bytes());
}

/// The record of one segment.
#[derive(Clone)]
pub(crate) struct Segment {
    pub offset: u64,
    pub length: u64,
    pub first_seq: u64,
    pub last_seq: u64,
    pub events: u32,
    pub min_ts: i64,
    pub max_ts: i64,
    pub levels: u8,
    pub layers: u8,
    pub classes: u8,
    record: Vec<u8>,
}

impl Segment {
    fn new(offset: u64) -> Self {
        Segment {
            offset,
            length: 0,
            first_seq: 0,
            last_seq: 0,
            events: 0,
            min_ts: i64::MAX,
            max_ts: i64::MIN,
            levels: 0,
            layers: 0,
            classes: 0,
            record: vec![0; RECORD_BYTES],
        }
    }

    /// The Bloom filter of the given kind.
    pub fn filter(&self, kind: usize) -> &[u8] {
        let start = bloom_offset(kind);
        &self.record[start..start + BLOOM_SHAPES[kind].0]
    }

    fn filter_mut(&mut self, kind: usize) -> &mut [u8] {
        let start = bloom_offset(kind);
        &mut self.record[start..start + BLOOM_SHAPES[kind].0]
    }

    /// Records one line in the segment: what the scan found and the size of the line with its line feed.
    fn add(&mut self, line: &ScannedLine, size: u64) {
        if self.events == 0 {
            self.first_seq = line.seq as u64;
        }
        self.last_seq = line.seq as u64;
        self.events += 1;
        self.length += size;
        self.min_ts = self.min_ts.min(line.ts_us);
        self.max_ts = self.max_ts.max(line.ts_us);
        self.levels |= 1 << line.level;
        self.layers |= 1 << line.layer;
        if let Some(class) = line.class {
            self.classes |= 1 << class;
        }
        let name = line.event.as_str();
        let hashes = BLOOM_SHAPES[BLOOM_EVENT].1;
        for (i, byte) in name.bytes().enumerate() {
            if byte == b'.' {
                bloom_add(self.filter_mut(BLOOM_EVENT), hashes, &name[..i]);
            }
        }
        bloom_add(self.filter_mut(BLOOM_EVENT), hashes, name);
        if !line.surface.is_empty() {
            bloom_add(
                self.filter_mut(BLOOM_SURFACE),
                BLOOM_SHAPES[BLOOM_SURFACE].1,
                &line.surface,
            );
        }
        if !line.session.is_empty() {
            bloom_add(
                self.filter_mut(BLOOM_SESSION),
                BLOOM_SHAPES[BLOOM_SESSION].1,
                &line.session,
            );
        }
        if !line.run.is_empty() {
            bloom_add(
                self.filter_mut(BLOOM_RUN),
                BLOOM_SHAPES[BLOOM_RUN].1,
                &line.run,
            );
        }
        for cid in &line.cids {
            bloom_add(self.filter_mut(BLOOM_CIDS), BLOOM_SHAPES[BLOOM_CIDS].1, cid);
        }
    }

    /// Writes the members and the checksum into the record.
    fn encode(&mut self) -> &[u8] {
        let r = &mut self.record;
        put_u64(r, 0, self.offset);
        put_u64(r, 8, self.length);
        put_u64(r, 16, self.first_seq);
        put_u64(r, 24, self.last_seq);
        put_u32(r, 32, self.events);
        put_u64(r, 40, self.min_ts as u64);
        put_u64(r, 48, self.max_ts as u64);
        r[56] = self.levels;
        r[57] = self.layers;
        r[58] = self.classes;
        let checksum = fnv1a(&r[..RECORD_BYTES - 8]);
        put_u64(r, RECORD_BYTES - 8, checksum);
        &self.record
    }

    /// Reads a record; `None` when the checksum does not match.
    fn decode(record: &[u8]) -> Option<Segment> {
        if u64_at(record, RECORD_BYTES - 8) != fnv1a(&record[..RECORD_BYTES - 8]) {
            return None;
        }
        Some(Segment {
            offset: u64_at(record, 0),
            length: u64_at(record, 8),
            first_seq: u64_at(record, 16),
            last_seq: u64_at(record, 24),
            events: u32_at(record, 32),
            min_ts: u64_at(record, 40) as i64,
            max_ts: u64_at(record, 48) as i64,
            levels: record[56],
            layers: record[57],
            classes: record[58],
            record: record.to_vec(),
        })
    }
}

/// The content of a state block.
#[derive(Clone, Default)]
pub(crate) struct IndexState {
    generation: u64,
    head_len: u32,
    head_hash: u64,
    indexed_bytes: u64,
    source_size: u64,
    source_mtime_ns: i64,
    first_seq: u64,
    pub last_seq: u64,
    pub events: u64,
    full_segments: u32,
    tail: Option<Segment>,
}

impl Default for Segment {
    fn default() -> Self {
        Segment::new(0)
    }
}

impl IndexState {
    fn encode(&self) -> Vec<u8> {
        let mut b = vec![0u8; BLOCK_BYTES];
        b[..4].copy_from_slice(b"SKIX");
        put_u32(&mut b, 4, VERSION);
        put_u32(&mut b, 8, SEGMENT_EVENTS as u32);
        put_u32(&mut b, 12, self.head_len);
        put_u64(&mut b, 16, self.generation);
        put_u64(&mut b, 24, self.head_hash);
        put_u64(&mut b, 32, self.indexed_bytes);
        put_u64(&mut b, 40, self.source_size);
        put_u64(&mut b, 48, self.source_mtime_ns as u64);
        put_u64(&mut b, 56, self.first_seq);
        put_u64(&mut b, 64, self.last_seq);
        put_u64(&mut b, 72, self.events);
        put_u32(&mut b, 80, self.full_segments);
        if let Some(tail) = &self.tail {
            put_u32(&mut b, 84, 1);
            let mut tail = tail.clone();
            b[88..88 + RECORD_BYTES].copy_from_slice(tail.encode());
        }
        let checksum = fnv1a(&b[..BLOCK_BYTES - 8]);
        put_u64(&mut b, BLOCK_BYTES - 8, checksum);
        b
    }
}

/// What reading a state block found.
enum Block {
    Unused,
    Invalid,
    Valid(Box<IndexState>),
}

/// Reads a state block. A block of zeros is unused. A block with another magic or version is an error; a block whose checksum does not
/// match is not valid.
fn decode_block(name: &str, number: usize, b: &[u8]) -> Result<Block, String> {
    if b.iter().all(|byte| *byte == 0) {
        return Ok(Block::Unused);
    }
    if &b[..4] != b"SKIX" {
        return Err(format!("{name}: block {number} does not start with SKIX"));
    }
    let version = u32_at(b, 4);
    if version != VERSION {
        return Err(format!("{name}: version {version} is not {VERSION}"));
    }
    if u64_at(b, BLOCK_BYTES - 8) != fnv1a(&b[..BLOCK_BYTES - 8]) {
        return Ok(Block::Invalid);
    }
    let lines = u32_at(b, 8);
    if lines as u64 != SEGMENT_EVENTS {
        return Err(format!(
            "{name}: {lines} lines in a segment is not {SEGMENT_EVENTS}"
        ));
    }
    let tail = if u32_at(b, 84) == 1 {
        match Segment::decode(&b[88..88 + RECORD_BYTES]) {
            Some(tail) => Some(tail),
            None => return Ok(Block::Invalid),
        }
    } else {
        None
    };
    Ok(Block::Valid(Box::new(IndexState {
        head_len: u32_at(b, 12),
        generation: u64_at(b, 16),
        head_hash: u64_at(b, 24),
        indexed_bytes: u64_at(b, 32),
        source_size: u64_at(b, 40),
        source_mtime_ns: u64_at(b, 48) as i64,
        first_seq: u64_at(b, 56),
        last_seq: u64_at(b, 64),
        events: u64_at(b, 72),
        full_segments: u32_at(b, 80),
        tail,
    })))
}

/// The content of an index file that was read.
pub(crate) struct IndexFile {
    name: String,
    pub state: IndexState,
    /// False when the file holds no valid state block.
    pub exists: bool,
    data: Vec<u8>,
}

/// Reads the two state blocks of the content of an index file; `name` is the display name of the index.
fn parse_index(name: &str, data: Vec<u8>) -> Result<IndexFile, String> {
    let mut file = IndexFile {
        name: name.to_string(),
        state: IndexState::default(),
        exists: false,
        data,
    };
    if file.data.is_empty() {
        return Ok(file);
    }
    if file.data.len() < 2 * BLOCK_BYTES {
        return Err(format!(
            "{name}: {} bytes are fewer than the two state blocks of {}",
            file.data.len(),
            2 * BLOCK_BYTES
        ));
    }
    let mut any_used = false;
    for number in 0..2 {
        match decode_block(
            name,
            number,
            &file.data[number * BLOCK_BYTES..(number + 1) * BLOCK_BYTES],
        )? {
            Block::Unused => {}
            Block::Invalid => any_used = true,
            Block::Valid(state) => {
                any_used = true;
                if !file.exists || state.generation > file.state.generation {
                    file.state = *state;
                    file.exists = true;
                }
            }
        }
    }
    if !any_used {
        return Ok(file);
    }
    if !file.exists {
        return Err(format!("{name}: neither state block has a valid checksum"));
    }
    let follow = (file.data.len() - 2 * BLOCK_BYTES) / RECORD_BYTES;
    if (follow as u64) < file.state.full_segments as u64 {
        return Err(format!(
            "{name}: {follow} records follow the state blocks, and the state block counts {}",
            file.state.full_segments
        ));
    }
    Ok(file)
}

impl IndexFile {
    /// The record of segment number `n`; the tail is the segment after the full ones.
    pub fn segment_at(&self, n: usize) -> Result<Segment, String> {
        if n == self.state.full_segments as usize {
            if let Some(tail) = &self.state.tail {
                return Ok(tail.clone());
            }
        }
        let start = 2 * BLOCK_BYTES + n * RECORD_BYTES;
        Segment::decode(&self.data[start..start + RECORD_BYTES]).ok_or_else(|| {
            format!(
                "{}: segment {n} has a record whose checksum does not match",
                self.name
            )
        })
    }

    /// The number of segments of the index, the tail included.
    pub fn segments(&self) -> usize {
        self.state.full_segments as usize + usize::from(self.state.tail.is_some())
    }
}

/// What the scan of one line of an event file finds.
pub(crate) struct ScannedLine {
    pub ts_us: i64,
    pub seq: i64,
    pub level: usize,
    pub layer: usize,
    pub class: Option<usize>,
    pub event: String,
    pub surface: String,
    pub session: String,
    pub cids: Vec<String>,
    pub run: String,
}

/// A member of a line whose type the scan checks. `Other` is any value that is not a string and not an integer that fits i64.
enum Loose<'a> {
    Str(Cow<'a, str>),
    Int(i64),
    Other,
}

struct LooseVisitor;

impl<'de> Visitor<'de> for LooseVisitor {
    type Value = Loose<'de>;
    fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
        formatter.write_str("a JSON value")
    }
    fn visit_borrowed_str<E>(self, value: &'de str) -> Result<Loose<'de>, E> {
        Ok(Loose::Str(Cow::Borrowed(value)))
    }
    fn visit_str<E>(self, value: &str) -> Result<Loose<'de>, E> {
        Ok(Loose::Str(Cow::Owned(value.to_string())))
    }
    fn visit_string<E>(self, value: String) -> Result<Loose<'de>, E> {
        Ok(Loose::Str(Cow::Owned(value)))
    }
    fn visit_i64<E>(self, value: i64) -> Result<Loose<'de>, E> {
        Ok(Loose::Int(value))
    }
    fn visit_u64<E>(self, value: u64) -> Result<Loose<'de>, E> {
        // default: a number above the range of i64 is not an integer for the scan, so the reader of the event structure judges the line.
        Ok(i64::try_from(value).map(Loose::Int).unwrap_or(Loose::Other))
    }
    fn visit_f64<E>(self, _: f64) -> Result<Loose<'de>, E> {
        Ok(Loose::Other)
    }
    fn visit_bool<E>(self, _: bool) -> Result<Loose<'de>, E> {
        Ok(Loose::Other)
    }
    fn visit_unit<E>(self) -> Result<Loose<'de>, E> {
        Ok(Loose::Other)
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Loose<'de>, A::Error> {
        while seq.next_element::<IgnoredAny>()?.is_some() {}
        Ok(Loose::Other)
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Loose<'de>, A::Error> {
        while map.next_entry::<IgnoredAny, IgnoredAny>()?.is_some() {}
        Ok(Loose::Other)
    }
}

impl<'de> Deserialize<'de> for Loose<'de> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_any(LooseVisitor)
    }
}

/// The member `cids`: a list of strings, or what it is when it is not one.
enum Cids {
    List(Vec<String>),
    Invalid,
}

struct CidsVisitor;

impl<'de> Visitor<'de> for CidsVisitor {
    type Value = Cids;
    fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
        formatter.write_str("a JSON value")
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Cids, A::Error> {
        let mut list = vec![];
        let mut valid = true;
        while let Some(item) = seq.next_element::<Loose>()? {
            match item {
                Loose::Str(text) => list.push(text.into_owned()),
                _ => valid = false,
            }
        }
        Ok(if valid {
            Cids::List(list)
        } else {
            Cids::Invalid
        })
    }
    fn visit_borrowed_str<E>(self, _: &'de str) -> Result<Cids, E> {
        Ok(Cids::Invalid)
    }
    fn visit_str<E>(self, _: &str) -> Result<Cids, E> {
        Ok(Cids::Invalid)
    }
    fn visit_i64<E>(self, _: i64) -> Result<Cids, E> {
        Ok(Cids::Invalid)
    }
    fn visit_u64<E>(self, _: u64) -> Result<Cids, E> {
        Ok(Cids::Invalid)
    }
    fn visit_f64<E>(self, _: f64) -> Result<Cids, E> {
        Ok(Cids::Invalid)
    }
    fn visit_bool<E>(self, _: bool) -> Result<Cids, E> {
        Ok(Cids::Invalid)
    }
    fn visit_unit<E>(self) -> Result<Cids, E> {
        Ok(Cids::Invalid)
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Cids, A::Error> {
        while map.next_entry::<IgnoredAny, IgnoredAny>()?.is_some() {}
        Ok(Cids::Invalid)
    }
}

impl<'de> Deserialize<'de> for Cids {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_any(CidsVisitor)
    }
}

/// The member `fields`: the identifiers that the scan reads, or the fact that it is not an object.
enum FieldsMember {
    Object {
        surface: String,
        session: String,
        run: String,
    },
    Invalid,
}

struct FieldsVisitor;

impl<'de> Visitor<'de> for FieldsVisitor {
    type Value = FieldsMember;
    fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
        formatter.write_str("a JSON value")
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<FieldsMember, A::Error> {
        let (mut surface, mut session, mut run) = (String::new(), String::new(), String::new());
        while let Some(key) = map.next_key::<Key>()? {
            let slot = match key {
                Key::Surface => Some(&mut surface),
                Key::Session => Some(&mut session),
                Key::Run => Some(&mut run),
                _ => None,
            };
            match slot {
                Some(slot) => {
                    // A value that is not a string is not an identifier: the member keeps what it had before.
                    if let Loose::Str(text) = map.next_value::<Loose>()? {
                        *slot = text.into_owned();
                    }
                }
                None => {
                    map.next_value::<IgnoredAny>()?;
                }
            }
        }
        Ok(FieldsMember::Object {
            surface,
            session,
            run,
        })
    }
    fn visit_borrowed_str<E>(self, _: &'de str) -> Result<FieldsMember, E> {
        Ok(FieldsMember::Invalid)
    }
    fn visit_str<E>(self, _: &str) -> Result<FieldsMember, E> {
        Ok(FieldsMember::Invalid)
    }
    fn visit_i64<E>(self, _: i64) -> Result<FieldsMember, E> {
        Ok(FieldsMember::Invalid)
    }
    fn visit_u64<E>(self, _: u64) -> Result<FieldsMember, E> {
        Ok(FieldsMember::Invalid)
    }
    fn visit_f64<E>(self, _: f64) -> Result<FieldsMember, E> {
        Ok(FieldsMember::Invalid)
    }
    fn visit_bool<E>(self, _: bool) -> Result<FieldsMember, E> {
        Ok(FieldsMember::Invalid)
    }
    fn visit_unit<E>(self) -> Result<FieldsMember, E> {
        Ok(FieldsMember::Invalid)
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<FieldsMember, A::Error> {
        while seq.next_element::<IgnoredAny>()?.is_some() {}
        Ok(FieldsMember::Invalid)
    }
}

impl<'de> Deserialize<'de> for FieldsMember {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_any(FieldsVisitor)
    }
}

/// The names of the members that the scan reads.
enum Key {
    TsUs,
    Seq,
    Level,
    Layer,
    Event,
    Class,
    Window,
    Surface,
    Session,
    Cids,
    Fields,
    Run,
    Other,
}

struct KeyVisitor;

impl<'de> Visitor<'de> for KeyVisitor {
    type Value = Key;
    fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
        formatter.write_str("a member name")
    }
    fn visit_str<E>(self, value: &str) -> Result<Key, E> {
        Ok(match value {
            "ts_us" => Key::TsUs,
            "seq" => Key::Seq,
            "level" => Key::Level,
            "layer" => Key::Layer,
            "event" => Key::Event,
            "class" => Key::Class,
            "window" => Key::Window,
            "surface" => Key::Surface,
            "session" => Key::Session,
            "cids" => Key::Cids,
            "fields" => Key::Fields,
            "run" => Key::Run,
            _ => Key::Other,
        })
    }
}

impl<'de> Deserialize<'de> for Key {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_identifier(KeyVisitor)
    }
}

/// The members of a line that the scan reads, each the last one of its name.
#[derive(Default)]
struct LineMembers<'a> {
    ts_us: Option<Loose<'a>>,
    seq: Option<Loose<'a>>,
    level: Option<Loose<'a>>,
    layer: Option<Loose<'a>>,
    event: Option<Loose<'a>>,
    class: Option<Loose<'a>>,
    window: Option<Loose<'a>>,
    surface: Option<Loose<'a>>,
    session: Option<Loose<'a>>,
    cids: Option<Cids>,
    fields: Option<FieldsMember>,
}

impl<'de> Deserialize<'de> for LineMembers<'de> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct LineVisitor;
        impl<'de> Visitor<'de> for LineVisitor {
            type Value = LineMembers<'de>;
            fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
                formatter.write_str("an object")
            }
            fn visit_map<A: MapAccess<'de>>(
                self,
                mut map: A,
            ) -> Result<LineMembers<'de>, A::Error> {
                let mut line = LineMembers::default();
                while let Some(key) = map.next_key::<Key>()? {
                    match key {
                        Key::TsUs => line.ts_us = Some(map.next_value()?),
                        Key::Seq => line.seq = Some(map.next_value()?),
                        Key::Level => line.level = Some(map.next_value()?),
                        Key::Layer => line.layer = Some(map.next_value()?),
                        Key::Event => line.event = Some(map.next_value()?),
                        Key::Class => line.class = Some(map.next_value()?),
                        Key::Window => line.window = Some(map.next_value()?),
                        Key::Surface => line.surface = Some(map.next_value()?),
                        Key::Session => line.session = Some(map.next_value()?),
                        Key::Cids => line.cids = Some(map.next_value()?),
                        Key::Fields => line.fields = Some(map.next_value()?),
                        Key::Run | Key::Other => {
                            map.next_value::<IgnoredAny>()?;
                        }
                    }
                }
                Ok(line)
            }
        }
        deserializer.deserialize_map(LineVisitor)
    }
}

/// The string of a member that may be missing: it is an error when the member is there and is not a string.
fn optional_string(name: &str, value: Option<Loose>) -> Result<String, String> {
    match value {
        None => Ok(String::new()),
        Some(Loose::Str(text)) => Ok(text.into_owned()),
        Some(_) => Err(format!("{name} is not a string")),
    }
}

fn scan_fast(raw: &[u8]) -> Result<ScannedLine, String> {
    if std::str::from_utf8(raw).is_err() {
        return Err("the line is not valid UTF-8".into());
    }
    let members: LineMembers = serde_json::from_slice(raw).map_err(|error| error.to_string())?;
    let integer = |name: &str, value: Option<Loose>| match value {
        Some(Loose::Int(n)) => Ok(n),
        _ => Err(format!("{name} is not an integer")),
    };
    let ts_us = integer("ts_us", members.ts_us)?;
    let seq = integer("seq", members.seq)?;
    let Some(Loose::Str(event)) = members.event else {
        return Err("event is missing".into());
    };
    let choice = |name: &str, value: Option<Loose>, allowed: &[&str]| match value {
        Some(Loose::Str(text)) => allowed
            .iter()
            .position(|item| *item == text)
            .ok_or_else(|| format!("{name} is not defined")),
        _ => Err(format!("{name} is not defined")),
    };
    let level = choice("level", members.level, &LEVELS)?;
    let layer = choice("layer", members.layer, &LAYERS)?;
    let class = match members.class {
        None => None,
        Some(Loose::Str(text)) => Some(
            CLASSES
                .iter()
                .position(|item| *item == text)
                .ok_or_else(|| "class is not defined".to_string())?,
        ),
        Some(_) => return Err("class is not a string".into()),
    };
    optional_string("window", members.window)?;
    let mut surface = optional_string("surface", members.surface)?;
    let mut session = optional_string("session", members.session)?;
    let cids = match members.cids {
        None => vec![],
        Some(Cids::List(list)) => list,
        Some(Cids::Invalid) => return Err("cids is not an array of strings".into()),
    };
    let mut run = String::new();
    match members.fields {
        None => {}
        Some(FieldsMember::Object {
            surface: from_fields,
            session: from_session,
            run: from_run,
        }) => {
            if surface.is_empty() {
                surface = from_fields;
            }
            if session.is_empty() {
                session = from_session;
            }
            run = from_run;
        }
        Some(FieldsMember::Invalid) => return Err("fields is not an object".into()),
    }
    Ok(ScannedLine {
        ts_us,
        seq,
        level,
        layer,
        class,
        event: event.into_owned(),
        surface,
        session,
        cids,
        run,
    })
}

/// Reads one line. A line that the typed read does not accept is read again by the reader of the event structure, whose error names the
/// file and the line; a line that this reader accepts after all is reported with the reason of the typed read.
pub(crate) fn scan_line(file: &str, number: usize, raw: &[u8]) -> Result<ScannedLine, String> {
    match scan_fast(raw) {
        Ok(line) => Ok(line),
        Err(reason) => {
            debug::row_of(file, number, &String::from_utf8_lossy(raw))?;
            Err(format!(
                "{file}:{number}: the line cannot be indexed: {reason}"
            ))
        }
    }
}

/// What one update of an index did.
#[derive(Debug, Clone, Default)]
pub struct IndexUpdate {
    /// The display name of the event file, `logs/<name>`.
    pub file: String,
    /// False when the index was current.
    pub changed: bool,
    /// True when the whole file was indexed; `reason` says why.
    pub rebuilt: bool,
    pub reason: String,
    /// The lines indexed by this update and the bytes of the file that were read.
    pub lines: i64,
    pub bytes: i64,
    pub micros: i64,
}

/// The name that errors give an event file: `logs/<name>`.
pub(crate) fn display_name(path: &Path) -> String {
    format!(
        "logs/{}",
        path.file_name()
            .map(|name| name.to_string_lossy().to_string())
            // default: a path without a file name has an empty display name.
            .unwrap_or_default()
    )
}

fn index_path(path: &Path) -> std::path::PathBuf {
    let mut name = path.as_os_str().to_os_string();
    name.push(".idx");
    name.into()
}

/// An event file with its index brought up to date. The source stays open, so the segments are read from the file that was indexed even
/// when a rotation renames it afterwards.
pub(crate) struct OpenedLog {
    pub source: File,
    pub index: IndexFile,
    pub update: IndexUpdate,
}

fn read_at(file: &File, buffer: &mut [u8], offset: u64) -> std::io::Result<()> {
    let mut file = file;
    file.seek(SeekFrom::Start(offset))?;
    file.read_exact(buffer)
}

fn write_at(file: &File, data: &[u8], offset: u64) -> std::io::Result<()> {
    let mut file = file;
    file.seek(SeekFrom::Start(offset))?;
    file.write_all(data)
}

pub(crate) fn read_range(file: &File, offset: u64, length: usize) -> std::io::Result<Vec<u8>> {
    let mut data = vec![0u8; length];
    read_at(file, &mut data, offset)?;
    Ok(data)
}

fn read_all(file: &File) -> std::io::Result<Vec<u8>> {
    let size = file.metadata()?.len() as usize;
    read_range(file, 0, size)
}

/// Opens the event file and its index, locks the index, and checks that both are still the files at their paths, so a rotation cannot mix
/// two files. The caller releases the lock by closing the index with `close_index`.
fn locked_index(path: &Path) -> Result<(File, File, Box<dyn Platform>), String> {
    let system = platform::current()?;
    let idx_path = index_path(path);
    for _ in 0..8 {
        let source = File::open(path).map_err(|error| file_error(path.display(), &error))?;
        let idx = system.open_index(&idx_path)?;
        system.lock_file(&idx)?;
        let same_source = system.same_file(&source, path);
        let same_index = system.same_file(&idx, &idx_path);
        match (same_source, same_index) {
            (Ok(true), Ok(true)) => return Ok((source, idx, system)),
            (Ok(_), Ok(_)) => drop(idx),
            (source_result, index_result) => {
                drop(idx);
                return Err([source_result.err(), index_result.err()]
                    .into_iter()
                    .flatten()
                    .collect::<Vec<_>>()
                    .join("; "));
            }
        }
    }
    Err(format!(
        "{}: the file was renamed 8 times while it was opened",
        path.display()
    ))
}

/// Closes the index, which releases its lock, and reports the result of the close.
fn close_index(system: &dyn Platform, idx: File, path: &Path) -> Result<(), String> {
    system.close_file(idx, &index_path(path))
}

/// Brings the index of the event file at `path` up to date, building it when it does not exist, and says what it did.
pub fn update_log_index(path: &Path) -> Result<IndexUpdate, String> {
    open_log(path).map(|opened| opened.update)
}

/// Brings the index of the event file up to date and returns the file with the index content.
pub(crate) fn open_log(path: &Path) -> Result<OpenedLog, String> {
    let (source, idx, system) = locked_index(path)?;
    let opened = refresh_locked(path, source, &idx);
    let closed = close_index(system.as_ref(), idx, path);
    let opened = opened?;
    closed?;
    Ok(opened)
}

/// Brings the index up to date while the caller holds its lock.
fn refresh_locked(path: &Path, source: File, idx: &File) -> Result<OpenedLog, String> {
    let started = Instant::now();
    let name = display_name(path);
    let idx_display = format!("{name}.idx");
    let info = source
        .metadata()
        .map_err(|error| file_error(path.display(), &error))?;
    let data = read_all(idx).map_err(|error| file_error(&idx_display, &error))?;
    let current = parse_index(&idx_display, data)?;
    let size = info.len();
    let mtime = info
        .modified()
        .map_err(|error| file_error(path.display(), &error))?
        .duration_since(UNIX_EPOCH)
        .map_err(|error| {
            format!(
                "{}: the modification time is before the epoch: {error}",
                path.display()
            )
        })?
        .as_nanos() as i64;
    let mut update = IndexUpdate {
        file: name.clone(),
        ..IndexUpdate::default()
    };
    let mut state = current.state.clone();
    let mut rebuild = String::new();
    if !current.exists {
        rebuild = "the index did not exist".into();
    } else if state.source_size == size && state.source_mtime_ns == mtime {
        return Ok(OpenedLog {
            source,
            index: current,
            update,
        });
    } else if size < state.source_size {
        rebuild = "the file is smaller than the indexed part".into();
    } else if size == state.source_size {
        rebuild = "the modification time changed at the same size".into();
    } else if state.head_len > 0 {
        let matches = read_range(&source, 0, state.head_len as usize)
            .map(|head| fnv1a(&head) == state.head_hash)
            // default: a head that cannot be read is not the head that was indexed, so the index is built again.
            .unwrap_or(false);
        if !matches {
            rebuild = "the first line changed".into();
        }
    }
    let rebuilt = !rebuild.is_empty();
    if rebuilt {
        // An index that is built again is empty until the new state is written, so a failure leaves no state that describes the old file.
        idx.set_len(0)
            .map_err(|error| file_error(&idx_display, &error))?;
        write_at(idx, &vec![0u8; 2 * BLOCK_BYTES], 0)
            .map_err(|error| file_error(&idx_display, &error))?;
        state = IndexState::default();
    }
    let (read, lines) = index_from(&name, &state, &source, idx, size, mtime, rebuilt)?;
    update.changed = true;
    update.rebuilt = rebuilt;
    update.reason = rebuild;
    update.bytes = read;
    update.lines = lines;
    update.micros = started.elapsed().as_micros() as i64;
    let data = read_all(idx).map_err(|error| file_error(&idx_display, &error))?;
    let index = parse_index(&idx_display, data)?;
    Ok(OpenedLog {
        source,
        index,
        update,
    })
}

/// Indexes the lines of the source after the indexed part (from the start when `rebuild` is set), writes the new full records and then the
/// new state block. It returns the bytes it read and the lines it indexed.
fn index_from(
    name: &str,
    state: &IndexState,
    source: &File,
    idx: &File,
    size: u64,
    mtime: i64,
    rebuild: bool,
) -> Result<(i64, i64), String> {
    let idx_display = format!("{name}.idx");
    let (mut start, mut events, state) = if rebuild {
        (0, 0, IndexState::default())
    } else {
        (
            state.indexed_bytes,
            state.full_segments as u64 * SEGMENT_EVENTS,
            state.clone(),
        )
    };
    if !rebuild {
        if let Some(tail) = &state.tail {
            start = tail.offset;
        }
    }
    let first_event = events;
    let mut next = state.clone();
    next.tail = None;
    let mut acc = Segment::new(start);
    let mut carry: Vec<u8> = vec![];
    let mut position = start;
    let mut buffer = vec![0u8; CHUNK_BYTES];
    let mut line_start = start;
    let mut number = events as usize + 1;
    let mut read = 0i64;
    while position < size {
        let want = (buffer.len() as u64).min(size - position) as usize;
        read_at(source, &mut buffer[..want], position).map_err(|error| file_error(name, &error))?;
        read += want as i64;
        position += want as u64;
        let mut chunk = &buffer[..want];
        while let Some(end) = memchr::memchr(b'\n', chunk) {
            let owned;
            let line_bytes: &[u8] = if carry.is_empty() {
                &chunk[..end]
            } else {
                carry.extend_from_slice(&chunk[..end]);
                owned = std::mem::take(&mut carry);
                &owned
            };
            chunk = &chunk[end + 1..];
            let line_size = line_bytes.len() as u64 + 1;
            let line = scan_line(name, number, line_bytes)?;
            if events == 0 {
                if line.event != "log.open" {
                    return Err(format!(
                        "{name}: the first line is not log.open: {}",
                        debug::js_string(&line.event)
                    ));
                }
                let schema = debug::schema_of(name, &String::from_utf8_lossy(line_bytes))?;
                if schema != 2 {
                    return Err(format!("{name}: schema {schema} is not 2"));
                }
                next.head_len = line_size as u32;
                let mut head = line_bytes.to_vec();
                head.push(b'\n');
                next.head_hash = fnv1a(&head);
                next.first_seq = line.seq as u64;
            }
            acc.add(&line, line_size);
            next.last_seq = line.seq as u64;
            events += 1;
            number += 1;
            line_start += line_size;
            if acc.events as u64 == SEGMENT_EVENTS {
                let offset =
                    (2 * BLOCK_BYTES) as u64 + next.full_segments as u64 * RECORD_BYTES as u64;
                write_at(idx, acc.encode(), offset)
                    .map_err(|error| file_error(&idx_display, &error))?;
                next.full_segments += 1;
                acc = Segment::new(line_start);
            }
        }
        if !chunk.is_empty() {
            carry.extend_from_slice(chunk);
            if carry.len() > LINE_LIMIT {
                return Err(format!(
                    "{name}:{number}: the line is over {LINE_LIMIT} bytes"
                ));
            }
        }
    }
    if acc.events > 0 {
        next.tail = Some(acc);
    }
    next.events = events;
    next.indexed_bytes = line_start;
    next.source_size = size;
    next.source_mtime_ns = mtime;
    next.generation = state.generation + 1;
    write_at(
        idx,
        &next.encode(),
        (next.generation % 2) * BLOCK_BYTES as u64,
    )
    .map_err(|error| file_error(&idx_display, &error))?;
    Ok((read, (events - first_event) as i64))
}

/// What the state block of an index says.
#[derive(Debug)]
pub struct LogIndexInfo {
    pub events: i64,
    pub indexed_bytes: i64,
    pub source_size: i64,
    pub full_segments: i64,
    pub tail_events: i64,
    pub first_seq: i64,
    pub last_seq: i64,
}

/// Reads the state of the index of the event file at `path` without updating it. It is an error when the index has no valid state block.
pub fn read_log_index(path: &Path) -> Result<LogIndexInfo, String> {
    let idx_path = index_path(path);
    let data = std::fs::read(&idx_path).map_err(|error| file_error(idx_path.display(), &error))?;
    let name = format!("{}.idx", display_name(path));
    let index = parse_index(&name, data)?;
    if !index.exists {
        return Err(format!("{name}: the index has no state block"));
    }
    Ok(LogIndexInfo {
        events: index.state.events as i64,
        indexed_bytes: index.state.indexed_bytes as i64,
        source_size: index.state.source_size as i64,
        full_segments: index.state.full_segments as i64,
        tail_events: index
            .state
            .tail
            .as_ref()
            .map(|tail| tail.events as i64)
            // default: an index without a partial segment has no events in a tail.
            .unwrap_or(0),
        first_seq: index.state.first_seq as i64,
        last_seq: index.state.last_seq as i64,
    })
}

/// Runs `rotate`, which renames the generations of the event file at `path` (the file becomes generation 1, the generations move up and
/// the one beyond `generations` is removed), and moves the index files with them. It first brings the index of the file up to date while it
/// holds the lock of that index, so the index of the closed generation is complete. The rotation of the event file does not wait for the
/// index: when the index cannot be locked or brought up to date, `rotate` still runs and the index files still move, and the error says that
/// the index of the closed file is not complete. A `rotate` that fails leaves the index files where they are.
pub fn rotate_log_indexes(
    path: &Path,
    generations: u32,
    rotate: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    let (source, idx, system) = match locked_index(path) {
        Ok(locked) => locked,
        Err(error) => {
            rotate()?;
            return Err(format!("the index files did not move: {error}"));
        }
    };
    // The lock is held through the renames: the other updaters wait for it and then find the files at their new paths.
    let refreshed = refresh_locked(path, source, &idx).map(drop);
    let result = (|| {
        rotate()?;
        let generation = |n: u32| -> std::path::PathBuf {
            let mut name = path.as_os_str().to_os_string();
            name.push(format!(".{n}.idx"));
            name.into()
        };
        let tolerate = |result: std::io::Result<()>, path: &Path| match result {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
                Err(file_error(path.display(), &error))
            }
            _ => Ok(()),
        };
        tolerate(
            std::fs::remove_file(generation(generations)),
            &generation(generations),
        )?;
        for n in (1..generations).rev() {
            tolerate(
                std::fs::rename(generation(n), generation(n + 1)),
                &generation(n),
            )?;
        }
        tolerate(
            std::fs::rename(index_path(path), generation(1)),
            &index_path(path),
        )
    })();
    let closed = close_index(system.as_ref(), idx, path);
    result?;
    closed?;
    refreshed.map_err(|error| format!("the index of the closed file is not complete: {error}"))
}
