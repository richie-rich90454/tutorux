use super::*;

pub(crate) const ASSET_CHUNK_BYTES: usize = 8 * 1024 * 1024;
// Per-file commits preserve the TypeScript CLI's archive generation count; these remain the documented batch ceilings.
#[allow(dead_code)]
pub(crate) const ASSET_IMPORT_BATCH_BYTES: usize = 64 * 1024 * 1024;
#[allow(dead_code)]
pub(crate) const ASSET_IMPORT_BATCH_FILES: usize = 128;
const MAX_ASSET_BYTES: usize = 256 * 1024 * 1024;

pub(crate) struct CaptureImport {
    pub(crate) source: String,
    pub(crate) consent_at_us: String,
}

pub(crate) struct MemoryStaging {
    bytes: Vec<u8>,
}

impl crate::core::archive::ArchiveStaging for MemoryStaging {
    fn append(&mut self, bytes: &[u8]) -> Result<()> {
        self.bytes.extend_from_slice(bytes);
        Ok(())
    }

    fn seal(&mut self) -> Result<std::sync::Arc<dyn crate::core::source::ByteSource>> {
        Ok(std::sync::Arc::new(crate::core::source::MemorySource::new(
            std::mem::take(&mut self.bytes),
        )))
    }

    fn abort(&mut self) -> Result<()> {
        self.bytes.clear();
        Ok(())
    }
}

pub(crate) fn mutate_staged_assets(
    path: &std::path::Path,
    snapshot: &ArchiveSnapshot,
    records: Vec<ArchiveRecord>,
) -> CliResult<Vec<ArchiveRecord>> {
    let mut staging = MemoryStaging { bytes: Vec::new() };
    let next = crate::core::archive::append_staged_asset_records(
        snapshot,
        records.into_iter(),
        &mut staging,
    )?;
    let bytes = next.source.read(0, next.source.size() as usize)?;
    crate::core::cli::archive::save::save_bytes(path, &bytes)?;
    let mut saved = Vec::new();
    for key in next.all_index_entries().keys() {
        if key.matches(':').count() != 1 {
            continue;
        }
        let Some((type_name, id)) = key.split_once(':') else {
            continue;
        };
        let Some(record_type) = crate::core::format::record_type_from_name(type_name) else {
            continue;
        };
        if record_type == RecordType::ASSET_METADATA || record_type == RecordType::ASSET_BLOB {
            if let Some(record) = next.get_record(record_type, id)? {
                saved.push(record);
            }
        }
    }
    Ok(saved)
}

pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    crate::core::archive::sha256(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

pub(crate) fn guess_mime(filename: &str) -> &'static str {
    match filename
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "txt" | "text" | "log" => "text/plain",
        "md" | "markdown" => "text/markdown",
        "csv" => "text/csv",
        "json" => "application/json",
        "pdf" => "application/pdf",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "wav" => "audio/wav",
        "mp3" => "audio/mpeg",
        "m4a" => "audio/mp4",
        "flac" => "audio/flac",
        "ogg" | "oga" => "audio/ogg",
        "webm" => "video/webm",
        _ => "application/octet-stream",
    }
}

fn zip_u16(bytes: &[u8], offset: usize) -> Option<u16> {
    Some((*bytes.get(offset)? as u16) | ((*bytes.get(offset + 1)? as u16) << 8))
}

fn zip_u32(bytes: &[u8], offset: usize) -> Option<u32> {
    Some(zip_u16(bytes, offset)? as u32 | ((zip_u16(bytes, offset + 2)? as u32) << 16))
}

