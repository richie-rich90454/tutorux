use std::collections::{BTreeMap, HashSet};

use crate::core::crypto::ArchiveDataKey;
use crate::core::error::{err, CoreError, Result};
use crate::core::format::{
    decode_record_frame, decode_stored_payload, encode_record_frame, ARCHIVE_HEADER_SIZE,
    RecordType, ZERO_UUID,
};
use crate::core::source::ByteSource;

pub const MAX_INDEX_DEPTH: usize = 32;
pub const MAX_INDEX_KEY_BYTES: usize = 192;
const PAGE_CAPACITY: usize = 2048;
const PAGE_FANOUT: usize = 256;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IndexPage {
    pub leaf: bool,
    pub entries: Vec<(String, u64)>,
    pub separators: Vec<String>,
    pub children: Vec<u64>,
}

impl IndexPage {
    fn empty_leaf() -> Self {
        Self {
            leaf: true,
            entries: Vec::new(),
            separators: Vec::new(),
            children: Vec::new(),
        }
    }
}

fn read_u16(bytes: &[u8], offset: usize) -> Result<u16> {
    bytes
        .get(offset..offset + 2)
        .map(|slice| u16::from_le_bytes([slice[0], slice[1]]))
        .ok_or_else(|| CoreError::new("archive_truncated", "Index field is truncated."))
}

fn read_u64(bytes: &[u8], offset: usize) -> Result<u64> {
    bytes
        .get(offset..offset + 8)
        .map(|slice| {
            u64::from_le_bytes([
                slice[0], slice[1], slice[2], slice[3], slice[4], slice[5], slice[6], slice[7],
            ])
        })
        .ok_or_else(|| CoreError::new("archive_truncated", "Index field is truncated."))
}

pub fn decode_index_page(payload: &[u8]) -> Result<IndexPage> {
    if payload.len() < 10 || &payload[..4] != b"TXPG" {
        return err(
            "index_page_invalid",
            "Index page magic or length is invalid.",
        );
    }
    let version = read_u16(payload, 4)?;
    let kind = payload[6];
    let reserved = payload[7];
    let count = read_u16(payload, 8)? as usize;
    if version != 1 || kind > 1 || reserved != 0 {
        return err("index_page_invalid", "Index page fields are invalid.");
    }
    let mut cursor = 10usize;
    let read_key = |cursor: &mut usize| -> Result<String> {
        if *cursor + 2 > payload.len() {
            return err("archive_truncated", "Index key length is truncated.");
        }
        let key_length = read_u16(payload, *cursor)? as usize;
        *cursor += 2;
        if key_length == 0
            || key_length > MAX_INDEX_KEY_BYTES
            || *cursor + key_length > payload.len()
        {
            return err("index_page_invalid", "Index key is invalid.");
        }
        let key = std::str::from_utf8(&payload[*cursor..*cursor + key_length])
            .map_err(|_| CoreError::new("index_page_invalid", "Index key is not valid UTF-8."))?
            .to_owned();
        *cursor += key_length;
        Ok(key)
    };
    let read_offset = |cursor: &mut usize| -> Result<u64> {
        let offset = read_u64(payload, *cursor)?;
        *cursor += 8;
        if offset < ARCHIVE_HEADER_SIZE {
            return err("index_page_invalid", "Index page offset is invalid.");
        }
        Ok(offset)
    };

    let mut page = IndexPage {
        leaf: kind == 0,
        entries: Vec::new(),
        separators: Vec::new(),
        children: Vec::new(),
    };
    if page.leaf {
        for _ in 0..count {
            let key = read_key(&mut cursor)?;
            let value_offset = read_offset(&mut cursor)?;
            if page
                .entries
                .last()
                .map(|(previous, _)| previous.as_str() >= key.as_str())
                .unwrap_or(false)
            {
                return err(
                    "index_page_order",
                    "Leaf keys are not strictly ordered.",
                );
            }
            page.entries.push((key, value_offset));
        }
    } else {
        page.children.push(read_offset(&mut cursor)?);
        for _ in 0..count {
            let separator = read_key(&mut cursor)?;
            let child = read_offset(&mut cursor)?;
            if page
                .separators
                .last()
                .map(|previous| previous.as_str() >= separator.as_str())
                .unwrap_or(false)
            {
                return err(
                    "index_page_order",
                    "Internal separators are not strictly ordered.",
                );
            }
            page.separators.push(separator);
            page.children.push(child);
        }
    }
    if cursor != payload.len() {
        return err(
            "index_page_trailing_data",
            "Index page has trailing bytes.",
        );
    }
    Ok(page)
}

