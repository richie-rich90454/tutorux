cmake_minimum_required(VERSION 3.25)

if(POLICY CMP0091)
    cmake_policy(SET CMP0091 NEW)
endif()

project(Tutorux VERSION 1.0.0 LANGUAGES CXX)

if(APPLE)
    enable_language(OBJCXX)
    set(CMAKE_OBJCXX_STANDARD 23)
    set(CMAKE_OBJCXX_STANDARD_REQUIRED ON)
    set(CMAKE_OBJCXX_EXTENSIONS OFF)
endif()

if(POLICY CMP0207)
    cmake_policy(SET CMP0207 NEW)
endif()

include(CTest)

option(TUTORUX_BUILD_GUI "Build the optional Slint desktop interface" OFF)
option(TUTORUX_FETCH_SLINT "Fetch the pinned Slint C++ dependency when building the GUI" OFF)
option(TUTORUX_FETCH_PODOFO "Build the pinned PoDoFo dependency from its upstream source" OFF)
option(TUTORUX_ENABLE_WHISPER "Enable local transcription with whisper.cpp" OFF)
option(TUTORUX_FETCH_WHISPER "Fetch the pinned whisper.cpp dependency" OFF)
option(TUTORUX_ENABLE_LLAMA "Enable embedded llama.cpp inference" OFF)
option(TUTORUX_FETCH_LLAMA "Fetch the pinned llama.cpp dependency" OFF)
option(TUTORUX_LLAMA_CUDA "Build embedded llama.cpp with CUDA support" OFF)
option(TUTORUX_LLAMA_VULKAN "Build embedded llama.cpp with Vulkan support" OFF)
option(TUTORUX_LLAMA_METAL "Build embedded llama.cpp with Metal support" OFF)
option(TUTORUX_ENABLE_LTO "Enable link-time optimization for release builds" ON)
option(TUTORUX_STATIC_RUNTIME "Statically link bundled third-party dependencies" OFF)
option(TUTORUX_BUILD_WASM "Build the static browser edition with Emscripten" OFF)

if(TUTORUX_FETCH_LLAMA)
    set(TUTORUX_ENABLE_LLAMA ON)
endif()
if(TUTORUX_FETCH_WHISPER)
    set(TUTORUX_ENABLE_WHISPER ON)
endif()

if(TUTORUX_BUILD_WASM AND NOT EMSCRIPTEN)
    message(FATAL_ERROR "TUTORUX_BUILD_WASM requires the Emscripten toolchain.")
endif()
if(TUTORUX_BUILD_WASM AND
   (TUTORUX_FETCH_SLINT OR TUTORUX_FETCH_PODOFO OR TUTORUX_FETCH_WHISPER OR TUTORUX_FETCH_LLAMA))
    message(FATAL_ERROR
        "The WebAssembly target uses browser-native interfaces and does not fetch native-only "
        "GUI, PDF, transcription, or model dependencies."
    )
endif()
if(TUTORUX_BUILD_WASM AND (TUTORUX_BUILD_GUI OR TUTORUX_ENABLE_WHISPER OR TUTORUX_ENABLE_LLAMA))
    message(FATAL_ERROR
        "The static browser edition uses its HTML interface and browser-provided recording; "
        "native GUI and local model runtimes are unavailable in this target."
    )
endif()
if(TUTORUX_BUILD_WASM AND TUTORUX_STATIC_RUNTIME)
    message(FATAL_ERROR
        "Emscripten already produces a statically linked WebAssembly module; "
        "TUTORUX_STATIC_RUNTIME is reserved for native platform packaging."
    )
endif()

if(TUTORUX_LLAMA_METAL AND NOT APPLE)
    message(FATAL_ERROR "TUTORUX_LLAMA_METAL can only be enabled on macOS.")
endif()
if((TUTORUX_LLAMA_CUDA OR TUTORUX_LLAMA_VULKAN OR TUTORUX_LLAMA_METAL) AND
   NOT TUTORUX_ENABLE_LLAMA)
    message(FATAL_ERROR "llama.cpp acceleration options require TUTORUX_ENABLE_LLAMA=ON.")
endif()

if(TUTORUX_STATIC_RUNTIME)
    if(NOT TUTORUX_FETCH_PODOFO)
        message(FATAL_ERROR "Static runtime builds require TUTORUX_FETCH_PODOFO=ON.")
    endif()
    if(TUTORUX_BUILD_GUI AND NOT TUTORUX_FETCH_SLINT)
        message(FATAL_ERROR "Static GUI builds require TUTORUX_FETCH_SLINT=ON.")
    endif()
    if(TUTORUX_ENABLE_WHISPER AND NOT TUTORUX_FETCH_WHISPER)
        message(FATAL_ERROR "Static Whisper builds require TUTORUX_FETCH_WHISPER=ON.")
    endif()
    if(TUTORUX_ENABLE_LLAMA AND NOT TUTORUX_FETCH_LLAMA)
        message(FATAL_ERROR "Static embedded inference requires TUTORUX_FETCH_LLAMA=ON.")
    endif()

    set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
    if(MSVC)
        set(CMAKE_MSVC_RUNTIME_LIBRARY
            "MultiThreaded$<$<CONFIG:Debug>:Debug>"
            CACHE STRING "" FORCE
        )
    else()
        set(CMAKE_FIND_LIBRARY_SUFFIXES ".a")
    endif()
endif()

