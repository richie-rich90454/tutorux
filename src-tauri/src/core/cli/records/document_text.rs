use crate::core::error::CoreError;
use crate::core::error::Result;
use std::collections::BTreeMap;
use std::io::Read;

#[path = "document_pdf_text.rs"]
mod document_pdf_text;
use document_pdf_text::extract_pdf;

pub(crate) const DOCUMENT_INPUT_LIMIT: usize = 16 * 1024 * 1024;
pub(crate) const DOCUMENT_TEXT_LIMIT: usize = 2 * 1024 * 1024;
const DOCX_XML_LIMIT: usize = 4 * 1024 * 1024;
const DOCX_ENTRY_LIMIT: usize = 2048;

pub(crate) struct Extraction {
    pub(crate) status: &'static str,
    pub(crate) text: String,
    pub(crate) page_count: Option<usize>,
    pub(crate) paragraph_count: Option<usize>,
}

fn document_error(message: &str) -> CoreError {
    CoreError::new("asset_document_invalid", message.to_owned())
}

fn read_u16(bytes: &[u8], offset: usize) -> Result<u16> {
    let low = *bytes
        .get(offset)
        .ok_or_else(|| document_error("DOCX ZIP structure exceeds its bounds."))?;
    let high = *bytes
        .get(offset + 1)
        .ok_or_else(|| document_error("DOCX ZIP structure exceeds its bounds."))?;
    Ok((low as u16) | ((high as u16) << 8))
}

fn read_u32(bytes: &[u8], offset: usize) -> Result<u32> {
    let mut value = 0u32;
    for index in 0..4 {
        let byte = *bytes
            .get(offset + index)
            .ok_or_else(|| document_error("DOCX ZIP structure exceeds its bounds."))?;
        value |= (byte as u32) << (index * 8);
    }
    Ok(value)
}

fn crc32(bytes: &[u8]) -> u32 {
    let mut table = [0u32; 256];
    for (index, slot) in table.iter_mut().enumerate() {
        let mut value = index as u32;
        for _ in 0..8 {
            value = if value & 1 != 0 {
                (value >> 1) ^ 0xedb8_8320
            } else {
                value >> 1
            };
        }
        *slot = value;
    }
    let mut crc = 0xffff_ffffu32;
    for byte in bytes {
        crc = (crc >> 8) ^ table[((crc ^ *byte as u32) & 0xff) as usize];
    }
    !crc
}

struct ZipEntry<'a> {
    method: u16,
    crc: u32,
    packed: &'a [u8],
    uncompressed: u32,
}

