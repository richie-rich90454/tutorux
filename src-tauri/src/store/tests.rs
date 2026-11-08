use rusqlite::Connection;

use super::{
    content::{
        create_evidence, create_evidence_link, create_journal, create_observation,
        delete_evidence_link, evidence_graph, list_cues,
    },
    materials::import_material_file,
    models::{
        EvidenceInput, EvidenceLinkInput, ObservationInput, RecordingTrackInput, StudentInput,
    },
    repo::{create_session, create_student, get_session, initialize_workspace, list_students},
    salvage::salvage_workspace,
    schedule::{create_schedule, find_conflicts, list_schedule, materialize_sessions},
    schema::{migrate_workspace, SCHEMA_SQL},
};

fn workspace() -> Connection {
    let connection = Connection::open_in_memory().unwrap();
    connection
        .execute_batch("PRAGMA foreign_keys = ON;")
        .unwrap();
    connection.execute_batch(SCHEMA_SQL).unwrap();
    initialize_workspace(&connection, "Test workspace", "A test", false).unwrap();
    connection
}

#[test]
fn creates_students_sessions_and_searchable_notes() {
    let connection = workspace();
    let student = create_student(
        &connection,
        &StudentInput {
            display_name: "Maya Ortiz".to_owned(),
            year: "Year 10".to_owned(),
            subjects: vec!["Algebra".to_owned()],
            goals: vec!["Fractions".to_owned()],
            notes: "Prefers worked examples.".to_owned(),
        },
    )
    .unwrap();
    assert_eq!(student.display_name, "Maya Ortiz");
    assert_eq!(list_students(&connection, "maya").unwrap().len(), 1);

    let session = create_session(
        &connection,
        &super::models::SessionInput {
            student_id: Some(student.id.clone()),
            title: "Linear equations".to_owned(),
            subject: "Algebra".to_owned(),
            scheduled_at: None,
            started_at: Some(1),
            ended_at: None,
            status: "active".to_owned(),
            notes: "Worked through signs.".to_owned(),
        },
    )
    .unwrap();
    assert_eq!(
        get_session(&connection, &session.id).unwrap().student_name,
        "Maya Ortiz"
    );

    create_journal(
        &connection,
        &super::models::JournalInput {
            session_id: Some(session.id.clone()),
            student_id: Some(student.id.clone()),
            entry_date: "2026-11-05".to_owned(),
            title: "Sign change".to_owned(),
            body: "Maya explained the sign change correctly.".to_owned(),
        },
    )
    .unwrap();
    let hits = super::search::search(&connection, "sign change", 10).unwrap();
    assert!(hits.iter().any(|hit| hit.entity_type == "journal"));

    create_observation(
        &connection,
        &ObservationInput {
            session_id: Some(session.id.clone()),
            student_id: Some(student.id),
            kind: "student-mistake".to_owned(),
            priority: "high".to_owned(),
            start_us: 0,
            end_us: 10,
            title: "Sign".to_owned(),
            body: "Check the sign.".to_owned(),
        },
    )
    .unwrap();
    assert_eq!(list_cues(&connection, &session.id, 10).unwrap().len(), 0);
}

#[test]
fn schedules_recurring_sessions_and_materializes_them() {
    let mut connection = workspace();
    let student = create_student(
        &connection,
        &StudentInput {
            display_name: "Maya".to_owned(),
            year: String::new(),
            subjects: vec![],
            goals: vec![],
            notes: String::new(),
        },
    )
    .unwrap();
    let start = super::models::now_ms() + 86_400_000;
    create_schedule(
        &mut connection,
        &super::models::ScheduleInput {
            student_id: Some(student.id),
            title: "Weekly algebra".to_owned(),
            subject: "Algebra".to_owned(),
            start_at: start,
            duration_min: 60,
            recurrence: "weekly".to_owned(),
            recurrence_interval: 1,
            recurrence_until: None,
            location: String::new(),
            notes: String::new(),
        },
    )
    .unwrap();
    materialize_sessions(&mut connection).unwrap();
    let events = list_schedule(&connection, None, None, 100).unwrap();
    assert_eq!(events.len(), 1);
    let sessions = super::repo::list_sessions(&connection, None, None, 100).unwrap();
    assert!(!sessions.is_empty());
}