set(CMAKE_CXX_STANDARD 23)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

function(tutorux_verify_source_pin dependency source_directory expected_commit)
    if(NOT EXISTS "${source_directory}/.git")
        message(FATAL_ERROR
            "${dependency} source must be a Git checkout so its pinned commit can be verified."
        )
    endif()

    find_package(Git REQUIRED)
    execute_process(
        COMMAND "${GIT_EXECUTABLE}" -C "${source_directory}" rev-parse HEAD
        OUTPUT_VARIABLE TUTORUX_ACTUAL_COMMIT
        RESULT_VARIABLE TUTORUX_GIT_RESULT
        OUTPUT_STRIP_TRAILING_WHITESPACE
    )
    string(FIND "${TUTORUX_ACTUAL_COMMIT}" "${expected_commit}" TUTORUX_PIN_POSITION)
    if(NOT TUTORUX_GIT_RESULT EQUAL 0 OR NOT TUTORUX_PIN_POSITION EQUAL 0)
        message(FATAL_ERROR
            "${dependency} source must begin with pinned commit ${expected_commit}; "
            "found '${TUTORUX_ACTUAL_COMMIT}'."
        )
    endif()
endfunction()

set(TUTORUX_CORE_SOURCES
    src/ai/http.cpp
    src/ai/content.cpp
    src/ai/cloudflare.cpp
    src/ai/embedded_llama.cpp
    src/ai/models_dev.cpp
    src/ai/native_protocol.cpp
    src/ai/openai_compatible.cpp
    src/ai/replicate.cpp
    src/audio/capture.cpp
    src/audio/multi_track.cpp
    src/audio/capture_alsa.cpp
    src/audio/capture_coreaudio.cpp
    src/audio/devices.cpp
    src/audio/recording_control.cpp
    src/audio/wav_import.cpp
    src/audio/wav_export.cpp
    src/audio/timeline.cpp
    src/audio/waveform.cpp
    src/audio/playback.cpp
    src/archive/archive.cpp
    src/archive/compression.cpp
    src/archive/crypto.cpp
    src/archive/file.cpp
    src/archive/format.cpp
    src/command/dispatcher.cpp
    src/command/json.cpp
    src/command/session_package.cpp
    src/command/zip.cpp
    src/domain/entities.cpp
    src/domain/guide.cpp
    src/domain/hash.cpp
    src/diagnostics/system.cpp
    src/intelligence/pipeline.cpp
    src/assets/import.cpp
    src/assets/mime.cpp
    src/document/docx_export.cpp
    src/document/editor.cpp
    src/document/pdf_export.cpp
    src/transcription/import.cpp
    src/transcription/whisper_backend.cpp
)

if(APPLE)
    list(APPEND TUTORUX_CORE_SOURCES
        src/audio/capture_screencapturekit.mm
        src/audio/playback_coreaudio.cpp
    )
    set_source_files_properties(src/audio/capture_screencapturekit.mm
        PROPERTIES COMPILE_OPTIONS "-fobjc-arc"
    )
endif()

if(TUTORUX_BUILD_WASM)
    list(REMOVE_ITEM TUTORUX_CORE_SOURCES
        src/ai/http.cpp
        src/audio/capture.cpp
        src/audio/multi_track.cpp
        src/audio/capture_alsa.cpp
        src/audio/capture_coreaudio.cpp
        src/audio/devices.cpp
        src/audio/recording_control.cpp
        src/document/pdf_export.cpp
    )
    list(APPEND TUTORUX_CORE_SOURCES
        src/ai/http_wasm.cpp
        src/audio/platform_wasm.cpp
        src/audio/playback_wasm.cpp
        src/document/pdf_export_wasm.cpp
    )
endif()

if(CMAKE_SYSTEM_NAME STREQUAL "Linux" AND NOT TUTORUX_BUILD_WASM)
    list(APPEND TUTORUX_CORE_SOURCES src/audio/playback_alsa.cpp)
elseif(WIN32)
    list(APPEND TUTORUX_CORE_SOURCES src/audio/playback_wasapi.cpp)
endif()

add_library(tutorux_core STATIC ${TUTORUX_CORE_SOURCES})
target_include_directories(tutorux_core PUBLIC include)
target_compile_features(tutorux_core PUBLIC cxx_std_23)

if(CMAKE_SYSTEM_NAME STREQUAL "Linux")
    find_package(PkgConfig REQUIRED)
    if(TUTORUX_STATIC_RUNTIME)
        set(PKG_CONFIG_ARGN --static)
    endif()
    pkg_check_modules(TUTORUX_ALSA REQUIRED IMPORTED_TARGET alsa)
    unset(PKG_CONFIG_ARGN)
    target_link_libraries(tutorux_core PRIVATE PkgConfig::TUTORUX_ALSA)
    target_compile_definitions(tutorux_core PRIVATE TUTORUX_HAS_ALSA=1)
endif()

if(APPLE)
    target_link_libraries(tutorux_core PRIVATE
        "-framework AudioToolbox"
        "-framework AVFAudio"
        "-framework CoreAudio"
        "-framework CoreFoundation"
        "-framework CoreMedia"
        "-framework ScreenCaptureKit"
    )
endif()

if(TUTORUX_BUILD_WASM)
    # Browser requests use the Emscripten Fetch API implementation in http_wasm.cpp.