pub fn encode_index_page(page: &IndexPage) -> Result<Vec<u8>> {
    if page.leaf && page.entries.len() > 0xffff {
        return err("index_page_full", "Index page has too many entries.");
    }
    let keys: Vec<&str> = if page.leaf {
        page.entries.iter().map(|(key, _)| key.as_str()).collect()
    } else {
        page.separators.iter().map(String::as_str).collect()
    };
    for key in &keys {
        if key.is_empty() || key.len() > MAX_INDEX_KEY_BYTES {
            return err(
                "index_key_invalid",
                "Index key exceeds the v1 key limit.",
            );
        }
    }
    if !page.leaf
        && (page.children.len() != page.separators.len() + 1 || page.children.is_empty())
    {
        return err(
            "index_page_invalid",
            "Internal index page has invalid children.",
        );
    }
    let mut size = 10usize;
    if page.leaf {
        for (key, _) in &page.entries {
            size += 2 + key.len() + 8;
        }
    } else {
        size += 8;
        for key in &page.separators {
            size += 2 + key.len() + 8;
        }
    }
    let mut payload = vec![0u8; size];
    payload[..4].copy_from_slice(b"TXPG");
    payload[4..6].copy_from_slice(&1u16.to_le_bytes());
    payload[6] = if page.leaf { 0 } else { 1 };
    payload[8..10].copy_from_slice(
        &(if page.leaf {
            page.entries.len() as u16
        } else {
            page.separators.len() as u16
        })
        .to_le_bytes(),
    );
    let mut cursor = 10usize;
    if page.leaf {
        for (key, value_offset) in &page.entries {
            write_index_key(&mut payload, &mut cursor, key);
            write_index_offset(&mut payload, &mut cursor, *value_offset);
        }
    } else {
        write_index_offset(&mut payload, &mut cursor, page.children[0]);
        for (index, separator) in page.separators.iter().enumerate() {
            write_index_key(&mut payload, &mut cursor, separator);
            write_index_offset(&mut payload, &mut cursor, page.children[index + 1]);
        }
    }
    Ok(payload)
}

fn write_index_key(payload: &mut [u8], cursor: &mut usize, key: &str) {
    payload[*cursor..*cursor + 2].copy_from_slice(&(key.len() as u16).to_le_bytes());
    *cursor += 2;
    payload[*cursor..*cursor + key.len()].copy_from_slice(key.as_bytes());
    *cursor += key.len();
}

fn write_index_offset(payload: &mut [u8], cursor: &mut usize, offset: u64) {
    payload[*cursor..*cursor + 8].copy_from_slice(&offset.to_le_bytes());
    *cursor += 8;
}

pub struct BuiltIndexTree {
    pub root_offset: u64,
    pub root_payload: Vec<u8>,
    pub end_offset: u64,
    pub frames: Vec<Vec<u8>>,
}

struct LevelPage {
    offset: u64,
    first_key: Option<String>,
    payload: Vec<u8>,
}

pub fn build_index_tree(
    entries: &[(String, u64)],
    initial_offset: u64,
    authenticate: Option<&dyn Fn(&[u8]) -> Vec<u8>>,
) -> Result<BuiltIndexTree> {
    let mut frames: Vec<Vec<u8>> = Vec::new();
    let mut offset = initial_offset;

    let append_page = |page: &IndexPage,
                       offset: &mut u64,
                       frames: &mut Vec<Vec<u8>>|
     -> Result<LevelPage> {
        let page_payload = encode_index_page(page)?;
        let payload = match authenticate {
            Some(authenticate) => {
                let mut authenticated = page_payload.clone();
                authenticated.extend_from_slice(&authenticate(&page_payload));
                authenticated
            }
            None => page_payload.clone(),
        };
        let frame = encode_record_frame(
            RecordType::INDEX_PAGE,
            ZERO_UUID,
            1,
            0,
            &payload,
            0,
            0,
        )?;
        let page_offset = *offset;
        *offset += frame.len() as u64;
        frames.push(frame);
        Ok(LevelPage {
            offset: page_offset,
            first_key: if page.leaf {
                page.entries.first().map(|(key, _)| key.clone())
            } else {
                None
            },
            payload,
        })
    };

    let mut first_level: Vec<LevelPage> = Vec::new();
    if entries.is_empty() {
        first_level.push(append_page(
            &IndexPage::empty_leaf(),
            &mut offset,
            &mut frames,
        )?);
    } else {
        for chunk in entries.chunks(PAGE_CAPACITY) {
            first_level.push(append_page(
                &IndexPage {
                    leaf: true,
                    entries: chunk.to_vec(),
                    separators: Vec::new(),
                    children: Vec::new(),
                },
                &mut offset,
                &mut frames,
            )?);
        }
    }

    let mut level = first_level;
    while level.len() > PAGE_FANOUT {
        let group_count = level.len().div_ceil(PAGE_FANOUT);
        let base_size = level.len() / group_count;
        let remainder = level.len() % group_count;
        let mut parent_level = Vec::new();
        let mut cursor = 0usize;
        for group in 0..group_count {
            let count = base_size + usize::from(group < remainder);
            let children = &level[cursor..cursor + count];
            cursor += count;
            let page = IndexPage {
                leaf: false,
                entries: Vec::new(),
                separators: children[1..]
                    .iter()
                    .map(|child| child.first_key.clone().expect("child has a first key"))
                    .collect(),
                children: children.iter().map(|child| child.offset).collect(),
            };
            let mut page = append_page(&page, &mut offset, &mut frames)?;
            page.first_key = children.first().and_then(|child| child.first_key.clone());
            parent_level.push(page);
        }
        level = parent_level;
    }

    if level.len() == 1 {
        let root = level.pop().expect("one root page");
        return Ok(BuiltIndexTree {
            root_offset: root.offset,
            root_payload: root.payload,
            end_offset: offset,
            frames,
        });
    }

    let root = append_page(
        &IndexPage {
            leaf: false,
            entries: Vec::new(),
            separators: level[1..]
                .iter()
                .map(|child| child.first_key.clone().expect("child has a first key"))
                .collect(),
            children: level.iter().map(|child| child.offset).collect(),
        },
        &mut offset,
        &mut frames,
    )?;
    Ok(BuiltIndexTree {
        root_offset: root.offset,
        root_payload: root.payload,
        end_offset: offset,
        frames,
    })
}