#[test]
fn encrypted_workspaces_require_the_key() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("encrypted.tutor");
    {
        let connection = Connection::open(&path).unwrap();
        super::set_key(&connection, "correct horse battery staple").unwrap();
        super::repo::apply_connection_pragmas(&connection).unwrap();
        super::repo::initialize_workspace(&connection, "Encrypted", "", true).unwrap();
        create_student(
            &connection,
            &StudentInput {
                display_name: "Maya".to_owned(),
                year: String::new(),
                subjects: vec![],
                goals: vec![],
                notes: String::new(),
            },
        )
        .unwrap();
        connection
            .execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
            .unwrap();
    }
    assert!(!super::database_has_plain_sqlite_header(&path));
    let without_key = Connection::open(&path).unwrap();
    assert!(super::verify_readable(&without_key).is_err());
    drop(without_key);
    let with_key = Connection::open(&path).unwrap();
    super::set_key(&with_key, "correct horse battery staple").unwrap();
    assert!(super::verify_readable(&with_key).is_ok());
    assert_eq!(list_students(&with_key, "").unwrap().len(), 1);
}

#[test]
fn imports_and_reads_material_bytes() {
    let mut connection = workspace();
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("worksheet.txt");
    std::fs::write(&path, b"fractions worksheet").unwrap();
    let material =
        import_material_file(&mut connection, path.to_str().unwrap(), None, None).unwrap();
    assert_eq!(material.status, "ready");
    let bytes = super::materials::read_material(&connection, &material.id, 1024).unwrap();
    assert_eq!(bytes, b"fractions worksheet");
}

#[test]
fn connects_and_removes_evidence_links() {
    let connection = workspace();
    let student = create_student(
        &connection,
        &StudentInput {
            display_name: "Maya Ortiz".to_owned(),
            year: String::new(),
            subjects: vec![],
            goals: vec![],
            notes: String::new(),
        },
    )
    .unwrap();
    let input = |statement: &str| EvidenceInput {
        student_id: Some(student.id.clone()),
        session_id: None,
        source_type: "manual".to_owned(),
        source_id: String::new(),
        kind: "observation".to_owned(),
        statement: statement.to_owned(),
        status: "approved".to_owned(),
    };
    let first = create_evidence(&connection, &input("Solves two-step equations.")).unwrap();
    let second = create_evidence(&connection, &input("Explains inverse operations.")).unwrap();
    let link = create_evidence_link(
        &connection,
        &EvidenceLinkInput {
            from_id: first.id.clone(),
            to_id: second.id.clone(),
            relationship: "builds-on".to_owned(),
        },
    )
    .unwrap();
    assert_eq!(link.relationship, "builds-on");

    let graph = evidence_graph(&connection, &student.id, "").unwrap();
    assert_eq!(graph.nodes.len(), 2);
    assert_eq!(graph.links.len(), 1);

    assert!(create_evidence_link(
        &connection,
        &EvidenceLinkInput {
            from_id: first.id.clone(),
            to_id: first.id,
            relationship: "supports".to_owned(),
        },
    )
    .is_err());

    delete_evidence_link(&connection, &link.id).unwrap();
    assert!(evidence_graph(&connection, &student.id, "")
        .unwrap()
        .links
        .is_empty());
}

