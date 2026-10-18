cmake_minimum_required(VERSION 3.25)

if(NOT CMAKE_HOST_SYSTEM_NAME STREQUAL "Darwin")
    message(FATAL_ERROR "PackageMacOSApp.cmake must run on macOS.")
endif()

foreach(TUTORUX_REQUIRED_VARIABLE IN ITEMS TUTORUX_RUNTIME_DIR TUTORUX_APP_BUNDLE_DIR)
    if(NOT DEFINED ${TUTORUX_REQUIRED_VARIABLE} OR "${${TUTORUX_REQUIRED_VARIABLE}}" STREQUAL "")
        message(FATAL_ERROR "Set ${TUTORUX_REQUIRED_VARIABLE} to package the macOS app.")
    endif()
endforeach()

if(NOT DEFINED TUTORUX_APP_VERSION OR TUTORUX_APP_VERSION STREQUAL "")
    set(TUTORUX_APP_VERSION "1.0.0")
endif()
if(NOT TUTORUX_APP_VERSION MATCHES "^[0-9]+(\\.[0-9]+){1,2}$")
    message(FATAL_ERROR "TUTORUX_APP_VERSION must be a dotted numeric version.")
endif()

if(NOT DEFINED TUTORUX_BUNDLE_IDENTIFIER OR TUTORUX_BUNDLE_IDENTIFIER STREQUAL "")
    set(TUTORUX_BUNDLE_IDENTIFIER "org.tutorux.Tutorux")
endif()

if(DEFINED TUTORUX_MIN_MACOS_VERSION AND NOT TUTORUX_MIN_MACOS_VERSION STREQUAL "")
    if(NOT TUTORUX_MIN_MACOS_VERSION MATCHES "^[0-9]+(\\.[0-9]+){1,2}$")
        message(FATAL_ERROR "TUTORUX_MIN_MACOS_VERSION must be a dotted numeric version.")
    endif()
    set(TUTORUX_MIN_MACOS_PLIST_ENTRY
        "<key>LSMinimumSystemVersion</key>\n    <string>${TUTORUX_MIN_MACOS_VERSION}</string>")
else()
    set(TUTORUX_MIN_MACOS_PLIST_ENTRY "")
endif()

cmake_path(ABSOLUTE_PATH TUTORUX_RUNTIME_DIR NORMALIZE OUTPUT_VARIABLE TUTORUX_RUNTIME_DIR)
cmake_path(ABSOLUTE_PATH TUTORUX_APP_BUNDLE_DIR NORMALIZE OUTPUT_VARIABLE TUTORUX_APP_BUNDLE_DIR)
set(TUTORUX_APP_EXECUTABLE "${TUTORUX_RUNTIME_DIR}/tutorux")
set(TUTORUX_APP_LICENSES "${TUTORUX_RUNTIME_DIR}/licenses")
if(NOT EXISTS "${TUTORUX_APP_EXECUTABLE}")
    message(FATAL_ERROR "Runtime executable not found: ${TUTORUX_APP_EXECUTABLE}")
endif()
if(NOT IS_DIRECTORY "${TUTORUX_APP_LICENSES}")
    message(FATAL_ERROR "Runtime license directory not found: ${TUTORUX_APP_LICENSES}")
endif()
if(EXISTS "${TUTORUX_APP_BUNDLE_DIR}")
    message(FATAL_ERROR "App bundle output already exists: ${TUTORUX_APP_BUNDLE_DIR}")
endif()

get_filename_component(TUTORUX_APP_PARENT "${TUTORUX_APP_BUNDLE_DIR}" DIRECTORY)
file(MAKE_DIRECTORY "${TUTORUX_APP_PARENT}")
set(TUTORUX_APP_CONTENTS "${TUTORUX_APP_BUNDLE_DIR}/Contents")
file(MAKE_DIRECTORY "${TUTORUX_APP_CONTENTS}/MacOS" "${TUTORUX_APP_CONTENTS}/Resources")
file(COPY_FILE "${TUTORUX_APP_EXECUTABLE}" "${TUTORUX_APP_CONTENTS}/MacOS/tutorux")
file(CHMOD "${TUTORUX_APP_CONTENTS}/MacOS/tutorux"
    PERMISSIONS OWNER_READ OWNER_WRITE OWNER_EXECUTE GROUP_READ GROUP_EXECUTE WORLD_READ WORLD_EXECUTE)
file(COPY "${TUTORUX_APP_LICENSES}" DESTINATION "${TUTORUX_APP_CONTENTS}/Resources")

configure_file(
    "${CMAKE_CURRENT_LIST_DIR}/Info.plist.in"
    "${TUTORUX_APP_CONTENTS}/Info.plist"
    @ONLY
)

if(DEFINED TUTORUX_CODESIGN_IDENTITY AND NOT TUTORUX_CODESIGN_IDENTITY STREQUAL "")
    if(TUTORUX_CODESIGN_IDENTITY STREQUAL "-")
        message(FATAL_ERROR "Ad-hoc signatures are not accepted as release signing.")
    endif()
    find_program(TUTORUX_CODESIGN_EXECUTABLE codesign REQUIRED)
    execute_process(
        COMMAND "${TUTORUX_CODESIGN_EXECUTABLE}" --force --options runtime --timestamp
                --sign "${TUTORUX_CODESIGN_IDENTITY}" "${TUTORUX_APP_BUNDLE_DIR}"
        RESULT_VARIABLE TUTORUX_CODESIGN_RESULT
        COMMAND_ECHO STDOUT
    )
    if(NOT TUTORUX_CODESIGN_RESULT EQUAL 0)
        message(FATAL_ERROR "codesign failed for the macOS app bundle.")
    endif()
    execute_process(
        COMMAND "${TUTORUX_CODESIGN_EXECUTABLE}" --verify --strict --verbose=2
                "${TUTORUX_APP_BUNDLE_DIR}"
        RESULT_VARIABLE TUTORUX_CODESIGN_VERIFY_RESULT
        COMMAND_ECHO STDOUT
    )
    if(NOT TUTORUX_CODESIGN_VERIFY_RESULT EQUAL 0)
        message(FATAL_ERROR "codesign verification failed for the macOS app bundle.")
    endif()
    message(STATUS "Created and verified a signed macOS app bundle.")
else()
    message(STATUS "Created an unsigned macOS app bundle; no signing identity was supplied.")
endif()
