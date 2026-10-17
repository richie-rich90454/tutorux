if(NOT DEFINED SLINT_CONFIG_HEADER OR NOT EXISTS "${SLINT_CONFIG_HEADER}")
    message(FATAL_ERROR "The pinned Slint C++ configuration header was not found.")
endif()

file(READ "${SLINT_CONFIG_HEADER}" TUTORUX_SLINT_CONFIG)
if(TUTORUX_SLINT_CONFIG MATCHES "#if defined\\(TUTORUX_STATIC_SLINT\\)")
    return()
endif()

set(TUTORUX_SLINT_IMPORT_BLOCK "#if !defined(DOXYGEN)\n#    if defined(_MSC_VER)")
set(TUTORUX_SLINT_STATIC_IMPORT_BLOCK
    "#if defined(TUTORUX_STATIC_SLINT)\n#    define SLINT_DLL_IMPORT\n#elif !defined(DOXYGEN)\n#    if defined(_MSC_VER)"
)
string(FIND "${TUTORUX_SLINT_CONFIG}" "${TUTORUX_SLINT_IMPORT_BLOCK}" TUTORUX_SLINT_IMPORT_OFFSET)
if(TUTORUX_SLINT_IMPORT_OFFSET EQUAL -1)
    message(FATAL_ERROR "The pinned Slint import declaration no longer matches the static patch.")
endif()

string(REPLACE
    "${TUTORUX_SLINT_IMPORT_BLOCK}"
    "${TUTORUX_SLINT_STATIC_IMPORT_BLOCK}"
    TUTORUX_SLINT_CONFIG
    "${TUTORUX_SLINT_CONFIG}"
)
file(WRITE "${SLINT_CONFIG_HEADER}" "${TUTORUX_SLINT_CONFIG}")
