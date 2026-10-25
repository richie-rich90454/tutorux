cmake_minimum_required(VERSION 3.25)

if(POLICY CMP0091)
    cmake_policy(SET CMP0091 NEW)
endif()

if(CMAKE_HOST_SYSTEM_NAME STREQUAL "Darwin" AND NOT CMAKE_OSX_DEPLOYMENT_TARGET)
    set(CMAKE_OSX_DEPLOYMENT_TARGET "13.0" CACHE STRING
        "Minimum macOS release target for Tutorux portable builds"
    )
endif()

project(Tutorux VERSION 1.0.0 LANGUAGES CXX)

set(TUTORUX_RELEASE_ARCH "" CACHE STRING
    "Architecture requested by a release preset: x64 or arm64"
)
set_property(CACHE TUTORUX_RELEASE_ARCH PROPERTY STRINGS "" x64 arm64)
if(TUTORUX_RELEASE_ARCH)
    string(TOLOWER "${CMAKE_SYSTEM_PROCESSOR}" TUTORUX_SYSTEM_PROCESSOR_LOWER)
    if(APPLE AND CMAKE_OSX_ARCHITECTURES)
        string(TOLOWER "${CMAKE_OSX_ARCHITECTURES}" TUTORUX_SYSTEM_PROCESSOR_LOWER)
    endif()
    if(TUTORUX_RELEASE_ARCH STREQUAL "x64" AND
       NOT TUTORUX_SYSTEM_PROCESSOR_LOWER MATCHES "^(x86_64|amd64|x64)$")
        message(FATAL_ERROR
            "The x64 release preset requires an x86_64 target; found '${CMAKE_SYSTEM_PROCESSOR}' "
            "with CMAKE_OSX_ARCHITECTURES='${CMAKE_OSX_ARCHITECTURES}'."
        )
    elseif(TUTORUX_RELEASE_ARCH STREQUAL "arm64" AND
           NOT TUTORUX_SYSTEM_PROCESSOR_LOWER MATCHES "^(aarch64|arm64|armv8.*)$")
        message(FATAL_ERROR
            "The ARM64 release preset requires an AArch64 target; found '${CMAKE_SYSTEM_PROCESSOR}' "
            "with CMAKE_OSX_ARCHITECTURES='${CMAKE_OSX_ARCHITECTURES}'."
        )
    elseif(NOT TUTORUX_RELEASE_ARCH STREQUAL "x64" AND
           NOT TUTORUX_RELEASE_ARCH STREQUAL "arm64")
        message(FATAL_ERROR "TUTORUX_RELEASE_ARCH must be x64 or arm64.")
    endif()
endif()

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
option(TUTORUX_ENABLE_PDF "Enable PoDoFo-backed PDF import and export" ON)
option(TUTORUX_ENABLE_NETWORK "Enable libcurl-backed HTTPS providers" ON)
option(TUTORUX_ENABLE_WHISPER "Enable local transcription with whisper.cpp" OFF)
option(TUTORUX_FETCH_WHISPER "Fetch the pinned whisper.cpp dependency" OFF)
option(TUTORUX_ENABLE_FFMPEG "Enable local FLAC, MP3, and M4A decoding" OFF)
option(TUTORUX_ENABLE_PIPEWIRE "Enable Linux PipeWire microphone and system-audio capture" ON)
option(TUTORUX_FETCH_FFMPEG "Build the pinned FFmpeg source statically" OFF)
set(TUTORUX_FFMPEG_PREFIX "" CACHE PATH
    "Prefix containing a static FFmpeg build for relinking or externally supplied builds"
)
option(TUTORUX_ENABLE_LLAMA "Enable embedded llama.cpp inference" OFF)
option(TUTORUX_FETCH_LLAMA "Fetch the pinned llama.cpp dependency" OFF)
option(TUTORUX_LLAMA_CUDA "Build embedded llama.cpp with CUDA support" OFF)
option(TUTORUX_LLAMA_VULKAN "Build embedded llama.cpp with Vulkan support" OFF)
option(TUTORUX_LLAMA_METAL "Build embedded llama.cpp with Metal support" OFF)
option(TUTORUX_ENABLE_LTO "Enable link-time optimization for release builds" ON)
option(TUTORUX_STATIC_RUNTIME "Statically link bundled third-party dependencies" OFF)
option(TUTORUX_BUILD_WASM "Build the static browser edition with Emscripten" OFF)
option(TUTORUX_STRIP_RUNTIME "Strip the release executable after linking" ON)
option(TUTORUX_SLINT_TESTING "Build the Slint headless testing backend" OFF)
set(TUTORUX_SIZE_LIMIT_BYTES "65000000" CACHE STRING
    "Maximum accepted size for the release executable in bytes"
)

if(TUTORUX_FETCH_LLAMA)
    set(TUTORUX_ENABLE_LLAMA ON)
endif()
if(TUTORUX_FETCH_WHISPER)
    set(TUTORUX_ENABLE_WHISPER ON)
endif()
if(TUTORUX_FETCH_FFMPEG)
    set(TUTORUX_ENABLE_FFMPEG ON)
endif()

if(TUTORUX_BUILD_WASM AND NOT EMSCRIPTEN)
    message(FATAL_ERROR "TUTORUX_BUILD_WASM requires the Emscripten toolchain.")
endif()
if(TUTORUX_BUILD_WASM AND
   (TUTORUX_FETCH_SLINT OR TUTORUX_FETCH_PODOFO OR TUTORUX_FETCH_WHISPER OR
    TUTORUX_FETCH_FFMPEG OR TUTORUX_FETCH_LLAMA))
    message(FATAL_ERROR
        "The WebAssembly target uses browser-native interfaces and does not fetch native-only "
        "GUI, PDF, transcription, or model dependencies."
    )
endif()
if(TUTORUX_BUILD_WASM AND
   (TUTORUX_BUILD_GUI OR TUTORUX_ENABLE_WHISPER OR TUTORUX_ENABLE_FFMPEG OR TUTORUX_ENABLE_LLAMA))
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

if(TUTORUX_BUILD_WASM)
    enable_language(C)
endif()

if(TUTORUX_LLAMA_METAL AND NOT APPLE)
    message(FATAL_ERROR "TUTORUX_LLAMA_METAL can only be enabled on macOS.")
endif()
if((TUTORUX_LLAMA_CUDA OR TUTORUX_LLAMA_VULKAN OR TUTORUX_LLAMA_METAL) AND
   NOT TUTORUX_ENABLE_LLAMA)
    message(FATAL_ERROR "llama.cpp acceleration options require TUTORUX_ENABLE_LLAMA=ON.")
endif()

if(TUTORUX_STATIC_RUNTIME)
    if(TUTORUX_ENABLE_PDF AND NOT TUTORUX_FETCH_PODOFO)
        message(FATAL_ERROR "Static PDF builds require TUTORUX_FETCH_PODOFO=ON.")
    endif()
    if(TUTORUX_BUILD_GUI AND NOT TUTORUX_FETCH_SLINT)
        message(FATAL_ERROR "Static GUI builds require TUTORUX_FETCH_SLINT=ON.")
    endif()
    if(TUTORUX_ENABLE_WHISPER AND NOT TUTORUX_FETCH_WHISPER)
        message(FATAL_ERROR "Static Whisper builds require TUTORUX_FETCH_WHISPER=ON.")
    endif()
    if(TUTORUX_ENABLE_FFMPEG AND NOT TUTORUX_FETCH_FFMPEG AND NOT TUTORUX_FFMPEG_PREFIX)
        message(FATAL_ERROR
            "Static FFmpeg builds require TUTORUX_FETCH_FFMPEG=ON or a static "
            "TUTORUX_FFMPEG_PREFIX development package."
        )
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
    src/audio/recording_take.cpp
    src/audio/capture_alsa.cpp
    src/audio/capture_pipewire.cpp
    src/audio/capture_coreaudio.cpp
    src/audio/devices.cpp
    src/audio/recording_control.cpp
    src/audio/ffmpeg_import.cpp
    src/audio/wav_import.cpp
    src/audio/wav_export.cpp
    src/audio/mix.cpp
    src/audio/timeline.cpp
    src/audio/waveform.cpp
    src/audio/playback.cpp
    src/archive/archive.cpp
    src/archive/compression.cpp
    src/archive/crypto.cpp
    src/archive/file.cpp
    src/archive/format.cpp
    src/archive/sanitized_copy.cpp
    src/application/task-executor.cpp
    src/application/journal-service.cpp
    src/application/recording-service.cpp
    src/application/trash-service.cpp
    src/application/workspace-service.cpp
    src/command/dispatcher.cpp
    src/command/json.cpp
    src/command/session_package.cpp
    src/command/zip.cpp
    src/domain/entities.cpp
    src/domain/guide.cpp
    src/domain/hash.cpp
    src/domain/journal.cpp
    src/diagnostics/system.cpp
    src/intelligence/evidence_extract.cpp
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
        src/audio/capture_pipewire.cpp
        src/audio/capture_coreaudio.cpp
        src/audio/devices.cpp
        src/audio/recording_control.cpp
        src/document/pdf_export.cpp
    )
    list(APPEND TUTORUX_CORE_SOURCES
        src/ai/http_wasm.cpp
        src/audio/platform_wasm.cpp
        src/audio/playback_wasm.cpp
        src/document/image_decoder.cpp
        src/document/pdf_export_wasm.cpp
    )
endif()

if(CMAKE_SYSTEM_NAME STREQUAL "Linux" AND NOT TUTORUX_BUILD_WASM)
    list(APPEND TUTORUX_CORE_SOURCES src/audio/playback_alsa.cpp)
elseif(WIN32)
    list(APPEND TUTORUX_CORE_SOURCES src/audio/playback_wasapi.cpp)
endif()

if(NOT TUTORUX_ENABLE_PDF AND NOT TUTORUX_BUILD_WASM)
    list(REMOVE_ITEM TUTORUX_CORE_SOURCES src/document/pdf_export.cpp)
    list(APPEND TUTORUX_CORE_SOURCES src/document/pdf_export_unavailable.cpp)
endif()
if(NOT TUTORUX_ENABLE_NETWORK AND NOT TUTORUX_BUILD_WASM)
    list(REMOVE_ITEM TUTORUX_CORE_SOURCES src/ai/http.cpp)
    list(APPEND TUTORUX_CORE_SOURCES src/ai/http_unavailable.cpp)
elseif(WIN32 AND NOT TUTORUX_BUILD_WASM)
    list(REMOVE_ITEM TUTORUX_CORE_SOURCES src/ai/http.cpp)
    list(APPEND TUTORUX_CORE_SOURCES src/ai/http_winhttp.cpp)
endif()

add_library(tutorux_core STATIC ${TUTORUX_CORE_SOURCES})
target_include_directories(tutorux_core PUBLIC include)
target_compile_features(tutorux_core PUBLIC cxx_std_23)

