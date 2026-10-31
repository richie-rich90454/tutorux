use super::super::*;
use super::parse_table_rows;

fn zip_archive(files: &[(&str, Vec<u8>)]) -> Vec<u8> {
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
    let mut output = Vec::new();
    let mut central = Vec::new();
    for (name, data) in files {
        let offset = output.len() as u32;
        let crc = crc32(data);
        output.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
        output.extend_from_slice(&20u16.to_le_bytes());
        output.extend_from_slice(&0u16.to_le_bytes());
        output.extend_from_slice(&0u16.to_le_bytes());
        output.extend_from_slice(&0u16.to_le_bytes());
        output.extend_from_slice(&0u16.to_le_bytes());
        output.extend_from_slice(&crc.to_le_bytes());
        output.extend_from_slice(&(data.len() as u32).to_le_bytes());
        output.extend_from_slice(&(data.len() as u32).to_le_bytes());
        output.extend_from_slice(&(name.len() as u16).to_le_bytes());
        output.extend_from_slice(&0u16.to_le_bytes());
        output.extend_from_slice(name.as_bytes());
        output.extend_from_slice(data);
        central.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
        central.extend_from_slice(&20u16.to_le_bytes());
        central.extend_from_slice(&20u16.to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes());
        central.extend_from_slice(&crc.to_le_bytes());
        central.extend_from_slice(&(data.len() as u32).to_le_bytes());
        central.extend_from_slice(&(data.len() as u32).to_le_bytes());
        central.extend_from_slice(&(name.len() as u16).to_le_bytes());
        for _ in 0..4 {
            central.extend_from_slice(&0u16.to_le_bytes());
        }
        central.extend_from_slice(&0u32.to_le_bytes());
        central.extend_from_slice(&offset.to_le_bytes());
        central.extend_from_slice(name.as_bytes());
    }
    let central_offset = output.len() as u32;
    let central_size = central.len() as u32;
    output.extend_from_slice(&central);
    output.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
    output.extend_from_slice(&0u16.to_le_bytes());
    output.extend_from_slice(&0u16.to_le_bytes());
    output.extend_from_slice(&(files.len() as u16).to_le_bytes());
    output.extend_from_slice(&(files.len() as u16).to_le_bytes());
    output.extend_from_slice(&central_size.to_le_bytes());
    output.extend_from_slice(&central_offset.to_le_bytes());
    output.extend_from_slice(&0u16.to_le_bytes());
    output
}

fn escape_xml(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '&' => output.push_str("&amp;"),
            '<' => output.push_str("&lt;"),
            '>' => output.push_str("&gt;"),
            '"' => output.push_str("&quot;"),
            '\'' => output.push_str("&apos;"),
            _ => output.push(character),
        }
    }
    output
}

fn paragraph_xml(text: &str, style: &str, prefix: &str) -> String {
    let joined = format!("{prefix}{text}");
    let runs: Vec<String> = joined
        .split('\n')
        .enumerate()
        .map(|(index, line)| {
            format!(
                "{}{}",
                if index > 0 { "<w:r><w:br/></w:r>" } else { "" },
                if line.is_empty() {
                    String::new()
                } else {
                    format!(
                        "<w:r><w:t xml:space=\"preserve\">{}</w:t></w:r>",
                        escape_xml(line)
                    )
                }
            )
        })
        .collect();
    let style_xml = if style.is_empty() {
        String::new()
    } else {
        format!("<w:pPr><w:pStyle w:val=\"{style}\"/></w:pPr>")
    };
    format!("<w:p>{style_xml}{}</w:p>", runs.join(""))
}

