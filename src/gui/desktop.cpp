#include "tutorux/gui/desktop.hpp"

#include "app-window.h"
#include "tutorux/assets/import.hpp"
#include "tutorux/archive/archive.hpp"
#include "tutorux/audio/capture.hpp"
#include "tutorux/command/dispatcher.hpp"
#include "tutorux/command/json.hpp"
#include "tutorux/document/editor.hpp"
#include "tutorux/domain/entities.hpp"
#include "tutorux/domain/guide.hpp"
#include "tutorux/domain/journal.hpp"

#include <algorithm>
#include <array>
#include <atomic>
#include <charconv>
#include <chrono>
#include <cctype>
#include <cmath>
#include <cstdint>
#include <exception>
#include <filesystem>
#include <iomanip>
#include <iterator>
#include <limits>
#include <memory>
#include <mutex>
#include <optional>
#include <sstream>
#include <set>
#include <span>
#include <string>
#include <string_view>
#include <thread>
#include <utility>
#include <vector>

#include <sodium.h>

namespace tutorux::gui {
namespace {

    using tutorux::archive::Archive;
    using tutorux::archive::ArchiveInfo;
    using tutorux::command::CommandResult;
    using tutorux::core::Result;

    struct ActiveGuideEditor final {
        std::string guideId;
        std::size_t sectionIndex{};
        std::size_t blockIndex{};
        std::uint64_t expectedRevision{};
        tutorux::document::PieceTable text;
        std::string kind;
        std::vector<std::string> sourceIds;
    };

    struct GuideBlockSelection final {
        std::string guideId;
        std::size_t sectionIndex{};
        std::size_t blockIndex{};
    };

    tutorux::core::Status updateGuideEditorText(ActiveGuideEditor& editor, std::string_view updatedText,
                                                std::optional<tutorux::document::TextSelection> selection = {}) {
        auto result =
            editor.text.applyTextSnapshot(updatedText, editor.guideId, editor.expectedRevision, selection, "desktop-guide-editor", true);
        if (!result)
            return std::unexpected(result.error());
        return {};
    }

    Result<tutorux::document::TextRange> nextGuideTextMatch(ActiveGuideEditor& editor, std::string_view query) {
        if (query.empty()) {
            return std::unexpected(tutorux::core::error("document_search_empty", "Enter text to find in this guide block."));
        }
        const auto matches = editor.text.findAll(query);
        if (matches.empty()) {
            return std::unexpected(tutorux::core::error("document_search_not_found", "No matching text was found in this guide block."));
        }
        const std::size_t currentEnd = std::max(editor.text.selection().anchor, editor.text.selection().focus);
        const auto next = std::find_if(matches.begin(), matches.end(), [&](const auto& match) {
            return match.start >= currentEnd;
        });
        return next == matches.end() ? matches.front() : *next;
    }

    std::string joinSourceIds(const std::vector<std::string>& sourceIds) {
        std::string joined;
        for (const auto& sourceId : sourceIds) {
            if (!joined.empty())
                joined.push_back(',');
            joined += sourceId;
        }
        return joined;
    }

    void appendUniqueSourceId(std::vector<std::string>& sourceIds, std::string_view sourceId) {
        if (std::find(sourceIds.begin(), sourceIds.end(), sourceId) == sourceIds.end())
            sourceIds.emplace_back(sourceId);
    }

    Result<std::vector<std::string>> guideEditorSourceIds(const ActiveGuideEditor& editor) {
        std::vector<std::string> sourceIds = editor.sourceIds;
        const std::string text = editor.text.text();
        auto inlineSourceIds = tutorux::domain::guideInlineSourceIds(text);
        if (!inlineSourceIds)
            return std::unexpected(inlineSourceIds.error());
        for (const auto& sourceId : *inlineSourceIds)
            appendUniqueSourceId(sourceIds, sourceId);
        if (editor.kind == "image" || editor.kind == "figure" || text.starts_with("![")) {
            auto image = tutorux::domain::parseGuideImageReference(text);
            if (!image)
                return std::unexpected(image.error());
            appendUniqueSourceId(sourceIds, image->assetId);
        }
        return sourceIds;
    }

    std::vector<std::string> explicitGuideSourceIds(const tutorux::domain::GuideBlock& block) {
        std::vector<std::string> sourceIds = block.sourceIds;
        auto inlineSourceIds = tutorux::domain::guideInlineSourceIds(block.text);
        const auto removeSource = [&](std::string_view sourceId) {
            std::erase_if(sourceIds, [&](const std::string& existing) {
                return existing == sourceId;
            });
        };
        if (inlineSourceIds) {
            for (const auto& sourceId : *inlineSourceIds)
                removeSource(sourceId);
        }
        if (block.kind == "image" || block.kind == "figure" || block.text.starts_with("![")) {
            auto image = tutorux::domain::parseGuideImageReference(block.text);
            if (image)
                removeSource(image->assetId);
        }
        return sourceIds;
    }

    struct ActiveTranscriptEditor final {
        std::string sessionId;
        std::string segmentId;
        std::uint64_t expectedRevision{};
    };

    slint::SharedString toSharedString(std::string_view text) {
        return slint::SharedString(text);
    }

    std::string archiveChoices(const std::vector<ArchiveInfo>& archives) {
        if (archives.empty())
            return "No .tux archives were found in this folder. Create one to begin.";
        std::ostringstream output;
        output << "Archives in this folder\n\n";
        for (const auto& archive : archives) {
            output << (archive.healthStatus == "healthy" ? "●  " : "!  ") << archive.displayName << "\n    " << archive.path.string();
            if (archive.healthStatus != "healthy")
                output << "\n    Status: " << archive.healthStatus;
            output << "\n\n";
        }
        return output.str();
    }

    std::shared_ptr<slint::VectorModel<slint::SharedString>> archivePathChoices(const std::vector<ArchiveInfo>& archives) {
        std::vector<slint::SharedString> paths;
        paths.reserve(archives.size());
        for (const auto& archive : archives)
            paths.emplace_back(archive.path.string());
        return std::make_shared<slint::VectorModel<slint::SharedString>>(std::move(paths));
    }

    std::string commandOutput(Result<CommandResult> command) {
        if (!command)
            return command.error().message;
        return command->output.empty() ? "Completed." : command->output;
    }

    std::optional<std::string> jsonStringField(std::string_view json, std::string_view fieldName) {
        auto parsed = tutorux::command::parseJson(json);
        if (!parsed)
            return std::nullopt;
        const auto* object = parsed->asObject();
        if (!object)
            return std::nullopt;
        const auto field = object->find(fieldName);
        if (field == object->end())
            return std::nullopt;
        const auto* value = field->second.asString();
        if (!value)
            return std::nullopt;
        return *value;
    }

    std::string selectionId(const slint::SharedString& selection);

    std::vector<slint::SharedString> journalTaxonomyChoices(std::string_view json, std::string_view allLabel) {
        std::vector<slint::SharedString> choices{toSharedString(allLabel)};
        auto parsed = tutorux::command::parseJson(json);
        const auto* rows = parsed ? parsed->asArray() : nullptr;
        if (!rows)
            return choices;

        choices.reserve(rows->size() + 1);
        for (const auto& row : *rows) {
            const auto* object = row.asObject();
            if (!object)
                continue;
            const auto read = [&](std::string_view name) -> std::string {
                const auto found = object->find(name);
                if (found == object->end())
                    return {};
                const auto* value = found->second.asString();
                return value ? *value : std::string{};
            };
            const std::string id = read("id");
            const std::string name = read("name");
            if (!tutorux::archive::uuidFromString(id) || name.empty())
                continue;
            choices.emplace_back(name + " · " + id);
        }
        return choices;
    }

    std::string journalTaxonomyFilterId(std::string_view selection) {
        if (selection.empty() || selection == "All collections" || selection == "All tags")
            return {};
        if (tutorux::archive::uuidFromString(selection))
            return std::string(selection);
        return selectionId(toSharedString(selection));
    }

    struct JournalNoteBlockView final {
        std::string id;
        std::string kind;
        std::string text;
    };

    std::vector<JournalNoteBlockView> journalNoteBlocks(std::string_view json) {
        std::vector<JournalNoteBlockView> blocks;
        auto parsed = tutorux::command::parseJson(json);
        const auto* rows = parsed ? parsed->asArray() : nullptr;
        if (!rows)
            return blocks;

        blocks.reserve(rows->size());
        for (const auto& row : *rows) {
            const auto* object = row.asObject();
            if (!object)
                continue;
            const auto read = [&](std::string_view name) -> std::string {
                const auto found = object->find(name);
                if (found == object->end())
                    return {};
                const auto* value = found->second.asString();
                return value ? *value : std::string{};
            };
            JournalNoteBlockView block{read("id"), read("kind"), read("text")};
            if (tutorux::archive::uuidFromString(block.id) && tutorux::domain::isValidJournalNoteBlockKind(block.kind)) {
                blocks.push_back(std::move(block));
            }
        }
        return blocks;
    }

    std::string journalNoteKindLabel(std::string_view kind) {
        if (kind == "heading")
            return "Heading";
        if (kind == "bullet-list")
            return "Bulleted list";
        if (kind == "numbered-list")
            return "Numbered list";
        if (kind == "checklist")
            return "Checklist";
        if (kind == "quote")
            return "Quote";
        if (kind == "code")
            return "Code";
        return "Paragraph";
    }

    std::string journalNoteKindValue(std::string_view label) {
        if (label == "Heading")
            return "heading";
        if (label == "Bulleted list")
            return "bullet-list";
        if (label == "Numbered list")
            return "numbered-list";
        if (label == "Checklist")
            return "checklist";
        if (label == "Quote")
            return "quote";
        if (label == "Code")
            return "code";
        return label == "Paragraph" ? "paragraph" : std::string{};
    }

    std::vector<slint::SharedString> journalNoteBlockChoices(const std::vector<JournalNoteBlockView>& blocks) {
        std::vector<slint::SharedString> choices;
        choices.reserve(blocks.size());
        for (std::size_t index = 0; index < blocks.size(); ++index) {
            choices.emplace_back(journalNoteKindLabel(blocks[index].kind) + " · Block " + std::to_string(index + 1) + " · " +
                                 blocks[index].id);
        }
        return choices;
    }

    std::string journalNoteDocumentText(const std::vector<JournalNoteBlockView>& blocks) {
        std::string text;
        for (std::size_t index = 0; index < blocks.size(); ++index) {
            if (index != 0)
                text += "\n\n";
            text += blocks[index].text;
        }
        return text;
    }

    struct JournalInlineFormat final {
        std::string text;
        int anchor{};
        int focus{};
    };

    std::size_t journalTextOffset(std::string_view text, int offset) {
        if (offset <= 0)
            return 0;
        std::size_t position = std::min(static_cast<std::size_t>(offset), text.size());
        while (position > 0 && position < text.size() && (static_cast<unsigned char>(text[position]) & 0xc0U) == 0x80U)
            --position;
        return position;
    }

    JournalInlineFormat formatJournalText(std::string text, int anchorOffset, int focusOffset, std::string_view format) {
        const std::string_view marker = format == "bold"     ? "**"
                                        : format == "italic" ? "*"
                                        : format == "strike" ? "~~"
                                        : format == "code"   ? "`"
                                                             : "";
        const std::size_t anchor = journalTextOffset(text, anchorOffset);
        const std::size_t focus = journalTextOffset(text, focusOffset);
        const std::size_t start = std::min(anchor, focus);
        const std::size_t end = std::max(anchor, focus);

        if (format == "link") {
            if (end > start && start > 0 && end + 1 < text.size() && text[start - 1] == '[' && text[end] == ']' && text[end + 1] == '(') {
                const std::size_t targetEnd = text.find(')', end + 2);
                if (targetEnd != std::string::npos) {
                    std::string unlinked;
                    unlinked.reserve(text.size());
                    unlinked.append(text, 0, start - 1);
                    unlinked.append(text, start, end - start);
                    unlinked.append(text, targetEnd + 1, std::string::npos);
                    const std::size_t newStart = start - 1;
                    const std::size_t newEnd = end - 1;
                    return {std::move(unlinked), static_cast<int>(anchor <= focus ? newStart : newEnd),
                            static_cast<int>(anchor <= focus ? newEnd : newStart)};
                }
            }
            const std::string_view selected(text.data() + start, end - start);
            const std::size_t selectedSize = selected.size();
            const std::string replacement = "[" + std::string(selected) + "](url)";
            text.replace(start, end - start, replacement);
            const std::size_t urlStart = start + 1 + selectedSize + 2;
            if (selectedSize == 0) {
                return {std::move(text), static_cast<int>(start + 1), static_cast<int>(start + 5)};
            }
            return {std::move(text), static_cast<int>(urlStart), static_cast<int>(urlStart + 3)};
        }

        if (marker.empty())
            return {std::move(text), static_cast<int>(anchor), static_cast<int>(focus)};

        const std::size_t markerSize = marker.size();
        std::size_t openingStarRun = 0;
        for (std::size_t offset = start; offset > 0 && text[offset - 1] == '*'; --offset)
            ++openingStarRun;
        std::size_t closingStarRun = 0;
        for (std::size_t offset = end; offset < text.size() && text[offset] == '*'; ++offset)
            ++closingStarRun;
        const bool italicWouldRemoveBold = marker == "*" && openingStarRun == 2 && closingStarRun == 2;
        if (!italicWouldRemoveBold && end > start && start >= markerSize && text.compare(start - markerSize, markerSize, marker) == 0 &&
            text.compare(end, markerSize, marker) == 0) {
            text.erase(end, markerSize);
            text.erase(start - markerSize, markerSize);
            const std::size_t newStart = start - markerSize;
            const std::size_t newEnd = end - markerSize;
            return {std::move(text), static_cast<int>(anchor <= focus ? newStart : newEnd),
                    static_cast<int>(anchor <= focus ? newEnd : newStart)};
        }

        text.insert(end, marker);
        text.insert(start, marker);
        if (start == end) {
            const std::size_t caret = start + markerSize;
            return {std::move(text), static_cast<int>(caret), static_cast<int>(caret)};
        }
        const std::size_t newStart = start + markerSize;
        const std::size_t newEnd = end + markerSize;
        return {std::move(text), static_cast<int>(anchor <= focus ? newStart : newEnd),
                static_cast<int>(anchor <= focus ? newEnd : newStart)};
    }

    std::optional<std::size_t> journalNoteBlockIndex(std::string_view blocksJson, std::string_view blockId) {
        const auto blocks = journalNoteBlocks(blocksJson);
        const auto found = std::find_if(blocks.begin(), blocks.end(), [&](const auto& block) {
            return block.id == blockId;
        });
        if (found == blocks.end())
            return std::nullopt;
        return static_cast<std::size_t>(std::distance(blocks.begin(), found));
    }

    void setSelectedJournalNoteBlock(MainWindow& window, std::string_view blockId) {
        const auto blocksJsonShared = window.get_journal_document_blocks_json();
        const std::string blocksJson(blocksJsonShared.data(), blocksJsonShared.size());
        const auto blocks = journalNoteBlocks(blocksJson);
        const auto found = std::find_if(blocks.begin(), blocks.end(), [&](const auto& block) {
            return block.id == blockId;
        });
        if (found == blocks.end()) {
            window.set_journal_document_block_text(toSharedString(""));
            window.set_journal_document_block_kind(toSharedString("Paragraph"));
            window.set_journal_document_block_anchor_offset(0);
            window.set_journal_document_block_focus_offset(0);
            window.set_journal_document_block_index(-1);
            window.set_journal_document_block_count(static_cast<int>(blocks.size()));
            return;
        }
        window.set_journal_document_block_text(toSharedString(found->text));
        window.set_journal_document_block_kind(toSharedString(journalNoteKindLabel(found->kind)));
        window.set_journal_document_block_anchor_offset(0);
        window.set_journal_document_block_focus_offset(0);
        window.set_journal_document_block_index(static_cast<int>(std::distance(blocks.begin(), found)));
        window.set_journal_document_block_count(static_cast<int>(blocks.size()));
    }

    void setJournalDocumentFromJson(MainWindow& window, std::string_view json) {
        if (const auto documentId = jsonStringField(json, "document_id"))
            window.set_journal_document_id(toSharedString(*documentId));
        const std::string blocksJson = jsonStringField(json, "blocks_json").value_or("[]");
        const auto blocks = journalNoteBlocks(blocksJson);
        const auto choices = journalNoteBlockChoices(blocks);
        const auto selectedShared = window.get_selected_journal_note_block();
        const std::string selectedId = selectionId(selectedShared);
        const auto selectedBlock = std::find_if(blocks.begin(), blocks.end(), [&](const auto& block) {
            return block.id == selectedId;
        });
        const std::size_t selectedIndex =
            selectedBlock == blocks.end() ? 0U : static_cast<std::size_t>(std::distance(blocks.begin(), selectedBlock));
        const std::string selectedChoice =
            choices.empty() ? std::string{} : std::string(choices[selectedIndex].data(), choices[selectedIndex].size());
        window.set_journal_document_blocks_json(toSharedString(blocksJson));
        window.set_journal_document_text(toSharedString(journalNoteDocumentText(blocks)));
        window.set_journal_note_block_options(std::make_shared<slint::VectorModel<slint::SharedString>>(choices));
        window.set_selected_journal_note_block(toSharedString(selectedChoice));
        setSelectedJournalNoteBlock(window, choices.empty() ? std::string_view{} : std::string_view(blocks[selectedIndex].id));
    }

    std::vector<slint::SharedString> journalEntryChoices(std::string_view json) {
        std::vector<slint::SharedString> choices;
        auto parsed = tutorux::command::parseJson(json);
        const auto* rows = parsed ? parsed->asArray() : nullptr;
        if (!rows)
            return choices;

        choices.reserve(rows->size());
        for (const auto& row : *rows) {
            const auto* object = row.asObject();
            if (!object)
                continue;
            const auto read = [&](std::string_view name) -> std::string {
                const auto found = object->find(name);
                if (found == object->end())
                    return {};
                const auto* value = found->second.asString();
                return value ? *value : std::string{};
            };
            const std::string id = read("id");
            if (!tutorux::archive::uuidFromString(id))
                continue;
            const std::string title = read("title");
            const std::string date = read("entry_date");
            const std::string sessionCount = read("session_count");
            std::string label = date.empty() ? title : date + " · " + title;
            if (!sessionCount.empty())
                label += " · " + sessionCount + " session(s)";
            label += " · " + id;
            choices.emplace_back(std::move(label));
        }
        return choices;
    }

    std::string journalEntryListSummary(std::string_view json) {
        auto parsed = tutorux::command::parseJson(json);
        if (!parsed || !parsed->asArray())
            return std::string(json);
        const auto choices = journalEntryChoices(json);
        if (choices.empty())
            return "No journal entries yet. Create an entry to start the journal.";
        return "Select an entry above to open it. " + std::to_string(choices.size()) +
               (choices.size() == 1 ? " entry found." : " entries found.");
    }

    std::string journalSessionDateTime(std::string_view value) {
        std::int64_t timestampUs = 0;
        const auto [end, errorCode] = std::from_chars(value.data(), value.data() + value.size(), timestampUs);
        if (errorCode != std::errc{} || end != value.data() + value.size() || timestampUs < 0)
            return std::string(value);

        using namespace std::chrono;
        const sys_time<microseconds> timestamp{microseconds{timestampUs}};
        const auto day = floor<days>(timestamp);
        const year_month_day date{day};
        const hh_mm_ss time{floor<seconds>(timestamp - day)};
        std::ostringstream output;
        output << static_cast<int>(date.year()) << '-' << std::setfill('0') << std::setw(2) << static_cast<unsigned int>(date.month())
               << '-' << std::setw(2) << static_cast<unsigned int>(date.day()) << ' ' << std::setw(2) << time.hours().count() << ':'
               << std::setw(2) << time.minutes().count() << ':' << std::setw(2) << time.seconds().count() << " UTC";
        return output.str();
    }

    std::vector<slint::SharedString> journalSessionChoices(std::string_view json) {
        std::vector<slint::SharedString> choices;
        auto parsed = tutorux::command::parseJson(json);
        const auto* rows = parsed ? parsed->asArray() : nullptr;
        if (!rows)
            return choices;

        choices.reserve(rows->size());
        for (const auto& row : *rows) {
            const auto* object = row.asObject();
            if (!object)
                continue;
            const auto read = [&](std::string_view name) -> std::string {
                const auto found = object->find(name);
                if (found == object->end())
                    return {};
                const auto* value = found->second.asString();
                return value ? *value : std::string{};
            };
            const std::string id = read("id");
            if (!tutorux::archive::uuidFromString(id))
                continue;
            const std::string sessionTitle = read("title");
            const std::string title = sessionTitle.empty() ? "Tutoring session" : sessionTitle;
            std::string rawStartedAt = read("started_at");
            if (rawStartedAt.empty())
                rawStartedAt = read("started_at_us");
            if (rawStartedAt.empty())
                rawStartedAt = read("created_at_us");
            const std::string startedAt = journalSessionDateTime(rawStartedAt);
            const std::string state = read("state");
            std::string label = startedAt.empty() ? title : startedAt + " · " + title;
            if (!state.empty())
                label += " · " + state;
            const std::string audioChunkCount = read("audio_chunk_count");
            const std::string transcriptSegmentCount = read("transcript_segment_count");
            const bool hasAudio = read("has_audio") == "true" || (!audioChunkCount.empty() && audioChunkCount != "0");
            const bool hasTranscript =
                read("has_transcript") == "true" || (!transcriptSegmentCount.empty() && transcriptSegmentCount != "0");
            if (hasAudio || hasTranscript) {
                label += " · ";
                label += hasAudio ? "Audio" : "Notes";
                if (hasTranscript)
                    label += hasAudio ? " and transcript" : "Transcript";
            } else {
                label += " · Notes only";
            }
            label += " · " + id;
            choices.emplace_back(std::move(label));
        }
        return choices;
    }

    std::string journalSessionListSummary(std::string_view json) {
        auto parsed = tutorux::command::parseJson(json);
        if (!parsed || !parsed->asArray())
            return std::string(json);
        const auto choices = journalSessionChoices(json);
        if (choices.empty())
            return "No sessions are linked to this entry yet.";
        return std::to_string(choices.size()) + (choices.size() == 1
                                                     ? " session in this entry. Choose it to review its materials."
                                                     : " sessions in this entry, newest first. Choose one to review its materials.");
    }

    std::vector<std::string> archiveCommand(const std::filesystem::path& path, std::initializer_list<std::string> command) {
        std::vector<std::string> arguments{"--archive", path.string()};
        arguments.insert(arguments.end(), command.begin(), command.end());
        return arguments;
    }

    std::vector<std::string> archiveCommand(const std::filesystem::path& path, std::vector<std::string> command) {
        std::vector<std::string> arguments{"--archive", path.string()};
        arguments.insert(arguments.end(), std::make_move_iterator(command.begin()), std::make_move_iterator(command.end()));
        return arguments;
    }

    void eraseSecret(std::string& secret) {
        if (!secret.empty())
            sodium_memzero(secret.data(), secret.size());
        secret.clear();
    }

    Result<CommandResult> dispatchWithSecrets(const std::vector<std::string>& arguments, std::string_view passphrase = {},
                                              std::string_view newPassphrase = {}, tutorux::command::ProgressCallback progress = {},
                                              std::function<bool()> stopRequested = {}) {
        tutorux::command::DispatchControl control;
        control.archivePassphrase = passphrase;
        control.newArchivePassphrase = newPassphrase;
        control.stopRequested = std::move(stopRequested);
        return command::dispatch(arguments, std::move(progress), std::move(control));
    }

