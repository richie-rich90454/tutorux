#include "tutorux/domain/guide.hpp"

#include "tutorux/domain/entities.hpp"

#include <charconv>
#include <sstream>

namespace tutorux::domain {
namespace {

    std::string indexedKey(std::size_t section, std::string_view suffix) {
        return "section." + std::to_string(section) + "." + std::string(suffix);
    }

    std::string blockKey(std::size_t section, std::size_t block, std::string_view suffix) {
        return indexedKey(section, "block." + std::to_string(block) + "." + std::string(suffix));
    }

    std::string encodeSourceIds(const std::vector<std::string>& ids) {
        std::string output;
        for (const auto& id : ids) {
            if (!output.empty())
                output.push_back(',');
            output += id;
        }
        return output;
    }

    std::vector<std::string> decodeSourceIds(std::string_view value) {
        std::vector<std::string> ids;
        std::size_t start = 0;
        while (start < value.size()) {
            const auto comma = value.find(',', start);
            const auto end = comma == std::string_view::npos ? value.size() : comma;
            if (end > start)
                ids.emplace_back(value.substr(start, end - start));
            if (comma == std::string_view::npos)
                break;
            start = comma + 1;
        }
        return ids;
    }

    tutorux::core::Result<std::size_t> parseCount(const archive::Record& record,
                                                  std::string_view key) {
        const auto found = record.fields.find(key);
        if (found == record.fields.end()) {
            return std::unexpected(
                tutorux::core::error("guide_invalid",
                                     "Guide is missing '" + std::string(key) + "'."));
        }
        std::size_t value = 0;
        const auto [end, errorCode] = std::from_chars(found->second.data(),
                                                      found->second.data() + found->second.size(),
                                                      value);
        if (errorCode != std::errc{} || end != found->second.data() + found->second.size() ||
            value > 10000) {
            return std::unexpected(
                tutorux::core::error("guide_invalid", "Guide count field is invalid."));
        }
        return value;
    }

} // namespace

archive::Record toRecord(const GuideDocument& guide) {
    archive::Record record;
    record.type = archive::RecordType::Guide;
    record.id = guide.id;
    record.fields = {
        {"session_id",     guide.sessionId                      },
        {"title",          guide.title                          },
        {"template_id",    guide.templateId                     },
        {"approval_state", guide.approvalState                  },
        {"section_count",  std::to_string(guide.sections.size())}
    };
    std::size_t staleBlockCount = 0;
    for (std::size_t sectionIndex = 0; sectionIndex < guide.sections.size(); ++sectionIndex) {
        const auto& section = guide.sections[sectionIndex];
        record.fields[indexedKey(sectionIndex, "id")] = section.id;
        record.fields[indexedKey(sectionIndex, "heading")] = section.heading;
        record.fields[indexedKey(sectionIndex, "block_count")] =
            std::to_string(section.blocks.size());
        for (std::size_t blockIndex = 0; blockIndex < section.blocks.size(); ++blockIndex) {
            const auto& block = section.blocks[blockIndex];
            record.fields[blockKey(sectionIndex, blockIndex, "kind")] = block.kind;
            record.fields[blockKey(sectionIndex, blockIndex, "text")] = block.text;
            record.fields[blockKey(sectionIndex, blockIndex, "source_ids")] =
                encodeSourceIds(block.sourceIds);
            record.fields[blockKey(sectionIndex, blockIndex, "stale")] =
                block.stale ? "true" : "false";
            if (block.stale)
                ++staleBlockCount;
        }
    }
    record.fields["stale_block_count"] = std::to_string(staleBlockCount);
    return record;
}

tutorux::core::Result<GuideDocument> guideFromRecord(const archive::Record& record) {
    if (record.type != archive::RecordType::Guide) {
        return std::unexpected(tutorux::core::error("guide_invalid", "Record is not a guide."));
    }
    auto sectionCount = parseCount(record, "section_count");
    if (!sectionCount)
        return std::unexpected(sectionCount.error());
    GuideDocument guide;
    guide.id = record.id;
    guide.sessionId = getField(record, "session_id");
    guide.title = getField(record, "title");
    guide.templateId = getField(record, "template_id", "general");
    guide.approvalState = getField(record, "approval_state", "draft");
    guide.sections.reserve(*sectionCount);
    for (std::size_t sectionIndex = 0; sectionIndex < *sectionCount; ++sectionIndex) {
        GuideSection section;
        section.id = getField(record, indexedKey(sectionIndex, "id"));
        section.heading = getField(record, indexedKey(sectionIndex, "heading"));
        auto blockCount = parseCount(record, indexedKey(sectionIndex, "block_count"));
        if (!blockCount)
            return std::unexpected(blockCount.error());
        section.blocks.reserve(*blockCount);
        for (std::size_t blockIndex = 0; blockIndex < *blockCount; ++blockIndex) {
            GuideBlock block;
            block.kind = getField(record, blockKey(sectionIndex, blockIndex, "kind"));
            block.text = getField(record, blockKey(sectionIndex, blockIndex, "text"));
            block.sourceIds =
                decodeSourceIds(getField(record, blockKey(sectionIndex, blockIndex, "source_ids")));
            block.stale = getField(record, blockKey(sectionIndex, blockIndex, "stale")) == "true";
            section.blocks.push_back(std::move(block));
        }
        guide.sections.push_back(std::move(section));
    }
    return guide;
}

std::string_view guideBlockLabel(std::string_view kind) noexcept {
    if (kind == "instruction")
        return "Tutor instruction";
    if (kind == "recommendation")
        return "AI recommendation";
    if (kind == "worked-example")
        return "Worked example";
    return {};
}

std::string renderGuideMarkdown(const GuideDocument& guide) {
    std::ostringstream output;
    output << "# " << guide.title << "\n\n";
    output << "_Tutorux study guide · " << guide.templateId << " template · " << guide.approvalState
           << "_\n\n";
    for (const auto& section : guide.sections) {
        output << "## " << section.heading << "\n\n";
        for (const auto& block : section.blocks) {
            if (block.kind == "list-item")
                output << "- ";
            else if (block.kind == "quote")
                output << "> ";
            if (block.stale)
                output << "**Source changed — review this block.** ";
            const auto label = guideBlockLabel(block.kind);
            if (!label.empty())
                output << "**" << label << ":** ";
            output << block.text;
            if (!block.sourceIds.empty()) {
                output << "  \n_Source: ";
                for (std::size_t index = 0; index < block.sourceIds.size(); ++index) {
                    if (index != 0)
                        output << ", ";
                    output << "`" << block.sourceIds[index] << "`";
                }
                output << "_";
            }
            output << "\n\n";
        }
    }
    return output.str();
}

tutorux::core::Status validateGuide(const GuideDocument& guide,
                                    const archive::Archive& archive,
                                    bool requireFreshSources) {
    if (guide.title.empty()) {
        return std::unexpected(
            tutorux::core::error("guide_title_required", "Guide title is required."));
    }
    if (guide.sessionId.empty()) {
        return std::unexpected(
            tutorux::core::error("guide_session_required", "Guide must reference a session."));
    }
    if (guide.approvalState != "draft" && guide.approvalState != "proposed" &&
        guide.approvalState != "approved") {
        return std::unexpected(
            tutorux::core::error("guide_approval_state_invalid",
                                 "Guide approval state must be draft, proposed, or approved."));
    }
    auto sessionId = archive::uuidFromString(guide.sessionId);
    if (!sessionId)
        return std::unexpected(sessionId.error());
    auto session = archive.get(archive::RecordType::Session, *sessionId);
    if (!session)
        return std::unexpected(session.error());
    if (!*session || isDeleted(**session)) {
        return std::unexpected(tutorux::core::error("guide_session_missing",
                                                    "Guide session reference does not resolve."));
    }
    const std::string sessionStudentId = getField(**session, "student_id");
    const auto sessionStudentUuid = archive::uuidFromString(sessionStudentId);
    for (const auto& section : guide.sections) {
        if (section.heading.empty()) {
            return std::unexpected(tutorux::core::error("guide_section_invalid",
                                                        "Every guide section needs a heading."));
        }
        for (const auto& block : section.blocks) {
            if (requireFreshSources && block.stale) {
                return std::unexpected(tutorux::core::error(
                    "guide_sources_stale",
                    "Guide content in section '" + section.heading +
                        "' cites changed source material. Review or regenerate the affected "
                        "block before validation, approval, or export."));
            }
            if (block.kind.empty()) {
                return std::unexpected(
                    tutorux::core::error("guide_block_invalid", "Guide block kind is required."));
            }
            for (const auto& sourceId : block.sourceIds) {
                auto id = archive::uuidFromString(sourceId);
                if (!id)
                    return std::unexpected(id.error());
                bool found = false;
                for (const auto type : {archive::RecordType::TranscriptSegment,
                                        archive::RecordType::Annotation,
                                        archive::RecordType::EvidenceNode,
                                        archive::RecordType::AssetMetadata,
                                        archive::RecordType::Session,
                                        archive::RecordType::Student}) {
                    auto source = archive.get(type, *id);
                    if (!source)
                        return std::unexpected(source.error());
                    if (!*source || isDeleted(**source))
                        continue;

                    const archive::Record& sourceRecord = **source;
                    const std::string sourceSessionId = getField(sourceRecord, "session_id");
                    if (type == archive::RecordType::Session)
                        found = sourceRecord.id == *sessionId;
                    else if (type == archive::RecordType::Student)
                        found = sessionStudentUuid && sourceRecord.id == *sessionStudentUuid;
                    else if (type == archive::RecordType::AssetMetadata)
                        found = sourceSessionId == guide.sessionId ||
                                (!sessionStudentId.empty() && sessionStudentId != "anonymous" &&
                                 getField(sourceRecord, "student_id") == sessionStudentId);
                    else
                        found = sourceSessionId == guide.sessionId;
                    if (found)
                        break;
                }
                if (!found) {
                    return std::unexpected(
                        tutorux::core::error("guide_source_missing",
                                             "Guide source '" + sourceId +
                                                 "' does not resolve to a live archive record."));
                }
            }
        }
    }
    return {};
}

} // namespace tutorux::domain
