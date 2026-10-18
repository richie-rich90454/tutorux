#include "tutorux/domain/guide.hpp"

#include "tutorux/domain/entities.hpp"

#include <algorithm>
#include <array>
#include <charconv>
#include <optional>
#include <set>
#include <sstream>

namespace tutorux::domain {
namespace {

    constexpr std::string_view inlineSourcePrefix = "[[source:";
    constexpr std::string_view inlineSourceSuffix = "]]";

    std::string_view trimTableCell(std::string_view value) {
        while (!value.empty() &&
               (value.front() == ' ' || value.front() == '\t' || value.front() == '\r')) {
            value.remove_prefix(1);
        }
        while (!value.empty() &&
               (value.back() == ' ' || value.back() == '\t' || value.back() == '\r')) {
            value.remove_suffix(1);
        }
        return value;
    }

    std::vector<std::string> parseTableRow(std::string_view line) {
        line = trimTableCell(line);
        if (!line.empty() && line.front() == '|')
            line.remove_prefix(1);
        if (!line.empty() && line.back() == '|')
            line.remove_suffix(1);

        std::vector<std::string> cells;
        std::string cell;
        bool escaped = false;
        for (const char character : line) {
            if (escaped) {
                if (character != '|' && character != '\\')
                    cell.push_back('\\');
                cell.push_back(character);
                escaped = false;
            } else if (character == '\\') {
                escaped = true;
            } else if (character == '|') {
                cells.emplace_back(trimTableCell(cell));
                cell.clear();
            } else {
                cell.push_back(character);
            }
        }
        if (escaped)
            cell.push_back('\\');
        cells.emplace_back(trimTableCell(cell));
        return cells;
    }

