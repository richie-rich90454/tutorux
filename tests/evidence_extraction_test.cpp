#include "tutorux/intelligence/evidence_extract.hpp"

#include <algorithm>
#include <iostream>
#include <string_view>

namespace {

bool hasType(const std::vector<tutorux::intelligence::TranscriptEvidenceCandidate>& candidates, std::string_view type) {
    return std::any_of(candidates.begin(), candidates.end(), [type](const auto& candidate) {
        return candidate.type == type;
    });
}

} // namespace

int main() {
    using tutorux::intelligence::classifyTranscriptEvidence;

    const auto lesson =
        classifyTranscriptEvidence("Remember to check the denominator. The correct method works because the fractions have equal parts. "
                                   "For example, let's solve 1/2 + 1/4. What if the denominators differ?");
    if (!hasType(lesson, "explicit-instruction-candidate") || !hasType(lesson, "tutor-correction-candidate") ||
        !hasType(lesson, "explanation-candidate") || !hasType(lesson, "worked-example-candidate") ||
        !hasType(lesson, "student-question-candidate")) {
        std::cerr << "Expected source-supported teaching-event candidates were not classified.\n";
        return 1;
    }

    const auto learner = classifyTranscriptEvidence("I thought the denominator was added. Now I understand.");
    if (!hasType(learner, "student-mistake-candidate") || !hasType(learner, "learning-outcome-candidate")) {
        std::cerr << "Expected learner reflection candidates were not classified.\n";
        return 1;
    }

    const auto empty = classifyTranscriptEvidence("   ");
    if (!empty.empty()) {
        std::cerr << "Empty transcript text must not create evidence candidates.\n";
        return 1;
    }

    for (const auto& candidate : lesson) {
        if (candidate.confidence <= 0.0 || candidate.confidence >= 1.0 || candidate.detectionMethod.empty()) {
            std::cerr << "Heuristic output must be provisional and disclose its detection method.\n";
            return 1;
        }
    }
    return 0;
}
