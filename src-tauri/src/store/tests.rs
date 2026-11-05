use rusqlite::Connection;

use super::{
    content::{create_journal, create_observation, list_cues},
    materials::import_material_file,
    models::{ObservationInput, StudentInput},
    repo::{create_session, create_student, get_session, initialize_workspace, list_students},
    schedule::{create_schedule, list_schedule, materialize_sessions},
    schema::SCHEMA_SQL,
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
