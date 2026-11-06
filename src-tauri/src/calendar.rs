use std::{
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    time::{Duration, Instant},
};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD as BASE64, Engine as _};
use chrono::{DateTime, TimeZone, Utc};
use keyring::{Entry, Error as KeyringError};
use reqwest::{redirect::Policy, Client, Url};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::store::{
    models::{now_ms, CalendarAccount, CalendarSyncResult},
    repo::touch_workspace_public,
};

const KEYRING_SERVICE: &str = "app.tutorux.calendar";
const CLIENT_KEYRING_SERVICE: &str = "app.tutorux.calendar.client";
const OAUTH_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarClientStatus {
    pub provider: String,
    pub has_client_id: bool,
    pub has_client_secret: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarTokens {
    pub access_token: String,
    #[serde(default)]
    pub refresh_token: String,
    pub expires_at: i64,
}

#[derive(Debug, Clone)]
struct ProviderConfig {
    auth_url: &'static str,
    token_url: &'static str,
    scope: &'static str,
    userinfo_url: &'static str,
    extra_auth: &'static [(&'static str, &'static str)],
}

fn provider_config(provider: &str) -> Result<ProviderConfig, String> {
    match provider {
        "google" => Ok(ProviderConfig {
            auth_url: "https://accounts.google.com/o/oauth2/v2/auth",
            token_url: "https://oauth2.googleapis.com/token",
            scope: "https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/userinfo.email",
            userinfo_url: "https://www.googleapis.com/oauth2/v2/userinfo",
            extra_auth: &[("access_type", "offline"), ("prompt", "consent")],
        }),
        "microsoft" => Ok(ProviderConfig {
            auth_url: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
            token_url: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
            scope: "offline_access Calendars.Read User.Read",
            userinfo_url: "https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName",
            extra_auth: &[("response_mode", "query")],
        }),
        _ => Err("Choose Google Calendar or Microsoft Outlook.".to_owned()),
    }
}

fn setting_key(provider: &str) -> String {
    format!("calendar_{provider}_client_id")
}

fn client_entry(provider: &str) -> Result<Entry, String> {
    Entry::new(CLIENT_KEYRING_SERVICE, provider).map_err(|_| {
        "The operating system credential store is unavailable for calendar setup.".to_owned()
    })
}

fn token_entry(credential_key: &str) -> Result<Entry, String> {
    Entry::new(KEYRING_SERVICE, credential_key).map_err(|_| {
        "The operating system credential store is unavailable for calendar tokens.".to_owned()
    })
}

pub fn client_status(conn: &Connection, provider: &str) -> Result<CalendarClientStatus, String> {
    let client_id: Option<String> = conn
        .query_row(
            "SELECT value FROM settings WHERE key = ?1",
            params![setting_key(provider)],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("Could not read calendar settings: {error}"))?;
    let has_client_secret = match client_entry(provider)?.get_password() {
        Ok(value) => !value.is_empty(),
        Err(KeyringError::NoEntry) => false,
        Err(_) => false,
    };
    Ok(CalendarClientStatus {
        provider: provider.to_owned(),
        has_client_id: client_id.is_some_and(|value| !value.trim().is_empty()),
        has_client_secret,
    })
}

pub fn save_client(
    conn: &Connection,
    provider: &str,
    client_id: &str,
    client_secret: Option<&str>,
) -> Result<CalendarClientStatus, String> {
    provider_config(provider)?;
    let client_id = client_id.trim();
    if client_id.is_empty() {
        return Err("Enter the OAuth client ID from the provider console.".to_owned());
    }
    if client_id.len() > 512 {
        return Err("That OAuth client ID is too long.".to_owned());
    }
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![setting_key(provider), client_id],
    )
    .map_err(|error| format!("Could not save the calendar client ID: {error}"))?;
    if let Some(secret) = client_secret
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        client_entry(provider)?
            .set_password(secret)
            .map_err(|_| "The calendar client secret could not be saved.".to_owned())?;
    } else {
        match client_entry(provider)?.delete_credential() {
            Ok(()) | Err(KeyringError::NoEntry) => {}
            Err(_) => return Err("The calendar client secret could not be cleared.".to_owned()),
        }
    }
    touch_workspace_public(conn)?;
    client_status(conn, provider)
}

pub fn client_credentials(
    conn: &Connection,
    provider: &str,
) -> Result<(String, Option<String>), String> {
    provider_config(provider)?;
    let client_id: Option<String> = conn
        .query_row(
            "SELECT value FROM settings WHERE key = ?1",
            params![setting_key(provider)],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("Could not read calendar settings: {error}"))?;
    let client_id = client_id
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "Save an OAuth client ID before connecting a calendar.".to_owned())?;
    let secret = match client_entry(provider)?.get_password() {
        Ok(value) if !value.is_empty() => Some(value),
        _ => None,
    };
    Ok((client_id, secret))
}

