use std::{path::Path, path::PathBuf, sync::OnceLock};

use ocrs::{ImageSource, OcrEngine, OcrEngineParams};
use pdfium_render::prelude::{PdfRenderConfig, Pdfium, PdfiumError};
use rten::Model;

const DETECTION_MODEL: &[u8] = include_bytes!("../resources/ocr/text-detection.onnx");
const RECOGNITION_MODEL: &[u8] = include_bytes!("../resources/ocr/text-recognition.onnx");
const MAX_EDGE: u32 = 3200;
const MAX_PDF_PAGES: usize = 100;
const PDF_EMBEDDED_TEXT_MIN: usize = 40;

#[cfg(target_os = "windows")]
const PDFIUM_LIBRARY: &[u8] = include_bytes!("../resources/pdfium/pdfium.dll");
#[cfg(target_os = "macos")]
const PDFIUM_LIBRARY: &[u8] = include_bytes!("../resources/pdfium/libpdfium.dylib");
#[cfg(target_os = "linux")]
const PDFIUM_LIBRARY: &[u8] = include_bytes!("../resources/pdfium/libpdfium.so");

fn engine() -> Result<&'static OcrEngine, String> {
    static ENGINE: OnceLock<OcrEngine> = OnceLock::new();
    if let Some(engine) = ENGINE.get() {
        return Ok(engine);
    }
    let detection = Model::load_static_slice(DETECTION_MODEL)
        .map_err(|error| format!("Could not load the OCR detection model: {error}"))?;
    let recognition = Model::load_static_slice(RECOGNITION_MODEL)
        .map_err(|error| format!("Could not load the OCR recognition model: {error}"))?;
    let created = OcrEngine::new(OcrEngineParams {
        detection_model: Some(detection),
        recognition_model: Some(recognition),
        ..Default::default()
    })
    .map_err(|error| format!("Could not start the OCR engine: {error}"))?;
    let _ = ENGINE.set(created);
    ENGINE
        .get()
        .ok_or_else(|| "The OCR engine is unavailable.".to_owned())
}

pub fn recognize_image(bytes: &[u8]) -> Result<String, String> {
    let image = image::load_from_memory(bytes)
        .map_err(|error| format!("The image could not be decoded for OCR: {error}"))?;
    recognize_dynamic_image(image)
}

fn recognize_dynamic_image(image: image::DynamicImage) -> Result<String, String> {
    let image = if image.width() > MAX_EDGE || image.height() > MAX_EDGE {
        image.thumbnail(MAX_EDGE, MAX_EDGE)
    } else {
        image
    };
    let rgb = image.into_rgb8();
    let source = ImageSource::from_bytes(rgb.as_raw(), rgb.dimensions())
        .map_err(|error| format!("The image could not be prepared for OCR: {error}"))?;
    let engine = engine()?;
    let input = engine
        .prepare_input(source)
        .map_err(|error| format!("The OCR input could not be prepared: {error}"))?;
    let text = engine
        .get_text(&input)
        .map_err(|error| format!("OCR could not read the image: {error}"))?;
    Ok(text.trim().to_owned())
}

pub fn pdfium_library(directory: &Path) -> std::path::PathBuf {
    Pdfium::pdfium_platform_library_name_at_path(directory)
}

fn embedded_pdfium_directory() -> Result<PathBuf, String> {
    let directory =
        std::env::temp_dir().join(format!("tutorux-pdfium-8125-{}", env!("CARGO_PKG_VERSION")));
    std::fs::create_dir_all(&directory)
        .map_err(|error| format!("The PDF engine folder could not be created: {error}"))?;
    let path = Pdfium::pdfium_platform_library_name_at_path(&directory);
    let needs_write = std::fs::metadata(&path)
        .map(|metadata| metadata.len() as usize != PDFIUM_LIBRARY.len())
        .unwrap_or(true);
    if needs_write {
        std::fs::write(&path, PDFIUM_LIBRARY)
            .map_err(|error| format!("The PDF engine could not be unpacked: {error}"))?;
    }
    Ok(directory)
}

fn pdfium(library_directory: Option<&Path>) -> Result<Pdfium, String> {
    if let Ok(directory) = embedded_pdfium_directory() {
        let path = Pdfium::pdfium_platform_library_name_at_path(&directory);
        match Pdfium::bind_to_library(path) {
            Ok(bindings) => return Ok(Pdfium::new(bindings)),
            Err(PdfiumError::PdfiumLibraryBindingsAlreadyInitialized) => {
                return Ok(Pdfium::default());
            }
            Err(_) => {}
        }
    }
    if let Some(directory) = library_directory {
        let path = Pdfium::pdfium_platform_library_name_at_path(directory);
        match Pdfium::bind_to_library(path) {
            Ok(bindings) => return Ok(Pdfium::new(bindings)),
            Err(PdfiumError::PdfiumLibraryBindingsAlreadyInitialized) => {
                return Ok(Pdfium::default());
            }
            Err(_) => {}
        }
    }
    match Pdfium::bind_to_system_library() {
        Ok(bindings) => Ok(Pdfium::new(bindings)),
        Err(PdfiumError::PdfiumLibraryBindingsAlreadyInitialized) => Ok(Pdfium::default()),
        Err(error) => Err(format!("The PDF engine could not be loaded: {error}")),
    }
}