fn table_xml(value: &str) -> CliResult<String> {
    let rows = parse_table_rows(value)?;
    let cells = rows
        .iter()
        .enumerate()
        .map(|(index, row)| {
            format!(
                "<w:tr>{}</w:tr>",
                row.iter()
                    .map(|cell| {
                        let shading = if index == 0 {
                            "<w:shd w:fill=\"E8EEF5\"/>"
                        } else {
                            ""
                        };
                        format!(
                            "<w:tc><w:tcPr>{shading}</w:tcPr>{}</w:tc>",
                            paragraph_xml(&replace_inline_sources(cell), "", "")
                        )
                    })
                    .collect::<Vec<_>>()
                    .join("")
            )
        })
        .collect::<Vec<_>>()
        .join("");
    Ok(format!("<w:tbl><w:tblPr><w:tblW w:w=\"0\" w:type=\"auto\"/><w:tblBorders><w:top w:val=\"single\" w:sz=\"4\" w:color=\"CBD5E1\"/><w:left w:val=\"single\" w:sz=\"4\" w:color=\"CBD5E1\"/><w:bottom w:val=\"single\" w:sz=\"4\" w:color=\"CBD5E1\"/><w:right w:val=\"single\" w:sz=\"4\" w:color=\"CBD5E1\"/><w:insideH w:val=\"single\" w:sz=\"4\" w:color=\"CBD5E1\"/><w:insideV w:val=\"single\" w:sz=\"4\" w:color=\"CBD5E1\"/></w:tblBorders></w:tblPr>{cells}</w:tbl>"))
}

fn image_extension(mime: &str) -> CliResult<&'static str> {
    match mime {
        "image/png" => Ok("png"),
        "image/jpeg" | "image/jpg" => Ok("jpeg"),
        "image/gif" => Ok("gif"),
        "image/webp" => Ok("webp"),
        _ => Err(CliError(
            "Only PNG, JPEG, GIF, and WebP guide images can be exported to Word.".to_owned(),
        )
        .into()),
    }
}

fn image_mime(extension: &str) -> CliResult<&'static str> {
    match extension {
        "png" => Ok("image/png"),
        "jpeg" => Ok("image/jpeg"),
        "gif" => Ok("image/gif"),
        "webp" => Ok("image/webp"),
        _ => Err(CliError("Unsupported image type in the guide.".to_owned()).into()),
    }
}

fn image_dimensions(mime: &str, bytes: &[u8]) -> CliResult<(u32, u32)> {
    let byte = |index: usize| bytes.get(index).copied().unwrap_or(0) as u32;
    let big32 = |offset: usize| {
        (byte(offset) << 24) | (byte(offset + 1) << 16) | (byte(offset + 2) << 8) | byte(offset + 3)
    };
    let little16 = |offset: usize| byte(offset) | (byte(offset + 1) << 8);
    let dimensions = if mime == "image/png"
        && bytes.len() >= 24
        && byte(0) == 0x89
        && byte(1) == 0x50
        && byte(2) == 0x4e
        && byte(3) == 0x47
    {
        Some((big32(16), big32(20)))
    } else if matches!(mime, "image/jpeg" | "image/jpg") && byte(0) == 0xff && byte(1) == 0xd8 {
        jpeg_dimensions(bytes)
    } else if mime == "image/gif"
        && bytes.len() >= 10
        && byte(0) == 0x47
        && byte(1) == 0x49
        && byte(2) == 0x46
    {
        Some((little16(6), little16(8)))
    } else if mime == "image/webp"
        && bytes.len() >= 25
        && byte(0) == 0x52
        && byte(8) == 0x57
        && byte(9) == 0x45
        && byte(10) == 0x42
        && byte(11) == 0x50
    {
        if byte(12) == 0x56
            && byte(13) == 0x50
            && byte(14) == 0x38
            && byte(15) == 0x58
            && bytes.len() >= 30
        {
            Some((
                1 + byte(24) + byte(25) * 256 + byte(26) * 65_536,
                1 + byte(27) + byte(28) * 256 + byte(29) * 65_536,
            ))
        } else if byte(12) == 0x56
            && byte(13) == 0x50
            && byte(14) == 0x38
            && byte(15) == 0x4c
            && byte(20) == 0x2f
        {
            let bits = byte(21) | (byte(22) << 8) | (byte(23) << 16) | (byte(24) << 24);
            Some((1 + (bits & 0x3fff), 1 + ((bits >> 14) & 0x3fff)))
        } else if byte(12) == 0x56
            && byte(13) == 0x50
            && byte(14) == 0x38
            && byte(15) == 0x20
            && bytes.len() >= 30
        {
            Some((
                (byte(26) | (byte(27) << 8)) & 0x3fff,
                (byte(28) | (byte(29) << 8)) & 0x3fff,
            ))
        } else {
            None
        }
    } else {
        None
    };
    match dimensions {
        Some((width, height)) if width > 0 && height > 0 => Ok((width, height)),
        _ => Err(CliError("The dimensions of a guide image could not be read.".to_owned()).into()),
    }
}