elseif(TUTORUX_STATIC_RUNTIME AND NOT MSVC)
    find_package(PkgConfig REQUIRED)
    set(PKG_CONFIG_ARGN --static)
    pkg_check_modules(TUTORUX_STATIC_CURL REQUIRED IMPORTED_TARGET libcurl>=7.85)
    unset(PKG_CONFIG_ARGN)
    target_link_libraries(tutorux_core PRIVATE PkgConfig::TUTORUX_STATIC_CURL)
    target_compile_definitions(tutorux_core PRIVATE CURL_STATICLIB)
else()
    find_package(CURL 7.85 REQUIRED)
    target_link_libraries(tutorux_core PRIVATE CURL::libcurl)
    if(TUTORUX_STATIC_RUNTIME)
        target_compile_definitions(tutorux_core PRIVATE CURL_STATICLIB)
    endif()
endif()

set(TUTORUX_SODIUM_PREFIX "$ENV{TUTORUX_SODIUM_PREFIX}" CACHE PATH
    "Prefix containing the pinned target libsodium headers and static library"
)
set(TUTORUX_SODIUM_VERSION_PIN "1.0.22")
set(TUTORUX_PODOFO_VERSION_PIN "1.1.2")
set(TUTORUX_PODOFO_COMMIT_PIN "e91d8b727763724f3efd96c589c8033f4333c68c")
set(TUTORUX_SLINT_VERSION_PIN "1.18.1")
set(TUTORUX_SLINT_COMMIT_PIN "372cf0ee5577c3dfec309a45e7b778ba4e81b734")
set(TUTORUX_CORROSION_VERSION_PIN "0.6.1")
set(TUTORUX_CORROSION_COMMIT_PIN "1499b14e4906a2890f5cee1547c8848db261753d")
set(TUTORUX_WHISPER_VERSION_PIN "1.9.5")
set(TUTORUX_WHISPER_COMMIT_PIN "d1be6fde11ac6e0407606b4e42fe72d34add8037")
set(TUTORUX_LLAMA_VERSION_PIN "0.6.0")
set(TUTORUX_LLAMA_COMMIT_PIN "d812350")
if(MINGW)
    get_filename_component(TUTORUX_MINGW_BIN "${CMAKE_CXX_COMPILER}" DIRECTORY)
    get_filename_component(TUTORUX_SODIUM_PREFIX "${TUTORUX_MINGW_BIN}" DIRECTORY)
endif()
find_path(TUTORUX_SODIUM_INCLUDE_DIR sodium.h HINTS "${TUTORUX_SODIUM_PREFIX}/include")
set(TUTORUX_SODIUM_LINK_LIBRARY "")
if(MINGW)
    find_file(TUTORUX_SODIUM_STATIC_LIBRARY NAMES libsodium.a
        HINTS "${TUTORUX_SODIUM_PREFIX}/lib" NO_DEFAULT_PATH
    )
    if(TUTORUX_SODIUM_STATIC_LIBRARY)
        set(TUTORUX_SODIUM_LINK_LIBRARY "${TUTORUX_SODIUM_STATIC_LIBRARY}")
    endif()
endif()
if(NOT TUTORUX_SODIUM_LINK_LIBRARY)
    find_library(TUTORUX_SODIUM_LIBRARY NAMES sodium libsodium HINTS "${TUTORUX_SODIUM_PREFIX}/lib")
    set(TUTORUX_SODIUM_LINK_LIBRARY "${TUTORUX_SODIUM_LIBRARY}")
endif()
if(NOT TUTORUX_SODIUM_INCLUDE_DIR OR NOT TUTORUX_SODIUM_LINK_LIBRARY)
    message(FATAL_ERROR "libsodium ${TUTORUX_SODIUM_VERSION_PIN} is required for archive encryption.")
endif()
if(EMSCRIPTEN AND NOT TUTORUX_SODIUM_LINK_LIBRARY MATCHES "\\.a$")
    message(FATAL_ERROR
        "The WebAssembly edition requires a static Emscripten build of libsodium; "
        "set TUTORUX_SODIUM_PREFIX to that target library's install prefix."
    )
endif()
file(STRINGS "${TUTORUX_SODIUM_INCLUDE_DIR}/sodium/version.h"
    TUTORUX_SODIUM_VERSION_LINE REGEX "^#define SODIUM_VERSION_STRING ")
string(REGEX MATCH "[0-9]+\\.[0-9]+\\.[0-9]+" TUTORUX_SODIUM_VERSION
    "${TUTORUX_SODIUM_VERSION_LINE}")
if(NOT TUTORUX_SODIUM_VERSION STREQUAL TUTORUX_SODIUM_VERSION_PIN)
    message(FATAL_ERROR
        "libsodium ${TUTORUX_SODIUM_VERSION_PIN} is required; found '${TUTORUX_SODIUM_VERSION}'."
    )
endif()
target_include_directories(tutorux_core PRIVATE "${TUTORUX_SODIUM_INCLUDE_DIR}")
target_link_libraries(tutorux_core PRIVATE "${TUTORUX_SODIUM_LINK_LIBRARY}")

if(TUTORUX_BUILD_WASM)
    # The browser target uses the self-contained portable PDF writer.