#[test]
fn exports_and_imports_a_session_package() {
    let mut connection = workspace();
    let directory = tempfile::tempdir().unwrap();
    let student = create_student(
        &connection,
        &StudentInput {
            display_name: "Maya Ortiz".to_owned(),
            year: "Year 10".to_owned(),
            subjects: vec!["Algebra".to_owned()],
            goals: vec![],
            notes: String::new(),
        },
    )
    .unwrap();
    let session = create_session(
        &connection,
        &super::models::SessionInput {
            student_id: None,
            title: "Linear equations".to_owned(),
            subject: "Algebra".to_owned(),
            scheduled_at: None,
            started_at: Some(1),
            ended_at: None,
            status: "planned".to_owned(),
            notes: "Transfer package".to_owned(),
        },
    )
    .unwrap();
    create_journal(
        &connection,
        &super::models::JournalInput {
            session_id: Some(session.id.clone()),
            student_id: Some(student.id.clone()),
            entry_date: "2026-11-05".to_owned(),
            title: "Sign change".to_owned(),
            body: "Maya explained the sign change.".to_owned(),
        },
    )
    .unwrap();
    let worksheet = directory.path().join("worksheet.txt");
    std::fs::write(&worksheet, b"fractions worksheet").unwrap();
    import_material_file(
        &mut connection,
        worksheet.to_str().unwrap(),
        Some(session.id.clone()),
        Some(student.id.clone()),
    )
    .unwrap();
    create_evidence(
        &connection,
        &EvidenceInput {
            student_id: Some(student.id.clone()),
            session_id: Some(session.id.clone()),
            source_type: "session".to_owned(),
            source_id: session.id.clone(),
            kind: "skill".to_owned(),
            statement: "Explains equal parts.".to_owned(),
            status: "approved".to_owned(),
        },
    )
    .unwrap();
    super::recordings::import_recording_tracks(
        &mut connection,
        &session.id,
        "Tracked",
        "microphone+system",
        48_000,
        1,
        1_000_000,
        &[
            RecordingTrackInput {
                track: "mixed".to_owned(),
                sample_rate: 48_000,
                channels: 1,
                bytes: vec![1, 2, 3],
            },
            RecordingTrackInput {
                track: "microphone".to_owned(),
                sample_rate: 48_000,
                channels: 1,
                bytes: vec![4, 5],
            },
        ],
    )
    .unwrap();

    let package = directory.path().join("lesson.tutorpkg");
    let exported =
        super::packages::export_session(&connection, &session.id, package.to_str().unwrap())
            .unwrap();
    assert!(exported.bytes > 0);

    let mut target = workspace();
    let imported = super::packages::import_session(&mut target, package.to_str().unwrap()).unwrap();
    assert_eq!(imported.title, "Linear equations");
    assert_eq!(
        super::content::list_journal(&target, &imported.session_id)
            .unwrap()
            .len(),
        1
    );
    let materials =
        super::materials::list_materials(&target, &imported.session_id, "", "").unwrap();
    assert_eq!(materials.len(), 1);
    assert_eq!(
        super::materials::read_material(&target, &materials[0].id, 1024).unwrap(),
        b"fractions worksheet"
    );
    let imported_evidence =
        super::content::list_evidence(&target, "", &imported.session_id).unwrap();
    assert_eq!(imported_evidence.len(), 1);
    assert_eq!(imported_evidence[0].source_id, imported.session_id);
    let imported_student_id = imported_evidence[0].student_id.clone().unwrap();
    assert_eq!(
        super::repo::get_student(&target, &imported_student_id)
            .unwrap()
            .display_name,
        "Maya Ortiz"
    );
}

