#pragma once

#include <string>
#include <string_view>
#include <vector>

namespace tutorux::intelligence {

struct TranscriptEvidenceCandidate final {
    std::string type;
    std::string title;
    std::string detectionMethod;
    double confidence{};
};

// Returns review-only candidates supported by literal transcript cues. This classifier does not
// infer speaker identity or treat a detected cue as a verified educational claim.
std::vector<TranscriptEvidenceCandidate> classifyTranscriptEvidence(std::string_view text);

} // namespace tutorux::intelligence