pub struct OAuthSession {
    pub url: String,
    redirect_uri: String,
    state: String,
    verifier: String,
    listener: TcpListener,
}

impl OAuthSession {
    pub fn wait(self) -> Result<String, String> {
        self.listener
            .set_nonblocking(true)
            .map_err(|error| format!("Could not prepare the calendar callback: {error}"))?;
        let deadline = Instant::now() + OAUTH_TIMEOUT;
        while Instant::now() < deadline {
            match self.listener.accept() {
                Ok((mut stream, _)) => {
                    let request = read_request(&mut stream);
                    let target = request
                        .lines()
                        .next()
                        .and_then(|line| line.split_whitespace().nth(1))
                        .unwrap_or("/");
                    let callback = Url::parse(&format!("http://127.0.0.1{target}"))
                        .map_err(|_| "The calendar callback was invalid.".to_owned())?;
                    if callback.path() != "/callback" {
                        respond(&mut stream, 404, "Not found");
                        continue;
                    }
                    let params: std::collections::HashMap<String, String> =
                        callback.query_pairs().into_owned().collect();
                    if params.get("state") != Some(&self.state) {
                        respond(
                            &mut stream,
                            400,
                            "State mismatch. Close this tab and try again.",
                        );
                        continue;
                    }
                    if let Some(error) = params.get("error") {
                        respond(&mut stream, 400, "Calendar access was not granted.");
                        return Err(format!("Calendar authorization failed: {error}"));
                    }
                    if let Some(code) = params.get("code") {
                        respond(
                            &mut stream,
                            200,
                            "Calendar connected. You can close this window and return to Tutorux.",
                        );
                        return Ok(code.clone());
                    }
                    respond(&mut stream, 400, "The callback did not include a code.");
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(120));
                }
                Err(error) => return Err(format!("The calendar callback failed: {error}")),
            }
        }
        Err("Calendar authorization timed out. Try connecting again.".to_owned())
    }

    pub fn redirect_uri(&self) -> &str {
        &self.redirect_uri
    }

    pub fn verifier(&self) -> &str {
        &self.verifier
    }
}

fn read_request(stream: &mut TcpStream) -> String {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let mut buffer = [0u8; 16 * 1024];
    let read = stream.read(&mut buffer).unwrap_or(0);
    String::from_utf8_lossy(&buffer[..read]).into_owned()
}

fn respond(stream: &mut TcpStream, status: u16, message: &str) {
    let body = format!(
        "<!doctype html><html><body style=\"font-family:sans-serif;padding:3rem\"><p>{message}</p></body></html>"
    );
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        404 => "Not Found",
        _ => "Error",
    };
    let response = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.flush();
}

pub fn begin_oauth(provider: &str, client_id: &str) -> Result<OAuthSession, String> {
    let config = provider_config(provider)?;
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .map_err(|error| format!("Could not start the calendar callback listener: {error}"))?;
    let port = listener
        .local_addr()
        .map_err(|error| format!("Could not read the calendar callback address: {error}"))?
        .port();
    let redirect_uri = format!("http://127.0.0.1:{port}/callback");
    let state = Uuid::new_v4().simple().to_string();
    let verifier = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let challenge = BASE64.encode(Sha256::digest(verifier.as_bytes()));
    let mut url = Url::parse(config.auth_url)
        .map_err(|error| format!("Could not build the calendar authorization URL: {error}"))?;
    {
        let mut query = url.query_pairs_mut();
        query
            .append_pair("client_id", client_id)
            .append_pair("redirect_uri", &redirect_uri)
            .append_pair("response_type", "code")
            .append_pair("scope", config.scope)
            .append_pair("state", &state)
            .append_pair("code_challenge", &challenge)
            .append_pair("code_challenge_method", "S256");
        for (key, value) in config.extra_auth {
            query.append_pair(key, value);
        }
    }
    Ok(OAuthSession {
        url: url.into(),
        redirect_uri,
        state,
        verifier,
        listener,
    })
}

fn oauth_client() -> Result<Client, String> {
    Client::builder()
        .redirect(Policy::none())
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|error| format!("Could not prepare the calendar connection: {error}"))
}

pub async fn exchange_code(
    provider: &str,
    client_id: &str,
    client_secret: Option<&str>,
    code: &str,
    redirect_uri: &str,
    verifier: &str,
) -> Result<CalendarTokens, String> {
    let config = provider_config(provider)?;
    let mut form = vec![
        ("client_id", client_id),
        ("code", code),
        ("code_verifier", verifier),
        ("grant_type", "authorization_code"),
        ("redirect_uri", redirect_uri),
    ];
    if let Some(secret) = client_secret {
        form.push(("client_secret", secret));
    }
    request_tokens(config.token_url, &form).await
}