fn jpeg_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    let mut offset = 2usize;
    while offset + 4 <= bytes.len() {
        if bytes[offset] != 0xff {
            offset += 1;
            continue;
        }
        while bytes.get(offset) == Some(&0xff) {
            offset += 1;
        }
        let marker = *bytes.get(offset)? as usize;
        offset += 1;
        if marker == 0xd8 || marker == 0xd9 || marker == 0x01 || (0xd0..=0xd7).contains(&marker) {
            continue;
        }
        if offset + 2 > bytes.len() {
            break;
        }
        let length = ((bytes[offset] as usize) << 8) | bytes[offset + 1] as usize;
        if length < 2 || length > bytes.len() - offset {
            break;
        }
        if matches!(
            marker,
            0xc0 | 0xc1
                | 0xc2
                | 0xc3
                | 0xc5
                | 0xc6
                | 0xc7
                | 0xc9
                | 0xca
                | 0xcb
                | 0xcd
                | 0xce
                | 0xcf
        ) && length >= 7
        {
            return Some((
                (((bytes[offset + 5] as u32) << 8) | bytes[offset + 6] as u32),
                (((bytes[offset + 3] as u32) << 8) | bytes[offset + 4] as u32),
            ));
        }
        offset += length;
    }
    None
}

fn image_drawing_xml(
    image: &GuideExportImage,
    alternative: &str,
    relationship: &str,
    drawing: usize,
) -> CliResult<String> {
    const MAX_WIDTH_EMU: f64 = 4_572_000.0;
    const MAX_HEIGHT_EMU: f64 = 5_486_400.0;
    const EMU_PER_PIXEL: f64 = 9_525.0;
    let (width, height) = image_dimensions(&image.mime_type, &image.bytes)?;
    let scale = 1.0f64
        .min(MAX_WIDTH_EMU / (width as f64 * EMU_PER_PIXEL))
        .min(MAX_HEIGHT_EMU / (height as f64 * EMU_PER_PIXEL));
    let width_emu = (width as f64 * EMU_PER_PIXEL * scale).round().max(1.0) as u64;
    let height_emu = (height as f64 * EMU_PER_PIXEL * scale).round().max(1.0) as u64;
    let id = drawing.to_string();
    let alt = escape_xml(alternative);
    Ok(format!("<w:p><w:r><w:drawing><wp:inline distT=\"0\" distB=\"0\" distL=\"0\" distR=\"0\"><wp:extent cx=\"{width_emu}\" cy=\"{height_emu}\"/><wp:docPr id=\"{id}\" name=\"Tutorux image {id}\" descr=\"{alt}\"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect=\"1\"/></wp:cNvGraphicFramePr><a:graphic><a:graphicData uri=\"http://schemas.openxmlformats.org/drawingml/2006/picture\"><pic:pic><pic:nvPicPr><pic:cNvPr id=\"{id}\" name=\"Tutorux image {id}\"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed=\"{relationship}\"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x=\"0\" y=\"0\"/><a:ext cx=\"{width_emu}\" cy=\"{height_emu}\"/></a:xfrm><a:prstGeom prst=\"rect\"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>"))
}

