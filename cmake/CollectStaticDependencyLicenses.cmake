if(NOT DEFINED PLATFORM OR NOT DEFINED ARCHIVE_PATHS OR
   NOT DEFINED OUTPUT_DIRECTORY OR NOT DEFINED MANIFEST_FILE)
    message(FATAL_ERROR "Static license collection requires PLATFORM, ARCHIVE_PATHS, OUTPUT_DIRECTORY, and MANIFEST_FILE.")
endif()

file(REMOVE_RECURSE "${OUTPUT_DIRECTORY}")
file(MAKE_DIRECTORY "${OUTPUT_DIRECTORY}/licenses")
file(WRITE "${MANIFEST_FILE}"
    "# Tutorux ${PLATFORM} Static Dependency Manifest\n\n"
    "This manifest is generated from the resolved static link archives.\n\n"
    "| Archive SHA-256 | Package or formula | Version | Source | License files |\n"
    "| --- | --- | --- | --- | --- |\n"
)
set(_complete TRUE)
set(_license_number 0)
set(_seen_packages)
set(_sodium_real_archive "")
if(SODIUM_ARCHIVE AND EXISTS "${SODIUM_ARCHIVE}")
    file(REAL_PATH "${SODIUM_ARCHIVE}" _sodium_real_archive)
endif()

function(_tutorux_record_unresolved archive reason)
    set(_complete FALSE PARENT_SCOPE)
    file(APPEND "${MANIFEST_FILE}"
        "| unavailable | `${archive}` | unresolved | unavailable | ${reason} |\n"
    )
endfunction()

foreach(_unresolved_name IN LISTS UNRESOLVED_NAMES)
    _tutorux_record_unresolved("${_unresolved_name}" "static linker dependency did not resolve to a package archive")
endforeach()

