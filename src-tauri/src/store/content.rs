use rusqlite::{params, Connection, OptionalExtension};
use uuid::Uuid;

use super::{
    models::{
        now_ms, Evidence, EvidenceGraph, EvidenceInput, EvidenceLink, EvidenceLinkInput, Goal,
        GoalInput, Guide, GuideInput, JournalEntry, JournalInput, Observation, ObservationInput,
        SkillRating, SkillRatingInput, TranscriptCue, TranscriptCueInput,
    },
    repo::{reindex_public, touch_workspace_public},
};

fn journal_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<JournalEntry> {
    Ok(JournalEntry {
        id: row.get(0)?,
        session_id: row.get(1)?,
        student_id: row.get(2)?,
        entry_date: row.get(3)?,
        title: row.get(4)?,
        body: row.get(5)?,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
    })
}

const JOURNAL_SELECT: &str = "SELECT id, session_id, student_id, entry_date, title, body,
    created_at, updated_at FROM journal_entries";

pub fn list_journal(conn: &Connection, session_id: &str) -> Result<Vec<JournalEntry>, String> {
    let mut statement = conn
        .prepare(&format!(
            "{JOURNAL_SELECT} WHERE deleted_at IS NULL AND (?1 = '' OR session_id = ?1)
             ORDER BY entry_date DESC, created_at DESC"
        ))
        .map_err(|error| format!("Could not read journal entries: {error}"))?;
    let rows = statement
        .query_map(params![session_id], journal_row)
        .map_err(|error| format!("Could not read journal entries: {error}"))?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| format!("Could not read journal entries: {error}"))
}

pub fn create_journal(conn: &Connection, input: &JournalInput) -> Result<JournalEntry, String> {
    let id = Uuid::new_v4().to_string();
    let now = now_ms();
    conn.execute(
        "INSERT INTO journal_entries (id, session_id, student_id, entry_date, title, body, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
        params![
            id,
            input.session_id,
            input.student_id,
            input.entry_date.trim(),
            input.title.trim(),
            input.body.trim(),
            now
        ],
    )
    .map_err(|error| format!("Could not create the journal entry: {error}"))?;
    reindex_public(
        conn,
        "journal",
        &id,
        input.title.trim(),
        input.body.trim(),
        input.student_id.as_deref().unwrap_or(""),
        input.session_id.as_deref().unwrap_or(""),
    )?;
    touch_workspace_public(conn)?;
    get_journal(conn, &id)
}

pub fn get_journal(conn: &Connection, id: &str) -> Result<JournalEntry, String> {
    conn.query_row(
        &format!("{JOURNAL_SELECT} WHERE id = ?1 AND deleted_at IS NULL"),
        params![id],
        journal_row,
    )
    .optional()
    .map_err(|error| format!("Could not read the journal entry: {error}"))?
    .ok_or_else(|| "The journal entry could not be found.".to_owned())
}

pub fn update_journal(
    conn: &Connection,
    id: &str,
    input: &JournalInput,
) -> Result<JournalEntry, String> {
    let changed = conn
        .execute(
            "UPDATE journal_entries SET session_id = ?2, student_id = ?3, entry_date = ?4,
             title = ?5, body = ?6, updated_at = ?7 WHERE id = ?1 AND deleted_at IS NULL",
            params![
                id,
                input.session_id,
                input.student_id,
                input.entry_date.trim(),
                input.title.trim(),
                input.body.trim(),
                now_ms()
            ],
        )
        .map_err(|error| format!("Could not update the journal entry: {error}"))?;
    if changed == 0 {
        return Err("The journal entry could not be found.".to_owned());
    }
    reindex_public(
        conn,
        "journal",
        id,
        input.title.trim(),
        input.body.trim(),
        input.student_id.as_deref().unwrap_or(""),
        input.session_id.as_deref().unwrap_or(""),
    )?;
    touch_workspace_public(conn)?;
    get_journal(conn, id)
}

