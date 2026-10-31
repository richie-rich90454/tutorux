use super::capture::{encode_f32, encode_i16, DiscontinuityTracker};
use cpal::StreamInstant;
use std::time::Duration;

fn instant(milliseconds: u64) -> StreamInstant {
    StreamInstant::ZERO
        .checked_add(Duration::from_millis(milliseconds))
        .expect("test timestamps fit the stream clock")
}

#[test]
fn discontinuity_tracker_marks_a_missing_callback_and_keeps_the_timeline() {
    let mut tracker = DiscontinuityTracker::new(48_000);
    assert_eq!(tracker.observe(instant(0), 480, 0), Some((0, false)));
    assert_eq!(tracker.observe(instant(10), 480, 0), Some((0, false)));
    assert_eq!(tracker.observe(instant(30), 480, 0), Some((480, true)));
    assert_eq!(tracker.observe(instant(40), 480, 0), Some((0, false)));
}

#[test]
fn discontinuity_tracker_resets_after_a_resume_epoch() {
    let mut tracker = DiscontinuityTracker::new(48_000);
    assert_eq!(tracker.observe(instant(0), 480, 0), Some((0, false)));
    assert_eq!(tracker.observe(instant(2_000), 480, 1), Some((0, false)));
    assert_eq!(tracker.observe(instant(2_010), 480, 1), Some((0, false)));
}

#[test]
fn discontinuity_tracker_rejects_a_gap_beyond_the_recovery_window() {
    let mut tracker = DiscontinuityTracker::new(48_000);
    assert_eq!(tracker.observe(instant(0), 480, 0), Some((0, false)));
    assert_eq!(tracker.observe(instant(11_000), 480, 0), None);
}

#[test]
fn pcm_encoders_keep_every_interleaved_channel() {
    assert_eq!(
        encode_i16(&[1, -1, 2, -2]),
        vec![1, 0, 255, 255, 2, 0, 254, 255]
    );
    let stereo = encode_f32(&[0.5, -0.5]);
    assert_eq!(stereo.len(), 8);
    assert_eq!(f32::from_le_bytes(stereo[0..4].try_into().unwrap()), 0.5);
    assert_eq!(f32::from_le_bytes(stereo[4..8].try_into().unwrap()), -0.5);
}
