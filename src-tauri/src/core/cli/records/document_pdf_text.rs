use super::{document_error, finish_text, inflate_zlib, size_limit, Extraction};
use super::{DOCUMENT_INPUT_LIMIT, DOCUMENT_TEXT_LIMIT};
use crate::core::error::Result;

const PDF_PAGE_LIMIT: usize = 512;
const PDF_STREAM_LIMIT: usize = 4096;

fn find_from(bytes: &[u8], needle: &[u8], start: usize) -> Option<usize> {
    if needle.is_empty() || start >= bytes.len() {
        return None;
    }
    bytes[start..]
        .windows(needle.len())
        .position(|window| window == needle)
        .map(|position| start + position)
}

fn rfind_before(bytes: &[u8], needle: &[u8], end: usize) -> Option<usize> {
    if needle.is_empty() || end < needle.len() {
        return None;
    }
    bytes[..end]
        .windows(needle.len())
        .rposition(|window| window == needle)
}

fn count_pages(bytes: &[u8]) -> usize {
    let mut count = 0usize;
    let mut index = 0usize;
    while let Some(position) = find_from(bytes, b"/Type", index) {
        let mut cursor = position + 5;
        while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
            cursor += 1;
        }
        if bytes.get(cursor..cursor + 5) == Some(&b"/Page"[..]) {
            let next = bytes.get(cursor + 5).copied().unwrap_or(b' ');
            if !next.is_ascii_alphabetic() {
                count += 1;
            }
        }
        index = position + 5;
    }
    count
}

fn pdf_string_text(bytes: &[u8], utf16: bool) -> String {
    if utf16 && bytes.len() % 2 == 0 {
        let units: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|pair| ((pair[0] as u16) << 8) | pair[1] as u16)
            .collect();
        return String::from_utf16_lossy(&units);
    }
    if bytes.starts_with(&[0xfe, 0xff]) {
        let units: Vec<u16> = bytes[2..]
            .chunks_exact(2)
            .map(|pair| ((pair[0] as u16) << 8) | pair[1] as u16)
            .collect();
        String::from_utf16_lossy(&units)
    } else if bytes.starts_with(&[0xff, 0xfe]) {
        let units: Vec<u16> = bytes[2..]
            .chunks_exact(2)
            .map(|pair| (pair[0] as u16) | ((pair[1] as u16) << 8))
            .collect();
        String::from_utf16_lossy(&units)
    } else {
        bytes.iter().map(|byte| *byte as char).collect()
    }
}

struct TextSink {
    text: String,
    exceeded: bool,
}

impl TextSink {
    fn new() -> Self {
        Self {
            text: String::new(),
            exceeded: false,
        }
    }

    fn push(&mut self, value: &str) {
        if self.exceeded {
            return;
        }
        if self.text.len() + value.len() > DOCUMENT_TEXT_LIMIT {
            self.exceeded = true;
            return;
        }
        self.text.push_str(value);
    }

    fn newline(&mut self) {
        if !self.exceeded && !self.text.is_empty() && !self.text.ends_with('\n') {
            self.push("\n");
        }
    }
}

fn pdf_literal(bytes: &[u8], start: usize) -> Option<(Vec<u8>, usize)> {
    let mut output = Vec::new();
    let mut depth = 1usize;
    let mut index = start + 1;
    while index < bytes.len() {
        match bytes[index] {
            b'\\' => {
                let next = *bytes.get(index + 1)?;
                index += 2;
                match next {
                    b'n' => output.push(b'\n'),
                    b'r' => output.push(b'\r'),
                    b't' => output.push(b'\t'),
                    b'b' => output.push(8),
                    b'f' => output.push(12),
                    b'\r' => {
                        if bytes.get(index) == Some(&b'\n') {
                            index += 1;
                        }
                    }
                    b'\n' => {}
                    b'0'..=b'7' => {
                        let mut value = (next - b'0') as u32;
                        let mut digits = 1;
                        while digits < 3 {
                            match bytes.get(index) {
                                Some(byte @ b'0'..=b'7') => {
                                    value = value * 8 + (*byte - b'0') as u32;
                                    index += 1;
                                    digits += 1;
                                }
                                _ => break,
                            }
                        }
                        output.push(value as u8);
                    }
                    other => output.push(other),
                }
            }
            b'(' => {
                depth += 1;
                output.push(b'(');
                index += 1;
            }
            b')' => {
                depth -= 1;
                if depth == 0 {
                    return Some((output, index + 1));
                }
                output.push(b')');
                index += 1;
            }
            byte => {
                output.push(byte);
                index += 1;
            }
        }
    }
    None
}