    Result<std::vector<std::string>> parseCommandLine(std::string_view input) {
        std::vector<std::string> arguments;
        std::string token;
        char quote = 0;
        bool escaped = false;
        bool tokenStarted = false;

        const auto finishToken = [&]() {
            if (!tokenStarted)
                return;
            arguments.push_back(std::move(token));
            token.clear();
            tokenStarted = false;
        };

        for (const char character : input) {
            if (escaped) {
                token.push_back(character);
                escaped = false;
                continue;
            }
            if (quote != 0) {
                if (character == '\\' && quote == '"') {
                    escaped = true;
                } else if (character == quote) {
                    quote = 0;
                } else {
                    token.push_back(character);
                }
                tokenStarted = true;
                continue;
            }
            if (character == '"' || character == '\'') {
                quote = character;
                tokenStarted = true;
            } else if (std::isspace(static_cast<unsigned char>(character)) != 0) {
                finishToken();
            } else {
                token.push_back(character);
                tokenStarted = true;
            }
        }

        if (escaped)
            token.push_back('\\');
        if (quote != 0) {
            return std::unexpected(tutorux::core::error("command_quote_unclosed", "Close the quoted command argument before running it."));
        }
        finishToken();
        if (!arguments.empty() && arguments.front() == "tutorux")
            arguments.erase(arguments.begin());
        if (arguments.empty()) {
            return std::unexpected(tutorux::core::error("command_empty", "Enter a Tutorux command to run."));
        }
        for (const auto& argument : arguments) {
            if (argument == "--archive" || argument.starts_with("--archive=") || argument == "--directory" ||
                argument.starts_with("--directory=")) {
                return std::unexpected(tutorux::core::error("command_workspace_override",
                                                            "The command console always uses the selected archive and directory."));
            }
        }
        return arguments;
    }

    std::string commandLineFromArguments(const std::vector<std::string>& arguments) {
        std::string commandLine;
        for (const auto& argument : arguments) {
            if (!commandLine.empty())
                commandLine.push_back(' ');
            commandLine.push_back('"');
            for (const char character : argument) {
                if (character == '\\' || character == '"')
                    commandLine.push_back('\\');
                commandLine.push_back(character);
            }
            commandLine.push_back('"');
        }
        return commandLine;
    }

    std::string commandResultText(const Result<CommandResult>& command) {
        if (!command)
            return command.error().message;
        if (command->exitCode != 0)
            return command->output.empty() ? "Command failed." : command->output;
        if (command->output.empty())
            return "Completed.";
        constexpr std::string_view aiPreviewPrefix = "Outbound AI request preview (no network request was sent)";
        constexpr std::size_t maximumAiPreviewBytes = 17U * 1024U * 1024U;
        if (command->output.starts_with(aiPreviewPrefix) && command->output.size() <= maximumAiPreviewBytes) {
            return command->output;
        }
        constexpr std::size_t maximumDisplayedBytes = 256U * 1024U;
        if (command->output.size() > maximumDisplayedBytes) {
            return "Command completed, but its " + std::to_string(command->output.size()) +
                   "-byte result is too large to display here. Use the CLI to save or inspect "
                   "the full output.";
        }
        return command->output;
    }

    std::string selectionId(const slint::SharedString& selection) {
        constexpr std::string_view separator = " · ";
        const std::string value(selection.data(), selection.size());
        if (tutorux::archive::uuidFromString(value))
            return value;
        const auto position = value.rfind(separator);
        if (position == std::string::npos)
            return {};
        const std::string id = value.substr(position + separator.size());
        return tutorux::archive::uuidFromString(id) ? id : std::string{};
    }

    constexpr std::uint64_t maximumNativeImagePreviewBytes = 12U * 1024U * 1024U;
    constexpr std::uint64_t maximumNativeTextPreviewBytes = 1U * 1024U * 1024U;
    constexpr std::uint64_t maximumNativeAudioPreviewBytes = 24U * 1024U * 1024U;
    constexpr std::uint64_t maximumNativeImagePreviewPixels = 16U * 1024U * 1024U;
    constexpr std::size_t maximumNativeTextPreviewCharacters = 100'000;

    std::optional<std::uint64_t> assetByteSize(const tutorux::archive::Record& asset) {
        const std::string sizeText = tutorux::domain::getField(asset, "byte_size");
        std::uint64_t size = 0;
        const auto [end, error] = std::from_chars(sizeText.data(), sizeText.data() + sizeText.size(), size);
        if (error != std::errc{} || end != sizeText.data() + sizeText.size())
            return std::nullopt;
        return size;
    }

    std::string safeAssetLabel(std::string_view value, std::size_t maximumBytes = 192) {
        std::string result;
        result.reserve(std::min(value.size(), maximumBytes));
        for (std::size_t index = 0; index < value.size() && result.size() < maximumBytes;) {
            const auto first = static_cast<unsigned char>(value[index]);
            std::size_t sequenceLength = first < 0x80U                      ? 1U
                                         : first >= 0xc2U && first <= 0xdfU ? 2U
                                         : first >= 0xe0U && first <= 0xefU ? 3U
                                         : first >= 0xf0U && first <= 0xf4U ? 4U
                                                                            : 0U;
            bool valid = sequenceLength != 0 && index + sequenceLength <= value.size();
            if (valid && sequenceLength > 1) {
                for (std::size_t offset = 1; offset < sequenceLength; ++offset) {
                    const auto next = static_cast<unsigned char>(value[index + offset]);
                    valid = valid && (next & 0xc0U) == 0x80U;
                }
                const auto second = static_cast<unsigned char>(value[index + 1]);
                valid = valid && !(first == 0xe0U && second < 0xa0U) && !(first == 0xedU && second >= 0xa0U) &&
                        !(first == 0xf0U && second < 0x90U) && !(first == 0xf4U && second >= 0x90U);
            }
            if (!valid) {
                if (result.size() + 3 > maximumBytes)
                    break;
                result.append("\xef\xbf\xbd");
                ++index;
                continue;
            }
            if (sequenceLength == 1 && (first < 0x20U || first == 0x7fU)) {
                result.push_back(' ');
            } else {
                if (result.size() + sequenceLength > maximumBytes)
                    break;
                result.append(value.substr(index, sequenceLength));
            }
            index += sequenceLength;
        }
        return result;
    }

    struct SanitizedAssetText final {
        std::string text;
        bool replacedInvalidData{};
        bool containedNul{};
        bool truncated{};
    };

    SanitizedAssetText sanitizeAssetText(std::span<const std::uint8_t> bytes) {
        SanitizedAssetText result;
        result.text.reserve(std::min(bytes.size(), maximumNativeTextPreviewCharacters));
        std::size_t characters = 0;
        std::size_t index = 0;
        for (; index < bytes.size() && characters < maximumNativeTextPreviewCharacters;) {
            const std::uint8_t first = bytes[index];
            std::size_t sequenceLength = first < 0x80U                      ? 1U
                                         : first >= 0xc2U && first <= 0xdfU ? 2U
                                         : first >= 0xe0U && first <= 0xefU ? 3U
                                         : first >= 0xf0U && first <= 0xf4U ? 4U
                                                                            : 0U;
            bool valid = sequenceLength != 0 && index + sequenceLength <= bytes.size();
            if (valid && sequenceLength > 1) {
                for (std::size_t offset = 1; offset < sequenceLength; ++offset)
                    valid = valid && (bytes[index + offset] & 0xc0U) == 0x80U;
                const std::uint8_t second = bytes[index + 1];
                valid = valid && !(first == 0xe0U && second < 0xa0U) && !(first == 0xedU && second >= 0xa0U) &&
                        !(first == 0xf0U && second < 0x90U) && !(first == 0xf4U && second >= 0x90U);
            }
            if (!valid || (sequenceLength == 1 && first == 0)) {
                result.replacedInvalidData = true;
                result.containedNul = result.containedNul || (sequenceLength == 1 && first == 0);
                result.text.append("\xef\xbf\xbd");
                ++index;
                ++characters;
                continue;
            }
            if (sequenceLength == 1 && first < 0x20U && first != '\n' && first != '\r' && first != '\t') {
                result.text.push_back(' ');
            } else {
                result.text.append(reinterpret_cast<const char*>(bytes.data() + index), sequenceLength);
            }
            index += sequenceLength;
            ++characters;
        }
        result.truncated = index < bytes.size();
        if (result.truncated)
            result.text += "\n\n[Preview truncated at 100,000 characters.]";
        return result;
    }

    std::optional<std::pair<std::uint32_t, std::uint32_t>> pngDimensions(std::span<const std::uint8_t> bytes) {
        constexpr std::array<std::uint8_t, 8> signature{0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a};
        if (bytes.size() < 24 || !std::equal(signature.begin(), signature.end(), bytes.begin()) || bytes[12] != 'I' || bytes[13] != 'H' ||
            bytes[14] != 'D' || bytes[15] != 'R') {
            return std::nullopt;
        }
        const auto readBigEndian = [&](std::size_t offset) {
            return (static_cast<std::uint32_t>(bytes[offset]) << 24U) | (static_cast<std::uint32_t>(bytes[offset + 1]) << 16U) |
                   (static_cast<std::uint32_t>(bytes[offset + 2]) << 8U) | static_cast<std::uint32_t>(bytes[offset + 3]);
        };
        if (readBigEndian(8) != 13)
            return std::nullopt;
        return std::pair{readBigEndian(16), readBigEndian(20)};
    }

    std::optional<std::pair<std::uint32_t, std::uint32_t>> jpegDimensions(std::span<const std::uint8_t> bytes) {
        if (bytes.size() < 4 || bytes[0] != 0xffU || bytes[1] != 0xd8U)
            return std::nullopt;
        std::size_t offset = 2;
        while (offset + 4 <= bytes.size() && offset <= 1024U * 1024U) {
            if (bytes[offset++] != 0xffU)
                return std::nullopt;
            while (offset < bytes.size() && bytes[offset] == 0xffU)
                ++offset;
            if (offset >= bytes.size())
                return std::nullopt;
            const std::uint8_t marker = bytes[offset++];
            if (marker == 0xd9U || marker == 0xdaU)
                return std::nullopt;
            if (marker == 0x01U || (marker >= 0xd0U && marker <= 0xd7U))
                continue;
            if (offset + 2 > bytes.size())
                return std::nullopt;
            const std::size_t segmentLength = (static_cast<std::size_t>(bytes[offset]) << 8U) | bytes[offset + 1];
            if (segmentLength < 2 || segmentLength > bytes.size() - offset)
                return std::nullopt;
            const bool startOfFrame = (marker >= 0xc0U && marker <= 0xc3U) || (marker >= 0xc5U && marker <= 0xc7U) ||
                                      (marker >= 0xc9U && marker <= 0xcbU) || (marker >= 0xcdU && marker <= 0xcfU);
            if (startOfFrame) {
                if (segmentLength < 7)
                    return std::nullopt;
                const std::size_t heightOffset = offset + 3;
                const std::size_t widthOffset = offset + 5;
                const std::uint32_t height = (static_cast<std::uint32_t>(bytes[heightOffset]) << 8U) | bytes[heightOffset + 1];
                const std::uint32_t width = (static_cast<std::uint32_t>(bytes[widthOffset]) << 8U) | bytes[widthOffset + 1];
                return std::pair{width, height};
            }
            offset += segmentLength;
        }
        return std::nullopt;
    }

    Result<std::vector<std::uint8_t>> readAssetPreviewBytes(const Archive& archive, const tutorux::archive::Record& asset,
                                                            std::uint64_t maximumBytes) {
        const auto expectedSize = assetByteSize(asset);
        if (!expectedSize)
            return std::unexpected(tutorux::core::error("asset_preview_metadata_invalid", "The archived asset size metadata is invalid."));
        if (*expectedSize == 0 || *expectedSize > maximumBytes || *expectedSize > std::numeric_limits<std::size_t>::max()) {
            return std::unexpected(
                tutorux::core::error("asset_preview_size_limit", "This file is empty or exceeds its native preview limit."));
        }
        std::vector<std::uint8_t> bytes;
        bytes.reserve(static_cast<std::size_t>(*expectedSize));
        auto verification =
            tutorux::assets::visitArchiveAsset(archive, asset, [&](std::span<const std::byte> chunk) -> tutorux::core::Status {
                if (chunk.size() > maximumBytes - bytes.size()) {
                    return std::unexpected(
                        tutorux::core::error("asset_preview_size_limit", "The archived content exceeds its native preview limit."));
                }
                for (const std::byte value : chunk)
                    bytes.push_back(std::to_integer<std::uint8_t>(value));
                return {};
            });
        if (!verification)
            return std::unexpected(verification.error());
        return bytes;
    }

    struct PcmWavePreview final {
        std::string waveform;
        std::string details;
    };

    std::optional<PcmWavePreview> previewPcmWave(std::span<const std::uint8_t> bytes) {
        if (bytes.size() < 44 || std::string_view(reinterpret_cast<const char*>(bytes.data()), 4) != "RIFF" ||
            std::string_view(reinterpret_cast<const char*>(bytes.data() + 8), 4) != "WAVE")
            return std::nullopt;
        const auto readU16 = [&](std::size_t offset) {
            return static_cast<std::uint16_t>(bytes[offset]) |
                   static_cast<std::uint16_t>(static_cast<std::uint16_t>(bytes[offset + 1]) << 8U);
        };
        const auto readU32 = [&](std::size_t offset) {
            return static_cast<std::uint32_t>(bytes[offset]) | (static_cast<std::uint32_t>(bytes[offset + 1]) << 8U) |
                   (static_cast<std::uint32_t>(bytes[offset + 2]) << 16U) | (static_cast<std::uint32_t>(bytes[offset + 3]) << 24U);
        };
        const std::uint64_t declaredSize = readU32(4);
        if (declaredSize > static_cast<std::uint64_t>(std::numeric_limits<std::size_t>::max() - 8U))
            return std::nullopt;
        const std::size_t declaredEnd = static_cast<std::size_t>(declaredSize) + 8U;
        if (declaredEnd > bytes.size() || declaredEnd < 44)
            return std::nullopt;

        std::uint16_t format = 0;
        std::uint16_t channels = 0;
        std::uint16_t bitsPerSample = 0;
        std::uint16_t blockAlign = 0;
        std::uint32_t sampleRate = 0;
        std::size_t dataOffset = 0;
        std::size_t dataLength = 0;
        for (std::size_t offset = 12; offset + 8 <= declaredEnd;) {
            const std::string_view chunkId(reinterpret_cast<const char*>(bytes.data() + offset), 4);
            const std::size_t chunkLength = readU32(offset + 4);
            const std::size_t chunkStart = offset + 8;
            if (chunkLength > declaredEnd - chunkStart)
                return std::nullopt;
            if (chunkId == "fmt " && chunkLength >= 16) {
                format = readU16(chunkStart);
                channels = readU16(chunkStart + 2);
                sampleRate = readU32(chunkStart + 4);
                blockAlign = readU16(chunkStart + 12);
                bitsPerSample = readU16(chunkStart + 14);
            } else if (chunkId == "data" && dataLength == 0) {
                dataOffset = chunkStart;
                dataLength = chunkLength;
            }
            const std::size_t paddedLength = chunkLength + (chunkLength & 1U);
            if (paddedLength > declaredEnd - chunkStart)
                return std::nullopt;
            offset = chunkStart + paddedLength;
        }
        const std::size_t bytesPerSample = bitsPerSample / 8U;
        if (format != 1 || channels == 0 || channels > 8 || sampleRate == 0 ||
            (bitsPerSample != 8 && bitsPerSample != 16 && bitsPerSample != 24 && bitsPerSample != 32) ||
            bytesPerSample * channels != blockAlign || dataOffset == 0 || dataLength < blockAlign || dataLength % blockAlign != 0)
            return std::nullopt;

        const std::size_t frameCount = dataLength / blockAlign;
        constexpr std::size_t barCount = 56;
        constexpr std::array<std::string_view, 8> bars{"▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"};
        std::string waveform;
        waveform.reserve(barCount * 3);
        for (std::size_t bar = 0; bar < barCount; ++bar) {
            const std::size_t firstFrame = bar * frameCount / barCount;
            const std::size_t lastFrame = std::max(firstFrame + 1, (bar + 1) * frameCount / barCount);
            double peak = 0.0;
            for (std::size_t frame = firstFrame; frame < std::min(lastFrame, frameCount); ++frame) {
                const std::size_t frameOffset = dataOffset + frame * blockAlign;
                for (std::size_t channel = 0; channel < channels; ++channel) {
                    const std::size_t sampleOffset = frameOffset + channel * bytesPerSample;
                    std::int64_t value = 0;
                    double scale = 1.0;
                    if (bitsPerSample == 8) {
                        value = static_cast<std::int64_t>(bytes[sampleOffset]) - 128;
                        scale = 128.0;
                    } else if (bitsPerSample == 16) {
                        std::uint32_t raw = bytes[sampleOffset] | (static_cast<std::uint32_t>(bytes[sampleOffset + 1]) << 8U);
                        value = raw >= 0x8000U ? static_cast<std::int64_t>(raw) - 0x10000 : raw;
                        scale = 32768.0;
                    } else if (bitsPerSample == 24) {
                        std::uint32_t raw = bytes[sampleOffset] | (static_cast<std::uint32_t>(bytes[sampleOffset + 1]) << 8U) |
                                            (static_cast<std::uint32_t>(bytes[sampleOffset + 2]) << 16U);
                        value = raw >= 0x800000U ? static_cast<std::int64_t>(raw) - 0x1000000 : raw;
                        scale = 8388608.0;
                    } else {
                        std::uint64_t raw = bytes[sampleOffset] | (static_cast<std::uint64_t>(bytes[sampleOffset + 1]) << 8U) |
                                            (static_cast<std::uint64_t>(bytes[sampleOffset + 2]) << 16U) |
                                            (static_cast<std::uint64_t>(bytes[sampleOffset + 3]) << 24U);
                        value = raw >= 0x80000000ULL ? static_cast<std::int64_t>(raw) - 0x100000000LL : static_cast<std::int64_t>(raw);
                        scale = 2147483648.0;
                    }
                    peak = std::max(peak, std::abs(static_cast<double>(value) / scale));
                }
            }
            const std::size_t level =
                std::min<std::size_t>(bars.size() - 1, static_cast<std::size_t>(std::round(peak * (bars.size() - 1))));
            waveform += bars[level];
        }
        std::ostringstream details;
        details << "PCM WAV · " << sampleRate << " Hz · " << channels << " channels · " << bitsPerSample << " bit · " << std::fixed
                << std::setprecision(1) << static_cast<double>(frameCount) / sampleRate
                << " s · waveform only; this view "
                   "does not play audio.";
        return PcmWavePreview{std::move(waveform), details.str()};
    }

    void resetAssetPreview(MainWindow& window, std::string_view message) {
        window.set_asset_preview_kind(toSharedString("message"));
        window.set_asset_preview_description(toSharedString(message));
        window.set_asset_preview_body(toSharedString(""));
        window.set_asset_preview_waveform(toSharedString(""));
        window.set_asset_preview_image(slint::Image{});
    }

    void clearAssetPanel(MainWindow& window, std::string_view message) {
        window.set_asset_options(std::make_shared<slint::VectorModel<slint::SharedString>>());
        window.set_selected_asset(toSharedString(""));
        resetAssetPreview(window, message);
    }

    std::string formatTimestampField(const tutorux::archive::Record& record, std::string_view field) {
        const auto value = record.fields.find(field);
        if (value == record.fields.end())
            return "00:00:00";
        std::int64_t timestamp = 0;
        const auto [end, error] = std::from_chars(value->second.data(), value->second.data() + value->second.size(), timestamp);
        if (error != std::errc{} || end != value->second.data() + value->second.size() || timestamp < 0) {
            return "Unknown time";
        }
        return tutorux::domain::formatTimestampUs(timestamp);
    }

    std::array<std::string, 7> markerShortcuts(Archive& archive) {
        std::array<std::string, 7> shortcuts{"1", "2", "3", "4", "5", "6", "m"};
        auto settings = archive.list(tutorux::archive::RecordType::Settings);
        if (!settings)
            return shortcuts;
        const auto record = std::find_if(settings->begin(), settings->end(), [](const auto& setting) {
            const auto key = setting.fields.find("key");
            return key != setting.fields.end() && key->second == "annotation.quick_marker_shortcuts";
        });
        if (record == settings->end())
            return shortcuts;
        const auto saved = record->fields.find("value");
        if (saved == record->fields.end())
            return shortcuts;
        std::array<std::string, 7> parsed;
        std::size_t start = 0;
        for (std::size_t index = 0; index < parsed.size(); ++index) {
            const auto comma = saved->second.find(',', start);
            const auto end = comma == std::string::npos ? saved->second.size() : comma;
            parsed[index] = saved->second.substr(start, end - start);
            if (parsed[index].size() != 1 || static_cast<unsigned char>(parsed[index].front()) < 0x21U ||
                static_cast<unsigned char>(parsed[index].front()) > 0x7eU || (index + 1 < parsed.size() && comma == std::string::npos) ||
                (index + 1 == parsed.size() && comma != std::string::npos)) {
                return shortcuts;
            }
            start = end + (comma == std::string::npos ? 0U : 1U);
        }
        std::set<char> unique;
        for (auto& shortcut : parsed) {
            char key = shortcut.front();
            if (std::isalpha(static_cast<unsigned char>(key))) {
                key = static_cast<char>(std::tolower(static_cast<unsigned char>(key)));
                shortcut.front() = key;
            }
            if (!unique.insert(key).second)
                return shortcuts;
        }
        return parsed;
    }

    std::optional<GuideBlockSelection> guideBlockIndexes(const slint::SharedString& selection) {
        const std::string value(selection.data(), selection.size());
        constexpr std::string_view labelSeparator = " · ";
        const auto labelPosition = value.find(labelSeparator);
        const std::string_view label(value.data(), labelPosition == std::string::npos ? value.size() : labelPosition);
        const auto identitySeparator = label.find('|');
        if (identitySeparator == std::string_view::npos)
            return std::nullopt;
        const std::string guideId(label.substr(0, identitySeparator));
        if (!tutorux::archive::uuidFromString(guideId))
            return std::nullopt;
        const std::string_view indexes = label.substr(identitySeparator + 1);
        const auto colon = indexes.find(':');
        if (colon == std::string_view::npos)
            return std::nullopt;
        std::size_t sectionIndex = 0;
        std::size_t blockIndex = 0;
        const auto [sectionEnd, sectionError] = std::from_chars(indexes.data(), indexes.data() + colon, sectionIndex);
        const auto [blockEnd, blockError] = std::from_chars(indexes.data() + colon + 1, indexes.data() + indexes.size(), blockIndex);
        if (sectionError != std::errc{} || sectionEnd != indexes.data() + colon || blockError != std::errc{} ||
            blockEnd != indexes.data() + indexes.size()) {
            return std::nullopt;
        }
        return GuideBlockSelection{guideId, sectionIndex, blockIndex};
    }

    std::string populateGuideBlockOptions(MainWindow& window, Archive& archive, std::string_view guideIdText) {
        auto guideId = tutorux::archive::uuidFromString(guideIdText);
        if (!guideId)
            return guideId.error().message;
        auto record = archive.get(tutorux::archive::RecordType::Guide, *guideId);
        if (!record)
            return record.error().message;
        if (!*record)
            return "Guide was not found in the active archive.";
        auto guide = tutorux::domain::guideFromRecord(**record);
        if (!guide)
            return guide.error().message;

        std::vector<slint::SharedString> choices;
        const std::string canonicalId = tutorux::archive::uuidToString(guide->id);
        for (std::size_t sectionIndex = 0; sectionIndex < guide->sections.size(); ++sectionIndex) {
            const auto& section = guide->sections[sectionIndex];
            for (std::size_t blockIndex = 0; blockIndex < section.blocks.size(); ++blockIndex) {
                const auto& block = section.blocks[blockIndex];
                const auto label = tutorux::domain::guideBlockLabel(block.kind);
                const std::string blockLabel = label.empty() ? block.kind : std::string(label);
                choices.emplace_back(canonicalId + "|" + std::to_string(sectionIndex) + ":" + std::to_string(blockIndex) + " · " +
                                     section.heading + " — " + blockLabel);
            }
        }
        window.set_guide_block_options(std::make_shared<slint::VectorModel<slint::SharedString>>(std::move(choices)));
        const auto options = window.get_guide_block_options();
        window.set_selected_guide_block(options->row_count() == 0 ? toSharedString("") : options->row_data(0).value_or(toSharedString("")));
        return {};
    }

