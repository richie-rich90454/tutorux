use super::super::*;
use super::GuideExportImage;

#[path = "guide_pdf_image.rs"]
mod guide_pdf_image;
use guide_pdf_image::{encode_image, PdfImage};

const PAGE_WIDTH: i32 = 612;
const PAGE_HEIGHT: i32 = 792;
const MARGIN: i32 = 54;
const BOTTOM: i32 = 60;
const CONTENT_WIDTH: f64 = 504.0;
const IMAGE_HEIGHT_LIMIT: f64 = 600.0;

fn win_ansi(character: char) -> Option<u8> {
    let code = character as u32;
    let mapped = match code {
        0x20..=0x7e => Some(code as u8),
        0xa0..=0xff => Some(code as u8),
        0x20ac => Some(0x80),
        0x201a => Some(0x82),
        0x0192 => Some(0x83),
        0x201e => Some(0x84),
        0x2026 => Some(0x85),
        0x2020 => Some(0x86),
        0x2021 => Some(0x87),
        0x02c6 => Some(0x88),
        0x2030 => Some(0x89),
        0x0160 => Some(0x8a),
        0x2039 => Some(0x8b),
        0x0152 => Some(0x8c),
        0x017d => Some(0x8e),
        0x2018 => Some(0x91),
        0x2019 => Some(0x92),
        0x201c => Some(0x93),
        0x201d => Some(0x94),
        0x2022 => Some(0x95),
        0x2013 => Some(0x96),
        0x2014 => Some(0x97),
        0x02dc => Some(0x98),
        0x2122 => Some(0x99),
        0x0161 => Some(0x9a),
        0x203a => Some(0x9b),
        0x0153 => Some(0x9c),
        0x017e => Some(0x9e),
        0x0178 => Some(0x9f),
        _ => None,
    };
    mapped
}

fn literal_string(text: &str) -> Option<Vec<u8>> {
    let mut output = vec![b'('];
    for character in text.chars() {
        if character == '\t' {
            output.push(b' ');
            continue;
        }
        let byte = win_ansi(character)?;
        if matches!(byte, b'(' | b')' | b'\\') {
            output.push(b'\\');
        }
        output.push(byte);
    }
    output.push(b')');
    Some(output)
}

fn utf16_hex(text: &str) -> Vec<u8> {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut output = Vec::with_capacity(text.len() * 2 + 2);
    output.push(b'<');
    for unit in text.encode_utf16() {
        output.push(HEX[((unit >> 12) & 0xf) as usize]);
        output.push(HEX[((unit >> 8) & 0xf) as usize]);
        output.push(HEX[((unit >> 4) & 0xf) as usize]);
        output.push(HEX[(unit & 0xf) as usize]);
    }
    output.push(b'>');
    output
}

fn wrap_pdf_text(text: &str, width: usize) -> Vec<String> {
    let mut lines = Vec::new();
    for source_line in text.split('\n') {
        let mut current = String::new();
        for word in source_line.split_whitespace() {
            let candidate = if current.is_empty() {
                word.to_owned()
            } else {
                format!("{current} {word}")
            };
            if candidate.chars().count() > width && !current.is_empty() {
                lines.push(current);
                current = word.to_owned();
            } else {
                current = candidate;
            }
        }
        if !current.is_empty() || source_line.is_empty() {
            lines.push(current);
        }
    }
    lines
}

fn num(value: f64) -> String {
    let rounded = (value * 1000.0).round() / 1000.0;
    if rounded.fract() == 0.0 {
        return format!("{rounded:.0}");
    }
    let mut text = format!("{rounded:.3}");
    while text.ends_with('0') {
        text.pop();
    }
    text
}

#[derive(Default)]
struct PdfPage {
    content: Vec<u8>,
    images: Vec<usize>,
}

struct PdfBuilder {
    pages: Vec<PdfPage>,
    y: i32,
}

impl PdfBuilder {
    fn new() -> Self {
        Self {
            pages: vec![PdfPage::default()],
            y: PAGE_HEIGHT - MARGIN,
        }
    }

    fn next_page(&mut self) {
        self.pages.push(PdfPage::default());
        self.y = PAGE_HEIGHT - MARGIN;
    }

    fn ensure(&mut self, height: i32) {
        if self.y - height < BOTTOM {
            self.next_page();
        }
    }

    fn text(&mut self, value: &str, size: i32, spacing: i32) {
        let width = (CONTENT_WIDTH / (size as f64 * 0.55)).max(8.0) as usize;
        for line in wrap_pdf_text(value, width) {
            self.ensure(spacing.max(size));
            self.emit_line(&line, size);
            self.y -= spacing;
        }
    }