#[test]
fn sanitized_copies_remove_private_content() {
    let connection = workspace();
    let directory = tempfile::tempdir().unwrap();
    let student = create_student(
        &connection,
        &StudentInput {
            display_name: "Maya Ortiz".to_owned(),
            year: "Year 10".to_owned(),
            subjects: vec![],
            goals: vec!["Fractions".to_owned()],
            notes: "Private note".to_owned(),
        },
    )
    .unwrap();
    let session = create_session(
        &connection,
        &super::models::SessionInput {
            student_id: Some(student.id.clone()),
            title: "Linear equations".to_owned(),
            subject: "Algebra".to_owned(),
            scheduled_at: None,
            started_at: Some(1),
            ended_at: None,
            status: "planned".to_owned(),
            notes: "Private session note".to_owned(),
        },
    )
    .unwrap();
    create_journal(
        &connection,
        &super::models::JournalInput {
            session_id: Some(session.id),
            student_id: Some(student.id.clone()),
            entry_date: "2026-11-05".to_owned(),
            title: "Private title".to_owned(),
            body: "Private body".to_owned(),
        },
    )
    .unwrap();
    let destination = directory.path().join("shared.tutor");
    super::maintenance::sanitized_copy(&connection, destination.to_str().unwrap(), None).unwrap();
    let sanitized = Connection::open(&destination).unwrap();
    let name: String = sanitized
        .query_row(
            "SELECT display_name FROM students WHERE id = ?1",
            [&student.id],
            |row| row.get(0),
        )
        .unwrap();
    assert!(name.starts_with("Student "));
    let journals: i64 = sanitized
        .query_row("SELECT COUNT(*) FROM journal_entries", [], |row| row.get(0))
        .unwrap();
    assert_eq!(journals, 0);
    let private_hits = super::search::search(&sanitized, "private", 10).unwrap();
    assert!(private_hits.is_empty());
}

#[test]
fn stores_and_reads_separate_recording_tracks() {
    let mut connection = workspace();
    let student = create_student(
        &connection,
        &StudentInput {
            display_name: "Maya Ortiz".to_owned(),
            year: String::new(),
            subjects: vec![],
            goals: vec![],
            notes: String::new(),
        },
    )
    .unwrap();
    let session = create_session(
        &connection,
        &super::models::SessionInput {
            student_id: Some(student.id),
            title: "Linear equations".to_owned(),
            subject: "Algebra".to_owned(),
            scheduled_at: None,
            started_at: Some(1),
            ended_at: None,
            status: "active".to_owned(),
            notes: String::new(),
        },
    )
    .unwrap();
    let recording = super::recordings::import_recording_tracks(
        &mut connection,
        &session.id,
        "Tracked",
        "microphone+system",
        48_000,
        1,
        1_000_000,
        &[
            RecordingTrackInput {
                track: "mixed".to_owned(),
                sample_rate: 48_000,
                channels: 1,
                bytes: vec![1, 2, 3, 4],
            },
            RecordingTrackInput {
                track: "microphone".to_owned(),
                sample_rate: 48_000,
                channels: 1,
                bytes: vec![5, 6],
            },
            RecordingTrackInput {
                track: "system".to_owned(),
                sample_rate: 48_000,
                channels: 1,
                bytes: vec![7, 8, 9],
            },
        ],
    )
    .unwrap();
    assert_eq!(recording.tracks.len(), 3);
    assert_eq!(
        super::recordings::read_recording_track(&connection, &recording.id, "system").unwrap(),
        vec![7, 8, 9]
    );
    assert_eq!(
        super::recordings::read_recording(&connection, &recording.id).unwrap(),
        vec![1, 2, 3, 4]
    );
}

#[test]
fn returns_lessons_due_within_the_lead_window() {
    let mut connection = workspace();
    let start = super::models::now_ms() + 10 * 60_000;
    create_schedule(
        &mut connection,
        &super::models::ScheduleInput {
            student_id: None,
            title: "Algebra check-in".to_owned(),
            subject: "Algebra".to_owned(),
            start_at: start,
            duration_min: 60,
            recurrence: String::new(),
            recurrence_interval: 1,
            recurrence_until: None,
            location: String::new(),
            notes: String::new(),
        },
    )
    .unwrap();
    let due = super::reminders::due_reminders(&connection, 15).unwrap();
    assert_eq!(due.len(), 1);
    assert_eq!(due[0].entity_type, "session");
    assert_eq!(due[0].title, "Algebra check-in");
    assert!(super::reminders::due_reminders(&connection, 5)
        .unwrap()
        .is_empty());
}