    void refreshArchiveRecoveryState(MainWindow& window, const std::filesystem::path& path, std::string_view passphrase = {}) {
        auto report = Archive::inspectRecovery(path, passphrase);
        if (!report) {
            window.set_archive_recovery_needed(true);
            window.set_archive_recovery_recoverable(false);
            window.set_archive_recovery_tail_present(false);
            window.set_archive_status(toSharedString("Recovery inspection failed"));
            window.set_archive_recovery_status(toSharedString("Recovery inspection failed: " + report.error().message));
            return;
        }

        const bool hasTail = report->trailingBytes != 0;
        window.set_archive_recovery_needed(hasTail);
        window.set_archive_recovery_recoverable(hasTail && report->recoverable);
        window.set_archive_recovery_tail_present(hasTail);
        if (!hasTail) {
            window.set_archive_recovery_status(toSharedString(""));
            return;
        }
        window.set_archive_status(toSharedString(report->encrypted ? "Recovery required · Encrypted" : "Recovery required"));

        std::ostringstream status;
        status << "Committed generation " << report->committedGeneration << "; " << report->trailingBytes << " trailing bytes. ";
        if (report->hasUnpublishedCommit) {
            status << "An unpublished generation " << report->candidateGeneration << " was found. ";
            if (report->recoverable) {
                status << "Full integrity verification passed; you can recover this generation.";
            } else if (report->requiresPassphrase) {
                status << "Enter the archive passphrase to verify whether it can be recovered.";
            } else {
                status << "It did not pass full integrity verification and cannot be recovered.";
            }
        } else {
            status << "No complete unpublished generation is available.";
        }
        for (const auto& issue : report->issues)
            status << "\n" << issue;
        window.set_archive_recovery_status(toSharedString(status.str()));
    }

    void showMetadataOnlyArchive(MainWindow& window, const ArchiveInfo& info) {
        clearAssetPanel(window, "Asset previews are unavailable in metadata-only archive mode.");
        const std::string version = std::to_string(info.formatMajor) + "." + std::to_string(info.formatMinor);
        const std::string reason = info.healthStatus == "unsupported-capability" ? "Unsupported capability" : "Unsupported version";
        const std::string status = "Metadata only · Format " + version + " · " + reason;
        window.set_archive_path(toSharedString(info.path.string()));
        window.set_selected_archive(toSharedString(info.displayName));
        window.set_archive_status(toSharedString(status));
        window.set_students_text(toSharedString("Archive metadata is available. " + status + ". Student records are not loaded."));
        window.set_sessions_text(toSharedString("Session records are unavailable until this "
                                                "archive format is supported."));
        window.set_journal_list_output(toSharedString(status + ". Journal data is not opened by this build."));
        window.set_journal_entry_options(std::make_shared<slint::VectorModel<slint::SharedString>>());
        window.set_selected_journal_entry(toSharedString(""));
        window.set_journal_session_options(std::make_shared<slint::VectorModel<slint::SharedString>>());
        window.set_selected_journal_session(toSharedString(""));
        window.set_journal_collection_options(
            std::make_shared<slint::VectorModel<slint::SharedString>>(std::vector<slint::SharedString>{toSharedString("All collections")}));
        window.set_journal_tag_options(
            std::make_shared<slint::VectorModel<slint::SharedString>>(std::vector<slint::SharedString>{toSharedString("All tags")}));
        window.set_journal_timeline_output(toSharedString("Open a supported archive to view a timeline."));
        window.set_journal_document_id(toSharedString(""));
        window.set_journal_document_text(toSharedString(""));
        window.set_journal_document_blocks_json(toSharedString("[]"));
        window.set_journal_note_block_options(std::make_shared<slint::VectorModel<slint::SharedString>>());
        window.set_selected_journal_note_block(toSharedString(""));
        window.set_journal_document_block_text(toSharedString(""));
        window.set_journal_document_block_anchor_offset(0);
        window.set_journal_document_block_focus_offset(0);
        window.set_journal_document_block_index(-1);
        window.set_journal_document_block_count(0);
        window.set_active_view(toSharedString("archive"));
        window.set_status_message(
            toSharedString(info.displayName + " uses " + status + ". Data operations are unavailable in this build."));
    }

    void showLockedArchive(MainWindow& window, const ArchiveInfo& info) {
        clearAssetPanel(window, "Unlock this archive to list or preview its materials.");
        const std::string status =
            "Locked · Encrypted · Format " + std::to_string(info.formatMajor) + "." + std::to_string(info.formatMinor);
        window.set_archive_path(toSharedString(info.path.string()));
        window.set_selected_archive(toSharedString(info.displayName));
        window.set_archive_status(toSharedString(status));
        window.set_students_text(toSharedString("This archive is encrypted. Enter its passphrase to unlock it."));
        window.set_sessions_text(toSharedString("Unlock the archive to view sessions."));
        window.set_journal_list_output(toSharedString("Unlock this archive to view journal entries."));
        window.set_journal_entry_options(std::make_shared<slint::VectorModel<slint::SharedString>>());
        window.set_selected_journal_entry(toSharedString(""));
        window.set_journal_session_options(std::make_shared<slint::VectorModel<slint::SharedString>>());
        window.set_selected_journal_session(toSharedString(""));
        window.set_journal_collection_options(
            std::make_shared<slint::VectorModel<slint::SharedString>>(std::vector<slint::SharedString>{toSharedString("All collections")}));
        window.set_journal_tag_options(
            std::make_shared<slint::VectorModel<slint::SharedString>>(std::vector<slint::SharedString>{toSharedString("All tags")}));
        window.set_journal_timeline_output(toSharedString("Unlock this archive to view its timeline."));
        window.set_journal_document_id(toSharedString(""));
        window.set_journal_document_text(toSharedString(""));
        window.set_journal_document_blocks_json(toSharedString("[]"));
        window.set_journal_note_block_options(std::make_shared<slint::VectorModel<slint::SharedString>>());
        window.set_selected_journal_note_block(toSharedString(""));
        window.set_journal_document_block_text(toSharedString(""));
        window.set_journal_document_block_anchor_offset(0);
        window.set_journal_document_block_focus_offset(0);
        window.set_journal_document_block_index(-1);
        window.set_journal_document_block_count(0);
        window.set_active_view(toSharedString("archive"));
        window.set_status_message(toSharedString("Archive is locked. Enter its passphrase to unlock it."));
    }

    void refreshWorkspace(MainWindow& window, const std::filesystem::path& path, std::string_view passphrase = {}) {
        clearAssetPanel(window, "Choose a session, list its materials, then preview a selected file.");
        window.set_archive_path(toSharedString(path.string()));
        auto info = Archive::discover(path.parent_path());
        window.set_archive_list(toSharedString(info ? archiveChoices(*info) : info.error().message));
        window.set_archive_paths(archivePathChoices(info ? *info : std::vector<ArchiveInfo>{}));
        bool writableOnDisk = false;
        if (info) {
            const auto selectedPath = path.lexically_normal();
            const auto selectedInfo = std::find_if(info->begin(), info->end(), [&](const ArchiveInfo& archive) {
                return archive.path.lexically_normal() == selectedPath;
            });
            if (selectedInfo != info->end() && selectedInfo->metadataOnly) {
                showMetadataOnlyArchive(window, *selectedInfo);
                return;
            }
            if (selectedInfo != info->end() && selectedInfo->healthStatus == "locked" && passphrase.empty()) {
                showLockedArchive(window, *selectedInfo);
                return;
            }
            writableOnDisk = selectedInfo != info->end() && selectedInfo->writable;
        }
        auto students = dispatchWithSecrets(archiveCommand(path, {"student", "list"}), passphrase);
        auto sessions = dispatchWithSecrets(archiveCommand(path, {"session", "list"}), passphrase);
        auto journalEntries = dispatchWithSecrets(archiveCommand(path, {"--json", "journal", "entry", "list"}), passphrase);
        auto journalCollections = dispatchWithSecrets(archiveCommand(path, {"--json", "journal", "collection", "list"}), passphrase);
        auto journalTags = dispatchWithSecrets(archiveCommand(path, {"--json", "journal", "tag", "list"}), passphrase);
        window.set_students_text(toSharedString(commandOutput(std::move(students))));
        window.set_sessions_text(toSharedString(commandOutput(std::move(sessions))));
        const std::string journalEntriesJson = commandOutput(std::move(journalEntries));
        const auto journalChoices = journalEntryChoices(journalEntriesJson);
        window.set_journal_list_output(toSharedString(journalEntryListSummary(journalEntriesJson)));
        window.set_journal_entry_options(std::make_shared<slint::VectorModel<slint::SharedString>>(journalChoices));
        window.set_journal_collection_options(std::make_shared<slint::VectorModel<slint::SharedString>>(
            journalTaxonomyChoices(commandOutput(std::move(journalCollections)), "All collections")));
        window.set_journal_tag_options(std::make_shared<slint::VectorModel<slint::SharedString>>(
            journalTaxonomyChoices(commandOutput(std::move(journalTags)), "All tags")));
        const auto selectedEntryId = std::string(window.get_journal_entry_id().data(), window.get_journal_entry_id().size());
        const auto selectedJournalEntry =
            std::find_if(journalChoices.begin(), journalChoices.end(), [&](const slint::SharedString& choice) {
                return selectionId(choice) == selectedEntryId;
            });
        window.set_selected_journal_entry(selectedJournalEntry != journalChoices.end() ? *selectedJournalEntry
                                          : journalChoices.empty()                     ? toSharedString("")
                                                                                       : journalChoices.front());
        window.set_selected_archive(toSharedString(path.filename().string()));

        std::vector<slint::SharedString> studentChoices{"Anonymous session"};
        std::vector<slint::SharedString> sessionChoices;
        std::vector<slint::SharedString> guideChoices;
        std::vector<slint::SharedString> guideBlockChoices;
        auto opened = Archive::open(path, false, passphrase);
        if (opened) {
            auto records = opened->list(tutorux::archive::RecordType::Student);
            if (records) {
                studentChoices.reserve(records->size() + 1);
                for (const auto& student : *records) {
                    const auto name = student.fields.find("display_name");
                    const std::string displayName = name == student.fields.end() ? "Unnamed student" : name->second;
                    studentChoices.emplace_back(displayName + " · " + tutorux::archive::uuidToString(student.id));
                }
            }
            auto sessions = opened->list(tutorux::archive::RecordType::Session);
            if (sessions) {
                sessionChoices.reserve(sessions->size());
                for (const auto& session : *sessions) {
                    const auto title = session.fields.find("title");
                    const auto subject = session.fields.find("subject");
                    const std::string displayTitle = title == session.fields.end() ? "Untitled session" : title->second;
                    const std::string displaySubject = subject == session.fields.end() ? "Session" : subject->second;
                    sessionChoices.emplace_back(displaySubject + " · " + displayTitle + " · " + tutorux::archive::uuidToString(session.id));
                }
            }
            auto guides = opened->list(tutorux::archive::RecordType::Guide);
            if (guides) {
                guideChoices.reserve(guides->size());
                for (const auto& guide : *guides) {
                    const auto title = guide.fields.find("title");
                    const std::string displayTitle = title == guide.fields.end() ? "Untitled guide" : title->second;
                    guideChoices.emplace_back(displayTitle + " · " + tutorux::archive::uuidToString(guide.id));
                    auto parsedGuide = tutorux::domain::guideFromRecord(guide);
                    if (!parsedGuide)
                        continue;
                    for (std::size_t sectionIndex = 0; sectionIndex < parsedGuide->sections.size(); ++sectionIndex) {
                        const auto& section = parsedGuide->sections[sectionIndex];
                        for (std::size_t blockIndex = 0; blockIndex < section.blocks.size(); ++blockIndex) {
                            const auto& block = section.blocks[blockIndex];
                            const auto kind = tutorux::domain::guideBlockLabel(block.kind);
                            const std::string blockLabel = kind.empty() ? block.kind : std::string(kind);
                            guideBlockChoices.emplace_back(tutorux::archive::uuidToString(guide.id) + "|" + std::to_string(sectionIndex) +
                                                           ":" + std::to_string(blockIndex) + " · " + section.heading + " — " + blockLabel);
                        }
                    }
                }
            }
        }
        window.set_student_options(std::make_shared<slint::VectorModel<slint::SharedString>>(std::move(studentChoices)));
        window.set_selected_student(toSharedString("Anonymous session"));
        window.set_session_options(std::make_shared<slint::VectorModel<slint::SharedString>>(std::move(sessionChoices)));
        const auto selectedSessions = window.get_session_options();
        window.set_selected_session(selectedSessions->row_count() == 0 ? toSharedString("")
                                                                       : selectedSessions->row_data(0).value_or(toSharedString("")));
        window.set_guide_options(std::make_shared<slint::VectorModel<slint::SharedString>>(std::move(guideChoices)));
        const auto selectedGuides = window.get_guide_options();
        window.set_selected_guide(selectedGuides->row_count() == 0 ? toSharedString("")
                                                                   : selectedGuides->row_data(0).value_or(toSharedString("")));
        window.set_guide_block_options(std::make_shared<slint::VectorModel<slint::SharedString>>(std::move(guideBlockChoices)));
        const auto selectedBlocks = window.get_guide_block_options();
        window.set_selected_guide_block(selectedBlocks->row_count() == 0 ? toSharedString("")
                                                                         : selectedBlocks->row_data(0).value_or(toSharedString("")));
        std::array<std::string, 7> shortcuts{"1", "2", "3", "4", "5", "6", "m"};
        if (opened)
            shortcuts = markerShortcuts(*opened);
        window.set_shortcut_concept(toSharedString(shortcuts[0]));
        window.set_shortcut_mistake(toSharedString(shortcuts[1]));
        window.set_shortcut_correction(toSharedString(shortcuts[2]));
        window.set_shortcut_instruction(toSharedString(shortcuts[3]));
        window.set_shortcut_example(toSharedString(shortcuts[4]));
        window.set_shortcut_follow_up(toSharedString(shortcuts[5]));
        window.set_shortcut_note(toSharedString(shortcuts[6]));
        const bool encrypted = opened && opened->encrypted();
        window.set_archive_status(
            toSharedString(std::string(writableOnDisk ? "Read/Write" : "Read-only") + (encrypted ? " · Encrypted" : " · Unencrypted")));
    }

