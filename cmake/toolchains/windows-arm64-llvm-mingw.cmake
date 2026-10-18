set(CMAKE_SYSTEM_NAME Windows)
set(CMAKE_SYSTEM_PROCESSOR ARM64)

set(TUTORUX_WINDOWS_ARM64_PREFIX "$ENV{TUTORUX_WINDOWS_ARM64_PREFIX}" CACHE PATH
    "LLVM-MinGW or MSYS2 CLANGARM64 toolchain and static dependency prefix"
)
set(TUTORUX_WINDOWS_ARM64_TOOLCHAIN_KIND
    "$ENV{TUTORUX_WINDOWS_ARM64_TOOLCHAIN_KIND}" CACHE STRING
    "Windows ARM64 toolchain layout: llvm-mingw or msys2-clangarm64"
)
if(NOT TUTORUX_WINDOWS_ARM64_TOOLCHAIN_KIND)
    set(TUTORUX_WINDOWS_ARM64_TOOLCHAIN_KIND "llvm-mingw")
endif()
if(NOT TUTORUX_WINDOWS_ARM64_PREFIX)
    message(FATAL_ERROR
        "Set TUTORUX_WINDOWS_ARM64_PREFIX to an LLVM-MinGW or MSYS2 CLANGARM64 prefix "
        "containing the ARM64 compiler and target static dependency archives."
    )
endif()

set(_tutorux_arm64_bin "${TUTORUX_WINDOWS_ARM64_PREFIX}/bin")
if(TUTORUX_WINDOWS_ARM64_TOOLCHAIN_KIND STREQUAL "msys2-clangarm64")
    set(_tutorux_arm64_c_compiler "${_tutorux_arm64_bin}/clang.exe")
    set(_tutorux_arm64_cxx_compiler "${_tutorux_arm64_bin}/clang++.exe")
elseif(TUTORUX_WINDOWS_ARM64_TOOLCHAIN_KIND STREQUAL "llvm-mingw")
    set(_tutorux_arm64_c_compiler "${_tutorux_arm64_bin}/aarch64-w64-mingw32-clang.exe")
    set(_tutorux_arm64_cxx_compiler "${_tutorux_arm64_bin}/aarch64-w64-mingw32-clang++.exe")
else()
    message(FATAL_ERROR
        "TUTORUX_WINDOWS_ARM64_TOOLCHAIN_KIND must be llvm-mingw or msys2-clangarm64."
    )
endif()
set(CMAKE_C_COMPILER "${_tutorux_arm64_c_compiler}" CACHE FILEPATH "" FORCE)
set(CMAKE_CXX_COMPILER "${_tutorux_arm64_cxx_compiler}" CACHE FILEPATH "" FORCE)
set(CMAKE_AR "${_tutorux_arm64_bin}/llvm-ar.exe" CACHE FILEPATH "" FORCE)
set(CMAKE_RANLIB "${_tutorux_arm64_bin}/llvm-ranlib.exe" CACHE FILEPATH "" FORCE)
foreach(_tutorux_arm64_tool IN ITEMS
    "${_tutorux_arm64_c_compiler}"
    "${_tutorux_arm64_cxx_compiler}"
    "${CMAKE_AR}"
    "${CMAKE_RANLIB}"
)
    if(NOT EXISTS "${_tutorux_arm64_tool}")
        message(FATAL_ERROR
            "Windows ARM64 toolchain file is missing: ${_tutorux_arm64_tool}. "
            "Provision the complete target prefix before configuring this preset."
        )
    endif()
endforeach()
set(CMAKE_C_COMPILER_TARGET aarch64-w64-windows-gnu CACHE STRING "" FORCE)
set(CMAKE_CXX_COMPILER_TARGET aarch64-w64-windows-gnu CACHE STRING "" FORCE)
set(Rust_CARGO_TARGET aarch64-pc-windows-gnullvm CACHE STRING
    "Rust target triple used by Corrosion for Windows ARM64"
)

set(CMAKE_FIND_ROOT_PATH "${TUTORUX_WINDOWS_ARM64_PREFIX}")
set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)
set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_PACKAGE ONLY)

set(CMAKE_PREFIX_PATH "${TUTORUX_WINDOWS_ARM64_PREFIX}" CACHE PATH
    "Target ARM64 dependency prefix"
)
