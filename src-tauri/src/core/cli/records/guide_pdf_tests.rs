use super::super::render_guide_docx;
use super::*;
use std::io::Write;

const ASSET_ID: &str = "00000000-0000-0000-0000-0000000000aa";

fn crc32(bytes: &[u8]) -> u32 {
    let mut crc = 0xffff_ffffu32;
    for byte in bytes {
        crc ^= *byte as u32;
        for _ in 0..8 {
            crc = if crc & 1 != 0 {
                (crc >> 1) ^ 0xedb8_8320
            } else {
                crc >> 1
            };
        }
    }
    !crc
}

fn png_chunk(kind: &[u8], data: &[u8]) -> Vec<u8> {
    let mut output = (data.len() as u32).to_be_bytes().to_vec();
    output.extend_from_slice(kind);
    output.extend_from_slice(data);
    let mut crc_input = kind.to_vec();
    crc_input.extend_from_slice(data);
    output.extend_from_slice(&crc32(&crc_input).to_be_bytes());
    output
}

fn png(width: u32, height: u32) -> Vec<u8> {
    let mut raw = Vec::new();
    for row in 0..height {
        raw.push(0);
        for column in 0..width {
            raw.extend_from_slice(&[(column * 60) as u8, (row * 90) as u8, 0x40, 0xff]);
        }
    }
    let mut encoder = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
    encoder.write_all(&raw).ok().unwrap();
    let compressed = encoder.finish().ok().unwrap();
    let mut header = width.to_be_bytes().to_vec();
    header.extend_from_slice(&height.to_be_bytes());
    header.extend_from_slice(&[8, 6, 0, 0, 0]);
    let mut output = vec![0x89, b'P', b'N', b'G', b'\r', b'\n', 0x1a, b'\n'];
    output.extend_from_slice(&png_chunk(b"IHDR", &header));
    output.extend_from_slice(&png_chunk(b"IDAT", &compressed));
    output.extend_from_slice(&png_chunk(b"IEND", &[]));
    output
}