    std::optional<std::filesystem::path> initialArchive(const std::optional<std::filesystem::path>& requested,
                                                        const std::filesystem::path& directory) {
        if (requested)
            return requested;
        auto archives = Archive::discover(directory);
        if (!archives)
            return std::nullopt;
        if (archives->size() == 1) {
            const auto& only = archives->front();
            if (only.healthStatus == "healthy" || only.healthStatus == "locked" || only.metadataOnly) {
                return only.path;
            }
        }
        return std::nullopt;
    }

} // namespace

int launchDesktop(std::optional<std::filesystem::path> archivePath, std::optional<std::filesystem::path> directoryPath) {
    auto window = MainWindow::create();
    auto directory = directoryPath ? std::filesystem::absolute(*directoryPath) : std::filesystem::current_path();
    if (archivePath && archivePath->is_relative())
        archivePath = directory / *archivePath;
    auto archives = Archive::discover(directory);
    std::string startupMessage = "Your tutoring data stays in the selected .tux archive.";
    if (!archivePath && archives && archives->empty())
        startupMessage = "No archive was found. Choose a name and create a workspace to begin.";
    window->set_archive_list(toSharedString(archives ? archiveChoices(*archives) : archives.error().message));
    window->set_archive_paths(archivePathChoices(archives ? *archives : std::vector<ArchiveInfo>{}));
    window->set_archive_path(toSharedString(archivePath ? archivePath->string() : ""));
    window->set_archive_name(toSharedString("Tutorux.tux"));
    window->set_archive_status(toSharedString("No archive selected"));
    window->set_students_text(toSharedString("Choose an archive to view students."));
    window->set_sessions_text(toSharedString("Choose an archive to view sessions."));
    window->set_journal_list_output(toSharedString("Open an archive to see journal entries."));
    window->set_journal_entry_options(std::make_shared<slint::VectorModel<slint::SharedString>>());
    window->set_journal_collection_options(
        std::make_shared<slint::VectorModel<slint::SharedString>>(std::vector<slint::SharedString>{toSharedString("All collections")}));
    window->set_journal_tag_options(
        std::make_shared<slint::VectorModel<slint::SharedString>>(std::vector<slint::SharedString>{toSharedString("All tags")}));
    window->set_selected_journal_entry(toSharedString(""));
    window->set_journal_timeline_output(toSharedString("Open an entry to view its sessions."));
    window->set_journal_session_options(std::make_shared<slint::VectorModel<slint::SharedString>>());
    window->set_selected_journal_session(toSharedString(""));
    window->set_journal_document_blocks_json(toSharedString("[]"));
    window->set_journal_note_block_options(std::make_shared<slint::VectorModel<slint::SharedString>>());
    window->set_selected_journal_note_block(toSharedString(""));
    window->set_journal_document_block_text(toSharedString(""));
    window->set_journal_document_block_anchor_offset(0);
    window->set_journal_document_block_focus_offset(0);
    window->set_journal_document_block_index(-1);
    window->set_journal_document_block_count(0);
    window->set_transcript_options(std::make_shared<slint::VectorModel<slint::SharedString>>());
    window->set_selected_transcript(toSharedString(""));
    window->set_transcript_edit_text(toSharedString(""));
    window->set_transcript_provenance(toSharedString("Choose a session and load a segment."));
    window->set_session_options(std::make_shared<slint::VectorModel<slint::SharedString>>());
    window->set_selected_session(toSharedString(""));
    clearAssetPanel(*window, "Choose a session, list its materials, then preview a selected file.");
    window->set_guide_options(std::make_shared<slint::VectorModel<slint::SharedString>>());
    window->set_selected_guide(toSharedString(""));
    window->set_guide_block_options(std::make_shared<slint::VectorModel<slint::SharedString>>());
    window->set_selected_guide_block(toSharedString(""));
    window->set_guide_edit_text(toSharedString(""));
    window->set_guide_provenance(toSharedString("Load a guide block to edit its text."));
    window->set_guide_output(toSharedString("Choose an archive to view study guides."));
    window->set_student_options(
        std::make_shared<slint::VectorModel<slint::SharedString>>(std::vector<slint::SharedString>{toSharedString("Anonymous session")}));
    window->set_selected_student(toSharedString("Anonymous session"));
    window->set_selected_archive(toSharedString("No archive selected"));
    window->set_status_message(toSharedString(startupMessage));
    std::string activePassphrase;

    auto selected = initialArchive(archivePath, directory);
    if (!selected)
        window->set_active_view(toSharedString("archive"));
    if (selected) {
        auto info = tutorux::archive::inspectArchive(*selected);
        if (info) {
            directory = info->path.parent_path();
            if (info->metadataOnly) {
                showMetadataOnlyArchive(*window, *info);
            } else if (info->healthStatus == "locked") {
                showLockedArchive(*window, *info);
                refreshArchiveRecoveryState(*window, info->path);
            } else {
                refreshWorkspace(*window, info->path);
                refreshArchiveRecoveryState(*window, info->path);
                window->set_active_view(toSharedString(info->recoveryNeeded ? "archive" : "journal"));
            }
        } else {
            window->set_status_message(toSharedString(info.error().message));
        }
    }

    window->on_open_archive([&](slint::SharedString requestedPath, slint::SharedString requestedPassphrase) {
        std::filesystem::path path(requestedPath.data());
        if (path.is_relative())
            path = directory / path;
        std::string passphrase(requestedPassphrase.data(), requestedPassphrase.size());
        auto info = tutorux::archive::inspectArchive(path, passphrase);
        if (!info) {
            eraseSecret(passphrase);
            window->set_status_message(toSharedString(info.error().message));
            return;
        }
        if (info->metadataOnly) {
            directory = info->path.parent_path();
            eraseSecret(activePassphrase);
            window->set_archive_passphrase(toSharedString(""));
            eraseSecret(passphrase);
            showMetadataOnlyArchive(*window, *info);
            return;
        }
        if (info->healthStatus == "locked") {
            directory = info->path.parent_path();
            eraseSecret(activePassphrase);
            window->set_archive_passphrase(toSharedString(""));
            eraseSecret(passphrase);
            showLockedArchive(*window, *info);
            refreshArchiveRecoveryState(*window, info->path);
            return;
        }
        directory = info->path.parent_path();
        eraseSecret(activePassphrase);
        auto opened = Archive::open(info->path, false, passphrase);
        if (!opened) {
            eraseSecret(passphrase);
            window->set_status_message(toSharedString(opened.error().message));
            return;
        }
        if (opened->encrypted())
            activePassphrase = std::move(passphrase);
        eraseSecret(passphrase);
        window->set_archive_passphrase(toSharedString(""));
        refreshWorkspace(*window, info->path, activePassphrase);
        refreshArchiveRecoveryState(*window, info->path, activePassphrase);
        window->set_active_view(toSharedString(info->recoveryNeeded ? "archive" : "journal"));
        window->set_status_message(toSharedString(info->recoveryNeeded
                                                      ? "Archive opened read-only. Review the recovery options before editing."
                                                      : "Archive opened. Changes save directly to this file."));
    });

    window->on_archive_recovery_action([&](slint::SharedString requestedAction) {
        const std::filesystem::path path(window->get_archive_path().data());
        if (path.empty()) {
            window->set_status_message(toSharedString("Choose an archive before recovery."));
            return;
        }
        const std::string action(requestedAction.data(), requestedAction.size());
        std::vector<std::string> arguments{"archive", "recover"};
        if (action == "recover-unpublished")
            arguments.emplace_back("--recover-unpublished");
        else if (action == "discard-tail")
            arguments.emplace_back("--discard-tail");
        else {
            window->set_status_message(toSharedString("Unknown archive recovery action."));
            return;
        }

        auto recovered = dispatchWithSecrets(archiveCommand(path, std::move(arguments)), activePassphrase);
        if (!recovered || recovered->exitCode != 0) {
            window->set_status_message(toSharedString(commandOutput(std::move(recovered))));
            return;
        }
        refreshWorkspace(*window, path, activePassphrase);
        refreshArchiveRecoveryState(*window, path, activePassphrase);
        const bool recoveryStillNeeded = window->get_archive_recovery_needed();
        auto archiveState = tutorux::archive::inspectArchive(path, activePassphrase);
        const bool archiveStillLocked = archiveState && archiveState->healthStatus == "locked";
        window->set_active_view(toSharedString(recoveryStillNeeded || archiveStillLocked ? "archive" : "journal"));
        if (archiveStillLocked) {
            window->set_archive_status(toSharedString("Locked · Encrypted"));
            window->set_students_text(toSharedString("Unlock the archive to view students."));
            window->set_sessions_text(toSharedString("Unlock the archive to view sessions."));
        }
        window->set_status_message(toSharedString(commandOutput(std::move(recovered))));
    });

    window->on_forget_passphrase([&]() {
        eraseSecret(activePassphrase);
        window->set_archive_passphrase(toSharedString(""));
        const std::filesystem::path path(window->get_archive_path().data());
        auto info = tutorux::archive::inspectArchive(path);
        if (info && info->healthStatus == "locked") {
            window->set_archive_status(toSharedString("Locked · Encrypted"));
            window->set_students_text(toSharedString("Unlock the archive to view students."));
            window->set_sessions_text(toSharedString("Unlock the archive to view sessions."));
            refreshArchiveRecoveryState(*window, path);
            window->set_status_message(toSharedString("Passphrase cleared. Archive is locked."));
        } else {
            if (info)
                refreshArchiveRecoveryState(*window, info->path);
            window->set_status_message(toSharedString("Passphrase cleared from memory."));
        }
    });

    window->on_create_archive([&](slint::SharedString requestedName, slint::SharedString requestedPassphrase) {
        std::string name(requestedName.data());
        if (name.empty())
            name = "Tutorux.tux";
        std::filesystem::path path(name);
        std::string extension = path.extension().string();
        std::transform(extension.begin(), extension.end(), extension.begin(), [](unsigned char character) {
            return static_cast<char>(std::tolower(character));
        });
        if (extension != ".tux")
            path += ".tux";
        if (path.is_relative())
            path = directory / path;
        auto created = command::dispatch({"archive", "init", path.string(), "--name", path.stem().string()});
        if (!created) {
            window->set_status_message(toSharedString(created.error().message));
            return;
        }
        std::string newPassphrase(requestedPassphrase.data(), requestedPassphrase.size());
        if (!newPassphrase.empty()) {
            auto encrypted = dispatchWithSecrets({"archive", "encrypt", path.string()}, {}, newPassphrase);
            if (!encrypted || encrypted->exitCode != 0) {
                eraseSecret(newPassphrase);
                window->set_status_message(toSharedString(commandOutput(std::move(encrypted))));
                return;
            }
            eraseSecret(activePassphrase);
            activePassphrase = std::move(newPassphrase);
        }
        eraseSecret(newPassphrase);
        window->set_new_archive_passphrase(toSharedString(""));
        refreshWorkspace(*window, path, activePassphrase);
        refreshArchiveRecoveryState(*window, path, activePassphrase);
        window->set_active_view(toSharedString("journal"));
        window->set_status_message(toSharedString("Archive created and selected."));
    });

    std::string sanitizedPreviewGeneration;
    std::string sanitizedPreviewFingerprint;
    std::string sanitizedPreviewRequest;
    window->on_sanitized_copy(
        [&](slint::SharedString requestedOutput, slint::SharedString includeStudents, slint::SharedString excludeStudents,
            slint::SharedString includeSessions, slint::SharedString excludeSessions, slint::SharedString includeRecordingTracks,
            slint::SharedString excludeRecordingTracks, bool includeRecordings, bool includePrivateAnnotations, bool includeGenerationLogs,
            bool includeCredentials, slint::SharedString requestedPassphrase, bool confirm) {
            const auto toString = [](const slint::SharedString& value) {
                return std::string(value.data(), value.size());
            };
            const std::string outputText = toString(requestedOutput);
            if (outputText.empty()) {
                window->set_sanitized_copy_ready(false);
                window->set_sanitized_copy_status(toSharedString("Choose a .tux output path."));
                return;
            }
            std::filesystem::path sourcePath(window->get_archive_path().data());
            if (sourcePath.empty()) {
                window->set_sanitized_copy_ready(false);
                window->set_sanitized_copy_status(toSharedString("Open an archive before creating a sanitized copy."));
                return;
            }
            if (sourcePath.is_relative())
                sourcePath = directory / sourcePath;
            std::filesystem::path outputPath(outputText);
            if (outputPath.is_relative())
                outputPath = directory / outputPath;

            const std::string includeStudentText = toString(includeStudents);
            const std::string excludeStudentText = toString(excludeStudents);
            const std::string includeSessionText = toString(includeSessions);
            const std::string excludeSessionText = toString(excludeSessions);
            const std::string includeRecordingTrackText = toString(includeRecordingTracks);
            const std::string excludeRecordingTrackText = toString(excludeRecordingTracks);
            std::string requestKey;
            const auto appendKey = [&](std::string_view value) {
                requestKey += std::to_string(value.size());
                requestKey.push_back(':');
                requestKey.append(value);
                requestKey.push_back(';');
            };
            appendKey(sourcePath.string());
            appendKey(outputPath.string());
            appendKey(includeStudentText);
            appendKey(excludeStudentText);
            appendKey(includeSessionText);
            appendKey(excludeSessionText);
            appendKey(includeRecordingTrackText);
            appendKey(excludeRecordingTrackText);
            appendKey(includeRecordings ? "1" : "0");
            appendKey(includePrivateAnnotations ? "1" : "0");
            appendKey(includeGenerationLogs ? "1" : "0");
            appendKey(includeCredentials ? "1" : "0");

            if (confirm &&
                (sanitizedPreviewRequest != requestKey || sanitizedPreviewGeneration.empty() || sanitizedPreviewFingerprint.empty())) {
                window->set_sanitized_copy_ready(false);
                window->set_sanitized_copy_status(toSharedString("The selection changed or has no preview. Preview again before "
                                                                 "creating the copy."));
                return;
            }

            std::vector<std::string> arguments{"--json", "archive", "sanitize", sourcePath.string(), "--output", outputPath.string()};
            const auto addOption = [&](std::string_view name, const std::string& value) {
                if (!value.empty()) {
                    arguments.emplace_back("--" + std::string(name));
                    arguments.push_back(value);
                }
            };
            addOption("include-students", includeStudentText);
            addOption("exclude-students", excludeStudentText);
            addOption("include-sessions", includeSessionText);
            addOption("exclude-sessions", excludeSessionText);
            addOption("include-recording-tracks", includeRecordingTrackText);
            addOption("exclude-recording-tracks", excludeRecordingTrackText);
            if (includeRecordings)
                arguments.emplace_back("--include-recordings");
            if (includePrivateAnnotations)
                arguments.emplace_back("--include-private-annotations");
            if (includeGenerationLogs)
                arguments.emplace_back("--include-generation-logs");
            if (includeCredentials)
                arguments.emplace_back("--include-credentials");
            if (confirm) {
                arguments.emplace_back("--confirm-sensitive");
                arguments.emplace_back("--expected-generation");
                arguments.push_back(sanitizedPreviewGeneration);
                arguments.emplace_back("--expected-selection");
                arguments.push_back(sanitizedPreviewFingerprint);
                arguments.emplace_back("--expected-output");
                arguments.push_back(outputPath.string());
            }

            std::string destinationPassphrase = confirm ? toString(requestedPassphrase) : std::string{};
            auto response = dispatchWithSecrets(arguments, activePassphrase, destinationPassphrase);
            eraseSecret(destinationPassphrase);
            if (confirm)
                window->set_sanitized_copy_passphrase(toSharedString(""));
            if (!response || response->exitCode != 0) {
                window->set_sanitized_copy_ready(false);
                window->set_sanitized_copy_status(toSharedString(commandOutput(std::move(response))));
                sanitizedPreviewGeneration.clear();
                sanitizedPreviewFingerprint.clear();
                sanitizedPreviewRequest.clear();
                return;
            }
            const std::string output = response->output;
            if (!confirm) {
                const auto generation = jsonStringField(output, "source_generation");
                const auto fingerprint = jsonStringField(output, "selection_fingerprint");
                if (!generation || !fingerprint) {
                    window->set_sanitized_copy_ready(false);
                    window->set_sanitized_copy_status(toSharedString("Preview response was incomplete. Preview again."));
                    return;
                }
                sanitizedPreviewGeneration = *generation;
                sanitizedPreviewFingerprint = *fingerprint;
                sanitizedPreviewRequest = requestKey;
                window->set_sanitized_copy_ready(true);
                const auto count = [&](std::string_view field) {
                    return jsonStringField(output, field).value_or("0");
                };
                const std::string previewSummary =
                    "Preview ready for source generation " + *generation + ". Students " + count("students") + ", sessions " +
                    count("sessions") + ", annotations " + count("annotations") + ", assets " + count("assets") + ", evidence " +
                    count("evidence_items") + ", guides " + count("guides") + ", recording tracks " + count("recording_tracks") +
                    ", recording chunks " + count("recording_chunks") + ", generation logs " + count("generation_logs") + ", credentials " +
                    count("credentials") + ". Create only after reviewing these counts.";
                window->set_sanitized_copy_status(toSharedString(previewSummary));
                return;
            }
            sanitizedPreviewGeneration.clear();
            sanitizedPreviewFingerprint.clear();
            sanitizedPreviewRequest.clear();
            window->set_sanitized_copy_ready(false);
            window->set_sanitized_copy_status(toSharedString("Sanitized copy created at " + outputPath.string() + "."));
            window->set_status_message(toSharedString("Sanitized archive created."));
        });

    window->on_journal_action([&](slint::SharedString requestedAction, slint::SharedString first, slint::SharedString second,
                                  slint::SharedString third, slint::SharedString fourth, slint::SharedString fifth,
                                  slint::SharedString sixth) {
        const auto text = [](const slint::SharedString& value) {
            return std::string(value.data(), value.size());
        };
        const std::string action = text(requestedAction);
        const std::array<std::string, 6> values{text(first), text(second), text(third), text(fourth), text(fifth), text(sixth)};
        std::vector<std::string> arguments;
        const auto addOption = [&](std::string_view name, const std::string& value) {
            if (value.empty())
                return;
            arguments.emplace_back("--" + std::string(name));
            arguments.push_back(value);
        };

        if (action == "document-block-format") {
            const std::string blockId = selectionId(toSharedString(values[1]));
            const auto blocksJsonShared = window->get_journal_document_blocks_json();
            const std::string blocksJson(blocksJsonShared.data(), blocksJsonShared.size());
            const auto blockKind = window->get_journal_document_block_kind();
            const bool validFormat =
                (values[2] == "bold" || values[2] == "italic" || values[2] == "strike" || values[2] == "code" || values[2] == "link") &&
                std::string(blockKind.data(), blockKind.size()) != "Code";
            if (!tutorux::archive::uuidFromString(values[0]) || values[0] != text(window->get_journal_document_id()) ||
                !tutorux::archive::uuidFromString(blockId) || !journalNoteBlockIndex(blocksJson, blockId) || !validFormat) {
                window->set_status_message(toSharedString("Select a loaded notes block before applying inline formatting."));
                return;
            }
            const auto currentText = window->get_journal_document_block_text();
            auto formatted =
                formatJournalText(std::string(currentText.data(), currentText.size()), window->get_journal_document_block_anchor_offset(),
                                  window->get_journal_document_block_focus_offset(), values[2]);
            window->set_journal_document_block_text(toSharedString(formatted.text));
            window->set_journal_document_block_anchor_offset(formatted.anchor);
            window->set_journal_document_block_focus_offset(formatted.focus);
            window->set_status_message(toSharedString("Formatting applied. Save the block to write the changes to the journal."));
            return;
        } else if (action == "document-block-select") {
            setSelectedJournalNoteBlock(*window, selectionId(toSharedString(values[1])));
            return;
        } else if (action == "entry-list") {
            arguments = {"--json", "journal", "entry", "list"};
            addOption("query", values[0]);
            addOption("collection-id", journalTaxonomyFilterId(values[1]));
            addOption("tag-id", journalTaxonomyFilterId(values[2]));
            addOption("from", values[3]);
            addOption("to", values[4]);
            if (values[5] == "with sessions")
                arguments.insert(arguments.end(), {"--has-sessions", "true"});
            else if (values[5] == "without sessions")
                arguments.insert(arguments.end(), {"--has-sessions", "false"});
        } else if (action == "entry-create") {
            if (values[0].empty()) {
                window->set_status_message(toSharedString("Enter an entry title first."));
                return;
            }
            arguments = {"--json", "journal", "entry", "create", "--title", values[0]};
            addOption("date", values[1]);
            addOption("collection-ids", values[2]);
            addOption("tag-ids", values[3]);
        } else if (action == "entry-show") {
            const auto selectedEntryId = tutorux::archive::uuidFromString(values[0]) ? values[0] : selectionId(toSharedString(values[0]));
            if (!tutorux::archive::uuidFromString(selectedEntryId)) {
                window->set_status_message(toSharedString("Enter a valid entry ID first."));
                return;
            }
            arguments = {"--json", "journal", "entry", "show", selectedEntryId};
            window->set_selected_journal_entry(toSharedString(values[0]));
        } else if (action == "entry-update") {
            if (!tutorux::archive::uuidFromString(values[0])) {
                window->set_status_message(toSharedString("Enter a valid entry ID first."));
                return;
            }
            arguments = {"--json", "journal", "entry", "update", values[0]};
            addOption("title", values[1]);
            addOption("date", values[2]);
            addOption("collection-ids", values[3]);
            addOption("tag-ids", values[4]);
            if (arguments.size() == 5) {
                window->set_status_message(toSharedString("Enter at least one entry change."));
                return;
            }
        } else if (action == "entry-clear-date") {
            if (!tutorux::archive::uuidFromString(values[0])) {
                window->set_status_message(toSharedString("Enter a valid entry ID first."));
                return;
            }
            arguments = {"--json", "journal", "entry", "update", values[0], "--clear-date"};
        } else if (action == "entry-delete") {
            if (!tutorux::archive::uuidFromString(values[0])) {
                window->set_status_message(toSharedString("Enter a valid entry ID first."));
                return;
            }
            arguments = {"journal", "entry", "delete", values[0]};
        } else if (action == "session-create") {
            if (!tutorux::archive::uuidFromString(values[0])) {
                window->set_status_message(toSharedString("Open an entry before adding a session."));
                return;
            }
            std::string studentId = "anonymous";
            if (!values[3].empty() && values[3] != "Anonymous session") {
                studentId = selectionId(toSharedString(values[3]));
                if (!tutorux::archive::uuidFromString(studentId)) {
                    window->set_status_message(toSharedString("Select a student from this archive before creating the session."));
                    return;
                }
            }
            arguments = {"--json", "session", "create", "--entry-id", values[0], "--type", values[1]};
            addOption("title", values[2]);
            addOption("student-id", studentId);
            addOption("subject", values[4]);
            addOption("objectives", values[5]);
        } else if (action == "session-list") {
            if (!tutorux::archive::uuidFromString(values[0])) {
                window->set_status_message(toSharedString("Open an entry to view its timeline."));
                return;
            }
            arguments = {"--json", "session", "list", "--entry-id", values[0]};
        } else if (action == "session-resume" || action == "session-complete" || action == "session-review" ||
                   action == "session-delete-preview" || action == "session-delete-confirm") {
            const auto selectedSessionId = tutorux::archive::uuidFromString(values[0]) ? values[0] : selectionId(toSharedString(values[0]));
            if (!tutorux::archive::uuidFromString(selectedSessionId)) {
                window->set_status_message(toSharedString("Enter a valid session ID first."));
                return;
            }
            window->set_journal_session_id(toSharedString(selectedSessionId));
            const bool isDeletePreview = action == "session-delete-preview";
            const bool isDeleteConfirmation = action == "session-delete-confirm";
            const auto reviewedSessionId = window->get_journal_session_delete_preview_id();
            if (isDeleteConfirmation &&
                (!window->get_journal_session_delete_scope_reviewed() ||
                 std::string(reviewedSessionId.data(), reviewedSessionId.size()) != selectedSessionId || values[1].empty())) {
                window->set_status_message(toSharedString("Review the deletion scope for this session first."));
                return;
            }
            const std::string operation = action == "session-review"                  ? "review"
                                          : (isDeletePreview || isDeleteConfirmation) ? "delete"
                                                                                      : action.substr(std::string("session-").size());
            if (isDeletePreview) {
                window->set_journal_session_delete_scope_reviewed(false);
                window->set_journal_session_delete_preview_id(toSharedString(""));
                window->set_journal_session_delete_scope_output(toSharedString("Loading the records linked to this session…"));
            } else if (isDeleteConfirmation) {
                window->set_journal_session_delete_scope_reviewed(false);
                window->set_journal_session_delete_scope_output(toSharedString("Confirming the reviewed deletion scope…"));
            }
            arguments = {"session", operation, selectedSessionId};
            if (isDeletePreview || isDeleteConfirmation)
                arguments.insert(arguments.begin(), "--json");
            if (isDeleteConfirmation) {
                arguments.insert(arguments.end(), {"--confirm-scope", "--scope-token", values[1]});
                window->set_journal_session_delete_scope_token(toSharedString(""));
            }
        } else if (action == "document-show") {
            if (!tutorux::archive::uuidFromString(values[0])) {
                window->set_status_message(toSharedString("Enter a valid notes document ID."));
                return;
            }
            arguments = {"--json", "journal", "document", "show", values[0]};
        } else if (action == "document-update") {
            if (!tutorux::archive::uuidFromString(values[0])) {
                window->set_status_message(toSharedString("Enter a valid notes document ID."));
                return;
            }
            arguments = {"journal", "document", "update", values[0], "--text", values[1]};
        } else if (action == "document-block-add") {
            if (!tutorux::archive::uuidFromString(values[0])) {
                window->set_status_message(toSharedString("Load a notes document before adding a block."));
                return;
            }
            const std::string kind = journalNoteKindValue(values[1]);
            if (kind.empty() || !tutorux::domain::isValidJournalNoteBlockKind(kind)) {
                window->set_status_message(toSharedString("Choose a valid notes block type."));
                return;
            }
            if (values[2].empty()) {
                window->set_status_message(toSharedString("Enter text for the new notes block."));
                return;
            }
            arguments = {"--json", "journal", "document", "add-block", values[0], "--kind", kind, "--text", values[2]};
            const auto selectedId = selectionId(toSharedString(values[3]));
            const auto blocksJsonShared = window->get_journal_document_blocks_json();
            const std::string blocksJson(blocksJsonShared.data(), blocksJsonShared.size());
            const auto blockIndex = journalNoteBlockIndex(blocksJson, selectedId);
            if (blockIndex) {
                arguments.emplace_back("--block-index");
                arguments.push_back(std::to_string(*blockIndex + 1));
            }
        } else if (action == "document-block-update") {
            if (!tutorux::archive::uuidFromString(values[0])) {
                window->set_status_message(toSharedString("Load a notes document before editing a block."));
                return;
            }
            const std::string blockId = selectionId(toSharedString(values[1]));
            const std::string kind = journalNoteKindValue(values[2]);
            if (!tutorux::archive::uuidFromString(blockId) || kind.empty() || !tutorux::domain::isValidJournalNoteBlockKind(kind)) {
                window->set_status_message(toSharedString("Select a notes block and a valid type."));
                return;
            }
            arguments = {"--json", "journal", "document", "update", values[0], "--block-id", blockId, "--kind", kind, "--text", values[3]};
        } else if (action == "document-block-remove") {
            if (!tutorux::archive::uuidFromString(values[0])) {
                window->set_status_message(toSharedString("Load a notes document before removing a block."));
                return;
            }
            const std::string blockId = selectionId(toSharedString(values[1]));
            if (!tutorux::archive::uuidFromString(blockId)) {
                window->set_status_message(toSharedString("Select a notes block to remove."));
                return;
            }
            arguments = {"--json", "journal", "document", "remove-block", values[0], "--block-id", blockId};
        } else if (action == "document-block-move") {
            if (!tutorux::archive::uuidFromString(values[0])) {
                window->set_status_message(toSharedString("Load a notes document before moving a block."));
                return;
            }
            const std::string blockId = selectionId(toSharedString(values[1]));
            const auto blocksJsonShared = window->get_journal_document_blocks_json();
            const std::string blocksJson(blocksJsonShared.data(), blocksJsonShared.size());
            const auto blockIndex = journalNoteBlockIndex(blocksJson, blockId);
            if (!blockIndex || (values[2] != "up" && values[2] != "down")) {
                window->set_status_message(toSharedString("Select a notes block and a valid move."));
                return;
            }
            const auto blockCount = journalNoteBlocks(blocksJson).size();
            if ((values[2] == "up" && *blockIndex == 0) || (values[2] == "down" && *blockIndex + 1 >= blockCount)) {
                window->set_status_message(toSharedString("That block is already at the edge of the document."));
                return;
            }
            const std::size_t targetIndex = values[2] == "up" ? *blockIndex - 1 : *blockIndex + 1;
            arguments = {"--json",
                         "journal",
                         "document",
                         "move-block",
                         values[0],
                         "--from",
                         std::to_string(*blockIndex),
                         "--to",
                         std::to_string(targetIndex)};
        } else if (action == "guide-generate-entry") {
            if (!tutorux::archive::uuidFromString(values[0])) {
                window->set_status_message(toSharedString("Open an entry before generating its guide."));
                return;
            }
            arguments = {"--json", "guide", "generate", "--entry-id", values[0]};
        } else if (action == "collection-list") {
            arguments = {"journal", "collection", "list"};
        } else if (action == "tag-list") {
            arguments = {"journal", "tag", "list"};
        } else if (action == "collection-create" || action == "tag-create") {
            if (values[0].empty()) {
                window->set_status_message(toSharedString("Enter a collection or tag name."));
                return;
            }
            arguments = {"journal", action == "collection-create" ? "collection" : "tag", "create", "--name", values[0]};
            addOption("description", values[1]);
            addOption("color", values[2]);
        } else if (action == "collection-update" || action == "tag-update") {
            if (!tutorux::archive::uuidFromString(values[0])) {
                window->set_status_message(toSharedString("Enter a valid collection or tag ID."));
                return;
            }
            arguments = {"journal", action == "collection-update" ? "collection" : "tag", "update", values[0]};
            addOption("name", values[1]);
            addOption("description", values[2]);
            addOption("color", values[3]);
            if (arguments.size() == 4) {
                window->set_status_message(toSharedString("Enter at least one change."));
                return;
            }
        } else if (action == "collection-delete" || action == "tag-delete") {
            if (!tutorux::archive::uuidFromString(values[0])) {
                window->set_status_message(toSharedString("Enter a valid collection or tag ID."));
                return;
            }
            arguments = {"journal", action == "collection-delete" ? "collection" : "tag", "delete", values[0]};
        } else {
            window->set_status_message(toSharedString("Unsupported journal action."));
            return;
        }

        const std::string requestedCommand = commandLineFromArguments(arguments);
        window->set_command_input(toSharedString(requestedCommand));
        window->set_status_message(toSharedString("Working in the selected journal archive."));
        window->invoke_run_command(toSharedString(requestedCommand), toSharedString(""));
    });

    window->on_create_student([&](slint::SharedString requestedName, slint::SharedString requestedGrade,
                                  slint::SharedString requestedSubjects, slint::SharedString requestedObjectives,
                                  slint::SharedString requestedDifficulties, slint::SharedString requestedNotes) {
        if (requestedName.empty()) {
            window->set_status_message(toSharedString("Enter a student name first."));
            return;
        }
        const std::filesystem::path path(window->get_archive_path().data());
        if (path.empty()) {
            window->set_status_message(toSharedString("Choose an archive before adding a student."));
            return;
        }
        auto arguments = archiveCommand(path, {"student", "create", "--name", std::string(requestedName.data())});
        const auto appendOption = [&](std::string_view name, const slint::SharedString& value) {
            if (value.empty())
                return;
            arguments.emplace_back("--" + std::string(name));
            arguments.emplace_back(value.data(), value.size());
        };
        appendOption("grade", requestedGrade);
        appendOption("subjects", requestedSubjects);
        appendOption("objectives", requestedObjectives);
        appendOption("difficulties", requestedDifficulties);
        appendOption("notes", requestedNotes);
        auto created = dispatchWithSecrets(arguments, activePassphrase);
        window->set_status_message(toSharedString(commandOutput(std::move(created))));
        refreshWorkspace(*window, path, activePassphrase);
        window->set_student_name(toSharedString(""));
        window->set_student_grade(toSharedString(""));
        window->set_student_subjects(toSharedString(""));
        window->set_student_objectives(toSharedString(""));
        window->set_student_difficulties(toSharedString(""));
        window->set_student_notes(toSharedString(""));
    });

    window->on_load_student_progress([&](slint::SharedString selectedStudent) {
        const std::string studentId = selectionId(selectedStudent);
        if (studentId.empty()) {
            window->set_student_progress_output(toSharedString("Select a student from this archive first."));
            return;
        }
        const std::filesystem::path path(window->get_archive_path().data());
        if (path.empty()) {
            window->set_student_progress_output(toSharedString("Choose an archive first."));
            return;
        }
        auto loaded = dispatchWithSecrets(archiveCommand(path, {"student", "progress", studentId}), activePassphrase);
        window->set_student_progress_output(toSharedString(commandOutput(std::move(loaded))));
        auto profile = dispatchWithSecrets(archiveCommand(path, {"student", "show", studentId, "--json"}), activePassphrase);
        const std::string profileOutput = commandOutput(std::move(profile));
        const auto setProfileField = [&](std::string_view name, auto setter) {
            setter(toSharedString(jsonStringField(profileOutput, name).value_or("")));
        };
        setProfileField("display_name", [&](slint::SharedString value) {
            window->set_student_profile_name(value);
        });
        setProfileField("grade", [&](slint::SharedString value) {
            window->set_student_profile_grade(value);
        });
        setProfileField("subjects", [&](slint::SharedString value) {
            window->set_student_profile_subjects(value);
        });
        setProfileField("learning_objectives", [&](slint::SharedString value) {
            window->set_student_profile_objectives(value);
        });
        setProfileField("known_difficulties", [&](slint::SharedString value) {
            window->set_student_profile_difficulties(value);
        });
        setProfileField("demonstrated_improvements", [&](slint::SharedString value) {
            window->set_student_profile_improvements(value);
        });
        setProfileField("preferred_guide_template", [&](slint::SharedString value) {
            window->set_student_profile_template(value);
        });
        setProfileField("tutor_notes", [&](slint::SharedString value) {
            window->set_student_profile_notes(value);
        });
    });

    window->on_review_student_progress([&](slint::SharedString selectedStudent, slint::SharedString requestedSkill,
                                           slint::SharedString requestedClassification, slint::SharedString requestedEvidence,
                                           slint::SharedString requestedReviewer, slint::SharedString requestedNote) {
        const std::string studentId = selectionId(selectedStudent);
        if (studentId.empty()) {
            window->set_student_progress_output(toSharedString("Select a student from this archive first."));
            return;
        }
        if (requestedSkill.empty() || requestedEvidence.empty() || requestedReviewer.empty()) {
            window->set_student_progress_output(toSharedString("Enter a skill, evidence UUIDs, and your tutor review label."));
            return;
        }
        const std::filesystem::path path(window->get_archive_path().data());
        if (path.empty()) {
            window->set_student_progress_output(toSharedString("Choose an archive first."));
            return;
        }
        auto reviewed =
            dispatchWithSecrets(archiveCommand(path, {"student", "progress-review", studentId, "--skill",
                                                      std::string(requestedSkill.data(), requestedSkill.size()), "--classification",
                                                      std::string(requestedClassification.data(), requestedClassification.size()),
                                                      "--evidence-ids", std::string(requestedEvidence.data(), requestedEvidence.size()),
                                                      "--reviewed-by", std::string(requestedReviewer.data(), requestedReviewer.size()),
                                                      "--note", std::string(requestedNote.data(), requestedNote.size())}),
                                activePassphrase);
        const std::string reviewOutput = commandOutput(std::move(reviewed));
        window->set_status_message(toSharedString(reviewOutput));
        auto refreshed = dispatchWithSecrets(archiveCommand(path, {"student", "progress", studentId}), activePassphrase);
        window->set_student_progress_output(toSharedString(commandOutput(std::move(refreshed))));
    });

    window->on_save_student_profile([&](slint::SharedString selectedStudent, slint::SharedString requestedName,
                                        slint::SharedString requestedGrade, slint::SharedString requestedSubjects,
                                        slint::SharedString requestedObjectives, slint::SharedString requestedDifficulties,
                                        slint::SharedString requestedImprovements, slint::SharedString requestedTemplate,
                                        slint::SharedString requestedNotes) {
        const std::string studentId = selectionId(selectedStudent);
        if (studentId.empty() || requestedName.empty()) {
            window->set_student_progress_output(toSharedString("Select a student and enter a name before saving."));
            return;
        }
        const std::filesystem::path path(window->get_archive_path().data());
        if (path.empty()) {
            window->set_student_progress_output(toSharedString("Choose an archive first."));
            return;
        }
        auto updated = dispatchWithSecrets(
            archiveCommand(path, {"student", "update", studentId, "--name", std::string(requestedName.data(), requestedName.size()),
                                  "--grade", std::string(requestedGrade.data(), requestedGrade.size()), "--subjects",
                                  std::string(requestedSubjects.data(), requestedSubjects.size()), "--objectives",
                                  std::string(requestedObjectives.data(), requestedObjectives.size()), "--difficulties",
                                  std::string(requestedDifficulties.data(), requestedDifficulties.size()), "--demonstrated-improvements",
                                  std::string(requestedImprovements.data(), requestedImprovements.size()), "--preferred-guide-template",
                                  std::string(requestedTemplate.data(), requestedTemplate.size()), "--notes",
                                  std::string(requestedNotes.data(), requestedNotes.size())}),
            activePassphrase);
        const bool succeeded = updated && updated->exitCode == 0;
        const std::string output = commandOutput(std::move(updated));
        window->set_status_message(toSharedString(output));
        if (!succeeded) {
            window->set_student_progress_output(toSharedString(output));
            return;
        }
        refreshWorkspace(*window, path, activePassphrase);
        window->set_selected_student(toSharedString(std::string(requestedName.data(), requestedName.size()) + " · " + studentId));
        auto progress = dispatchWithSecrets(archiveCommand(path, {"student", "progress", studentId}), activePassphrase);
        window->set_student_progress_output(toSharedString(commandOutput(std::move(progress))));
    });

    window->on_create_session(
        [&](slint::SharedString selectedStudent, slint::SharedString subject, slint::SharedString title, slint::SharedString objectives) {
            const std::filesystem::path path(window->get_archive_path().data());
            if (path.empty()) {
                window->set_status_message(toSharedString("Choose an archive before adding a session."));
                return;
            }
            if (title.empty()) {
                window->set_status_message(toSharedString("Enter a session title first."));
                return;
            }
            std::string studentId = "anonymous";
            const std::string selected(selectedStudent.data(), selectedStudent.size());
            if (!selected.empty() && selected != "Anonymous session") {
                constexpr std::string_view separator = " · ";
                const auto separatorPosition = selected.rfind(separator);
                if (separatorPosition == std::string::npos) {
                    window->set_status_message(toSharedString("Select a student from this archive before creating the session."));
                    return;
                }
                studentId = selected.substr(separatorPosition + separator.size());
                if (!tutorux::archive::uuidFromString(studentId)) {
                    window->set_status_message(toSharedString("The selected student entry is invalid. Refresh the archive."));
                    return;
                }
            }
            auto arguments = archiveCommand(path, {"session", "create", "--student-id", studentId, "--subject", std::string(subject.data()),
                                                   "--title", std::string(title.data())});
            if (!objectives.empty()) {
                arguments.emplace_back("--objectives");
                arguments.emplace_back(objectives.data(), objectives.size());
            }
            auto created = dispatchWithSecrets(arguments, activePassphrase);
            window->set_status_message(toSharedString(commandOutput(std::move(created))));
            refreshWorkspace(*window, path, activePassphrase);
            window->set_session_subject(toSharedString(""));
            window->set_session_title(toSharedString(""));
            window->set_session_objectives(toSharedString(""));
        });

    window->on_open_session([&](slint::SharedString selectedSession) {
        const std::filesystem::path path(window->get_archive_path().data());
        const std::string id = selectionId(selectedSession);
        if (path.empty() || id.empty()) {
            window->set_command_output(toSharedString("Select a session from this archive."));
            return;
        }
        auto command = dispatchWithSecrets(archiveCommand(path, {"session", "show", id}), activePassphrase);
        window->set_command_output(toSharedString(commandOutput(std::move(command))));
    });

    const auto activeTranscriptEditor = std::make_shared<std::optional<ActiveTranscriptEditor>>();
    window->on_review_transcript([&, activeTranscriptEditor](slint::SharedString selectedSession) {
        const std::filesystem::path path(window->get_archive_path().data());
        const std::string id = selectionId(selectedSession);
        if (path.empty() || id.empty()) {
            window->set_command_output(toSharedString("Select a session from this archive."));
            return;
        }
        auto command = dispatchWithSecrets(archiveCommand(path, {"transcript", "list", "--session", id}), activePassphrase);
        window->set_command_output(toSharedString(commandOutput(std::move(command))));
        auto archive = Archive::open(path, false, activePassphrase);
        if (!archive) {
            window->set_transcript_provenance(toSharedString(archive.error().message));
            return;
        }
        auto records = archive->list(tutorux::archive::RecordType::TranscriptSegment);
        if (!records) {
            window->set_transcript_provenance(toSharedString(records.error().message));
            return;
        }
        std::vector<slint::SharedString> choices;
        for (const auto& segment : *records) {
            const auto session = segment.fields.find("session_id");
            if (session == segment.fields.end() || session->second != id)
                continue;
            const auto speaker = segment.fields.find("speaker_label");
            const std::string speakerName =
                speaker == segment.fields.end() || speaker->second.empty() ? "Unknown speaker" : speaker->second;
            choices.emplace_back(formatTimestampField(segment, "start_time_us") + "–" + formatTimestampField(segment, "end_time_us") +
                                 " · " + speakerName + " · " + tutorux::archive::uuidToString(segment.id));
        }
        window->set_transcript_options(std::make_shared<slint::VectorModel<slint::SharedString>>(std::move(choices)));
        const auto selectedSegments = window->get_transcript_options();
        window->set_selected_transcript(selectedSegments->row_count() == 0 ? toSharedString("")
                                                                           : selectedSegments->row_data(0).value_or(toSharedString("")));
        window->set_transcript_provenance(selectedSegments->row_count() == 0
                                              ? toSharedString("No transcript segments are stored for this session.")
                                              : toSharedString("Select a segment, load it, then save a human correction."));
        activeTranscriptEditor->reset();
    });

    window->on_load_transcript([&, activeTranscriptEditor](slint::SharedString selectedSession, slint::SharedString selectedSegment) {
        const std::filesystem::path path(window->get_archive_path().data());
        const std::string sessionId = selectionId(selectedSession);
        const std::string segmentId = selectionId(selectedSegment);
        const auto uuid = tutorux::archive::uuidFromString(segmentId);
        if (path.empty() || sessionId.empty() || !uuid) {
            window->set_transcript_provenance(toSharedString("Select a transcript segment from the active session."));
            return;
        }
        auto archive = Archive::open(path, false, activePassphrase);
        if (!archive) {
            window->set_transcript_provenance(toSharedString(archive.error().message));
            return;
        }
        auto record = archive->get(tutorux::archive::RecordType::TranscriptSegment, *uuid);
        if (!record || !*record) {
            window->set_transcript_provenance(toSharedString(record ? "Transcript segment was not found." : record.error().message));
            return;
        }
        const auto& fields = (**record).fields;
        const auto savedSession = fields.find("session_id");
        if (savedSession == fields.end() || savedSession->second != sessionId) {
            window->set_transcript_provenance(toSharedString("The selected transcript segment belongs to another session."));
            return;
        }
        const auto text = fields.find("text");
        const auto speaker = fields.find("speaker_label");
        const auto verification = fields.find("verification_state");
        window->set_transcript_edit_text(toSharedString(text == fields.end() ? "" : text->second));
        std::ostringstream provenance;
        provenance << "Segment " << segmentId << " · "
                   << (speaker == fields.end() || speaker->second.empty() ? "Unknown speaker" : speaker->second) << " · "
                   << (verification == fields.end() ? "provisional" : verification->second) << " · "
                   << formatTimestampField(**record, "start_time_us") << "–" << formatTimestampField(**record, "end_time_us");
        window->set_transcript_provenance(toSharedString(provenance.str()));
        *activeTranscriptEditor = ActiveTranscriptEditor{sessionId, segmentId, (**record).revision};
    });

    window->on_save_transcript([&, activeTranscriptEditor](slint::SharedString selectedSession, slint::SharedString selectedSegment,
                                                           slint::SharedString editedText) {
        const std::filesystem::path path(window->get_archive_path().data());
        const std::string sessionId = selectionId(selectedSession);
        const std::string segmentId = selectionId(selectedSegment);
        const auto uuid = tutorux::archive::uuidFromString(segmentId);
        if (path.empty() || sessionId.empty() || !uuid || !*activeTranscriptEditor || (*activeTranscriptEditor)->sessionId != sessionId ||
            (*activeTranscriptEditor)->segmentId != segmentId) {
            window->set_transcript_provenance(toSharedString("Load the selected transcript segment before saving."));
            return;
        }
        auto archive = Archive::open(path, false, activePassphrase);
        if (!archive) {
            window->set_transcript_provenance(toSharedString(archive.error().message));
            return;
        }
        auto current = archive->get(tutorux::archive::RecordType::TranscriptSegment, *uuid);
        if (!current || !*current) {
            window->set_transcript_provenance(toSharedString(current ? "Transcript segment was not found." : current.error().message));
            return;
        }
        if ((**current).revision != (*activeTranscriptEditor)->expectedRevision) {
            window->set_transcript_provenance(
                toSharedString("This transcript segment changed after it was loaded. Reload it before saving."));
            return;
        }
        auto command = dispatchWithSecrets(
            archiveCommand(path, {"transcript", "correct", segmentId, "--text", std::string(editedText.data(), editedText.size())}),
            activePassphrase);
        const std::string output = commandOutput(std::move(command));
        window->set_command_output(toSharedString(output));
        window->set_status_message(toSharedString(output));
        if (output == "Transcript segment corrected.\n") {
            auto latestArchive = Archive::open(path, false, activePassphrase);
            if (latestArchive) {
                auto latest = latestArchive->get(tutorux::archive::RecordType::TranscriptSegment, *uuid);
                if (latest && *latest)
                    (*activeTranscriptEditor)->expectedRevision = (**latest).revision;
            }
            window->set_transcript_provenance(toSharedString("Saved as a new human-corrected archive revision."));
        }
    });

    window->on_quick_marker(
        [&](slint::SharedString selectedSession, slint::SharedString type, slint::SharedString timestamp, slint::SharedString note) {
            const std::filesystem::path path(window->get_archive_path().data());
            const std::string id = selectionId(selectedSession);
            if (path.empty() || id.empty()) {
                window->set_command_output(toSharedString("Select a session from this archive."));
                return;
            }
            auto command = dispatchWithSecrets(
                archiveCommand(path, {"annotation", "add", "--session", id, "--type", std::string(type.data(), type.size()), "--at",
                                      std::string(timestamp.data(), timestamp.size()), "--text", std::string(note.data(), note.size())}),
                activePassphrase);
            const std::string output = commandOutput(std::move(command));
            window->set_command_output(toSharedString(output));
            window->set_status_message(toSharedString(output));
        });

    const auto playbackThreads = std::make_shared<std::vector<std::thread>>();
    const auto playbackThreadsMutex = std::make_shared<std::mutex>();
    std::shared_ptr<std::atomic_bool> playbackStop;
    std::shared_ptr<std::atomic_bool> waveformStop;
    const slint::ComponentWeakHandle<MainWindow> playbackWeakWindow(window);
    const auto microphonePreflightBusy = std::make_shared<std::atomic_bool>(false);
    window->on_check_recording_device([playbackWeakWindow, playbackThreads, playbackThreadsMutex,
                                       microphonePreflightBusy](slint::SharedString requestedDevice) {
        bool expected = false;
        if (!microphonePreflightBusy->compare_exchange_strong(expected, true)) {
            if (auto strongWindow = playbackWeakWindow.lock()) {
                (*strongWindow)->set_status_message(toSharedString("The microphone check is already running."));
            }
            return;
        }

        const std::string requestedDeviceId(requestedDevice.data(), requestedDevice.size());
        if (auto strongWindow = playbackWeakWindow.lock()) {
            (*strongWindow)->set_recording_preflight_ready(false);
            (*strongWindow)->set_recording_preflight_device_id(toSharedString(""));
            (*strongWindow)->set_recording_preflight_requested_device_id(toSharedString(""));
            (*strongWindow)->set_recording_input_level(0);
            (*strongWindow)->set_recording_preflight_output(toSharedString("Listening briefly. Speak naturally into the microphone…"));
            (*strongWindow)->set_status_message(toSharedString("Checking microphone input in temporary memory."));
        }

        tutorux::audio::CapturePreflightOptions options;
        options.deviceId = requestedDeviceId;
        options.levelChanged = [playbackWeakWindow](const tutorux::audio::CaptureInputLevel& level) {
            const int peakPercent = std::clamp(static_cast<int>(std::lround(level.peakLevel * 100.0)), 0, 100);
            std::ostringstream message;
            message << "Listening · peak " << std::fixed << std::setprecision(1) << level.peakDbfs << " dBFS · RMS " << level.rmsDbfs
                    << " dBFS";
            const std::string output = message.str();
            static_cast<void>(slint::invoke_from_event_loop([playbackWeakWindow, peakPercent, output] {
                if (auto strongWindow = playbackWeakWindow.lock()) {
                    (*strongWindow)->set_recording_input_level(peakPercent);
                    (*strongWindow)->set_recording_preflight_output(toSharedString(output));
                }
            }));
        };

        std::thread worker;
        try {
            worker = std::thread([playbackWeakWindow, microphonePreflightBusy, requestedDeviceId, options = std::move(options)]() mutable {
                bool succeeded = false;
                bool signalDetected = false;
                std::string checkedDeviceId;
                double peakLevel = 0.0;
                std::string output;
                try {
                    auto result = tutorux::audio::preflightCaptureInput(std::move(options));
                    succeeded = result.has_value();
                    signalDetected = succeeded && result->signalDetected;
                    checkedDeviceId = succeeded ? result->device.deviceId : std::string{};
                    peakLevel = succeeded ? result->peakLevel : 0.0;
                    std::ostringstream report;
                    if (!succeeded) {
                        report << "Microphone check failed: " << result.error().message;
                    } else if (!signalDetected) {
                        report << "No input signal detected. Check the microphone and speak, "
                                  "then run the check again.";
                    } else {
                        report << "Input detected · peak " << std::fixed << std::setprecision(1) << result->peakDbfs << " dBFS · RMS "
                               << result->rmsDbfs << " dBFS";
                    }
                    output = report.str();
                } catch (const std::exception& exception) {
                    output = std::string("Microphone check failed: ") + exception.what();
                } catch (...) {
                    output = "Microphone check failed with an unknown error.";
                }

                static_cast<void>(slint::invoke_from_event_loop([playbackWeakWindow, microphonePreflightBusy, succeeded, signalDetected,
                                                                 requestedDeviceId, checkedDeviceId, peakLevel, output] {
                    microphonePreflightBusy->store(false);
                    if (auto strongWindow = playbackWeakWindow.lock()) {
                        const int peakPercent = std::clamp(static_cast<int>(std::lround(peakLevel * 100.0)), 0, 100);
                        (*strongWindow)->set_recording_input_level(peakPercent);
                        (*strongWindow)->set_recording_preflight_output(toSharedString(output));
                        (*strongWindow)->set_recording_preflight_ready(succeeded && signalDetected);
                        (*strongWindow)->set_recording_preflight_device_id(toSharedString(checkedDeviceId));
                        (*strongWindow)->set_recording_preflight_requested_device_id(toSharedString(requestedDeviceId));
                        (*strongWindow)
                            ->set_status_message(toSharedString(succeeded && signalDetected ? "Microphone input is ready for recording."
                                                                                            : "Microphone check needs attention."));
                    }
                }));
            });
        } catch (const std::exception& exception) {
            microphonePreflightBusy->store(false);
            if (auto strongWindow = playbackWeakWindow.lock()) {
                const std::string message = std::string("Unable to start the microphone check: ") + exception.what();
                (*strongWindow)->set_recording_preflight_output(toSharedString(message));
                (*strongWindow)->set_status_message(toSharedString(message));
            }
            return;
        } catch (...) {
            microphonePreflightBusy->store(false);
            if (auto strongWindow = playbackWeakWindow.lock()) {
                const std::string message = "Unable to start the microphone check because of an unknown error.";
                (*strongWindow)->set_recording_preflight_output(toSharedString(message));
                (*strongWindow)->set_status_message(toSharedString(message));
            }
            return;
        }
        try {
            const std::scoped_lock lock(*playbackThreadsMutex);
            playbackThreads->push_back(std::move(worker));
        } catch (const std::exception& exception) {
            if (worker.joinable())
                worker.join();
            microphonePreflightBusy->store(false);
            if (auto strongWindow = playbackWeakWindow.lock()) {
                const std::string message = std::string("Unable to retain the microphone check worker: ") + exception.what();
                (*strongWindow)->set_recording_preflight_ready(false);
                (*strongWindow)->set_recording_preflight_output(toSharedString(message));
                (*strongWindow)->set_status_message(toSharedString(message));
            }
        } catch (...) {
            if (worker.joinable())
                worker.join();
            microphonePreflightBusy->store(false);
            if (auto strongWindow = playbackWeakWindow.lock()) {
                const std::string message = "Unable to retain the microphone check worker.";
                (*strongWindow)->set_recording_preflight_ready(false);
                (*strongWindow)->set_recording_preflight_output(toSharedString(message));
                (*strongWindow)->set_status_message(toSharedString(message));
            }
        }
    });
    window->on_recording_command([&, playbackThreads, playbackThreadsMutex](slint::SharedString selectedSession, slint::SharedString action,
                                                                            slint::SharedString source) {
        const std::filesystem::path path(window->get_archive_path().data());
        const std::string id = selectionId(selectedSession);
        const std::string commandAction(action.data(), action.size());
        if (commandAction == "stop-playback") {
            if (playbackStop)
                playbackStop->store(true);
            window->set_status_message(toSharedString("Audio playback is stopping."));
            return;
        }
        if (commandAction == "stop-waveform") {
            if (waveformStop)
                waveformStop->store(true);
            window->set_status_message(toSharedString("Waveform generation is stopping."));
            return;
        }
        if (commandAction == "devices") {
            auto command = dispatchWithSecrets({"record", "devices"}, activePassphrase);
            const std::string output = commandOutput(std::move(command));
            window->set_command_output(toSharedString(output));
            window->set_status_message(toSharedString(output));
            return;
        }
        if (commandAction == "start" && !window->get_recording_consent_confirmed()) {
            window->set_status_message(toSharedString("Confirm participant consent before starting audio capture."));
            return;
        }
        const std::string requestedSource(source.data(), source.size());
        const bool microphoneTrackRequested = commandAction == "start" && (requestedSource == "microphone" || requestedSource == "both");
        if (microphoneTrackRequested &&
            (!window->get_recording_preflight_ready() ||
             std::string(window->get_recording_preflight_requested_device_id().data(),
                         window->get_recording_preflight_requested_device_id().size()) !=
                 std::string(window->get_recording_microphone_device().data(), window->get_recording_microphone_device().size()))) {
            window->set_status_message(toSharedString("Check the selected microphone input before starting."));
            return;
        }
        if (path.empty() || id.empty()) {
            window->set_command_output(toSharedString("Select a session from this archive."));
            return;
        }
        if (commandAction == "play-transcript") {
            const std::string segmentId = selectionId(window->get_selected_transcript());
            const auto segmentUuid = tutorux::archive::uuidFromString(segmentId);
            if (!segmentUuid) {
                window->set_transcript_provenance(toSharedString("Select a transcript timestamp before playing audio."));
                return;
            }
            auto archive = Archive::open(path, false, activePassphrase);
            if (!archive) {
                window->set_transcript_provenance(toSharedString(archive.error().message));
                return;
            }
            auto segment = archive->get(tutorux::archive::RecordType::TranscriptSegment, *segmentUuid);
            if (!segment || !*segment) {
                window->set_transcript_provenance(
                    toSharedString(segment ? "The selected transcript segment was not found." : segment.error().message));
                return;
            }
            const auto sessionField = (**segment).fields.find("session_id");
            const auto startField = (**segment).fields.find("start_time_us");
            if (sessionField == (**segment).fields.end() || sessionField->second != id || startField == (**segment).fields.end()) {
                window->set_transcript_provenance(toSharedString("The selected transcript timestamp is invalid for this session."));
                return;
            }
            std::uint64_t startUs = 0;
            const auto [end, parseError] =
                std::from_chars(startField->second.data(), startField->second.data() + startField->second.size(), startUs);
            if (parseError != std::errc{} || end != startField->second.data() + startField->second.size()) {
                window->set_transcript_provenance(toSharedString("The selected transcript timestamp is malformed."));
                return;
            }

            std::vector<std::string> arguments{"record",        "play",    "--session", id, "--start-us", std::to_string(startUs),
                                               "--duration-us", "30000000"};
            const std::string trackId(window->get_recording_export_track().data(), window->get_recording_export_track().size());
            if (!trackId.empty())
                arguments.insert(arguments.end(), {"--track", trackId});
            const auto stopRequested = std::make_shared<std::atomic_bool>(false);
            if (playbackStop)
                playbackStop->store(true);
            playbackStop = stopRequested;
            std::string passphrase = activePassphrase;
            window->set_command_output(toSharedString("Playing 30 seconds from the selected transcript timestamp…"));
            window->set_status_message(toSharedString("Playing archive audio."));
            std::thread worker([playbackWeakWindow, selectedPath = path, stopRequested, passphrase = std::move(passphrase),
                                arguments = std::move(arguments)]() mutable {
                std::string output;
                try {
                    auto command =
                        dispatchWithSecrets(archiveCommand(selectedPath, std::move(arguments)), passphrase, {}, {}, [stopRequested] {
                            return stopRequested->load();
                        });
                    output = commandOutput(std::move(command));
                } catch (const std::exception& exception) {
                    output = std::string("Playback failed: ") + exception.what();
                } catch (...) {
                    output = "Playback failed with an unknown error.";
                }
                eraseSecret(passphrase);
                static_cast<void>(slint::invoke_from_event_loop([playbackWeakWindow, output = std::move(output)]() mutable {
                    if (auto strongWindow = playbackWeakWindow.lock()) {
                        (*strongWindow)->set_command_output(toSharedString(output));
                        (*strongWindow)->set_status_message(toSharedString("Playback finished."));
                    }
                }));
            });
            {
                const std::scoped_lock lock(*playbackThreadsMutex);
                playbackThreads->push_back(std::move(worker));
            }
            return;
        }
        if (commandAction == "waveform") {
            std::vector<std::string> arguments{"record", "waveform", "--session", id, "--buckets", "72"};
            const std::string trackId(window->get_recording_export_track().data(), window->get_recording_export_track().size());
            if (!trackId.empty())
                arguments.insert(arguments.end(), {"--track", trackId});
            const auto stopRequested = std::make_shared<std::atomic_bool>(false);
            if (waveformStop)
                waveformStop->store(true);
            waveformStop = stopRequested;
            std::string passphrase = activePassphrase;
            window->set_command_output(toSharedString("Building the archive waveform index…"));
            window->set_status_message(toSharedString("Reading audio in bounded buffers."));
            std::thread worker([playbackWeakWindow, selectedPath = path, stopRequested, passphrase = std::move(passphrase),
                                arguments = std::move(arguments)]() mutable {
                std::string output;
                try {
                    auto command =
                        dispatchWithSecrets(archiveCommand(selectedPath, std::move(arguments)), passphrase, {}, {}, [stopRequested] {
                            return stopRequested->load();
                        });
                    output = commandOutput(std::move(command));
                } catch (const std::exception& exception) {
                    output = std::string("Waveform generation failed: ") + exception.what();
                } catch (...) {
                    output = "Waveform generation failed with an unknown error.";
                }
                eraseSecret(passphrase);
                static_cast<void>(slint::invoke_from_event_loop([playbackWeakWindow, output = std::move(output)]() mutable {
                    if (auto strongWindow = playbackWeakWindow.lock()) {
                        (*strongWindow)->set_command_output(toSharedString(output));
                        (*strongWindow)->set_status_message(toSharedString("Waveform command finished."));
                    }
                }));
            });
            {
                const std::scoped_lock lock(*playbackThreadsMutex);
                playbackThreads->push_back(std::move(worker));
            }
            return;
        }
        const bool fillAudioGaps = commandAction == "export-wav-fill-gaps";
        const std::string dispatchedAction = fillAudioGaps ? "export-wav" : commandAction;
        std::vector<std::string> arguments{"record", dispatchedAction, "--session", id};
        if (commandAction == "import") {
            const std::string inputValue(source.data(), source.size());
            if (inputValue.empty()) {
                window->set_command_output(toSharedString("Choose a WAV recording to import."));
                return;
            }
            arguments = {"record", "import", "--session", id, "--input", inputValue};
        } else if (commandAction == "export-wav" || fillAudioGaps) {
            const std::string outputValue(source.data(), source.size());
            if (outputValue.empty()) {
                window->set_command_output(toSharedString("Choose a WAV export path."));
                return;
            }
            std::filesystem::path outputPath(outputValue);
            if (outputPath.is_relative())
                outputPath = path.parent_path() / outputPath;
            arguments.insert(arguments.end(), {"--output", outputPath.string()});
            if (fillAudioGaps)
                arguments.push_back("--fill-gaps");
            const std::string trackId(window->get_recording_export_track().data(), window->get_recording_export_track().size());
            if (!trackId.empty())
                arguments.insert(arguments.end(), {"--track", trackId});
        } else if (commandAction == "start") {
            arguments.insert(arguments.end(), {"--source", requestedSource, "--consent", "--confirmed-by", "Tutorux desktop", "--detach"});
            if (window->get_recording_live_transcription_enabled()) {
                const std::string modelPath(window->get_recording_live_model_path().data(), window->get_recording_live_model_path().size());
                if (requestedSource == "both") {
                    window->set_command_output(toSharedString("Live transcription currently supports one source at a time."));
                    return;
                }
                if (modelPath.empty()) {
                    window->set_command_output(toSharedString("Choose a local Whisper model for live transcription."));
                    return;
                }
                arguments.insert(arguments.end(), {"--live-transcribe", "--model", modelPath});
            }
            std::string microphoneDevice(window->get_recording_microphone_device().data(),
                                         window->get_recording_microphone_device().size());
            if (microphoneTrackRequested)
                microphoneDevice =
                    std::string(window->get_recording_preflight_device_id().data(), window->get_recording_preflight_device_id().size());
            const std::string playbackDevice(window->get_recording_playback_device().data(),
                                             window->get_recording_playback_device().size());
            const std::string applicationDevice(window->get_recording_application_device().data(),
                                                window->get_recording_application_device().size());
            if ((requestedSource == "microphone" || requestedSource == "both") && !microphoneDevice.empty()) {
                arguments.insert(arguments.end(), {"--microphone", microphoneDevice});
            }
            if ((requestedSource == "application" || requestedSource == "both") && !applicationDevice.empty()) {
                arguments.insert(arguments.end(), {"--application", applicationDevice});
            } else if ((requestedSource == "system-audio" || requestedSource == "both") && !playbackDevice.empty()) {
                arguments.insert(arguments.end(), {"--playback", playbackDevice});
            }
        } else if (commandAction != "pause" && commandAction != "resume" && commandAction != "stop" && commandAction != "status") {
            window->set_command_output(toSharedString("Unsupported recording action."));
            return;
        }
        if (commandAction == "start")
            window->set_recording_preflight_ready(false);
        auto command = dispatchWithSecrets(archiveCommand(path, std::move(arguments)), activePassphrase);
        const bool commandSucceeded = command && command->exitCode == 0;
        const std::string output = commandOutput(std::move(command));
        window->set_command_output(toSharedString(output));
        window->set_status_message(toSharedString(output));
        if (commandAction == "start" || commandAction == "pause" || commandAction == "resume" || commandAction == "stop" ||
            commandAction == "status") {
            window->set_recording_status_output(toSharedString("Session " + id + "\n" + output));
        }
        if (commandAction == "start" && commandSucceeded) {
            const bool recordingPanelWasOpen = window->get_recording_panel_open();
            const auto journalSessionId = selectionId(window->get_selected_journal_session());
            const std::string enteredJournalSessionId(window->get_journal_session_id().data(), window->get_journal_session_id().size());
            bool sessionIsInVisibleEntry = id == journalSessionId || id == enteredJournalSessionId;
            const auto journalSessions = window->get_journal_session_options();
            for (std::size_t row = 0; !sessionIsInVisibleEntry && row < journalSessions->row_count(); ++row) {
                const auto choice = journalSessions->row_data(row);
                sessionIsInVisibleEntry = choice && selectionId(*choice) == id;
            }
            window->set_recording_panel_open(true);
            if (recordingPanelWasOpen && sessionIsInVisibleEntry)
                window->set_active_view(toSharedString("journal"));
        }
    });

    window->on_guide_command([&](slint::SharedString selectedGuide, slint::SharedString action, slint::SharedString format,
                                 slint::SharedString outputPath) {
        const std::filesystem::path path(window->get_archive_path().data());
        const std::string id = selectionId(selectedGuide);
        const std::string commandAction(action.data(), action.size());
        if (path.empty() || id.empty()) {
            window->set_guide_output(toSharedString("Select a guide from this archive."));
            return;
        }
        auto openedArchive = Archive::open(path, false, activePassphrase);
        if (!openedArchive) {
            window->set_guide_output(toSharedString(openedArchive.error().message));
            return;
        }
        const std::string blockStatus = populateGuideBlockOptions(*window, *openedArchive, id);
        if (!blockStatus.empty()) {
            window->set_guide_output(toSharedString(blockStatus));
            return;
        }
        std::vector<std::string> arguments{"guide", commandAction, id};
        std::optional<std::pair<std::size_t, std::size_t>> requestedBlockSelection;
        bool refreshGuideEditorChoices = false;
        if (commandAction == "export") {
            if (outputPath.empty()) {
                window->set_guide_output(toSharedString("Choose an output file before exporting the guide."));
                return;
            }
            arguments.insert(arguments.end(), {"--format", std::string(format.data(), format.size()), "--output",
                                               std::string(outputPath.data(), outputPath.size())});
        } else if (commandAction == "regenerate-section") {
            const auto indexes = guideBlockIndexes(window->get_selected_guide_block());
            if (!indexes || indexes->guideId != id) {
                window->set_guide_output(toSharedString("Select a section block before regenerating its section."));
                return;
            }
            arguments = {"guide", "regenerate", id, "--section-index", std::to_string(indexes->sectionIndex)};
            requestedBlockSelection = std::pair{indexes->sectionIndex, indexes->blockIndex};
            refreshGuideEditorChoices = true;
        } else if (commandAction == "add-example" || commandAction == "remove-block" || commandAction == "move-section-up" ||
                   commandAction == "move-section-down") {
            const auto indexes = guideBlockIndexes(window->get_selected_guide_block());
            if (!indexes || indexes->guideId != id) {
                window->set_guide_output(toSharedString("Select a guide block before changing the guide."));
                return;
            }
            if (commandAction == "add-example") {
                const std::size_t insertionIndex = indexes->blockIndex + 1U;
                arguments = {"guide",
                             "add-block",
                             id,
                             "--section-index",
                             std::to_string(indexes->sectionIndex),
                             "--block-index",
                             std::to_string(insertionIndex),
                             "--kind",
                             "example",
                             "--text",
                             ""};
                requestedBlockSelection = std::pair{indexes->sectionIndex, insertionIndex};
            } else if (commandAction == "remove-block") {
                arguments = {"guide",
                             "remove-block",
                             id,
                             "--section-index",
                             std::to_string(indexes->sectionIndex),
                             "--block-index",
                             std::to_string(indexes->blockIndex)};
                requestedBlockSelection = std::pair{indexes->sectionIndex, indexes->blockIndex};
            } else {
                const auto guideId = tutorux::archive::uuidFromString(id);
                if (!guideId) {
                    window->set_guide_output(toSharedString(guideId.error().message));
                    return;
                }
                auto guideRecord = openedArchive->get(tutorux::archive::RecordType::Guide, *guideId);
                if (!guideRecord || !*guideRecord) {
                    window->set_guide_output(
                        toSharedString(guideRecord ? "Guide was not found in the active archive." : guideRecord.error().message));
                    return;
                }
                auto guide = tutorux::domain::guideFromRecord(**guideRecord);
                if (!guide) {
                    window->set_guide_output(toSharedString(guide.error().message));
                    return;
                }
                const std::size_t sectionCount = guide->sections.size();
                const bool moveUp = commandAction == "move-section-up";
                if ((moveUp && indexes->sectionIndex == 0) || (!moveUp && indexes->sectionIndex + 1U >= sectionCount)) {
                    window->set_guide_output(
                        toSharedString(moveUp ? "The first section is already at the top." : "The last section is already at the bottom."));
                    return;
                }
                const std::size_t destinationIndex = moveUp ? indexes->sectionIndex - 1U : indexes->sectionIndex + 1U;
                arguments = {
                    "guide", "move-section", id, "--from", std::to_string(indexes->sectionIndex), "--to", std::to_string(destinationIndex)};
                requestedBlockSelection = std::pair{destinationIndex, indexes->blockIndex};
            }
            refreshGuideEditorChoices = true;
        } else if (commandAction != "show" && commandAction != "validate" && commandAction != "approve" && commandAction != "compare") {
            window->set_guide_output(toSharedString("Unsupported guide action."));
            return;
        }
        auto command = dispatchWithSecrets(archiveCommand(path, std::move(arguments)), activePassphrase);
        const std::string output = commandOutput(std::move(command));
        window->set_guide_output(toSharedString(output));
        window->set_status_message(toSharedString(output));
        if (refreshGuideEditorChoices && (output == "Guide revision saved.\n" || output.starts_with("Regenerated section"))) {
            std::string refreshedGuideId = id;
            if (commandAction == "regenerate-section") {
                constexpr std::string_view guideMarker = " in guide ";
                const auto markerPosition = output.rfind(guideMarker);
                if (markerPosition != std::string::npos) {
                    refreshedGuideId = output.substr(markerPosition + guideMarker.size());
                    if (refreshedGuideId.ends_with(".\n"))
                        refreshedGuideId.resize(refreshedGuideId.size() - 2U);
                }
            }
            refreshWorkspace(*window, path, activePassphrase);
            window->set_selected_guide(toSharedString(refreshedGuideId));
            auto latestArchive = Archive::open(path, false, activePassphrase);
            if (latestArchive) {
                populateGuideBlockOptions(*window, *latestArchive, refreshedGuideId);
                if (requestedBlockSelection) {
                    const auto choices = window->get_guide_block_options();
                    for (std::size_t row = 0; row < choices->row_count(); ++row) {
                        const auto choice = choices->row_data(row);
                        if (!choice)
                            continue;
                        const auto choiceIndexes = guideBlockIndexes(*choice);
                        if (choiceIndexes && choiceIndexes->guideId == refreshedGuideId &&
                            choiceIndexes->sectionIndex == requestedBlockSelection->first &&
                            choiceIndexes->blockIndex == requestedBlockSelection->second) {
                            window->set_selected_guide_block(*choice);
                            break;
                        }
                    }
                }
            }
        }
    });

    window->on_asset_command([&](slint::SharedString selectedSession, slint::SharedString action, slint::SharedString inputPath) {
        const std::filesystem::path path(window->get_archive_path().data());
        const std::string id = selectionId(selectedSession);
        const std::string commandAction(action.data(), action.size());
        const auto showAssetMessage = [&](std::string_view description, std::string_view body = {}) {
            window->set_asset_preview_kind(toSharedString("message"));
            window->set_asset_preview_description(toSharedString(description));
            window->set_asset_preview_body(toSharedString(body));
            window->set_asset_preview_waveform(toSharedString(""));
            window->set_asset_preview_image(slint::Image{});
        };
        if (commandAction == "reset") {
            clearAssetPanel(*window, "Choose a session, list its materials, then preview a selected file.");
            return;
        }
        if (path.empty()) {
            clearAssetPanel(*window, "Choose or unlock an archive before previewing materials.");
            window->set_command_output(toSharedString("Select an archive first."));
            return;
        }
        if (id.empty()) {
            clearAssetPanel(*window, "Choose a session, then list its materials.");
            window->set_command_output(toSharedString("Select a session from this archive."));
            return;
        }

        if (commandAction == "list") {
            auto opened = Archive::open(path, false, activePassphrase);
            if (!opened) {
                clearAssetPanel(*window, "Materials could not be loaded from this archive.");
                window->set_command_output(toSharedString(opened.error().message));
                return;
            }
            auto assets = opened->list(tutorux::archive::RecordType::AssetMetadata);
            if (!assets) {
                clearAssetPanel(*window, "Materials could not be listed from this archive.");
                window->set_command_output(toSharedString(assets.error().message));
                return;
            }
            constexpr std::size_t maximumMaterialChoices = 2'000;
            std::vector<slint::SharedString> choices;
            std::ostringstream listing;
            std::size_t totalCount = 0;
            for (const auto& asset : *assets) {
                const std::string role = tutorux::domain::getField(asset, "record_role");
                if (tutorux::domain::isDeleted(asset) || role == "audio-track" || role == "waveform-pyramid" ||
                    role == "sparse-timestamp-seek-index" || tutorux::domain::getField(asset, "session_id") != id)
                    continue;
                ++totalCount;
                if (choices.size() >= maximumMaterialChoices)
                    continue;
                const std::string assetId = tutorux::archive::uuidToString(asset.id);
                const std::string filename = safeAssetLabel(tutorux::domain::getField(asset, "filename"));
                const std::string mime = safeAssetLabel(tutorux::domain::getField(asset, "mime_type"));
                const auto byteSize = assetByteSize(asset);
                const std::string size = byteSize ? std::to_string(*byteSize) : "unknown size";
                choices.emplace_back(filename + " · " + mime + " · " + size + " bytes · " + assetId);
                listing << filename << " · " << mime << " · " << size << " bytes · " << assetId << "\n";
            }
            window->set_asset_options(std::make_shared<slint::VectorModel<slint::SharedString>>(choices));
            window->set_selected_asset(choices.empty() ? toSharedString("") : choices.front());
            resetAssetPreview(*window, choices.empty() ? "No materials are linked to this session."
                                                       : "Choose a material and select Preview. Content stays inside the archive.");
            std::string output =
                std::to_string(totalCount) + (totalCount == 1 ? " material in this session.\n" : " materials in this session.\n");
            output += listing.str();
            if (totalCount > maximumMaterialChoices)
                output += "Only the first 2,000 materials are shown.\n";
            window->set_command_output(toSharedString(output));
            return;
        }

        if (commandAction == "preview") {
            const std::string assetId = selectionId(inputPath);
            const auto parsedAssetId = tutorux::archive::uuidFromString(assetId);
            if (!parsedAssetId) {
                showAssetMessage("Select a material from the current session before previewing.");
                return;
            }
            auto opened = Archive::open(path, false, activePassphrase);
            if (!opened) {
                showAssetMessage("The material could not be opened.", opened.error().message);
                return;
            }
            auto assetResult = opened->get(tutorux::archive::RecordType::AssetMetadata, *parsedAssetId);
            if (!assetResult || !*assetResult) {
                showAssetMessage("The selected material is unavailable in this archive.",
                                 assetResult ? "The material was removed or no longer exists." : assetResult.error().message);
                return;
            }
            const auto& asset = **assetResult;
            const std::string role = tutorux::domain::getField(asset, "record_role");
            if (tutorux::domain::isDeleted(asset) || role == "audio-track" || role == "waveform-pyramid" ||
                role == "sparse-timestamp-seek-index" || tutorux::domain::getField(asset, "session_id") != id) {
                showAssetMessage("This material does not belong to the selected session.",
                                 "Refresh the material list, then choose an item from that session.");
                return;
            }
            const std::string filename = safeAssetLabel(tutorux::domain::getField(asset, "filename"), 256);
            const std::string mime = safeAssetLabel(tutorux::domain::getField(asset, "mime_type"));
            const auto byteSize = assetByteSize(asset);
            if (!byteSize) {
                showAssetMessage("Material preview blocked.", "The archive contains invalid size metadata for this asset.");
                return;
            }
            const std::string size = std::to_string(*byteSize) + " bytes";
            const bool isText = mime.starts_with("text/") || mime == "application/json" || mime == "application/xml" ||
                                mime == "application/javascript" || mime == "application/x-ndjson";
            if (mime == "image/png" || mime == "image/jpeg") {
                auto bytes = readAssetPreviewBytes(*opened, asset, maximumNativeImagePreviewBytes);
                if (!bytes) {
                    showAssetMessage("Image preview unavailable · " + filename, bytes.error().message);
                    return;
                }
                const auto dimensions = mime == "image/png" ? pngDimensions(*bytes) : jpegDimensions(*bytes);
                if (!dimensions || dimensions->first == 0 || dimensions->second == 0 || dimensions->first > 16'384U ||
                    dimensions->second > 16'384U ||
                    static_cast<std::uint64_t>(dimensions->first) * dimensions->second > maximumNativeImagePreviewPixels) {
                    showAssetMessage("Image preview blocked · " + filename,
                                     "The image header is invalid or its dimensions exceed the 16-megapixel safety limit.");
                    return;
                }
                const auto image = slint::Image::load_from_data(*bytes, mime == "image/png" ? "png" : "jpg");
                const auto decodedSize = image.size();
                if (decodedSize.width != dimensions->first || decodedSize.height != dimensions->second) {
                    showAssetMessage("Image preview failed · " + filename, "The file could not be decoded safely in this native build.");
                    return;
                }
                window->set_asset_preview_kind(toSharedString("image"));
                window->set_asset_preview_description(toSharedString("Image preview · " + filename + " · " +
                                                                     std::to_string(decodedSize.width) + " × " +
                                                                     std::to_string(decodedSize.height) + " pixels · " + size));
                window->set_asset_preview_body(toSharedString(""));
                window->set_asset_preview_waveform(toSharedString(""));
                window->set_asset_preview_image(image);
                return;
            }
            if (isText) {
                auto bytes = readAssetPreviewBytes(*opened, asset, maximumNativeTextPreviewBytes);
                if (!bytes) {
                    showAssetMessage("Text preview unavailable · " + filename, bytes.error().message);
                    return;
                }
                auto preview = sanitizeAssetText(*bytes);
                if (preview.containedNul) {
                    showAssetMessage("Text preview blocked · " + filename, "This file contains binary NUL bytes and is not shown as text.");
                    return;
                }
                std::string description = "Plain-text preview · " + filename + " · " + size;
                if (preview.replacedInvalidData)
                    description += " · Invalid text bytes were replaced safely";
                window->set_asset_preview_kind(toSharedString("text"));
                window->set_asset_preview_description(toSharedString(description));
                window->set_asset_preview_body(toSharedString(preview.text));
                window->set_asset_preview_waveform(toSharedString(""));
                window->set_asset_preview_image(slint::Image{});
                return;
            }

            const std::string summary = filename + " · " + mime + " · " + size;
            if (mime.starts_with("audio/")) {
                if (mime == "audio/wav" || mime == "audio/x-wav" || mime == "audio/wave") {
                    auto bytes = readAssetPreviewBytes(*opened, asset, maximumNativeAudioPreviewBytes);
                    if (!bytes) {
                        showAssetMessage("Audio preview unavailable · " + filename, bytes.error().message);
                        return;
                    }
                    const auto preview = previewPcmWave(*bytes);
                    if (!preview) {
                        showAssetMessage(
                            "Audio material · " + summary,
                            "A waveform preview is available for bounded, uncompressed PCM WAV files only. This file is retained in the archive and was not extracted or played.");
                        return;
                    }
                    window->set_asset_preview_kind(toSharedString("audio"));
                    window->set_asset_preview_description(toSharedString("Verified audio waveform preview · " + filename + " · " + size));
                    window->set_asset_preview_body(toSharedString(preview->details));
                    window->set_asset_preview_waveform(toSharedString(preview->waveform));
                    window->set_asset_preview_image(slint::Image{});
                } else {
                    showAssetMessage(
                        "Audio material · " + summary,
                        "This native view has no decoder-backed player for this format. The file remains in the archive and was not extracted or played.");
                }
            } else if (mime.starts_with("video/")) {
                showAssetMessage(
                    "Video material · " + summary,
                    "This native view has no video decoder. The file remains in the archive; no temporary or extracted file was created.");
            } else if (mime == "application/pdf" || mime.starts_with("application/vnd.")) {
                showAssetMessage(
                    "Document material · " + summary,
                    "This native build does not include a PDF or Office renderer. Text documents can be previewed inline; this file remains in the archive and was not extracted.");
            } else {
                showAssetMessage("Preview not supported · " + summary,
                                 "This file type is kept as an opaque archive asset and is not opened or executed by Tutorux.");
            }
            return;
        }

        std::vector<std::string> arguments{"asset", commandAction};
        if (commandAction == "add") {
            if (inputPath.empty()) {
                window->set_command_output(toSharedString("Choose a file path to import."));
                return;
            }
            arguments.emplace_back(inputPath.data(), inputPath.size());
        } else if (commandAction != "list") {
            window->set_command_output(toSharedString("Unsupported material action."));
            return;
        }
        arguments.insert(arguments.end(), {"--session", id});
        auto command = dispatchWithSecrets(archiveCommand(path, std::move(arguments)), activePassphrase);
        const std::string output = commandOutput(std::move(command));
        window->set_command_output(toSharedString(output));
        window->set_status_message(toSharedString(output));
    });

    window->on_accepts_dropped_files([](slint::DataTransfer transfer) {
        const auto paths = transfer.file_paths();
        return paths.has_value() && !paths->empty();
    });

    window->on_import_dropped_files([&](slint::DataTransfer transfer) {
        const auto paths = transfer.file_paths();
        if (!paths || paths->empty()) {
            const std::string output = "The drop did not contain any local file paths.";
            window->set_command_output(toSharedString(output));
            window->set_status_message(toSharedString(output));
            return;
        }

        const auto archivePathValue = window->get_archive_path();
        const std::filesystem::path archivePath(std::string(archivePathValue.data(), archivePathValue.size()));
        if (archivePath.empty()) {
            const std::string output = "Choose or create an archive before dropping files.";
            window->set_command_output(toSharedString(output));
            window->set_status_message(toSharedString(output));
            return;
        }

        const auto archiveInfo = tutorux::archive::inspectArchive(archivePath, activePassphrase);
        if (!archiveInfo) {
            const std::string output = "Cannot import files: " + archiveInfo.error().message;
            window->set_command_output(toSharedString(output));
            window->set_status_message(toSharedString(output));
            return;
        }
        if (archiveInfo->metadataOnly) {
            const std::string output = "Cannot import files into an archive that is available in metadata-only mode.";
            window->set_command_output(toSharedString(output));
            window->set_status_message(toSharedString(output));
            return;
        }
        if (archiveInfo->healthStatus == "locked") {
            const std::string output = "Unlock the selected archive before importing files.";
            window->set_command_output(toSharedString(output));
            window->set_status_message(toSharedString(output));
            return;
        }
        if (archiveInfo->recoveryNeeded || archiveInfo->healthStatus != "healthy") {
            const std::string output = "Review and resolve archive recovery before importing files.";
            window->set_command_output(toSharedString(output));
            window->set_status_message(toSharedString(output));
            return;
        }
        if (!archiveInfo->writable) {
            const std::string output = "The selected archive is read-only.";
            window->set_command_output(toSharedString(output));
            window->set_status_message(toSharedString(output));
            return;
        }

        const auto sessionSelection = window->get_selected_session();
        const std::string sessionLabel(sessionSelection.data(), sessionSelection.size());
        const std::string sessionId = selectionId(sessionSelection);
        if (!sessionLabel.empty() && sessionId.empty()) {
            const std::string output = "The selected session is no longer available. Choose a session again before "
                                       "dropping files.";
            window->set_command_output(toSharedString(output));
            window->set_status_message(toSharedString(output));
            return;
        }

        std::size_t importedCount = 0;
        std::size_t failedCount = 0;
        std::ostringstream report;
        report << "Dropped file import";
        if (!sessionId.empty())
            report << " · selected session " << sessionId;
        else
            report << " · no session selected";
        report << "\n";

        for (const auto& droppedPath : *paths) {
            std::error_code errorCode;
            auto sourcePath = std::filesystem::canonical(droppedPath, errorCode);
            if (errorCode) {
                ++failedCount;
                report << "Failed · " << droppedPath.string() << " · " << errorCode.message() << "\n";
                continue;
            }

            const auto sourceStatus = std::filesystem::status(sourcePath, errorCode);
            if (errorCode || !std::filesystem::is_regular_file(sourceStatus)) {
                ++failedCount;
                report << "Failed · " << sourcePath.string() << " · " << (errorCode ? errorCode.message() : "path is not a regular file")
                       << "\n";
                continue;
            }

            std::vector<std::string> arguments{"asset", "add", sourcePath.string()};
            if (!sessionId.empty())
                arguments.insert(arguments.end(), {"--session", sessionId});
            auto command = dispatchWithSecrets(archiveCommand(archiveInfo->path, std::move(arguments)), activePassphrase);
            if (!command || command->exitCode != 0) {
                ++failedCount;
                const std::string error = !command                  ? command.error().message
                                          : command->output.empty() ? "asset import failed"
                                                                    : command->output;
                report << "Failed · " << sourcePath.string() << " · " << error << "\n";
                continue;
            }

            ++importedCount;
            report << "Imported · " << sourcePath.string() << "\n";
        }

        report << "\nFinished: " << importedCount << " imported, " << failedCount << " failed.";
        const std::string output = report.str();
        window->set_active_view(toSharedString("assets"));
        window->set_command_output(toSharedString(output));
        window->set_status_message(toSharedString("Drop import finished: " + std::to_string(importedCount) + " imported, " +
                                                  std::to_string(failedCount) + " failed. See the materials output for per-file details."));
    });

    window->on_ai_command([&](slint::SharedString provider, slint::SharedString action, slint::SharedString selectedSession,
                              slint::SharedString outputPath) {
        const std::filesystem::path path(window->get_archive_path().data());
        if (path.empty()) {
            window->set_command_output(toSharedString("Choose an archive first."));
            return;
        }
        const std::string commandAction(action.data(), action.size());
        const std::string providerId(provider.data(), provider.size());
        const std::string modelId(window->get_ai_model_id().data(), window->get_ai_model_id().size());
        const std::string endpoint(window->get_ai_endpoint().data(), window->get_ai_endpoint().size());
        std::vector<std::string> arguments{"ai"};
        if (commandAction == "providers") {
            arguments.emplace_back("providers");
        } else if (commandAction == "models") {
            if (providerId.empty()) {
                window->set_command_output(toSharedString("Enter a provider ID first."));
                return;
            }
            arguments.insert(arguments.end(), {"models", "--provider", providerId, "--refresh"});
        } else if (commandAction == "configure") {
            if (providerId.empty()) {
                window->set_command_output(toSharedString("Enter a provider ID first."));
                return;
            }
            arguments.insert(arguments.end(), {"configure", "--provider", providerId});
            if (!endpoint.empty())
                arguments.insert(arguments.end(), {"--endpoint", endpoint});
            if (!modelId.empty())
                arguments.insert(arguments.end(), {"--model", modelId});
        } else if (commandAction == "select-embedded") {
            const std::string modelPath(window->get_ai_model_path().data(), window->get_ai_model_path().size());
            if (providerId != "llama.cpp-embedded" || modelId.empty() || modelPath.empty()) {
                window->set_command_output(toSharedString("Enter provider llama.cpp-embedded, a model ID, and an explicit GGUF path."));
                return;
            }
            arguments = {"model", "select", "--provider", providerId, "--model", modelId, "--path", modelPath};
        } else if (commandAction == "package" || commandAction == "zip-package") {
            const std::string sessionId = selectionId(selectedSession);
            if (sessionId.empty()) {
                window->set_command_output(toSharedString("Select a session before preparing its package."));
                return;
            }
            arguments.insert(arguments.end(), {"package", "--session", sessionId, "--mode", "manual", "--format",
                                               commandAction == "zip-package" ? "zip" : "markdown"});
            if (commandAction == "zip-package")
                arguments.emplace_back("--confirm-sensitive");
            if (!outputPath.empty()) {
                arguments.emplace_back("--output");
                arguments.emplace_back(outputPath.data(), outputPath.size());
            }
        } else if (commandAction == "local-package") {
            const std::string sessionId = selectionId(selectedSession);
            if (sessionId.empty()) {
                window->set_command_output(toSharedString("Select a session before preparing a local package."));
                return;
            }
            arguments.insert(arguments.end(), {"package", "--session", sessionId, "--mode", "local", "--format", "json"});
            if (!outputPath.empty()) {
                arguments.emplace_back("--output");
                arguments.emplace_back(outputPath.data(), outputPath.size());
            }
        } else if (commandAction == "generate" || commandAction == "confirm-send") {
            const std::string jobId(window->get_ai_package_job_id().data(), window->get_ai_package_job_id().size());
            if (providerId.empty() || !tutorux::archive::uuidFromString(jobId)) {
                window->set_command_output(toSharedString("Enter a provider ID and the package job ID returned by package creation."));
                return;
            }
            arguments.insert(arguments.end(), {"generate", "--job", jobId, "--provider", providerId});
            if (!modelId.empty())
                arguments.insert(arguments.end(), {"--model", modelId});
            if (providerId != "ollama" && providerId != "lm-studio" && providerId != "llama.cpp-server" &&
                providerId != "llama.cpp-embedded") {
                const std::string environment(window->get_ai_api_key_environment().data(), window->get_ai_api_key_environment().size());
                if (!environment.empty())
                    arguments.insert(arguments.end(), {"--api-key-env", environment});
            }
            if (commandAction == "confirm-send") {
                const std::string confirmationHash(window->get_ai_confirmation_hash().data(), window->get_ai_confirmation_hash().size());
                if (confirmationHash.empty()) {
                    window->set_command_output(toSharedString("Review the outbound preview and enter its package SHA-256 first."));
                    return;
                }
                arguments.insert(arguments.end(), {"--confirm-outbound", "--confirm-hash", confirmationHash});
            }
        } else if (commandAction == "import") {
            const std::string sessionId = selectionId(selectedSession);
            if (sessionId.empty() || outputPath.empty()) {
                window->set_command_output(toSharedString("Select a session and enter the structured external response file path."));
                return;
            }
            arguments = {"ai", "import", "--session", sessionId, "--input", std::string(outputPath.data(), outputPath.size())};
        } else {
            window->set_command_output(toSharedString("Unsupported AI workspace action."));
            return;
        }
        const std::string requestedCommand = commandLineFromArguments(arguments);
        window->set_command_input(toSharedString(requestedCommand));
        window->invoke_run_command(toSharedString(requestedCommand), toSharedString(""));
    });

    window->on_save_marker_shortcuts([&](slint::SharedString conceptShortcut, slint::SharedString mistake, slint::SharedString correction,
                                         slint::SharedString instruction, slint::SharedString example, slint::SharedString followUp,
                                         slint::SharedString note) {
        const std::filesystem::path path(window->get_archive_path().data());
        if (path.empty()) {
            window->set_status_message(toSharedString("Choose an archive first."));
            return;
        }
        std::array<std::string, 7> shortcuts{std::string(conceptShortcut.data(), conceptShortcut.size()),
                                             std::string(mistake.data(), mistake.size()),
                                             std::string(correction.data(), correction.size()),
                                             std::string(instruction.data(), instruction.size()),
                                             std::string(example.data(), example.size()),
                                             std::string(followUp.data(), followUp.size()),
                                             std::string(note.data(), note.size())};
        std::set<char> unique;
        for (auto& shortcut : shortcuts) {
            if (shortcut.size() != 1 || shortcut.front() == ',' || static_cast<unsigned char>(shortcut.front()) < 0x21U ||
                static_cast<unsigned char>(shortcut.front()) > 0x7eU) {
                window->set_status_message(toSharedString("Each shortcut must be one printable ASCII character other than comma."));
                return;
            }
            char key = shortcut.front();
            if (std::isalpha(static_cast<unsigned char>(key))) {
                key = static_cast<char>(std::tolower(static_cast<unsigned char>(key)));
                shortcut.front() = key;
            }
            if (!unique.insert(key).second) {
                window->set_status_message(toSharedString("Quick marker shortcuts must be unique."));
                return;
            }
        }
        std::string serialized;
        for (const auto& shortcut : shortcuts) {
            if (!serialized.empty())
                serialized.push_back(',');
            serialized += shortcut;
        }
        auto command = dispatchWithSecrets(archiveCommand(path, {"settings", "set", "annotation.quick_marker_shortcuts", serialized}),
                                           activePassphrase);
        const bool saved = command && command->exitCode == 0;
        const std::string output = commandOutput(std::move(command));
        if (saved) {
            window->set_shortcut_concept(toSharedString(shortcuts[0]));
            window->set_shortcut_mistake(toSharedString(shortcuts[1]));
            window->set_shortcut_correction(toSharedString(shortcuts[2]));
            window->set_shortcut_instruction(toSharedString(shortcuts[3]));
            window->set_shortcut_example(toSharedString(shortcuts[4]));
            window->set_shortcut_follow_up(toSharedString(shortcuts[5]));
            window->set_shortcut_note(toSharedString(shortcuts[6]));
        }
        window->set_status_message(toSharedString(output));
        window->set_command_output(toSharedString(output));
    });

    const auto activeGuideEditor = std::make_shared<std::optional<ActiveGuideEditor>>();
    window->on_load_guide_block([&, activeGuideEditor](slint::SharedString selectedGuide, slint::SharedString selectedBlock) {
        const std::filesystem::path path(window->get_archive_path().data());
        const std::string id = selectionId(selectedGuide);
        const auto indexes = guideBlockIndexes(selectedBlock);
        const auto guideId = tutorux::archive::uuidFromString(id);
        if (path.empty() || !guideId || !indexes || indexes->guideId != id) {
            window->set_guide_provenance(toSharedString("Select a block that belongs to the currently selected guide."));
            return;
        }
        auto archive = Archive::open(path, false, activePassphrase);
        if (!archive) {
            window->set_guide_provenance(toSharedString(archive.error().message));
            return;
        }
        auto record = archive->get(tutorux::archive::RecordType::Guide, *guideId);
        if (!record || !*record) {
            window->set_guide_provenance(toSharedString(record ? "Guide was not found in the active archive." : record.error().message));
            return;
        }
        auto guide = tutorux::domain::guideFromRecord(**record);
        if (!guide || indexes->sectionIndex >= guide->sections.size() ||
            indexes->blockIndex >= guide->sections[indexes->sectionIndex].blocks.size()) {
            window->set_guide_provenance(toSharedString(guide ? "Selected block is outside the guide." : guide.error().message));
            return;
        }
        auto& block = guide->sections[indexes->sectionIndex].blocks[indexes->blockIndex];
        auto sourceIds = explicitGuideSourceIds(block);
        auto buffer = tutorux::document::PieceTable::create(block.text);
        if (!buffer) {
            window->set_guide_provenance(toSharedString(buffer.error().message));
            return;
        }
        *activeGuideEditor = ActiveGuideEditor{
            id, indexes->sectionIndex, indexes->blockIndex, (**record).revision, std::move(*buffer), block.kind, std::move(sourceIds)};
        window->set_guide_edit_text(toSharedString(block.text));
        window->set_guide_edit_anchor(0);
        window->set_guide_edit_focus(0);
        window->set_guide_reference_id(toSharedString(block.sourceIds.empty() ? std::string_view{} : block.sourceIds.front()));
        window->set_guide_block_kind(toSharedString(block.kind));
        std::ostringstream provenance;
        provenance << guide->sections[indexes->sectionIndex].heading << " · " << block.kind;
        if (block.origin == "ai-generated")
            provenance << " · AI-generated draft";
        else if (block.origin == "human-edited")
            provenance << " · tutor-edited";
        else if (block.origin == "tutor-authored")
            provenance << " · tutor-authored";
        else if (block.origin == "session-evidence")
            provenance << " · session evidence";
        else if (block.origin == "uncertain")
            provenance << " · uncertain interpretation";
        else
            provenance << " · provenance unverified";
        if (block.stale)
            provenance << " · source changed; review this content before saving";
        if (!block.sourceIds.empty()) {
            provenance << " · sources: ";
            for (std::size_t sourceIndex = 0; sourceIndex < block.sourceIds.size(); ++sourceIndex) {
                if (sourceIndex != 0)
                    provenance << ", ";
                provenance << block.sourceIds[sourceIndex];
            }
        } else {
            provenance << " · no source references";
        }
        window->set_guide_provenance(toSharedString(provenance.str()));
        window->set_guide_output(toSharedString("Block loaded from the selected archive revision."));
    });

    window->on_guide_edit_input_changed([&, activeGuideEditor](slint::SharedString editedText, int cursorOffset, int anchorOffset) {
        if (!*activeGuideEditor)
            return;
        const std::string_view text(editedText.data(), editedText.size());
        const auto selection =
            tutorux::document::TextSelection{static_cast<std::size_t>(anchorOffset), static_cast<std::size_t>(cursorOffset)};
        auto status = updateGuideEditorText(**activeGuideEditor, text, selection);
        if (!status)
            window->set_guide_output(toSharedString(status.error().message));
    });

    window->on_guide_edit_selection_changed([&, activeGuideEditor](int cursorOffset, int anchorOffset) {
        if (!*activeGuideEditor)
            return;
        auto status =
            (*activeGuideEditor)->text.setSelection({static_cast<std::size_t>(anchorOffset), static_cast<std::size_t>(cursorOffset)});
        if (!status)
            window->set_guide_output(toSharedString(status.error().message));
    });

    window->on_find_guide_next([&, activeGuideEditor](slint::SharedString requestedQuery) {
        if (!*activeGuideEditor) {
            window->set_guide_output(toSharedString("Load a guide block before searching."));
            return;
        }
        const std::string query(requestedQuery.data(), requestedQuery.size());
        auto match = nextGuideTextMatch(**activeGuideEditor, query);
        if (!match) {
            window->set_guide_output(toSharedString(match.error().message));
            return;
        }
        auto status = (*activeGuideEditor)->text.setSelection({match->start, match->end});
        if (!status) {
            window->set_guide_output(toSharedString(status.error().message));
            return;
        }
        window->set_guide_edit_anchor(static_cast<int>(match->start));
        window->set_guide_edit_focus(static_cast<int>(match->end));
        window->set_guide_output(toSharedString("Selected the next matching text."));
    });

    window->on_replace_guide_match([&, activeGuideEditor](slint::SharedString requestedQuery, slint::SharedString replacementText) {
        if (!*activeGuideEditor) {
            window->set_guide_output(toSharedString("Load a guide block before replacing text."));
            return;
        }
        const std::string query(requestedQuery.data(), requestedQuery.size());
        const std::string replacement(replacementText.data(), replacementText.size());
        auto& editor = **activeGuideEditor;
        const auto selection = editor.text.selection();
        const std::size_t start = std::min(selection.anchor, selection.focus);
        const std::size_t end = std::max(selection.anchor, selection.focus);
        const std::string contents = editor.text.text();
        if (query.empty()) {
            window->set_guide_output(toSharedString("Enter text to find before replacing."));
            return;
        }
        if (end - start != query.size() || contents.compare(start, query.size(), query) != 0) {
            auto match = nextGuideTextMatch(editor, query);
            if (!match) {
                window->set_guide_output(toSharedString(match.error().message));
                return;
            }
            editor.text.setSelection({match->start, match->end});
            window->set_guide_edit_anchor(static_cast<int>(match->start));
            window->set_guide_edit_focus(static_cast<int>(match->end));
            window->set_guide_output(toSharedString("Selected the next match. Press Replace again to replace it."));
            return;
        }
        auto result = editor.text.replace({start, end}, replacement, editor.guideId, editor.expectedRevision, "guide-find-replace");
        if (!result) {
            window->set_guide_output(toSharedString(result.error().message));
            return;
        }
        window->set_guide_edit_text(toSharedString(editor.text.text()));
        window->set_guide_edit_anchor(static_cast<int>(result->selection.anchor));
        window->set_guide_edit_focus(static_cast<int>(result->selection.focus));
        window->set_guide_output(toSharedString("Replaced the selected match."));
    });

    window->on_replace_all_guide_matches([&, activeGuideEditor](slint::SharedString requestedQuery, slint::SharedString replacementText) {
        if (!*activeGuideEditor) {
            window->set_guide_output(toSharedString("Load a guide block before replacing text."));
            return;
        }
        auto result = (*activeGuideEditor)
                          ->text.replaceAll(std::string_view(requestedQuery.data(), requestedQuery.size()),
                                            std::string_view(replacementText.data(), replacementText.size()), (*activeGuideEditor)->guideId,
                                            (*activeGuideEditor)->expectedRevision, "guide-find-replace-all");
        if (!result) {
            window->set_guide_output(toSharedString(result.error().message));
            return;
        }
        window->set_guide_edit_text(toSharedString((*activeGuideEditor)->text.text()));
        window->set_guide_edit_anchor(static_cast<int>(result->selection.anchor));
        window->set_guide_edit_focus(static_cast<int>(result->selection.focus));
        window->set_guide_output(toSharedString("Replaced " + std::to_string(result->operationCount) + " match(es)."));
    });

    window->on_guide_edit_undo([&, activeGuideEditor] {
        if (!*activeGuideEditor)
            return;
        auto result = (*activeGuideEditor)->text.undo();
        if (!result) {
            window->set_guide_output(toSharedString(result.error().message));
            return;
        }
        window->set_guide_edit_text(toSharedString((*activeGuideEditor)->text.text()));
        window->set_guide_edit_anchor(static_cast<int>(result->selection.anchor));
        window->set_guide_edit_focus(static_cast<int>(result->selection.focus));
        window->set_guide_output(toSharedString("Undid the last structured guide edit."));
    });

    window->on_guide_edit_redo([&, activeGuideEditor] {
        if (!*activeGuideEditor)
            return;
        auto result = (*activeGuideEditor)->text.redo();
        if (!result) {
            window->set_guide_output(toSharedString(result.error().message));
            return;
        }
        window->set_guide_edit_text(toSharedString((*activeGuideEditor)->text.text()));
        window->set_guide_edit_anchor(static_cast<int>(result->selection.anchor));
        window->set_guide_edit_focus(static_cast<int>(result->selection.focus));
        window->set_guide_output(toSharedString("Redid the last structured guide edit."));
    });

    window->on_insert_guide_markup([&, activeGuideEditor](slint::SharedString markupKind, slint::SharedString referenceId) {
        if (!*activeGuideEditor) {
            window->set_guide_output(toSharedString("Load a guide block before inserting markup."));
            return;
        }
        auto& editor = **activeGuideEditor;
        const std::string kind(markupKind.data(), markupKind.size());
        const std::string reference(referenceId.data(), referenceId.size());
        const auto selection = editor.text.selection();
        const std::size_t start = std::min(selection.anchor, selection.focus);
        const std::size_t end = std::max(selection.anchor, selection.focus);
        const std::string contents = editor.text.text();
        if (end > contents.size()) {
            window->set_guide_output(toSharedString("The editor selection is outside the guide block."));
            return;
        }
        const std::string selectedText = contents.substr(start, end - start);
        std::string insertion;
        std::string updatedKind = editor.kind;
        if (kind == "source") {
            auto id = tutorux::archive::uuidFromString(reference);
            if (!id) {
                window->set_guide_output(toSharedString("Enter a valid source UUID before inserting it."));
                return;
            }
            const std::string canonicalId = tutorux::archive::uuidToString(*id);
            insertion = selectedText + "[[source:" + canonicalId + "]]";
        } else if (kind == "image" && !reference.empty()) {
            auto id = tutorux::archive::uuidFromString(reference);
            if (!id) {
                window->set_guide_output(toSharedString("Enter a valid asset UUID before inserting an image."));
                return;
            }
            const std::string canonicalId = tutorux::archive::uuidToString(*id);
            std::string description = selectedText.empty() ? "Image description" : selectedText;
            std::string escapedDescription;
            escapedDescription.reserve(description.size());
            for (const char character : description) {
                if (character == '\\' || character == ']')
                    escapedDescription.push_back('\\');
                escapedDescription.push_back(character);
            }
            insertion = "![" + escapedDescription + "](asset:" + canonicalId + ")";
            updatedKind = "image";
        } else if (kind == "code") {
            updatedKind = "code";
            insertion = selectedText;
        } else if (kind == "equation") {
            updatedKind = "equation";
            insertion = selectedText;
        } else if (kind == "table") {
            updatedKind = "table";
            insertion = "| Column 1 | Column 2 |\n| --- | --- |\n| Value | Value |";
        } else if (kind == "image" || kind == "figure" || kind == "paragraph" || kind == "list-item" || kind == "quote" ||
                   kind == "example" || kind == "instruction" || kind == "recommendation" || kind == "worked-example") {
            updatedKind = kind;
            insertion = selectedText;
        } else {
            window->set_guide_output(toSharedString("Unsupported guide markup action."));
            return;
        }

        if (insertion != selectedText) {
            auto result = editor.text.replace({start, end}, insertion, editor.guideId, editor.expectedRevision, "guide-markup");
            if (!result) {
                window->set_guide_output(toSharedString(result.error().message));
                return;
            }
        }
        editor.kind = std::move(updatedKind);
        window->set_guide_block_kind(toSharedString(editor.kind));
        const auto insertedSelection = editor.text.selection();
        window->set_guide_edit_text(toSharedString(editor.text.text()));
        window->set_guide_edit_anchor(static_cast<int>(insertedSelection.anchor));
        window->set_guide_edit_focus(static_cast<int>(insertedSelection.focus));
        window->set_guide_output(toSharedString("Inserted markup into the in-memory guide block."));
    });

    window->on_save_guide_block(
        [&, activeGuideEditor](slint::SharedString selectedGuide, slint::SharedString selectedBlock, slint::SharedString editedText) {
            const std::filesystem::path path(window->get_archive_path().data());
            const std::string id = selectionId(selectedGuide);
            const auto indexes = guideBlockIndexes(selectedBlock);
            if (path.empty() || !indexes || indexes->guideId != id || !*activeGuideEditor || (*activeGuideEditor)->guideId != id ||
                (*activeGuideEditor)->sectionIndex != indexes->sectionIndex || (*activeGuideEditor)->blockIndex != indexes->blockIndex) {
                window->set_guide_output(toSharedString("Load the selected guide block before saving its edits."));
                return;
            }
            auto guideId = tutorux::archive::uuidFromString(id);
            if (!guideId) {
                window->set_guide_output(toSharedString(guideId.error().message));
                return;
            }
            auto archive = Archive::open(path, false, activePassphrase);
            if (!archive) {
                window->set_guide_output(toSharedString(archive.error().message));
                return;
            }
            auto current = archive->get(tutorux::archive::RecordType::Guide, *guideId);
            if (!current || !*current) {
                window->set_guide_output(toSharedString(current ? "Guide was not found in the active archive." : current.error().message));
                return;
            }
            if ((**current).revision != (*activeGuideEditor)->expectedRevision) {
                window->set_guide_output(toSharedString("This guide changed after the block was loaded. Reload it before saving."));
                return;
            }

            const std::string replacement(editedText.data(), editedText.size());
            auto& buffer = (*activeGuideEditor)->text;
            auto synchronized = updateGuideEditorText(**activeGuideEditor, replacement);
            if (!synchronized) {
                window->set_guide_output(toSharedString(synchronized.error().message));
                return;
            }

            auto sourceIds = guideEditorSourceIds(**activeGuideEditor);
            if (!sourceIds) {
                window->set_guide_output(toSharedString(sourceIds.error().message));
                return;
            }

            std::vector<std::string> editArguments{"guide",
                                                   "edit",
                                                   id,
                                                   "--section-index",
                                                   std::to_string(indexes->sectionIndex),
                                                   "--block-index",
                                                   std::to_string(indexes->blockIndex),
                                                   "--text",
                                                   buffer.text(),
                                                   "--kind",
                                                   (*activeGuideEditor)->kind,
                                                   "--sources",
                                                   joinSourceIds(*sourceIds)};
            auto arguments = archiveCommand(path, std::move(editArguments));
            auto saved = dispatchWithSecrets(arguments, activePassphrase);
            const std::string output = commandOutput(std::move(saved));
            window->set_guide_output(toSharedString(output));
            window->set_status_message(toSharedString(output));
            if (output.starts_with("Updated") || output.starts_with("Guide")) {
                auto latestArchive = Archive::open(path, false, activePassphrase);
                if (latestArchive) {
                    auto latest = latestArchive->get(tutorux::archive::RecordType::Guide, *guideId);
                    if (latest && *latest)
                        (*activeGuideEditor)->expectedRevision = (**latest).revision;
                }
                window->set_guide_edit_text(toSharedString(buffer.text()));
                window->set_guide_provenance(toSharedString("Saved as a new archive revision. Source references were retained."));
            }
            const std::string guideSelection(selectedGuide.data(), selectedGuide.size());
            const std::string blockSelection(selectedBlock.data(), selectedBlock.size());
            refreshWorkspace(*window, path, activePassphrase);
            window->set_selected_guide(toSharedString(guideSelection));
            auto latestArchive = Archive::open(path, false, activePassphrase);
            if (latestArchive) {
                const std::string blockStatus = populateGuideBlockOptions(*window, *latestArchive, id);
                if (!blockStatus.empty())
                    window->set_guide_provenance(toSharedString(blockStatus));
            }
            window->set_selected_guide_block(toSharedString(blockSelection));
        });

    const auto commandBusy = std::make_shared<std::atomic_bool>(false);
    const auto commandStopRequested = std::make_shared<std::atomic_bool>(false);
    const auto commandThreads = std::make_shared<std::vector<std::thread>>();
    const auto commandThreadsMutex = std::make_shared<std::mutex>();
    const slint::ComponentWeakHandle<MainWindow> weakWindow(window);
    window->on_cancel_command([weakWindow, commandBusy, commandStopRequested] {
        if (!commandBusy->load())
            return;
        commandStopRequested->store(true);
        if (auto strongWindow = weakWindow.lock()) {
            (*strongWindow)->set_status_message(toSharedString("Cancellation requested. Saving any received response."));
        }
    });
    window->on_run_command([weakWindow, commandBusy, commandStopRequested, commandThreads, commandThreadsMutex,
                            &activePassphrase](slint::SharedString requestedCommand, slint::SharedString requestedNewPassphrase) {
        const auto selectedPath = [&]() -> std::filesystem::path {
            const auto strongWindow = weakWindow.lock();
            if (!strongWindow)
                return {};
            return std::filesystem::path((*strongWindow)->get_archive_path().data());
        }();
        if (selectedPath.empty()) {
            if (auto strongWindow = weakWindow.lock()) {
                (*strongWindow)->set_command_output(toSharedString("Choose an archive before running a command."));
            }
            return;
        }

        auto parsed = parseCommandLine(std::string_view(requestedCommand.data(), requestedCommand.size()));
        if (!parsed) {
            if (auto strongWindow = weakWindow.lock()) {
                (*strongWindow)->set_command_output(toSharedString(parsed.error().message));
            }
            return;
        }

        bool expected = false;
        if (!commandBusy->compare_exchange_strong(expected, true)) {
            if (auto strongWindow = weakWindow.lock()) {
                (*strongWindow)->set_command_output(toSharedString("Wait for the current command to finish."));
            }
            return;
        }
        commandStopRequested->store(false);
        if (auto strongWindow = weakWindow.lock())
            (*strongWindow)->set_command_running(true);

        auto commandStart = parsed->begin();
        while (commandStart != parsed->end() &&
               (*commandStart == "--json" || *commandStart == "--quiet" || *commandStart == "--verbose" || *commandStart == "--no-color")) {
            ++commandStart;
        }
        const auto remainingArguments = static_cast<std::size_t>(parsed->end() - commandStart);
        const bool journalEntryResponse =
            remainingArguments >= 3 && *commandStart == "journal" && *(commandStart + 1) == "entry" &&
            (*(commandStart + 2) == "create" || *(commandStart + 2) == "show" || *(commandStart + 2) == "update");
        const bool journalDocumentResponse =
            remainingArguments >= 3 && *commandStart == "journal" && *(commandStart + 1) == "document" && *(commandStart + 2) == "show";
        const bool journalDocumentMutationResponse = remainingArguments >= 3 && *commandStart == "journal" &&
                                                     *(commandStart + 1) == "document" &&
                                                     (*(commandStart + 2) == "update" || *(commandStart + 2) == "add-block" ||
                                                      *(commandStart + 2) == "remove-block" || *(commandStart + 2) == "move-block");
        const bool journalDocumentBlockAddResponse = remainingArguments >= 3 && *commandStart == "journal" &&
                                                     *(commandStart + 1) == "document" && *(commandStart + 2) == "add-block";
        const std::string journalDocumentMutationId =
            journalDocumentMutationResponse && remainingArguments >= 4 ? *(commandStart + 3) : std::string{};
        const bool journalEntryOpensDocument = remainingArguments >= 3 && *commandStart == "journal" && *(commandStart + 1) == "entry" &&
                                               (*(commandStart + 2) == "create" || *(commandStart + 2) == "show");
        const bool journalEntryCreateResponse =
            remainingArguments >= 3 && *commandStart == "journal" && *(commandStart + 1) == "entry" && *(commandStart + 2) == "create";
        const bool journalEntryListResponse =
            remainingArguments >= 3 && *commandStart == "journal" && *(commandStart + 1) == "entry" && *(commandStart + 2) == "list";
        const bool journalSessionListResponse = remainingArguments >= 2 && *commandStart == "session" && *(commandStart + 1) == "list";
        const bool journalSessionCreateResponse = remainingArguments >= 2 && *commandStart == "session" && *(commandStart + 1) == "create";
        const bool journalSessionDeleteResponse = remainingArguments >= 3 && *commandStart == "session" && *(commandStart + 1) == "delete";
        const bool journalSessionDeleteConfirmation =
            journalSessionDeleteResponse && std::find(parsed->begin(), parsed->end(), "--confirm-scope") != parsed->end();
        const std::string journalSessionDeleteId = journalSessionDeleteResponse ? *(commandStart + 2) : std::string{};
        const bool journalEntryGuideResponse = remainingArguments >= 2 && *commandStart == "guide" && *(commandStart + 1) == "generate" &&
                                               std::find(parsed->begin(), parsed->end(), "--entry-id") != parsed->end();
        const bool foregroundRecording = parsed->end() - commandStart >= 2 && *commandStart == "record" && *(commandStart + 1) == "start" &&
                                         std::find(parsed->begin(), parsed->end(), "--detach") == parsed->end();
        if (foregroundRecording) {
            commandBusy->store(false);
            if (auto strongWindow = weakWindow.lock()) {
                (*strongWindow)->set_command_running(false);
                (*strongWindow)
                    ->set_command_output(toSharedString("Run foreground recording from the CLI, or add --detach "
                                                        "so the recording "
                                                        "worker remains controllable outside this window."));
            }
            return;
        }

        std::vector<std::string> arguments{"--archive", selectedPath.string(), "--directory", selectedPath.parent_path().string()};
        arguments.insert(arguments.end(), std::make_move_iterator(parsed->begin()), std::make_move_iterator(parsed->end()));
        if (auto strongWindow = weakWindow.lock()) {
            (*strongWindow)->set_command_output(toSharedString("Running command…"));
            (*strongWindow)->set_status_message(toSharedString("Running command against the selected archive."));
        }

        std::string commandPassphrase = activePassphrase;
        std::string newPassphrase(requestedNewPassphrase.data(), requestedNewPassphrase.size());
        bool changesPassphrase =
            parsed->size() >= 2 && parsed->front() == "archive" && ((*parsed)[1] == "encrypt" || (*parsed)[1] == "change-passphrase");
        if (changesPassphrase && parsed->size() > 2) {
            std::filesystem::path commandArchive((*parsed)[2]);
            if (commandArchive.is_relative())
                commandArchive = selectedPath.parent_path() / commandArchive;
            std::error_code pathError;
            const auto normalizedCommandArchive = std::filesystem::absolute(commandArchive, pathError).lexically_normal();
            changesPassphrase = !pathError && normalizedCommandArchive == selectedPath.lexically_normal();
        }
        if (auto strongWindow = weakWindow.lock())
            (*strongWindow)->set_new_archive_passphrase(toSharedString(""));

        std::thread worker([weakWindow, commandBusy, commandStopRequested, selectedPath, &activePassphrase, changesPassphrase,
                            journalEntryResponse, journalEntryOpensDocument, journalEntryCreateResponse, journalDocumentResponse,
                            journalDocumentMutationResponse, journalDocumentBlockAddResponse, journalDocumentMutationId,
                            journalEntryListResponse, journalSessionListResponse, journalSessionCreateResponse,
                            journalSessionDeleteResponse, journalSessionDeleteConfirmation, journalSessionDeleteId,
                            journalEntryGuideResponse, commandPassphrase = std::move(commandPassphrase),
                            newPassphrase = std::move(newPassphrase), arguments = std::move(arguments)]() mutable {
            std::string output;
            int exitCode = 2;
            try {
                auto command = dispatchWithSecrets(
                    arguments, commandPassphrase, newPassphrase,
                    [weakWindow,
                     liveOutputTruncated = std::make_shared<std::atomic_bool>(false)](const tutorux::command::ProgressEvent& event) {
                        if (event.phase != "ai-generation-text")
                            return;
                        if (liveOutputTruncated->load())
                            return;
                        std::string delta = event.message;
                        static_cast<void>(
                            slint::invoke_from_event_loop([weakWindow, liveOutputTruncated, delta = std::move(delta)]() mutable {
                                auto strongWindow = weakWindow.lock();
                                if (!strongWindow)
                                    return;
                                const auto displayed = (*strongWindow)->get_command_output();
                                std::string current(displayed.data(), displayed.size());
                                if (current == "Running command…")
                                    current.clear();
                                constexpr std::size_t maximumStreamDisplayBytes = 256U * 1024U;
                                if (current.size() + delta.size() > maximumStreamDisplayBytes) {
                                    liveOutputTruncated->store(true);
                                    (*strongWindow)
                                        ->set_command_output(toSharedString("Streaming response exceeded the 256 KiB live display "
                                                                            "limit. The complete response will be retained in the "
                                                                            "archive.\n"));
                                    return;
                                }
                                current += delta;
                                (*strongWindow)->set_command_output(toSharedString(current));
                                (*strongWindow)->set_status_message(toSharedString("Receiving AI response…"));
                            }));
                    },
                    [commandStopRequested] {
                        return commandStopRequested->load();
                    });
                output = commandResultText(command);
                if (command)
                    exitCode = command->exitCode;
            } catch (const std::exception& exception) {
                output = std::string("Command failed: ") + exception.what();
            } catch (...) {
                output = "Command failed with an unknown error.";
            }

            std::string refreshPassphrase = exitCode == 0 && changesPassphrase ? newPassphrase : commandPassphrase;
            eraseSecret(commandPassphrase);
            eraseSecret(newPassphrase);

            commandBusy->store(false);
            static_cast<void>(slint::invoke_from_event_loop(
                [weakWindow, selectedPath, exitCode, changesPassphrase, journalEntryResponse, journalEntryOpensDocument,
                 journalEntryCreateResponse, journalDocumentResponse, journalDocumentMutationResponse, journalDocumentBlockAddResponse,
                 journalDocumentMutationId, journalEntryListResponse, journalSessionListResponse, journalSessionCreateResponse,
                 journalSessionDeleteResponse, journalSessionDeleteConfirmation, journalSessionDeleteId, journalEntryGuideResponse,
                 &activePassphrase, refreshPassphrase = std::move(refreshPassphrase), output = std::move(output)]() mutable {
                    auto strongWindow = weakWindow.lock();
                    if (!strongWindow) {
                        eraseSecret(refreshPassphrase);
                        return;
                    }
                    constexpr std::string_view packageJobMarker = "as job ";
                    const std::size_t packageJobPosition = output.find(packageJobMarker);
                    if (packageJobPosition != std::string::npos) {
                        const std::size_t idStart = packageJobPosition + packageJobMarker.size();
                        if (idStart <= output.size() && output.size() - idStart >= 36) {
                            const std::string_view candidate(output.data() + idStart, 36);
                            if (tutorux::archive::uuidFromString(candidate))
                                (*strongWindow)->set_ai_package_job_id(toSharedString(candidate));
                        }
                    }
                    (*strongWindow)->set_command_output(toSharedString(output));
                    if (exitCode == 0 && journalEntryResponse) {
                        if (journalEntryCreateResponse)
                            (*strongWindow)->set_journal_entry_create_open(false);
                        if (auto entryId = jsonStringField(output, "id")) {
                            (*strongWindow)->set_journal_entry_id(toSharedString(*entryId));
                            const auto choices = (*strongWindow)->get_journal_entry_options();
                            for (std::size_t row = 0; row < choices->row_count(); ++row) {
                                const auto choice = choices->row_data(row);
                                if (choice && selectionId(*choice) == *entryId) {
                                    (*strongWindow)->set_selected_journal_entry(*choice);
                                    break;
                                }
                            }
                        }
                        if (auto title = jsonStringField(output, "title"))
                            (*strongWindow)->set_journal_entry_title(toSharedString(*title));
                        if (auto date = jsonStringField(output, "entry_date"))
                            (*strongWindow)->set_journal_entry_date(toSharedString(*date));
                        if (auto collections = jsonStringField(output, "collection_ids"))
                            (*strongWindow)->set_journal_entry_collections(toSharedString(*collections));
                        if (auto tags = jsonStringField(output, "tag_ids"))
                            (*strongWindow)->set_journal_entry_tags(toSharedString(*tags));
                        if (auto documentId = jsonStringField(output, "notes_document_id")) {
                            (*strongWindow)->set_journal_document_id(toSharedString(*documentId));
                        }
                        if (auto notesText = jsonStringField(output, "notes_text")) {
                            (*strongWindow)->set_journal_document_text(toSharedString(*notesText));
                        }
                    }
                    if (exitCode == 0 && journalDocumentResponse) {
                        setJournalDocumentFromJson(**strongWindow, output);
                    }
                    (*strongWindow)->set_command_running(false);
                    (*strongWindow)->set_status_message(toSharedString(exitCode == 0 ? "Command completed." : "Command failed."));
                    if (exitCode == 0 && std::filesystem::path((*strongWindow)->get_archive_path().data()) == selectedPath) {
                        if (changesPassphrase) {
                            eraseSecret(activePassphrase);
                            activePassphrase = refreshPassphrase;
                        }
                        refreshWorkspace(**strongWindow, selectedPath, refreshPassphrase);
                    }
                    if (exitCode == 0 && journalEntryOpensDocument) {
                        const auto documentId = jsonStringField(output, "notes_document_id");
                        if (documentId && tutorux::archive::uuidFromString(*documentId)) {
                            auto document = dispatchWithSecrets(
                                archiveCommand(selectedPath, {"--json", "journal", "document", "show", *documentId}), refreshPassphrase);
                            if (document && document->exitCode == 0)
                                setJournalDocumentFromJson(**strongWindow, document->output);
                        }
                    }
                    if (exitCode == 0 && journalDocumentMutationResponse && tutorux::archive::uuidFromString(journalDocumentMutationId)) {
                        auto document = dispatchWithSecrets(
                            archiveCommand(selectedPath, {"--json", "journal", "document", "show", journalDocumentMutationId}),
                            refreshPassphrase);
                        if (document && document->exitCode == 0)
                            setJournalDocumentFromJson(**strongWindow, document->output);
                        if (journalDocumentBlockAddResponse)
                            (*strongWindow)->set_journal_document_new_block_text(toSharedString(""));
                    }
                    if (exitCode == 0 && journalSessionCreateResponse) {
                        if (auto sessionId = jsonStringField(output, "id")) {
                            (*strongWindow)->set_journal_session_id(toSharedString(*sessionId));
                            (*strongWindow)->set_selected_session(toSharedString("Session · " + *sessionId));
                            const auto sessionType = jsonStringField(output, "session_type");
                            if (sessionType && (*sessionType == "record-audio" || *sessionType == "import-recording")) {
                                if (*sessionType == "import-recording") {
                                    (*strongWindow)
                                        ->set_status_message(toSharedString("Session created. Open recording controls to choose its "
                                                                            "WAV recording."));
                                } else {
                                    (*strongWindow)
                                        ->set_status_message(toSharedString("Session created. Open recording controls to check the "
                                                                            "microphone and start capture."));
                                }
                            }
                        }
                    }
                    if (exitCode == 0 && journalEntryListResponse) {
                        const auto choices = journalEntryChoices(output);
                        (*strongWindow)->set_journal_list_output(toSharedString(journalEntryListSummary(output)));
                        (*strongWindow)->set_journal_entry_options(std::make_shared<slint::VectorModel<slint::SharedString>>(choices));
                        const auto selectedEntryId =
                            std::string((*strongWindow)->get_journal_entry_id().data(), (*strongWindow)->get_journal_entry_id().size());
                        const auto selectedChoice = std::find_if(choices.begin(), choices.end(), [&](const slint::SharedString& choice) {
                            return selectionId(choice) == selectedEntryId;
                        });
                        (*strongWindow)
                            ->set_selected_journal_entry(selectedChoice != choices.end() ? *selectedChoice
                                                         : choices.empty()               ? toSharedString("")
                                                                                         : choices.front());
                    }
                    if (exitCode == 0 && journalSessionListResponse) {
                        const auto choices = journalSessionChoices(output);
                        (*strongWindow)->set_journal_timeline_output(toSharedString(journalSessionListSummary(output)));
                        (*strongWindow)->set_journal_session_options(std::make_shared<slint::VectorModel<slint::SharedString>>(choices));
                        (*strongWindow)->set_journal_session_id(toSharedString(""));
                        (*strongWindow)->set_selected_journal_session(choices.empty() ? toSharedString("") : choices.front());
                    }
                    if (exitCode == 0 && journalEntryGuideResponse) {
                        if (const auto guideId = jsonStringField(output, "id")) {
                            const std::string title = jsonStringField(output, "title").value_or("Study Guide");
                            (*strongWindow)->set_selected_guide(toSharedString(title + " · " + *guideId));
                            (*strongWindow)
                                ->set_journal_guide_output(
                                    toSharedString("Draft guide created for this entry. Review it before approval: " + *guideId));
                        }
                    }
                    if (exitCode == 0 && journalSessionDeleteResponse) {
                        const auto deleteStatus = jsonStringField(output, "status");
                        if (!journalSessionDeleteConfirmation && deleteStatus && *deleteStatus == "confirmation-required") {
                            const auto fieldOrZero = [&](std::string_view name) {
                                const auto value = jsonStringField(output, name);
                                return value.value_or("0");
                            };
                            std::string scope = "Review the records that will be removed with this session:\n";
                            scope += "Audio chunks: " + fieldOrZero("audio_chunks") + "\n";
                            scope += "Transcript segments: " + fieldOrZero("transcript_segments") + "\n";
                            scope += "Annotations: " + fieldOrZero("annotations") + "\n";
                            scope += "Session notes: " + fieldOrZero("session_notes") + "\n";
                            scope += "Study guides: " + fieldOrZero("guides") + "\n";
                            scope += "Assets: " + fieldOrZero("assets") + "\n";
                            scope += "Evidence nodes: " + fieldOrZero("evidence_nodes") + "\n";
                            scope += "Total records: " + fieldOrZero("total_records");
                            (*strongWindow)->set_journal_session_delete_scope_output(toSharedString(scope));
                            (*strongWindow)->set_journal_session_delete_preview_id(toSharedString(journalSessionDeleteId));
                            (*strongWindow)
                                ->set_journal_session_delete_scope_token(
                                    toSharedString(jsonStringField(output, "scope_token").value_or("")));
                            (*strongWindow)->set_journal_session_delete_scope_reviewed(true);
                            (*strongWindow)->set_journal_session_delete_confirmed(false);
                        } else if (journalSessionDeleteConfirmation && deleteStatus && *deleteStatus == "deleted") {
                            (*strongWindow)
                                ->set_journal_session_delete_scope_output(
                                    toSharedString("Session and the reviewed associated records were deleted."));
                            (*strongWindow)->set_journal_session_delete_preview_id(toSharedString(""));
                            (*strongWindow)->set_journal_session_delete_scope_token(toSharedString(""));
                            (*strongWindow)->set_journal_session_delete_scope_reviewed(false);
                            (*strongWindow)->set_journal_session_delete_confirmed(false);
                        }
                    }
                    if (exitCode != 0 && journalSessionDeleteConfirmation) {
                        (*strongWindow)
                            ->set_journal_session_delete_scope_output(toSharedString("Deletion was not completed. Review the current scope "
                                                                                     "before trying again."));
                        (*strongWindow)->set_journal_session_delete_preview_id(toSharedString(""));
                        (*strongWindow)->set_journal_session_delete_scope_token(toSharedString(""));
                        (*strongWindow)->set_journal_session_delete_scope_reviewed(false);
                    }
                    eraseSecret(refreshPassphrase);
                }));
        });
        {
            const std::scoped_lock lock(*commandThreadsMutex);
            commandThreads->push_back(std::move(worker));
        }
    });

    window->run();
    if (playbackStop)
        playbackStop->store(true);
    if (waveformStop)
        waveformStop->store(true);
    for (auto& playbackThread : *playbackThreads) {
        if (playbackThread.joinable())
            playbackThread.join();
    }
    for (auto& commandThread : *commandThreads) {
        if (commandThread.joinable())
            commandThread.join();
    }
    return 0;
}

} // namespace tutorux::gui
