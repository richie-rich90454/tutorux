use std::{collections::VecDeque, path::PathBuf, sync::Mutex};

#[derive(Default)]
pub(crate) struct DesktopState {
    pub(crate) pending_open: Mutex<VecDeque<PathBuf>>,
}
