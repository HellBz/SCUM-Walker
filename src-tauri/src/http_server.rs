use axum::{
    body::Body,
    extract::{Path, State, WebSocketUpgrade},
    http::{header},
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use axum::extract::ws::{Message, WebSocket};
use serde::{Deserialize, Serialize};
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::broadcast;
use crate::AppState;

const LIVEMAP_HTML: &str = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../src/livemap.html"));
const LIVEMAP_CSS: &str = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../src/livemap.css"));
const LIVEMAP_JS: &str = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../src/livemap.js"));
const LEAFLET_CSS: &str = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../src/lib/leaflet.css"));
const LEAFLET_JS: &str = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../src/lib/leaflet.js"));
const MARKERCLUSTER_CSS: &str = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../src/lib/MarkerCluster.css"));
const MARKERCLUSTER_DEFAULT_CSS: &str = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../src/lib/MarkerCluster.Default.css"));
const MARKERCLUSTER_JS: &str = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../src/lib/leaflet.markercluster.js"));
const FAVICON_PNG: &[u8] = include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../src/favicon.png"));

pub static HTTP_PORT: std::sync::OnceLock<u16> = std::sync::OnceLock::new();
pub static WS_PORT: std::sync::OnceLock<u16> = std::sync::OnceLock::new();
pub static TILES_DIR: std::sync::OnceLock<String> = std::sync::OnceLock::new();
pub static WS_BROADCAST: std::sync::OnceLock<broadcast::Sender<String>> = std::sync::OnceLock::new();

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

fn text_response(body: &'static str, content_type: &'static str) -> Response {
    Response::builder()
        .status(200)
        .header(header::CONTENT_TYPE, content_type)
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(Body::from(body))
        .unwrap()
}

fn bytes_response(body: &'static [u8], content_type: &'static str) -> Response {
    Response::builder()
        .status(200)
        .header(header::CONTENT_TYPE, content_type)
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(Body::from(body.to_vec()))
        .unwrap()
}

fn json_response<T: Serialize>(value: T) -> Response {
    let body = serde_json::to_string(&value).unwrap_or_default();
    Response::builder()
        .status(200)
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(Body::from(body))
        .unwrap()
}

fn not_found() -> Response {
    Response::builder()
        .status(404)
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(Body::from("Not Found"))
        .unwrap()
}

pub fn start_http_server(state: Arc<AppState>, tiles_dir: String) {
    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("tokio runtime");
        rt.block_on(run_server(state, tiles_dir));
    });
}

async fn run_server(state: Arc<AppState>, tiles_dir: String) {
    let (tx, _rx) = broadcast::channel::<String>(256);
    let _ = WS_BROADCAST.set(tx);
    let _ = TILES_DIR.set(tiles_dir);

    let app = Router::new()
        .route("/", get(livemap_handler))
        .route("/livemap", get(livemap_handler))
        .route("/livemap.html", get(livemap_handler))
        .route("/livemap.css", get(livemap_css_handler))
        .route("/livemap.js", get(livemap_js_handler))
        .route("/lib/leaflet.css", get(leaflet_css_handler))
        .route("/lib/leaflet.js", get(leaflet_js_handler))
        .route("/lib/MarkerCluster.css", get(markercluster_css_handler))
        .route("/lib/MarkerCluster.Default.css", get(markercluster_default_css_handler))
        .route("/lib/leaflet.markercluster.js", get(markercluster_js_handler))
        .route("/favicon.png", get(favicon_handler))
        .route("/api/bounds", get(get_bounds).post(post_bounds))
        .route("/api/poi_image/:id", get(poi_image_handler))
        .route("/tiles/:z/:x/:y", get(tile_handler))
        .route("/ws", get(ws_handler))
        .with_state(state);

    let ports: Vec<u16> = (0..=10).map(|i| 4488 + i * 10).chain(std::iter::once(80)).collect();
    for port in ports {
        let addr = SocketAddr::from(([0, 0, 0, 0], port));
        match tokio::net::TcpListener::bind(addr).await {
            Ok(listener) => {
                eprintln!("[http_server] Lauscht auf {}", addr);
                let _ = HTTP_PORT.set(port);
                let _ = WS_PORT.set(port);
                if let Err(e) = axum::serve(listener, app).await {
                    eprintln!("[http_server] Server-Fehler: {}", e);
                }
                return;
            }
            Err(e) => {
                eprintln!("[http_server] Konnte Port {} nicht binden: {}", port, e);
            }
        }
    }
    eprintln!("[http_server] Kein Port verfügbar");
}

async fn livemap_handler() -> Response {
    let port = HTTP_PORT.get().copied().unwrap_or(4488);
    let html = LIVEMAP_HTML.replace("{{WS_PORT}}", &port.to_string());
    Response::builder()
        .status(200)
        .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
        .header(header::CACHE_CONTROL, "no-store, no-cache, must-revalidate")
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(Body::from(html))
        .unwrap()
}