    fn emit_line(&mut self, line: &str, size: i32) {
        let (font, encoded) = match literal_string(line) {
            Some(bytes) => ("/F1", bytes),
            None => ("/F2", utf16_hex(line)),
        };
        let mut operators = format!("BT {font} {size} Tf {MARGIN} {} Td ", self.y).into_bytes();
        operators.extend_from_slice(&encoded);
        operators.extend_from_slice(b" Tj ET\n");
        if let Some(page) = self.pages.last_mut() {
            page.content.extend_from_slice(&operators);
        }
    }

    fn gap(&mut self, points: i32) {
        self.y -= points;
        if self.y < BOTTOM {
            self.next_page();
        }
    }

    fn image(&mut self, image: &PdfImage, index: usize) {
        let scale = (CONTENT_WIDTH / (image.width as f64 * 0.75))
            .min(IMAGE_HEIGHT_LIMIT / (image.height as f64 * 0.75))
            .min(1.0);
        let width = (image.width as f64 * 0.75 * scale).max(1.0);
        let height = (image.height as f64 * 0.75 * scale).max(1.0);
        self.ensure(height.ceil() as i32 + 8);
        self.y -= height.ceil() as i32;
        let operator = format!(
            "q {} 0 0 {} {MARGIN} {} cm /Im{index} Do Q\n",
            num(width),
            num(height),
            self.y
        );
        if let Some(page) = self.pages.last_mut() {
            page.content.extend_from_slice(operator.as_bytes());
            page.images.push(index);
        }
        self.y -= 8;
    }
}

fn stream_object(dictionary: &[u8], data: &[u8]) -> Vec<u8> {
    let mut output = b"<< ".to_vec();
    output.extend_from_slice(dictionary);
    output.extend_from_slice(format!(" /Length {} >>\nstream\n", data.len()).as_bytes());
    output.extend_from_slice(data);
    output.extend_from_slice(b"\nendstream");
    output
}

fn to_unicode_cmap() -> &'static [u8] {
    b"/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n\
/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n\
/CMapName /TutoruxIdentity def\n/CMapType 2 def\n1 begincodespacerange\n\
<0000> <FFFF>\nendcodespacerange\n1 beginbfrange\n<0000> <FFFF> <0000>\n\
endbfrange\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n"
}

fn serialize_guide_pdf(pages: &[PdfPage], images: &[PdfImage], title: &str) -> Vec<u8> {
    let first_page = 7usize;
    let first_image = first_page + pages.len() * 2;
    let mut image_ids = Vec::with_capacity(images.len());
    let mut next_image = first_image;
    for image in images {
        image_ids.push(next_image);
        next_image += if image.alpha.is_some() { 2 } else { 1 };
    }
    let info_id = next_image;
    let mut objects: Vec<Vec<u8>> = Vec::with_capacity(info_id - 1);
    objects.push(b"<< /Type /Catalog /Pages 2 0 R >>".to_vec());
    let kids: Vec<String> = (0..pages.len())
        .map(|index| format!("{} 0 R", first_page + index * 2))
        .collect();
    objects.push(
        format!(
            "<< /Type /Pages /Kids [{}] /Count {} >>",
            kids.join(" "),
            pages.len()
        )
        .into_bytes(),
    );
    objects.push(
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"
            .to_vec(),
    );
    objects.push(
        b"<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [5 0 R] /ToUnicode 6 0 R >>"
            .to_vec(),
    );
    objects.push(
        b"<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> >>"
            .to_vec(),
    );
    objects.push(stream_object(b"", to_unicode_cmap()));

    for (index, page) in pages.iter().enumerate() {
        let content_id = first_page + index * 2 + 1;
        let mut resources = "/Font << /F1 3 0 R /F2 4 0 R >>".to_owned();
        if !page.images.is_empty() {
            resources.push_str(" /XObject <<");
            for image_index in &page.images {
                resources.push_str(&format!(
                    " /Im{image_index} {} 0 R",
                    image_ids[*image_index]
                ));
            }
            resources.push_str(" >>");
        }
        objects.push(
            format!(
                "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {PAGE_WIDTH} {PAGE_HEIGHT}] /Resources << {resources} >> /Contents {content_id} 0 R >>"
            )
            .into_bytes(),
        );
        objects.push(stream_object(b"", &page.content));
    }

    for (index, image) in images.iter().enumerate() {
        let mut dictionary = format!(
            "/Type /XObject /Subtype /Image /Width {} /Height {} /ColorSpace {} /BitsPerComponent 8 /Filter {}",
            image.width, image.height, image.color_space, image.filter
        );
        if image.alpha.is_some() {
            dictionary.push_str(&format!(" /SMask {} 0 R", image_ids[index] + 1));
        }
        objects.push(stream_object(dictionary.as_bytes(), &image.bytes));
        if let Some(alpha) = &image.alpha {
            let alpha_dictionary = format!(
                "/Type /XObject /Subtype /Image /Width {} /Height {} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode",
                image.width, image.height
            );
            objects.push(stream_object(alpha_dictionary.as_bytes(), alpha));
        }
    }
    let title_hex = format!("FEFF{}", hex_units(title));
    let subject_hex = format!("FEFF{}", hex_units("Session-linked teaching guide"));
    objects.push(
        format!("<< /Title <{title_hex}> /Creator (Tutorux) /Subject <{subject_hex}> >>")
            .into_bytes(),
    );

    debug_assert_eq!(objects.len(), info_id);
    let mut output = b"%PDF-1.4\n%\xE2\xE3\xCF\xD3\n".to_vec();
    let mut offsets = Vec::with_capacity(objects.len());
    for (index, object) in objects.iter().enumerate() {
        offsets.push(output.len());
        output.extend_from_slice(format!("{} 0 obj\n", index + 1).as_bytes());
        output.extend_from_slice(object);
        output.extend_from_slice(b"\nendobj\n");
    }
    let xref = output.len();
    output.extend_from_slice(
        format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1).as_bytes(),
    );
    for offset in offsets {
        output.extend_from_slice(format!("{offset:010} 00000 n \n").as_bytes());
    }
    output.extend_from_slice(
        format!(
            "trailer\n<< /Size {} /Root 1 0 R /Info {info_id} 0 R >>\nstartxref\n{xref}\n%%EOF\n",
            objects.len() + 1
        )
        .as_bytes(),
    );
    output
}

