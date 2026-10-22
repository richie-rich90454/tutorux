// Unit coverage for the production piece-table editor, including Unicode boundaries.
#include "tutorux/document/editor.hpp"

#include <iostream>
#include <string>
#include <string_view>

namespace {

bool expect(bool condition, std::string_view label) {
    if (condition)
        return true;
    std::cerr << "editor units: " << label << '\n';
    return false;
}

template <typename T>
bool expectError(const tutorux::core::Result<T>& result, std::string_view label,
                 std::string_view code = {}) {
    if (result)
        return expect(false, label);
    if (!code.empty() && result.error().code != code)
        return expect(false, std::string(label) + ": unexpected code " + result.error().code);
    return true;
}

bool expectStatusError(const tutorux::core::Status& status, std::string_view label) {
    return status ? expect(false, label) : true;
}

} // namespace

int main() {
    using namespace tutorux;
    bool okay = true;

    expectError(document::PieceTable::create(std::string("\xFF", 1)),
                "invalid UTF-8 document accepted");

    auto created = document::PieceTable::create("Hello\nWorld");
    if (!created) {
        std::cerr << "editor units: unable to create the document\n";
        return 1;
    }
    document::PieceTable editor = std::move(*created);
    okay &= expect(editor.size() == 11 && !editor.empty() &&
                       editor.text() == "Hello\nWorld",
                   "initial document state is wrong");

    okay &= expect(editor.setSelection({0, 5}).has_value(), "selection failed");
    okay &= expect(editor.selection().anchor == 0 && editor.selection().focus == 5,
                   "selection was not retained");
    okay &= expectStatusError(editor.setSelection({0, 100}),
                              "out-of-range selection accepted");

    auto replaced = editor.replace({0, 5}, "Howdy");
    okay &= expect(replaced && editor.text() == "Howdy\nWorld",
                   "range replacement failed");
    okay &= expect(editor.canUndo(), "undo was not recorded");
    auto undone = editor.undo();
    okay &= expect(undone && editor.text() == "Hello\nWorld", "undo failed");
    auto redone = editor.redo();
    okay &= expect(redone && editor.text() == "Howdy\nWorld", "redo failed");
    okay &= expectError(editor.replace({10, 1}, "x"), "reversed range accepted",
                        "document_range_invalid");
    okay &= expectError(editor.replace({0, 100}, "x"), "oversized range accepted",
                        "document_range_invalid");

    document::DocumentEditTransaction transaction;
    transaction.operations.push_back({0, "Hi", "Howdy"});
    transaction.selectionAfter = {2, 2};
    auto applied = editor.apply(transaction);
    okay &= expect(applied && editor.text() == "Hi\nWorld", "transaction apply failed");
    transaction.operations.clear();
    auto emptyTransaction = editor.apply(transaction);
    okay &= expect(emptyTransaction && emptyTransaction->operationCount == 0,
                   "empty transaction was not a no-op");

    auto snapshot = editor.applyTextSnapshot(
        "Hi there\nWorld", {}, 0, document::TextSelection{8, 8});
    okay &= expect(snapshot && editor.text() == "Hi there\nWorld",
                   "text snapshot failed");
    auto unchanged = editor.applyTextSnapshot("Hi there\nWorld");
    okay &= expect(unchanged && unchanged->operationCount == 0,
                   "unchanged snapshot produced an edit");
    okay &= expectError(editor.applyTextSnapshot(std::string("\xFF", 1)),
                        "invalid UTF-8 snapshot accepted");

    editor = std::move(*document::PieceTable::create("one two one"));
    auto replacedAll = editor.replaceAll("one", "1");
    okay &= expect(replacedAll && editor.text() == "1 two 1",
                   "replace-all failed");
    okay &= expectError(editor.replaceAll("", "x"), "empty search accepted",
                        "document_search_empty");
    auto noMatches = editor.replaceAll("missing", "x");
    okay &= expect(noMatches && noMatches->operationCount == 0,
                   "no-match replace-all produced an edit");
    okay &= expect(editor.findAll("1").size() == 2, "find-all result is wrong");
    okay &= expect(editor.findAll("").empty(), "empty find-all returned matches");

    auto unicode = document::PieceTable::create("a\xF0\x9F\x98\x80" "b");
    okay &= expect(unicode.has_value(), "Unicode document creation failed");
    if (unicode) {
        auto& text = *unicode;
        okay &= expect(text.nextCodePoint(1) == 5, "next code point is wrong");
        okay &= expect(text.previousCodePoint(5) == 1, "previous code point is wrong");
        okay &= expect(text.nextGrapheme(1) == 5, "next grapheme is wrong");
        okay &= expect(text.previousGrapheme(5) == 1, "previous grapheme is wrong");
        okay &= expectError(text.nextCodePoint(2), "non-boundary cursor accepted",
                            "document_cursor_invalid");
        auto paragraph = text.paragraphAt(0);
        okay &= expect(paragraph.start == 0, "paragraph start is wrong");
    }

    auto freshResult = document::PieceTable::create("fresh");
    if (freshResult) {
        document::PieceTable fresh = std::move(*freshResult);
        okay &= expectError(fresh.undo(), "empty undo succeeded", "document_undo_empty");
        okay &= expectError(fresh.redo(), "empty redo succeeded", "document_redo_empty");
    } else {
        okay &= expect(false, "fresh editor creation failed");
    }

    return okay ? 0 : 1;
}