fn docx_entry<'a>(bytes: &'a [u8], name: &[u8]) -> Result<ZipEntry<'a>> {
    if bytes.len() < 22 {
        return Err(document_error("DOCX ZIP directory is missing."));
    }
    let search_begin = bytes.len().saturating_sub(65_557);
    let mut end = None;
    for offset in (search_begin..=bytes.len() - 22).rev() {
        if read_u32(bytes, offset).ok() == Some(0x0605_4b50)
            && read_u16(bytes, offset + 20)
                .ok()
                .map(|value| value as usize)
                == Some(bytes.len() - offset - 22)
        {
            end = Some(offset);
            break;
        }
    }
    let end = end.ok_or_else(|| document_error("DOCX ZIP end directory is invalid."))?;
    if read_u16(bytes, end + 4)? != 0 || read_u16(bytes, end + 6)? != 0 {
        return Err(document_error(
            "DOCX ZIP uses an unsupported multi-disk layout.",
        ));
    }
    let disk_entries = read_u16(bytes, end + 8)? as usize;
    let entry_count = read_u16(bytes, end + 10)? as usize;
    let directory_size = read_u32(bytes, end + 12)? as usize;
    let directory_offset = read_u32(bytes, end + 16)? as usize;
    if disk_entries != entry_count
        || entry_count == 0
        || entry_count > DOCX_ENTRY_LIMIT
        || entry_count == 0xffff
        || directory_size == 0xffff_ffff
        || directory_offset == 0xffff_ffff
        || directory_offset + directory_size > end
    {
        return Err(document_error(
            "DOCX ZIP directory uses unsupported or invalid bounds.",
        ));
    }
    let directory_end = directory_offset + directory_size;
    let mut cursor = directory_offset;
    let mut found: Option<(usize, ZipEntry<'a>)> = None;
    for _ in 0..entry_count {
        if directory_end.saturating_sub(cursor) < 46 || read_u32(bytes, cursor)? != 0x0201_4b50 {
            return Err(document_error(
                "DOCX ZIP central directory entry is invalid.",
            ));
        }
        let flags = read_u16(bytes, cursor + 8)?;
        let method = read_u16(bytes, cursor + 10)?;
        let crc = read_u32(bytes, cursor + 16)?;
        let packed_size = read_u32(bytes, cursor + 20)? as usize;
        let uncompressed = read_u32(bytes, cursor + 24)?;
        let name_length = read_u16(bytes, cursor + 28)? as usize;
        let extra_length = read_u16(bytes, cursor + 30)? as usize;
        let comment_length = read_u16(bytes, cursor + 32)? as usize;
        let disk_start = read_u16(bytes, cursor + 34)?;
        let local_offset = read_u32(bytes, cursor + 42)? as usize;
        let record_size = 46 + name_length + extra_length + comment_length;
        if record_size > directory_end - cursor || disk_start != 0 {
            return Err(document_error(
                "DOCX ZIP central directory entry exceeds its bounds.",
            ));
        }
        let entry_name = bytes
            .get(cursor + 46..cursor + 46 + name_length)
            .ok_or_else(|| document_error("DOCX ZIP entry name exceeds its bounds."))?;
        if entry_name == name {
            if found.is_some() {
                return Err(document_error(
                    "DOCX ZIP contains duplicate main document entries.",
                ));
            }
            if flags & 1 != 0 || flags & 0x40 != 0 {
                return Err(document_error(
                    "DOCX main document uses unsupported or invalid ZIP features.",
                ));
            }
            if method != 0 && method != 8 {
                return Err(document_error(
                    "DOCX main document uses unsupported or invalid ZIP features.",
                ));
            }
            if packed_size == 0 || packed_size > DOCUMENT_INPUT_LIMIT {
                return Err(document_error(
                    "DOCX main document uses unsupported or invalid ZIP features.",
                ));
            }
            if uncompressed == 0 {
                return Err(document_error(
                    "DOCX main document uses unsupported or invalid ZIP features.",
                ));
            }
            if local_offset > directory_offset || local_offset + 30 > bytes.len() {
                return Err(document_error(
                    "DOCX main document local header is invalid.",
                ));
            }
            if read_u32(bytes, local_offset)? != 0x0403_4b50 {
                return Err(document_error(
                    "DOCX main document local header is invalid.",
                ));
            }
            let local_flags = read_u16(bytes, local_offset + 6)?;
            let local_method = read_u16(bytes, local_offset + 8)?;
            let local_name_length = read_u16(bytes, local_offset + 26)? as usize;
            let local_extra_length = read_u16(bytes, local_offset + 28)? as usize;
            let data_offset = local_offset + 30 + local_name_length + local_extra_length;
            let local_name = bytes
                .get(local_offset + 30..local_offset + 30 + local_name_length)
                .ok_or_else(|| document_error("DOCX main document local header is invalid."))?;
            if local_flags != flags
                || local_method != method
                || local_name != name
                || data_offset > directory_offset
                || packed_size > directory_offset - data_offset
            {
                return Err(document_error(
                    "DOCX main document local header is inconsistent.",
                ));
            }
            let packed = &bytes[data_offset..data_offset + packed_size];
            found = Some((
                uncompressed as usize,
                ZipEntry {
                    method,
                    crc,
                    packed,
                    uncompressed,
                },
            ));
        }
        cursor += record_size;
    }
    if cursor != directory_end {
        return Err(document_error("DOCX ZIP central directory is invalid."));
    }
    let entry = found
        .ok_or_else(|| document_error("DOCX ZIP has no valid word/document.xml entry."))?
        .1;
    Ok(entry)
}

