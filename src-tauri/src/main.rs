use arboard::Clipboard;
use chrono::{DateTime, Utc};
use enigo::{Direction, Enigo, Key, Keyboard, Settings};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::ffi::OsStr;
use std::fs;
use std::os::windows::ffi::OsStrExt;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::{Emitter, Manager, State};
use tauri::webview::WebviewWindowBuilder;

mod http_server;
use windows::Win32::Foundation::{HWND, RECT};
use windows::Win32::Graphics::Gdi::{
    BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject,
    GetDC, GetDIBits, ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, DIB_RGB_COLORS,
    SRCCOPY,
};
use windows::Win32::UI::WindowsAndMessaging::{FindWindowW, GetClientRect, SetForegroundWindow};

const INTERVAL_SECONDS: u64 = 10;
const SCUM_WINDOW_TITLES: &[&str] = &["SCUM", "SCUM ", "SCUM Early Access"];

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CoordRecord {
    time: DateTime<Utc>,
    x: f64,
    y: f64,
    z: f64,
    pitch: f64,
    yaw: f64,
    roll: f64,
}

const ROUTE_COLORS: &[&str] = &["#00ffcc", "#ff8800", "#4488ff", "#ff44d3", "#ffee00", "#44cc44", "#ff4444", "#ffffff"];

fn default_true() -> bool { true }

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Route {
    id: String,
    name: String,
    color: String,
    #[serde(default = "default_true")]
    visible: bool,
    records: Vec<CoordRecord>,
}

