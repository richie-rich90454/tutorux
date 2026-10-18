#include "tutorux/intelligence/evidence_extract.hpp"

#include <algorithm>
#include <array>
#include <cctype>
#include <span>

namespace tutorux::intelligence {
namespace {

    struct CueGroup final {
        std::string_view type;
        std::string_view title;
        std::string_view method;
        double confidence;
        std::span<const std::string_view> cues;
    };

    constexpr std::array instructionCues{
        std::string_view{"remember to"},  std::string_view{"make sure"}, std::string_view{"you should"},    std::string_view{"you need to"},
        std::string_view{"don't forget"}, std::string_view{"next time"}, std::string_view{"practice this"}, std::string_view{"try to"},
    };
    constexpr std::array conceptCues{
        std::string_view{"means "},      std::string_view{"is defined as"},  std::string_view{"is called"},
        std::string_view{"the idea is"}, std::string_view{"the concept of"}, std::string_view{"in other words"},
    };
    constexpr std::array explanationCues{
        std::string_view{"because "}, std::string_view{"this works"},  std::string_view{"the reason is"},
        std::string_view{"so that"},  std::string_view{"which means"},
    };
    constexpr std::array correctionCues{
        std::string_view{"not quite"}, std::string_view{"actually,"},      std::string_view{"instead of"}, std::string_view{"the correct"},
        std::string_view{"should be"}, std::string_view{"that should be"}, std::string_view{"you meant"},
    };
    constexpr std::array mistakeCues{
        std::string_view{"i thought"}, std::string_view{"i assumed"},  std::string_view{"i confused"},
        std::string_view{"i forgot"},  std::string_view{"my mistake"}, std::string_view{"i mixed up"},
    };
    constexpr std::array exampleCues{
        std::string_view{"for example"}, std::string_view{"let's solve"}, std::string_view{"suppose "},
        std::string_view{"consider "},   std::string_view{"an example"},
    };
    constexpr std::array learningCues{
        std::string_view{"now i understand"}, std::string_view{"i see now"},        std::string_view{"i learned"},
        std::string_view{"i can now"},        std::string_view{"that makes sense"},
    };
    constexpr std::array followUpCues{
        std::string_view{"next session"}, std::string_view{"for next time"}, std::string_view{"practice this"},
        std::string_view{"review this"},  std::string_view{"homework"},      std::string_view{"before next"},
    };

    std::string lowerAscii(std::string_view text) {
        std::string lowered(text);
        std::transform(lowered.begin(), lowered.end(), lowered.begin(), [](unsigned char character) {
            return static_cast<char>(std::tolower(character));
        });
        return lowered;
    }

    bool hasAnyCue(std::string_view text, std::span<const std::string_view> cues) {
        return std::any_of(cues.begin(), cues.end(), [text](std::string_view cue) {
            return text.find(cue) != std::string_view::npos;
        });
    }

} // namespace

std::vector<TranscriptEvidenceCandidate> classifyTranscriptEvidence(std::string_view text) {
    const auto normalized = lowerAscii(text);
    if (normalized.empty())
        return {};

    const std::array groups{
        CueGroup{"explicit-instruction-candidate", "Possible spoken tutor instruction", "instruction-phrase-heuristic",        0.72,
                 instructionCues                                                                                                                    },
        CueGroup{"important-concept-candidate",    "Possible concept or definition",    "concept-phrase-heuristic",            0.58, conceptCues    },
        CueGroup{"explanation-candidate",          "Possible explanation",              "explanation-phrase-heuristic",        0.54, explanationCues},
        CueGroup{"tutor-correction-candidate",     "Possible correction",               "correction-phrase-heuristic",         0.62, correctionCues },
        CueGroup{"student-mistake-candidate",      "Possible learner misconception",    "first-person-error-phrase-heuristic", 0.56, mistakeCues    },
        CueGroup{"worked-example-candidate",       "Possible worked example",           "example-phrase-heuristic",            0.62, exampleCues    },
        CueGroup{"learning-outcome-candidate",     "Possible learning outcome",         "learning-outcome-phrase-heuristic",   0.62, learningCues   },
        CueGroup{"follow-up-priority-candidate",   "Possible follow-up priority",       "follow-up-phrase-heuristic",          0.65, followUpCues   },
    };

    std::vector<TranscriptEvidenceCandidate> candidates;
    for (const auto& group : groups) {
        if (hasAnyCue(normalized, group.cues))
            candidates.push_back({std::string(group.type), std::string(group.title), std::string(group.method), group.confidence});
    }
    if (normalized.find('?') != std::string::npos) {
        candidates.push_back({"student-question-candidate", "Possible question", "question-mark-heuristic", 0.5});
    }
    return candidates;
}

} // namespace tutorux::intelligence
