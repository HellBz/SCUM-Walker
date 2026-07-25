use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::thread;
use std::sync::mpsc;
use tiny_http::{Header, Method, Response, Server};
use tungstenite::accept;

use crate::{AppState, CoordRecord};

#[derive(Serialize)]
struct LiveMapData {
    data: crate::AppData,
    current_position: Option<CoordRecord>,
}

const LIVEMAP_HTML: &str = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../src/livemap.html"));
const LIVEMAP_CSS: &str = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../src/livemap.css"));
const LIVEMAP_JS: &str = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../src/livemap.js"));
const LEAFLET_CSS: &str = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../src/lib/leaflet.css"));
const LEAFLET_JS: &str = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../src/lib/leaflet.js"));
const FAVICON_PNG: &[u8] = include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../src/favicon.png"));

pub static HTTP_PORT: std::sync::OnceLock<u16> = std::sync::OnceLock::new();
pub static WS_PORT: std::sync::OnceLock<u16> = std::sync::OnceLock::new();
pub static TILES_DIR: std::sync::OnceLock<String> = std::sync::OnceLock::new();
pub static WS_BROADCAST: std::sync::OnceLock<mpsc::Sender<String>> = std::sync::OnceLock::new();

pub fn ws_broadcast(msg: String) {
    if let Some(tx) = WS_BROADCAST.get() {
        let _ = tx.send(msg);
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorldBounds {
    pub min_x: f64,
    pub max_x: f64,
    pub min_y: f64,
    pub max_y: f64,
}

impl Default for WorldBounds {
    fn default() -> Self {
        Self { min_x: -904800.0, max_x: 619318.0, min_y: -904800.0, max_y: 618818.0 }
    }
}

pub static WORLD_BOUNDS: std::sync::RwLock<WorldBounds> = std::sync::RwLock::new(WorldBounds { min_x: -904800.0, max_x: 619318.0, min_y: -904800.0, max_y: 618818.0 });

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

pub fn start_http_server(state: Arc<AppState>, tiles_dir: String) {
    // Create broadcast channel for WebSocket events
    let (ws_tx, ws_rx) = mpsc::channel::<String>();
    let _ = WS_BROADCAST.set(ws_tx);

    // Start WebSocket server
    let ws_state = state.clone();
    {
        let mut port = 4489u16;
        let listener = {
            let mut l = None;
            for p in 4489..=4500 {
                match std::net::TcpListener::bind(format!("0.0.0.0:{}", p)) {
                    Ok(listener) => {
                        eprintln!("[ws_server] WebSocket lauscht auf Port {}", p);
                        port = p;
                        l = Some(listener);
                        break;
                    }
                    Err(e) => {
                        eprintln!("[ws_server] Port {} fehlgeschlagen: {}", p, e);
                    }
                }
            }
            match l {
                Some(l) => l,
                None => {
                    eprintln!("[ws_server] FEHLER: WebSocket Server konnte nicht gestartet werden");
                    return;
                }
            }
        };
        let _ = WS_PORT.set(port);

        thread::spawn(move || {
            let clients: Arc<std::sync::Mutex<Vec<mpsc::Sender<String>>>> = Arc::new(std::sync::Mutex::new(Vec::new()));

            // Broadcast thread
            {
                let clients = clients.clone();
                thread::spawn(move || {
                    while let Ok(msg) = ws_rx.recv() {
                        let mut to_remove = Vec::new();
                        let clients_lock = clients.lock().unwrap();
                        for (i, client_tx) in clients_lock.iter().enumerate() {
                            if client_tx.send(msg.clone()).is_err() {
                                to_remove.push(i);
                            }
                        }
                        drop(clients_lock);
                        if !to_remove.is_empty() {
                            let mut clients_lock = clients.lock().unwrap();
                            for i in to_remove.iter().rev() {
                                clients_lock.swap_remove(*i);
                            }
                        }
                    }
                });
            }

            // Accept connections
            for stream in listener.incoming() {
                if let Ok(stream) = stream {
                    let (client_tx, client_rx) = mpsc::channel::<String>();
                    clients.lock().unwrap().push(client_tx);

                    let state = ws_state.clone();
                    thread::spawn(move || {
                        match accept(stream) {
                            Ok(mut ws) => {
                                // Single thread per connection: alternate between
                                // checking broadcast channel and reading from socket.
                                // Set read timeout so read() doesn't block forever.
                                let _ = ws.get_ref().set_read_timeout(Some(std::time::Duration::from_millis(100)));

                                loop {
                                    // 1. Check for broadcast messages (non-blocking)
                                    match client_rx.recv_timeout(std::time::Duration::from_millis(50)) {
                                        Ok(msg) => {
                                            if ws.send(tungstenite::Message::Text(msg)).is_err() {
                                                break;
                                            }
                                        }
                                        Err(mpsc::RecvTimeoutError::Timeout) => {
                                            // No broadcast, send WebSocket ping to keep alive
                                            if ws.send(tungstenite::Message::Ping(Vec::new())).is_err() {
                                                break;
                                            }
                                        }
                                        Err(mpsc::RecvTimeoutError::Disconnected) => {
                                            break;
                                        }
                                    }

                                    // 2. Try to read incoming messages (times out after 100ms)
                                    match ws.read() {
                                        Ok(msg) => {
                                            match msg {
                                                tungstenite::Message::Text(text) => {
                                                    if text.contains("\"ping\"") {
                                                        let _ = ws.send(tungstenite::Message::Text(
                                                            serde_json::json!({"type": "pong"}).to_string()
                                                        ));
                                                    } else if text.contains("\"login\"") {
                                                        let bounds = WORLD_BOUNDS.read().unwrap().clone();
                                                        let tiles_dir = TILES_DIR.get().map(|s| s.as_str()).unwrap_or(".");
                                                        let has_hires = std::path::Path::new(tiles_dir).join("4").join("0").join("0.png").exists();
                                                        let login_resp = serde_json::json!({
                                                            "type": "login-success",
                                                            "data": state.app_data(),
                                                            "current_position": state.current_position(),
                                                            "bounds": bounds,
                                                            "has_hires_tiles": has_hires,
                                                        }).to_string();
                                                        let _ = ws.send(tungstenite::Message::Text(login_resp));
                                                        eprintln!("[ws_server] Client login erfolgreich");
                                                    }
                                                }
                                                tungstenite::Message::Close(_) => break,
                                                _ => {}
                                            }
                                        }
                                        Err(tungstenite::Error::Io(ref e)) if e.kind() == std::io::ErrorKind::WouldBlock || e.kind() == std::io::ErrorKind::TimedOut => {
                                            // Normal timeout, continue loop
                                        }
                                        Err(_) => break,
                                    }
                                }
                            }
                            Err(e) => {
                                eprintln!("[ws_server] Verbindung fehlgeschlagen: {}", e);
                            }
                        }
                    });
                }
            }
        });
    };

    // HTTP server (static files)
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
        let _ = TILES_DIR.set(tiles_dir);

        for mut request in server.incoming_requests() {
            let path = request.url().split('?').next().unwrap_or("/");
            let response = match (request.method(), path) {
                (&Method::Get, "/" | "/livemap" | "/livemap.html") => {
                    let ws_port = WS_PORT.get().map(|p| *p).unwrap_or(4489);
                    let html = LIVEMAP_HTML.replace("__WS_PORT__", &ws_port.to_string());
                    let html = html.replace("__HTTP_PORT__", &chosen_port.to_string());
                    text_response(&html, "text/html; charset=utf-8")
                }
                (&Method::Get, "/livemap.css") => text_response(LIVEMAP_CSS, "text/css"),
                (&Method::Get, "/livemap.js") => text_response(LIVEMAP_JS, "application/javascript"),
                (&Method::Get, "/lib/leaflet.css") => text_response(LEAFLET_CSS, "text/css"),
                (&Method::Get, "/lib/leaflet.js") => text_response(LEAFLET_JS, "application/javascript"),
                (&Method::Get, "/favicon.png") => bytes_response(FAVICON_PNG, "image/png"),
                (&Method::Get, path) if path.starts_with("/tiles/") => {
                    // Serve tile: /tiles/{z}/{x}/{y}.png
                    let parts: Vec<&str> = path.strip_prefix("/tiles/").unwrap().split('/').collect();
                    if parts.len() == 3 && parts[2].ends_with(".png") {
                        let tile_path = std::path::Path::new(TILES_DIR.get().map(|s| s.as_str()).unwrap_or("."))
                            .join(parts[0])
                            .join(parts[1])
                            .join(parts[2]);
                        match std::fs::read(&tile_path) {
                            Ok(data) => bytes_response(&data, "image/png"),
                            Err(_) => Response::from_string("Not Found")
                                .with_status_code(404)
                                .with_header(cors_header()),
                        }
                    } else {
                        Response::from_string("Not Found")
                            .with_status_code(404)
                            .with_header(cors_header())
                    }
                }
                (&Method::Get, "/api/bounds") => {
                    let bounds = WORLD_BOUNDS.read().unwrap();
                    match serde_json::to_string(&*bounds) {
                        Ok(json) => text_response(&json, "application/json"),
                        Err(e) => Response::from_string(format!("{{\"error\":\"{}\"}}", e))
                            .with_status_code(500)
                            .with_header(cors_header()),
                    }
                }
                (&Method::Post, "/api/bounds") => {
                    let mut body = String::new();
                    let _ = request.as_reader().read_to_string(&mut body);
                    match serde_json::from_str::<WorldBounds>(&body) {
                        Ok(new_bounds) => {
                            *WORLD_BOUNDS.write().unwrap() = new_bounds.clone();
                            eprintln!("[http_server] World Bounds aktualisiert: {:?}", new_bounds);
                            ws_broadcast(serde_json::json!({"type": "bounds-updated", "bounds": new_bounds}).to_string());
                            text_response("{\"status\":\"ok\"}", "application/json")
                        }
                        Err(e) => Response::from_string(format!("{{\"error\":\"{}\"}}", e))
                            .with_status_code(400)
                            .with_header(cors_header()),
                    }
                }
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
                (&Method::Get, path) if path.starts_with("/api/poi_image/") => {
                    let poi_id = path.strip_prefix("/api/poi_image/").unwrap();
                    let data = state.app_data();
                    let poi = data.pois.iter().find(|p| p.id == poi_id);
                    match poi.and_then(|p| p.image_path.as_ref()) {
                        Some(filename) => {
                            let image_dir = state.data_path.parent().unwrap_or(&state.data_path).join("poi_images");
                            let img_path = image_dir.join(filename);
                            match std::fs::read(&img_path) {
                                Ok(bytes) => bytes_response(&bytes, "image/png"),
                                Err(_) => Response::from_string("Not Found")
                                    .with_status_code(404)
                                    .with_header(cors_header()),
                            }
                        }
                        None => Response::from_string("Not Found")
                            .with_status_code(404)
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
