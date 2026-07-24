use serde::Serialize;
use std::sync::Arc;
use std::thread;
use tiny_http::{Header, Method, Response, Server};

use crate::{AppState, CoordRecord};

#[derive(Serialize)]
struct LiveMapData {
    data: crate::AppData,
    current_position: Option<CoordRecord>,
}

const LIVEMAP_HTML: &str = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../src/livemap.html"));
const LIVEMAP_CSS: &str = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../src/livemap.css"));
const LIVEMAP_JS: &str = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../src/livemap.js"));
const MAP_PNG: &[u8] = include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../src/scum_map-4096.png"));

pub static HTTP_PORT: std::sync::OnceLock<u16> = std::sync::OnceLock::new();

fn text_response(body: &str, content_type: &str) -> Response<std::io::Cursor<Vec<u8>>> {
    Response::from_string(body)
        .with_header(Header::from_bytes("Content-Type".as_bytes(), content_type.as_bytes()).unwrap())
        .with_header(cors_header())
}

fn bytes_response(body: &[u8], content_type: &str) -> Response<std::io::Cursor<Vec<u8>>> {
    Response::from_data(body.to_vec())
        .with_header(Header::from_bytes("Content-Type".as_bytes(), content_type.as_bytes()).unwrap())
        .with_header(cors_header())
}

fn cors_header() -> Header {
    Header::from_bytes("Access-Control-Allow-Origin".as_bytes(), "*".as_bytes()).unwrap()
}

pub fn start_http_server(state: Arc<AppState>) {
    thread::spawn(move || {
        let mut chosen_port = 4488u16;
        let server = {
            let mut s = None;
            let ports: Vec<u16> = (0..=10).map(|i| 4488 + i * 10).chain(std::iter::once(80)).collect();
            for port in ports {
                match Server::http(format!("0.0.0.0:{}", port)) {
                    Ok(server) => {
                        eprintln!("[http_server] Server lauscht auf Port {}", port);
                        s = Some(server);
                        chosen_port = port;
                        break;
                    }
                    Err(e) => {
                        eprintln!("[http_server] Port {} fehlgeschlagen: {}", port, e);
                    }
                }
            }
            match s {
                Some(server) => server,
                None => {
                    eprintln!("[http_server] FEHLER: Live-Map Server konnte nicht gestartet werden");
                    return;
                }
            }
        };
        let _ = HTTP_PORT.set(chosen_port);

        for request in server.incoming_requests() {
            let path = request.url().split('?').next().unwrap_or("/");
            let response = match (request.method(), path) {
                (&Method::Get, "/" | "/livemap" | "/livemap.html") => {
                    text_response(LIVEMAP_HTML, "text/html; charset=utf-8")
                }
                (&Method::Get, "/livemap.css") => text_response(LIVEMAP_CSS, "text/css"),
                (&Method::Get, "/livemap.js") => text_response(LIVEMAP_JS, "application/javascript"),
                (&Method::Get, "/map.png") => bytes_response(MAP_PNG, "image/png"),
                (&Method::Get, "/api/data") => {
                    let data = state.app_data();
                    let payload = LiveMapData {
                        data,
                        current_position: state.current_position(),
                    };
                    match serde_json::to_string(&payload) {
                        Ok(json) => text_response(&json, "application/json"),
                        Err(e) => Response::from_string(format!("{{\"error\":\"{}\"}}", e))
                            .with_status_code(500)
                            .with_header(cors_header()),
                    }
                }
                _ => Response::from_string("Not Found")
                    .with_status_code(404)
                    .with_header(cors_header()),
            };

            let _ = request.respond(response);
        }
    });
}