fn inflate_raw(packed: &[u8], expected: usize) -> Result<Vec<u8>> {
    let mut decoder = flate2::read::DeflateDecoder::new(packed);
    let mut output = Vec::with_capacity(expected.min(DOCX_XML_LIMIT));
    decoder
        .by_ref()
        .take(expected as u64 + 1)
        .read_to_end(&mut output)
        .map_err(|_| document_error("DOCX main document deflate stream is invalid."))?;
    Ok(output)
}

fn inflate_zlib(packed: &[u8], limit: usize) -> Option<Vec<u8>> {
    let mut decoder = flate2::read::ZlibDecoder::new(packed);
    let mut output = Vec::new();
    decoder
        .by_ref()
        .take(limit as u64 + 1)
        .read_to_end(&mut output)
        .ok()?;
    if output.len() > limit {
        None
    } else {
        Some(output)
    }
}

fn decode_xml_entities(value: &str) -> Result<String> {
    let mut output = String::with_capacity(value.len());
    let mut rest = value;
    while let Some(start) = rest.find('&') {
        output.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        let Some(end) = after.find(';') else {
            return Err(document_error("DOCX text contains an invalid XML entity."));
        };
        if end > 16 {
            return Err(document_error("DOCX text contains an invalid XML entity."));
        }
        let entity = &after[..end];
        let character = match entity {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            _ if entity.starts_with('#') => {
                let (digits, radix): (&str, u32) = match entity
                    .strip_prefix("#x")
                    .or_else(|| entity.strip_prefix("#X"))
                {
                    Some(digits) => (digits, 16),
                    None => (&entity[1..], 10),
                };
                if digits.is_empty() {
                    return Err(document_error("DOCX text contains an invalid XML entity."));
                }
                u32::from_str_radix(digits, radix)
                    .ok()
                    .filter(|point| {
                        *point == 0x09
                            || *point == 0x0a
                            || *point == 0x0d
                            || (0x20u32..=0xd7ff).contains(point)
                            || (0xe000u32..=0xfffd).contains(point)
                            || (0x10000u32..=0x10ffff).contains(point)
                    })
                    .and_then(char::from_u32)
            }
            _ => None,
        };
        let character =
            character.ok_or_else(|| document_error("DOCX text contains an invalid XML entity."))?;
        output.push(character);
        rest = &after[end + 1..];
    }
    output.push_str(rest);
    Ok(output)
}

fn docx_xml_text(xml: &str) -> Result<(String, usize)> {
    let mut output = String::new();
    let mut paragraphs = 0usize;
    let mut in_text = false;
    let mut index = 0usize;
    while index < xml.len() {
        let Some(relative) = xml[index..].find('<') else {
            if in_text {
                output.push_str(&decode_xml_entities(&xml[index..])?);
            }
            break;
        };
        let open = index + relative;
        if in_text {
            output.push_str(&decode_xml_entities(&xml[index..open])?);
        }
        let rest = &xml[open..];
        if rest.starts_with("<!--") {
            let close = rest
                .find("-->")
                .ok_or_else(|| document_error("DOCX XML contains an unterminated comment."))?;
            index = open + close + 3;
            continue;
        }
        if rest.starts_with("<?") {
            let close = rest
                .find("?>")
                .ok_or_else(|| document_error("DOCX XML contains an unterminated instruction."))?;
            index = open + close + 2;
            continue;
        }
        if rest.starts_with("<![CDATA[") {
            let close = rest.find("]]>").ok_or_else(|| {
                document_error("DOCX XML contains an unterminated CDATA section.")
            })?;
            if in_text {
                output.push_str(&rest[9..close]);
            }
            index = open + close + 3;
            continue;
        }
        if rest.starts_with("<!") {
            return Err(document_error(
                "DOCX XML declarations and doctypes are unsupported.",
            ));
        }
        let close = rest
            .find('>')
            .ok_or_else(|| document_error("DOCX XML contains an unterminated tag."))?;
        let mut tag = &rest[1..close];
        let closing = tag.starts_with('/');
        if closing {
            tag = &tag[1..];
        }
        let self_closing = tag.ends_with('/');
        if self_closing {
            tag = &tag[..tag.len() - 1];
        }
        let name_end = tag
            .find(|character: char| character.is_whitespace())
            .unwrap_or(tag.len());
        let name = &tag[..name_end];
        if closing {
            if name == "w:t" {
                in_text = false;
            } else if name == "w:p" {
                paragraphs += 1;
                push_paragraph_break(&mut output);
            }
        } else {
            if name == "w:t" {
                in_text = !self_closing;
            } else if name == "w:tab" {
                output.push('\t');
            } else if name == "w:br" || name == "w:cr" {
                output.push('\n');
            } else if name == "w:p" && self_closing {
                paragraphs += 1;
                push_paragraph_break(&mut output);
            }
        }
        index = open + close + 1;
    }
    while output.ends_with('\n') {
        output.pop();
    }
    Ok((output, paragraphs))
}

