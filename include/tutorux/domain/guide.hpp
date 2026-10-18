#pragma once

#include "tutorux/archive/archive.hpp"

#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace tutorux::domain {

struct GuideBlock final {
    GuideBlock() = default;
    GuideBlock(std::string blockKind, std::string blockText, std::vector<std::string> sources,
               bool isStale = false, std::string blockOrigin = "tutor-authored")
        : kind(std::move(blockKind))
        , text(std::move(blockText))
        , sourceIds(std::move(sources))
        , stale(isStale)
        , origin(std::move(blockOrigin)) {}

    std::string kind;
    std::string text;
    std::vector<std::string> sourceIds;
    bool stale{};
    // Describes who authored the guide wording, independently of its cited source records.
    std::string origin{"tutor-authored"};
};

struct GuideSection final {
    std::string id;
    std::string heading;
    std::vector<GuideBlock> blocks;
};

struct GuideDocument final {
    archive::Uuid id{};
    std::string entryId;
    std::string sessionId;
    std::string title;
    std::string templateId{"general"};
    std::string approvalState{"draft"};
    std::vector<GuideSection> sections;
};

using GuideTable = std::vector<std::vector<std::string>>;

struct GuideImageReference final {
    std::string alternativeText;
    std::string assetId;
};

archive::Record toRecord(const GuideDocument& guide);
tutorux::core::Result<GuideDocument> guideFromRecord(const archive::Record& record);
std::string_view guideBlockLabel(std::string_view kind) noexcept;
std::string guideBlockLabel(const GuideBlock& block);
core::Result<GuideTable> parseGuideTable(std::string_view text);
core::Result<GuideImageReference> parseGuideImageReference(std::string_view text);
core::Result<std::vector<std::string>> guideInlineSourceIds(std::string_view text);
std::string renderGuideInlineText(std::string_view text);
std::string renderGuideMarkdown(const GuideDocument& guide);
tutorux::core::Status validateGuide(const GuideDocument& guide, const archive::Archive& archive,
                                    bool requireFreshSources = true);

} // namespace tutorux::domain