elseif(TUTORUX_FETCH_PODOFO)
    include(FetchContent)
    set(PODOFO_BUILD_LIB_ONLY ON CACHE BOOL "" FORCE)
    if(TUTORUX_STATIC_RUNTIME)
        set(PODOFO_BUILD_STATIC ON CACHE BOOL "" FORCE)
    endif()
    set(PODOFO_WITH_AFDKO OFF CACHE BOOL "" FORCE)
    set(PODOFO_WITH_FONTMANAGER ON CACHE BOOL "" FORCE)
    set(CMAKE_DISABLE_FIND_PACKAGE_TIFF ON)
    if(WIN32)
        set(PODOFO_WITH_WIN32GDI_FONT_SEARCH ON CACHE BOOL "" FORCE)
        set(CMAKE_DISABLE_FIND_PACKAGE_Fontconfig ON)
    endif()
    FetchContent_Declare(
        PoDoFo
        GIT_REPOSITORY https://github.com/podofo/podofo.git
        GIT_TAG ${TUTORUX_PODOFO_VERSION_PIN}
        GIT_SHALLOW TRUE
        GIT_SUBMODULES ""
        GIT_SUBMODULES_RECURSE FALSE
    )
    FetchContent_MakeAvailable(PoDoFo)
    FetchContent_GetProperties(PoDoFo SOURCE_DIR TUTORUX_PODOFO_SOURCE_DIR)
    tutorux_verify_source_pin(
        PoDoFo "${TUTORUX_PODOFO_SOURCE_DIR}" "${TUTORUX_PODOFO_COMMIT_PIN}"
    )
    if(NOT TARGET podofo::podofo)
        message(FATAL_ERROR "The pinned PoDoFo source did not define podofo::podofo.")
    endif()
    if(TUTORUX_STATIC_RUNTIME)
        target_compile_definitions(podofo_static PUBLIC LIBXML_STATIC)
        target_compile_definitions(podofo_private PUBLIC LIBXML_STATIC)
    endif()
    set(TUTORUX_PODOFO_INCLUDE_DIRS
        "${TUTORUX_PODOFO_SOURCE_DIR}/src"
        "${podofo_BINARY_DIR}/src/podofo/podofo/auxiliary"
        "${podofo_BINARY_DIR}/src/podofo/podofo/private"
    )
elseif(MINGW)
    find_package(podofo ${TUTORUX_PODOFO_VERSION_PIN} EXACT CONFIG REQUIRED
        PATHS "${TUTORUX_SODIUM_PREFIX}/lib/cmake/podofo"
    )
else()
    find_package(podofo ${TUTORUX_PODOFO_VERSION_PIN} EXACT CONFIG REQUIRED)
endif()
if(NOT TUTORUX_BUILD_WASM)
    target_link_libraries(tutorux_core PRIVATE podofo::podofo)
    if(TUTORUX_FETCH_PODOFO)
        target_include_directories(tutorux_core PRIVATE ${TUTORUX_PODOFO_INCLUDE_DIRS})
    endif()
endif()
if(TUTORUX_STATIC_RUNTIME AND NOT MSVC AND NOT TUTORUX_BUILD_WASM)
    find_package(PkgConfig REQUIRED)
    set(PKG_CONFIG_ARGN --static)
    pkg_check_modules(TUTORUX_STATIC_FREETYPE REQUIRED IMPORTED_TARGET freetype2)
    pkg_check_modules(TUTORUX_STATIC_LIBXML2 REQUIRED IMPORTED_TARGET libxml-2.0)
    unset(PKG_CONFIG_ARGN)

    set(TUTORUX_STATIC_ARCHIVE_GROUP_LIBRARIES
        podofo_static
        podofo_private
        podofo_3rdparty
        ${TUTORUX_STATIC_FREETYPE_STATIC_LIBRARIES}
        ${TUTORUX_STATIC_LIBXML2_STATIC_LIBRARIES}
        ssl
        crypto
        jpeg
        png
        z
    )
    string(JOIN "," TUTORUX_STATIC_ARCHIVE_GROUP ${TUTORUX_STATIC_ARCHIVE_GROUP_LIBRARIES})
    target_link_libraries(tutorux_core PRIVATE
        "$<LINK_GROUP:RESCAN,${TUTORUX_STATIC_ARCHIVE_GROUP}>"
    )
    target_compile_definitions(tutorux_core PUBLIC LIBXML_STATIC)
    target_link_libraries(tutorux_core PRIVATE
        PkgConfig::TUTORUX_STATIC_FREETYPE
        PkgConfig::TUTORUX_STATIC_LIBXML2
    )
endif()

if(WIN32)
    target_link_libraries(tutorux_core PUBLIC ole32 propsys uuid advapi32 Psapi)
endif()

if(MSVC)
    target_compile_options(tutorux_core PRIVATE /W4 /permissive- /Zc:__cplusplus /EHsc)
    target_compile_definitions(tutorux_core PUBLIC NOMINMAX WIN32_LEAN_AND_MEAN)
else()
    target_compile_options(tutorux_core PRIVATE -Wall -Wextra -Wpedantic -Wconversion -Wsign-conversion)
endif()

if(TUTORUX_FETCH_LLAMA)
    install(FILES "${TUTORUX_LLAMA_SOURCE_DIR}/LICENSE"
        DESTINATION licenses/llama.cpp COMPONENT Runtime
    )
endif()

target_compile_definitions(tutorux_core PRIVATE
    TUTORUX_BUILD_GUI=$<BOOL:${TUTORUX_BUILD_GUI}>
    TUTORUX_ENABLE_WHISPER=$<BOOL:${TUTORUX_ENABLE_WHISPER}>
)

