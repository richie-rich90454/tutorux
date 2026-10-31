use super::*;
use std::collections::BTreeMap;

fn zip(files: &[(&str, &[u8])], deflate: bool) -> Vec<u8> {
    use flate2::write::DeflateEncoder;
    use flate2::Compression;
    use std::io::Write;

    let mut output = Vec::new();
    let mut directory = Vec::new();
    for (name, data) in files {
        let (method, stored): (u16, Vec<u8>) = if deflate {
            let mut encoder = DeflateEncoder::new(Vec::new(), Compression::default());
            encoder.write_all(data).ok().unwrap();
            (8, encoder.finish().ok().unwrap())
        } else {
            (0, data.to_vec())
        };
        let offset = output.len();
        output.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
        output.extend_from_slice(&20u16.to_le_bytes());
        output.extend_from_slice(&0u16.to_le_bytes());
        output.extend_from_slice(&method.to_le_bytes());
        output.extend_from_slice(&0u16.to_le_bytes());
        output.extend_from_slice(&0u16.to_le_bytes());
        output.extend_from_slice(&crc32(data).to_le_bytes());
        output.extend_from_slice(&(stored.len() as u32).to_le_bytes());
        output.extend_from_slice(&(data.len() as u32).to_le_bytes());
        output.extend_from_slice(&(name.len() as u16).to_le_bytes());
        output.extend_from_slice(&0u16.to_le_bytes());
        output.extend_from_slice(name.as_bytes());
        output.extend_from_slice(&stored);

        directory.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
        directory.extend_from_slice(&20u16.to_le_bytes());
        directory.extend_from_slice(&20u16.to_le_bytes());
        directory.extend_from_slice(&0u16.to_le_bytes());
        directory.extend_from_slice(&method.to_le_bytes());
        directory.extend_from_slice(&0u16.to_le_bytes());
        directory.extend_from_slice(&0u16.to_le_bytes());
        directory.extend_from_slice(&crc32(data).to_le_bytes());
        directory.extend_from_slice(&(stored.len() as u32).to_le_bytes());
        directory.extend_from_slice(&(data.len() as u32).to_le_bytes());
        directory.extend_from_slice(&(name.len() as u16).to_le_bytes());
        for _ in 0..4 {
            directory.extend_from_slice(&0u16.to_le_bytes());
        }
        directory.extend_from_slice(&0u32.to_le_bytes());
        directory.extend_from_slice(&(offset as u32).to_le_bytes());
        directory.extend_from_slice(name.as_bytes());
    }
    let directory_offset = output.len();
    output.extend_from_slice(&directory);
    output.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
    output.extend_from_slice(&0u16.to_le_bytes());
    output.extend_from_slice(&0u16.to_le_bytes());
    output.extend_from_slice(&(files.len() as u16).to_le_bytes());
    output.extend_from_slice(&(files.len() as u16).to_le_bytes());
    output.extend_from_slice(&(directory.len() as u32).to_le_bytes());
    output.extend_from_slice(&(directory_offset as u32).to_le_bytes());
    output.extend_from_slice(&0u16.to_le_bytes());
    output
}

fn docx(xml: &str, deflate: bool) -> Vec<u8> {
    zip(&[("word/document.xml", xml.as_bytes())], deflate)
}

fn fields_for(mime: &str, bytes: &[u8]) -> BTreeMap<String, String> {
    let mut fields = BTreeMap::new();
    apply_text_extraction(&mut fields, mime, bytes)
        .ok()
        .unwrap();
    fields
}

#[test]
fn extracts_deflated_docx_text() {
    let xml = "<w:document><w:body><w:p><w:r><w:t>Hello &amp; &#x1F600;</w:t></w:r>\
               <w:r><w:tab/></w:r><w:r><w:t>world</w:t><w:br/><w:t>again</w:t></w:r></w:p>\
               <w:p><w:r><w:t>Second</w:t></w:r></w:p></w:body></w:document>";
    let bytes = docx(xml, true);
    let fields = fields_for(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        &bytes,
    );
    assert_eq!(fields["text_extraction_status"], "extracted");
    assert_eq!(fields["extracted_text"], "Hello & 😀\tworld\nagain\nSecond");
    assert_eq!(fields["paragraph_count"], "2");
}

