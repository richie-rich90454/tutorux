use super::super::*;

pub(crate) fn run_evidence_edges(
    snapshot: &ArchiveSnapshot,
    args: &ParsedArguments,
    output: &mut dyn CliOutput,
) -> CliResult<i32> {
    let session = args.required_option("session")?.to_lowercase();
    require_live(snapshot, RecordType::SESSION, &session)?;
    let nodes = snapshot.list_records(RecordType::EVIDENCE_NODE, false)?;
    let node_by_id: BTreeMap<String, &ArchiveRecord> = nodes
        .iter()
        .filter(|record| record.field("session_id") == Some(session.as_str()))
        .map(|record| (record.id.clone(), record))
        .collect();
    let edge_records = snapshot.list_records(RecordType::EVIDENCE_EDGE, false)?;
    let edges: Vec<&ArchiveRecord> = edge_records
        .iter()
        .filter(|record| {
            node_by_id.contains_key(record.field("from_id").unwrap_or(""))
                && node_by_id.contains_key(record.field("to_id").unwrap_or(""))
        })
        .collect();
    let title = |node: Option<&&ArchiveRecord>| {
        node.and_then(|record| {
            record
                .field("title")
                .filter(|value| !value.is_empty())
                .or_else(|| record.field("type").filter(|value| !value.is_empty()))
        })
        .unwrap_or("Evidence")
        .to_owned()
    };
    let rows: Vec<Value> = edges
        .iter()
        .map(|edge| {
            let mut value = plain(edge);
            if let Value::Object(map) = &mut value {
                map.insert(
                    "from_title".to_owned(),
                    Value::String(title(node_by_id.get(edge.field("from_id").unwrap_or("")))),
                );
                map.insert(
                    "to_title".to_owned(),
                    Value::String(title(node_by_id.get(edge.field("to_id").unwrap_or("")))),
                );
            }
            value
        })
        .collect();
    emit(
        output,
        Value::Array(rows),
        &format!("{} evidence relationship(s).", edges.len()),
        args.json(),
    );
    Ok(0)
}

pub(crate) fn run_evidence_graph(
    snapshot: &ArchiveSnapshot,
    args: &ParsedArguments,
    output: &mut dyn CliOutput,
) -> CliResult<i32> {
    let session = args.required_option("session")?.to_lowercase();
    require_live(snapshot, RecordType::SESSION, &session)?;
    let nodes: Vec<ArchiveRecord> = snapshot
        .list_records(RecordType::EVIDENCE_NODE, false)?
        .into_iter()
        .filter(|record| {
            record.field("session_id").map(str::to_lowercase).as_deref() == Some(session.as_str())
        })
        .collect();
    for node in &nodes {
        if node.field("content").unwrap_or("").is_empty() {
            return Err(CliError(format!("Evidence {} needs a statement.", node.id)).into());
        }
    }
    let node_ids: BTreeSet<String> = nodes
        .iter()
        .map(|record| record.id.to_lowercase())
        .collect();
    let mut edge_count = 0usize;
    let mut contradictions: BTreeMap<String, Value> = BTreeMap::new();
    for edge in snapshot.list_records(RecordType::EVIDENCE_EDGE, false)? {
        let from = edge.field("from_id").unwrap_or("").to_lowercase();
        let to = edge.field("to_id").unwrap_or("").to_lowercase();
        let from_here = node_ids.contains(&from);
        let to_here = node_ids.contains(&to);
        if !from_here && !to_here {
            continue;
        }
        if !from_here || !to_here {
            return Err(CliError(
                "An evidence relationship connects a session node to a missing or cross-session node."
                    .to_owned(),
            )
            .into());
        }
        let relationship = edge.field("relationship").unwrap_or("");
        if from == to || !EVIDENCE_RELATIONSHIPS.contains(&relationship) {
            return Err(CliError(format!(
                "Evidence relationship {} has invalid endpoints or type.",
                edge.id
            ))
            .into());
        }
        edge_count += 1;
        if relationship == "contradicts" {
            let (first, second) = if from <= to { (from, to) } else { (to, from) };
            contradictions.insert(
                format!("{first}:{second}"),
                json!({"first_evidence_id": first, "second_evidence_id": second}),
            );
        }
    }
    let pairs: Vec<Value> = contradictions.into_values().collect();
    let details = pairs
        .iter()
        .map(|pair| {
            format!(
                "  {} contradicts {}",
                pair["first_evidence_id"].as_str().unwrap_or(""),
                pair["second_evidence_id"].as_str().unwrap_or("")
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    emit(
        output,
        json!({
            "session_id": session,
            "node_count": nodes.len(),
            "edge_count": edge_count,
            "contradiction_count": pairs.len(),
            "contradictions": pairs,
            "valid": true,
        }),
        &format!(
            "Evidence graph: {} node(s), {edge_count} relationship(s), {} explicit contradiction(s).{}",
            nodes.len(),
            pairs.len(),
            if details.is_empty() { String::new() } else { format!("\n{details}") }
        ),
        args.json(),
    );
    Ok(0)
}