fn pdf_hex_string(bytes: &[u8], start: usize) -> Option<(Vec<u8>, usize)> {
    let mut output = Vec::new();
    let mut nibble: Option<u8> = None;
    let mut index = start + 1;
    while index < bytes.len() {
        let byte = bytes[index];
        index += 1;
        if byte == b'>' {
            if let Some(high) = nibble {
                output.push(high << 4);
            }
            return Some((output, index));
        }
        let value = match byte {
            b'0'..=b'9' => byte - b'0',
            b'a'..=b'f' => byte - b'a' + 10,
            b'A'..=b'F' => byte - b'A' + 10,
            _ if byte.is_ascii_whitespace() => continue,
            _ => return None,
        };
        match nibble.take() {
            Some(high) => output.push((high << 4) | value),
            None => nibble = Some(value),
        }
    }
    None
}

fn content_operator(token: &[u8]) -> bool {
    [
        "Tj".as_bytes(),
        "TJ".as_bytes(),
        "'".as_bytes(),
        "\"".as_bytes(),
        "Td".as_bytes(),
        "TD".as_bytes(),
        "T*".as_bytes(),
        "ET".as_bytes(),
        "Tm".as_bytes(),
    ]
    .contains(&token)
}

fn extract_content_text(content: &[u8], sink: &mut TextSink) {
    let mut pending: Vec<Vec<u8>> = Vec::new();
    let mut last_name: Vec<u8> = Vec::new();
    let mut utf16 = false;
    let mut index = 0usize;
    while index < content.len() {
        match content[index] {
            b'(' => {
                if let Some((text, next)) = pdf_literal(content, index) {
                    pending.push(text);
                    index = next;
                } else {
                    index += 1;
                }
            }
            b'<' => {
                if content.get(index + 1) == Some(&b'<') {
                    index += 2;
                    continue;
                }
                if let Some((text, next)) = pdf_hex_string(content, index) {
                    pending.push(text);
                    index = next;
                } else {
                    index += 1;
                }
            }
            b'%' => {
                while index < content.len() && content[index] != b'\n' {
                    index += 1;
                }
            }
            b'/' => {
                let start = index + 1;
                index = start;
                while index < content.len() && !content[index].is_ascii_whitespace() {
                    index += 1;
                }
                last_name = content[start..index].to_vec();
            }
            byte if byte.is_ascii_whitespace() || byte == b'[' || byte == b']' => index += 1,
            _ => {
                let start = index;
                while index < content.len() && !content[index].is_ascii_whitespace() {
                    index += 1;
                }
                let token = &content[start..index];
                let shows = ["Tj", "TJ", "'", "\""]
                    .iter()
                    .any(|operator| token == operator.as_bytes());
                if shows {
                    for text in pending.drain(..) {
                        sink.push(&pdf_string_text(&text, utf16));
                    }
                    if token == "'".as_bytes() || token == "\"".as_bytes() {
                        sink.newline();
                    }
                } else {
                    if token == "Tf".as_bytes() {
                        utf16 = last_name.as_slice() == b"F2";
                    }
                    let numeric = !token.is_empty()
                        && token.iter().all(|byte| {
                            byte.is_ascii_digit() || matches!(byte, b'.' | b'-' | b'+')
                        });
                    if !numeric {
                        pending.clear();
                    }
                    if content_operator(token) {
                        sink.newline();
                    }
                }
            }
        }
    }
}