pub async fn refresh_tokens(
    provider: &str,
    client_id: &str,
    client_secret: Option<&str>,
    tokens: &CalendarTokens,
) -> Result<CalendarTokens, String> {
    if tokens.refresh_token.is_empty() {
        return Err("The calendar session expired. Connect the account again.".to_owned());
    }
    let config = provider_config(provider)?;
    let mut form = vec![
        ("client_id", client_id),
        ("refresh_token", tokens.refresh_token.as_str()),
        ("grant_type", "refresh_token"),
    ];
    if let Some(secret) = client_secret {
        form.push(("client_secret", secret));
    }
    let mut refreshed = request_tokens(config.token_url, &form).await?;
    if refreshed.refresh_token.is_empty() {
        refreshed.refresh_token = tokens.refresh_token.clone();
    }
    Ok(refreshed)
}

async fn request_tokens(token_url: &str, form: &[(&str, &str)]) -> Result<CalendarTokens, String> {
    let response = oauth_client()?
        .post(token_url)
        .form(form)
        .send()
        .await
        .map_err(|error| format!("Could not reach the calendar token service: {error}"))?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|error| format!("Could not read the calendar token response: {error}"))?;
    if !status.is_success() {
        return Err(format!(
            "The calendar provider rejected the connection ({status}): {}",
            body.chars().take(300).collect::<String>()
        ));
    }
    let value: Value = serde_json::from_str(&body)
        .map_err(|error| format!("The calendar token response was invalid: {error}"))?;
    let access_token = value["access_token"]
        .as_str()
        .ok_or_else(|| "The calendar provider did not return an access token.".to_owned())?
        .to_owned();
    let refresh_token = value["refresh_token"].as_str().unwrap_or("").to_owned();
    let expires_in = value["expires_in"].as_i64().unwrap_or(3600).max(60);
    Ok(CalendarTokens {
        access_token,
        refresh_token,
        expires_at: now_ms() + expires_in * 1000,
    })
}

pub async fn fetch_email(provider: &str, access_token: &str) -> Result<String, String> {
    let config = provider_config(provider)?;
    let response = oauth_client()?
        .get(config.userinfo_url)
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|error| format!("Could not read the calendar account: {error}"))?;
    let value: Value = response
        .json()
        .await
        .map_err(|error| format!("The calendar account response was invalid: {error}"))?;
    Ok(value["email"]
        .as_str()
        .or_else(|| value["mail"].as_str())
        .or_else(|| value["userPrincipalName"].as_str())
        .unwrap_or("Calendar account")
        .to_owned())
}

fn token_key(account_id: &str) -> String {
    format!("account:{account_id}")
}

pub fn save_tokens(account_id: &str, tokens: &CalendarTokens) -> Result<(), String> {
    let encoded = serde_json::to_string(tokens)
        .map_err(|error| format!("Could not encode calendar tokens: {error}"))?;
    token_entry(&token_key(account_id))?
        .set_password(&encoded)
        .map_err(|_| "The calendar tokens could not be saved to the system keychain.".to_owned())
}

pub fn load_tokens(credential_key: &str) -> Result<CalendarTokens, String> {
    let encoded = token_entry(credential_key)?.get_password().map_err(|_| {
        "The calendar tokens could not be read from the system keychain.".to_owned()
    })?;
    serde_json::from_str(&encoded)
        .map_err(|error| format!("The saved calendar tokens are invalid: {error}"))
}

pub fn remove_tokens(credential_key: &str) -> Result<(), String> {
    match token_entry(credential_key)?.delete_credential() {
        Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
        Err(_) => Err("The calendar tokens could not be removed.".to_owned()),
    }
}

pub fn save_account(
    conn: &Connection,
    provider: &str,
    account_email: &str,
    tokens: &CalendarTokens,
) -> Result<CalendarAccount, String> {
    provider_config(provider)?;
    let existing: Option<String> = conn
        .query_row(
            "SELECT id FROM calendar_accounts
             WHERE provider = ?1 AND account_email = ?2 AND deleted_at IS NULL",
            params![provider, account_email],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("Could not read the calendar account: {error}"))?;
    let is_existing = existing.is_some();
    let id = existing.unwrap_or_else(|| Uuid::new_v4().to_string());
    let now = now_ms();
    save_tokens(&id, tokens)?;
    if let Err(error) = conn.execute(
        "INSERT INTO calendar_accounts (id, provider, account_email, credential_key, sync_cursor,
         deleted_at, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, '', NULL, ?5, ?5)
         ON CONFLICT(id) DO UPDATE SET account_email = excluded.account_email,
            credential_key = excluded.credential_key, updated_at = excluded.updated_at",
        params![id, provider, account_email, token_key(&id), now],
    ) {
        if !is_existing {
            let _ = remove_tokens(&token_key(&id));
        }
        return Err(format!("Could not save the calendar account: {error}"));
    }
    touch_workspace_public(conn)?;
    Ok(CalendarAccount {
        id,
        provider: provider.to_owned(),
        account_email: account_email.to_owned(),
        last_sync_at: now,
        event_count: 0,
    })
}