pub fn recognize_pdf(bytes: &[u8], library_directory: Option<&Path>) -> Result<String, String> {
    let pdfium = pdfium(library_directory)?;
    let document = pdfium
        .load_pdf_from_byte_slice(bytes, None)
        .map_err(|error| format!("The PDF could not be opened: {error}"))?;
    let pages = document.pages();
    let page_count = pages.len() as usize;
    if page_count == 0 {
        return Err("The PDF has no pages.".to_owned());
    }
    if page_count > MAX_PDF_PAGES {
        return Err(format!(
            "This PDF has {page_count} pages. OCR is limited to {MAX_PDF_PAGES} pages at a time."
        ));
    }
    let render = PdfRenderConfig::new()
        .set_target_width(2000)
        .set_maximum_height(2800);
    let mut output = String::new();
    for (index, page) in pages.iter().enumerate() {
        let embedded = page
            .text()
            .map(|text| text.all())
            .unwrap_or_default()
            .trim()
            .to_owned();
        let text = if embedded.chars().count() >= PDF_EMBEDDED_TEXT_MIN {
            embedded
        } else {
            page.render_with_config(&render)
                .map_err(|error| format!("Page {} could not be rendered: {error}", index + 1))?
                .as_image()
                .map_err(|error| format!("Page {} could not be converted: {error}", index + 1))
                .and_then(recognize_dynamic_image)?
        };
        if !text.is_empty() {
            if !output.is_empty() {
                output.push_str("\n\n");
            }
            output.push_str(&text);
        }
    }
    if output.trim().is_empty() {
        return Err("No text was found in this PDF.".to_owned());
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    #[test]
    fn blank_images_are_valid_ocr_input() {
        let image = image::RgbImage::from_pixel(64, 64, image::Rgb([255, 255, 255]));
        let mut bytes = Vec::new();
        image::DynamicImage::ImageRgb8(image)
            .write_to(
                &mut std::io::Cursor::new(&mut bytes),
                image::ImageFormat::Png,
            )
            .unwrap();
        let text = super::recognize_image(&bytes).unwrap();
        assert!(text.is_empty() || text.chars().all(|character| character.is_whitespace()));
    }

    #[test]
    fn reads_printed_text() {
        let text =
            super::recognize_image(include_bytes!("../tests/fixtures/ocr-sample.png")).unwrap();
        assert!(
            text.to_uppercase().contains("FRACTION"),
            "OCR returned {text:?}"
        );
    }

    #[test]
    #[ignore = "requires a PDFium runtime and TUTORUX_PDF_FIXTURE pointing at a scanned PDF"]
    fn reads_a_scanned_pdf_fixture() {
        let path =
            std::env::var("TUTORUX_PDF_FIXTURE").expect("Set TUTORUX_PDF_FIXTURE to a scanned PDF");
        let bytes = std::fs::read(&path).expect("read PDF fixture");
        let directory = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("pdfium");
        let text = super::recognize_pdf(&bytes, Some(&directory)).expect("PDF OCR");
        assert!(
            text.to_uppercase().contains("FRACTION"),
            "OCR returned {text:?}"
        );
    }

    #[test]
    fn unpacks_the_embedded_pdfium_runtime() {
        let directory = super::embedded_pdfium_directory().expect("embedded PDFium");
        assert!(super::pdfium_library(&directory).exists());
    }

    #[test]
    fn renders_and_reads_a_pdf_page_when_pdfium_is_present() {
        let directory = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("pdfium");
        let library = directory.join(if cfg!(windows) {
            "pdfium.dll"
        } else if cfg!(target_os = "macos") {
            "libpdfium.dylib"
        } else {
            "libpdfium.so"
        });
        if !library.exists() {
            return;
        }
        let text = super::recognize_pdf(&text_pdf(), Some(&directory)).expect("PDF OCR");
        assert!(
            text.to_uppercase().contains("FRACTION"),
            "OCR returned {text:?}"
        );
    }

    fn text_pdf() -> Vec<u8> {
        let content = b"BT /F1 64 Tf 72 500 Td (FRACTIONS) Tj ET";
        let objects = [
            b"<< /Type /Catalog /Pages 2 0 R >>".to_vec(),
            b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_vec(),
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>".to_vec(),
            {
                let mut stream = format!("<< /Length {} >>\nstream\n", content.len()).into_bytes();
                stream.extend_from_slice(content);
                stream.extend_from_slice(b"\nendstream");
                stream
            },
            b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_vec(),
        ];
        let mut pdf = b"%PDF-1.4\n".to_vec();
        let mut offsets = Vec::new();
        for (index, object) in objects.iter().enumerate() {
            offsets.push(pdf.len());
            pdf.extend_from_slice(format!("{} 0 obj\n", index + 1).as_bytes());
            pdf.extend_from_slice(object);
            pdf.extend_from_slice(b"\nendobj\n");
        }
        let xref = pdf.len();
        pdf.extend_from_slice(format!("xref\n0 {}\n", objects.len() + 1).as_bytes());
        pdf.extend_from_slice(b"0000000000 65535 f \n");
        for offset in &offsets {
            pdf.extend_from_slice(format!("{offset:010} 00000 n \n").as_bytes());
        }
        pdf.extend_from_slice(
            format!(
                "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n",
                objects.len() + 1
            )
            .as_bytes(),
        );
        pdf
    }
}
