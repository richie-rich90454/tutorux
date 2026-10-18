#include "tutorux/document/editor.hpp"

#include <iostream>
#include <string>
#include <string_view>
#include <utility>

namespace {

bool edit(tutorux::document::PieceTable& document, std::size_t offset, std::string_view removedText,
          std::string_view insertedText, std::size_t cursor, std::string origin = "typing",
          bool coalesce = true) {
    tutorux::document::DocumentEditTransaction transaction;
    transaction.selectionBefore = document.selection();
    transaction.selectionAfter = {cursor, cursor};
    transaction.origin = std::move(origin);
    transaction.coalesceWithPrevious = coalesce;
    transaction.operations.push_back({offset, std::string(insertedText), std::string(removedText)});
    return document.apply(transaction).has_value();
}

bool expectText(const tutorux::document::PieceTable& document, std::string_view expected,
                std::string_view scenario) {
    if (document.text() == expected)
        return true;
    std::cerr << scenario << ": unexpected document text\n";
    return false;
}

} // namespace

int main() {
    using tutorux::document::PieceTable;

    auto typingResult = PieceTable::create("note");
    if (!typingResult)
        return 1;
    auto typing = std::move(*typingResult);
    if (!edit(typing, 4, "", " ", 5) || !edit(typing, 5, "", "one", 8) ||
        !expectText(typing, "note one", "adjacent typing")) {
        return 1;
    }
    if (!typing.undo() || !expectText(typing, "note", "typing undo") || typing.canUndo()) {
        std::cerr << "Adjacent typing did not undo as one operation.\n";
        return 1;
    }
    if (!typing.redo() || !expectText(typing, "note one", "typing redo"))
        return 1;

    auto backspaceResult = PieceTable::create("testing");
    if (!backspaceResult)
        return 1;
    auto backspace = std::move(*backspaceResult);
    if (!edit(backspace, 6, "g", "", 6) || !edit(backspace, 5, "n", "", 5) ||
        !expectText(backspace, "testi", "backspace sequence") || !backspace.undo() ||
        !expectText(backspace, "testing", "backspace undo") || backspace.canUndo()) {
        std::cerr << "Adjacent backspaces did not undo as one operation.\n";
        return 1;
    }

    auto deleteResult = PieceTable::create("testing");
    if (!deleteResult)
        return 1;
    auto deletion = std::move(*deleteResult);
    if (!edit(deletion, 0, "t", "", 0) || !edit(deletion, 0, "e", "", 0) ||
        !expectText(deletion, "sting", "forward delete sequence") || !deletion.undo() ||
        !expectText(deletion, "testing", "forward delete undo") || deletion.canUndo()) {
        std::cerr << "Adjacent forward deletes did not undo as one operation.\n";
        return 1;
    }

    auto boundaryResult = PieceTable::create("note");
    if (!boundaryResult)
        return 1;
    auto boundary = std::move(*boundaryResult);
    if (!edit(boundary, 4, "", " ", 5) || !edit(boundary, 5, "", "\n", 6) || !boundary.undo() ||
        !expectText(boundary, "note ", "newline undo")) {
        std::cerr << "A paragraph break was incorrectly merged with adjacent typing.\n";
        return 1;
    }

    auto originResult = PieceTable::create("note");
    if (!originResult)
        return 1;
    auto origins = std::move(*originResult);
    if (!edit(origins, 4, "", " ", 5, "keyboard") || !edit(origins, 5, "", "pasted", 11, "paste") ||
        !origins.undo() || !expectText(origins, "note ", "undo origin boundary")) {
        std::cerr << "Different edit origins were incorrectly coalesced.\n";
        return 1;
    }

    return 0;
}