pub fn list_accounts(conn: &Connection) -> Result<Vec<CalendarAccount>, String> {
    let mut statement = conn
        .prepare(
            "SELECT a.id, a.provider, a.account_email, a.updated_at,
             (SELECT COUNT(*) FROM schedule_events e
              WHERE e.calendar_account_id = a.id AND e.deleted_at IS NULL)
             FROM calendar_accounts a WHERE a.deleted_at IS NULL ORDER BY a.created_at",
        )
        .map_err(|error| format!("Could not read calendar accounts: {error}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok(CalendarAccount {
                id: row.get(0)?,
                provider: row.get(1)?,
                account_email: row.get(2)?,
                last_sync_at: row.get(3)?,
                event_count: row.get(4)?,
            })
        })
        .map_err(|error| format!("Could not read calendar accounts: {error}"))?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| format!("Could not read calendar accounts: {error}"))
}

pub fn account_credentials(
    conn: &Connection,
    account_id: &str,
) -> Result<(String, String), String> {
    conn.query_row(
        "SELECT provider, credential_key FROM calendar_accounts
         WHERE id = ?1 AND deleted_at IS NULL",
        params![account_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
    .optional()
    .map_err(|error| format!("Could not read the calendar account: {error}"))?
    .ok_or_else(|| "The calendar account could not be found.".to_owned())
}

#[derive(Debug, Clone)]
pub struct CalendarEvent {
    pub external_id: String,
    pub title: String,
    pub start_at: i64,
    pub duration_min: i64,
    pub recurrence: String,
    pub location: String,
    pub notes: String,
    pub cancelled: bool,
    pub etag: String,
}

fn parse_rfc3339(value: &str) -> Option<i64> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|date| date.with_timezone(&Utc).timestamp_millis())
}

fn parse_graph_datetime(value: &str) -> Option<i64> {
    parse_rfc3339(value).or_else(|| {
        chrono::NaiveDateTime::parse_from_str(value, "%Y-%m-%dT%H:%M:%S%.f")
            .ok()
            .map(|date| date.and_utc().timestamp_millis())
    })
}

fn parse_date(value: &str) -> Option<i64> {
    chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d")
        .ok()
        .and_then(|date| date.and_hms_opt(0, 0, 0))
        .map(|date| date.and_utc().timestamp_millis())
}

fn trusted_microsoft_link(link: &str) -> Option<Url> {
    let url = Url::parse(link).ok()?;
    (url.scheme() == "https" && url.host_str() == Some("graph.microsoft.com")).then_some(url)
}

