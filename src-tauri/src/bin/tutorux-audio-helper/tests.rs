use crate::capture_io::{application_frame_bytes, write_f32le, write_silence_frames};

#[test]
fn gap_silence_uses_the_native_frame_width() {
    let mut output = Vec::new();
    write_silence_frames(&mut output, 3, application_frame_bytes())
        .expect("silence must be writable");
    assert_eq!(output.len(), 3 * application_frame_bytes());
    assert!(output.iter().all(|byte| *byte == 0));

    let mut mono = Vec::new();
    write_silence_frames(&mut mono, 5, 2).expect("silence must be writable");
    assert_eq!(mono.len(), 10);
}

#[test]
fn application_capture_preserves_stereo_frames() {
    let mut output = Vec::new();
    write_f32le(&mut output, &[0.25, -0.25, 0.5, -0.5]).expect("PCM must be writable");
    assert_eq!(output.len(), 4 * 4);
    assert_eq!(
        output,
        [
            0.25_f32.to_le_bytes(),
            (-0.25_f32).to_le_bytes(),
            0.5_f32.to_le_bytes(),
            (-0.5_f32).to_le_bytes()
        ]
        .concat()
    );
}