if(TUTORUX_BUILD_WASM)
    include(FetchContent)

    set(TUTORUX_ZLIB_COMMIT_PIN "da607da739fa6047df13e66a2af6b8bec7c2a498")
    set(TUTORUX_LIBPNG_COMMIT_PIN "cd952f49f95bb27154ae77dbb103032d95f6e580")
    set(TUTORUX_GIFLIB_COMMIT_PIN "061605081115bbfd7019bafc119a13b6f17fcf25")
    set(TUTORUX_LIBWEBP_COMMIT_PIN "4fa21912338357f89e4fd51cf2368325b59e9bd9")

    set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
    set(ZLIB_BUILD_TESTING OFF CACHE BOOL "" FORCE)
    set(ZLIB_BUILD_SHARED OFF CACHE BOOL "" FORCE)
    set(ZLIB_BUILD_STATIC ON CACHE BOOL "" FORCE)
    set(ZLIB_INSTALL OFF CACHE BOOL "" FORCE)
    FetchContent_Declare(
        tutorux_zlib
        GIT_REPOSITORY https://github.com/madler/zlib.git
        GIT_TAG ${TUTORUX_ZLIB_COMMIT_PIN}
        GIT_SHALLOW TRUE
        GIT_SUBMODULES ""
    )
    FetchContent_MakeAvailable(tutorux_zlib)
    FetchContent_GetProperties(tutorux_zlib SOURCE_DIR TUTORUX_ZLIB_SOURCE_DIR)
    tutorux_verify_source_pin(
        zlib "${TUTORUX_ZLIB_SOURCE_DIR}" "${TUTORUX_ZLIB_COMMIT_PIN}"
    )
    if(NOT TARGET zlibstatic)
        message(FATAL_ERROR "The pinned zlib source did not define the static zlib target.")
    endif()

    add_library(ZLIB::ZLIB ALIAS zlibstatic)
    set(ZLIB_FOUND TRUE)
    set(ZLIB_VERSION_STRING "1.3.2")
    set(ZLIB_INCLUDE_DIR "${TUTORUX_ZLIB_SOURCE_DIR}")
    set(ZLIB_INCLUDE_DIRS "${TUTORUX_ZLIB_SOURCE_DIR};${tutorux_zlib_BINARY_DIR}")
    set(ZLIB_LIBRARY zlibstatic)
    set(ZLIB_LIBRARY_RELEASE zlibstatic)
    set(ZLIB_LIBRARY_DEBUG zlibstatic)

    set(PNG_SHARED OFF CACHE BOOL "" FORCE)
    set(PNG_STATIC ON CACHE BOOL "" FORCE)
    set(PNG_TESTS OFF CACHE BOOL "" FORCE)
    set(PNG_TOOLS OFF CACHE BOOL "" FORCE)
    set(PNG_FRAMEWORK OFF CACHE BOOL "" FORCE)
    set(PNG_HARDWARE_OPTIMIZATIONS OFF CACHE BOOL "" FORCE)
    FetchContent_Declare(
        tutorux_libpng
        GIT_REPOSITORY https://github.com/pnggroup/libpng.git
        GIT_TAG ${TUTORUX_LIBPNG_COMMIT_PIN}
        GIT_SHALLOW TRUE
        GIT_SUBMODULES ""
    )
    FetchContent_MakeAvailable(tutorux_libpng)
    FetchContent_GetProperties(tutorux_libpng SOURCE_DIR TUTORUX_LIBPNG_SOURCE_DIR)
    tutorux_verify_source_pin(
        libpng "${TUTORUX_LIBPNG_SOURCE_DIR}" "${TUTORUX_LIBPNG_COMMIT_PIN}"
    )
    if(NOT TARGET png_static)
        message(FATAL_ERROR "The pinned libpng source did not define the static png target.")
    endif()
    target_link_libraries(png_static PUBLIC zlibstatic)

    FetchContent_Declare(
        tutorux_giflib
        GIT_REPOSITORY https://git.code.sf.net/p/giflib/code
        GIT_TAG ${TUTORUX_GIFLIB_COMMIT_PIN}
        GIT_SUBMODULES ""
    )
    FetchContent_MakeAvailable(tutorux_giflib)
    FetchContent_GetProperties(tutorux_giflib SOURCE_DIR TUTORUX_GIFLIB_SOURCE_DIR)
    tutorux_verify_source_pin(
        GIFLIB "${TUTORUX_GIFLIB_SOURCE_DIR}" "${TUTORUX_GIFLIB_COMMIT_PIN}"
    )
    add_library(tutorux_giflib STATIC
        "${TUTORUX_GIFLIB_SOURCE_DIR}/dgif_lib.c"
        "${TUTORUX_GIFLIB_SOURCE_DIR}/gifalloc.c"
        "${TUTORUX_GIFLIB_SOURCE_DIR}/gif_err.c"
        "${TUTORUX_GIFLIB_SOURCE_DIR}/gif_hash.c"
        "${TUTORUX_GIFLIB_SOURCE_DIR}/openbsd-reallocarray.c"
    )
    target_include_directories(tutorux_giflib PUBLIC "${TUTORUX_GIFLIB_SOURCE_DIR}")

    set(WEBP_BUILD_ANIM_UTILS OFF CACHE BOOL "" FORCE)
    set(WEBP_BUILD_CWEBP OFF CACHE BOOL "" FORCE)
    set(WEBP_BUILD_DWEBP OFF CACHE BOOL "" FORCE)
    set(WEBP_BUILD_GIF2WEBP OFF CACHE BOOL "" FORCE)
    set(WEBP_BUILD_IMG2WEBP OFF CACHE BOOL "" FORCE)
    set(WEBP_BUILD_VWEBP OFF CACHE BOOL "" FORCE)
    set(WEBP_BUILD_WEBPINFO OFF CACHE BOOL "" FORCE)
    set(WEBP_BUILD_LIBWEBPMUX OFF CACHE BOOL "" FORCE)
    set(WEBP_BUILD_WEBPMUX OFF CACHE BOOL "" FORCE)
    set(WEBP_BUILD_EXTRAS OFF CACHE BOOL "" FORCE)
    set(WEBP_BUILD_FUZZTEST OFF CACHE BOOL "" FORCE)
    set(WEBP_ENABLE_SIMD OFF CACHE BOOL "" FORCE)
    set(WEBP_USE_THREAD OFF CACHE BOOL "" FORCE)
    FetchContent_Declare(
        tutorux_libwebp
        GIT_REPOSITORY https://github.com/webmproject/libwebp.git
        GIT_TAG ${TUTORUX_LIBWEBP_COMMIT_PIN}
        GIT_SHALLOW TRUE
        GIT_SUBMODULES ""
    )
    FetchContent_MakeAvailable(tutorux_libwebp)
    FetchContent_GetProperties(tutorux_libwebp SOURCE_DIR TUTORUX_LIBWEBP_SOURCE_DIR)
    tutorux_verify_source_pin(
        libwebp "${TUTORUX_LIBWEBP_SOURCE_DIR}" "${TUTORUX_LIBWEBP_COMMIT_PIN}"
    )
    if(NOT TARGET webp OR NOT TARGET webpdemux)
        message(FATAL_ERROR "The pinned libwebp source did not define the static decoder targets.")
    endif()

    target_include_directories(tutorux_core PRIVATE
        "${TUTORUX_LIBPNG_SOURCE_DIR}"
        "${tutorux_libpng_BINARY_DIR}"
    )
    target_link_libraries(tutorux_core PRIVATE png_static tutorux_giflib webpdemux webp)

    install(FILES "${TUTORUX_ZLIB_SOURCE_DIR}/LICENSE"
        DESTINATION licenses/zlib COMPONENT WebRuntime
    )
    install(FILES "${TUTORUX_LIBPNG_SOURCE_DIR}/LICENSE.md"
        DESTINATION licenses/libpng COMPONENT WebRuntime
    )
    install(FILES "${TUTORUX_GIFLIB_SOURCE_DIR}/COPYING"
        DESTINATION licenses/GIFLIB COMPONENT WebRuntime
    )
    install(FILES
        "${TUTORUX_LIBWEBP_SOURCE_DIR}/COPYING"
        "${TUTORUX_LIBWEBP_SOURCE_DIR}/PATENTS"
        DESTINATION licenses/libwebp COMPONENT WebRuntime
    )
endif()

if(CMAKE_SYSTEM_NAME STREQUAL "Linux")
    find_package(PkgConfig REQUIRED)
    if(TUTORUX_STATIC_RUNTIME)
        set(PKG_CONFIG_ARGN --static)
    endif()
    pkg_check_modules(TUTORUX_ALSA REQUIRED IMPORTED_TARGET alsa)
    unset(PKG_CONFIG_ARGN)
    target_link_libraries(tutorux_core PRIVATE PkgConfig::TUTORUX_ALSA)
    target_compile_definitions(tutorux_core PRIVATE TUTORUX_HAS_ALSA=1)

    if(TUTORUX_ENABLE_PIPEWIRE)
        if(TUTORUX_STATIC_RUNTIME)
            set(PKG_CONFIG_ARGN --static)
        endif()
        pkg_check_modules(TUTORUX_PIPEWIRE QUIET IMPORTED_TARGET libpipewire-0.3>=0.3.60)
        unset(PKG_CONFIG_ARGN)

        set(TUTORUX_PIPEWIRE_STATIC_AVAILABLE FALSE)
        if(TUTORUX_PIPEWIRE_FOUND)
            foreach(TUTORUX_PIPEWIRE_LIBRARY_DIR IN LISTS TUTORUX_PIPEWIRE_LIBRARY_DIRS)
                if(EXISTS "${TUTORUX_PIPEWIRE_LIBRARY_DIR}/libpipewire-0.3.a")
                    set(TUTORUX_PIPEWIRE_STATIC_AVAILABLE TRUE)
                    break()
                endif()
            endforeach()
        endif()

        if(TUTORUX_PIPEWIRE_FOUND AND (NOT TUTORUX_STATIC_RUNTIME OR TUTORUX_PIPEWIRE_STATIC_AVAILABLE))
            target_link_libraries(tutorux_core PRIVATE PkgConfig::TUTORUX_PIPEWIRE)
            target_compile_definitions(tutorux_core PRIVATE TUTORUX_HAS_PIPEWIRE=1)
        elseif(TUTORUX_STATIC_RUNTIME)
            message(STATUS
                "PipeWire capture is omitted from this static build because a static libpipewire-0.3 archive is unavailable; ALSA capture remains enabled."
            )
        else()
            message(STATUS
                "PipeWire development files were not found; Linux capture will use the ALSA backend."
            )
        endif()
    endif()
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
elseif(NOT TUTORUX_ENABLE_NETWORK)
    # The base profile ships no TLS or HTTP client; provider calls return a typed error.
elseif(WIN32)
    # Windows uses WinHTTP and the platform trust store; no libcurl/OpenSSL closure.
    target_link_libraries(tutorux_core PRIVATE winhttp)
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

# DOCX/PDF asset extraction (src/assets/import.cpp) uses zlib directly.
if(TUTORUX_BUILD_WASM)
    # The fetched zlib archive is already linked through the PNG/WebP decoders.
elseif(TUTORUX_STATIC_RUNTIME AND NOT MSVC)
    find_package(PkgConfig REQUIRED)
    set(PKG_CONFIG_ARGN --static)
    pkg_check_modules(TUTORUX_STATIC_ZLIB REQUIRED IMPORTED_TARGET zlib)
    unset(PKG_CONFIG_ARGN)
    target_link_libraries(tutorux_core PRIVATE PkgConfig::TUTORUX_STATIC_ZLIB)
else()
    find_package(ZLIB REQUIRED)
    target_link_libraries(tutorux_core PRIVATE ZLIB::ZLIB)
endif()