pub async fn fetch_events(
    provider: &str,
    access_token: &str,
    from: i64,
    to: i64,
) -> Result<Vec<CalendarEvent>, String> {
    let client = oauth_client()?;
    let (url, is_google) = match provider {
        "google" => {
            let start = DateTime::<Utc>::from_timestamp_millis(from)
                .ok_or_else(|| "The calendar start time is invalid.".to_owned())?
                .to_rfc3339();
            let end = DateTime::<Utc>::from_timestamp_millis(to)
                .ok_or_else(|| "The calendar end time is invalid.".to_owned())?
                .to_rfc3339();
            let mut url =
                Url::parse("https://www.googleapis.com/calendar/v3/calendars/primary/events")
                    .map_err(|error| format!("Could not build the calendar request: {error}"))?;
            url.query_pairs_mut()
                .append_pair("timeMin", &start)
                .append_pair("timeMax", &end)
                .append_pair("singleEvents", "true")
                .append_pair("orderBy", "startTime")
                .append_pair("maxResults", "2500");
            (url, true)
        }
        "microsoft" => {
            let start = DateTime::<Utc>::from_timestamp_millis(from)
                .ok_or_else(|| "The calendar start time is invalid.".to_owned())?
                .to_rfc3339();
            let end = DateTime::<Utc>::from_timestamp_millis(to)
                .ok_or_else(|| "The calendar end time is invalid.".to_owned())?
                .to_rfc3339();
            let mut url = Url::parse("https://graph.microsoft.com/v1.0/me/calendarView")
                .map_err(|error| format!("Could not build the calendar request: {error}"))?;
            url.query_pairs_mut()
                .append_pair("startDateTime", &start)
                .append_pair("endDateTime", &end)
                .append_pair("$top", "1000")
                .append_pair(
                    "$select",
                    "id,subject,start,end,location,bodyPreview,isCancelled",
                );
            (url, false)
        }
        _ => return Err("Choose a supported calendar provider.".to_owned()),
    };
    let base_url = url.clone();
    let mut next = Some(url);
    let mut events = Vec::new();
    let mut pages = 0;
    while let Some(url) = next.take() {
        pages += 1;
        if pages > 10 {
            return Err("The calendar returned too many pages for one sync.".to_owned());
        }
        let response = client
            .get(url)
            .bearer_auth(access_token)
            .send()
            .await
            .map_err(|error| format!("Could not reach the calendar service: {error}"))?;
        let status = response.status();
        let body = response
            .text()
            .await
            .map_err(|error| format!("Could not read the calendar response: {error}"))?;
        if !status.is_success() {
            return Err(format!(
                "The calendar service rejected the sync ({status}): {}",
                body.chars().take(300).collect::<String>()
            ));
        }
        let value: Value = serde_json::from_str(&body)
            .map_err(|error| format!("The calendar response was invalid: {error}"))?;
        let items = value[if is_google { "items" } else { "value" }]
            .as_array()
            .cloned()
            .unwrap_or_default();
        for item in items {
            let external_id = item["id"].as_str().unwrap_or("").to_owned();
            if external_id.is_empty() {
                continue;
            }
            let (start_at, end_at) = if is_google {
                let start = item["start"]["dateTime"]
                    .as_str()
                    .and_then(parse_rfc3339)
                    .or_else(|| item["start"]["date"].as_str().and_then(parse_date));
                let end = item["end"]["dateTime"]
                    .as_str()
                    .and_then(parse_rfc3339)
                    .or_else(|| item["end"]["date"].as_str().and_then(parse_date));
                (start, end)
            } else {
                (
                    parse_graph_datetime(item["start"]["dateTime"].as_str().unwrap_or("")),
                    parse_graph_datetime(item["end"]["dateTime"].as_str().unwrap_or("")),
                )
            };
            let Some(start_at) = start_at else {
                continue;
            };
            let duration_min = end_at
                .map(|end| ((end - start_at) / 60_000).clamp(5, 24 * 60))
                .unwrap_or(60);
            events.push(CalendarEvent {
                external_id,
                title: item["subject"]
                    .as_str()
                    .or_else(|| item["summary"].as_str())
                    .unwrap_or("Calendar lesson")
                    .to_owned(),
                start_at,
                duration_min,
                recurrence: String::new(),
                location: item["location"]["displayName"]
                    .as_str()
                    .or_else(|| item["location"].as_str())
                    .unwrap_or("")
                    .to_owned(),
                notes: item["bodyPreview"]
                    .as_str()
                    .or_else(|| item["description"].as_str())
                    .unwrap_or("")
                    .chars()
                    .take(4000)
                    .collect(),
                cancelled: item["isCancelled"].as_bool().unwrap_or(false)
                    || item["status"].as_str() == Some("cancelled"),
                etag: item["etag"]
                    .as_str()
                    .or_else(|| item["iCalUID"].as_str())
                    .unwrap_or("")
                    .to_owned(),
            });
        }
        next = if is_google {
            value["nextPageToken"].as_str().map(|token| {
                let mut page = base_url.clone();
                page.query_pairs_mut().append_pair("pageToken", token);
                page
            })
        } else {
            value["@odata.nextLink"]
                .as_str()
                .and_then(trusted_microsoft_link)
        };
    }
    Ok(events)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CalDavCredentials {
    pub server_url: String,
    pub username: String,
    pub password: String,
}

pub fn save_caldav_account(
    conn: &Connection,
    server_url: &str,
    username: &str,
    password: &str,
) -> Result<CalendarAccount, String> {
    let server_url = server_url.trim();
    let username = username.trim();
    if !(server_url.starts_with("https://") || server_url.starts_with("http://127.0.0.1")) {
        return Err("Enter the HTTPS CalDAV calendar URL from Apple Calendar.".to_owned());
    }
    if username.is_empty() || password.is_empty() {
        return Err("Enter the Apple ID and app-specific password.".to_owned());
    }
    let existing: Option<String> = conn
        .query_row(
            "SELECT id FROM calendar_accounts
             WHERE provider = 'caldav' AND account_email = ?1 AND deleted_at IS NULL",
            params![username],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("Could not read the calendar account: {error}"))?;
    let is_existing = existing.is_some();
    let id = existing.unwrap_or_else(|| Uuid::new_v4().to_string());
    let now = now_ms();
    let credentials = CalDavCredentials {
        server_url: server_url.to_owned(),
        username: username.to_owned(),
        password: password.to_owned(),
    };
    let encoded = serde_json::to_string(&credentials)
        .map_err(|error| format!("Could not encode the CalDAV credentials: {error}"))?;
    token_entry(&token_key(&id))?
        .set_password(&encoded)
        .map_err(|_| "The CalDAV credentials could not be saved.".to_owned())?;
    if let Err(error) = conn.execute(
        "INSERT INTO calendar_accounts (id, provider, account_email, credential_key, sync_cursor,
         deleted_at, created_at, updated_at)
         VALUES (?1, 'caldav', ?2, ?3, '', NULL, ?4, ?4)
         ON CONFLICT(id) DO UPDATE SET account_email = excluded.account_email,
            credential_key = excluded.credential_key, updated_at = excluded.updated_at",
        params![id, username, token_key(&id), now],
    ) {
        if !is_existing {
            let _ = remove_tokens(&token_key(&id));
        }
        return Err(format!("Could not save the calendar account: {error}"));
    }
    touch_workspace_public(conn)?;
    Ok(CalendarAccount {
        id,
        provider: "caldav".to_owned(),
        account_email: username.to_owned(),
        last_sync_at: now,
        event_count: 0,
    })
}