#[test]
#[ignore = "qualification writes a large workspace; set TUTORUX_QUALIFY_GB"]
fn qualifies_a_large_workspace() {
    use uuid::Uuid;

    let gigabytes: u64 = std::env::var("TUTORUX_QUALIFY_GB")
        .expect("Set TUTORUX_QUALIFY_GB to the workspace size to qualify")
        .parse()
        .expect("TUTORUX_QUALIFY_GB must be an integer");
    assert!(gigabytes > 0, "TUTORUX_QUALIFY_GB must be at least 1");
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("qualified.tutor");
    let connection = Connection::open(&path).unwrap();
    super::repo::apply_connection_pragmas(&connection).unwrap();
    super::repo::initialize_workspace(&connection, "Qualification", "", false).unwrap();
    let student = create_student(
        &connection,
        &StudentInput {
            display_name: "Scale Student".to_owned(),
            year: String::new(),
            subjects: vec![],
            goals: vec![],
            notes: String::new(),
        },
    )
    .unwrap();
    let session = create_session(
        &connection,
        &super::models::SessionInput {
            student_id: Some(student.id.clone()),
            title: "Scale session".to_owned(),
            subject: "Scale".to_owned(),
            scheduled_at: None,
            started_at: Some(super::models::now_ms()),
            ended_at: None,
            status: "active".to_owned(),
            notes: String::new(),
        },
    )
    .unwrap();
    let material_id = Uuid::new_v4().to_string();
    connection
        .execute(
            "INSERT INTO materials (id, session_id, student_id, kind, filename, mime_type,
             byte_size, title, notes, status, created_at, updated_at)
             VALUES (?1, ?2, ?3, 'file', 'scale.bin', 'application/octet-stream', 0,
             'scale.bin', '', 'importing', ?4, ?4)",
            rusqlite::params![material_id, session.id, student.id, super::models::now_ms()],
        )
        .unwrap();
    let chunk_size = 4 * 1024 * 1024usize;
    let chunks = (gigabytes * 1024 / 4).max(1);
    let mut state = 0x243f_6a88_85a3_08d3u64;
    for index in 0..chunks {
        let mut bytes = vec![0u8; chunk_size];
        for byte in &mut bytes {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            *byte = (state & 0xff) as u8;
        }
        bytes[..8].copy_from_slice(&index.to_le_bytes());
        let stored = super::blob::put_blob(&connection, &bytes).unwrap();
        connection
            .execute(
                "INSERT INTO material_chunks (material_id, chunk_no, hash, original_size)
                 VALUES (?1, ?2, ?3, ?4)",
                rusqlite::params![material_id, index as i64, stored.hash, stored.original_size],
            )
            .unwrap();
    }
    let bytes = std::fs::metadata(&path).unwrap().len();
    assert!(bytes >= gigabytes * 1024 * 1024 * 1024 / 2);
    let started = std::time::Instant::now();
    let check = super::backup::integrity_check(&connection).unwrap();
    assert_eq!(check, "ok");
    let materials = super::materials::list_materials(&connection, &session.id, "", "").unwrap();
    assert_eq!(materials.len(), 1);
    eprintln!(
        "qualified {} GiB in {:?}: file={} bytes",
        gigabytes,
        started.elapsed(),
        bytes
    );
}