fn push_paragraph_break(output: &mut String) {
    if !output.is_empty() && !output.ends_with('\n') {
        output.push('\n');
    }
}

fn finish_text(
    text: String,
    page_count: Option<usize>,
    paragraph_count: Option<usize>,
) -> Extraction {
    let status = if text.chars().any(|character| !" \t\r\n".contains(character)) {
        "extracted"
    } else {
        "no-text"
    };
    Extraction {
        status,
        text: if status == "extracted" {
            text
        } else {
            String::new()
        },
        page_count,
        paragraph_count,
    }
}

fn size_limit() -> Extraction {
    Extraction {
        status: "size-limit",
        text: String::new(),
        page_count: None,
        paragraph_count: None,
    }
}

fn extract_docx(bytes: &[u8]) -> Result<Extraction> {
    let entry = docx_entry(bytes, b"word/document.xml")?;
    if entry.uncompressed as usize > DOCX_XML_LIMIT {
        return Ok(size_limit());
    }
    let xml_bytes = if entry.method == 0 {
        if entry.packed.len() != entry.uncompressed as usize {
            return Err(document_error(
                "DOCX stored document has inconsistent sizes.",
            ));
        }
        entry.packed.to_vec()
    } else {
        inflate_raw(entry.packed, entry.uncompressed as usize)?
    };
    if xml_bytes.len() != entry.uncompressed as usize {
        return Err(document_error(
            "DOCX main document deflate stream has inconsistent sizes.",
        ));
    }
    if crc32(&xml_bytes) != entry.crc {
        return Err(document_error(
            "DOCX main document checksum does not match.",
        ));
    }
    let xml = std::str::from_utf8(&xml_bytes)
        .map_err(|_| document_error("DOCX main document is not valid UTF-8."))?;
    let xml = xml.strip_prefix('\u{feff}').unwrap_or(xml);
    let (text, paragraphs) = docx_xml_text(xml)?;
    if text.len() > DOCUMENT_TEXT_LIMIT {
        return Ok(size_limit());
    }
    Ok(finish_text(text, None, Some(paragraphs)))
}

pub(crate) fn apply_text_extraction(
    fields: &mut BTreeMap<String, String>,
    mime_type: &str,
    bytes: &[u8],
) -> Result<()> {
    let is_pdf = mime_type == "application/pdf";
    let is_docx =
        mime_type == "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    if !is_pdf && !is_docx {
        return Ok(());
    }
    if bytes.len() > DOCUMENT_INPUT_LIMIT {
        fields.insert("text_extraction_status".to_owned(), "size-limit".to_owned());
        return Ok(());
    }
    let extraction = if is_docx {
        extract_docx(bytes)?
    } else {
        extract_pdf(bytes)?
    };
    fields.insert(
        "text_extraction_status".to_owned(),
        extraction.status.to_owned(),
    );
    if !extraction.text.is_empty() {
        fields.insert("extracted_text".to_owned(), extraction.text);
    }
    if let Some(pages) = extraction.page_count {
        fields.insert("page_count".to_owned(), pages.to_string());
    }
    if let Some(paragraphs) = extraction.paragraph_count {
        fields.insert("paragraph_count".to_owned(), paragraphs.to_string());
    }
    Ok(())
}

#[cfg(test)]
#[path = "document_text_tests.rs"]
mod tests;
