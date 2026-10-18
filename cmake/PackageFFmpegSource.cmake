if(NOT DEFINED GIT_EXECUTABLE OR NOT DEFINED SOURCE_DIR OR NOT DEFINED PATCH_FILE OR
   NOT DEFINED SOURCE_COMMIT OR NOT DEFINED OUTPUT_ARCHIVE)
    message(FATAL_ERROR "FFmpeg source packaging requires Git, source, patch, commit, and output.")
endif()

if(NOT EXISTS "${SOURCE_DIR}/.git" OR NOT EXISTS "${PATCH_FILE}")
    message(FATAL_ERROR "The pinned FFmpeg checkout or security patch is missing.")
endif()

get_filename_component(_output_directory "${OUTPUT_ARCHIVE}" DIRECTORY)
file(MAKE_DIRECTORY "${_output_directory}")
set(_staging_directory "${_output_directory}/source-stage")
set(_source_archive "${_output_directory}/ffmpeg-upstream.tar")
set(_source_root "${_staging_directory}/FFmpeg-9.0.2")
file(REMOVE_RECURSE "${_staging_directory}")
file(REMOVE "${_source_archive}" "${OUTPUT_ARCHIVE}")
file(MAKE_DIRECTORY "${_staging_directory}")

execute_process(
    COMMAND "${GIT_EXECUTABLE}" -C "${SOURCE_DIR}" archive
            --format=tar --prefix=FFmpeg-9.0.2/ -o "${_source_archive}" "${SOURCE_COMMIT}"
    RESULT_VARIABLE _archive_result
    ERROR_VARIABLE _archive_error
)
if(NOT _archive_result EQUAL 0)
    message(FATAL_ERROR "Could not archive pinned FFmpeg source: ${_archive_error}")
endif()

file(ARCHIVE_EXTRACT INPUT "${_source_archive}" DESTINATION "${_staging_directory}")
file(REMOVE "${_source_archive}")
if(NOT EXISTS "${_source_root}/configure")
    message(FATAL_ERROR "Pinned FFmpeg source archive did not contain configure.")
endif()

execute_process(
    COMMAND "${GIT_EXECUTABLE}" -C "${_source_root}" apply --check "${PATCH_FILE}"
    RESULT_VARIABLE _patch_check_result
    ERROR_VARIABLE _patch_check_error
)
if(NOT _patch_check_result EQUAL 0)
    message(FATAL_ERROR "The security patch does not apply to the pinned source: ${_patch_check_error}")
endif()
execute_process(
    COMMAND "${GIT_EXECUTABLE}" -C "${_source_root}" apply "${PATCH_FILE}"
    RESULT_VARIABLE _patch_apply_result
    ERROR_VARIABLE _patch_apply_error
)
if(NOT _patch_apply_result EQUAL 0)
    message(FATAL_ERROR "Could not apply the security patch to packaged FFmpeg source: ${_patch_apply_error}")
endif()

file(ARCHIVE_CREATE
    OUTPUT "${OUTPUT_ARCHIVE}"
    PATHS FFmpeg-9.0.2
    WORKING_DIRECTORY "${_staging_directory}"
    FORMAT gnutar
    COMPRESSION GZip
)
file(SHA256 "${OUTPUT_ARCHIVE}" _source_archive_sha256)
get_filename_component(_source_archive_name "${OUTPUT_ARCHIVE}" NAME)
file(WRITE "${OUTPUT_ARCHIVE}.sha256" "${_source_archive_sha256}  ${_source_archive_name}\n")
file(REMOVE_RECURSE "${_staging_directory}")
