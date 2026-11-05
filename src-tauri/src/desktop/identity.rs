use std::path::Path;

#[cfg(windows)]
pub(crate) fn move_file_without_replacing(source: &Path, target: &Path) -> std::io::Result<()> {
    use std::{io, os::windows::ffi::OsStrExt};
    use windows_sys::Win32::Storage::FileSystem::MoveFileW;

    fn nul_terminated_path(path: &Path) -> io::Result<Vec<u16>> {
        let mut encoded: Vec<u16> = path.as_os_str().encode_wide().collect();
        if encoded.contains(&0) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Windows paths cannot contain a null character.",
            ));
        }
        encoded.push(0);
        Ok(encoded)
    }

    let source = nul_terminated_path(source)?;
    let target = nul_terminated_path(target)?;

    // SAFETY: both arguments are valid, NUL-terminated UTF-16 paths kept alive for the call.
    let result = unsafe { MoveFileW(source.as_ptr(), target.as_ptr()) };
    if result == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
pub(crate) fn move_file_without_replacing(source: &Path, target: &Path) -> std::io::Result<()> {
    std::fs::hard_link(source, target)
}