#[test]
fn encrypted_sanitized_copies_remain_encrypted() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("source.tutor");
    let copy = directory.path().join("shared.tutor");
    let key = "correct horse battery staple";
    {
        let connection = Connection::open(&path).unwrap();
        super::set_key(&connection, key).unwrap();
        super::repo::apply_connection_pragmas(&connection).unwrap();
        super::repo::initialize_workspace(&connection, "Encrypted", "", true).unwrap();
        let student = create_student(
            &connection,
            &StudentInput {
                display_name: "Maya Ortiz".to_owned(),
                year: String::new(),
                subjects: vec![],
                goals: vec![],
                notes: "Private note".to_owned(),
            },
        )
        .unwrap();
        create_journal(
            &connection,
            &super::models::JournalInput {
                session_id: None,
                student_id: Some(student.id),
                entry_date: "2026-11-05".to_owned(),
                title: "Private".to_owned(),
                body: "Private body".to_owned(),
            },
        )
        .unwrap();
        super::maintenance::sanitized_copy(&connection, copy.to_str().unwrap(), Some(key)).unwrap();
        connection
            .execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
            .unwrap();
    }
    assert!(!super::database_has_plain_sqlite_header(&copy));
    let sanitized = Connection::open(&copy).unwrap();
    super::set_key(&sanitized, key).unwrap();
    assert!(super::verify_readable(&sanitized).is_ok());
    let name: String = sanitized
        .query_row("SELECT display_name FROM students LIMIT 1", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert!(name.starts_with("Student "));
    let journals: i64 = sanitized
        .query_row("SELECT COUNT(*) FROM journal_entries", [], |row| row.get(0))
        .unwrap();
    assert_eq!(journals, 0);
}

#[test]
fn exports_session_packages_from_encrypted_workspaces() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("source.tutor");
    let package = directory.path().join("lesson.tutorpkg");
    let key = "correct horse battery staple";
    let session_id;
    {
        let connection = Connection::open(&path).unwrap();
        super::set_key(&connection, key).unwrap();
        super::repo::apply_connection_pragmas(&connection).unwrap();
        super::repo::initialize_workspace(&connection, "Encrypted", "", true).unwrap();
        let student = create_student(
            &connection,
            &StudentInput {
                display_name: "Maya Ortiz".to_owned(),
                year: String::new(),
                subjects: vec![],
                goals: vec![],
                notes: String::new(),
            },
        )
        .unwrap();
        let session = create_session(
            &connection,
            &super::models::SessionInput {
                student_id: Some(student.id),
                title: "Encrypted lesson".to_owned(),
                subject: "Algebra".to_owned(),
                scheduled_at: None,
                started_at: Some(1),
                ended_at: None,
                status: "planned".to_owned(),
                notes: String::new(),
            },
        )
        .unwrap();
        session_id = session.id;
        super::packages::export_session(&connection, &session_id, package.to_str().unwrap())
            .unwrap();
    }
    let package_connection = Connection::open(&package).unwrap();
    let packaged: String = package_connection
        .query_row(
            "SELECT value FROM meta WHERE key = 'package_session_id'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(packaged, session_id);
    drop(package_connection);

    let target_path = directory.path().join("target.tutor");
    let mut target = Connection::open(&target_path).unwrap();
    super::set_key(&target, key).unwrap();
    super::repo::apply_connection_pragmas(&target).unwrap();
    super::repo::initialize_workspace(&target, "Target", "", true).unwrap();
    let imported = super::packages::import_session(&mut target, package.to_str().unwrap()).unwrap();
    assert_eq!(imported.title, "Encrypted lesson");
}

#[test]
fn migrates_version_one_workspaces() {
    let connection = Connection::open_in_memory().unwrap();
    connection
        .execute_batch(
            "PRAGMA application_id = 0x54555452;
             CREATE TABLE schedule_events (
                 id TEXT PRIMARY KEY,
                 student_id TEXT,
                 title TEXT NOT NULL,
                 subject TEXT NOT NULL DEFAULT '',
                 start_at INTEGER NOT NULL,
                 duration_min INTEGER NOT NULL DEFAULT 60,
                 recurrence TEXT NOT NULL DEFAULT '',
                 location TEXT NOT NULL DEFAULT '',
                 notes TEXT NOT NULL DEFAULT '',
                 calendar_provider TEXT NOT NULL DEFAULT 'internal',
                 calendar_account_id TEXT,
                 external_id TEXT,
                 external_etag TEXT,
                 deleted_at INTEGER,
                 created_at INTEGER NOT NULL,
                 updated_at INTEGER NOT NULL
             ) STRICT;
             PRAGMA user_version = 1;",
        )
        .unwrap();
    migrate_workspace(&connection).unwrap();
    let columns: Vec<String> = connection
        .prepare("PRAGMA table_info(schedule_events)")
        .unwrap()
        .query_map([], |row| row.get(1))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    assert!(columns.contains(&"recurrence_interval".to_owned()));
    assert!(columns.contains(&"recurrence_until".to_owned()));
    let version: i64 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap();
    assert_eq!(version, 2);
}