pub fn delete_journal(conn: &Connection, id: &str) -> Result<(), String> {
    let changed = conn
        .execute(
            "UPDATE journal_entries SET deleted_at = ?2, updated_at = ?2
             WHERE id = ?1 AND deleted_at IS NULL",
            params![id, now_ms()],
        )
        .map_err(|error| format!("Could not move the journal entry to trash: {error}"))?;
    if changed == 0 {
        return Err("The journal entry could not be found.".to_owned());
    }
    touch_workspace_public(conn)?;
    Ok(())
}

fn observation_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Observation> {
    Ok(Observation {
        id: row.get(0)?,
        session_id: row.get(1)?,
        student_id: row.get(2)?,
        kind: row.get(3)?,
        priority: row.get(4)?,
        start_us: row.get(5)?,
        end_us: row.get(6)?,
        title: row.get(7)?,
        body: row.get(8)?,
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
    })
}

const OBSERVATION_SELECT: &str = "SELECT id, session_id, student_id, kind, priority, start_us,
    end_us, title, body, created_at, updated_at FROM observations";

pub fn list_observations(conn: &Connection, session_id: &str) -> Result<Vec<Observation>, String> {
    let mut statement = conn
        .prepare(&format!(
            "{OBSERVATION_SELECT} WHERE deleted_at IS NULL AND (?1 = '' OR session_id = ?1)
             ORDER BY start_us ASC, created_at ASC"
        ))
        .map_err(|error| format!("Could not read observations: {error}"))?;
    let rows = statement
        .query_map(params![session_id], observation_row)
        .map_err(|error| format!("Could not read observations: {error}"))?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| format!("Could not read observations: {error}"))
}

pub fn create_observation(
    conn: &Connection,
    input: &ObservationInput,
) -> Result<Observation, String> {
    let id = Uuid::new_v4().to_string();
    let now = now_ms();
    conn.execute(
        "INSERT INTO observations (id, session_id, student_id, kind, priority, start_us, end_us,
         title, body, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)",
        params![
            id,
            input.session_id,
            input.student_id,
            input.kind.trim(),
            input.priority.trim(),
            input.start_us.max(0),
            input.end_us.max(0),
            input.title.trim(),
            input.body.trim(),
            now
        ],
    )
    .map_err(|error| format!("Could not create the observation: {error}"))?;
    reindex_public(
        conn,
        "observation",
        &id,
        input.title.trim(),
        input.body.trim(),
        input.student_id.as_deref().unwrap_or(""),
        input.session_id.as_deref().unwrap_or(""),
    )?;
    touch_workspace_public(conn)?;
    get_observation(conn, &id)
}

pub fn get_observation(conn: &Connection, id: &str) -> Result<Observation, String> {
    conn.query_row(
        &format!("{OBSERVATION_SELECT} WHERE id = ?1 AND deleted_at IS NULL"),
        params![id],
        observation_row,
    )
    .optional()
    .map_err(|error| format!("Could not read the observation: {error}"))?
    .ok_or_else(|| "The observation could not be found.".to_owned())
}

pub fn update_observation(
    conn: &Connection,
    id: &str,
    input: &ObservationInput,
) -> Result<Observation, String> {
    let changed = conn
        .execute(
            "UPDATE observations SET session_id = ?2, student_id = ?3, kind = ?4, priority = ?5,
             start_us = ?6, end_us = ?7, title = ?8, body = ?9, updated_at = ?10
             WHERE id = ?1 AND deleted_at IS NULL",
            params![
                id,
                input.session_id,
                input.student_id,
                input.kind.trim(),
                input.priority.trim(),
                input.start_us.max(0),
                input.end_us.max(0),
                input.title.trim(),
                input.body.trim(),
                now_ms()
            ],
        )
        .map_err(|error| format!("Could not update the observation: {error}"))?;
    if changed == 0 {
        return Err("The observation could not be found.".to_owned());
    }
    reindex_public(
        conn,
        "observation",
        id,
        input.title.trim(),
        input.body.trim(),
        input.student_id.as_deref().unwrap_or(""),
        input.session_id.as_deref().unwrap_or(""),
    )?;
    touch_workspace_public(conn)?;
    get_observation(conn, id)
}

