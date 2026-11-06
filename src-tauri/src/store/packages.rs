use std::path::Path;

use rusqlite::{params, Connection, OpenFlags, OptionalExtension};

use super::{
    models::{ImportedSession, PackageResult},
    repo::{self, touch_workspace_public},
};

const PACKAGE_EXTENSION: &str = "tutorpkg";
const PACKAGE_VERSION: &str = "1";

fn ensure_package_extension(path: &Path) -> Result<(), String> {
    if path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case(PACKAGE_EXTENSION))
    {
        Ok(())
    } else {
        Err("Session packages must use the .tutorpkg extension.".to_owned())
    }
}

fn cleanup(path: &Path) {
    let _ = std::fs::remove_file(path);
    let _ = std::fs::remove_file(format!("{}-wal", path.display()));
    let _ = std::fs::remove_file(format!("{}-shm", path.display()));
}

pub fn export_session(
    conn: &Connection,
    session_id: &str,
    destination: &str,
) -> Result<PackageResult, String> {
    let path = Path::new(destination);
    ensure_package_extension(path)?;
    if path.exists() {
        return Err(
            "Choose a new session package file; that destination already exists.".to_owned(),
        );
    }
    if let Some(parent) = path.parent() {
        if !parent.exists() {
            return Err("The package folder does not exist.".to_owned());
        }
    }
    let (title, student_id): (String, Option<String>) = conn
        .query_row(
            "SELECT title, student_id FROM sessions WHERE id = ?1 AND deleted_at IS NULL",
            params![session_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|error| format!("Could not read the session: {error}"))?
        .ok_or_else(|| "The session could not be found.".to_owned())?;
    {
        let target = Connection::open(path)
            .map_err(|error| format!("Could not create the session package: {error}"))?;
        repo::apply_connection_pragmas(&target)?;
        repo::initialize_workspace(
            &target,
            &format!("Session package: {title}"),
            "Portable Tutorux session package",
            false,
        )?;
    }
    let result = (|| {
        conn.execute("ATTACH DATABASE ?1 AS pkg KEY ''", params![destination])
            .map_err(|error| format!("Could not open the session package: {error}"))?;
        let copy = || -> Result<(), String> {
            if let Some(student_id) = student_id.as_deref() {
                conn.execute(
                    "INSERT INTO pkg.students SELECT * FROM main.students WHERE id = ?1",
                    params![student_id],
                )
                .map_err(|error| format!("Could not copy the student: {error}"))?;
            }
            conn.execute(
                "INSERT OR IGNORE INTO pkg.students SELECT * FROM main.students WHERE id IN (
                     SELECT student_id FROM main.evidence WHERE session_id = ?1
                     UNION SELECT student_id FROM main.materials WHERE session_id = ?1
                     UNION SELECT student_id FROM main.guides WHERE session_id = ?1
                     UNION SELECT student_id FROM main.journal_entries WHERE session_id = ?1
                     UNION SELECT student_id FROM main.observations WHERE session_id = ?1
                 )",
                params![session_id],
            )
            .map_err(|error| format!("Could not copy related students: {error}"))?;
            conn.execute(
                "INSERT INTO pkg.sessions SELECT * FROM main.sessions WHERE id = ?1",
                params![session_id],
            )
            .map_err(|error| format!("Could not copy the session: {error}"))?;
            for (label, statement) in [
                (
                    "journal",
                    "INSERT INTO pkg.journal_entries SELECT * FROM main.journal_entries WHERE session_id = ?1",
                ),
                (
                    "observations",
                    "INSERT INTO pkg.observations SELECT * FROM main.observations WHERE session_id = ?1",
                ),
                (
                    "transcript",
                    "INSERT INTO pkg.transcript_cues SELECT * FROM main.transcript_cues WHERE session_id = ?1",
                ),
                (
                    "materials",
                    "INSERT INTO pkg.materials SELECT * FROM main.materials WHERE session_id = ?1",
                ),
                (
                    "recordings",
                    "INSERT INTO pkg.recordings SELECT * FROM main.recordings WHERE session_id = ?1",
                ),
                (
                    "guides",
                    "INSERT INTO pkg.guides SELECT * FROM main.guides WHERE session_id = ?1",
                ),
                (
                    "evidence",
                    "INSERT INTO pkg.evidence SELECT * FROM main.evidence WHERE session_id = ?1",
                ),
            ] {
                conn.execute(statement, params![session_id])
                    .map_err(|error| format!("Could not copy session {label}: {error}"))?;
            }
            for statement in [
                "INSERT INTO pkg.material_chunks SELECT * FROM main.material_chunks
                 WHERE material_id IN (SELECT id FROM pkg.materials)",
                "INSERT INTO pkg.recording_chunks SELECT * FROM main.recording_chunks
                 WHERE recording_id IN (SELECT id FROM pkg.recordings)",
                "INSERT INTO pkg.guide_revisions SELECT * FROM main.guide_revisions
                 WHERE guide_id IN (SELECT id FROM pkg.guides)",
                "INSERT INTO pkg.evidence_links SELECT * FROM main.evidence_links
                 WHERE from_id IN (SELECT id FROM pkg.evidence)
                   AND to_id IN (SELECT id FROM pkg.evidence)",
                "INSERT OR IGNORE INTO pkg.blobs SELECT * FROM main.blobs WHERE hash IN (
                     SELECT hash FROM pkg.material_chunks
                     UNION SELECT hash FROM pkg.recording_chunks)",
            ] {
                conn.execute(statement, [])
                    .map_err(|error| format!("Could not copy session media: {error}"))?;
            }
            if let Some(student_id) = student_id.as_deref() {
                for statement in [
                    "INSERT INTO pkg.goals SELECT * FROM main.goals WHERE student_id = ?1",
                    "INSERT INTO pkg.skill_ratings SELECT * FROM main.skill_ratings WHERE student_id = ?1",
                ] {
                    conn.execute(statement, params![student_id])
                        .map_err(|error| format!("Could not copy student progress: {error}"))?;
                }
            }
            conn.execute(
                "INSERT OR REPLACE INTO pkg.meta(key, value) VALUES
                 ('package_session_id', ?1), ('package_version', ?2)",
                params![session_id, PACKAGE_VERSION],
            )
            .map_err(|error| format!("Could not mark the session package: {error}"))?;
            conn.execute_batch(
                "INSERT INTO pkg.search_fts(entity_type, entity_id, title, body, student_id, session_id)
                     SELECT 'student', id, display_name, '', id, '' FROM pkg.students;
                 INSERT INTO pkg.search_fts(entity_type, entity_id, title, body, student_id, session_id)
                     SELECT 'session', id, title, subject, COALESCE(student_id, ''), id
                     FROM pkg.sessions;
                 INSERT INTO pkg.search_fts(entity_type, entity_id, title, body, student_id, session_id)
                     SELECT 'journal', id, title, body, COALESCE(student_id, ''),
                            COALESCE(session_id, '') FROM pkg.journal_entries;
                 INSERT INTO pkg.search_fts(entity_type, entity_id, title, body, student_id, session_id)
                     SELECT 'observation', id, title, body, COALESCE(student_id, ''),
                            COALESCE(session_id, '') FROM pkg.observations;
                 INSERT INTO pkg.search_fts(entity_type, entity_id, title, body, student_id, session_id)
                     SELECT 'material', id, COALESCE(NULLIF(title, ''), filename), extracted_text,
                            COALESCE(student_id, ''), COALESCE(session_id, '') FROM pkg.materials;
                 INSERT INTO pkg.search_fts(entity_type, entity_id, title, body, student_id, session_id)
                     SELECT 'guide', id, title, body, COALESCE(student_id, ''),
                            COALESCE(session_id, '') FROM pkg.guides;
                 INSERT INTO pkg.search_fts(entity_type, entity_id, title, body, student_id, session_id)
                     SELECT 'evidence', id, kind, statement, COALESCE(student_id, ''),
                            COALESCE(session_id, '') FROM pkg.evidence;",
            )
            .map_err(|error| format!("Could not index the session package: {error}"))?;
            let check: String = conn
                .query_row("PRAGMA pkg.integrity_check", [], |row| row.get(0))
                .map_err(|error| format!("Could not verify the session package: {error}"))?;
            if check != "ok" {
                return Err(format!(
                    "The session package failed its integrity check: {check}"
                ));
            }
            Ok(())
        };
        let copy_result = copy();
        let detach_result = conn.execute_batch("DETACH DATABASE pkg");
        copy_result?;
        detach_result.map_err(|error| format!("Could not close the session package: {error}"))?;
        Ok(())
    })();
    if let Err(error) = result {
        cleanup(path);
        return Err(error);
    }
    let bytes = std::fs::metadata(path)
        .map(|metadata| metadata.len() as i64)
        .unwrap_or(0);
    Ok(PackageResult {
        path: path.to_string_lossy().into_owned(),
        bytes,
        session_id: session_id.to_owned(),
        title,
    })
}