pub fn load_caldav_credentials(credential_key: &str) -> Result<CalDavCredentials, String> {
    let encoded = token_entry(credential_key)?
        .get_password()
        .map_err(|_| "The CalDAV credentials could not be read.".to_owned())?;
    serde_json::from_str(&encoded)
        .map_err(|error| format!("The saved CalDAV credentials are invalid: {error}"))
}

fn parse_ics_date(value: &str, timezone: Option<&str>) -> Option<i64> {
    let value = value.trim();
    let is_utc = value.ends_with('Z');
    if let Ok(date) =
        chrono::NaiveDateTime::parse_from_str(value.trim_end_matches('Z'), "%Y%m%dT%H%M%S")
    {
        if !is_utc {
            if let Some(timezone) = timezone.and_then(|value| value.parse::<chrono_tz::Tz>().ok()) {
                return timezone
                    .from_local_datetime(&date)
                    .earliest()
                    .map(|date| date.timestamp_millis());
            }
        }
        return Some(date.and_utc().timestamp_millis());
    }
    if let Ok(date) = chrono::NaiveDate::parse_from_str(value, "%Y%m%d") {
        return date
            .and_hms_opt(0, 0, 0)
            .map(|date| date.and_utc().timestamp_millis());
    }
    None
}

fn map_recurrence(rule: &str) -> String {
    let frequency = rule
        .split(';')
        .find_map(|part| part.strip_prefix("FREQ="))
        .unwrap_or("");
    let interval = rule
        .split(';')
        .find_map(|part| part.strip_prefix("INTERVAL="))
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(1);
    match (frequency, interval) {
        ("DAILY", _) => "daily".to_owned(),
        ("WEEKLY", 2) => "biweekly".to_owned(),
        ("WEEKLY", _) => "weekly".to_owned(),
        _ => String::new(),
    }
}

fn parse_ics_events(ics: &str) -> Vec<CalendarEvent> {
    let unfolded = ics
        .replace("\r\n ", "")
        .replace("\r\n\t", "")
        .replace('\n', "\r\n");
    let mut events = Vec::new();
    for block in unfolded.split("BEGIN:VEVENT").skip(1) {
        let body = block.split("END:VEVENT").next().unwrap_or("");
        let mut values = std::collections::HashMap::new();
        let mut timezones = std::collections::HashMap::new();
        for line in body.lines() {
            let line = line.trim();
            let Some((key, value)) = line.split_once(':') else {
                continue;
            };
            let name = key.split(';').next().unwrap_or(key).to_ascii_uppercase();
            if let Some(timezone) = key
                .split(';')
                .skip(1)
                .find_map(|part| part.strip_prefix("TZID="))
            {
                timezones.insert(name.clone(), timezone.trim_matches('"').to_owned());
            }
            values.insert(name, value.to_owned());
        }
        let Some(start_at) = values
            .get("DTSTART")
            .and_then(|value| parse_ics_date(value, timezones.get("DTSTART").map(String::as_str)))
        else {
            continue;
        };
        let end_at = values
            .get("DTEND")
            .and_then(|value| parse_ics_date(value, timezones.get("DTEND").map(String::as_str)));
        let duration_min = end_at
            .map(|end| ((end - start_at) / 60_000).clamp(5, 24 * 60))
            .unwrap_or(60);
        let recurrence = values
            .get("RRULE")
            .map(|value| map_recurrence(value.as_str()))
            .unwrap_or_default();
        let title = values
            .get("SUMMARY")
            .cloned()
            .unwrap_or_else(|| "Calendar lesson".to_owned());
        let external_id = values
            .get("UID")
            .cloned()
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        events.push(CalendarEvent {
            external_id,
            title,
            start_at,
            duration_min,
            recurrence,
            location: values.get("LOCATION").cloned().unwrap_or_default(),
            notes: values
                .get("DESCRIPTION")
                .map(|value| value.replace("\\n", "\n"))
                .unwrap_or_default(),
            cancelled: values
                .get("STATUS")
                .is_some_and(|value| value == "CANCELLED"),
            etag: String::new(),
        });
    }
    events
}