pub fn delete_observation(conn: &Connection, id: &str) -> Result<(), String> {
    let changed = conn
        .execute(
            "UPDATE observations SET deleted_at = ?2, updated_at = ?2
             WHERE id = ?1 AND deleted_at IS NULL",
            params![id, now_ms()],
        )
        .map_err(|error| format!("Could not move the observation to trash: {error}"))?;
    if changed == 0 {
        return Err("The observation could not be found.".to_owned());
    }
    touch_workspace_public(conn)?;
    Ok(())
}

fn cue_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<TranscriptCue> {
    Ok(TranscriptCue {
        id: row.get(0)?,
        session_id: row.get(1)?,
        start_us: row.get(2)?,
        end_us: row.get(3)?,
        speaker: row.get(4)?,
        body: row.get(5)?,
        verified: row.get::<_, i64>(6)? != 0,
        created_at: row.get(7)?,
        updated_at: row.get(8)?,
    })
}

const CUE_SELECT: &str = "SELECT id, session_id, start_us, end_us, speaker, body, verified,
    created_at, updated_at FROM transcript_cues";

pub fn list_cues(
    conn: &Connection,
    session_id: &str,
    limit: i64,
) -> Result<Vec<TranscriptCue>, String> {
    let mut statement = conn
        .prepare(&format!(
            "{CUE_SELECT} WHERE deleted_at IS NULL AND session_id = ?1
             ORDER BY start_us ASC LIMIT ?2"
        ))
        .map_err(|error| format!("Could not read transcript cues: {error}"))?;
    let rows = statement
        .query_map(params![session_id, limit.clamp(1, 5000)], cue_row)
        .map_err(|error| format!("Could not read transcript cues: {error}"))?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| format!("Could not read transcript cues: {error}"))
}

pub fn create_cue(conn: &Connection, input: &TranscriptCueInput) -> Result<TranscriptCue, String> {
    if input.session_id.trim().is_empty() {
        return Err("A transcript cue needs a session.".to_owned());
    }
    if input.end_us < input.start_us {
        return Err("A transcript cue cannot end before it starts.".to_owned());
    }
    let id = Uuid::new_v4().to_string();
    let now = now_ms();
    conn.execute(
        "INSERT INTO transcript_cues (id, session_id, start_us, end_us, speaker, body, verified, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
        params![
            id,
            input.session_id.trim(),
            input.start_us.max(0),
            input.end_us.max(0),
            input.speaker.trim(),
            input.body.trim(),
            i64::from(input.verified),
            now
        ],
    )
    .map_err(|error| format!("Could not create the transcript cue: {error}"))?;
    reindex_public(
        conn,
        "transcript",
        &id,
        input.speaker.trim(),
        input.body.trim(),
        "",
        input.session_id.trim(),
    )?;
    touch_workspace_public(conn)?;
    get_cue(conn, &id)
}

pub fn get_cue(conn: &Connection, id: &str) -> Result<TranscriptCue, String> {
    conn.query_row(
        &format!("{CUE_SELECT} WHERE id = ?1 AND deleted_at IS NULL"),
        params![id],
        cue_row,
    )
    .optional()
    .map_err(|error| format!("Could not read the transcript cue: {error}"))?
    .ok_or_else(|| "The transcript cue could not be found.".to_owned())
}

pub fn update_cue(
    conn: &Connection,
    id: &str,
    input: &TranscriptCueInput,
) -> Result<TranscriptCue, String> {
    let changed = conn
        .execute(
            "UPDATE transcript_cues SET start_us = ?2, end_us = ?3, speaker = ?4, body = ?5,
             verified = ?6, updated_at = ?7 WHERE id = ?1 AND deleted_at IS NULL",
            params![
                id,
                input.start_us.max(0),
                input.end_us.max(0),
                input.speaker.trim(),
                input.body.trim(),
                i64::from(input.verified),
                now_ms()
            ],
        )
        .map_err(|error| format!("Could not update the transcript cue: {error}"))?;
    if changed == 0 {
        return Err("The transcript cue could not be found.".to_owned());
    }
    reindex_public(
        conn,
        "transcript",
        id,
        input.speaker.trim(),
        input.body.trim(),
        "",
        input.session_id.trim(),
    )?;
    touch_workspace_public(conn)?;
    get_cue(conn, id)
}

