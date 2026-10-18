if(NOT DEFINED GIT_EXECUTABLE OR NOT DEFINED SOURCE_DIR OR NOT DEFINED PATCH_FILE)
    message(FATAL_ERROR "FFmpeg patch application requires Git, source, and patch paths.")
endif()

if(NOT EXISTS "${SOURCE_DIR}/.git" OR NOT EXISTS "${PATCH_FILE}")
    message(FATAL_ERROR "The pinned FFmpeg checkout or security patch is missing.")
endif()

execute_process(
    COMMAND "${GIT_EXECUTABLE}" -C "${SOURCE_DIR}" apply --check "${PATCH_FILE}"
    RESULT_VARIABLE TUTORUX_FFMPEG_PATCH_CHECK_RESULT
    OUTPUT_VARIABLE TUTORUX_FFMPEG_PATCH_CHECK_OUTPUT
    ERROR_VARIABLE TUTORUX_FFMPEG_PATCH_CHECK_ERROR
)
if(TUTORUX_FFMPEG_PATCH_CHECK_RESULT EQUAL 0)
    execute_process(
        COMMAND "${GIT_EXECUTABLE}" -C "${SOURCE_DIR}" apply "${PATCH_FILE}"
        RESULT_VARIABLE TUTORUX_FFMPEG_PATCH_APPLY_RESULT
        OUTPUT_VARIABLE TUTORUX_FFMPEG_PATCH_APPLY_OUTPUT
        ERROR_VARIABLE TUTORUX_FFMPEG_PATCH_APPLY_ERROR
    )
    if(NOT TUTORUX_FFMPEG_PATCH_APPLY_RESULT EQUAL 0)
        message(FATAL_ERROR
            "Could not apply the pinned FFmpeg security patch: ${TUTORUX_FFMPEG_PATCH_APPLY_ERROR}"
        )
    endif()
else()
    execute_process(
        COMMAND "${GIT_EXECUTABLE}" -C "${SOURCE_DIR}" apply --reverse --check "${PATCH_FILE}"
        RESULT_VARIABLE TUTORUX_FFMPEG_PATCH_ALREADY_APPLIED
        OUTPUT_QUIET
        ERROR_QUIET
    )
    if(NOT TUTORUX_FFMPEG_PATCH_ALREADY_APPLIED EQUAL 0)
        message(FATAL_ERROR
            "The pinned FFmpeg security patch does not apply cleanly: "
            "${TUTORUX_FFMPEG_PATCH_CHECK_ERROR}"
        )
    endif()
endif()