pub async fn fetch_caldav_events(
    credentials: &CalDavCredentials,
    from: i64,
    to: i64,
) -> Result<Vec<CalendarEvent>, String> {
    let start = DateTime::<Utc>::from_timestamp_millis(from)
        .ok_or_else(|| "The calendar start time is invalid.".to_owned())?
        .format("%Y%m%dT%H%M%SZ")
        .to_string();
    let end = DateTime::<Utc>::from_timestamp_millis(to)
        .ok_or_else(|| "The calendar end time is invalid.".to_owned())?
        .format("%Y%m%dT%H%M%SZ")
        .to_string();
    let body = format!(
        r#"<?xml version="1.0" encoding="utf-8" ?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><d:getetag/><c:calendar-data/></d:prop>
  <c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT">
    <c:time-range start="{start}" end="{end}"/>
  </c:comp-filter></c:comp-filter></c:filter>
</c:calendar-query>"#
    );
    let response = oauth_client()?
        .request(
            reqwest::Method::from_bytes(b"REPORT")
                .map_err(|error| format!("Could not prepare the CalDAV request: {error}"))?,
            &credentials.server_url,
        )
        .basic_auth(&credentials.username, Some(&credentials.password))
        .header("Depth", "1")
        .header("Content-Type", "application/xml; charset=utf-8")
        .body(body)
        .send()
        .await
        .map_err(|error| format!("Could not reach the CalDAV calendar: {error}"))?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|error| format!("Could not read the CalDAV calendar: {error}"))?;
    if !status.is_success() {
        return Err(format!(
            "The CalDAV calendar rejected the sync ({status}): {}",
            text.chars().take(300).collect::<String>()
        ));
    }
    let document = roxmltree::Document::parse(&text)
        .map_err(|error| format!("The CalDAV response was invalid: {error}"))?;
    let mut events = Vec::new();
    for node in document
        .descendants()
        .filter(|node| node.tag_name().name() == "calendar-data")
    {
        if let Some(ics) = node.text() {
            events.extend(parse_ics_events(ics));
        }
    }
    Ok(events)
}