pub fn delete_cue(conn: &Connection, id: &str) -> Result<(), String> {
    let changed = conn
        .execute(
            "UPDATE transcript_cues SET deleted_at = ?2, updated_at = ?2
             WHERE id = ?1 AND deleted_at IS NULL",
            params![id, now_ms()],
        )
        .map_err(|error| format!("Could not delete the transcript cue: {error}"))?;
    if changed == 0 {
        return Err("The transcript cue could not be found.".to_owned());
    }
    touch_workspace_public(conn)?;
    Ok(())
}

fn guide_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Guide> {
    let source_ids: String = row.get(6)?;
    Ok(Guide {
        id: row.get(0)?,
        student_id: row.get(1)?,
        session_id: row.get(2)?,
        title: row.get(3)?,
        status: row.get(4)?,
        body: row.get(5)?,
        source_ids: serde_json::from_str(&source_ids).unwrap_or_default(),
        created_at: row.get(7)?,
        updated_at: row.get(8)?,
    })
}

const GUIDE_SELECT: &str = "SELECT id, student_id, session_id, title, status, body, source_ids,
    created_at, updated_at FROM guides";

pub fn list_guides(
    conn: &Connection,
    student_id: &str,
    session_id: &str,
) -> Result<Vec<Guide>, String> {
    let mut statement = conn
        .prepare(&format!(
            "{GUIDE_SELECT} WHERE deleted_at IS NULL
             AND (?1 = '' OR student_id = ?1) AND (?2 = '' OR session_id = ?2)
             ORDER BY updated_at DESC"
        ))
        .map_err(|error| format!("Could not read study guides: {error}"))?;
    let rows = statement
        .query_map(params![student_id, session_id], guide_row)
        .map_err(|error| format!("Could not read study guides: {error}"))?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| format!("Could not read study guides: {error}"))
}

pub fn get_guide(conn: &Connection, id: &str) -> Result<Guide, String> {
    conn.query_row(
        &format!("{GUIDE_SELECT} WHERE id = ?1 AND deleted_at IS NULL"),
        params![id],
        guide_row,
    )
    .optional()
    .map_err(|error| format!("Could not read the study guide: {error}"))?
    .ok_or_else(|| "The study guide could not be found.".to_owned())
}

