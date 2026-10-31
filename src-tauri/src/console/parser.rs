pub(super) const MAX_COMMAND_BYTES: usize = 64 * 1024;

pub(super) fn parse_command_line(input: &str) -> Result<Vec<String>, String> {
    let mut arguments = Vec::new();
    let mut token = String::new();
    let mut quote = None;
    let mut escaped = false;
    let mut token_started = false;

    for character in input.chars() {
        if escaped {
            if quote == Some('"') && character != '"' && character != '\\' {
                token.push('\\');
            }
            token.push(character);
            escaped = false;
            continue;
        }
        if let Some(open_quote) = quote {
            if character == '\\' && open_quote == '"' {
                escaped = true;
            } else if character == open_quote {
                quote = None;
            } else {
                token.push(character);
            }
            token_started = true;
            continue;
        }
        if character == '"' || character == '\'' {
            quote = Some(character);
            token_started = true;
        } else if character.is_ascii_whitespace() {
            finish_token(&mut arguments, &mut token, &mut token_started);
        } else {
            token.push(character);
            token_started = true;
        }
    }

    if escaped {
        token.push('\\');
    }
    if quote.is_some() {
        return Err("Close the quoted command argument before running it.".to_owned());
    }
    finish_token(&mut arguments, &mut token, &mut token_started);
    if arguments
        .first()
        .is_some_and(|argument| argument == "tutorux")
    {
        arguments.remove(0);
    }
    if arguments.is_empty() {
        return Err("Enter a Tutorux command to run.".to_owned());
    }
    if arguments.iter().any(|argument| {
        argument == "--archive"
            || argument.starts_with("--archive=")
            || argument == "--directory"
            || argument.starts_with("--directory=")
    }) {
        return Err(
            "The command console always uses the selected archive and directory.".to_owned(),
        );
    }
    if arguments.iter().any(|argument| argument.contains('\0')) {
        return Err("A command argument contains an unsupported null character.".to_owned());
    }
    Ok(arguments)
}

fn finish_token(arguments: &mut Vec<String>, token: &mut String, token_started: &mut bool) {
    if !*token_started {
        return;
    }
    arguments.push(std::mem::take(token));
    *token_started = false;
}

pub(super) fn reject_foreground_recording(arguments: &[String]) -> Result<(), String> {
    let command_index = global_prefix_len(arguments);
    if arguments
        .get(command_index)
        .is_some_and(|argument| argument == "record")
        && arguments
            .get(command_index + 1)
            .is_some_and(|argument| argument == "start")
        && !arguments.iter().any(|argument| argument == "--detach")
    {
        return Err("Run foreground recording from the CLI, or add --detach so the recording worker remains controllable outside this window.".to_owned());
    }
    Ok(())
}

fn global_prefix_len(arguments: &[String]) -> usize {
    let mut index = 0;
    while let Some(argument) = arguments.get(index) {
        match argument.as_str() {
            "--json" | "--quiet" | "--verbose" | "--no-color" => index += 1,
            "--passphrase-env" | "--new-passphrase-env" => index += 2,
            value
                if value.starts_with("--passphrase-env=")
                    || value.starts_with("--new-passphrase-env=") =>
            {
                index += 1;
            }
            _ => break,
        }
    }
    index
}

pub(super) fn is_archive_discovery(arguments: &[String]) -> bool {
    let index = global_prefix_len(arguments);
    arguments.get(index).map(String::as_str) == Some("archive")
        && matches!(
            arguments.get(index + 1).map(String::as_str),
            Some("discover" | "list")
        )
}

pub(super) fn has_passphrase_env_option(arguments: &[String], option: &str) -> bool {
    arguments
        .iter()
        .any(|argument| argument == option || argument.starts_with(&format!("{option}=")))
}

pub(super) fn replace_passphrase_env_option(
    arguments: &mut Vec<String>,
    option: &str,
    value: &str,
) -> bool {
    let mut found = false;
    let mut index = 0;
    while index < arguments.len() {
        if arguments[index] == option {
            if index + 1 < arguments.len() {
                arguments[index + 1] = value.to_owned();
            } else {
                arguments.push(value.to_owned());
            }
            found = true;
            index += 2;
        } else if arguments[index].starts_with(&format!("{option}=")) {
            arguments[index] = format!("{option}={value}");
            found = true;
            index += 1;
        } else {
            index += 1;
        }
    }
    found
}

pub(super) fn supports_new_passphrase(arguments: &[String]) -> bool {
    let index = global_prefix_len(arguments);
    arguments.get(index).map(String::as_str) == Some("archive")
        && matches!(
            arguments.get(index + 1).map(String::as_str),
            Some("init" | "encrypt" | "change-passphrase" | "sanitize")
        )
}

#[cfg(test)]
mod tests {
    use super::{
        is_archive_discovery, parse_command_line, replace_passphrase_env_option,
        supports_new_passphrase,
    };

    #[test]
    fn command_line_splits_quotes_and_strips_the_tutorux_prefix() {
        let arguments =
            parse_command_line(r#"tutorux student list --query "Ada Lovelace" --json"#).unwrap();
        assert_eq!(
            arguments,
            ["student", "list", "--query", "Ada Lovelace", "--json"]
        );
    }

    #[test]
    fn command_line_rejects_a_user_selected_archive() {
        assert!(parse_command_line("student list --archive other.tux").is_err());
        assert!(parse_command_line("archive discover --directory elsewhere").is_err());
    }

    #[test]
    fn command_line_rejects_unbalanced_quotes() {
        assert!(parse_command_line("student list --query \"Ada").is_err());
    }

    #[test]
    fn discovery_detection_skips_global_options() {
        let arguments = ["--json", "archive", "list", "--json"]
            .into_iter()
            .map(str::to_owned)
            .collect::<Vec<_>>();
        assert!(is_archive_discovery(&arguments));
        let arguments = ["student", "list"]
            .into_iter()
            .map(str::to_owned)
            .collect::<Vec<_>>();
        assert!(!is_archive_discovery(&arguments));
    }

    #[test]
    fn new_passphrase_commands_are_recognized() {
        let arguments = ["--json", "archive", "change-passphrase"]
            .into_iter()
            .map(str::to_owned)
            .collect::<Vec<_>>();
        assert!(supports_new_passphrase(&arguments));
        let arguments = ["student", "list"]
            .into_iter()
            .map(str::to_owned)
            .collect::<Vec<_>>();
        assert!(!supports_new_passphrase(&arguments));
    }

    #[test]
    fn passphrase_environment_option_is_replaced_in_place() {
        let mut arguments = [
            "archive",
            "sanitize",
            "--new-passphrase-env",
            "OLD",
            "out.tux",
        ]
        .into_iter()
        .map(str::to_owned)
        .collect::<Vec<_>>();
        assert!(replace_passphrase_env_option(
            &mut arguments,
            "--new-passphrase-env",
            "CONSOLE"
        ));
        assert_eq!(arguments[3], "CONSOLE");
    }
}