fn stream_filters(dictionary: &[u8]) -> Vec<Vec<u8>> {
    let mut filters = Vec::new();
    let mut index = 0usize;
    while let Some(position) = find_from(dictionary, b"/Filter", index) {
        let mut cursor = position + 7;
        while cursor < dictionary.len() {
            while cursor < dictionary.len() && dictionary[cursor].is_ascii_whitespace() {
                cursor += 1;
            }
            if dictionary.get(cursor) == Some(&b'/') {
                let start = cursor;
                cursor += 1;
                while cursor < dictionary.len()
                    && !dictionary[cursor].is_ascii_whitespace()
                    && !matches!(dictionary[cursor], b'[' | b']' | b'/' | b'<' | b'>')
                {
                    cursor += 1;
                }
                filters.push(dictionary[start..cursor].to_vec());
            } else if dictionary.get(cursor) == Some(&b'[') {
                cursor += 1;
            } else {
                break;
            }
            if dictionary.get(cursor) != Some(&b'/') {
                break;
            }
        }
        index = position + 7;
    }
    filters
}

fn stream_length(dictionary: &[u8]) -> Option<usize> {
    let position = find_from(dictionary, b"/Length", 0)?;
    let mut cursor = position + 7;
    while cursor < dictionary.len() && dictionary[cursor].is_ascii_whitespace() {
        cursor += 1;
    }
    let start = cursor;
    while cursor < dictionary.len() && dictionary[cursor].is_ascii_digit() {
        cursor += 1;
    }
    if cursor == start {
        return None;
    }
    std::str::from_utf8(&dictionary[start..cursor])
        .ok()?
        .parse()
        .ok()
}

fn extract_pdf_streams(bytes: &[u8], sink: &mut TextSink) {
    let mut index = 0usize;
    let mut streams = 0usize;
    while let Some(position) = find_from(bytes, b"stream", index) {
        if position > 0 && bytes[position - 1].is_ascii_alphanumeric() {
            index = position + 6;
            continue;
        }
        streams += 1;
        if streams > PDF_STREAM_LIMIT {
            break;
        }
        let mut data_start = position + 6;
        if bytes.get(data_start) == Some(&b'\r') {
            data_start += 1;
        }
        if bytes.get(data_start) == Some(&b'\n') {
            data_start += 1;
        }
        let dictionary_start = rfind_before(bytes, b"obj", position).unwrap_or(0);
        let dictionary = &bytes[dictionary_start..position];
        let filters = stream_filters(dictionary);
        let is_flate = filters
            .iter()
            .any(|filter| filter.as_slice() == "/FlateDecode".as_bytes());
        let is_image = find_from(dictionary, b"/Image", 0).is_some();
        let decodable = !is_image && (filters.is_empty() || is_flate);
        let data_end = match stream_length(dictionary) {
            Some(length) => (data_start + length).min(bytes.len()),
            None => find_from(bytes, b"endstream", data_start).unwrap_or(bytes.len()),
        };
        if decodable {
            let data = &bytes[data_start..data_end];
            let decoded = if is_flate {
                inflate_zlib(data, DOCUMENT_INPUT_LIMIT)
            } else {
                Some(data.to_vec())
            };
            if let Some(content) = decoded {
                extract_content_text(&content, sink);
            }
        }
        index = data_end.max(position + 6);
    }
}

pub(super) fn extract_pdf(bytes: &[u8]) -> Result<Extraction> {
    if bytes.is_empty() {
        return Err(document_error("PDF file is empty."));
    }
    if find_from(&bytes[..bytes.len().min(1024)], b"%PDF-", 0).is_none() {
        return Err(document_error(
            "PDF is malformed, encrypted, or cannot be parsed.",
        ));
    }
    if find_from(bytes, b"/Encrypt", 0).is_some() {
        return Err(document_error("PDF is encrypted and cannot be read."));
    }
    let pages = count_pages(bytes);
    if pages > PDF_PAGE_LIMIT {
        return Ok(size_limit());
    }
    let mut sink = TextSink::new();
    extract_pdf_streams(bytes, &mut sink);
    if sink.exceeded {
        return Ok(size_limit());
    }
    let text = sink
        .text
        .trim_end_matches(|character| character == '\r' || character == '\n')
        .to_owned();
    Ok(finish_text(text, Some(pages), None))
}