#[test]
fn recurrence_interval_and_until_limit_materialized_sessions() {
    let mut connection = workspace();
    let start = super::models::now_ms() + 86_400_000;
    let until = start + 4 * 7 * 86_400_000;
    let event = create_schedule(
        &mut connection,
        &super::models::ScheduleInput {
            student_id: None,
            title: "Every other week".to_owned(),
            subject: "Algebra".to_owned(),
            start_at: start,
            duration_min: 60,
            recurrence: "weekly".to_owned(),
            recurrence_interval: 2,
            recurrence_until: Some(until),
            location: String::new(),
            notes: String::new(),
        },
    )
    .unwrap();
    materialize_sessions(&mut connection).unwrap();
    let count: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM sessions WHERE schedule_event_id = ?1 AND deleted_at IS NULL",
            [event.id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(count, 3);
}

#[test]
fn detects_overlapping_schedule_events() {
    let mut connection = workspace();
    let start = super::models::now_ms() + 86_400_000;
    let first = create_schedule(
        &mut connection,
        &super::models::ScheduleInput {
            student_id: None,
            title: "First".to_owned(),
            subject: String::new(),
            start_at: start,
            duration_min: 60,
            recurrence: String::new(),
            recurrence_interval: 1,
            recurrence_until: None,
            location: String::new(),
            notes: String::new(),
        },
    )
    .unwrap();
    let overlapping = super::models::ScheduleInput {
        student_id: None,
        title: "Second".to_owned(),
        subject: String::new(),
        start_at: start + 30 * 60_000,
        duration_min: 60,
        recurrence: String::new(),
        recurrence_interval: 1,
        recurrence_until: None,
        location: String::new(),
        notes: String::new(),
    };
    let conflicts = find_conflicts(&connection, &overlapping, None).unwrap();
    assert_eq!(conflicts.len(), 1);
    assert_eq!(conflicts[0].event_id, first.id);
    assert!(find_conflicts(&connection, &overlapping, Some(&first.id))
        .unwrap()
        .is_empty());
    let adjacent = super::models::ScheduleInput {
        start_at: start + 60 * 60_000,
        ..overlapping
    };
    assert!(find_conflicts(&connection, &adjacent, None)
        .unwrap()
        .is_empty());
}

#[test]
fn salvages_readable_rows_into_a_new_workspace() {
    let directory = tempfile::tempdir().unwrap();
    let source_path = directory.path().join("source.tutor");
    let source = Connection::open(&source_path).unwrap();
    super::repo::apply_connection_pragmas(&source).unwrap();
    initialize_workspace(&source, "Source", "", false).unwrap();
    let student = create_student(
        &source,
        &StudentInput {
            display_name: "Maya Ortiz".to_owned(),
            year: "Year 10".to_owned(),
            subjects: vec!["Algebra".to_owned()],
            goals: vec![],
            notes: "Keep this".to_owned(),
        },
    )
    .unwrap();
    drop(source);
    let destination = directory.path().join("recovered.tutor");
    let report = salvage_workspace(&source_path, destination.to_str().unwrap()).unwrap();
    assert!(report.copied_rows > 0);
    assert_eq!(report.integrity, "ok");
    let recovered = Connection::open(&destination).unwrap();
    let students = list_students(&recovered, "").unwrap();
    assert_eq!(students.len(), 1);
    assert_eq!(students[0].display_name, student.display_name);
}
