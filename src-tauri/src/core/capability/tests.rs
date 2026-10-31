use super::*;

fn issue_text(issues: &[RegistryIssue]) -> String {
    issues
        .iter()
        .map(|issue| {
            format!(
                "{} {:?}: {}",
                issue.capability_id, issue.kind, issue.detail
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[test]
fn registry_is_valid() {
    let issues = validate();
    assert!(issues.is_empty(), "registry issues:\n{}", issue_text(&issues));
}

#[test]
fn capability_ids_are_unique() {
    let mut ids = std::collections::BTreeMap::<&str, usize>::new();
    for capability in CAPABILITIES {
        *ids.entry(capability.id).or_insert(0) += 1;
    }
    let duplicates: Vec<&str> = ids
        .into_iter()
        .filter(|(_, count)| *count > 1)
        .map(|(id, _)| id)
        .collect();
    assert!(duplicates.is_empty(), "duplicate ids: {duplicates:?}");
}

#[test]
fn canonical_cli_mappings_are_unique() {
    let mut mappings = std::collections::BTreeMap::<String, &str>::new();
    let duplicates: Vec<String> = CAPABILITIES
        .iter()
        .filter_map(|capability| {
            let key = capability.cli.join(" ");
            mappings
                .insert(key.clone(), capability.id)
                .map(|previous| format!("{key} ({previous} and {})", capability.id))
        })
        .collect();
    assert!(duplicates.is_empty(), "duplicate CLI mappings: {duplicates:?}");
}

#[test]
fn every_known_cli_group_has_a_capability() {
    for group in KNOWN_CLI_GROUPS {
        assert!(
            CAPABILITIES
                .iter()
                .any(|capability| capability.cli.first() == Some(group)),
            "CLI group `{group}` has no capability"
        );
    }
}

#[test]
fn required_legacy_aliases_are_registered() {
    let archive_open = find("archive.open").expect("archive open");
    assert_eq!(archive_open.cli, &["archive", "open"]);

    let asset_add = find("asset.add").expect("asset add");
    assert!(asset_add.cli_aliases.contains(&"asset import"));

    let transcribe = find("transcript.transcribe").expect("transcript transcribe");
    assert!(transcribe.cli_aliases.contains(&"transcript generate"));
    assert!(find("transcript.refine").is_some());

    for action in ["create", "update", "list", "search", "show", "delete", "restore"] {
        let capability = find(&format!("journal.{action}"))
            .unwrap_or_else(|| panic!("journal {action}"));
        let alias = format!("journal entry {action}");
        assert!(
            capability.cli_aliases.contains(&alias.as_str()),
            "missing alias `{alias}`"
        );
    }
}

#[test]
fn every_capability_declares_ports_and_an_integration_test() {
    for capability in CAPABILITIES {
        assert!(!capability.ports.is_empty(), "{} has no ports", capability.id);
        assert!(
            capability.integration_test.contains("::")
                || capability.integration_test.contains('#'),
            "{} has no integration test",
            capability.id
        );
    }
}

#[test]
fn counts_by_family_cover_the_registry() {
    let counts = counts_by_family();
    let total: usize = counts.iter().map(|(_, count)| count).sum();
    assert_eq!(total, CAPABILITIES.len());
    assert!(counts.iter().any(|(family, _)| *family == Family::Archive));
    assert!(counts.iter().any(|(family, _)| *family == Family::Record));
}

#[test]
fn port_index_finds_archive_capabilities() {
    let archive = capabilities_for_port(Port::Archive);
    assert!(archive.len() > 20);
    assert!(archive.iter().any(|capability| capability.id == "archive.verify"));
}

#[test]
fn validation_rejects_missing_and_duplicate_mappings() {
    let broken = [
        Capability {
            id: "broken.missing",
            family: Family::Archive,
            cli: &[],
            cli_aliases: &[],
            desktop: "",
            ports: &[],
            integration_test: "",
        },
        Capability {
            id: "broken.missing",
            family: Family::Archive,
            cli: &["archive", "info"],
            cli_aliases: &[],
            desktop: "console:archive info",
            ports: &[Port::Archive],
            integration_test: "tests/x.test.ts::suite",
        },
    ];
    let issues = validate_capabilities(&broken);
    for kind in [
        RegistryIssueKind::MissingCliMapping,
        RegistryIssueKind::MissingDesktopMapping,
        RegistryIssueKind::MissingIntegrationTest,
        RegistryIssueKind::MissingPorts,
        RegistryIssueKind::DuplicateId,
    ] {
        assert!(
            issues.iter().any(|issue| issue.kind == kind),
            "expected issue {kind:?}: {}",
            issue_text(&issues)
        );
    }
    }
