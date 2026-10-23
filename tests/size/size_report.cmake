if(NOT DEFINED TUTORUX_BINARY OR NOT EXISTS "${TUTORUX_BINARY}")
    message(FATAL_ERROR "Tutorux size check needs an existing TUTORUX_BINARY.")
endif()
if(NOT DEFINED TUTORUX_SIZE_LIMIT_BYTES OR TUTORUX_SIZE_LIMIT_BYTES STREQUAL "")
    message(FATAL_ERROR "Tutorux size check needs TUTORUX_SIZE_LIMIT_BYTES.")
endif()

file(SIZE "${TUTORUX_BINARY}" actual_size)
math(EXPR actual_mb "${actual_size} / 1000000")
math(EXPR limit_mb "${TUTORUX_SIZE_LIMIT_BYTES} / 1000000")

set(report
    "Tutorux binary size report\n"
    "profile: ${TUTORUX_SIZE_PROFILE}\n"
    "binary: ${TUTORUX_BINARY}\n"
    "size: ${actual_size} bytes (${actual_mb} MB)\n"
    "limit: ${TUTORUX_SIZE_LIMIT_BYTES} bytes (${limit_mb} MB)\n"
)
if(DEFINED TUTORUX_OBJDUMP AND EXISTS "${TUTORUX_OBJDUMP}")
    execute_process(
        COMMAND "${TUTORUX_OBJDUMP}" -h "${TUTORUX_BINARY}"
        OUTPUT_VARIABLE sections
        RESULT_VARIABLE objdump_result
    )
    if(objdump_result EQUAL 0)
        string(APPEND report "\nsection sizes:\n${sections}\n")
    endif()
endif()

if(DEFINED TUTORUX_SIZE_REPORT AND NOT TUTORUX_SIZE_REPORT STREQUAL "")
    file(WRITE "${TUTORUX_SIZE_REPORT}" "${report}")
endif()
message(STATUS "${report}")

if(actual_size GREATER TUTORUX_SIZE_LIMIT_BYTES)
    message(FATAL_ERROR
        "Tutorux binary is ${actual_size} bytes, over the ${TUTORUX_SIZE_LIMIT_BYTES}-byte budget."
    )
endif()