#[test]
fn extracts_stored_docx_and_reports_no_text() {
    let stored = docx(
        "<w:document><w:body><w:p><w:r><w:t>Stored</w:t></w:r></w:p></w:body></w:document>",
        false,
    );
    let fields = fields_for(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        &stored,
    );
    assert_eq!(fields["extracted_text"], "Stored");

    let blank = docx(
        "<w:document><w:body><w:p><w:r><w:tab/></w:r></w:p></w:body></w:document>",
        true,
    );
    let fields = fields_for(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        &blank,
    );
    assert_eq!(fields["text_extraction_status"], "no-text");
    assert!(!fields.contains_key("extracted_text"));
}

#[test]
fn rejects_corrupt_docx_checksum() {
    let mut bytes = docx(
        "<w:document><w:body><w:p><w:r><w:t>Integrity</w:t></w:r></w:p></w:body></w:document>",
        false,
    );
    let central = bytes
        .windows(4)
        .position(|window| window == 0x0201_4b50u32.to_le_bytes())
        .unwrap();
    bytes[central + 16] ^= 0xff;
    let mut fields = BTreeMap::new();
    let error = apply_text_extraction(
        &mut fields,
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        &bytes,
    );
    assert!(error.is_err());
}

fn flate_pdf(content: &[u8]) -> Vec<u8> {
    use flate2::write::ZlibEncoder;
    use flate2::Compression;
    use std::io::Write;

    let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(content).ok().unwrap();
    let compressed = encoder.finish().ok().unwrap();
    let mut pdf = b"%PDF-1.4\n1 0 obj\n<< /Type /Page >>\nendobj\n2 0 obj\n<< /Length ".to_vec();
    pdf.extend_from_slice(compressed.len().to_string().as_bytes());
    pdf.extend_from_slice(b" /Filter /FlateDecode >>\nstream\n");
    pdf.extend_from_slice(&compressed);
    pdf.extend_from_slice(b"\nendstream\nendobj\n%%EOF\n");
    pdf
}

#[test]
fn extracts_flate_pdf_text_operators() {
    let content = b"BT /F1 12 Tf 72 720 Td (Hello PDF) Tj 0 -14 Td [(Second ) -200 (line)] TJ ET";
    let fields = fields_for("application/pdf", &flate_pdf(content));
    assert_eq!(fields["text_extraction_status"], "extracted");
    assert_eq!(fields["extracted_text"], "Hello PDF\nSecond line");
    assert_eq!(fields["page_count"], "1");
}

#[test]
fn extracts_literal_and_hex_pdf_strings() {
    let content = b"BT <FEFF00480069> Tj ( literal\\101 ) Tj ET";
    let mut pdf = b"%PDF-1.4\n1 0 obj\n<< /Length ".to_vec();
    pdf.extend_from_slice(content.len().to_string().as_bytes());
    pdf.extend_from_slice(b" >>\nstream\n");
    pdf.extend_from_slice(content);
    pdf.extend_from_slice(b"\nendstream\nendobj\n%%EOF\n");
    let fields = fields_for("application/pdf", &pdf);
    assert_eq!(fields["extracted_text"], "Hi literalA ");
}

#[test]
fn rejects_encrypted_and_image_only_pdf() {
    let encrypted = b"%PDF-1.4\n1 0 obj\n<< /Encrypt 2 0 R >>\nendobj\n%%EOF\n".to_vec();
    let mut fields = BTreeMap::new();
    assert!(apply_text_extraction(&mut fields, "application/pdf", &encrypted).is_err());

    let image_only = b"%PDF-1.4\n1 0 obj\n<< /Type /Page /Resources << /XObject << /Im0 2 0 R >> >> >>\nendobj\n%%EOF\n".to_vec();
    let fields = fields_for("application/pdf", &image_only);
    assert_eq!(fields["text_extraction_status"], "no-text");
    assert_eq!(fields["page_count"], "1");
}

#[test]
fn enforces_document_size_limits() {
    let mut fields = BTreeMap::new();
    apply_text_extraction(
        &mut fields,
        "application/pdf",
        &vec![0u8; DOCUMENT_INPUT_LIMIT + 1],
    )
    .ok()
    .unwrap();
    assert_eq!(fields["text_extraction_status"], "size-limit");
}
