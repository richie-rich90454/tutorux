use std::cell::Cell;

use super::{Cancellation, CliError, CliResult};

type ErasedCancellation = *const (dyn Cancellation + 'static);

thread_local! {
    static ACTIVE: Cell<Option<ErasedCancellation>> = const { Cell::new(None) };
}

/// Installs the active CLI cancellation for the current thread for the guard's lifetime.
pub(crate) struct Scope {
    previous: Option<ErasedCancellation>,
}

impl Scope {
    pub(crate) fn install(cancellation: &dyn Cancellation) -> Self {
        let erased: ErasedCancellation = unsafe {
            // SAFETY: `Scope` restores the previous value before `cancellation` is dropped.
            std::mem::transmute(cancellation as *const dyn Cancellation)
        };
        let previous = ACTIVE.with(|active| active.replace(Some(erased)));
        Self { previous }
    }
}

impl Drop for Scope {
    fn drop(&mut self) {
        ACTIVE.with(|active| active.set(self.previous));
    }
}

pub(crate) fn is_cancelled() -> bool {
    ACTIVE.with(|active| match active.get() {
        Some(cancellation) => unsafe {
            // SAFETY: an installed `Scope` keeps this pointer valid while it is active.
            (*cancellation).is_cancelled()
        },
        None => false,
    })
}

pub(crate) fn check(label: &str) -> CliResult<()> {
    if is_cancelled() {
        Err(CliError(format!("{label} was cancelled.")).into())
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Flag(bool);

    impl Cancellation for Flag {
        fn is_cancelled(&self) -> bool {
            self.0
        }
    }

    #[test]
    fn scope_exposes_the_active_cancellation_and_restores_it() {
        assert!(!is_cancelled());
        {
            let _scope = Scope::install(&Flag(true));
            assert!(is_cancelled());
            assert!(check("Test").is_err());
        }
        assert!(!is_cancelled());
        let _scope = Scope::install(&Flag(false));
        assert!(check("Test").is_ok());
    }

    #[test]
    fn execute_cli_reports_a_cancelled_command_as_a_usage_error() {
        struct Output;

        impl super::super::CliOutput for Output {
            fn stdout(&mut self, _message: &str) {}
            fn stderr(&mut self, _message: &str) {}
        }

        let arguments = vec!["archive".to_owned(), "info".to_owned(), "missing.tux".to_owned()];
        assert_eq!(
            super::super::execute_cli(&arguments, &mut Output, &Flag(true)),
            2
        );
        assert!(!is_cancelled());
    }
}