if(TUTORUX_ENABLE_WHISPER)
    if(TUTORUX_FETCH_WHISPER)
        include(FetchContent)
        set(WHISPER_BUILD_TESTS OFF CACHE BOOL "" FORCE)
        set(WHISPER_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
        set(WHISPER_BUILD_SERVER OFF CACHE BOOL "" FORCE)
        set(WHISPER_COMMON_FFMPEG OFF CACHE BOOL "" FORCE)
        set(WHISPER_FFMPEG OFF CACHE BOOL "" FORCE)
        set(GGML_NATIVE OFF CACHE BOOL "" FORCE)
        FetchContent_Declare(
            whisper_cpp
            GIT_REPOSITORY https://github.com/ggml-org/whisper.cpp.git
            GIT_TAG v${TUTORUX_WHISPER_VERSION_PIN}
            GIT_SHALLOW TRUE
        )
        FetchContent_MakeAvailable(whisper_cpp)
        FetchContent_GetProperties(whisper_cpp SOURCE_DIR TUTORUX_WHISPER_SOURCE_DIR)
        tutorux_verify_source_pin(
            whisper.cpp "${TUTORUX_WHISPER_SOURCE_DIR}" "${TUTORUX_WHISPER_COMMIT_PIN}"
        )
    else()
        find_package(whisper CONFIG REQUIRED)
    endif()
    if(NOT TARGET whisper)
        message(FATAL_ERROR "The whisper.cpp package must provide the 'whisper' CMake target.")
    endif()
    target_link_libraries(tutorux_core PRIVATE whisper)
    target_compile_definitions(tutorux_core PRIVATE TUTORUX_WITH_WHISPER=1)
endif()

if(TUTORUX_ENABLE_LLAMA)
    if(TUTORUX_FETCH_LLAMA)
        include(FetchContent)
        set(LLAMA_BUILD_TESTS OFF CACHE BOOL "" FORCE)
        set(LLAMA_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
        set(LLAMA_BUILD_SERVER OFF CACHE BOOL "" FORCE)
        set(LLAMA_CURL OFF CACHE BOOL "" FORCE)
        set(LLAMA_BUILD_COMMON OFF CACHE BOOL "" FORCE)
        set(GGML_NATIVE OFF CACHE BOOL "" FORCE)
        set(GGML_CUDA ${TUTORUX_LLAMA_CUDA} CACHE BOOL "" FORCE)
        set(GGML_VULKAN ${TUTORUX_LLAMA_VULKAN} CACHE BOOL "" FORCE)
        set(GGML_METAL ${TUTORUX_LLAMA_METAL} CACHE BOOL "" FORCE)
        set(GGML_BUILD_TESTS OFF CACHE BOOL "" FORCE)
        set(GGML_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
        FetchContent_Declare(
            llama_cpp
            GIT_REPOSITORY https://github.com/ggml-org/llama.cpp.git
            GIT_TAG v${TUTORUX_LLAMA_VERSION_PIN}
            GIT_SHALLOW TRUE
        )
        FetchContent_MakeAvailable(llama_cpp)
        FetchContent_GetProperties(llama_cpp SOURCE_DIR TUTORUX_LLAMA_SOURCE_DIR)
        tutorux_verify_source_pin(
            llama.cpp "${TUTORUX_LLAMA_SOURCE_DIR}" "${TUTORUX_LLAMA_COMMIT_PIN}"
        )
    else()
        find_package(llama CONFIG REQUIRED)
    endif()
    if(NOT TARGET llama)
        message(FATAL_ERROR "The pinned llama.cpp source must define the 'llama' target.")
    endif()
    target_link_libraries(tutorux_core PRIVATE llama)
    target_compile_definitions(tutorux_core PRIVATE TUTORUX_WITH_LLAMA=1)
    if(TUTORUX_LLAMA_CUDA OR TUTORUX_LLAMA_VULKAN OR TUTORUX_LLAMA_METAL)
        target_compile_definitions(tutorux_core PRIVATE TUTORUX_LLAMA_GPU_AVAILABLE=1)
    endif()
endif()

if(NOT TUTORUX_BUILD_WASM)
    add_executable(tutorux src/main.cpp)
    target_link_libraries(tutorux PRIVATE tutorux_core)
    if(MINGW AND TUTORUX_STATIC_RUNTIME)
        target_link_options(tutorux_core INTERFACE -static -static-libgcc -static-libstdc++)
    elseif(MINGW)
        target_link_options(tutorux PRIVATE -static-libgcc -static-libstdc++)
    elseif(UNIX AND NOT APPLE AND TUTORUX_STATIC_RUNTIME)
        target_link_options(tutorux_core INTERFACE -static -static-libgcc -static-libstdc++)
    endif()
endif()

if(TUTORUX_ENABLE_LTO AND CMAKE_BUILD_TYPE STREQUAL "Release" AND NOT MINGW)
    include(CheckIPOSupported)
    check_ipo_supported(RESULT TUTORUX_LTO_SUPPORTED OUTPUT TUTORUX_LTO_ERROR)
    if(TUTORUX_LTO_SUPPORTED)
        set_property(TARGET tutorux_core PROPERTY INTERPROCEDURAL_OPTIMIZATION TRUE)
        if(TARGET tutorux)
            set_property(TARGET tutorux PROPERTY INTERPROCEDURAL_OPTIMIZATION TRUE)
        endif()
    endif()
elseif(TUTORUX_ENABLE_LTO AND CMAKE_BUILD_TYPE STREQUAL "Release" AND MINGW)
    message(STATUS "Skipping IPO/LTO for MinGW; GCC LTO cannot reliably merge the COFF archive.")
endif()

if(TUTORUX_BUILD_GUI)
    if(TUTORUX_FETCH_SLINT)
        include(FetchContent)
        set(CORROSION_BUILD_TESTS OFF CACHE BOOL "" FORCE)
        FetchContent_Declare(
            Corrosion
            GIT_REPOSITORY https://github.com/corrosion-rs/corrosion.git
            GIT_TAG v${TUTORUX_CORROSION_VERSION_PIN}
            GIT_SHALLOW TRUE
        )
        FetchContent_MakeAvailable(Corrosion)
        FetchContent_GetProperties(Corrosion SOURCE_DIR TUTORUX_CORROSION_SOURCE_DIR)
        tutorux_verify_source_pin(
            Corrosion "${TUTORUX_CORROSION_SOURCE_DIR}" "${TUTORUX_CORROSION_COMMIT_PIN}"
        )
        FetchContent_Declare(
            Slint
            GIT_REPOSITORY https://github.com/slint-ui/slint.git
            GIT_TAG v${TUTORUX_SLINT_VERSION_PIN}
            GIT_SHALLOW TRUE
            SOURCE_SUBDIR api/cpp
        )
        FetchContent_MakeAvailable(Slint)
        FetchContent_GetProperties(Slint SOURCE_DIR TUTORUX_SLINT_SOURCE_DIR)
        tutorux_verify_source_pin(
            Slint "${TUTORUX_SLINT_SOURCE_DIR}" "${TUTORUX_SLINT_COMMIT_PIN}"
        )
        if(TUTORUX_STATIC_RUNTIME AND WIN32)
            execute_process(
                COMMAND "${CMAKE_COMMAND}"
                        -DSLINT_CONFIG_HEADER=${TUTORUX_SLINT_SOURCE_DIR}/api/cpp/include/private/slint_config.h
                        -P "${CMAKE_CURRENT_SOURCE_DIR}/cmake/PatchStaticSlint.cmake"
                COMMAND_ERROR_IS_FATAL ANY
            )
            target_link_libraries(Slint INTERFACE imm32 uxtheme)
        endif()
    else()
        find_package(Slint 1.18 CONFIG REQUIRED)
    endif()

    target_sources(tutorux PRIVATE src/gui/desktop.cpp)
    target_compile_definitions(tutorux PRIVATE TUTORUX_WITH_GUI=1)
    if(TUTORUX_STATIC_RUNTIME AND WIN32)
        target_compile_definitions(tutorux PRIVATE TUTORUX_STATIC_SLINT=1)
    endif()
    slint_target_sources(tutorux ui/app-window.slint)
    target_link_libraries(tutorux PRIVATE Slint::Slint)
endif()

if(TUTORUX_BUILD_WASM)
    find_program(TUTORUX_TSC_EXECUTABLE NAMES tsc REQUIRED)
    add_executable(tutorux_web src/wasm/web_api.cpp)
    target_link_libraries(tutorux_web PRIVATE tutorux_core)
    target_compile_features(tutorux_web PRIVATE cxx_std_23)
    set_target_properties(tutorux_web PROPERTIES
        OUTPUT_NAME "tutorux-core"
        RUNTIME_OUTPUT_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/web"
    )
    target_link_options(tutorux_web PRIVATE
        "-sMODULARIZE=1"
        "-sEXPORT_NAME=createTutoruxModule"
        "-sALLOW_MEMORY_GROWTH=1"
        "-sFETCH=1"
        "-sASYNCIFY=1"
        "-sEXIT_RUNTIME=0"
        "-sENVIRONMENT=web,worker"
        "-sEXPORTED_RUNTIME_METHODS=ccall,FS"
        "-sEXPORTED_FUNCTIONS=_main,_tutorux_web_dispatch_json"
    )
    add_custom_command(TARGET tutorux_web PRE_LINK
        COMMAND ${CMAKE_COMMAND} -E copy_directory
                "${CMAKE_CURRENT_SOURCE_DIR}/web"
                "$<TARGET_FILE_DIR:tutorux_web>"
        COMMAND "${TUTORUX_TSC_EXECUTABLE}"
                --target ES2022
                --module none
                --lib ES2022,DOM
                --skipLibCheck
                --outFile "$<TARGET_FILE_DIR:tutorux_web>/tutorux.js"
                "${CMAKE_CURRENT_SOURCE_DIR}/web/tutorux.ts"
        VERBATIM
    )
    install(TARGETS tutorux_web RUNTIME DESTINATION web COMPONENT WebRuntime)
    install(DIRECTORY web/ DESTINATION web COMPONENT WebRuntime
        PATTERN "tutorux.js" EXCLUDE
    )
    install(FILES "${CMAKE_CURRENT_BINARY_DIR}/web/tutorux.js"
        DESTINATION web COMPONENT WebRuntime
    )
    install(FILES "${CMAKE_CURRENT_BINARY_DIR}/web/tutorux-core.wasm"
        DESTINATION web COMPONENT WebRuntime
    )
endif()

if(TUTORUX_BUILD_GUI AND TUTORUX_FETCH_SLINT)
    install(FILES "${TUTORUX_SLINT_SOURCE_DIR}/LICENSE.md"
        DESTINATION licenses/Slint COMPONENT Runtime
    )
    install(DIRECTORY "${TUTORUX_SLINT_SOURCE_DIR}/LICENSES/"
        DESTINATION licenses/Slint COMPONENT Runtime
    )
    if(BUILD_SHARED_LIBS)
        if(WIN32)
            set(TUTORUX_SLINT_LIBRARY_NAME "slint_cpp${CMAKE_SHARED_LIBRARY_SUFFIX}")
        else()
            set(TUTORUX_SLINT_LIBRARY_NAME
                "${CMAKE_SHARED_LIBRARY_PREFIX}slint_cpp${CMAKE_SHARED_LIBRARY_SUFFIX}"
            )
        endif()
        set(TUTORUX_SLINT_RUNTIME
            "${CMAKE_CURRENT_BINARY_DIR}/_deps/slint-build/${TUTORUX_SLINT_LIBRARY_NAME}"
        )
        add_custom_command(
            TARGET tutorux
            POST_BUILD
            COMMAND ${CMAKE_COMMAND} -E copy_if_different
                    "${TUTORUX_SLINT_RUNTIME}"
                    "$<TARGET_FILE_DIR:tutorux>"
            VERBATIM
        )
        install(FILES "${TUTORUX_SLINT_RUNTIME}" DESTINATION . COMPONENT Runtime)
    endif()
endif()

if(TUTORUX_STATIC_RUNTIME)
    add_custom_command(
        TARGET tutorux
        POST_BUILD
        COMMAND ${CMAKE_COMMAND}
                -DTUTORUX_RUNTIME_EXECUTABLE=$<TARGET_FILE:tutorux>
                -P "${CMAKE_CURRENT_SOURCE_DIR}/cmake/VerifyStaticRuntime.cmake"
        VERBATIM
    )
elseif(WIN32 AND MINGW)
    set(TUTORUX_PODOFO_RUNTIME_DIRECTORY "")
    if(TUTORUX_FETCH_PODOFO AND TARGET podofo_shared)
        set(TUTORUX_PODOFO_RUNTIME_DIRECTORY "$<TARGET_FILE_DIR:podofo_shared>")
    endif()
    add_custom_command(
        TARGET tutorux
        POST_BUILD
        COMMAND ${CMAKE_COMMAND}
                -DTUTORUX_RUNTIME_EXECUTABLE=$<TARGET_FILE:tutorux>
                -DTUTORUX_RUNTIME_DESTINATION=$<TARGET_FILE_DIR:tutorux>
                -DTUTORUX_RUNTIME_SEARCH_DIRECTORY=${TUTORUX_MINGW_BIN}
                -DTUTORUX_RUNTIME_PODOFO_DIRECTORY=${TUTORUX_PODOFO_RUNTIME_DIRECTORY}
                -P "${CMAKE_CURRENT_SOURCE_DIR}/cmake/CopyRuntimeDependencies.cmake"
        VERBATIM
    )
endif()

if(TARGET tutorux AND APPLE)
    set_target_properties(tutorux PROPERTIES BUILD_RPATH "@loader_path" INSTALL_RPATH "@loader_path")
elseif(TARGET tutorux AND UNIX)
    set_target_properties(tutorux PROPERTIES BUILD_RPATH "$ORIGIN" INSTALL_RPATH "$ORIGIN")
endif()

if(TUTORUX_FETCH_PODOFO)
    install(FILES
        "${TUTORUX_PODOFO_SOURCE_DIR}/COPYING.LGPL"
        "${TUTORUX_PODOFO_SOURCE_DIR}/COPYING.MPL"
        "${TUTORUX_PODOFO_SOURCE_DIR}/NOTICE"
        DESTINATION licenses/PoDoFo
        COMPONENT Runtime
    )
endif()
if(TUTORUX_FETCH_WHISPER)
    install(FILES "${TUTORUX_WHISPER_SOURCE_DIR}/LICENSE"
        DESTINATION licenses/whisper.cpp COMPONENT Runtime
    )
endif()

if(TARGET tutorux AND WIN32 AND MINGW)
    install(FILES docs/dependencies/WINDOWS-X64-SBOM.md DESTINATION . COMPONENT Runtime)
    set(TUTORUX_MINGW_LICENSES
        brotli
        bzip2
        curl
        freetype
        gcc-libs
        gettext-runtime
        glib2
        graphite2
        harfbuzz
        libiconv
        libjpeg-turbo
        libpng
        libpsl
        libssh2
        libunistring
        libwinpthread
        libxml2
        nghttp2
        nghttp3
        ngtcp2
        libsodium
        openssl
        pcre2
        zstd
        zlib
    )
    foreach(TUTORUX_LICENSE_NAME IN LISTS TUTORUX_MINGW_LICENSES)
        set(TUTORUX_LICENSE_SOURCE
            "${TUTORUX_SODIUM_PREFIX}/share/licenses/${TUTORUX_LICENSE_NAME}"
        )
        if(EXISTS "${TUTORUX_LICENSE_SOURCE}")
            install(DIRECTORY "${TUTORUX_LICENSE_SOURCE}/"
                DESTINATION "licenses/${TUTORUX_LICENSE_NAME}" COMPONENT Runtime
            )
        else()
            message(WARNING "No license directory found for ${TUTORUX_LICENSE_NAME}.")
        endif()
    endforeach()
    if("idn2" IN_LIST TUTORUX_STATIC_CURL_STATIC_LIBRARIES)
        set(TUTORUX_LIBIDN2_LICENSE
            "${TUTORUX_SODIUM_PREFIX}/share/licenses/xz/COPYING.GPLv2"
        )
        if(NOT EXISTS "${TUTORUX_LIBIDN2_LICENSE}")
            message(FATAL_ERROR
                "The static libcurl dependency closure uses libidn2, but its GPL-2.0-or-later "
                "license text is unavailable."
            )
        endif()
        install(FILES "${TUTORUX_LIBIDN2_LICENSE}"
            DESTINATION licenses/libidn2 COMPONENT Runtime
        )
    endif()
    install(TARGETS tutorux RUNTIME_DEPENDENCY_SET tutorux_runtime RUNTIME DESTINATION .
        COMPONENT Runtime
    )
    set(TUTORUX_INSTALL_RUNTIME_DIRECTORIES)
    if(TUTORUX_FETCH_PODOFO AND TARGET podofo_shared)
        list(APPEND TUTORUX_INSTALL_RUNTIME_DIRECTORIES "$<TARGET_FILE_DIR:podofo_shared>")
    endif()
    list(APPEND TUTORUX_INSTALL_RUNTIME_DIRECTORIES "${TUTORUX_MINGW_BIN}")
    install(RUNTIME_DEPENDENCY_SET tutorux_runtime
        DIRECTORIES ${TUTORUX_INSTALL_RUNTIME_DIRECTORIES}
        PRE_EXCLUDE_REGEXES
            "^api-ms-"
            "^ext-ms-"
            "^(AzureAttestManager|AzureAttestNormal|HvsiFileTrust|PdmUtilities|wpaxholder)\\.dll$"
        POST_EXCLUDE_REGEXES
            ".*[Ww][Ii][Nn][Dd][Oo][Ww][Ss]/([Ss][Yy][Ss][Tt][Ee][Mm]32|[Ss][Yy][Ss][Ww][Oo]64)/.*"
        RUNTIME DESTINATION .
        COMPONENT Runtime
    )
elseif(TARGET tutorux)
    install(TARGETS tutorux RUNTIME DESTINATION . COMPONENT Runtime)
endif()

if(BUILD_TESTING AND NOT TUTORUX_BUILD_WASM)
    add_executable(tutorux_json_test tests/json_test.cpp)
    target_link_libraries(tutorux_json_test PRIVATE tutorux_core)
    add_test(NAME json_strict_parsing COMMAND tutorux_json_test)

    add_executable(tutorux_ai_import_test tests/ai_import_test.cpp)
    target_link_libraries(tutorux_ai_import_test PRIVATE tutorux_core)
    add_test(NAME structured_ai_response_import COMMAND tutorux_ai_import_test)

    add_executable(tutorux_asset_import_test tests/asset_import_test.cpp)
    target_link_libraries(tutorux_asset_import_test PRIVATE tutorux_core)
    add_test(NAME streaming_asset_import_and_content_deduplication COMMAND tutorux_asset_import_test)

    add_executable(tutorux_http_transport_test tests/http_transport_test.cpp)
    target_link_libraries(tutorux_http_transport_test PRIVATE tutorux_core)
    add_test(NAME bounded_https_transport COMMAND tutorux_http_transport_test)

    add_executable(tutorux_archive_reopen_test tests/archive_reopen_test.cpp)
    target_link_libraries(tutorux_archive_reopen_test PRIVATE tutorux_core)
    add_test(NAME archive_integrity_discovery_and_compaction COMMAND tutorux_archive_reopen_test)

    add_executable(tutorux_session_transfer_test tests/session_transfer_test.cpp)
    target_link_libraries(tutorux_session_transfer_test PRIVATE tutorux_core)
    add_test(NAME wav_session_transfer COMMAND tutorux_session_transfer_test)

    add_executable(tutorux_audio_timeline_test tests/audio_timeline_test.cpp)
    target_link_libraries(tutorux_audio_timeline_test PRIVATE tutorux_core)
    add_test(NAME audio_timeline_waveform_and_wav_export COMMAND tutorux_audio_timeline_test)

    add_executable(tutorux_archive_encryption_test tests/archive_encryption_test.cpp)
    target_link_libraries(tutorux_archive_encryption_test PRIVATE tutorux_core)
    add_test(NAME archive_encryption_and_passphrase_rotation COMMAND tutorux_archive_encryption_test)

    add_executable(tutorux_credential_storage_test tests/credential_storage_test.cpp)
    target_link_libraries(tutorux_credential_storage_test PRIVATE tutorux_core)
    add_test(NAME encrypted_credential_storage_policy COMMAND tutorux_credential_storage_test)

    add_executable(tutorux_pdf_export_test tests/pdf_export_test.cpp)
    target_link_libraries(tutorux_pdf_export_test PRIVATE tutorux_core podofo::podofo)
    if(TUTORUX_FETCH_PODOFO)
        target_include_directories(tutorux_pdf_export_test PRIVATE ${TUTORUX_PODOFO_INCLUDE_DIRS})
    endif()
    add_test(NAME guide_pdf_export_and_unicode_pagination COMMAND tutorux_pdf_export_test)
endif()