async fn livemap_css_handler() -> Response { text_response(LIVEMAP_CSS, "text/css; charset=utf-8") }
async fn livemap_js_handler() -> Response { text_response(LIVEMAP_JS, "application/javascript; charset=utf-8") }
async fn leaflet_css_handler() -> Response { text_response(LEAFLET_CSS, "text/css; charset=utf-8") }
async fn leaflet_js_handler() -> Response { text_response(LEAFLET_JS, "application/javascript; charset=utf-8") }
async fn markercluster_css_handler() -> Response { text_response(MARKERCLUSTER_CSS, "text/css; charset=utf-8") }
async fn markercluster_default_css_handler() -> Response { text_response(MARKERCLUSTER_DEFAULT_CSS, "text/css; charset=utf-8") }
async fn markercluster_js_handler() -> Response { text_response(MARKERCLUSTER_JS, "application/javascript; charset=utf-8") }
async fn favicon_handler() -> Response { bytes_response(FAVICON_PNG, "image/png") }

async fn get_bounds() -> Response {
    let bounds = WORLD_BOUNDS.read().unwrap().clone();
    json_response(bounds)
}

async fn post_bounds(State(_state): State<Arc<AppState>>, axum::Json(new_bounds): axum::Json<WorldBounds>) -> Response {
    *WORLD_BOUNDS.write().unwrap() = new_bounds.clone();
    eprintln!("[http_server] World Bounds aktualisiert: {:?}", new_bounds);
    ws_broadcast(serde_json::json!(["bounds-updated", new_bounds]).to_string());
    json_response(serde_json::json!({"status": "ok"}))
}

async fn poi_image_handler(State(state): State<Arc<AppState>>, Path(id): Path<String>) -> Response {
    let filename = {
        let data = state.data.lock().unwrap();
        data.pois.iter().find(|p| p.id == id).and_then(|p| p.image_path.clone())
    };
    if let Some(filename) = filename {
        let dir = state.data_path.parent().unwrap_or(&state.data_path).join("poi_images");
        let path = dir.join(&filename);
        match tokio::fs::read(&path).await {
            Ok(bytes) => Response::builder()
                .status(200)
                .header(header::CONTENT_TYPE, "image/png")
                .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                .body(Body::from(bytes))
                .unwrap(),
            Err(_) => not_found(),
        }
    } else {
        not_found()
    }
}

async fn tile_handler(Path((z, x, y)): Path<(u32, u32, String)>) -> Response {
    let y = y.strip_suffix(".png")
        .and_then(|s| s.parse::<u32>().ok())
        .unwrap_or(0);
    let tiles_dir = TILES_DIR.get().map(|s| s.as_str()).unwrap_or(".");
    let path = PathBuf::from(tiles_dir)
        .join(z.to_string())
        .join(x.to_string())
        .join(format!("{}.png", y));
    match tokio::fs::read(&path).await {
        Ok(bytes) => Response::builder()
            .status(200)
            .header(header::CONTENT_TYPE, "image/png")
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .body(Body::from(bytes))
            .unwrap(),
        Err(_) => not_found(),
    }
}

async fn ws_handler(ws: WebSocketUpgrade, State(state): State<Arc<AppState>>) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, state))
}

async fn handle_socket(mut socket: WebSocket, state: Arc<AppState>) {
    let tx = match WS_BROADCAST.get() {
        Some(tx) => tx.clone(),
        None => return,
    };

    // Wait for the client to send a login message before pushing data
    let mut logged_in = false;
    while let Some(msg) = socket.recv().await {
        match msg {
            Ok(Message::Text(text)) => {
                if text.contains("\"login\"") {
                    logged_in = true;
                    break;
                } else if text.contains("\"ping\"") {
                    let _ = socket.send(Message::Text(
                        serde_json::json!(["pong", null]).to_string()
                    )).await;
                }
            }
            Ok(Message::Close(_)) | Err(_) => return,
            _ => {}
        }
    }
    if !logged_in { return; }

    // send login sequence
    let bounds = WORLD_BOUNDS.read().unwrap().clone();
    let has_hires = {
        let tiles_dir = TILES_DIR.get().map(|s| s.as_str()).unwrap_or(".");
        let path = PathBuf::from(tiles_dir).join("4").join("0").join("0.png");
        tokio::fs::metadata(&path).await.is_ok()
    };
    let _ = socket.send(Message::Text(
        serde_json::json!(["login-success", {"bounds": bounds, "has_hires_tiles": has_hires}]).to_string()
    )).await;

    let data = state.data.lock().unwrap().clone();
    let _ = socket.send(Message::Text(
        serde_json::json!(["data-updated", data]).to_string()
    )).await;

    let pos = state.current_position.lock().unwrap().clone();
    if let Some(pos) = pos {
        let _ = socket.send(Message::Text(
            serde_json::json!(["coord-update", pos]).to_string()
        )).await;
    }

    let ids = state.poi_connections.lock().unwrap().clone();
    let _ = socket.send(Message::Text(
        serde_json::json!(["poi-connections", ids]).to_string()
    )).await;

    let mut rx = tx.subscribe();
    loop {
        tokio::select! {
            msg = rx.recv() => {
                match msg {
                    Ok(text) => {
                        if socket.send(Message::Text(text)).await.is_err() { break; }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
            incoming = socket.recv() => {
                match incoming {
                    Some(Ok(Message::Text(text))) => {
                        if text.contains("\"ping\"") {
                            let _ = socket.send(Message::Text(
                                serde_json::json!(["pong", null]).to_string()
                            )).await;
                        }
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    _ => {}
                }
            }
        }
    }
}