pub fn create_guide(conn: &mut Connection, input: &GuideInput) -> Result<Guide, String> {
    let title = input.title.trim();
    if title.is_empty() {
        return Err("Enter a title for the study guide.".to_owned());
    }
    let id = Uuid::new_v4().to_string();
    let now = now_ms();
    let sources = serde_json::to_string(&input.source_ids).unwrap_or_else(|_| "[]".to_owned());
    let transaction = conn
        .transaction()
        .map_err(|error| format!("Could not start the guide update: {error}"))?;
    transaction
        .execute(
            "INSERT INTO guides (id, student_id, session_id, title, status, body, source_ids, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
            params![
                id,
                input.student_id,
                input.session_id,
                title,
                normalized_guide_status(&input.status),
                input.body,
                sources,
                now
            ],
        )
        .map_err(|error| format!("Could not create the study guide: {error}"))?;
    transaction
        .execute(
            "INSERT INTO guide_revisions (id, guide_id, title, body, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![Uuid::new_v4().to_string(), id, title, input.body, now],
        )
        .map_err(|error| format!("Could not create the guide revision: {error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("Could not save the study guide: {error}"))?;
    reindex_public(
        conn,
        "guide",
        &id,
        title,
        &input.body,
        input.student_id.as_deref().unwrap_or(""),
        input.session_id.as_deref().unwrap_or(""),
    )?;
    touch_workspace_public(conn)?;
    get_guide(conn, &id)
}

pub fn update_guide(conn: &mut Connection, id: &str, input: &GuideInput) -> Result<Guide, String> {
    let title = input.title.trim();
    if title.is_empty() {
        return Err("Enter a title for the study guide.".to_owned());
    }
    let now = now_ms();
    let sources = serde_json::to_string(&input.source_ids).unwrap_or_else(|_| "[]".to_owned());
    let transaction = conn
        .transaction()
        .map_err(|error| format!("Could not start the guide update: {error}"))?;
    let changed = transaction
        .execute(
            "UPDATE guides SET student_id = ?2, session_id = ?3, title = ?4, status = ?5,
             body = ?6, source_ids = ?7, updated_at = ?8 WHERE id = ?1 AND deleted_at IS NULL",
            params![
                id,
                input.student_id,
                input.session_id,
                title,
                normalized_guide_status(&input.status),
                input.body,
                sources,
                now
            ],
        )
        .map_err(|error| format!("Could not update the study guide: {error}"))?;
    if changed == 0 {
        return Err("The study guide could not be found.".to_owned());
    }
    transaction
        .execute(
            "INSERT INTO guide_revisions (id, guide_id, title, body, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![Uuid::new_v4().to_string(), id, title, input.body, now],
        )
        .map_err(|error| format!("Could not create the guide revision: {error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("Could not save the study guide: {error}"))?;
    reindex_public(
        conn,
        "guide",
        id,
        title,
        &input.body,
        input.student_id.as_deref().unwrap_or(""),
        input.session_id.as_deref().unwrap_or(""),
    )?;
    touch_workspace_public(conn)?;
    get_guide(conn, id)
}

pub fn delete_guide(conn: &Connection, id: &str) -> Result<(), String> {
    let changed = conn
        .execute(
            "UPDATE guides SET deleted_at = ?2, updated_at = ?2 WHERE id = ?1 AND deleted_at IS NULL",
            params![id, now_ms()],
        )
        .map_err(|error| format!("Could not move the study guide to trash: {error}"))?;
    if changed == 0 {
        return Err("The study guide could not be found.".to_owned());
    }
    touch_workspace_public(conn)?;
    Ok(())
}

fn normalized_guide_status(value: &str) -> &str {
    match value {
        "draft" | "approved" | "archived" => value,
        _ => "draft",
    }
}

fn evidence_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Evidence> {
    Ok(Evidence {
        id: row.get(0)?,
        student_id: row.get(1)?,
        session_id: row.get(2)?,
        source_type: row.get(3)?,
        source_id: row.get(4)?,
        kind: row.get(5)?,
        statement: row.get(6)?,
        status: row.get(7)?,
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
    })
}

const EVIDENCE_SELECT: &str = "SELECT id, student_id, session_id, source_type, source_id, kind,
    statement, status, created_at, updated_at FROM evidence";

pub fn list_evidence(
    conn: &Connection,
    student_id: &str,
    session_id: &str,
) -> Result<Vec<Evidence>, String> {
    let mut statement = conn
        .prepare(&format!(
            "{EVIDENCE_SELECT} WHERE deleted_at IS NULL
             AND (?1 = '' OR student_id = ?1) AND (?2 = '' OR session_id = ?2)
             ORDER BY created_at DESC"
        ))
        .map_err(|error| format!("Could not read evidence: {error}"))?;
    let rows = statement
        .query_map(params![student_id, session_id], evidence_row)
        .map_err(|error| format!("Could not read evidence: {error}"))?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| format!("Could not read evidence: {error}"))
}

pub fn create_evidence(conn: &Connection, input: &EvidenceInput) -> Result<Evidence, String> {
    let statement = input.statement.trim();
    if statement.is_empty() {
        return Err("Write the evidence statement first.".to_owned());
    }
    let id = Uuid::new_v4().to_string();
    let now = now_ms();
    conn.execute(
        "INSERT INTO evidence (id, student_id, session_id, source_type, source_id, kind, statement,
         status, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)",
        params![
            id,
            input.student_id,
            input.session_id,
            input.source_type.trim(),
            input.source_id.trim(),
            input.kind.trim(),
            statement,
            normalized_evidence_status(&input.status),
            now
        ],
    )
    .map_err(|error| format!("Could not create the evidence: {error}"))?;
    reindex_public(
        conn,
        "evidence",
        &id,
        input.kind.trim(),
        statement,
        input.student_id.as_deref().unwrap_or(""),
        input.session_id.as_deref().unwrap_or(""),
    )?;
    touch_workspace_public(conn)?;
    get_evidence(conn, &id)
}

pub fn get_evidence(conn: &Connection, id: &str) -> Result<Evidence, String> {
    conn.query_row(
        &format!("{EVIDENCE_SELECT} WHERE id = ?1 AND deleted_at IS NULL"),
        params![id],
        evidence_row,
    )
    .optional()
    .map_err(|error| format!("Could not read the evidence: {error}"))?
    .ok_or_else(|| "The evidence could not be found.".to_owned())
}

pub fn update_evidence(
    conn: &Connection,
    id: &str,
    input: &EvidenceInput,
) -> Result<Evidence, String> {
    let statement = input.statement.trim();
    if statement.is_empty() {
        return Err("Write the evidence statement first.".to_owned());
    }
    let changed = conn
        .execute(
            "UPDATE evidence SET student_id = ?2, session_id = ?3, source_type = ?4, source_id = ?5,
             kind = ?6, statement = ?7, status = ?8, updated_at = ?9
             WHERE id = ?1 AND deleted_at IS NULL",
            params![
                id,
                input.student_id,
                input.session_id,
                input.source_type.trim(),
                input.source_id.trim(),
                input.kind.trim(),
                statement,
                normalized_evidence_status(&input.status),
                now_ms()
            ],
        )
        .map_err(|error| format!("Could not update the evidence: {error}"))?;
    if changed == 0 {
        return Err("The evidence could not be found.".to_owned());
    }
    reindex_public(
        conn,
        "evidence",
        id,
        input.kind.trim(),
        statement,
        input.student_id.as_deref().unwrap_or(""),
        input.session_id.as_deref().unwrap_or(""),
    )?;
    touch_workspace_public(conn)?;
    get_evidence(conn, id)
}

pub fn delete_evidence(conn: &Connection, id: &str) -> Result<(), String> {
    let changed = conn
        .execute(
            "UPDATE evidence SET deleted_at = ?2, updated_at = ?2 WHERE id = ?1 AND deleted_at IS NULL",
            params![id, now_ms()],
        )
        .map_err(|error| format!("Could not move the evidence to trash: {error}"))?;
    if changed == 0 {
        return Err("The evidence could not be found.".to_owned());
    }
    touch_workspace_public(conn)?;
    Ok(())
}

fn normalized_evidence_status(value: &str) -> &str {
    match value {
        "draft" | "approved" | "rejected" => value,
        _ => "draft",
    }
}

fn evidence_link_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<EvidenceLink> {
    Ok(EvidenceLink {
        id: row.get(0)?,
        from_id: row.get(1)?,
        to_id: row.get(2)?,
        relationship: row.get(3)?,
        created_at: row.get(4)?,
    })
}

const EVIDENCE_LINK_SELECT: &str =
    "SELECT id, from_id, to_id, relationship, created_at FROM evidence_links";

pub fn list_evidence_links(
    conn: &Connection,
    student_id: &str,
    session_id: &str,
) -> Result<Vec<EvidenceLink>, String> {
    let mut statement = conn
        .prepare(&format!(
            "{EVIDENCE_LINK_SELECT} l
             WHERE EXISTS (SELECT 1 FROM evidence f WHERE f.id = l.from_id AND f.deleted_at IS NULL)
               AND EXISTS (SELECT 1 FROM evidence t WHERE t.id = l.to_id AND t.deleted_at IS NULL)
               AND (?1 = '' OR EXISTS (
                   SELECT 1 FROM evidence f WHERE f.id = l.from_id AND f.student_id = ?1
               ) AND EXISTS (
                   SELECT 1 FROM evidence t WHERE t.id = l.to_id AND t.student_id = ?1
               ))
               AND (?2 = '' OR EXISTS (
                   SELECT 1 FROM evidence f WHERE f.id = l.from_id AND f.session_id = ?2
               ) AND EXISTS (
                   SELECT 1 FROM evidence t WHERE t.id = l.to_id AND t.session_id = ?2
               ))
             ORDER BY l.created_at"
        ))
        .map_err(|error| format!("Could not read evidence links: {error}"))?;
    let rows = statement
        .query_map(params![student_id, session_id], evidence_link_row)
        .map_err(|error| format!("Could not read evidence links: {error}"))?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| format!("Could not read evidence links: {error}"))
}

pub fn evidence_graph(
    conn: &Connection,
    student_id: &str,
    session_id: &str,
) -> Result<EvidenceGraph, String> {
    Ok(EvidenceGraph {
        nodes: list_evidence(conn, student_id, session_id)?,
        links: list_evidence_links(conn, student_id, session_id)?,
    })
}

pub fn create_evidence_link(
    conn: &Connection,
    input: &EvidenceLinkInput,
) -> Result<EvidenceLink, String> {
    if input.from_id == input.to_id {
        return Err("An evidence item cannot link to itself.".to_owned());
    }
    let relationship = input.relationship.trim();
    if relationship.is_empty() {
        return Err("Choose how the evidence items are related.".to_owned());
    }
    let from_student: Option<String> = conn
        .query_row(
            "SELECT student_id FROM evidence WHERE id = ?1 AND deleted_at IS NULL",
            params![input.from_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("Could not read the evidence item: {error}"))?
        .ok_or_else(|| "The source evidence item could not be found.".to_owned())?;
    let to_student: Option<String> = conn
        .query_row(
            "SELECT student_id FROM evidence WHERE id = ?1 AND deleted_at IS NULL",
            params![input.to_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("Could not read the evidence item: {error}"))?
        .ok_or_else(|| "The target evidence item could not be found.".to_owned())?;
    if from_student.is_some() && to_student.is_some() && from_student != to_student {
        return Err("Link evidence items that belong to the same student.".to_owned());
    }
    let exists: bool = conn
        .query_row(
            "SELECT EXISTS(
                SELECT 1 FROM evidence_links
                WHERE from_id = ?1 AND to_id = ?2 AND relationship = ?3
             )",
            params![input.from_id, input.to_id, relationship],
            |row| row.get(0),
        )
        .map_err(|error| format!("Could not check the evidence link: {error}"))?;
    if exists {
        return Err("That evidence link already exists.".to_owned());
    }
    let id = Uuid::new_v4().to_string();
    let now = now_ms();
    conn.execute(
        "INSERT INTO evidence_links (id, from_id, to_id, relationship, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![id, input.from_id, input.to_id, relationship, now],
    )
    .map_err(|error| format!("Could not create the evidence link: {error}"))?;
    touch_workspace_public(conn)?;
    conn.query_row(
        &format!("{EVIDENCE_LINK_SELECT} WHERE id = ?1"),
        params![id],
        evidence_link_row,
    )
    .map_err(|error| format!("Could not read the evidence link: {error}"))
}

pub fn delete_evidence_link(conn: &Connection, id: &str) -> Result<(), String> {
    let changed = conn
        .execute("DELETE FROM evidence_links WHERE id = ?1", params![id])
        .map_err(|error| format!("Could not delete the evidence link: {error}"))?;
    if changed == 0 {
        return Err("The evidence link could not be found.".to_owned());
    }
    touch_workspace_public(conn)?;
    Ok(())
}

pub fn list_goals(conn: &Connection, student_id: &str) -> Result<Vec<Goal>, String> {
    let mut statement = conn
        .prepare(
            "SELECT id, student_id, title, status, target_date, notes, updated_at
             FROM goals WHERE student_id = ?1 ORDER BY status, target_date, title",
        )
        .map_err(|error| format!("Could not read goals: {error}"))?;
    let rows = statement
        .query_map(params![student_id], |row| {
            Ok(Goal {
                id: row.get(0)?,
                student_id: row.get(1)?,
                title: row.get(2)?,
                status: row.get(3)?,
                target_date: row.get(4)?,
                notes: row.get(5)?,
                updated_at: row.get(6)?,
            })
        })
        .map_err(|error| format!("Could not read goals: {error}"))?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| format!("Could not read goals: {error}"))
}

pub fn upsert_goal(conn: &Connection, id: Option<&str>, input: &GoalInput) -> Result<Goal, String> {
    let title = input.title.trim();
    if title.is_empty() {
        return Err("Enter a goal title.".to_owned());
    }
    let goal_id = id
        .map(str::to_owned)
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let now = now_ms();
    conn.execute(
        "INSERT INTO goals (id, student_id, title, status, target_date, notes, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(id) DO UPDATE SET title = excluded.title, status = excluded.status,
         target_date = excluded.target_date, notes = excluded.notes, updated_at = excluded.updated_at",
        params![
            goal_id,
            input.student_id,
            title,
            input.status.trim(),
            input.target_date.trim(),
            input.notes.trim(),
            now
        ],
    )
    .map_err(|error| format!("Could not save the goal: {error}"))?;
    touch_workspace_public(conn)?;
    conn.query_row(
        "SELECT id, student_id, title, status, target_date, notes, updated_at FROM goals WHERE id = ?1",
        params![goal_id],
        |row| {
            Ok(Goal {
                id: row.get(0)?,
                student_id: row.get(1)?,
                title: row.get(2)?,
                status: row.get(3)?,
                target_date: row.get(4)?,
                notes: row.get(5)?,
                updated_at: row.get(6)?,
            })
        },
    )
    .map_err(|error| format!("Could not read the saved goal: {error}"))
}

pub fn delete_goal(conn: &Connection, id: &str) -> Result<(), String> {
    conn.execute("DELETE FROM goals WHERE id = ?1", params![id])
        .map_err(|error| format!("Could not delete the goal: {error}"))?;
    touch_workspace_public(conn)?;
    Ok(())
}

pub fn list_skills(conn: &Connection, student_id: &str) -> Result<Vec<SkillRating>, String> {
    let mut statement = conn
        .prepare(
            "SELECT id, student_id, skill, rating, note, updated_at FROM skill_ratings
             WHERE student_id = ?1 ORDER BY skill",
        )
        .map_err(|error| format!("Could not read skill ratings: {error}"))?;
    let rows = statement
        .query_map(params![student_id], |row| {
            Ok(SkillRating {
                id: row.get(0)?,
                student_id: row.get(1)?,
                skill: row.get(2)?,
                rating: row.get(3)?,
                note: row.get(4)?,
                updated_at: row.get(5)?,
            })
        })
        .map_err(|error| format!("Could not read skill ratings: {error}"))?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| format!("Could not read skill ratings: {error}"))
}