pub(crate) fn render_guide_docx(
    record: &ArchiveRecord,
    images: &BTreeMap<String, GuideExportImage>,
) -> CliResult<Vec<u8>> {
    let draft = guide_draft(record);
    if draft.title.trim().is_empty() {
        return Err(CliError("Cannot export a guide without a title.".to_owned()).into());
    }
    let mut paragraphs = vec![
        paragraph_xml(&draft.title, "Title", ""),
        paragraph_xml(
            &format!(
                "Tutorux study guide · {} template · {}",
                draft.template_id,
                record.field("approval_state").unwrap_or("draft")
            ),
            "Subtitle",
            "",
        ),
    ];
    let mut relationships = Vec::new();
    let mut media: Vec<(String, Vec<u8>)> = Vec::new();
    let mut image_defaults = BTreeSet::new();
    let mut next_relationship = 2usize;
    let mut next_drawing = 1usize;
    for section in &draft.sections {
        paragraphs.push(paragraph_xml(&section.heading, "Heading1", ""));
        for block in &section.blocks {
            if block.stale {
                paragraphs.push(paragraph_xml(
                    "Source changed — review this block.",
                    "Warning",
                    "",
                ));
            }
            let label = guide_block_label(&block.kind, &block.origin);
            let is_image =
                block.kind == "image" || block.kind == "figure" || block.text.starts_with("![");
            if is_image {
                let Some((asset_id, alternative)) = parse_guide_image_reference(&block.text) else {
                    return Err(CliError(
                        "A guide image must point to one archive asset UUID.".to_owned(),
                    )
                    .into());
                };
                if !label.is_empty() {
                    paragraphs.push(paragraph_xml(&label, "Source", ""));
                }
                let Some(image) = images.get(&asset_id) else {
                    return Err(CliError(format!(
                        "Guide image {asset_id} is missing from this archive."
                    ))
                    .into());
                };
                let extension = image_extension(&image.mime_type)?;
                let file_name = format!("{asset_id}.{extension}");
                let relationship = format!("rId{next_relationship}");
                next_relationship += 1;
                relationships.push(format!("<Relationship Id=\"{relationship}\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/image\" Target=\"media/{file_name}\"/>"));
                let media_name = format!("word/media/{file_name}");
                if !media.iter().any(|(name, _)| name == &media_name) {
                    media.push((media_name, image.bytes.clone()));
                }
                image_defaults.insert(extension.to_owned());
                paragraphs.push(image_drawing_xml(
                    image,
                    &alternative,
                    &relationship,
                    next_drawing,
                )?);
                next_drawing += 1;
                if !alternative.is_empty() {
                    paragraphs.push(paragraph_xml(&alternative, "Caption", ""));
                }
                if !block.source_ids.is_empty() {
                    paragraphs.push(paragraph_xml(
                        &format!("Source: {}", block.source_ids.join(", ")),
                        "Source",
                        "",
                    ));
                }
                continue;
            }
            if block.kind == "table" {
                if !label.is_empty() {
                    paragraphs.push(paragraph_xml(&label, "Source", ""));
                }
                paragraphs.push(table_xml(&block.text)?);
                if !block.source_ids.is_empty() {
                    paragraphs.push(paragraph_xml(
                        &format!("Source: {}", block.source_ids.join(", ")),
                        "Source",
                        "",
                    ));
                }
                continue;
            }
            let style = match block.kind.as_str() {
                "quote" => "Quote",
                "code" | "equation" => "Code",
                _ => "",
            };
            let prefix = if !label.is_empty() {
                format!("{label}: ")
            } else if block.kind == "list-item" {
                "• ".to_owned()
            } else {
                String::new()
            };
            paragraphs.push(paragraph_xml(
                &replace_inline_sources(&block.text),
                style,
                &prefix,
            ));
            if !block.source_ids.is_empty() {
                paragraphs.push(paragraph_xml(
                    &format!("Source: {}", block.source_ids.join(", ")),
                    "Source",
                    "",
                ));
            }
        }
    }

    let defaults = image_defaults
        .iter()
        .map(|extension| {
            Ok(format!(
                "<Default Extension=\"{extension}\" ContentType=\"{}\"/>",
                image_mime(extension)?
            ))
        })
        .collect::<CliResult<Vec<_>>>()?
        .join("");
    let document_xml = format!("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\" xmlns:wp=\"http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing\" xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\" xmlns:pic=\"http://schemas.openxmlformats.org/drawingml/2006/picture\"><w:body>{}<w:sectPr><w:pgSz w:w=\"12240\" w:h=\"15840\"/><w:pgMar w:top=\"1440\" w:right=\"1440\" w:bottom=\"1440\" w:left=\"1440\" w:header=\"720\" w:footer=\"720\" w:gutter=\"0\"/></w:sectPr></w:body></w:document>", paragraphs.join(""));
    let document_relationships = format!("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles\" Target=\"styles.xml\"/>{}</Relationships>", relationships.join(""));
    let content_types = format!("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/><Default Extension=\"xml\" ContentType=\"application/xml\"/>{defaults}<Override PartName=\"/word/document.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml\"/><Override PartName=\"/word/styles.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml\"/><Override PartName=\"/docProps/core.xml\" ContentType=\"application/vnd.openxmlformats-package.core-properties+xml\"/></Types>");
    let root_relationships = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"word/document.xml\"/><Relationship Id=\"rId2\" Type=\"http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties\" Target=\"docProps/core.xml\"/></Relationships>";
    let core = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><cp:coreProperties xmlns:cp=\"http://schemas.openxmlformats.org/package/2006/metadata/core-properties\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\"><dc:creator>Tutorux</dc:creator><cp:lastModifiedBy>Tutorux</cp:lastModifiedBy></cp:coreProperties>";
    let styles = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><w:styles xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"><w:style w:type=\"paragraph\" w:default=\"1\" w:styleId=\"Normal\"><w:name w:val=\"Normal\"/><w:rPr><w:rFonts w:ascii=\"Aptos\" w:hAnsi=\"Aptos\"/><w:sz w:val=\"22\"/></w:rPr></w:style><w:style w:type=\"paragraph\" w:styleId=\"Title\"><w:name w:val=\"Title\"/><w:basedOn w:val=\"Normal\"/><w:pPr><w:keepNext/></w:pPr><w:rPr><w:b/><w:sz w:val=\"40\"/></w:rPr></w:style><w:style w:type=\"paragraph\" w:styleId=\"Subtitle\"><w:name w:val=\"Subtitle\"/><w:basedOn w:val=\"Normal\"/><w:pPr><w:spacing w:after=\"360\"/><w:keepNext/></w:pPr><w:rPr><w:i/><w:color w:val=\"64748B\"/><w:sz w:val=\"20\"/></w:rPr></w:style><w:style w:type=\"paragraph\" w:styleId=\"Heading1\"><w:name w:val=\"heading 1\"/><w:basedOn w:val=\"Normal\"/><w:next w:val=\"Normal\"/><w:pPr><w:spacing w:before=\"420\" w:after=\"180\"/><w:keepNext/></w:pPr><w:rPr><w:b/><w:sz w:val=\"30\"/><w:color w:val=\"315B4A\"/></w:rPr></w:style><w:style w:type=\"paragraph\" w:styleId=\"Quote\"><w:name w:val=\"Quote\"/><w:basedOn w:val=\"Normal\"/><w:pPr><w:ind w:left=\"480\"/><w:spacing w:before=\"120\" w:after=\"120\"/></w:pPr><w:rPr><w:i/><w:color w:val=\"475569\"/></w:rPr></w:style><w:style w:type=\"paragraph\" w:styleId=\"Code\"><w:name w:val=\"Code\"/><w:basedOn w:val=\"Normal\"/><w:rPr><w:rFonts w:ascii=\"Consolas\" w:hAnsi=\"Consolas\"/><w:sz w:val=\"20\"/></w:rPr></w:style><w:style w:type=\"paragraph\" w:styleId=\"Source\"><w:name w:val=\"Source\"/><w:basedOn w:val=\"Normal\"/><w:rPr><w:i/><w:color w:val=\"64748B\"/><w:sz w:val=\"18\"/></w:rPr></w:style><w:style w:type=\"paragraph\" w:styleId=\"Warning\"><w:name w:val=\"Review warning\"/><w:basedOn w:val=\"Normal\"/><w:rPr><w:b/><w:color w:val=\"9B6E2F\"/><w:sz w:val=\"18\"/></w:rPr></w:style><w:style w:type=\"paragraph\" w:styleId=\"Caption\"><w:name w:val=\"Caption\"/><w:basedOn w:val=\"Normal\"/><w:rPr><w:i/><w:color w:val=\"647267\"/><w:sz w:val=\"18\"/></w:rPr></w:style></w:styles>";
    let mut files: Vec<(&str, Vec<u8>)> = vec![
        ("[Content_Types].xml", content_types.into_bytes()),
        ("_rels/.rels", root_relationships.as_bytes().to_vec()),
        ("word/document.xml", document_xml.into_bytes()),
        ("word/styles.xml", styles.as_bytes().to_vec()),
        (
            "word/_rels/document.xml.rels",
            document_relationships.into_bytes(),
        ),
        ("docProps/core.xml", core.as_bytes().to_vec()),
    ];
    for (name, bytes) in media {
        files.push((&*Box::leak(name.into_boxed_str()), bytes));
    }
    Ok(zip_archive(&files))
}