fn jpeg(width: u16, height: u16) -> Vec<u8> {
    let mut output = vec![0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10];
    output.extend_from_slice(b"JFIF\0");
    output.extend_from_slice(&[1, 1, 0, 0, 1, 0, 1, 0, 0]);
    output.extend_from_slice(&[0xff, 0xc0, 0x00, 0x11, 0x08]);
    output.extend_from_slice(&height.to_be_bytes());
    output.extend_from_slice(&width.to_be_bytes());
    output.extend_from_slice(&[3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
    output.extend_from_slice(&[0xff, 0xd9]);
    output
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack
        .windows(needle.len())
        .any(|window| window == needle)
}

fn guide(title: &str, blocks: &[(&str, String)]) -> ArchiveRecord {
    let mut fields = vec![
        ("title".to_owned(), title.to_owned()),
        ("template_id".to_owned(), "general".to_owned()),
        ("approval_state".to_owned(), "draft".to_owned()),
        ("section_count".to_owned(), "1".to_owned()),
        ("section.0.id".to_owned(), "s1".to_owned()),
        ("section.0.heading".to_owned(), "Overview".to_owned()),
        ("section.0.block_count".to_owned(), blocks.len().to_string()),
    ];
    for (index, (kind, text)) in blocks.iter().enumerate() {
        fields.push((format!("section.0.block.{index}.kind"), (*kind).to_owned()));
        fields.push((format!("section.0.block.{index}.text"), text.clone()));
        fields.push((format!("section.0.block.{index}.source_ids"), String::new()));
        fields.push((format!("section.0.block.{index}.stale"), "false".to_owned()));
        fields.push((
            format!("section.0.block.{index}.origin"),
            "tutor-authored".to_owned(),
        ));
    }
    ArchiveRecord::new(
        RecordType::GUIDE,
        "00000000-0000-0000-0000-000000000010",
        fields,
    )
}

fn image_map(mime: &str, bytes: Vec<u8>) -> BTreeMap<String, GuideExportImage> {
    let mut images = BTreeMap::new();
    images.insert(
        ASSET_ID.to_owned(),
        GuideExportImage {
            mime_type: mime.to_owned(),
            bytes,
        },
    );
    images
}

fn xref_offsets(pdf: &[u8]) -> Vec<usize> {
    let start = pdf
        .windows(b"startxref".len())
        .rposition(|window| window == b"startxref")
        .unwrap();
    let digits: Vec<u8> = pdf[start + 9..]
        .iter()
        .copied()
        .skip_while(|byte| !byte.is_ascii_digit())
        .take_while(|byte| byte.is_ascii_digit())
        .collect();
    let xref = std::str::from_utf8(&digits)
        .ok()
        .unwrap()
        .parse::<usize>()
        .ok()
        .unwrap();
    assert!(pdf[xref..].starts_with(b"xref\n0 "));
    let rest = &pdf[xref + 7..];
    let newline = rest.iter().position(|byte| *byte == b'\n').unwrap();
    let size = std::str::from_utf8(&rest[..newline])
        .ok()
        .unwrap()
        .parse::<usize>()
        .ok()
        .unwrap();
    let mut cursor = xref + 7 + newline + 1 + 20;
    let mut offsets = Vec::new();
    for _ in 1..size {
        let entry = &pdf[cursor..cursor + 20];
        assert_eq!(&entry[10..], b" 00000 n \n");
        offsets.push(
            std::str::from_utf8(&entry[..10])
                .ok()
                .unwrap()
                .parse::<usize>()
                .ok()
                .unwrap(),
        );
        cursor += 20;
    }
    offsets
}

fn page_count(pdf: &[u8]) -> usize {
    let marker = b"/Type /Pages /Kids [";
    let start = pdf
        .windows(marker.len())
        .position(|window| window == marker)
        .unwrap();
    let rest = &pdf[start..];
    let count = rest
        .windows(b"/Count ".len())
        .position(|window| window == b"/Count ")
        .unwrap();
    let digits: Vec<u8> = rest[count + 7..]
        .iter()
        .copied()
        .take_while(|byte| byte.is_ascii_digit())
        .collect();
    std::str::from_utf8(&digits)
        .ok()
        .unwrap()
        .parse()
        .ok()
        .unwrap()
}

#[test]
fn embeds_png_as_flate_xobject_and_keeps_structure_valid() {
    let record = guide(
        "Export guide",
        &[("image", format!("![Diagram](asset:{ASSET_ID})"))],
    );
    let assets = image_map("image/png", png(4, 3));
    let pdf = render_guide_pdf_with_images(&record, &assets).ok().unwrap();
    assert!(pdf.starts_with(b"%PDF-"));
    assert!(pdf.ends_with(b"%%EOF\n"));
    assert!(contains(&pdf, b"/Subtype /Image"));
    assert!(contains(&pdf, b"/ColorSpace /DeviceRGB"));
    assert!(contains(&pdf, b"/SMask"));
    assert!(contains(&pdf, b"/Im0 Do"));
    assert!(contains(&pdf, b"/Subtype /Type0"));
    assert!(contains(&pdf, b"/ToUnicode"));
    assert!(contains(&pdf, b"Overview"));
    let offsets = xref_offsets(&pdf);
    for (index, offset) in offsets.iter().enumerate() {
        let expected = format!("{} 0 obj\n", index + 1);
        assert!(pdf[*offset..].starts_with(expected.as_bytes()));
    }
    assert_eq!(page_count(&pdf), 1);
}

#[test]
fn embeds_jpeg_with_dct_filter_and_correct_dimensions() {
    let record = guide("JPEG", &[("image", format!("![Photo](asset:{ASSET_ID})"))]);
    let assets = image_map("image/jpeg", jpeg(3, 2));
    let pdf = render_guide_pdf_with_images(&record, &assets).ok().unwrap();
    assert!(contains(&pdf, b"/Filter /DCTDecode"));
    assert!(contains(&pdf, b"/Width 3 /Height 2"));
    assert!(!contains(&pdf, b"/SMask"));
}

#[test]
fn encodes_latin1_literals_and_utf16_type0_strings() {
    let record = guide("Café – 日本語", &[("paragraph", "Café résumé".to_owned())]);
    let pdf = render_guide_pdf_with_images(&record, &BTreeMap::new())
        .ok()
        .unwrap();
    assert!(contains(&pdf, b"Caf\xe9 r\xe9sum\xe9"));
    let hex = "65E5672C8A9E";
    assert!(contains(&pdf, hex.as_bytes()));
    assert!(!contains(&pdf, "Café – 日本語".as_bytes()));
}

#[test]
fn paginates_long_guides_and_keeps_xref_aligned() {
    let blocks: Vec<(&str, String)> = (0..120)
        .map(|index| {
            (
                "paragraph",
                format!(
                    "Paragraph {index} explains worked examples with detailed reasoning for the student."
                ),
            )
        })
        .collect();
    let record = guide("Long guide", &blocks);
    let pdf = render_guide_pdf_with_images(&record, &BTreeMap::new())
        .ok()
        .unwrap();
    assert!(page_count(&pdf) > 1);
    let offsets = xref_offsets(&pdf);
    for (index, offset) in offsets.iter().enumerate() {
        let expected = format!("{} 0 obj\n", index + 1);
        assert!(pdf[*offset..].starts_with(expected.as_bytes()));
    }
    assert!(!contains(&pdf, b"/Im0 Do"));
}

#[test]
fn exported_pdf_text_round_trips_through_the_document_extractor() {
    use crate::core::cli::records::apply_text_extraction;
    let record = guide(
        "Rundbrief",
        &[
            ("paragraph", "Café résumé".to_owned()),
            ("paragraph", "日本語の本文".to_owned()),
        ],
    );
    let pdf = render_guide_pdf_with_images(&record, &BTreeMap::new())
        .ok()
        .unwrap();
    let mut fields = BTreeMap::new();
    apply_text_extraction(&mut fields, "application/pdf", &pdf)
        .ok()
        .unwrap();
    assert_eq!(fields["text_extraction_status"], "extracted");
    assert_eq!(fields["page_count"], "1");
    let text = &fields["extracted_text"];
    assert!(text.contains("Overview"));
    assert!(text.contains("Café résumé"));
    assert!(text.contains("日本語の本文"));
}

#[test]
fn docx_export_embeds_the_same_image() {
    let record = guide(
        "Word guide",
        &[("image", format!("![Diagram](asset:{ASSET_ID})"))],
    );
    let assets = image_map("image/png", png(2, 2));
    let docx = render_guide_docx(&record, &assets).ok().unwrap();
    assert!(docx.starts_with(b"PK"));
    assert!(contains(&docx, b"word/media/"));
    assert!(contains(&docx, b"<w:drawing>"));
    assert!(contains(&docx, b"relationships/image"));
    assert!(contains(&docx, b"wp:inline"));
}