fn decode_xml_entities(value: &str) -> String {
    value
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

fn docx_text(bytes: &[u8]) -> Option<Vec<u8>> {
    let end = (0..bytes.len().saturating_sub(21))
        .rev()
        .find(|offset| zip_u32(bytes, *offset) == Some(0x0605_4b50))?;
    let count = zip_u16(bytes, end + 10)? as usize;
    let directory_offset = zip_u32(bytes, end + 16)? as usize;
    let mut cursor = directory_offset;
    for _ in 0..count {
        if zip_u32(bytes, cursor) != Some(0x0201_4b50) {
            return None;
        }
        let method = zip_u16(bytes, cursor + 10)?;
        let packed = zip_u32(bytes, cursor + 20)? as usize;
        let name_length = zip_u16(bytes, cursor + 28)? as usize;
        let extra = zip_u16(bytes, cursor + 30)? as usize;
        let comment = zip_u16(bytes, cursor + 32)? as usize;
        let local = zip_u32(bytes, cursor + 42)? as usize;
        let name = bytes.get(cursor + 46..cursor + 46 + name_length)?;
        if name == b"word/document.xml" {
            if method != 0 {
                return None;
            }
            let local_name = zip_u16(bytes, local + 26)? as usize;
            let local_extra = zip_u16(bytes, local + 28)? as usize;
            let start = local + 30 + local_name + local_extra;
            return bytes.get(start..start + packed).map(<[u8]>::to_vec);
        }
        cursor += 46 + name_length + extra + comment;
    }
    None
}

fn docx_document_text(bytes: &[u8]) -> Option<String> {
    let xml = docx_text(bytes)?;
    let xml = String::from_utf8(xml).ok()?;
    let mut output = String::new();
    let mut rest = xml.as_str();
    let mut in_text = false;
    while let Some(open) = rest.find('<') {
        let text = &rest[..open];
        if in_text {
            output.push_str(&decode_xml_entities(text));
        }
        let Some(close) = rest[open..].find('>') else {
            break;
        };
        let tag = &rest[open + 1..open + close];
        if tag.starts_with("w:t") {
            in_text = true;
        } else if tag.starts_with("/w:t") {
            in_text = false;
        } else if tag.starts_with("w:tab") {
            output.push('\t');
        } else if tag.starts_with("/w:p") {
            output.push('\n');
        }
        rest = &rest[open + close + 1..];
    }
    Some(output)
}

fn pdf_text(bytes: &[u8]) -> String {
    let mut output = String::new();
    let mut index = 0usize;
    while index < bytes.len() {
        if bytes[index] == b'(' {
            let mut depth = 1usize;
            let mut position = index + 1;
            let mut text = Vec::new();
            while position < bytes.len() && depth > 0 {
                match bytes[position] {
                    b'\\' => {
                        if let Some(next) = bytes.get(position + 1) {
                            text.push(match next {
                                b'n' => b'\n',
                                b'r' => b'\r',
                                b't' => b'\t',
                                other => *other,
                            });
                            position += 2;
                            continue;
                        }
                    }
                    b'(' => depth += 1,
                    b')' => {
                        depth -= 1;
                        if depth == 0 {
                            break;
                        }
                    }
                    byte => text.push(byte),
                }
                position += 1;
            }
            if !text.is_empty() {
                output.push_str(&String::from_utf8_lossy(&text));
                output.push('\n');
            }
            index = position + 1;
        } else {
            index += 1;
        }
    }
    output
}

fn finish_extraction(text: String) -> (&'static str, String) {
    let bounded: String = text.chars().take(2 * 1024 * 1024).collect();
    if bounded
        .chars()
        .any(|character| !" \t\r\n".contains(character))
    {
        ("extracted", bounded)
    } else {
        ("no-text", String::new())
    }
}

pub(crate) fn apply_text_extraction(
    fields: &mut BTreeMap<String, String>,
    mime_type: &str,
    bytes: &[u8],
) {
    let is_pdf = mime_type == "application/pdf";
    let is_docx =
        mime_type == "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    if !is_pdf && !is_docx {
        return;
    }
    if bytes.len() > 16 * 1024 * 1024 {
        fields.insert("text_extraction_status".to_owned(), "size-limit".to_owned());
        return;
    }
    let text = if is_docx {
        docx_document_text(bytes).unwrap_or_default()
    } else {
        pdf_text(bytes)
    };
    let (status, text) = finish_extraction(text);
    fields.insert("text_extraction_status".to_owned(), status.to_owned());
    if !text.is_empty() {
        fields.insert("extracted_text".to_owned(), text);
    }
}

