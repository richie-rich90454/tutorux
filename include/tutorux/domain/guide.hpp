#pragma once

#include "tutorux/archive/archive.hpp"

#include <string>
#include <string_view>
#include <vector>

namespace tutorux::domain {

    struct GuideBlock final {
        std::string kind;
        std::string text;
        std::vector<std::string> sourceIds;
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
                                        const archive::Archive& archive);

} // namespace tutorux::domain