set(TUTORUX_SODIUM_PREFIX "$ENV{TUTORUX_SODIUM_PREFIX}" CACHE PATH
    "Prefix containing the pinned target libsodium headers and static library"
)
set(TUTORUX_SODIUM_SOURCE_COMMIT "$ENV{TUTORUX_SODIUM_SOURCE_COMMIT}" CACHE STRING
    "Exact source commit used to build the libsodium archive"
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
set(TUTORUX_FFMPEG_VERSION_PIN "9.0.2")
set(TUTORUX_FFMPEG_COMMIT_PIN "946fcce07b6dcd0331c8cc609192aeff5e1924f8")
file(SHA256
    "${CMAKE_CURRENT_SOURCE_DIR}/patches/ffmpeg-9.0.2-cve-2026-107678.patch"
    TUTORUX_FFMPEG_PATCH_SHA256
)
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

if(TUTORUX_ENABLE_FFMPEG)
    if(TUTORUX_FETCH_FFMPEG)
        if(WIN32 AND NOT MINGW)
            message(FATAL_ERROR
                "The pinned FFmpeg source build currently supports Windows UCRT64 MinGW, "
                "Linux, and macOS; an MSVC FFmpeg build is not configured."
            )
        endif()

        enable_language(C)
        include(FetchContent)
        include(ExternalProject)

        FetchContent_Declare(
            tutorux_ffmpeg
            GIT_REPOSITORY https://github.com/FFmpeg/FFmpeg.git
            GIT_TAG n${TUTORUX_FFMPEG_VERSION_PIN}
            GIT_SHALLOW TRUE
            GIT_SUBMODULES ""
        )
        FetchContent_GetProperties(tutorux_ffmpeg)
        if(NOT tutorux_ffmpeg_POPULATED)
            FetchContent_Populate(tutorux_ffmpeg)
        endif()
        FetchContent_GetProperties(tutorux_ffmpeg SOURCE_DIR TUTORUX_FFMPEG_SOURCE_DIR)
        tutorux_verify_source_pin(
            FFmpeg "${TUTORUX_FFMPEG_SOURCE_DIR}" "${TUTORUX_FFMPEG_COMMIT_PIN}"
        )

        if(NOT EXISTS "${TUTORUX_FFMPEG_SOURCE_DIR}/COPYING.LGPLv2.1")
            message(FATAL_ERROR "The pinned FFmpeg source is missing COPYING.LGPLv2.1.")
        endif()
        find_program(TUTORUX_FFMPEG_MAKE_EXECUTABLE NAMES make gmake mingw32-make REQUIRED)
        find_package(Git REQUIRED)
        if(WIN32)
            if(MINGW)
                get_filename_component(TUTORUX_MINGW_BIN_DIR "${CMAKE_C_COMPILER}" DIRECTORY)
                get_filename_component(TUTORUX_MINGW_PREFIX "${TUTORUX_MINGW_BIN_DIR}" DIRECTORY)
                get_filename_component(TUTORUX_MSYS_ROOT "${TUTORUX_MINGW_PREFIX}" DIRECTORY)
                find_program(TUTORUX_MSYS_INSTALL_EXECUTABLE
                    NAMES install.exe install
                    HINTS "${TUTORUX_MSYS_ROOT}/usr/bin"
                    NO_DEFAULT_PATH
                    REQUIRED
                )
                find_program(TUTORUX_MINGW_BASH_EXECUTABLE
                    NAMES bash.exe bash
                    HINTS "${TUTORUX_MSYS_ROOT}/usr/bin"
                    NO_DEFAULT_PATH
                    REQUIRED
                )
                set(TUTORUX_FFMPEG_BASH_EXECUTABLE "${TUTORUX_MINGW_BASH_EXECUTABLE}")
            else()
                find_program(TUTORUX_FFMPEG_BASH_EXECUTABLE NAMES bash REQUIRED)
            endif()
        endif()

        set(TUTORUX_FFMPEG_INSTALL_PREFIX "${CMAKE_CURRENT_BINARY_DIR}/ffmpeg-install")
        set(TUTORUX_FFMPEG_CONFIGURE_ARGS
            "--prefix=${TUTORUX_FFMPEG_INSTALL_PREFIX}"
            --disable-shared
            --enable-static
            --enable-pic
            --disable-gpl
            --disable-version3
            --disable-nonfree
            --disable-programs
            --disable-doc
            --disable-debug
            --disable-network
            --disable-autodetect
            --disable-everything
            --disable-x86asm
            --disable-encoders
            --disable-muxers
            --disable-filters
            --disable-devices
            --disable-indevs
            --disable-outdevs
            --disable-avdevice
            --disable-swscale
            --disable-iconv
            --disable-bzlib
            --disable-lzma
            --disable-zlib
            --enable-demuxer=flac,mp3,mov
            --enable-decoder=aac,alac,flac,mp3,mp3float
            --enable-parser=aac,flac,mpegaudio
            --enable-protocol=file
        )
        if(WIN32)
            if(CMAKE_SYSTEM_PROCESSOR MATCHES "^(ARM64|arm64|aarch64)$")
                set(TUTORUX_FFMPEG_ARCH "aarch64")
            else()
                set(TUTORUX_FFMPEG_ARCH "x86_64")
            endif()
            list(APPEND TUTORUX_FFMPEG_CONFIGURE_ARGS
                --target-os=mingw32
                "--arch=${TUTORUX_FFMPEG_ARCH}"
                "--cc=${CMAKE_C_COMPILER}"
                "--cxx=${CMAKE_CXX_COMPILER}"
                "--ar=${CMAKE_AR}"
                "--ranlib=${CMAKE_RANLIB}"
            )
            set(TUTORUX_FFMPEG_CONFIGURE_COMMAND
                "${TUTORUX_FFMPEG_BASH_EXECUTABLE}"
                "${TUTORUX_FFMPEG_SOURCE_DIR}/configure"
            )
        elseif(APPLE AND CMAKE_OSX_ARCHITECTURES)
            if(CMAKE_OSX_ARCHITECTURES STREQUAL "arm64")
                set(TUTORUX_FFMPEG_ARCH "aarch64")
            else()
                set(TUTORUX_FFMPEG_ARCH "x86_64")
            endif()
            list(APPEND TUTORUX_FFMPEG_CONFIGURE_ARGS
                --target-os=darwin
                "--arch=${TUTORUX_FFMPEG_ARCH}"
                --enable-cross-compile
                "--cc=${CMAKE_C_COMPILER} -arch ${CMAKE_OSX_ARCHITECTURES} -mmacosx-version-min=${CMAKE_OSX_DEPLOYMENT_TARGET}"
                "--cxx=${CMAKE_CXX_COMPILER} -arch ${CMAKE_OSX_ARCHITECTURES} -mmacosx-version-min=${CMAKE_OSX_DEPLOYMENT_TARGET}"
                "--ar=${CMAKE_AR}"
                "--ranlib=${CMAKE_RANLIB}"
            )
            set(TUTORUX_FFMPEG_CONFIGURE_COMMAND
                "${TUTORUX_FFMPEG_SOURCE_DIR}/configure"
            )
        elseif(CMAKE_CROSSCOMPILING AND CMAKE_SYSTEM_NAME STREQUAL "Linux")
            set(TUTORUX_FFMPEG_ARCH "aarch64")
            list(APPEND TUTORUX_FFMPEG_CONFIGURE_ARGS
                --target-os=linux
                "--arch=${TUTORUX_FFMPEG_ARCH}"
                --enable-cross-compile
                "--cc=${CMAKE_C_COMPILER}"
                "--cxx=${CMAKE_CXX_COMPILER}"
                "--ar=${CMAKE_AR}"
                "--ranlib=${CMAKE_RANLIB}"
                "--sysroot=${CMAKE_SYSROOT}"
            )
            set(TUTORUX_FFMPEG_CONFIGURE_COMMAND
                "${TUTORUX_FFMPEG_SOURCE_DIR}/configure"
            )
        else()
            set(TUTORUX_FFMPEG_CONFIGURE_COMMAND
                "${TUTORUX_FFMPEG_SOURCE_DIR}/configure"
            )
        endif()

        if(WIN32 AND MINGW)
            set(TUTORUX_FFMPEG_INSTALL_COMMAND
                "${CMAKE_COMMAND}" -E env "DESTDIR="
                "${TUTORUX_FFMPEG_MAKE_EXECUTABLE}"
                "INSTALL=${TUTORUX_MSYS_INSTALL_EXECUTABLE}"
                install-libs install-headers
            )
        else()
            set(TUTORUX_FFMPEG_INSTALL_COMMAND
                "${CMAKE_COMMAND}" -E env "DESTDIR="
                "${TUTORUX_FFMPEG_MAKE_EXECUTABLE}"
                install-libs install-headers
            )
        endif()

        ExternalProject_Add(tutorux_ffmpeg_build
            SOURCE_DIR "${TUTORUX_FFMPEG_SOURCE_DIR}"
            DOWNLOAD_COMMAND ""
            UPDATE_COMMAND ""
            PATCH_COMMAND
                "${CMAKE_COMMAND}"
                "-DGIT_EXECUTABLE=${GIT_EXECUTABLE}"
                "-DSOURCE_DIR=${TUTORUX_FFMPEG_SOURCE_DIR}"
                "-DPATCH_FILE=${CMAKE_CURRENT_SOURCE_DIR}/patches/ffmpeg-9.0.2-cve-2026-107678.patch"
                -P "${CMAKE_CURRENT_SOURCE_DIR}/cmake/ApplyFFmpegPatch.cmake"
            CONFIGURE_COMMAND
                ${TUTORUX_FFMPEG_CONFIGURE_COMMAND}
                ${TUTORUX_FFMPEG_CONFIGURE_ARGS}
            BUILD_COMMAND "${TUTORUX_FFMPEG_MAKE_EXECUTABLE}" -j4
            INSTALL_COMMAND ${TUTORUX_FFMPEG_INSTALL_COMMAND}
            BUILD_IN_SOURCE TRUE
            BUILD_BYPRODUCTS
                "${TUTORUX_FFMPEG_INSTALL_PREFIX}/lib/libavformat.a"
                "${TUTORUX_FFMPEG_INSTALL_PREFIX}/lib/libavcodec.a"
                "${TUTORUX_FFMPEG_INSTALL_PREFIX}/lib/libavutil.a"
                "${TUTORUX_FFMPEG_INSTALL_PREFIX}/lib/libswresample.a"
            USES_TERMINAL_CONFIGURE TRUE
            USES_TERMINAL_BUILD TRUE
            USES_TERMINAL_INSTALL TRUE
        )
        add_dependencies(tutorux_core tutorux_ffmpeg_build)
        target_include_directories(tutorux_core PRIVATE
            "${TUTORUX_FFMPEG_INSTALL_PREFIX}/include"
        )
        target_link_libraries(tutorux_core PRIVATE
            "${TUTORUX_FFMPEG_INSTALL_PREFIX}/lib/libavformat.a"
            "${TUTORUX_FFMPEG_INSTALL_PREFIX}/lib/libavcodec.a"
            "${TUTORUX_FFMPEG_INSTALL_PREFIX}/lib/libswresample.a"
            "${TUTORUX_FFMPEG_INSTALL_PREFIX}/lib/libavutil.a"
        )
        if(UNIX AND NOT APPLE)
            target_link_libraries(tutorux_core PRIVATE m pthread dl)
        elseif(APPLE)
            target_link_libraries(tutorux_core PRIVATE pthread)
        endif()
        target_compile_definitions(tutorux_core PRIVATE TUTORUX_WITH_FFMPEG=1)

        set(TUTORUX_FFMPEG_RELINK_DIR "${CMAKE_CURRENT_BINARY_DIR}/ffmpeg-relink")
        set(TUTORUX_FFMPEG_SOURCE_ARCHIVE
            "${TUTORUX_FFMPEG_RELINK_DIR}/FFmpeg-${TUTORUX_FFMPEG_VERSION_PIN}-patched-source.tar.gz"
        )
        add_custom_target(tutorux_ffmpeg_relink_source ALL
            COMMAND "${CMAKE_COMMAND}"
                "-DGIT_EXECUTABLE=${GIT_EXECUTABLE}"
                "-DSOURCE_DIR=${TUTORUX_FFMPEG_SOURCE_DIR}"
                "-DPATCH_FILE=${CMAKE_CURRENT_SOURCE_DIR}/patches/ffmpeg-9.0.2-cve-2026-107678.patch"
                "-DSOURCE_COMMIT=${TUTORUX_FFMPEG_COMMIT_PIN}"
                "-DOUTPUT_ARCHIVE=${TUTORUX_FFMPEG_SOURCE_ARCHIVE}"
                -P "${CMAKE_CURRENT_SOURCE_DIR}/cmake/PackageFFmpegSource.cmake"
            DEPENDS tutorux_ffmpeg_build
            BYPRODUCTS "${TUTORUX_FFMPEG_SOURCE_ARCHIVE}" "${TUTORUX_FFMPEG_SOURCE_ARCHIVE}.sha256"
            VERBATIM
        )

        string(REPLACE ";" "\n  " TUTORUX_FFMPEG_CONFIGURE_ARGS_TEXT
            "${TUTORUX_FFMPEG_CONFIGURE_ARGS}"
        )
        string(REPLACE "${TUTORUX_FFMPEG_INSTALL_PREFIX}" "<FFMPEG_INSTALL_PREFIX>"
            TUTORUX_FFMPEG_CONFIGURE_ARGS_TEXT "${TUTORUX_FFMPEG_CONFIGURE_ARGS_TEXT}"
        )
        string(REPLACE "${CMAKE_C_COMPILER}" "<C_COMPILER>"
            TUTORUX_FFMPEG_CONFIGURE_ARGS_TEXT "${TUTORUX_FFMPEG_CONFIGURE_ARGS_TEXT}"
        )
        string(REPLACE "${CMAKE_CXX_COMPILER}" "<CXX_COMPILER>"
            TUTORUX_FFMPEG_CONFIGURE_ARGS_TEXT "${TUTORUX_FFMPEG_CONFIGURE_ARGS_TEXT}"
        )
        get_filename_component(TUTORUX_FFMPEG_C_COMPILER_NAME "${CMAKE_C_COMPILER}" NAME)
        get_filename_component(TUTORUX_FFMPEG_CXX_COMPILER_NAME "${CMAKE_CXX_COMPILER}" NAME)
        get_filename_component(TUTORUX_FFMPEG_MAKE_NAME "${TUTORUX_FFMPEG_MAKE_EXECUTABLE}" NAME)
        get_filename_component(TUTORUX_FFMPEG_CMAKE_MAKE_NAME "${CMAKE_MAKE_PROGRAM}" NAME)
        if(WIN32)
            set(TUTORUX_FFMPEG_CONFIGURE_COMMAND_TEXT "bash ./configure")
        else()
            set(TUTORUX_FFMPEG_CONFIGURE_COMMAND_TEXT "./configure")
        endif()
        file(MAKE_DIRECTORY "${TUTORUX_FFMPEG_RELINK_DIR}")
        file(WRITE "${TUTORUX_FFMPEG_RELINK_DIR}/ffmpeg-build-metadata.txt"
            "FFmpeg version: ${TUTORUX_FFMPEG_VERSION_PIN}\n"
            "Upstream Git commit: ${TUTORUX_FFMPEG_COMMIT_PIN}\n"
            "Security patch: ffmpeg-9.0.2-cve-2026-107678.patch\n"
            "Security patch SHA-256: ${TUTORUX_FFMPEG_PATCH_SHA256}\n"
            "Security patch provenance: docs/dependencies/FFMPEG-CVE-2026-107678.md\n"
            "CMake generator: ${CMAKE_GENERATOR}\n"
            "CMake build type: ${CMAKE_BUILD_TYPE}\n"
            "Target system: ${CMAKE_SYSTEM_NAME} ${CMAKE_SYSTEM_PROCESSOR}\n"
            "Tutorux profile: GUI=${TUTORUX_BUILD_GUI}; Whisper=${TUTORUX_ENABLE_WHISPER}; llama.cpp=${TUTORUX_ENABLE_LLAMA}; static runtime=${TUTORUX_STATIC_RUNTIME}\n"
            "C compiler executable: ${TUTORUX_FFMPEG_C_COMPILER_NAME}\n"
            "C compiler ID/version: ${CMAKE_C_COMPILER_ID} ${CMAKE_C_COMPILER_VERSION}\n"
            "C flags: ${CMAKE_C_FLAGS} ${CMAKE_C_FLAGS_${CMAKE_BUILD_TYPE}}\n"
            "C++ compiler executable: ${TUTORUX_FFMPEG_CXX_COMPILER_NAME}\n"
            "C++ compiler ID/version: ${CMAKE_CXX_COMPILER_ID} ${CMAKE_CXX_COMPILER_VERSION}\n"
            "C++ flags: ${CMAKE_CXX_FLAGS} ${CMAKE_CXX_FLAGS_${CMAKE_BUILD_TYPE}}\n"
            "CMake build program: ${TUTORUX_FFMPEG_CMAKE_MAKE_NAME}\n"
            "FFmpeg make program: ${TUTORUX_FFMPEG_MAKE_NAME}\n"
            "FFmpeg build command: make -j4\n"
            "FFmpeg configure command: ${TUTORUX_FFMPEG_CONFIGURE_COMMAND_TEXT}\n"
            "FFmpeg configure arguments:\n  ${TUTORUX_FFMPEG_CONFIGURE_ARGS_TEXT}\n"
            "Static FFmpeg link order: libavformat.a, libavcodec.a, libswresample.a, libavutil.a\n"
            "Additional FFmpeg link libraries: m pthread dl on Linux; pthread on macOS; none on Windows\n"
            "Relink: build the matching Tutorux source with TUTORUX_ENABLE_FFMPEG=ON, TUTORUX_FETCH_FFMPEG=OFF, and TUTORUX_FFMPEG_PREFIX set to this package's relink/ffmpeg directory; use the same target toolchain and release preset settings, then build target tutorux.\n"
        )
    else()
        if(TUTORUX_FFMPEG_PREFIX)
            set(TUTORUX_FFMPEG_STATIC_LIBRARIES
                libavformat.a libavcodec.a libswresample.a libavutil.a
            )
            foreach(TUTORUX_FFMPEG_LIBRARY IN LISTS TUTORUX_FFMPEG_STATIC_LIBRARIES)
                if(NOT EXISTS "${TUTORUX_FFMPEG_PREFIX}/lib/${TUTORUX_FFMPEG_LIBRARY}")
                    message(FATAL_ERROR
                        "TUTORUX_FFMPEG_PREFIX is missing static archive ${TUTORUX_FFMPEG_LIBRARY}."
                    )
                endif()
            endforeach()
            target_include_directories(tutorux_core PRIVATE "${TUTORUX_FFMPEG_PREFIX}/include")
            target_link_libraries(tutorux_core PRIVATE
                "${TUTORUX_FFMPEG_PREFIX}/lib/libavformat.a"
                "${TUTORUX_FFMPEG_PREFIX}/lib/libavcodec.a"
                "${TUTORUX_FFMPEG_PREFIX}/lib/libswresample.a"
                "${TUTORUX_FFMPEG_PREFIX}/lib/libavutil.a"
            )
            if(UNIX AND NOT APPLE)
                target_link_libraries(tutorux_core PRIVATE m pthread dl)
            elseif(APPLE)
                target_link_libraries(tutorux_core PRIVATE pthread)
            endif()
        else()
            find_package(PkgConfig REQUIRED)
            pkg_check_modules(TUTORUX_FFMPEG REQUIRED IMPORTED_TARGET
                libavformat libavcodec libavutil libswresample
            )
            target_link_libraries(tutorux_core PRIVATE PkgConfig::TUTORUX_FFMPEG)
        endif()
        target_compile_definitions(tutorux_core PRIVATE TUTORUX_WITH_FFMPEG=1)
    endif()
endif()

if(TUTORUX_ENABLE_PDF)
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
endif()

if(WIN32)
    target_compile_definitions(tutorux_core PUBLIC WINVER=0x0A00 _WIN32_WINNT=0x0A00)
    target_link_libraries(tutorux_core PUBLIC ole32 shell32 propsys uuid advapi32 Psapi)
endif()

if(MSVC)
    target_compile_options(tutorux_core PRIVATE /W4 /permissive- /Zc:__cplusplus /EHsc)
    target_compile_definitions(tutorux_core PUBLIC NOMINMAX WIN32_LEAN_AND_MEAN)
else()
    target_compile_options(tutorux_core PRIVATE -Wall -Wextra -Wpedantic -Wconversion -Wsign-conversion)
endif()

target_compile_definitions(tutorux_core PRIVATE
    TUTORUX_BUILD_GUI=$<BOOL:${TUTORUX_BUILD_GUI}>
    TUTORUX_ENABLE_WHISPER=$<BOOL:${TUTORUX_ENABLE_WHISPER}>
    TUTORUX_WITH_PDF=$<BOOL:${TUTORUX_ENABLE_PDF}>
    TUTORUX_WITH_NETWORK=$<BOOL:${TUTORUX_ENABLE_NETWORK}>
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
        set(TUTORUX_LLAMA_CLEF_SOURCE "${TUTORUX_LLAMA_SOURCE_DIR}/src/models/clef.cpp")
        if(NOT EXISTS "${TUTORUX_LLAMA_CLEF_SOURCE}")
            message(FATAL_ERROR "The pinned llama.cpp source is missing src/models/clef.cpp.")
        endif()
        file(READ "${TUTORUX_LLAMA_CLEF_SOURCE}" TUTORUX_LLAMA_CLEF_CONTENT)
        string(FIND "${TUTORUX_LLAMA_CLEF_CONTENT}" "#include <algorithm>" TUTORUX_LLAMA_ALGORITHM_INCLUDE)
        if(TUTORUX_LLAMA_ALGORITHM_INCLUDE EQUAL -1)
            string(FIND "${TUTORUX_LLAMA_CLEF_CONTENT}" "#include <cmath>" TUTORUX_LLAMA_CMATH_INCLUDE)
            if(TUTORUX_LLAMA_CMATH_INCLUDE EQUAL -1)
                message(FATAL_ERROR "The pinned llama.cpp clef source no longer matches the compatibility patch.")
            endif()
            string(REPLACE "#include <cmath>" "#include <algorithm>\n#include <cmath>"
                TUTORUX_LLAMA_CLEF_CONTENT "${TUTORUX_LLAMA_CLEF_CONTENT}"
            )
            file(WRITE "${TUTORUX_LLAMA_CLEF_SOURCE}" "${TUTORUX_LLAMA_CLEF_CONTENT}")
        endif()
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

if(TUTORUX_FETCH_LLAMA)
    install(FILES "${TUTORUX_LLAMA_SOURCE_DIR}/LICENSE"
        DESTINATION licenses/llama.cpp COMPONENT Runtime
    )
endif()

if(NOT TUTORUX_BUILD_WASM)
    add_executable(tutorux src/main.cpp)
    if(WIN32)
        enable_language(RC)
        target_include_directories(tutorux PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/resources")
        target_sources(tutorux PRIVATE resources/tutorux.rc)
    elseif(APPLE AND TUTORUX_BUILD_GUI)
        set_source_files_properties(resources/macos/tutorux.icns PROPERTIES
            MACOSX_PACKAGE_LOCATION Resources
        )
        set_source_files_properties(
            docs/tutorial/quick-guide.mp4 docs/tutorial/README.md
            PROPERTIES MACOSX_PACKAGE_LOCATION "Resources/docs/tutorial" HEADER_FILE_ONLY TRUE
        )
        target_sources(tutorux PRIVATE
            resources/macos/tutorux.icns
            docs/tutorial/quick-guide.mp4
            docs/tutorial/README.md
        )
        set_target_properties(tutorux PROPERTIES
            MACOSX_BUNDLE TRUE
            MACOSX_BUNDLE_BUNDLE_NAME "Tutorux"
            MACOSX_BUNDLE_GUI_IDENTIFIER "app.tutorux.desktop"
            MACOSX_BUNDLE_ICON_FILE "tutorux.icns"
        )
    endif()
    target_link_libraries(tutorux PRIVATE tutorux_core)
    if(MINGW AND TUTORUX_STATIC_RUNTIME)
        if(CMAKE_CXX_COMPILER_ID STREQUAL "Clang")
            target_link_options(tutorux_core INTERFACE -static)
        else()
            target_link_options(tutorux_core INTERFACE -static -static-libgcc -static-libstdc++)
        endif()
    elseif(MINGW)
        target_link_options(tutorux PRIVATE -static-libgcc -static-libstdc++)
    elseif(UNIX AND NOT APPLE AND TUTORUX_STATIC_RUNTIME)
        target_link_options(tutorux_core INTERFACE -static -static-libgcc -static-libstdc++)
    endif()
endif()

if(NOT TUTORUX_BUILD_WASM)
    if(TUTORUX_STRIP_RUNTIME AND CMAKE_BUILD_TYPE MATCHES "^(Release|MinSizeRel)$" AND CMAKE_STRIP)
        add_custom_command(
            TARGET tutorux POST_BUILD
            COMMAND "${CMAKE_STRIP}" --strip-unneeded "$<TARGET_FILE:tutorux>"
            COMMENT "Stripping release symbols from tutorux"
            VERBATIM
        )
    endif()
    # Portable handoff artifact: cmake --build <build dir> --target dist
    set(TUTORUX_DIST_NAME "Tutorux${CMAKE_EXECUTABLE_SUFFIX}")
    add_custom_target(dist
        COMMAND "${CMAKE_COMMAND}" -E make_directory "${CMAKE_SOURCE_DIR}/dist"
        COMMAND "${CMAKE_COMMAND}" -E copy_if_different
            "$<TARGET_FILE:tutorux>" "${CMAKE_SOURCE_DIR}/dist/${TUTORUX_DIST_NAME}"
        COMMAND "${CMAKE_COMMAND}" -E copy_if_different
            "${CMAKE_SOURCE_DIR}/ui/fonts/OFL.txt" "${CMAKE_SOURCE_DIR}/dist/NotoSans-OFL.txt"
        COMMAND "${CMAKE_COMMAND}" -E echo
            "Tutorux dist: ${CMAKE_SOURCE_DIR}/dist/${TUTORUX_DIST_NAME}"
        DEPENDS tutorux
        VERBATIM
        COMMENT "Staging ${TUTORUX_DIST_NAME} into dist/"
    )

    add_custom_target(dist-base
        COMMAND "${CMAKE_COMMAND}" -E make_directory "${CMAKE_SOURCE_DIR}/dist"
        COMMAND "${CMAKE_COMMAND}" -E copy_if_different
            "$<TARGET_FILE:tutorux>" "${CMAKE_SOURCE_DIR}/dist/Tutorux-base${CMAKE_EXECUTABLE_SUFFIX}"
        COMMAND "${CMAKE_COMMAND}" -E copy_if_different
            "${CMAKE_SOURCE_DIR}/ui/fonts/OFL.txt" "${CMAKE_SOURCE_DIR}/dist/NotoSans-OFL.txt"
        COMMAND "${CMAKE_COMMAND}" -E echo
            "Tutorux base dist: ${CMAKE_SOURCE_DIR}/dist/Tutorux-base${CMAKE_EXECUTABLE_SUFFIX}"
        DEPENDS tutorux
        VERBATIM
        COMMENT "Staging the base profile into dist/"
    )

    if(NOT TUTORUX_SLINT_TESTING)
        add_custom_target(size
            COMMAND "${CMAKE_COMMAND}"
                "-DTUTORUX_BINARY=$<TARGET_FILE:tutorux>"
                "-DTUTORUX_SIZE_LIMIT_BYTES=${TUTORUX_SIZE_LIMIT_BYTES}"
                "-DTUTORUX_SIZE_PROFILE=${CMAKE_BUILD_TYPE}"
                "-DTUTORUX_SIZE_REPORT=${CMAKE_CURRENT_BINARY_DIR}/size-report.txt"
                "-DTUTORUX_OBJDUMP=${CMAKE_OBJDUMP}"
                -P "${CMAKE_CURRENT_SOURCE_DIR}/tests/size/size_report.cmake"
            DEPENDS tutorux
            VERBATIM
            COMMENT "Checking the Tutorux executable size budget"
        )
        add_test(NAME binary_size_budget
            COMMAND "${CMAKE_COMMAND}"
                "-DTUTORUX_BINARY=$<TARGET_FILE:tutorux>"
                "-DTUTORUX_SIZE_LIMIT_BYTES=${TUTORUX_SIZE_LIMIT_BYTES}"
                "-DTUTORUX_SIZE_PROFILE=${CMAKE_BUILD_TYPE}"
                "-DTUTORUX_SIZE_REPORT=${CMAKE_CURRENT_BINARY_DIR}/size-report.txt"
                "-DTUTORUX_OBJDUMP=${CMAKE_OBJDUMP}"
                -P "${CMAKE_CURRENT_SOURCE_DIR}/tests/size/size_report.cmake"
        )
    endif()
endif()

if(TUTORUX_ENABLE_LTO AND CMAKE_BUILD_TYPE MATCHES "^(Release|MinSizeRel)$" AND NOT MINGW)
    include(CheckIPOSupported)
    check_ipo_supported(RESULT TUTORUX_LTO_SUPPORTED OUTPUT TUTORUX_LTO_ERROR)
    if(TUTORUX_LTO_SUPPORTED)
        set_property(TARGET tutorux_core PROPERTY INTERPROCEDURAL_OPTIMIZATION TRUE)
        if(TARGET tutorux)
            set_property(TARGET tutorux PROPERTY INTERPROCEDURAL_OPTIMIZATION TRUE)
        endif()
    endif()
elseif(TUTORUX_ENABLE_LTO AND CMAKE_BUILD_TYPE MATCHES "^(Release|MinSizeRel)$" AND MINGW)
    message(STATUS "Skipping IPO/LTO for MinGW; GCC LTO cannot reliably merge the COFF archive.")
endif()

if(TUTORUX_BUILD_GUI)
    if(TUTORUX_FETCH_SLINT)
        # Release builds keep only the features the desktop shell needs. The
        # interpreter, live preview, system tray, and test backend are development
        # and size liabilities.
        set(SLINT_FEATURE_INTERPRETER OFF CACHE BOOL "" FORCE)
        set(SLINT_FEATURE_LIVE_PREVIEW OFF CACHE BOOL "" FORCE)
        set(SLINT_FEATURE_SYSTEM_TRAY OFF CACHE BOOL "" FORCE)
        set(SLINT_FEATURE_ACCESSIBILITY ON CACHE BOOL "" FORCE)
        set(SLINT_FEATURE_RENDERER_FEMTOVG OFF CACHE BOOL "" FORCE)
        set(SLINT_FEATURE_RENDERER_SOFTWARE ON CACHE BOOL "" FORCE)
        set(SLINT_FEATURE_TESTING ${TUTORUX_SLINT_TESTING} CACHE BOOL "" FORCE)
        set(SLINT_FEATURE_SYSTEM_TESTING ${TUTORUX_SLINT_TESTING} CACHE BOOL "" FORCE)
        set(SLINT_FEATURE_EXPERIMENTAL ${TUTORUX_SLINT_TESTING} CACHE BOOL "" FORCE)
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

    set(TUTORUX_EMBEDDED_FONT_SOURCE "${CMAKE_CURRENT_BINARY_DIR}/font_data.cpp")
    add_custom_command(
        OUTPUT "${TUTORUX_EMBEDDED_FONT_SOURCE}"
        COMMAND "${CMAKE_COMMAND}"
            "-DOUTPUT=${TUTORUX_EMBEDDED_FONT_SOURCE}"
            "-DFONT_DIR=${CMAKE_SOURCE_DIR}/ui/fonts"
            -P "${CMAKE_SOURCE_DIR}/cmake/EmbedFonts.cmake"
        DEPENDS
            "${CMAKE_SOURCE_DIR}/ui/fonts/NotoSans-Regular.ttf"
            "${CMAKE_SOURCE_DIR}/ui/fonts/NotoSans-Medium.ttf"
            "${CMAKE_SOURCE_DIR}/ui/fonts/NotoSans-SemiBold.ttf"
            "${CMAKE_SOURCE_DIR}/ui/fonts/NotoSans-Bold.ttf"
            "${CMAKE_SOURCE_DIR}/cmake/EmbedFonts.cmake"
        COMMENT "Embedding Noto Sans font weights"
        VERBATIM
    )
    target_sources(tutorux PRIVATE src/gui/desktop.cpp src/gui/system-theme.cpp
        "${TUTORUX_EMBEDDED_FONT_SOURCE}"
    )
    target_include_directories(tutorux PRIVATE src/gui "${CMAKE_CURRENT_BINARY_DIR}")
    target_compile_definitions(tutorux PRIVATE TUTORUX_WITH_GUI=1)
    if(TUTORUX_STATIC_RUNTIME AND WIN32)
        target_compile_definitions(tutorux PRIVATE TUTORUX_STATIC_SLINT=1)
    endif()
    add_library(tutorux_slint_ui OBJECT)
    target_include_directories(tutorux_slint_ui PRIVATE
        "${CMAKE_CURRENT_BINARY_DIR}"
        "${TUTORUX_SLINT_SOURCE_DIR}/api/cpp/include"
    )
    target_link_libraries(tutorux_slint_ui PRIVATE Slint::Slint)
    set_property(TARGET tutorux_slint_ui PROPERTY SLINT_TRANSLATION_DOMAIN tutorux)
    if(TUTORUX_STATIC_RUNTIME AND WIN32)
        target_compile_definitions(tutorux_slint_ui PRIVATE TUTORUX_STATIC_SLINT=1)
    endif()
    slint_target_sources(tutorux_slint_ui ui/app-window.slint)
    if(TUTORUX_SLINT_TESTING AND CMAKE_BUILD_TYPE STREQUAL "Release" AND NOT MSVC)
        # The generated translation unit is very large; keep developer builds
        # responsive while shipped profiles still use -Os/-O3.
        set_source_files_properties(
            "${CMAKE_CURRENT_BINARY_DIR}/slint_generated_app-window_1.cpp"
            PROPERTIES COMPILE_OPTIONS "-O0"
        )
    endif()
    target_link_libraries(tutorux PRIVATE tutorux_slint_ui Slint::Slint)
endif()

if(TUTORUX_FETCH_FFMPEG AND TARGET tutorux)
    get_target_property(TUTORUX_RELINK_CORE_LINK_ITEMS tutorux_core LINK_LIBRARIES)
    get_target_property(TUTORUX_RELINK_EXECUTABLE_LINK_ITEMS tutorux LINK_LIBRARIES)
    set(TUTORUX_RELINK_CORE_LINK_NAMES)
    set(TUTORUX_RELINK_EXECUTABLE_LINK_NAMES)
    foreach(TUTORUX_RELINK_LINK_ITEM IN LISTS TUTORUX_RELINK_CORE_LINK_ITEMS)
        if(IS_ABSOLUTE "${TUTORUX_RELINK_LINK_ITEM}")
            get_filename_component(TUTORUX_RELINK_LINK_NAME "${TUTORUX_RELINK_LINK_ITEM}" NAME)
        else()
            set(TUTORUX_RELINK_LINK_NAME "${TUTORUX_RELINK_LINK_ITEM}")
        endif()
        list(APPEND TUTORUX_RELINK_CORE_LINK_NAMES "${TUTORUX_RELINK_LINK_NAME}")
    endforeach()
    foreach(TUTORUX_RELINK_LINK_ITEM IN LISTS TUTORUX_RELINK_EXECUTABLE_LINK_ITEMS)
        if(IS_ABSOLUTE "${TUTORUX_RELINK_LINK_ITEM}")
            get_filename_component(TUTORUX_RELINK_LINK_NAME "${TUTORUX_RELINK_LINK_ITEM}" NAME)
        else()
            set(TUTORUX_RELINK_LINK_NAME "${TUTORUX_RELINK_LINK_ITEM}")
        endif()
        list(APPEND TUTORUX_RELINK_EXECUTABLE_LINK_NAMES "${TUTORUX_RELINK_LINK_NAME}")
    endforeach()
    string(JOIN ", " TUTORUX_RELINK_CORE_LINK_NAMES_TEXT ${TUTORUX_RELINK_CORE_LINK_NAMES})
    string(JOIN ", " TUTORUX_RELINK_EXECUTABLE_LINK_NAMES_TEXT
        ${TUTORUX_RELINK_EXECUTABLE_LINK_NAMES}
    )
    file(APPEND "${TUTORUX_FFMPEG_RELINK_DIR}/ffmpeg-build-metadata.txt"
        "Tutorux core link targets/libraries (paths reduced to filenames): ${TUTORUX_RELINK_CORE_LINK_NAMES_TEXT}\n"
        "Tutorux executable link targets/libraries (paths reduced to filenames): ${TUTORUX_RELINK_EXECUTABLE_LINK_NAMES_TEXT}\n"
        "Tutorux compile definitions: TUTORUX_WITH_FFMPEG=1; TUTORUX_BUILD_GUI=${TUTORUX_BUILD_GUI}; TUTORUX_ENABLE_WHISPER=${TUTORUX_ENABLE_WHISPER}\n"
    )
endif()

if(TUTORUX_BUILD_WASM)
    find_program(TUTORUX_TSC_EXECUTABLE NAMES tsc REQUIRED)
    add_executable(tutorux_web src/wasm/web_api.cpp)
    target_link_libraries(tutorux_web PRIVATE tutorux_core)
    target_include_directories(tutorux_web PRIVATE "${TUTORUX_SODIUM_INCLUDE_DIR}")
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
        COMMAND ${CMAKE_COMMAND} -E make_directory
                "$<TARGET_FILE_DIR:tutorux_web>/docs/tutorial"
        COMMAND ${CMAKE_COMMAND} -E copy_if_different
                "${CMAKE_CURRENT_SOURCE_DIR}/docs/tutorial/quick-guide.mp4"
                "$<TARGET_FILE_DIR:tutorux_web>/docs/tutorial/quick-guide.mp4"
        COMMAND ${CMAKE_COMMAND} -E copy_if_different
                "${CMAKE_CURRENT_SOURCE_DIR}/docs/tutorial/README.md"
                "$<TARGET_FILE_DIR:tutorux_web>/docs/tutorial/README.md"
        COMMAND "${TUTORUX_TSC_EXECUTABLE}"
                --target ES2022
                --module none
                --lib ES2022,DOM,DOM.Iterable
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
    install(FILES
        "${CMAKE_CURRENT_SOURCE_DIR}/docs/tutorial/quick-guide.mp4"
        "${CMAKE_CURRENT_SOURCE_DIR}/docs/tutorial/README.md"
        DESTINATION web/docs/tutorial COMPONENT WebRuntime
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

if(TUTORUX_ENABLE_PDF AND TUTORUX_FETCH_PODOFO)
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
if(TUTORUX_FETCH_FFMPEG)
    install(FILES
        "${TUTORUX_FFMPEG_SOURCE_DIR}/COPYING.LGPLv2.1"
        "${CMAKE_CURRENT_SOURCE_DIR}/patches/ffmpeg-9.0.2-cve-2026-107678.patch"
        "${CMAKE_CURRENT_SOURCE_DIR}/docs/dependencies/FFMPEG-CVE-2026-107678.md"
        DESTINATION licenses/FFmpeg COMPONENT Runtime
    )
    install(DIRECTORY "${TUTORUX_FFMPEG_INSTALL_PREFIX}/include/"
        DESTINATION relink/ffmpeg/include
        COMPONENT Development
        FILES_MATCHING PATTERN "*.h"
    )
    install(DIRECTORY "${TUTORUX_FFMPEG_INSTALL_PREFIX}/lib/"
        DESTINATION relink/ffmpeg/lib
        COMPONENT Development
        FILES_MATCHING PATTERN "*.a" PATTERN "*.pc"
    )
    install(FILES
        "${TUTORUX_FFMPEG_SOURCE_ARCHIVE}"
        "${TUTORUX_FFMPEG_SOURCE_ARCHIVE}.sha256"
        "${TUTORUX_FFMPEG_RELINK_DIR}/ffmpeg-build-metadata.txt"
        "${CMAKE_CURRENT_SOURCE_DIR}/patches/ffmpeg-9.0.2-cve-2026-107678.patch"
        "${CMAKE_CURRENT_SOURCE_DIR}/docs/dependencies/FFMPEG-CVE-2026-107678.md"
        "${CMAKE_CURRENT_SOURCE_DIR}/docs/dependencies/FFMPEG-LGPL-RELINK.md"
        "${TUTORUX_FFMPEG_SOURCE_DIR}/COPYING.LGPLv2.1"
        DESTINATION relink/ffmpeg
        COMPONENT Development
    )
endif()

if(TUTORUX_STATIC_RUNTIME AND
   (CMAKE_SYSTEM_NAME STREQUAL "Linux" OR APPLE))
    if(APPLE)
        set(TUTORUX_STATIC_MANIFEST_PLATFORM "macOS ${CMAKE_SYSTEM_PROCESSOR}")
        set(TUTORUX_STATIC_MANIFEST_FILE
            "${CMAKE_CURRENT_BINARY_DIR}/TUTORUX-STATIC-MACOS-SBOM.md"
        )
        set(TUTORUX_STATIC_LICENSE_PLATFORM "macOS")
        find_program(TUTORUX_BREW_EXECUTABLE brew)
        set(TUTORUX_STATIC_LICENSE_SYSROOT "")
    else()
        set(TUTORUX_STATIC_MANIFEST_PLATFORM "Linux ${CMAKE_SYSTEM_PROCESSOR}")
        set(TUTORUX_STATIC_MANIFEST_FILE
            "${CMAKE_CURRENT_BINARY_DIR}/TUTORUX-STATIC-LINUX-SBOM.md"
        )
        set(TUTORUX_STATIC_LICENSE_PLATFORM "Linux")
        set(TUTORUX_STATIC_LICENSE_SYSROOT "${CMAKE_SYSROOT}")
    endif()

    set(TUTORUX_STATIC_LICENSE_ARCHIVE_NAMES
        ${TUTORUX_STATIC_CURL_STATIC_LIBRARIES}
        ${TUTORUX_STATIC_FREETYPE_STATIC_LIBRARIES}
        ${TUTORUX_STATIC_LIBXML2_STATIC_LIBRARIES}
        ${TUTORUX_STATIC_ARCHIVE_GROUP_LIBRARIES}
        ${TUTORUX_ALSA_STATIC_LIBRARIES}
        ${TUTORUX_PIPEWIRE_STATIC_LIBRARIES}
        "${TUTORUX_SODIUM_LINK_LIBRARY}"
    )
    list(REMOVE_DUPLICATES TUTORUX_STATIC_LICENSE_ARCHIVE_NAMES)
    set(TUTORUX_STATIC_LICENSE_ARCHIVE_PATHS)
    set(TUTORUX_STATIC_LICENSE_UNRESOLVED_NAMES)
    set(TUTORUX_STATIC_LICENSE_SEARCH_DIRS
        ${TUTORUX_STATIC_CURL_STATIC_LIBRARY_DIRS}
        ${TUTORUX_STATIC_FREETYPE_STATIC_LIBRARY_DIRS}
        ${TUTORUX_STATIC_LIBXML2_STATIC_LIBRARY_DIRS}
        ${TUTORUX_PIPEWIRE_STATIC_LIBRARY_DIRS}
        ${CMAKE_PREFIX_PATH}
        "${TUTORUX_SODIUM_PREFIX}/lib"
    )
    if(TUTORUX_ALSA_STATIC_LIBRARY_DIRS)
        list(APPEND TUTORUX_STATIC_LICENSE_SEARCH_DIRS ${TUTORUX_ALSA_STATIC_LIBRARY_DIRS})
    endif()
    set(TUTORUX_STATIC_LICENSE_LIBRARY_INDEX 0)
    foreach(TUTORUX_STATIC_LICENSE_ENTRY IN LISTS TUTORUX_STATIC_LICENSE_ARCHIVE_NAMES)
        if(TARGET "${TUTORUX_STATIC_LICENSE_ENTRY}")
            continue()
        endif()
        if(TUTORUX_STATIC_LICENSE_ENTRY MATCHES "^(m|pthread|dl|rt|c|gcc|gcc_s|stdc\+\+|c\+\+)$")
            continue()
        endif()
        if(APPLE AND TUTORUX_STATIC_LICENSE_ENTRY STREQUAL "iconv")
            continue()
        endif()
        if(EXISTS "${TUTORUX_STATIC_LICENSE_ENTRY}" AND
           NOT IS_DIRECTORY "${TUTORUX_STATIC_LICENSE_ENTRY}")
            list(APPEND TUTORUX_STATIC_LICENSE_ARCHIVE_PATHS
                "${TUTORUX_STATIC_LICENSE_ENTRY}"
            )
            continue()
        endif()

        math(EXPR TUTORUX_STATIC_LICENSE_LIBRARY_INDEX
            "${TUTORUX_STATIC_LICENSE_LIBRARY_INDEX} + 1"
        )
        set(TUTORUX_STATIC_LICENSE_LIBRARY_VAR
            "TUTORUX_STATIC_LICENSE_LIBRARY_${TUTORUX_STATIC_LICENSE_LIBRARY_INDEX}"
        )
        find_library(${TUTORUX_STATIC_LICENSE_LIBRARY_VAR}
            NAMES "${TUTORUX_STATIC_LICENSE_ENTRY}"
            HINTS ${TUTORUX_STATIC_LICENSE_SEARCH_DIRS}
            PATH_SUFFIXES lib lib64
            NO_CACHE
        )
        if(${TUTORUX_STATIC_LICENSE_LIBRARY_VAR})
            list(APPEND TUTORUX_STATIC_LICENSE_ARCHIVE_PATHS
                "${${TUTORUX_STATIC_LICENSE_LIBRARY_VAR}}"
            )
        else()
            list(APPEND TUTORUX_STATIC_LICENSE_UNRESOLVED_NAMES
                "${TUTORUX_STATIC_LICENSE_ENTRY}"
            )
        endif()
    endforeach()
    list(REMOVE_DUPLICATES TUTORUX_STATIC_LICENSE_ARCHIVE_PATHS)

    find_file(TUTORUX_SODIUM_LICENSE_FILE
        NAMES LICENSE COPYING COPYING.md LICENSE.txt
        PATHS
            "${TUTORUX_SODIUM_PREFIX}/share/licenses/libsodium"
            "${TUTORUX_SODIUM_PREFIX}/share/licenses/sodium"
            "${TUTORUX_SODIUM_PREFIX}/share/doc/libsodium"
            "${TUTORUX_STATIC_LICENSE_SYSROOT}/usr/share/doc/libsodium-dev"
            /usr/share/doc/libsodium-dev
            /usr/share/doc/libsodium23
            /opt/homebrew/opt/libsodium/share/doc/libsodium
            /usr/local/opt/libsodium/share/doc/libsodium
        NO_DEFAULT_PATH
    )
    set(TUTORUX_STATIC_LICENSE_OUTPUT_DIRECTORY
        "${CMAKE_CURRENT_BINARY_DIR}/static-dependency-licenses"
    )
    set(TUTORUX_STATIC_LICENSE_STATUS_FILE
        "${TUTORUX_STATIC_LICENSE_OUTPUT_DIRECTORY}/collection-status.txt"
    )
    execute_process(
        COMMAND "${CMAKE_COMMAND}"
            "-DPLATFORM=${TUTORUX_STATIC_LICENSE_PLATFORM}"
            "-DARCHIVE_PATHS=${TUTORUX_STATIC_LICENSE_ARCHIVE_PATHS}"
            "-DUNRESOLVED_NAMES=${TUTORUX_STATIC_LICENSE_UNRESOLVED_NAMES}"
            "-DOUTPUT_DIRECTORY=${TUTORUX_STATIC_LICENSE_OUTPUT_DIRECTORY}"
            "-DMANIFEST_FILE=${TUTORUX_STATIC_MANIFEST_FILE}"
            "-DSYSROOT=${TUTORUX_STATIC_LICENSE_SYSROOT}"
            "-DBREW_EXECUTABLE=${TUTORUX_BREW_EXECUTABLE}"
            "-DSODIUM_ARCHIVE=${TUTORUX_SODIUM_LINK_LIBRARY}"
            "-DSODIUM_VERSION=${TUTORUX_SODIUM_VERSION}"
            "-DSODIUM_SOURCE_COMMIT=${TUTORUX_SODIUM_SOURCE_COMMIT}"
            "-DSODIUM_LICENSE_FILE=${TUTORUX_SODIUM_LICENSE_FILE}"
            -P "${CMAKE_CURRENT_SOURCE_DIR}/cmake/CollectStaticDependencyLicenses.cmake"
        RESULT_VARIABLE TUTORUX_STATIC_LICENSE_COLLECTION_RESULT
    )
    if(NOT TUTORUX_STATIC_LICENSE_COLLECTION_RESULT EQUAL 0)
        message(FATAL_ERROR
            "Static dependency license collection failed while generating the platform SBOM."
        )
    endif()

    file(APPEND "${TUTORUX_STATIC_MANIFEST_FILE}"
        "\n## Tutorux and source-built dependencies\n\n"
        "- Tutorux: ${PROJECT_VERSION}, GPL-3.0-only\n"
        "- PoDoFo: ${TUTORUX_PODOFO_VERSION_PIN}\n"
        "- FFmpeg: ${TUTORUX_FFMPEG_VERSION_PIN}, LGPL-2.1-only, upstream commit ${TUTORUX_FFMPEG_COMMIT_PIN}, security patch SHA-256 ${TUTORUX_FFMPEG_PATCH_SHA256}\n"
        "- Slint: ${TUTORUX_SLINT_VERSION_PIN}, GPLv3 route\n"
        "- whisper.cpp: ${TUTORUX_WHISPER_VERSION_PIN}\n"
        "- llama.cpp: ${TUTORUX_LLAMA_VERSION_PIN}, enabled=${TUTORUX_ENABLE_LLAMA}\n"
        "- Operating-system interfaces/frameworks remain external: ${TUTORUX_STATIC_LICENSE_PLATFORM}\n"
    )
    install(FILES "${TUTORUX_STATIC_MANIFEST_FILE}"
        DESTINATION licenses COMPONENT Runtime
    )
    install(DIRECTORY "${TUTORUX_STATIC_LICENSE_OUTPUT_DIRECTORY}/licenses/"
        DESTINATION licenses/static-dependencies COMPONENT Runtime
    )
    string(CONCAT TUTORUX_STATIC_LICENSE_INSTALL_GUARD
        "if(NOT EXISTS \"${TUTORUX_STATIC_LICENSE_STATUS_FILE}\")\n"
        "    message(FATAL_ERROR \"Static dependency license status is missing; Runtime packaging is blocked.\")\n"
        "endif()\n"
        "file(READ \"${TUTORUX_STATIC_LICENSE_STATUS_FILE}\" _tutorux_license_status)\n"
        "if(NOT _tutorux_license_status MATCHES \"^COMPLETE\")\n"
        "    message(FATAL_ERROR \"Static dependency license collection is incomplete; see ${TUTORUX_STATIC_MANIFEST_FILE}. Runtime packaging is blocked.\")\n"
        "endif()\n"
    )
    install(CODE "${TUTORUX_STATIC_LICENSE_INSTALL_GUARD}" COMPONENT Runtime)
endif()

if(TARGET tutorux AND WIN32 AND MINGW)
    if(TUTORUX_RELEASE_ARCH STREQUAL "arm64")
        set(TUTORUX_ARM64_LICENSE_ROOT "${TUTORUX_SODIUM_PREFIX}/share/licenses")
        if(NOT IS_DIRECTORY "${TUTORUX_ARM64_LICENSE_ROOT}")
            message(FATAL_ERROR
                "Windows ARM64 Runtime packaging requires the target package license tree at "
                "${TUTORUX_ARM64_LICENSE_ROOT}."
            )
        endif()
        find_program(TUTORUX_ARM64_PACMAN_EXECUTABLE pacman REQUIRED)
        execute_process(
            COMMAND "${TUTORUX_ARM64_PACMAN_EXECUTABLE}" -Q
            RESULT_VARIABLE TUTORUX_ARM64_PACKAGE_INVENTORY_RESULT
            OUTPUT_VARIABLE TUTORUX_ARM64_PACKAGE_INVENTORY
            ERROR_VARIABLE TUTORUX_ARM64_PACKAGE_INVENTORY_ERROR
        )
        if(NOT TUTORUX_ARM64_PACKAGE_INVENTORY_RESULT EQUAL 0)
            message(FATAL_ERROR
                "Windows ARM64 SBOM collection failed: ${TUTORUX_ARM64_PACKAGE_INVENTORY_ERROR}"
            )
        endif()
        set(TUTORUX_ARM64_SBOM_FILE
            "${CMAKE_CURRENT_BINARY_DIR}/WINDOWS-ARM64-SBOM.md"
        )
        file(WRITE "${TUTORUX_ARM64_SBOM_FILE}"
            "# Tutorux Windows ARM64 Static Dependency Manifest\n\n"
            "Architecture: ${CMAKE_SYSTEM_PROCESSOR}\n"
            "Compiler: ${CMAKE_CXX_COMPILER_ID} ${CMAKE_CXX_COMPILER_VERSION}\n"
            "Toolchain: MSYS2 CLANGARM64 / LLVM-MinGW GNU ABI\n"
            "Rust target: aarch64-pc-windows-gnullvm\n"
            "License source: complete CLANGARM64 prefix license tree\n\n"
            "## Installed MSYS2 package versions\n\n"
            "```text\n${TUTORUX_ARM64_PACKAGE_INVENTORY}```\n"
            "The Runtime install copies the package license tree. Release qualification also checks "
            "that the executable is a PE ARM64 image and that the copied notices are present.\n"
        )
        install(FILES "${TUTORUX_ARM64_SBOM_FILE}"
            DESTINATION . COMPONENT Runtime
        )
        install(DIRECTORY "${TUTORUX_ARM64_LICENSE_ROOT}/"
            DESTINATION licenses/third-party COMPONENT Runtime
        )
    else()
        install(FILES docs/dependencies/WINDOWS-X64-SBOM.md
            DESTINATION . COMPONENT Runtime
        )
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
            if(IS_DIRECTORY "${TUTORUX_LICENSE_SOURCE}")
                file(GLOB_RECURSE TUTORUX_LICENSE_FILES
                    LIST_DIRECTORIES false
                    "${TUTORUX_LICENSE_SOURCE}/*"
                )
                if(NOT TUTORUX_LICENSE_FILES)
                    message(FATAL_ERROR
                        "Windows x64 Runtime packaging requires non-empty third-party license "
                        "notices under ${TUTORUX_LICENSE_SOURCE}."
                    )
                endif()
                install(DIRECTORY "${TUTORUX_LICENSE_SOURCE}/"
                    DESTINATION "licenses/${TUTORUX_LICENSE_NAME}" COMPONENT Runtime
                )
            else()
                message(FATAL_ERROR
                    "Windows x64 Runtime packaging requires the ${TUTORUX_LICENSE_NAME} "
                    "third-party license directory at ${TUTORUX_LICENSE_SOURCE}."
                )
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
elseif(TARGET tutorux AND APPLE AND TUTORUX_BUILD_GUI)
    install(TARGETS tutorux BUNDLE DESTINATION . COMPONENT Runtime)
elseif(TARGET tutorux AND UNIX AND NOT APPLE AND TUTORUX_BUILD_GUI)
    install(TARGETS tutorux RUNTIME DESTINATION bin COMPONENT Runtime)
elseif(TARGET tutorux)
    install(TARGETS tutorux RUNTIME DESTINATION . COMPONENT Runtime)
endif()

if(TARGET tutorux)
    install(FILES
        "${CMAKE_CURRENT_SOURCE_DIR}/docs/tutorial/quick-guide.mp4"
        "${CMAKE_CURRENT_SOURCE_DIR}/docs/tutorial/README.md"
        DESTINATION docs/tutorial COMPONENT Runtime
    )
endif()

if(TARGET tutorux AND TUTORUX_BUILD_GUI AND UNIX AND NOT APPLE)
    install(FILES "${CMAKE_CURRENT_SOURCE_DIR}/resources/tutorux.desktop"
        DESTINATION share/applications COMPONENT Runtime
    )
    install(FILES "${CMAKE_CURRENT_SOURCE_DIR}/web/assets/tutorux.svg"
        DESTINATION share/icons/hicolor/scalable/apps COMPONENT Runtime
    )
    foreach(TUTORUX_ICON_SIZE IN ITEMS 32 192 512)
        install(FILES "${CMAKE_CURRENT_SOURCE_DIR}/web/assets/tutorux-${TUTORUX_ICON_SIZE}.png"
            DESTINATION "share/icons/hicolor/${TUTORUX_ICON_SIZE}x${TUTORUX_ICON_SIZE}/apps"
            RENAME tutorux.png COMPONENT Runtime
        )
    endforeach()
endif()

if(TARGET tutorux)
    install(FILES "${CMAKE_CURRENT_SOURCE_DIR}/LICENSE"
        DESTINATION licenses/Tutorux COMPONENT Runtime
    )
endif()
if(TUTORUX_BUILD_WASM)
    find_file(TUTORUX_WASM_SODIUM_LICENSE_FILE
        NAMES LICENSE COPYING LICENSE.txt COPYING.txt
        PATHS
            "${TUTORUX_SODIUM_PREFIX}/share/licenses/libsodium"
            "${TUTORUX_SODIUM_PREFIX}/share/licenses/sodium"
            "${TUTORUX_SODIUM_PREFIX}/share/doc/libsodium"
            "${TUTORUX_SODIUM_PREFIX}/share/licenses"
            "${TUTORUX_SODIUM_PREFIX}"
        NO_DEFAULT_PATH
    )
    if(NOT TUTORUX_WASM_SODIUM_LICENSE_FILE)
        message(FATAL_ERROR
            "The WebRuntime package requires the upstream libsodium license notice under "
            "TUTORUX_SODIUM_PREFIX."
        )
    endif()
    file(SHA256 "${TUTORUX_SODIUM_LINK_LIBRARY}" TUTORUX_WASM_SODIUM_ARCHIVE_SHA256)
    file(SHA256 "${TUTORUX_WASM_SODIUM_LICENSE_FILE}" TUTORUX_WASM_SODIUM_LICENSE_SHA256)
    set(TUTORUX_WASM_SBOM_FILE "${CMAKE_CURRENT_BINARY_DIR}/TUTORUX-WASM-SBOM.md")
    file(WRITE "${TUTORUX_WASM_SBOM_FILE}"
        "# Tutorux WebAssembly Static Dependency Manifest\n\n"
        "- Product: Tutorux ${PROJECT_VERSION}, GPL-3.0-only\n"
        "- Target: wasm32-unknown-emscripten\n"
        "- Compiler: ${CMAKE_CXX_COMPILER_ID} ${CMAKE_CXX_COMPILER_VERSION}\n"
        "- libsodium: ${TUTORUX_SODIUM_VERSION_PIN}, source commit "
        "${TUTORUX_SODIUM_SOURCE_COMMIT}\n"
        "- libsodium archive SHA-256: ${TUTORUX_WASM_SODIUM_ARCHIVE_SHA256}\n"
        "- libsodium license SHA-256: ${TUTORUX_WASM_SODIUM_LICENSE_SHA256}\n"
        "- zlib source commit: ${TUTORUX_ZLIB_COMMIT_PIN}\n"
        "- libpng source commit: ${TUTORUX_LIBPNG_COMMIT_PIN}\n"
        "- GIFLIB source commit: ${TUTORUX_GIFLIB_COMMIT_PIN}\n"
        "- libwebp source commit: ${TUTORUX_LIBWEBP_COMMIT_PIN}\n\n"
        "## Bundled license notices\n\n"
        "- libsodium: `licenses/libsodium/LICENSE`\n"
        "- zlib: `licenses/zlib/LICENSE`\n"
        "- libpng: `licenses/libpng/LICENSE.md`\n"
        "- GIFLIB: `licenses/GIFLIB/COPYING`\n"
        "- libwebp: `licenses/libwebp/COPYING` and `licenses/libwebp/PATENTS`\n"
        "- Tutorux: `licenses/Tutorux/LICENSE`\n"
    )
    install(FILES "${TUTORUX_WASM_SODIUM_LICENSE_FILE}"
        DESTINATION licenses/libsodium COMPONENT WebRuntime
        RENAME LICENSE
    )
    install(FILES "${TUTORUX_WASM_SBOM_FILE}"
        DESTINATION . COMPONENT WebRuntime
    )
    install(FILES "${CMAKE_CURRENT_SOURCE_DIR}/LICENSE"
        DESTINATION licenses/Tutorux COMPONENT WebRuntime
    )
endif()

if(BUILD_TESTING AND NOT TUTORUX_BUILD_WASM)
    add_executable(tutorux_evidence_extraction_test tests/evidence_extraction_test.cpp)
    target_link_libraries(tutorux_evidence_extraction_test PRIVATE tutorux_core)
    add_test(NAME transcript_evidence_candidate_classification COMMAND tutorux_evidence_extraction_test)

    add_executable(tutorux_evidence_workflow_test tests/evidence_workflow_test.cpp)
    target_link_libraries(tutorux_evidence_workflow_test PRIVATE tutorux_core)
    add_test(NAME transcript_evidence_revision_workflow COMMAND tutorux_evidence_workflow_test)

    add_executable(tutorux_json_test tests/json_test.cpp)
    target_link_libraries(tutorux_json_test PRIVATE tutorux_core)
    add_test(NAME json_strict_parsing COMMAND tutorux_json_test)

    add_executable(tutorux_ai_import_test tests/ai_import_test.cpp)
    target_link_libraries(tutorux_ai_import_test PRIVATE tutorux_core)
    add_test(NAME structured_ai_response_import COMMAND tutorux_ai_import_test)

    add_executable(tutorux_student_progress_test tests/student_progress_test.cpp)
    target_link_libraries(tutorux_student_progress_test PRIVATE tutorux_core)
    add_test(NAME student_progress_requires_human_reviewed_evidence
        COMMAND tutorux_student_progress_test
    )

    add_executable(tutorux_asset_import_test tests/asset_import_test.cpp)
    target_link_libraries(tutorux_asset_import_test PRIVATE tutorux_core)
    add_test(NAME streaming_asset_import_and_content_deduplication COMMAND tutorux_asset_import_test)

    if(TUTORUX_ENABLE_NETWORK)
        add_executable(tutorux_http_transport_test tests/http_transport_test.cpp)
        target_link_libraries(tutorux_http_transport_test PRIVATE tutorux_core)
        if(WIN32)
            # The test hosts throwaway loopback servers with the Winsock API directly.
            target_link_libraries(tutorux_http_transport_test PRIVATE ws2_32)
        endif()
        add_test(NAME bounded_https_transport COMMAND tutorux_http_transport_test)
    endif()

    add_executable(tutorux_archive_reopen_test tests/archive_reopen_test.cpp)
    target_link_libraries(tutorux_archive_reopen_test PRIVATE tutorux_core)
    add_test(NAME archive_integrity_discovery_and_compaction COMMAND tutorux_archive_reopen_test)

    add_executable(tutorux_archive_locking_test tests/archive_locking_test.cpp)
    target_link_libraries(tutorux_archive_locking_test PRIVATE tutorux_core)
    add_test(NAME archive_transient_cross_process_locking COMMAND tutorux_archive_locking_test)

    add_executable(tutorux_session_transfer_test tests/session_transfer_test.cpp)
    target_link_libraries(tutorux_session_transfer_test PRIVATE tutorux_core)
    add_test(NAME wav_session_transfer COMMAND tutorux_session_transfer_test)

    add_executable(tutorux_audio_timeline_test tests/audio_timeline_test.cpp)
    target_link_libraries(tutorux_audio_timeline_test PRIVATE tutorux_core)
    add_test(NAME audio_timeline_waveform_and_wav_export COMMAND tutorux_audio_timeline_test)

    add_executable(tutorux_audio_multitrack_failure_test tests/audio_multitrack_failure_test.cpp)
    target_link_libraries(tutorux_audio_multitrack_failure_test PRIVATE tutorux_core)
    add_test(NAME audio_multitrack_failure_interval_persistence COMMAND tutorux_audio_multitrack_failure_test)

    add_executable(tutorux_document_editor_test tests/document_editor_test.cpp)
    target_link_libraries(tutorux_document_editor_test PRIVATE tutorux_core)
    add_test(NAME document_editor_typing_and_deletion_coalescing COMMAND tutorux_document_editor_test)

    add_executable(tutorux_archive_encryption_test tests/archive_encryption_test.cpp)
    target_link_libraries(tutorux_archive_encryption_test PRIVATE tutorux_core)
    add_test(NAME archive_encryption_and_passphrase_rotation COMMAND tutorux_archive_encryption_test)

    add_executable(tutorux_credential_storage_test tests/credential_storage_test.cpp)
    target_link_libraries(tutorux_credential_storage_test PRIVATE tutorux_core)
    add_test(NAME encrypted_credential_storage_policy COMMAND tutorux_credential_storage_test)

    add_executable(tutorux_session_configuration_test tests/session_configuration_test.cpp)
    target_link_libraries(tutorux_session_configuration_test PRIVATE tutorux_core)
    add_test(NAME journal_session_configuration COMMAND tutorux_session_configuration_test)

    if(TUTORUX_ENABLE_PDF)
        add_executable(tutorux_pdf_export_test tests/pdf_export_test.cpp)
        target_link_libraries(tutorux_pdf_export_test PRIVATE tutorux_core podofo::podofo)
        if(TUTORUX_FETCH_PODOFO)
            target_include_directories(tutorux_pdf_export_test PRIVATE ${TUTORUX_PODOFO_INCLUDE_DIRS})
        endif()
        add_test(NAME guide_pdf_export_and_unicode_pagination COMMAND tutorux_pdf_export_test)
    endif()

    add_executable(tutorux_release_acceptance_test tests/release_acceptance_test.cpp)
    target_link_libraries(tutorux_release_acceptance_test PRIVATE tutorux_core)
    add_test(NAME release_acceptance_cli_contracts COMMAND tutorux_release_acceptance_test)

    add_executable(tutorux_cli_matrix_test tests/cli_matrix_test.cpp)
    target_link_libraries(tutorux_cli_matrix_test PRIVATE tutorux_core)
    add_test(NAME cli_command_family_matrix COMMAND tutorux_cli_matrix_test)

    add_executable(tutorux_core_units_test tests/core_units_test.cpp)
    target_link_libraries(tutorux_core_units_test PRIVATE tutorux_core)
    add_test(NAME pure_core_units COMMAND tutorux_core_units_test)

    add_executable(tutorux_pipeline_units_test tests/pipeline_units_test.cpp)
    target_link_libraries(tutorux_pipeline_units_test PRIVATE tutorux_core)
    add_test(NAME intelligence_pipeline_units COMMAND tutorux_pipeline_units_test)

    add_executable(tutorux_editor_units_test tests/editor_units_test.cpp)
    target_link_libraries(tutorux_editor_units_test PRIVATE tutorux_core)
    add_test(NAME document_editor_units COMMAND tutorux_editor_units_test)

    if(TUTORUX_ENABLE_NETWORK)
        add_executable(tutorux_native_protocol_test tests/native_protocol_test.cpp)
        target_link_libraries(tutorux_native_protocol_test PRIVATE tutorux_core)
        if(WIN32)
            target_link_libraries(tutorux_native_protocol_test PRIVATE ws2_32)
        endif()
        add_test(NAME native_provider_protocols COMMAND tutorux_native_protocol_test)
    endif()

    add_executable(tutorux_sanitized_copy_test tests/sanitized_copy_test.cpp)
    target_link_libraries(tutorux_sanitized_copy_test PRIVATE tutorux_core)
    add_test(NAME sanitized_copy_selection_and_isolation COMMAND tutorux_sanitized_copy_test)

    add_executable(tutorux_recording_control_test tests/recording_control_test.cpp)
    target_link_libraries(tutorux_recording_control_test PRIVATE tutorux_core)
    add_test(NAME recording_control_ipc_lifecycle COMMAND tutorux_recording_control_test)

    add_executable(tutorux_docx_export_test tests/docx_export_test.cpp)
    target_link_libraries(tutorux_docx_export_test PRIVATE tutorux_core)
    add_test(NAME guide_docx_export_blocks COMMAND tutorux_docx_export_test)

    add_executable(tutorux_audio_devices_test tests/audio_devices_test.cpp)
    target_link_libraries(tutorux_audio_devices_test PRIVATE tutorux_core)
    add_test(NAME audio_devices_and_failure_paths COMMAND tutorux_audio_devices_test)

    if(TUTORUX_BUILD_GUI AND TARGET Slint::Slint)
        if(TUTORUX_SLINT_TESTING)
            add_executable(tutorux_ui_layout_test
                tests/ui/layout_test.cpp
            )
            target_include_directories(tutorux_ui_layout_test PRIVATE
                "${CMAKE_CURRENT_BINARY_DIR}"
                "${TUTORUX_SLINT_SOURCE_DIR}/api/cpp/include"
            )
            target_link_libraries(tutorux_ui_layout_test PRIVATE
                tutorux_slint_ui Slint::Slint
            )
            add_test(NAME ui_layout_matrix COMMAND tutorux_ui_layout_test)
        endif()

        add_executable(tutorux_ui_screenshot
            tests/ui/screenshot_tool.cpp
        )
        target_include_directories(tutorux_ui_screenshot PRIVATE
            "${CMAKE_CURRENT_BINARY_DIR}"
            "${TUTORUX_SLINT_SOURCE_DIR}/api/cpp/include"
        )
        target_link_libraries(tutorux_ui_screenshot PRIVATE
            tutorux_slint_ui Slint::Slint
        )
    endif()

    add_executable(tutorux_task_executor_test tests/performance/task_executor_test.cpp)
    target_link_libraries(tutorux_task_executor_test PRIVATE tutorux_core)
    add_test(NAME bounded_task_executor COMMAND tutorux_task_executor_test)

    add_executable(tutorux_workspace_snapshot_test tests/workspace_snapshot_test.cpp)
    target_link_libraries(tutorux_workspace_snapshot_test PRIVATE tutorux_core)
    add_test(NAME typed_workspace_overview COMMAND tutorux_workspace_snapshot_test)

    add_executable(tutorux_journal_service_test tests/journal_service_test.cpp)
    target_link_libraries(tutorux_journal_service_test PRIVATE tutorux_core)
    add_test(NAME typed_journal_note_block_update COMMAND tutorux_journal_service_test)

    add_executable(tutorux_trash_service_test tests/trash_service_test.cpp)
    target_link_libraries(tutorux_trash_service_test PRIVATE tutorux_core)
    add_test(NAME recoverable_trash_group_restore_and_safe_purge COMMAND tutorux_trash_service_test)
endif()