pub fn read_index_tree(
    source: &dyn ByteSource,
    commit_offset: u64,
    root_offset: u64,
    encrypted: bool,
    data_key: Option<&ArchiveDataKey>,
) -> Result<BTreeMap<String, u64>> {
    let mut entries = BTreeMap::new();
    let mut visited = HashSet::new();
    let mut stack = vec![(root_offset, 0usize, true)];

    while let Some((offset, depth, is_root)) = stack.pop() {
        if depth > MAX_INDEX_DEPTH || !visited.insert(offset) {
            return err(
                "index_cycle",
                "B+ tree contains a cycle or excessive depth.",
            );
        }
        if offset >= commit_offset {
            return err(
                "index_page_invalid",
                "Index page is outside the committed archive region.",
            );
        }
        let frame = read_frame_at(source, offset)?;
        if frame.record_type != RecordType::INDEX_PAGE {
            return err(
                "index_page_invalid",
                "Index page points to a non-index record.",
            );
        }
        let mut payload = decode_stored_payload(frame.codec, frame.flags, &frame.stored_payload)?;
        if encrypted {
            if payload.len() < 32 {
                return err(
                    "archive_index_authentication_failed",
                    "Encrypted index page is truncated.",
                );
            }
            let authenticated_length = payload.len() - 32;
            if let Some(key) = data_key {
                if !key.authentication_matches(
                    "TUTORUX-INDEX-PAGE-V1",
                    &payload[..authenticated_length],
                    &payload[authenticated_length..],
                ) {
                    return err(
                        "archive_index_authentication_failed",
                        "Encrypted archive index authentication failed.",
                    );
                }
            }
            payload.truncate(authenticated_length);
        }
        let page = decode_index_page(&payload)?;
        if page.leaf {
            if !is_root && page.entries.is_empty() {
                return err(
                    "index_page_invalid",
                    "A non-root leaf index page cannot be empty.",
                );
            }
            for (key, value_offset) in page.entries {
                if value_offset < ARCHIVE_HEADER_SIZE
                    || value_offset >= commit_offset
                    || value_offset % 8 != 0
                {
                    return err(
                        "index_page_invalid",
                        "Leaf record offset is invalid.",
                    );
                }
                if entries.insert(key, value_offset).is_some() {
                    return err(
                        "index_page_order",
                        "Index keys are not globally unique.",
                    );
                }
            }
        } else {
            if page.children.len() != page.separators.len() + 1 || page.separators.is_empty() {
                return err(
                    "index_page_invalid",
                    "Internal index page has invalid children.",
                );
            }
            for (index, child) in page.children.iter().enumerate().rev() {
                stack.push((*child, depth + 1, false));
                if index > 0 {
                    // The separator order is validated during decode; child key ranges
                    // are validated by the verification pass.
                }
            }
        }
    }
    Ok(entries)
}

pub fn read_frame_at(source: &dyn ByteSource, offset: u64) -> Result<crate::core::format::RecordFrame> {
    if offset % 8 != 0 {
        return err(
            "record_offset_invalid",
            "Record offset is unaligned or outside the archive.",
        );
    }
    let header = source.read(offset, 64)?;
    let header_frame = crate::core::format::decode_record_frame_header(&header, offset)?;
    let total = 64usize
        + header_frame.payload_length as usize
        + ((8 - (header_frame.payload_length as usize % 8)) % 8);
    let bytes = source.read(offset, total)?;
    decode_record_frame(&bytes, offset)
}

pub fn primary_index_key(record_type: u16, id: &str) -> String {
    format!(
        "{}:{}",
        crate::core::format::record_type_name(record_type).to_uppercase(),
        id.to_lowercase()
    )
}