    bool isTableSeparatorCell(std::string_view cell) {
        cell = trimTableCell(cell);
        if (!cell.empty() && cell.front() == ':')
            cell.remove_prefix(1);
        if (!cell.empty() && cell.back() == ':')
            cell.remove_suffix(1);
        return cell.size() >= 3 && std::all_of(cell.begin(), cell.end(), [](char character) {
                   return character == '-';
               });
    }

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
            return std::unexpected(tutorux::core::error(
                "guide_invalid", "Guide is missing '" + std::string(key) + "'."));
        }
        std::size_t value = 0;
        const auto [end, errorCode] = std::from_chars(
            found->second.data(), found->second.data() + found->second.size(), value);
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
        {"entry_id",       guide.entryId                        },
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
            record.fields[blockKey(sectionIndex, blockIndex, "origin")] = block.origin;
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
    guide.entryId = getField(record, "entry_id");
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
            block.origin =
                getField(record, blockKey(sectionIndex, blockIndex, "origin"), "unknown");
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

std::string guideBlockLabel(const GuideBlock& block) {
    if (block.origin == "ai-generated") {
        if (block.kind == "recommendation")
            return "AI recommendation";
        if (block.kind == "instruction")
            return "AI-drafted instruction";
        if (block.kind == "example" || block.kind == "worked-example")
            return "AI-generated example";
        const auto semanticLabel = guideBlockLabel(block.kind);
        if (semanticLabel.empty())
            return "AI-generated content";
        return "AI-generated " + std::string(semanticLabel);
    }
    if (block.origin == "human-edited") {
        if (block.kind == "instruction")
            return "Tutor-edited instruction";
        if (block.kind == "recommendation")
            return "Tutor-edited recommendation";
        if (block.kind == "example" || block.kind == "worked-example")
            return "Tutor-edited example";
        return "Tutor-edited content";
    }
    if (block.origin == "uncertain")
        return "Uncertain interpretation";
    if (block.origin == "system-generated")
        return "Tutorux-generated notice";
    if (block.origin == "unknown")
        return "Content with unverified provenance";
    return std::string(guideBlockLabel(block.kind));
}

core::Result<GuideTable> parseGuideTable(std::string_view text) {
    std::vector<std::vector<std::string>> parsedRows;
    std::size_t lineStart = 0;
    while (lineStart <= text.size()) {
        const auto lineEnd = text.find('\n', lineStart);
        const auto end = lineEnd == std::string_view::npos ? text.size() : lineEnd;
        const auto line = trimTableCell(text.substr(lineStart, end - lineStart));
        if (!line.empty())
            parsedRows.push_back(parseTableRow(line));
        if (lineEnd == std::string_view::npos)
            break;
        lineStart = lineEnd + 1U;
    }

    if (parsedRows.size() < 2 || parsedRows.front().empty() ||
        parsedRows.front().size() != parsedRows[1].size() ||
        !std::all_of(parsedRows[1].begin(), parsedRows[1].end(), isTableSeparatorCell)) {
        return std::unexpected(
            core::error("guide_table_invalid",
                        "A table needs a header row and a matching Markdown separator row."));
    }

    const std::size_t columnCount = parsedRows.front().size();
    GuideTable table;
    table.reserve(parsedRows.size() - 1U);
    table.push_back(std::move(parsedRows.front()));
    for (std::size_t rowIndex = 2; rowIndex < parsedRows.size(); ++rowIndex) {
        if (parsedRows[rowIndex].size() != columnCount) {
            return std::unexpected(
                core::error("guide_table_invalid",
                            "Every Markdown table row must have the same number of cells."));
        }
        table.push_back(std::move(parsedRows[rowIndex]));
    }
    return table;
}

core::Result<GuideImageReference> parseGuideImageReference(std::string_view text) {
    if (!text.starts_with("![")) {
        return std::unexpected(core::error(
            "guide_image_invalid", "An image block must contain one Markdown asset reference."));
    }

    std::string alternativeText;
    std::size_t index = 2;
    bool foundAlternativeEnd = false;
    while (index < text.size()) {
        const char character = text[index];
        if (character == '\\') {
            if (index + 1U >= text.size())
                break;
            const char escapedCharacter = text[index + 1U];
            if (escapedCharacter != ']' && escapedCharacter != '\\')
                alternativeText.push_back('\\');
            alternativeText.push_back(escapedCharacter);
            index += 2U;
        } else if (character == ']' && index + 1U < text.size() && text[index + 1U] == '(') {
            index += 2U;
            foundAlternativeEnd = true;
            break;
        } else {
            alternativeText.push_back(character);
            ++index;
        }
    }
    if (!foundAlternativeEnd) {
        return std::unexpected(core::error(
            "guide_image_invalid", "The image reference is missing its closing asset link."));
    }

    constexpr std::string_view assetPrefix = "asset:";
    if (!text.substr(index).starts_with(assetPrefix) || text.size() <= index + assetPrefix.size() ||
        text.back() != ')') {
        return std::unexpected(core::error(
            "guide_image_invalid", "The image reference must point to an archive asset UUID."));
    }
    const std::string_view assetValue =
        text.substr(index + assetPrefix.size(), text.size() - index - assetPrefix.size() - 1U);
    if (assetValue.find_first_of("() \t\r\n") != std::string_view::npos) {
        return std::unexpected(core::error(
            "guide_image_invalid", "The image reference must contain only one asset UUID."));
    }
    auto assetId = archive::uuidFromString(assetValue);
    if (!assetId)
        return std::unexpected(assetId.error());
    return GuideImageReference{std::move(alternativeText), archive::uuidToString(*assetId)};
}

core::Result<std::vector<std::string>> guideInlineSourceIds(std::string_view text) {
    std::vector<std::string> sourceIds;
    std::size_t searchOffset = 0;
    while ((searchOffset = text.find(inlineSourcePrefix, searchOffset)) != std::string_view::npos) {
        const std::size_t idStart = searchOffset + inlineSourcePrefix.size();
        const std::size_t end = text.find(inlineSourceSuffix, idStart);
        if (end == std::string_view::npos) {
            return std::unexpected(
                tutorux::core::error("guide_inline_source_invalid",
                                     "An inline source reference is missing its closing ']]'."));
        }
        auto id = archive::uuidFromString(text.substr(idStart, end - idStart));
        if (!id) {
            return std::unexpected(
                tutorux::core::error("guide_inline_source_invalid",
                                     "An inline source reference must contain a valid UUID."));
        }
        const std::string canonicalId = archive::uuidToString(*id);
        if (std::find(sourceIds.begin(), sourceIds.end(), canonicalId) == sourceIds.end())
            sourceIds.push_back(canonicalId);
        searchOffset = end + inlineSourceSuffix.size();
    }
    return sourceIds;
}

std::string renderGuideInlineText(std::string_view text) {
    std::string output;
    output.reserve(text.size());
    std::size_t cursor = 0;
    while (true) {
        const std::size_t marker = text.find(inlineSourcePrefix, cursor);
        if (marker == std::string_view::npos) {
            output.append(text.substr(cursor));
            break;
        }
        const std::size_t idStart = marker + inlineSourcePrefix.size();
        const std::size_t end = text.find(inlineSourceSuffix, idStart);
        if (end == std::string_view::npos) {
            output.append(text.substr(cursor));
            break;
        }
        output.append(text.substr(cursor, marker - cursor));
        output += "[source: ";
        output.append(text.substr(idStart, end - idStart));
        output.push_back(']');
        cursor = end + inlineSourceSuffix.size();
    }
    return output;
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
            const auto label = guideBlockLabel(block);
            if (!label.empty())
                output << "**" << label << ":** ";
            output << renderGuideInlineText(block.text);
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

tutorux::core::Status validateGuide(const GuideDocument& guide, const archive::Archive& archive,
                                    bool requireFreshSources) {
    if (guide.title.empty()) {
        return std::unexpected(
            tutorux::core::error("guide_title_required", "Guide title is required."));
    }
    if (guide.sessionId.empty() && guide.entryId.empty()) {
        return std::unexpected(tutorux::core::error(
            "guide_scope_required", "Guide must reference a journal entry or session."));
    }
    if (guide.approvalState != "draft" && guide.approvalState != "proposed" &&
        guide.approvalState != "approved") {
        return std::unexpected(
            tutorux::core::error("guide_approval_state_invalid",
                                 "Guide approval state must be draft, proposed, or approved."));
    }
    std::set<std::string, std::less<>> sourceSessionIds;
    std::set<std::string, std::less<>> sourceStudentIds;
    if (!guide.entryId.empty()) {
        auto parsedEntryId = archive::uuidFromString(guide.entryId);
        if (!parsedEntryId)
            return std::unexpected(parsedEntryId.error());
        auto entry = archive.get(archive::RecordType::Settings, *parsedEntryId);
        if (!entry)
            return std::unexpected(entry.error());
        if (!*entry || isDeleted(**entry) || getField(**entry, "record_role") != "journal-entry") {
            return std::unexpected(tutorux::core::error(
                "guide_entry_missing", "Guide journal entry reference does not resolve."));
        }
        auto sessions = archive.list(archive::RecordType::Session);
        if (!sessions)
            return std::unexpected(sessions.error());
        for (const auto& candidate : *sessions) {
            if (isDeleted(candidate) || getField(candidate, "entry_id") != guide.entryId)
                continue;
            if (guide.sessionId.empty()) {
                sourceSessionIds.insert(archive::uuidToString(candidate.id));
                const std::string studentId = getField(candidate, "student_id");
                if (!studentId.empty() && studentId != "anonymous")
                    sourceStudentIds.insert(studentId);
            }
        }
    }

    if (!guide.sessionId.empty()) {
        auto sessionId = archive::uuidFromString(guide.sessionId);
        if (!sessionId)
            return std::unexpected(sessionId.error());
        auto session = archive.get(archive::RecordType::Session, *sessionId);
        if (!session)
            return std::unexpected(session.error());
        if (!*session || isDeleted(**session)) {
            return std::unexpected(tutorux::core::error(
                "guide_session_missing", "Guide session reference does not resolve."));
        }
        const std::string actualEntryId = getField(**session, "entry_id");
        if (!guide.entryId.empty() && actualEntryId != guide.entryId) {
            return std::unexpected(tutorux::core::error(
                "guide_scope_mismatch", "Guide session does not belong to its journal entry."));
        }
        sourceSessionIds.insert(guide.sessionId);
        const std::string studentId = getField(**session, "student_id");
        if (!studentId.empty() && studentId != "anonymous")
            sourceStudentIds.insert(studentId);
    }
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
            static constexpr std::array<std::string_view, 7> supportedOrigins{
                "tutor-authored", "session-evidence", "ai-generated", "human-edited",
                "uncertain",      "system-generated", "unknown"};
            if (std::find(supportedOrigins.begin(), supportedOrigins.end(), block.origin) ==
                supportedOrigins.end()) {
                return std::unexpected(tutorux::core::error("guide_block_origin_invalid",
                                                            "Guide block provenance is invalid."));
            }
            static constexpr std::array<std::string_view, 12> supportedKinds{
                "paragraph", "list-item",   "quote",          "code",
                "equation",  "table",       "image",          "figure",
                "example",   "instruction", "recommendation", "worked-example"};
            if (std::find(supportedKinds.begin(), supportedKinds.end(), block.kind) ==
                supportedKinds.end()) {
                return std::unexpected(tutorux::core::error("guide_block_kind_invalid",
                                                            "Guide block kind is not supported."));
            }
            if (block.kind == "table") {
                auto table = parseGuideTable(block.text);
                if (!table)
                    return std::unexpected(table.error());
            }
            std::optional<std::string> imageAssetId;
            if (block.kind == "image" || block.kind == "figure" || block.text.starts_with("![")) {
                auto image = parseGuideImageReference(block.text);
                if (!image)
                    return std::unexpected(image.error());
                imageAssetId = std::move(image->assetId);
            }
            auto inlineSourceIds = guideInlineSourceIds(block.text);
            if (!inlineSourceIds)
                return std::unexpected(inlineSourceIds.error());
            std::vector<std::string> sourceIds = block.sourceIds;
            for (const auto& sourceId : *inlineSourceIds) {
                if (std::find(sourceIds.begin(), sourceIds.end(), sourceId) == sourceIds.end())
                    sourceIds.push_back(sourceId);
            }
            if (imageAssetId &&
                std::find(sourceIds.begin(), sourceIds.end(), *imageAssetId) == sourceIds.end()) {
                sourceIds.push_back(*imageAssetId);
            }
            for (const auto& sourceId : sourceIds) {
                auto id = archive::uuidFromString(sourceId);
                if (!id)
                    return std::unexpected(id.error());
                bool found = false;
                for (const auto type :
                     {archive::RecordType::TranscriptSegment, archive::RecordType::Annotation,
                      archive::RecordType::EvidenceNode, archive::RecordType::AssetMetadata,
                      archive::RecordType::Session, archive::RecordType::Student}) {
                    auto source = archive.get(type, *id);
                    if (!source)
                        return std::unexpected(source.error());
                    if (!*source || isDeleted(**source))
                        continue;

                    const archive::Record& sourceRecord = **source;
                    const std::string sourceSessionId = getField(sourceRecord, "session_id");
                    if (type == archive::RecordType::Session)
                        found = sourceSessionIds.contains(archive::uuidToString(sourceRecord.id));
                    else if (type == archive::RecordType::Student)
                        found = sourceStudentIds.contains(archive::uuidToString(sourceRecord.id));
                    else if (type == archive::RecordType::AssetMetadata)
                        found = sourceSessionIds.contains(sourceSessionId) ||
                                (!sourceStudentIds.empty() &&
                                 sourceStudentIds.contains(getField(sourceRecord, "student_id")));
                    else
                        found = sourceSessionIds.contains(sourceSessionId);
                    if (found)
                        break;
                }
                if (!found) {
                    auto settingsSource = archive.get(archive::RecordType::Settings, *id);
                    if (!settingsSource)
                        return std::unexpected(settingsSource.error());
                    if (*settingsSource && !isDeleted(**settingsSource) &&
                        getField(**settingsSource, "record_role") == "journal-notes") {
                        const std::string notesEntryId = getField(**settingsSource, "entry_id");
                        const std::string notesSessionId = getField(**settingsSource, "session_id");
                        found = (!guide.entryId.empty() && notesEntryId == guide.entryId) ||
                                (!guide.sessionId.empty() && notesSessionId == guide.sessionId);
                    }
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
