if(NOT DEFINED OUTPUT OR NOT DEFINED FONT_DIR)
    message(FATAL_ERROR "OUTPUT and FONT_DIR are required")
endif()

file(WRITE "${OUTPUT}" "#include \"font_data.hpp\"
namespace tutorux::gui::fonts {
")

foreach(weight Regular Medium SemiBold Bold)
    set(font_file "${FONT_DIR}/NotoSans-${weight}.ttf")
    if(NOT EXISTS "${font_file}")
        message(FATAL_ERROR "Missing font: ${font_file}")
    endif()
    file(READ "${font_file}" hex HEX)
    string(LENGTH "${hex}" hex_length)
    math(EXPR byte_length "${hex_length} / 2")
    string(REGEX REPLACE "([0-9a-f][0-9a-f])" "0x\\1," bytes "${hex}")
    file(APPEND "${OUTPUT}" "extern const unsigned char NotoSans${weight}Data[] = {${bytes}};
extern const std::size_t NotoSans${weight}Size = ${byte_length};
")
endforeach()

file(APPEND "${OUTPUT}" "}
")