pub fn import_session(
    conn: &mut Connection,
    package_path: &str,
) -> Result<ImportedSession, String> {
    let path = Path::new(package_path);
    ensure_package_extension(path)?;
    if !path.is_file() {
        return Err("The selected session package does not exist.".to_owned());
    }
    let package = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| format!("Could not open the session package: {error}"))?;
    let package_session_id: Option<String> = package
        .query_row(
            "SELECT value FROM meta WHERE key = 'package_session_id'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("Could not read the session package: {error}"))?;
    let package_session_id = package_session_id
        .ok_or_else(|| "That file is not a Tutorux session package.".to_owned())?;
    drop(package);

    conn.execute("ATTACH DATABASE ?1 AS pkg KEY ''", params![package_path])
        .map_err(|error| format!("Could not open the session package: {error}"))?;
    let sql = r#"
        DROP TABLE IF EXISTS temp.map_student;
        DROP TABLE IF EXISTS temp.map_session;
        DROP TABLE IF EXISTS temp.map_journal;
        DROP TABLE IF EXISTS temp.map_observation;
        DROP TABLE IF EXISTS temp.map_cue;
        DROP TABLE IF EXISTS temp.map_material;
        DROP TABLE IF EXISTS temp.map_recording;
        DROP TABLE IF EXISTS temp.map_guide;
        DROP TABLE IF EXISTS temp.map_evidence;
        BEGIN IMMEDIATE;
        CREATE TEMP TABLE map_student(old TEXT PRIMARY KEY, new TEXT NOT NULL);
        INSERT INTO map_student SELECT id, lower(hex(randomblob(16))) FROM pkg.students;
        UPDATE map_student SET new = COALESCE((
            SELECT s.id FROM main.students s
            JOIN pkg.students p ON p.id = map_student.old
            WHERE s.display_name = p.display_name AND s.deleted_at IS NULL
            ORDER BY s.created_at LIMIT 1
        ), new);
        CREATE TEMP TABLE map_session(old TEXT PRIMARY KEY, new TEXT NOT NULL);
        INSERT INTO map_session SELECT id, lower(hex(randomblob(16))) FROM pkg.sessions;
        CREATE TEMP TABLE map_journal(old TEXT PRIMARY KEY, new TEXT NOT NULL);
        INSERT INTO map_journal SELECT id, lower(hex(randomblob(16))) FROM pkg.journal_entries;
        CREATE TEMP TABLE map_observation(old TEXT PRIMARY KEY, new TEXT NOT NULL);
        INSERT INTO map_observation SELECT id, lower(hex(randomblob(16))) FROM pkg.observations;
        CREATE TEMP TABLE map_cue(old TEXT PRIMARY KEY, new TEXT NOT NULL);
        INSERT INTO map_cue SELECT id, lower(hex(randomblob(16))) FROM pkg.transcript_cues;
        CREATE TEMP TABLE map_material(old TEXT PRIMARY KEY, new TEXT NOT NULL);
        INSERT INTO map_material SELECT id, lower(hex(randomblob(16))) FROM pkg.materials;
        CREATE TEMP TABLE map_recording(old TEXT PRIMARY KEY, new TEXT NOT NULL);
        INSERT INTO map_recording SELECT id, lower(hex(randomblob(16))) FROM pkg.recordings;
        CREATE TEMP TABLE map_guide(old TEXT PRIMARY KEY, new TEXT NOT NULL);
        INSERT INTO map_guide SELECT id, lower(hex(randomblob(16))) FROM pkg.guides;
        CREATE TEMP TABLE map_evidence(old TEXT PRIMARY KEY, new TEXT NOT NULL);
        INSERT INTO map_evidence SELECT id, lower(hex(randomblob(16))) FROM pkg.evidence;

        INSERT INTO main.students (id, display_name, year, subjects, goals, notes, archived,
            deleted_at, created_at, updated_at)
        SELECT m.new, p.display_name, p.year, p.subjects, p.goals, p.notes, p.archived,
            NULL, p.created_at, p.updated_at
        FROM pkg.students p JOIN map_student m ON m.old = p.id
        WHERE NOT EXISTS (SELECT 1 FROM main.students s WHERE s.id = m.new);

        INSERT INTO main.sessions (id, student_id, schedule_event_id, title, subject, scheduled_at,
            started_at, ended_at, status, notes, deleted_at, created_at, updated_at)
        SELECT m.new, (SELECT new FROM map_student WHERE old = p.student_id), NULL, p.title,
            p.subject, p.scheduled_at, p.started_at, p.ended_at, p.status, p.notes, NULL,
            p.created_at, p.updated_at
        FROM pkg.sessions p JOIN map_session m ON m.old = p.id;

        INSERT INTO main.journal_entries (id, session_id, student_id, entry_date, title, body,
            deleted_at, created_at, updated_at)
        SELECT m.new, (SELECT new FROM map_session WHERE old = p.session_id),
            (SELECT new FROM map_student WHERE old = p.student_id), p.entry_date, p.title,
            p.body, NULL, p.created_at, p.updated_at
        FROM pkg.journal_entries p JOIN map_journal m ON m.old = p.id;

        INSERT INTO main.observations (id, session_id, student_id, kind, priority, start_us,
            end_us, title, body, deleted_at, created_at, updated_at)
        SELECT m.new, (SELECT new FROM map_session WHERE old = p.session_id),
            (SELECT new FROM map_student WHERE old = p.student_id), p.kind, p.priority,
            p.start_us, p.end_us, p.title, p.body, NULL, p.created_at, p.updated_at
        FROM pkg.observations p JOIN map_observation m ON m.old = p.id;

        INSERT INTO main.transcript_cues (id, session_id, start_us, end_us, speaker, body,
            verified, deleted_at, created_at, updated_at)
        SELECT m.new, (SELECT new FROM map_session WHERE old = p.session_id), p.start_us,
            p.end_us, p.speaker, p.body, p.verified, NULL, p.created_at, p.updated_at
        FROM pkg.transcript_cues p JOIN map_cue m ON m.old = p.id;

        INSERT INTO main.materials (id, session_id, student_id, kind, filename, mime_type,
            byte_size, hash, source_url, title, notes, status, extracted_text, deleted_at,
            created_at, updated_at)
        SELECT m.new, (SELECT new FROM map_session WHERE old = p.session_id),
            (SELECT new FROM map_student WHERE old = p.student_id), p.kind, p.filename,
            p.mime_type, p.byte_size, p.hash, p.source_url, p.title, p.notes, p.status,
            p.extracted_text, NULL, p.created_at, p.updated_at
        FROM pkg.materials p JOIN map_material m ON m.old = p.id;

        INSERT INTO main.material_chunks (material_id, chunk_no, hash, original_size)
        SELECT m.new, c.chunk_no, c.hash, c.original_size
        FROM pkg.material_chunks c JOIN map_material m ON m.old = c.material_id;

        INSERT INTO main.recordings (id, session_id, title, source, sample_rate, channels,
            started_at, duration_us, deleted_at, created_at, updated_at)
        SELECT m.new, (SELECT new FROM map_session WHERE old = p.session_id), p.title, p.source,
            p.sample_rate, p.channels, p.started_at, p.duration_us, NULL, p.created_at,
            p.updated_at
        FROM pkg.recordings p JOIN map_recording m ON m.old = p.id;

        INSERT INTO main.recording_chunks (recording_id, track, chunk_no, start_us, sample_count,
            hash, original_size)
        SELECT m.new, c.track, c.chunk_no, c.start_us, c.sample_count, c.hash, c.original_size
        FROM pkg.recording_chunks c JOIN map_recording m ON m.old = c.recording_id;

        INSERT INTO main.guides (id, student_id, session_id, title, status, body, source_ids,
            deleted_at, created_at, updated_at)
        SELECT m.new, (SELECT new FROM map_student WHERE old = p.student_id),
            (SELECT new FROM map_session WHERE old = p.session_id), p.title, p.status, p.body,
            '[]', NULL, p.created_at, p.updated_at
        FROM pkg.guides p JOIN map_guide m ON m.old = p.id;

        INSERT INTO main.guide_revisions (id, guide_id, title, body, created_at)
        SELECT lower(hex(randomblob(16))), m.new, r.title, r.body, r.created_at
        FROM pkg.guide_revisions r JOIN map_guide m ON m.old = r.guide_id;

        INSERT INTO main.evidence (id, student_id, session_id, source_type, source_id, kind,
            statement, status, deleted_at, created_at, updated_at)
        SELECT m.new, (SELECT new FROM map_student WHERE old = p.student_id),
            (SELECT new FROM map_session WHERE old = p.session_id), p.source_type,
            CASE p.source_type
                WHEN 'session' THEN COALESCE((SELECT new FROM map_session WHERE old = p.source_id), '')
                WHEN 'material' THEN COALESCE((SELECT new FROM map_material WHERE old = p.source_id), '')
                WHEN 'transcript' THEN COALESCE((SELECT new FROM map_cue WHERE old = p.source_id), '')
                WHEN 'guide' THEN COALESCE((SELECT new FROM map_guide WHERE old = p.source_id), '')
                WHEN 'observation' THEN COALESCE((SELECT new FROM map_observation WHERE old = p.source_id), '')
                WHEN 'journal' THEN COALESCE((SELECT new FROM map_journal WHERE old = p.source_id), '')
                WHEN 'recording' THEN COALESCE((SELECT new FROM map_recording WHERE old = p.source_id), '')
                ELSE p.source_id
            END,
            p.kind, p.statement, p.status, NULL, p.created_at, p.updated_at
        FROM pkg.evidence p JOIN map_evidence m ON m.old = p.id;

        INSERT INTO main.evidence_links (id, from_id, to_id, relationship, created_at)
        SELECT lower(hex(randomblob(16))),
            (SELECT new FROM map_evidence WHERE old = l.from_id),
            (SELECT new FROM map_evidence WHERE old = l.to_id), l.relationship, l.created_at
        FROM pkg.evidence_links l
        WHERE EXISTS (SELECT 1 FROM map_evidence WHERE old = l.from_id)
          AND EXISTS (SELECT 1 FROM map_evidence WHERE old = l.to_id);

        INSERT INTO main.goals (id, student_id, title, status, target_date, notes, updated_at)
        SELECT lower(hex(randomblob(16))), m.new, g.title, g.status, g.target_date, g.notes,
            g.updated_at
        FROM pkg.goals g JOIN map_student m ON m.old = g.student_id
        WHERE NOT EXISTS (
            SELECT 1 FROM main.goals x WHERE x.student_id = m.new AND x.title = g.title
        );

        INSERT INTO main.skill_ratings (id, student_id, skill, rating, note, updated_at)
        SELECT lower(hex(randomblob(16))), m.new, s.skill, s.rating, s.note, s.updated_at
        FROM pkg.skill_ratings s JOIN map_student m ON m.old = s.student_id
        WHERE NOT EXISTS (
            SELECT 1 FROM main.skill_ratings x WHERE x.student_id = m.new AND x.skill = s.skill
        );

        INSERT OR IGNORE INTO main.blobs SELECT * FROM pkg.blobs;

        DELETE FROM main.search_fts WHERE entity_id IN (SELECT new FROM map_student);
        DELETE FROM main.search_fts WHERE entity_id IN (SELECT new FROM map_session);
        DELETE FROM main.search_fts WHERE entity_id IN (SELECT new FROM map_journal);
        DELETE FROM main.search_fts WHERE entity_id IN (SELECT new FROM map_observation);
        DELETE FROM main.search_fts WHERE entity_id IN (SELECT new FROM map_material);
        DELETE FROM main.search_fts WHERE entity_id IN (SELECT new FROM map_guide);
        DELETE FROM main.search_fts WHERE entity_id IN (SELECT new FROM map_evidence);

        INSERT INTO main.search_fts(entity_type, entity_id, title, body, student_id, session_id)
        SELECT 'student', m.new, p.display_name, '', m.new, ''
        FROM pkg.students p JOIN map_student m ON m.old = p.id;
        INSERT INTO main.search_fts(entity_type, entity_id, title, body, student_id, session_id)
        SELECT 'session', m.new, p.title, p.subject,
            COALESCE((SELECT new FROM map_student WHERE old = p.student_id), ''), m.new
        FROM pkg.sessions p JOIN map_session m ON m.old = p.id;
        INSERT INTO main.search_fts(entity_type, entity_id, title, body, student_id, session_id)
        SELECT 'journal', m.new, p.title, p.body,
            COALESCE((SELECT new FROM map_student WHERE old = p.student_id), ''),
            COALESCE((SELECT new FROM map_session WHERE old = p.session_id), '')
        FROM pkg.journal_entries p JOIN map_journal m ON m.old = p.id;
        INSERT INTO main.search_fts(entity_type, entity_id, title, body, student_id, session_id)
        SELECT 'observation', m.new, p.title, p.body,
            COALESCE((SELECT new FROM map_student WHERE old = p.student_id), ''),
            COALESCE((SELECT new FROM map_session WHERE old = p.session_id), '')
        FROM pkg.observations p JOIN map_observation m ON m.old = p.id;
        INSERT INTO main.search_fts(entity_type, entity_id, title, body, student_id, session_id)
        SELECT 'material', m.new, COALESCE(NULLIF(p.title, ''), p.filename), p.extracted_text,
            COALESCE((SELECT new FROM map_student WHERE old = p.student_id), ''),
            COALESCE((SELECT new FROM map_session WHERE old = p.session_id), '')
        FROM pkg.materials p JOIN map_material m ON m.old = p.id;
        INSERT INTO main.search_fts(entity_type, entity_id, title, body, student_id, session_id)
        SELECT 'guide', m.new, p.title, p.body,
            COALESCE((SELECT new FROM map_student WHERE old = p.student_id), ''),
            COALESCE((SELECT new FROM map_session WHERE old = p.session_id), '')
        FROM pkg.guides p JOIN map_guide m ON m.old = p.id;
        INSERT INTO main.search_fts(entity_type, entity_id, title, body, student_id, session_id)
        SELECT 'evidence', m.new, p.kind, p.statement,
            COALESCE((SELECT new FROM map_student WHERE old = p.student_id), ''),
            COALESCE((SELECT new FROM map_session WHERE old = p.session_id), '')
        FROM pkg.evidence p JOIN map_evidence m ON m.old = p.id;

        UPDATE main.meta SET value = CAST(strftime('%s', 'now') AS TEXT) || '000'
        WHERE key = 'updated_at';
        COMMIT;
    "#;
    let result = conn.execute_batch(sql);
    if let Err(error) = result {
        let _ = conn.execute_batch(
            "ROLLBACK;
             DROP TABLE IF EXISTS temp.map_student;
             DROP TABLE IF EXISTS temp.map_session;
             DROP TABLE IF EXISTS temp.map_journal;
             DROP TABLE IF EXISTS temp.map_observation;
             DROP TABLE IF EXISTS temp.map_cue;
             DROP TABLE IF EXISTS temp.map_material;
             DROP TABLE IF EXISTS temp.map_recording;
             DROP TABLE IF EXISTS temp.map_guide;
             DROP TABLE IF EXISTS temp.map_evidence;
             DETACH DATABASE pkg;",
        );
        return Err(format!("Could not import the session package: {error}"));
    }
    let imported = conn.query_row(
        "SELECT s.id, s.student_id, s.title FROM main.sessions s
         JOIN map_session m ON m.new = s.id WHERE m.old = ?1",
        params![package_session_id],
        |row| {
            Ok(ImportedSession {
                session_id: row.get(0)?,
                student_id: row.get(1)?,
                title: row.get(2)?,
            })
        },
    );
    let _ = conn.execute_batch(
        "DROP TABLE IF EXISTS temp.map_student;
         DROP TABLE IF EXISTS temp.map_session;
         DROP TABLE IF EXISTS temp.map_journal;
         DROP TABLE IF EXISTS temp.map_observation;
         DROP TABLE IF EXISTS temp.map_cue;
         DROP TABLE IF EXISTS temp.map_material;
         DROP TABLE IF EXISTS temp.map_recording;
         DROP TABLE IF EXISTS temp.map_guide;
         DROP TABLE IF EXISTS temp.map_evidence;
         DETACH DATABASE pkg;",
    );
    touch_workspace_public(conn)?;
    imported.map_err(|error| format!("Could not read the imported session: {error}"))
}