pub fn upsert_skill(
    conn: &Connection,
    id: Option<&str>,
    input: &SkillRatingInput,
) -> Result<SkillRating, String> {
    let skill = input.skill.trim();
    if skill.is_empty() {
        return Err("Enter a skill name.".to_owned());
    }
    let rating_id = id
        .map(str::to_owned)
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let now = now_ms();
    conn.execute(
        "INSERT INTO skill_ratings (id, student_id, skill, rating, note, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(id) DO UPDATE SET skill = excluded.skill, rating = excluded.rating,
         note = excluded.note, updated_at = excluded.updated_at",
        params![
            rating_id,
            input.student_id,
            skill,
            input.rating.clamp(0, 5),
            input.note.trim(),
            now
        ],
    )
    .map_err(|error| format!("Could not save the skill rating: {error}"))?;
    touch_workspace_public(conn)?;
    conn.query_row(
        "SELECT id, student_id, skill, rating, note, updated_at FROM skill_ratings WHERE id = ?1",
        params![rating_id],
        |row| {
            Ok(SkillRating {
                id: row.get(0)?,
                student_id: row.get(1)?,
                skill: row.get(2)?,
                rating: row.get(3)?,
                note: row.get(4)?,
                updated_at: row.get(5)?,
            })
        },
    )
    .map_err(|error| format!("Could not read the saved skill rating: {error}"))
}

pub fn delete_skill(conn: &Connection, id: &str) -> Result<(), String> {
    conn.execute("DELETE FROM skill_ratings WHERE id = ?1", params![id])
        .map_err(|error| format!("Could not delete the skill rating: {error}"))?;
    touch_workspace_public(conn)?;
    Ok(())
}