impl Route {
    fn new(name: String, color: String) -> Self {
        Self {
            id: format!("{}", Utc::now().timestamp_millis()),
            name,
            color,
            visible: true,
            records: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Poi {
    id: String,
    label: String,
    x: f64,
    y: f64,
    #[serde(rename = "type")]
    poi_type: String,
    color: String,
    #[serde(default)]
    image_path: Option<String>,
}

#[derive(Debug, Default, Serialize, Deserialize, Clone)]
struct AppData {
    routes: Vec<Route>,
    current_route_id: Option<String>,
    pois: Vec<Poi>,
}

pub(crate) struct AppState {
    data: Mutex<AppData>,
    data_path: PathBuf,
    recording: Mutex<bool>,
    current_position: Mutex<Option<CoordRecord>>,
}

impl AppState {
    pub(crate) fn app_data(&self) -> AppData {
        self.data.lock().unwrap().clone()
    }

    pub(crate) fn current_position(&self) -> Option<CoordRecord> {
        self.current_position.lock().unwrap().clone()
    }
}

fn parse_clipboard(text: &str) -> Option<CoordRecord> {
    let re = Regex::new(
        r"\{X=([-\d.]+)\s+Y=([-\d.]+)\s+Z=([-\d.]+)\|P=([-\d.]+)\s+Y=([-\d.]+)\s+R=([-\d.]+)\}"
    ).ok()?;
    let caps = re.captures(text)?;
    Some(CoordRecord {
        time: Utc::now(),
        x: caps[1].parse().ok()?,
        y: caps[2].parse().ok()?,
        z: caps[3].parse().ok()?,
        pitch: caps[4].parse().ok()?,
        yaw: caps[5].parse().ok()?,
        roll: caps[6].parse().ok()?,
    })
}

fn load_data(path: &PathBuf) -> AppData {
    if let Ok(text) = fs::read_to_string(path) {
        if let Ok(mut data) = serde_json::from_str::<AppData>(&text) {
            // Assign default colors to old routes without a color
            for (i, route) in data.routes.iter_mut().enumerate() {
                if route.color.is_empty() {
                    route.color = ROUTE_COLORS[i % ROUTE_COLORS.len()].to_string();
                }
            }
            return data;
        }
    }
    AppData::default()
}

fn save_data(path: &PathBuf, data: &AppData) {
    if let Ok(json) = serde_json::to_string_pretty(data) {
        let _ = fs::write(path, json);
    }
}

fn find_scum_window() -> Option<HWND> {
    for title in SCUM_WINDOW_TITLES {
        let wide: Vec<u16> = OsStr::new(title).encode_wide().chain(Some(0)).collect();
        let hwnd = unsafe { FindWindowW(None, windows::core::PCWSTR(wide.as_ptr())) };
        if hwnd.0 != 0 {
            return Some(hwnd);
        }
    }
    None
}

fn focus_scum_window() {
    if let Some(hwnd) = find_scum_window() {
        unsafe { let _ = SetForegroundWindow(hwnd); }
    }
}

fn press_ctrl_c() {
    let mut enigo = Enigo::new(&Settings::default()).unwrap();
    let _ = enigo.key(Key::Control, Direction::Press);
    std::thread::sleep(Duration::from_millis(10));
    let _ = enigo.key(Key::Unicode('c'), Direction::Press);
    std::thread::sleep(Duration::from_millis(10));
    let _ = enigo.key(Key::Unicode('c'), Direction::Release);
    std::thread::sleep(Duration::from_millis(10));
    let _ = enigo.key(Key::Control, Direction::Release);
}

fn capture_window(hwnd: HWND) -> Option<image::RgbaImage> {
    unsafe {
        let hdc_window = GetDC(hwnd);
        if hdc_window.0 == 0 {
            return None;
        }

        let mut rect: RECT = std::mem::zeroed();
        if GetClientRect(hwnd, &mut rect).is_err() {
            let _ = ReleaseDC(hwnd, hdc_window);
            return None;
        }

        let width = (rect.right - rect.left) as u32;
        let height = (rect.bottom - rect.top) as u32;
        if width == 0 || height == 0 {
            let _ = ReleaseDC(hwnd, hdc_window);
            return None;
        }

        let hdc_mem = CreateCompatibleDC(hdc_window);
        if hdc_mem.0 == 0 {
            let _ = ReleaseDC(hwnd, hdc_window);
            return None;
        }

        let hbm = CreateCompatibleBitmap(hdc_window, width as i32, height as i32);
        if hbm.0 == 0 {
            let _ = DeleteDC(hdc_mem);
            let _ = ReleaseDC(hwnd, hdc_window);
            return None;
        }

        let _ = SelectObject(hdc_mem, hbm);

        let _ = BitBlt(
            hdc_mem,
            0, 0,
            width as i32, height as i32,
            hdc_window,
            0, 0,
            SRCCOPY,
        );

        let mut bmi: BITMAPINFO = std::mem::zeroed();
        bmi.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
        bmi.bmiHeader.biWidth = width as i32;
        bmi.bmiHeader.biHeight = -(height as i32);
        bmi.bmiHeader.biPlanes = 1;
        bmi.bmiHeader.biBitCount = 32;
        bmi.bmiHeader.biCompression = DIB_RGB_COLORS.0;

        let mut buf: Vec<u8> = vec![0; (width * height * 4) as usize];
        let _ = GetDIBits(
            hdc_mem,
            hbm,
            0,
            height,
            Some(buf.as_mut_ptr() as *mut _),
            &mut bmi,
            DIB_RGB_COLORS,
        );

        let _ = DeleteObject(hbm);
        let _ = DeleteDC(hdc_mem);
        let _ = ReleaseDC(hwnd, hdc_window);

        // Convert BGRA -> RGBA
        let mut img = image::RgbaImage::new(width, height);
        for y in 0..height {
            for x in 0..width {
                let idx = ((y * width + x) * 4) as usize;
                let b = buf[idx];
                let g = buf[idx + 1];
                let r = buf[idx + 2];
                let a = buf[idx + 3];
                img.put_pixel(x, y, image::Rgba([r, g, b, a]));
            }
        }

        Some(img)
    }
}

fn capture_scum_window() -> Option<image::RgbaImage> {
    find_scum_window().and_then(capture_window)
}

#[tauri::command]
fn get_current_location() -> Result<CoordRecord, String> {
    focus_scum_window();
    std::thread::sleep(Duration::from_millis(100));
    press_ctrl_c();
    std::thread::sleep(Duration::from_millis(300));
    let mut clipboard = Clipboard::new().map_err(|e| e.to_string())?;
    let text = clipboard.get_text().map_err(|e| e.to_string())?;
    parse_clipboard(&text).ok_or_else(|| "Keine gültigen Koordinaten in der Zwischenablage".to_string())
}

fn start_recorder(state: Arc<AppState>, app_handle: tauri::AppHandle) {
    thread::spawn(move || {
        let mut clipboard = Clipboard::new().expect("clipboard");
        loop {
            let recording = *state.recording.lock().unwrap();
            if recording {
                focus_scum_window();
                std::thread::sleep(Duration::from_millis(100));
                press_ctrl_c();
                thread::sleep(Duration::from_millis(300));
                if let Ok(text) = clipboard.get_text() {
                    if let Some(record) = parse_clipboard(&text) {
                        let should_record = {
                            let mut pos = state.current_position.lock().unwrap();
                            let changed = pos.as_ref().map_or(true, |last| {
                                (last.x - record.x).abs() > 0.1 || (last.y - record.y).abs() > 0.1
                            });
                            *pos = Some(record.clone());
                            changed
                        };

                        let mut data = state.data.lock().unwrap();
                        if let Some(current_id) = data.current_route_id.clone() {
                            if let Some(route) = data.routes.iter_mut().find(|r| r.id == current_id) {
                                route.records.push(record.clone());
                                save_data(&state.data_path, &data);
                            }
                        }
                        drop(data);

                        if should_record {
                            let _ = app_handle.emit("coord-update", record);
                        }
                    }
                }
                thread::sleep(Duration::from_secs(INTERVAL_SECONDS));
            } else {
                thread::sleep(Duration::from_millis(500));
            }
        }
    });
}

#[tauri::command]
fn get_data(state: State<Arc<AppState>>) -> AppData {
    state.data.lock().unwrap().clone()
}

#[tauri::command]
fn new_route(state: State<Arc<AppState>>, name: String, color: String) -> AppData {
    let mut data = state.data.lock().unwrap();
    let route = Route::new(name, color);
    data.current_route_id = Some(route.id.clone());
    data.routes.push(route);
    save_data(&state.data_path, &data);
    data.clone()
}

#[tauri::command]
fn select_route(state: State<Arc<AppState>>, id: String) -> AppData {
    let mut data = state.data.lock().unwrap();
    data.current_route_id = Some(id);
    save_data(&state.data_path, &data);
    data.clone()
}

#[tauri::command]
fn rename_route(state: State<Arc<AppState>>, id: String, name: String) -> AppData {
    let mut data = state.data.lock().unwrap();
    if let Some(route) = data.routes.iter_mut().find(|r| r.id == id) {
        route.name = name;
        save_data(&state.data_path, &data);
    }
    data.clone()
}

#[tauri::command]
fn delete_route(state: State<Arc<AppState>>, id: String) -> AppData {
    let mut data = state.data.lock().unwrap();
    data.routes.retain(|r| r.id != id);
    if data.current_route_id.as_ref() == Some(&id) {
        data.current_route_id = data.routes.last().map(|r| r.id.clone());
    }
    save_data(&state.data_path, &data);
    data.clone()
}

#[tauri::command]
fn set_route_color(state: State<Arc<AppState>>, id: String, color: String) -> AppData {
    let mut data = state.data.lock().unwrap();
    if let Some(route) = data.routes.iter_mut().find(|r| r.id == id) {
        route.color = color;
        save_data(&state.data_path, &data);
    }
    data.clone()
}

#[tauri::command]
fn toggle_route_visibility(state: State<Arc<AppState>>, id: String) -> AppData {
    let mut data = state.data.lock().unwrap();
    if let Some(route) = data.routes.iter_mut().find(|r| r.id == id) {
        route.visible = !route.visible;
        save_data(&state.data_path, &data);
    }
    data.clone()
}

#[tauri::command]
fn toggle_recording(state: State<Arc<AppState>>) -> bool {
    let mut recording = state.recording.lock().unwrap();
    *recording = !*recording;
    *recording
}

#[tauri::command]
fn add_poi(state: State<Arc<AppState>>, poi: Poi) -> AppData {
    let mut data = state.data.lock().unwrap();
    data.pois.push(poi);
    save_data(&state.data_path, &data);
    data.clone()
}

#[tauri::command]
fn remove_poi(state: State<Arc<AppState>>, id: String) -> AppData {
    let mut data = state.data.lock().unwrap();
    data.pois.retain(|p| p.id != id);
    save_data(&state.data_path, &data);
    data.clone()
}

#[tauri::command]
fn paste_poi_screenshot(state: State<Arc<AppState>>, id: String) -> Result<AppData, String> {
    focus_scum_window();
    std::thread::sleep(Duration::from_millis(300));

    let img = capture_scum_window().ok_or_else(|| "Konnte SCUM-Fenster nicht aufnehmen".to_string())?;

    let image_dir = state.data_path.parent().unwrap_or(&state.data_path).join("poi_images");
    std::fs::create_dir_all(&image_dir).map_err(|e| e.to_string())?;
    let filename = format!("poi_{}.png", id);
    let path = image_dir.join(&filename);
    img.save_with_format(&path, image::ImageFormat::Png).map_err(|e| e.to_string())?;

    let mut data = state.data.lock().unwrap();
    if let Some(poi) = data.pois.iter_mut().find(|p| p.id == id) {
        poi.image_path = Some(filename);
        save_data(&state.data_path, &data);
    }
    Ok(data.clone())
}

#[tauri::command]
fn get_poi_image_base64(state: State<Arc<AppState>>, id: String) -> Result<String, String> {
    let data = state.data.lock().unwrap();
    let poi = data.pois.iter().find(|p| p.id == id).ok_or("POI nicht gefunden")?;
    let filename = poi.image_path.as_ref().ok_or("Kein Bild vorhanden")?;
    let image_dir = state.data_path.parent().unwrap_or(&state.data_path).join("poi_images");
    let path = image_dir.join(filename);
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    use base64::{prelude::BASE64_STANDARD, Engine};
    Ok(BASE64_STANDARD.encode(bytes))
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct OverlayConfig {
    x: Option<i32>,
    y: Option<i32>,
    width: Option<u32>,
    height: Option<u32>,
    opacity: Option<f64>,
}

fn overlay_config_path(app: &tauri::AppHandle) -> PathBuf {
    app.path().app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("overlay_config.json")
}

fn load_overlay_config(path: &PathBuf) -> OverlayConfig {
    if !path.exists() {
        return OverlayConfig::default();
    }
    fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_overlay_config_file(path: &PathBuf, config: &OverlayConfig) {
    if let Ok(json) = serde_json::to_string_pretty(config) {
        let _ = fs::write(path, json);
    }
}

#[tauri::command]
fn save_overlay_config(app: tauri::AppHandle, config: OverlayConfig) -> Result<(), String> {
    let path = overlay_config_path(&app);
    save_overlay_config_file(&path, &config);
    Ok(())
}

#[tauri::command]
fn get_overlay_config(app: tauri::AppHandle) -> OverlayConfig {
    let path = overlay_config_path(&app);
    load_overlay_config(&path)
}

#[tauri::command]
fn copy_livemap_url() -> Result<(), String> {
    use arboard::Clipboard;
    let url = format!("http://127.0.0.1:{}/livemap.html", http_server::HTTP_PORT);
    let mut clipboard = Clipboard::new().map_err(|e| e.to_string())?;
    clipboard.set_text(url).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn open_overlay(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("overlay") {
        window.show().map_err(|e| e.to_string())?;
    } else {
        return Err("Overlay-Fenster nicht verfügbar".into());
    }
    Ok(())
}

#[tauri::command]
fn close_overlay(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("overlay") {
        window.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn set_overlay_clickthrough(app: tauri::AppHandle, clickthrough: bool) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("overlay") {
        window.set_ignore_cursor_events(clickthrough).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .setup(move |app| {
            let data_path = app.path().app_data_dir()
                .unwrap_or_else(|_| PathBuf::from("."))
                .join("scum_walker_data.json");

            let data = load_data(&data_path);
            let state = Arc::new(AppState {
                data: Mutex::new(data),
                data_path,
                recording: Mutex::new(false),
                current_position: Mutex::new(None),
            });

            start_recorder(state.clone(), app.handle().clone());
            http_server::start_http_server(state.clone());
            app.manage(state);

            let overlay_config = load_overlay_config(&overlay_config_path(&app.handle()));
            let mut overlay_builder = WebviewWindowBuilder::new(app.handle(), "overlay", tauri::WebviewUrl::App("overlay.html".into()))
                .title("SCUM Walker Overlay")
                .inner_size(overlay_config.width.unwrap_or(450) as f64, overlay_config.height.unwrap_or(450) as f64)
                .min_inner_size(200.0, 200.0)
                .decorations(false)
                .transparent(true)
                .always_on_top(true)
                .resizable(true)
                .skip_taskbar(true)
                .visible(false);
            if let (Some(x), Some(y)) = (overlay_config.x, overlay_config.y) {
                overlay_builder = overlay_builder.position(x as f64, y as f64);
            }
            let _ = overlay_builder.build();

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_data,
            get_current_location,
            new_route,
            select_route,
            rename_route,
            delete_route,
            set_route_color,
            toggle_route_visibility,
            toggle_recording,
            add_poi,
            remove_poi,
            paste_poi_screenshot,
            get_poi_image_base64,
            copy_livemap_url,
            open_overlay,
            close_overlay,
            set_overlay_clickthrough,
            save_overlay_config,
            get_overlay_config
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