pub(crate) fn import_asset(
    snapshot: &ArchiveSnapshot,
    bytes: &[u8],
    filename: &str,
    session_id: &str,
    capture: Option<&CaptureImport>,
) -> Result<Vec<ArchiveRecord>> {
    if bytes.len() > MAX_ASSET_BYTES {
        return Err(CoreError::new(
            "asset_size_invalid",
            "Materials are limited to 256 MiB per file in this version.",
        ));
    }
    let content_hash = sha256_hex(bytes);
    let existing_blob = snapshot.get_record_by_index_key(&format!("BLOB:{content_hash}"))?;
    let existing_blob = existing_blob.filter(|record| !record.deleted());
    let timestamp = now_us().to_string();
    let mut records = Vec::new();
    let blob_id;
    let mut chunk_count = bytes.len().div_ceil(ASSET_CHUNK_BYTES);
    if let Some(existing) = existing_blob {
        if existing.record_type != RecordType::ASSET_BLOB
            || existing.field("content_hash").map(str::to_lowercase) != Some(content_hash.clone())
        {
            return Err(CoreError::new(
                "asset_blob_index_invalid",
                "The archive content hash index points to an invalid asset blob.",
            ));
        }
        if existing.field("record_role") == Some("asset-blob-manifest") {
            chunk_count = existing
                .field("chunk_count")
                .and_then(|value| value.parse::<usize>().ok())
                .ok_or_else(|| {
                    CoreError::new("asset_manifest_invalid", "Material chunk count is invalid.")
                })?;
        }
        blob_id = existing.id.clone();
    } else {
        blob_id = crate::core::archive::new_uuid();
        let mut chunk_ids = Vec::new();
        for (index, chunk) in bytes.chunks(ASSET_CHUNK_BYTES).enumerate() {
            let chunk_id = crate::core::archive::new_uuid();
            chunk_ids.push(chunk_id.clone());
            let mut record = ArchiveRecord::new(
                RecordType::ASSET_BLOB,
                chunk_id,
                [
                    ("record_role", "asset-blob-chunk".to_owned()),
                    ("manifest_id", blob_id.clone()),
                    ("chunk_index", index.to_string()),
                    ("byte_size", chunk.len().to_string()),
                ],
            );
            record.blob = chunk.to_vec();
            records.push(record);
        }
        records.push(ArchiveRecord::new(
            RecordType::ASSET_BLOB,
            &blob_id,
            [
                ("record_role", "asset-blob-manifest".to_owned()),
                ("content_hash", content_hash.clone()),
                ("byte_size", bytes.len().to_string()),
                ("chunk_count", chunk_count.to_string()),
                ("chunk_ids", chunk_ids.join(",")),
            ],
        ));
    }
    let mut fields = BTreeMap::new();
    let mut mime_type = guess_mime(filename).to_owned();
    if capture.is_some() {
        let browser_webm = mime_type == "video/webm" && filename.to_lowercase().ends_with(".webm");
        if !mime_type.starts_with("audio/") && !browser_webm {
            return Err(CoreError::new(
                "asset_capture_invalid",
                "A browser microphone capture must contain a recognized audio file.",
            ));
        }
        if browser_webm {
            mime_type = "audio/webm".to_owned();
        }
    }
    fields.insert("filename".to_owned(), filename.to_owned());
    fields.insert("mime_type".to_owned(), mime_type.clone());
    fields.insert("byte_size".to_owned(), bytes.len().to_string());
    fields.insert("content_hash".to_owned(), content_hash);
    fields.insert("blob_id".to_owned(), blob_id);
    fields.insert("blob_count".to_owned(), chunk_count.to_string());
    fields.insert("origin".to_owned(), "user-import".to_owned());
    fields.insert("created_at_us".to_owned(), timestamp);
    if !session_id.is_empty() {
        fields.insert("session_id".to_owned(), session_id.to_owned());
    }
    if let Some(capture) = capture {
        fields.insert("capture_source".to_owned(), capture.source.clone());
        fields.insert(
            "capture_consent_at_us".to_owned(),
            capture.consent_at_us.clone(),
        );
        fields.insert("capture_consent_policy".to_owned(), "1".to_owned());
    }
    apply_text_extraction(&mut fields, &mime_type, bytes);
    records.push(ArchiveRecord {
        record_type: RecordType::ASSET_METADATA,
        id: crate::core::archive::new_uuid(),
        revision: 0,
        previous_offset: 0,
        fields,
        blob: Vec::new(),
    });
    Ok(records)
}