pub fn apply_events(
    conn: &mut Connection,
    account_id: &str,
    provider: &str,
    events: &[CalendarEvent],
) -> Result<CalendarSyncResult, String> {
    let transaction = conn
        .transaction()
        .map_err(|error| format!("Could not start the calendar import: {error}"))?;
    let mut created = 0;
    let mut updated = 0;
    let mut removed = 0;
    let now = now_ms();
    for event in events {
        let existing: Option<(String, Option<i64>)> = transaction
            .query_row(
                "SELECT id, deleted_at FROM schedule_events
                 WHERE calendar_account_id = ?1 AND external_id = ?2 LIMIT 1",
                params![account_id, event.external_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|error| format!("Could not read the imported event: {error}"))?;
        if event.cancelled {
            if let Some((id, deleted_at)) = existing {
                if deleted_at.is_none() {
                    transaction
                        .execute(
                            "UPDATE schedule_events SET deleted_at = ?2, updated_at = ?2 WHERE id = ?1",
                            params![id, now],
                        )
                        .map_err(|error| format!("Could not remove the calendar event: {error}"))?;
                    removed += 1;
                }
            }
            continue;
        }
        if let Some((id, _)) = existing {
            transaction
                .execute(
                    "UPDATE schedule_events SET title = ?2, start_at = ?3, duration_min = ?4,
                     recurrence = ?5, location = ?6, notes = ?7, external_etag = ?8,
                     deleted_at = NULL, updated_at = ?9 WHERE id = ?1",
                    params![
                        id,
                        event.title,
                        event.start_at,
                        event.duration_min,
                        event.recurrence,
                        event.location,
                        event.notes,
                        event.etag,
                        now
                    ],
                )
                .map_err(|error| format!("Could not update the calendar event: {error}"))?;
            updated += 1;
        } else {
            let id = Uuid::new_v4().to_string();
            transaction
                .execute(
                    "INSERT INTO schedule_events (id, student_id, title, subject, start_at,
                     duration_min, recurrence, location, notes, calendar_provider,
                     calendar_account_id, external_id, external_etag, deleted_at, created_at,
                     updated_at)
                     VALUES (?1, NULL, ?2, '', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, NULL, ?12, ?12)",
                    params![
                        id,
                        event.title,
                        event.start_at,
                        event.duration_min,
                        event.recurrence,
                        event.location,
                        event.notes,
                        provider,
                        account_id,
                        event.external_id,
                        event.etag,
                        now
                    ],
                )
                .map_err(|error| format!("Could not import the calendar event: {error}"))?;
            created += 1;
        }
    }
    transaction
        .execute(
            "UPDATE calendar_accounts SET updated_at = ?2 WHERE id = ?1",
            params![account_id, now],
        )
        .map_err(|error| format!("Could not update the calendar account: {error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("Could not save the calendar import: {error}"))?;
    touch_workspace_public(conn)?;
    Ok(CalendarSyncResult {
        account_id: account_id.to_owned(),
        created,
        updated,
        removed,
    })
}

pub fn disconnect(conn: &mut Connection, account_id: &str) -> Result<(), String> {
    let credential_key: Option<String> = conn
        .query_row(
            "SELECT credential_key FROM calendar_accounts WHERE id = ?1",
            params![account_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("Could not read the calendar account: {error}"))?;
    let credential_key =
        credential_key.ok_or_else(|| "The calendar account could not be found.".to_owned())?;
    let transaction = conn
        .transaction()
        .map_err(|error| format!("Could not remove the calendar account: {error}"))?;
    transaction
        .execute(
            "DELETE FROM schedule_events WHERE calendar_account_id = ?1",
            params![account_id],
        )
        .map_err(|error| format!("Could not remove the imported calendar events: {error}"))?;
    transaction
        .execute(
            "DELETE FROM calendar_accounts WHERE id = ?1",
            params![account_id],
        )
        .map_err(|error| format!("Could not remove the calendar account: {error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("Could not save the calendar removal: {error}"))?;
    remove_tokens(&credential_key)?;
    touch_workspace_public(conn)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        begin_oauth, map_recurrence, parse_date, parse_graph_datetime, parse_ics_events,
        parse_rfc3339,
    };

    #[test]
    fn builds_pkce_authorization_urls() {
        let session = begin_oauth("google", "client-id.apps.googleusercontent.com").unwrap();
        assert!(session
            .url
            .starts_with("https://accounts.google.com/o/oauth2/v2/auth?"));
        assert!(session.url.contains("code_challenge_method=S256"));
        assert!(session
            .url
            .contains("redirect_uri=http%3A%2F%2F127.0.0.1%3A"));
        assert!(session.redirect_uri().starts_with("http://127.0.0.1:"));
        assert_eq!(session.verifier().len(), 64);
    }

    #[test]
    fn parses_calendar_timestamps() {
        assert_eq!(
            parse_rfc3339("2026-11-05T10:00:00Z"),
            Some(1_793_872_800_000)
        );
        assert_eq!(parse_date("2026-11-05"), Some(1_793_836_800_000));
        assert_eq!(
            parse_graph_datetime("2026-11-05T10:00:00.0000000"),
            Some(1_793_872_800_000)
        );
    }

    #[test]
    fn rejects_unknown_providers() {
        assert!(begin_oauth("apple", "client").is_err());
        assert!(super::provider_config("microsoft").is_ok());
    }

    #[test]
    fn only_trusts_microsoft_page_links() {
        assert!(super::trusted_microsoft_link(
            "https://graph.microsoft.com/v1.0/me/calendarView?$skiptoken=1"
        )
        .is_some());
        assert!(super::trusted_microsoft_link("https://example.com/steal").is_none());
        assert!(super::trusted_microsoft_link("http://graph.microsoft.com/steal").is_none());
    }

    #[test]
    fn parses_ics_events_and_recurrence() {
        let events = parse_ics_events(
            "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:lesson-1\r\nSUMMARY:Algebra\r\nDTSTART:20261105T100000Z\r\nDTEND:20261105T110000Z\r\nLOCATION:Room 2\r\nRRULE:FREQ=WEEKLY;INTERVAL=2\r\nEND:VEVENT\r\nEND:VCALENDAR",
        );
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].external_id, "lesson-1");
        assert_eq!(events[0].title, "Algebra");
        assert_eq!(events[0].duration_min, 60);
        assert_eq!(events[0].recurrence, "biweekly");
        assert_eq!(map_recurrence("FREQ=DAILY"), "daily");
    }

    #[test]
    fn applies_ics_timezones() {
        let events = parse_ics_events(
            "BEGIN:VEVENT\r\nUID:zoned\r\nSUMMARY:Zoned\r\nDTSTART;TZID=America/New_York:20261105T100000\r\nDTEND;TZID=America/New_York:20261105T110000\r\nEND:VEVENT",
        );
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].start_at, 1_793_890_800_000);
        assert_eq!(events[0].duration_min, 60);
    }
}