fn hex_units(text: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut output = String::with_capacity(text.len() * 4);
    for unit in text.encode_utf16() {
        output.push(HEX[((unit >> 12) & 0xf) as usize] as char);
        output.push(HEX[((unit >> 8) & 0xf) as usize] as char);
        output.push(HEX[((unit >> 4) & 0xf) as usize] as char);
        output.push(HEX[(unit & 0xf) as usize] as char);
    }
    output
}

fn render_guide_body(
    draft: &GuideDraft,
    record: &ArchiveRecord,
    images: &BTreeMap<String, GuideExportImage>,
) -> CliResult<(Vec<PdfPage>, Vec<PdfImage>)> {
    let mut builder = PdfBuilder::new();
    builder.text(&draft.title, 18, 26);
    builder.text(
        &format!(
            "Tutorux study guide - {} template - {}",
            draft.template_id,
            record.field("approval_state").unwrap_or("draft")
        ),
        9,
        20,
    );
    builder.gap(10);
    let mut embedded: Vec<PdfImage> = Vec::new();
    for section in &draft.sections {
        builder.text(&section.heading, 13, 20);
        for block in &section.blocks {
            if block.stale {
                builder.text("Source changed - review this block.", 9, 14);
            }
            let is_image =
                block.kind == "image" || block.kind == "figure" || block.text.starts_with("![");
            if is_image {
                let Some((asset_id, alternative)) = parse_guide_image_reference(&block.text) else {
                    return Err(CliError(
                        "A guide image must point to one archive asset UUID.".to_owned(),
                    )
                    .into());
                };
                let Some(image) = images.get(&asset_id) else {
                    return Err(CliError(format!(
                        "Guide image {asset_id} is missing from this archive."
                    ))
                    .into());
                };
                match encode_image(&image.mime_type, &image.bytes)? {
                    Some(encoded) => {
                        let index = embedded.len();
                        embedded.push(encoded);
                        builder.image(&embedded[index], index);
                        if !alternative.is_empty() {
                            builder.text(&alternative, 8, 12);
                        }
                    }
                    None => {
                        let label = if alternative.is_empty() {
                            String::new()
                        } else {
                            format!(" {alternative}")
                        };
                        builder.text(
                            &format!("[Image {}{label}]", &asset_id[..asset_id.len().min(8)]),
                            10,
                            13,
                        );
                    }
                }
                if !block.source_ids.is_empty() {
                    builder.text(&format!("Source: {}", block.source_ids.join(", ")), 8, 11);
                }
                continue;
            }
            let text = replace_inline_sources(&block.text);
            builder.text(&text, 10, 13);
            if !block.source_ids.is_empty() {
                builder.text(&format!("Source: {}", block.source_ids.join(", ")), 8, 11);
            }
        }
        builder.gap(6);
    }
    Ok((builder.pages, embedded))
}

#[cfg(test)]
pub(crate) fn render_guide_pdf(record: &ArchiveRecord) -> CliResult<Vec<u8>> {
    render_guide_pdf_with_images(record, &BTreeMap::new())
}

pub(crate) fn render_guide_pdf_with_images(
    record: &ArchiveRecord,
    images: &BTreeMap<String, GuideExportImage>,
) -> CliResult<Vec<u8>> {
    let draft = guide_draft(record);
    if draft.title.trim().is_empty() {
        return Err(CliError("Cannot export a guide without a title.".to_owned()).into());
    }
    let (pages, embedded) = render_guide_body(&draft, record, images)?;
    Ok(serialize_guide_pdf(&pages, &embedded, &draft.title))
}

#[cfg(test)]
#[path = "guide_pdf_tests.rs"]
mod tests;
