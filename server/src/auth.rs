use axum::http::{HeaderMap, header::AUTHORIZATION};
use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;

use crate::{document::Doc, storage::hash_password};

pub fn extract_password_from_headers(headers: &HeaderMap, slug: &str) -> Option<String> {
    let value = headers.get(AUTHORIZATION)?;
    let header = value.to_str().ok()?.trim();
    let (scheme, payload) = header.split_once(' ')?;
    if !scheme.eq_ignore_ascii_case("basic") {
        return None;
    }
    let (user, pass) = parse_basic_payload(payload)?;
    if user != slug {
        return None;
    }
    Some(pass)
}

pub fn extract_password_from_token(token: &str, slug: &str) -> Option<String> {
    let (user, pass) = parse_basic_payload(token)?;
    if user != slug {
        return None;
    }
    Some(pass)
}

fn parse_basic_payload(encoded: &str) -> Option<(String, String)> {
    let decoded = BASE64.decode(encoded.trim()).ok()?;
    let decoded_str = String::from_utf8(decoded).ok()?;
    match decoded_str.split_once(':') {
        Some((user, pass)) => Some((user.to_string(), pass.to_string())),
        None => Some((decoded_str, String::new())),
    }
}

pub fn is_authorized(doc: &Doc, provided: Option<&str>) -> bool {
    match (&doc.password_hash, provided) {
        (None, _) => true,
        (Some(expected), Some(actual)) => hash_password(actual) == *expected,
        (Some(_), None) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::{HeaderMap, HeaderValue};

    #[test]
    fn extract_password_from_headers_parses_basic_auth() {
        let mut headers = HeaderMap::new();
        let token = BASE64.encode("doc-slug:secret");
        headers.insert(
            AUTHORIZATION,
            HeaderValue::from_str(&format!("Basic {}", token)).unwrap(),
        );

        let password = extract_password_from_headers(&headers, "doc-slug");

        assert_eq!(password.as_deref(), Some("secret"));
    }

    #[test]
    fn extract_password_from_headers_rejects_invalid_data() {
        let mut headers = HeaderMap::new();
        headers.insert(AUTHORIZATION, HeaderValue::from_static("Bearer something"));

        assert!(extract_password_from_headers(&headers, "doc-slug").is_none());
    }

    #[test]
    fn is_authorized_checks_password_hash() {
        let mut doc = Doc::default();
        doc.password_hash = Some(hash_password("secret"));

        assert!(is_authorized(&doc, Some("secret")));
        assert!(!is_authorized(&doc, Some("wrong")));
        assert!(!is_authorized(&doc, None));
    }

    #[test]
    fn extract_password_from_token_validates_slug() {
        let token = BASE64.encode("doc-slug:secret");
        assert_eq!(
            extract_password_from_token(&token, "doc-slug").as_deref(),
            Some("secret")
        );
        assert!(extract_password_from_token(&token, "other").is_none());
    }
}
