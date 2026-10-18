#pragma once

#include "tutorux/archive/archive.hpp"

#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace tutorux::domain {

struct GuideBlock final {
    GuideBlock() = default;
    GuideBlock(std::string blockKind,
               std::string blockText,
               std::vector<std::string> sources,
               bool isStale = false)
        : kind(std::move(blockKind))
        , text(std::move(blockText))
        , sourceIds(std::move(sources))
        , stale(isStale) {}

    std::string kind;
    std::string text;
    std::vector<std::string> sourceIds;
    bool stale{};
};

struct GuideSection final {
    std::string id;
    std::string heading;
    std::vector<GuideBlock> blocks;
};

struct GuideDocument final {
    archive::Uuid id{};
    std::string sessionId;
    std::string title;
    std::string templateId{"general"};
    std::string approvalState{"draft"};
    std::vector<GuideSection> sections;
};

archive::Record toRecord(const GuideDocument& guide);
tutorux::core::Result<GuideDocument> guideFromRecord(const archive::Record& record);
std::string_view guideBlockLabel(std::string_view kind) noexcept;
std::string renderGuideMarkdown(const GuideDocument& guide);
tutorux::core::Status validateGuide(const GuideDocument& guide,
                                    const archive::Archive& archive,
                                    bool requireFreshSources = true);

} // namespace tutorux::domain