foreach(_archive IN LISTS ARCHIVE_PATHS)
    if(NOT EXISTS "${_archive}" OR IS_DIRECTORY "${_archive}")
        _tutorux_record_unresolved("${_archive}" "archive file does not exist")
        continue()
    endif()

    file(REAL_PATH "${_archive}" _real_archive)
    file(SHA256 "${_real_archive}" _archive_sha256)
    set(_package "")
    set(_version "")
    set(_source "")
    set(_license_files)

    if(_real_archive STREQUAL _sodium_real_archive AND SODIUM_SOURCE_COMMIT)
        set(_package "libsodium")
        set(_version "${SODIUM_VERSION}")
        set(_source "https://github.com/jedisct1/libsodium/tree/${SODIUM_SOURCE_COMMIT}; source commit ${SODIUM_SOURCE_COMMIT}")
        if(SODIUM_LICENSE_FILE AND EXISTS "${SODIUM_LICENSE_FILE}")
            list(APPEND _license_files "${SODIUM_LICENSE_FILE}")
        endif()
    elseif(PLATFORM STREQUAL "Linux")
        set(_query_args)
        if(SYSROOT)
            set(_admin_dir "${SYSROOT}/var/lib/dpkg")
            if(NOT IS_DIRECTORY "${_admin_dir}")
                _tutorux_record_unresolved("${_real_archive}" "target sysroot has no dpkg package database")
                continue()
            endif()
            list(APPEND _query_args "--admindir=${_admin_dir}")
            file(RELATIVE_PATH _relative_archive "${SYSROOT}" "${_real_archive}")
            set(_query_archive "/${_relative_archive}")
        else()
            set(_query_archive "${_real_archive}")
        endif()

        execute_process(
            COMMAND dpkg-query ${_query_args} -S "${_query_archive}"
            RESULT_VARIABLE _owner_result
            OUTPUT_VARIABLE _owner_output
            OUTPUT_STRIP_TRAILING_WHITESPACE
            ERROR_QUIET
        )
        if(NOT _owner_result EQUAL 0)
            _tutorux_record_unresolved("${_real_archive}" "dpkg-query could not identify the owning package")
            continue()
        endif()
        string(FIND "${_owner_output}" ": " _owner_separator)
        if(_owner_separator LESS 1)
            _tutorux_record_unresolved("${_real_archive}" "dpkg-query returned an unrecognized owner record")
            continue()
        endif()
        string(SUBSTRING "${_owner_output}" 0 ${_owner_separator} _package)
        execute_process(
            COMMAND dpkg-query ${_query_args} -W
                "-f=\${binary:Package}|\${Version}|\${source:Package}|\${source:Version}"
                "${_package}"
            RESULT_VARIABLE _metadata_result
            OUTPUT_VARIABLE _metadata
            OUTPUT_STRIP_TRAILING_WHITESPACE
            ERROR_QUIET
        )
        if(NOT _metadata_result EQUAL 0)
            _tutorux_record_unresolved("${_real_archive}" "dpkg-query could not read owning package metadata")
            continue()
        endif()
        string(REPLACE "|" ";" _metadata_fields "${_metadata}")
        list(LENGTH _metadata_fields _metadata_length)
        if(_metadata_length LESS 4)
            _tutorux_record_unresolved("${_real_archive}" "dpkg-query package metadata is incomplete")
            continue()
        endif()
        list(GET _metadata_fields 1 _version)
        list(GET _metadata_fields 2 _source_package)
        list(GET _metadata_fields 3 _source_version)
        if(NOT _version OR NOT _source_package OR NOT _source_version)
            _tutorux_record_unresolved("${_real_archive}" "dpkg source package or exact version metadata is missing")
            continue()
        endif()
        set(_source
            "Debian source package ${_source_package} ${_source_version} (https://sources.debian.org/src/${_source_package}/${_source_version}/)"
        )

        execute_process(
            COMMAND dpkg-query ${_query_args} -L "${_package}"
            RESULT_VARIABLE _files_result
            OUTPUT_VARIABLE _package_files
            OUTPUT_STRIP_TRAILING_WHITESPACE
            ERROR_QUIET
        )
        string(REPLACE "\n" ";" _package_files "${_package_files}")
        foreach(_package_file IN LISTS _package_files)
            if(_package_file MATCHES "/copyright$" AND NOT IS_DIRECTORY "${SYSROOT}${_package_file}")
                if(EXISTS "${SYSROOT}${_package_file}")
                    list(APPEND _license_files "${SYSROOT}${_package_file}")
                endif()
            endif()
        endforeach()
    elseif(PLATFORM STREQUAL "macOS")
        if(NOT BREW_EXECUTABLE)
            _tutorux_record_unresolved("${_real_archive}" "Homebrew executable was not found")
            continue()
        endif()
        string(REGEX MATCH "/Cellar/([^/]+)/([^/]+)/" _cellar_match "${_real_archive}")
        if(NOT _cellar_match)
            _tutorux_record_unresolved("${_real_archive}" "archive is not owned by a versioned Homebrew Cellar formula")
            continue()
        endif()
        set(_package "${CMAKE_MATCH_1}")
        set(_formula_version "${CMAKE_MATCH_2}")
        get_filename_component(_formula_root "${_real_archive}" DIRECTORY)
        get_filename_component(_formula_root "${_formula_root}" DIRECTORY)
        execute_process(
            COMMAND "${BREW_EXECUTABLE}" info --json=v2 --formula "${_package}"
            RESULT_VARIABLE _brew_result
            OUTPUT_VARIABLE _brew_info
            OUTPUT_STRIP_TRAILING_WHITESPACE
            ERROR_QUIET
        )
        if(NOT _brew_result EQUAL 0)
            _tutorux_record_unresolved("${_real_archive}" "Homebrew formula metadata is unavailable")
            continue()
        endif()
        string(JSON _source_url ERROR_VARIABLE _json_error GET "${_brew_info}" formulae 0 urls stable url)
        if(_json_error)
            set(_source_url "")
        endif()
        string(JSON _source_hash ERROR_VARIABLE _json_error GET "${_brew_info}" formulae 0 urls stable checksum)
        if(_json_error)
            set(_source_hash "")
        endif()
        string(JSON _license_id ERROR_VARIABLE _json_error GET "${_brew_info}" formulae 0 license)
        if(_json_error)
            set(_license_id "unknown")
        endif()
        if(NOT _source_url OR NOT _source_hash OR _license_id STREQUAL "unknown")
            _tutorux_record_unresolved("${_real_archive}" "Homebrew source URL, source checksum, or license metadata is missing")
            continue()
        endif()
        set(_version "${_formula_version}")
        set(_source "${_source_url} (source SHA-256 ${_source_hash}; license ${_license_id})")
        file(GLOB_RECURSE _formula_licenses LIST_DIRECTORIES FALSE
            "${_formula_root}/LICENSE*"
            "${_formula_root}/LICENCE*"
            "${_formula_root}/COPYING*"
            "${_formula_root}/NOTICE*"
        )
        list(APPEND _license_files ${_formula_licenses})
    else()
        _tutorux_record_unresolved("${_real_archive}" "unsupported package manager platform")
        continue()
    endif()

    list(REMOVE_DUPLICATES _license_files)
    if(NOT _license_files)
        _tutorux_record_unresolved("${_real_archive}" "owning package has no installed license or notice text")
        continue()
    endif()

    string(MAKE_C_IDENTIFIER "${_package}" _safe_package)
    set(_copied_files)
    foreach(_license_file IN LISTS _license_files)
        if(EXISTS "${_license_file}" AND NOT IS_DIRECTORY "${_license_file}")
            get_filename_component(_license_basename "${_license_file}" NAME)
            math(EXPR _license_number "${_license_number} + 1")
            set(_destination
                "${OUTPUT_DIRECTORY}/licenses/${_safe_package}/${_license_number}-${_license_basename}"
            )
            file(MAKE_DIRECTORY "${OUTPUT_DIRECTORY}/licenses/${_safe_package}")
            file(COPY_FILE "${_license_file}" "${_destination}" ONLY_IF_DIFFERENT)
            file(RELATIVE_PATH _manifest_license "${OUTPUT_DIRECTORY}" "${_destination}")
            list(APPEND _copied_files "`${_manifest_license}`")
        endif()
    endforeach()
    if(NOT _copied_files)
        _tutorux_record_unresolved("${_real_archive}" "license paths were reported but their files are missing")
        continue()
    endif()

    string(JOIN ", " _license_list ${_copied_files})
    file(APPEND "${MANIFEST_FILE}"
        "| ${_archive_sha256} | ${_package} | ${_version} | ${_source} | ${_license_list} |\n"
    )
endforeach()

if(_complete)
    file(WRITE "${OUTPUT_DIRECTORY}/collection-status.txt" "COMPLETE\n")
    file(APPEND "${MANIFEST_FILE}" "\nCollection status: COMPLETE. Archive hashes, package provenance, and license file paths were collected for every supplied archive.\n")
else()
    file(WRITE "${OUTPUT_DIRECTORY}/collection-status.txt" "INCOMPLETE\n")
    file(APPEND "${MANIFEST_FILE}" "\nCollection status: INCOMPLETE. Runtime installation is blocked until every static archive has package provenance and a full license or notice text.\n")
endif()
