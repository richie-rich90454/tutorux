if(NOT DEFINED TUTORUX_RUNTIME_EXECUTABLE)
    message(FATAL_ERROR "The runtime executable is required for static-link verification.")
endif()

if(POLICY CMP0207)
    cmake_policy(SET CMP0207 NEW)
endif()

if(WIN32)
    set(TUTORUX_PRE_EXCLUDE_REGEXES "^api-ms-" "^ext-ms-")
    set(TUTORUX_POST_EXCLUDE_REGEXES
        ".*[Ww][Ii][Nn][Dd][Oo][Ww][Ss]/([Ss][Yy][Ss][Tt][Ee][Mm]32|[Ss][Yy][Ss][Ww][Oo]64)/.*"
    )
elseif(APPLE)
    set(TUTORUX_POST_EXCLUDE_REGEXES "^/System/Library/.*" "^/usr/lib/.*")
elseif(UNIX)
    set(TUTORUX_POST_EXCLUDE_REGEXES "^/lib/.*" "^/usr/lib/.*")
endif()

set(TUTORUX_RUNTIME_SCAN_OPTIONS)
if(TUTORUX_PRE_EXCLUDE_REGEXES)
    list(APPEND TUTORUX_RUNTIME_SCAN_OPTIONS
        PRE_EXCLUDE_REGEXES ${TUTORUX_PRE_EXCLUDE_REGEXES}
    )
endif()
if(TUTORUX_POST_EXCLUDE_REGEXES)
    list(APPEND TUTORUX_RUNTIME_SCAN_OPTIONS
        POST_EXCLUDE_REGEXES ${TUTORUX_POST_EXCLUDE_REGEXES}
    )
endif()

file(GET_RUNTIME_DEPENDENCIES
    EXECUTABLES "${TUTORUX_RUNTIME_EXECUTABLE}"
    RESOLVED_DEPENDENCIES_VAR TUTORUX_RESOLVED_DEPENDENCIES
    UNRESOLVED_DEPENDENCIES_VAR TUTORUX_UNRESOLVED_DEPENDENCIES
    ${TUTORUX_RUNTIME_SCAN_OPTIONS}
)

if(TUTORUX_RESOLVED_DEPENDENCIES)
    message(FATAL_ERROR
        "Static runtime verification found non-system shared dependencies: "
        "${TUTORUX_RESOLVED_DEPENDENCIES}"
    )
endif()

if(TUTORUX_UNRESOLVED_DEPENDENCIES)
    message(FATAL_ERROR
        "Static runtime verification found unresolved dependencies: "
        "${TUTORUX_UNRESOLVED_DEPENDENCIES}"
    )
endif()
