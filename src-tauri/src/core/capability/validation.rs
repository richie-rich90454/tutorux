use super::registry::CAPABILITIES;
use super::types::{Capability, RegistryIssue, RegistryIssueKind, KNOWN_CLI_GROUPS};

pub fn validate() -> Vec<RegistryIssue> {
    validate_capabilities(CAPABILITIES)
}

pub fn validate_capabilities(capabilities: &[Capability]) -> Vec<RegistryIssue> {
    let mut issues = Vec::new();
    let mut seen_ids = std::collections::BTreeMap::<&str, usize>::new();
    let mut seen_cli = std::collections::BTreeMap::<String, &str>::new();
    for capability in capabilities {
        if capability.id.trim().is_empty() {
            issues.push(RegistryIssue {
                capability_id: capability.id.to_owned(),
                kind: RegistryIssueKind::MissingId,
                detail: "capability id is empty".to_owned(),
            });
        }
        *seen_ids.entry(capability.id).or_insert(0) += 1;

        if capability.cli.is_empty() || capability.cli.iter().any(|token| token.trim().is_empty()) {
            issues.push(RegistryIssue {
                capability_id: capability.id.to_owned(),
                kind: RegistryIssueKind::MissingCliMapping,
                detail: "canonical CLI path is empty".to_owned(),
            });
        } else {
            if !KNOWN_CLI_GROUPS.contains(&capability.cli[0]) {
                issues.push(RegistryIssue {
                    capability_id: capability.id.to_owned(),
                    kind: RegistryIssueKind::InvalidCliMapping,
                    detail: format!("unknown CLI group `{}`", capability.cli[0]),
                });
            }
            let key = capability.cli.join(" ");
            if let Some(previous) = seen_cli.insert(key.clone(), capability.id) {
                issues.push(RegistryIssue {
                    capability_id: capability.id.to_owned(),
                    kind: RegistryIssueKind::DuplicateCliMapping,
                    detail: format!("CLI mapping `{key}` is already used by `{previous}`"),
                });
            }
        }

        for alias in capability.cli_aliases {
            let group = alias.split_whitespace().next().unwrap_or("");
            let valid = alias.starts_with('-') || KNOWN_CLI_GROUPS.contains(&group);
            if alias.trim().is_empty() || !valid {
                issues.push(RegistryIssue {
                    capability_id: capability.id.to_owned(),
                    kind: RegistryIssueKind::InvalidCliMapping,
                    detail: format!("invalid CLI alias `{alias}`"),
                });
            }
        }

        if capability.desktop.trim().is_empty()
            || !(capability.desktop.starts_with("console:")
                || capability.desktop.starts_with("ui:"))
        {
            issues.push(RegistryIssue {
                capability_id: capability.id.to_owned(),
                kind: RegistryIssueKind::MissingDesktopMapping,
                detail: "desktop mapping must be a console: or ui: target".to_owned(),
            });
        }

        if capability.integration_test.trim().is_empty()
            || !(capability.integration_test.contains("::")
                || capability.integration_test.contains('#'))
        {
            issues.push(RegistryIssue {
                capability_id: capability.id.to_owned(),
                kind: RegistryIssueKind::MissingIntegrationTest,
                detail: "integration test must name a file and suite or corpus case".to_owned(),
            });
        }

        if capability.ports.is_empty() {
            issues.push(RegistryIssue {
                capability_id: capability.id.to_owned(),
                kind: RegistryIssueKind::MissingPorts,
                detail: "capability declares no ports".to_owned(),
            });
        }
    }

    for (id, count) in seen_ids {
        if count > 1 {
            issues.push(RegistryIssue {
                capability_id: id.to_owned(),
                kind: RegistryIssueKind::DuplicateId,
                detail: format!("capability id appears {count} times"),
            });
        }
    }

    issues
}
