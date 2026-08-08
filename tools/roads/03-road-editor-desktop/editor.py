#!/usr/bin/env python3
"""Native SCUM road editor (Tkinter + Pillow).

Supports:
- Map image pan / zoom
- roads.json (networks[].roads) and flat (roads[]) formats
- Change road type (main/secondary/rail), delete, add new roads
- Save back to JSON preserving the source format
"""

import copy
import json
import tkinter as tk
from tkinter import filedialog, messagebox, ttk

from PIL import Image, ImageTk

# SCUM map images are legitimately large (e.g. 14481x14481 = ~210M pixels).
# Pillow's decompression bomb guard rejects them by default; raise the limit.
Image.MAX_IMAGE_PIXELS = None

COLORS = {
    "main": "#ffd400",
    "primary": "#ffd400",
    "secondary": "#ffffff",
    "rail": "#ef4444",
    "railroad": "#ef4444",
}

TYPE_LABELS = {"main": "Hauptstraße (gelb)", "secondary": "Nebenstraße (weiß)", "rail": "Bahnlinie (rot)"}


def dist_sq(x1, y1, x2, y2):
    dx = x1 - x2
    dy = y1 - y2
    return dx * dx + dy * dy


class RoadEditor:
    def __init__(self, root):
        self.root = root
        self.root.title("SCUM Road Editor (Desktop)")
        self.root.geometry("1400x900")

        self.img = None
        self.img_w = 0
        self.img_h = 0
        self.photo = None

        self.scale = 0.15
        self.offset_x = 0.0
        self.offset_y = 0.0

        self.data = None
        self.roads = []  # flat list of road objects with network references
        self.selected_road = None
        self.selected_roads = []  # multi-selection for joining
        self.selected_point = None
        self.new_points = []

        self.undo_stack = []
        self.redo_stack = []
        self.max_undo = 20
        self._undo_before_drag = None
        self._drag_start_point = None
        self.select_start = None
        self.select_rect = None
        self._lasso_add = False
        self._road_parent = {}  # id(road) -> parent list
        self._road_network = {}  # id(road) -> network dict

        self.mode = "pan"  # pan, add, edit

        self._build_ui()
        self._bind_events()

    def _build_ui(self):
        top = tk.Frame(self.root, padx=6, pady=4)
        top.pack(side=tk.TOP, fill=tk.X)

        tk.Button(top, text="Bild laden", command=self.load_image).pack(side=tk.LEFT, padx=2)
        tk.Button(top, text="JSON laden", command=self.load_json).pack(side=tk.LEFT, padx=2)
        tk.Button(top, text="JSON speichern", command=self.save_json).pack(side=tk.LEFT, padx=2)

        tk.Label(top, text="Modus:").pack(side=tk.LEFT, padx=(20, 4))
        self.mode_var = tk.StringVar(value="pan")
        for m, lbl in [("pan", "Verschieben"), ("add", "Neue Straße"), ("edit", "Punkte bearbeiten")]:
            tk.Radiobutton(top, text=lbl, variable=self.mode_var, value=m, command=self.on_mode_change).pack(side=tk.LEFT, padx=2)

        tk.Button(top, text="Typ: gelb (main)", command=lambda: self.set_type("main")).pack(side=tk.LEFT, padx=(20, 2))
        tk.Button(top, text="Typ: weiß (secondary)", command=lambda: self.set_type("secondary")).pack(side=tk.LEFT, padx=2)
        tk.Button(top, text="Typ: Bahn (rail)", command=lambda: self.set_type("rail")).pack(side=tk.LEFT, padx=2)
        tk.Button(top, text="Verbinden", command=self.merge_selected_roads).pack(side=tk.LEFT, padx=2)
        tk.Button(top, text="Löschen", command=self.delete_selected, fg="red").pack(side=tk.LEFT, padx=2)

        self.info_label = tk.Label(top, text="Keine Straße", anchor=tk.W)
        self.info_label.pack(side=tk.RIGHT, fill=tk.X, expand=True)

        self.canvas = tk.Canvas(self.root, bg="#0a0a1a", highlightthickness=0)
        self.canvas.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)

        sidebar = tk.Frame(self.root, width=260, bg="#181c24", relief=tk.RIDGE, bd=1)
        sidebar.pack(side=tk.RIGHT, fill=tk.Y)
        sidebar.pack_propagate(False)

        tk.Label(sidebar, text="Tasten", bg="#181c24", fg="#9ca8b5", anchor=tk.W).pack(fill=tk.X, padx=8, pady=(10, 4))
        hints = (
            "Mausrad: zoomen\n"
            "Mittlere Maus: schieben\n"
            "Klick: Straße wählen\n"
            "Rechtsklick: Punkt wählen → Punkt verbinden\n"
            "Edit: Klick auf Linie → Knickpunkt\n"
            "Verschieben: Shift+Klick auf Linie → Knickpunkt\n"
            "Strg+Klick: mehrere wählen\n"
            "Klick+Ziehen: Lasso (Rechteck)\n"
            "Entf: Auswahl löschen\n"
            "Verbinden: ausgewählte zu einer Straße fügen\n"
            "Strg+Z / Strg+Y: Undo / Redo\n"
            "Strg+S: speichern\n"
            "Neu: Punkte setzen,\nEnter/2xKlick: beenden\n"
            "Esc: Abbrechen"
        )
        tk.Label(sidebar, text=hints, bg="#181c24", fg="#d4d8dd", justify=tk.LEFT).pack(fill=tk.X, padx=8, pady=4)

        self.status = tk.Label(sidebar, text="Bereit", bg="#181c24", fg="#9ca8b5", anchor=tk.W, wraplength=240)
        self.status.pack(side=tk.BOTTOM, fill=tk.X, padx=8, pady=8)

    def _bind_events(self):
        self.canvas.bind("<ButtonPress-1>", self.on_left_down)
        self.canvas.bind("<B1-Motion>", self.on_left_drag)
        self.canvas.bind("<ButtonRelease-1>", self.on_left_up)
        self.canvas.bind("<ButtonPress-3>", self.on_right_click)
        self.canvas.bind("<ButtonPress-2>", self.on_middle_down)
        self.canvas.bind("<B2-Motion>", self.on_middle_drag)
        self.canvas.bind("<MouseWheel>", self.on_wheel)
        self.root.bind("<Control-s>", lambda e: self.save_json())
        self.root.bind("<Control-z>", lambda e: self.undo())
        self.root.bind("<Control-y>", lambda e: self.redo())
        self.root.bind("<Delete>", lambda e: self.delete_selected())
        self.root.bind("<Return>", lambda e: self.finish_new_road())
        self.root.bind("<Escape>", lambda e: self.cancel_new_road())
        self.canvas.bind("<Configure>", lambda e: self.render())

    def on_mode_change(self):
        self.mode = self.mode_var.get()
        self.selected_road = None
        self.selected_roads = []
        self.selected_point = None
        self.new_points = []
        self.render()

    def set_status(self, text):
        self.status.config(text=text)

    def load_image(self):
        path = filedialog.askopenfilename(title="Kartenbild laden", filetypes=[("PNG/JPG", "*.png *.jpg *.jpeg")])
        if not path:
            return
        try:
            self.img = Image.open(path)
            if self.img.mode != "RGB":
                self.img = self.img.convert("RGB")
            self.img_w, self.img_h = self.img.size
            self.scale = min(1.0, 1200 / self.img_w, 800 / self.img_h)
            self.offset_x = 0.0
            self.offset_y = 0.0
            self.render()
            self.set_status(f"Bild geladen: {self.img_w}x{self.img_h}")
        except Exception as e:
            messagebox.showerror("Fehler", f"Bild konnte nicht geladen werden:\n{e}")

    def load_json(self):
        path = filedialog.askopenfilename(title="Roads JSON laden", filetypes=[("JSON", "*.json")])
        if not path:
            return
        try:
            with open(path, "r", encoding="utf-8") as f:
                self.data = json.load(f)
            self.selected_road = None
            self.selected_roads = []
            self.selected_point = None
            self._flatten_roads()
            self.render()
            self.set_status(f"JSON geladen: {len(self.roads)} Straßen")
        except Exception as e:
            messagebox.showerror("Fehler", f"JSON konnte nicht geladen werden:\n{e}")

    def _flatten_roads(self):
        self.roads = []
        self._road_parent.clear()
        self._road_network.clear()
        if not self.data:
            return
        if isinstance(self.data.get("networks"), list):
            for network in self.data["networks"]:
                for road in network.get("roads", []):
                    self._road_parent[id(road)] = network["roads"]
                    self._road_network[id(road)] = network
                    self.roads.append(road)
        else:
            parent = self.data.get("roads", [])
            for road in parent:
                self._road_parent[id(road)] = parent
                self.roads.append(road)
            rails = self.data.get("rails", [])
            for road in rails:
                self._road_parent[id(road)] = rails
                road["type"] = "rail"
                self.roads.append(road)

    def _push_undo(self):
        if not self.data:
            return
        self.undo_stack.append(copy.deepcopy(self.data))
        if len(self.undo_stack) > self.max_undo:
            self.undo_stack.pop(0)
        self.redo_stack.clear()

    def _restore_state(self, state):
        if not state:
            return
        self.data = copy.deepcopy(state)
        self._flatten_roads()
        self.selected_road = None
        self.selected_roads = []
        self.selected_point = None
        self._recalc_statistics()
        self.update_info()
        self.render()

    def undo(self):
        if not self.undo_stack:
            self.set_status("Nichts zum Rückgängig machen")
            return
        current = copy.deepcopy(self.data)
        state = self.undo_stack.pop()
        self.redo_stack.append(current)
        self._restore_state(state)
        self.set_status("Rückgängig")

    def redo(self):
        if not self.redo_stack:
            self.set_status("Nichts zum Wiederherstellen")
            return
        current = copy.deepcopy(self.data)
        state = self.redo_stack.pop()
        self.undo_stack.append(current)
        self._restore_state(state)
        self.set_status("Wiederhergestellt")

    @staticmethod
    def _remove_identity(lst, item):
        for i, x in enumerate(lst):
            if x is item:
                del lst[i]
                return True
        return False

    def _clean_data(self, data):
        clean = copy.deepcopy(data)
        if isinstance(clean.get("networks"), list):
            for network in clean.get("networks", []):
                for road in network.get("roads", []):
                    for key in list(road.keys()):
                        if key.startswith("_"):
                            del road[key]
        for key in ("roads", "rails"):
            for road in clean.get(key, []):
                for k in list(road.keys()):
                    if k.startswith("_"):
                        del road[k]
        return clean

    def save_json(self):
        if not self.data:
            messagebox.showwarning("Hinweis", "Keine JSON-Daten geladen.")
            return
        path = filedialog.asksaveasfilename(title="JSON speichern", defaultextension=".json", filetypes=[("JSON", "*.json")])
        if not path:
            return
        try:
            clean = self._clean_data(self.data)
            if self.img:
                clean["image"] = {
                    "width": self.img_w,
                    "height": self.img_h,
                    "source_image": "unknown",
                    "coordinate_system": {"origin": "top-left", "point_order": ["x", "y"]}
                }
                clean["world_bounds"] = {
                    "min_x": -904800,
                    "max_x": 619318,
                    "min_y": -904800,
                    "max_y": 618818
                }
            out = json.dumps(clean, indent=2, ensure_ascii=False)
            with open(path, "w", encoding="utf-8") as f:
                f.write(out)
            self.set_status(f"Gespeichert: {path}")
        except Exception as e:
            messagebox.showerror("Fehler", f"Speichern fehlgeschlagen:\n{e}")

    def world_to_screen(self, wx, wy):
        sx = (wx - self.offset_x) * self.scale
        sy = (wy - self.offset_y) * self.scale
        return sx, sy

    def screen_to_world(self, sx, sy):
        wx = sx / self.scale + self.offset_x
        wy = sy / self.scale + self.offset_y
        return wx, wy

    def set_type(self, t):
        targets = self.selected_roads if self.selected_roads else ([self.selected_road] if self.selected_road else [])
        if not targets:
            return
        self._push_undo()
        for road in targets:
            road["type"] = t
            road.pop("color", None)
        self.update_info()
        self.render()

    def delete_selected(self):
        targets = self.selected_roads if self.selected_roads else ([self.selected_road] if self.selected_road else [])
        if not targets:
            return
        self._push_undo()
        for road in targets:
            parent = self._road_parent.pop(id(road), None)
            if parent:
                self._remove_identity(parent, road)
            self._remove_identity(self.roads, road)
            self._road_network.pop(id(road), None)
        self.selected_road = None
        self.selected_roads = []
        self._recalc_statistics()
        self.update_info()
        self.render()

    def _recalc_statistics(self):
        if not self.data:
            return
        stats = self.data.get("statistics")
        if isinstance(stats, dict):
            road_count = 0
            rail_count = 0
            for r in self.roads:
                if r.get("type") == "rail":
                    rail_count += 1
                else:
                    road_count += 1
            stats["road_count"] = road_count
            stats["rail_count"] = rail_count

    def on_wheel(self, event):
        if not self.img:
            return
        x, y = self.canvas.canvasx(event.x), self.canvas.canvasy(event.y)
        wx, wy = self.screen_to_world(x, y)
        factor = 1.2 if event.delta > 0 else 1 / 1.2
        new_scale = self.scale * factor
        new_scale = max(0.01, min(20.0, new_scale))
        self.scale = new_scale
        # keep mouse over same world point
        self.offset_x = wx - x / self.scale
        self.offset_y = wy - y / self.scale
        self._clamp_offset()
        self.render()

    def _clamp_offset(self):
        if not self.img:
            return
        cw = self.canvas.winfo_width()
        ch = self.canvas.winfo_height()
        max_x = self.img_w - cw / self.scale
        max_y = self.img_h - ch / self.scale
        self.offset_x = max(0.0, min(max_x, self.offset_x))
        self.offset_y = max(0.0, min(max_y, self.offset_y))

    def on_middle_down(self, event):
        self.pan_start = (event.x, event.y)
        self.pan_offset = (self.offset_x, self.offset_y)

    def on_middle_drag(self, event):
        if not hasattr(self, "pan_start"):
            return
        dx = (self.pan_start[0] - event.x) / self.scale
        dy = (self.pan_start[1] - event.y) / self.scale
        self.offset_x = self.pan_offset[0] + dx
        self.offset_y = self.pan_offset[1] + dy
        self._clamp_offset()
        self.render()

    def on_left_down(self, event):
        if not self.img:
            return
        x, y = self.canvas.canvasx(event.x), self.canvas.canvasy(event.y)
        wx, wy = self.screen_to_world(x, y)

        ctrl = (event.state & 0x4) != 0
        shift = (event.state & 0x1) != 0

        # Insert a joint point by clicking on a line:
        # - in edit mode: normal click on a line
        # - in pan mode: Shift+Click on a line
        if self.mode == "edit" or (self.mode == "pan" and shift):
            road, pt = self._find_nearest_point(wx, wy)
            if not pt:
                ins_road, ins_idx, ins_pt, _ = self._find_insert_point(wx, wy)
                if ins_road and ins_pt:
                    self._push_undo()
                    ins_road.get("points", []).insert(ins_idx + 1, ins_pt)
                    self.selected_road = ins_road
                    self.selected_roads = [ins_road]
                    self.selected_point = ins_pt
                    self.update_info()
                    self.render()
                    self.set_status("Neuer Gelenkpunkt eingefügt")
                    return

        if self.mode == "add":
            road, pt = self._find_nearest_point(wx, wy)
            if pt:
                wx, wy = pt[0], pt[1]
            else:
                wx, wy = round(wx), round(wy)
            self.new_points.append([wx, wy])
            self.render()
            # connect two existing points on the fly
            if len(self.new_points) == 2 and pt:
                self.finish_new_road()
            return

        if self.mode == "edit":
            road, pt = self._find_nearest_point(wx, wy)
            self.selected_road = road
            self.selected_roads = []
            self.selected_point = pt
            if self.selected_road:
                # remember state before a potential point drag
                self._undo_before_drag = copy.deepcopy(self.data) if self.data else None
                self._drag_start_point = list(pt) if pt else None
                self.update_info()
                self.render()
            return

        # pan/select mode
        if self.mode == "pan":
            if not ctrl:
                # first try to grab a point (so dragging works in pan mode too)
                road, pt = self._find_nearest_point(wx, wy)
                if road:
                    self.selected_road = road
                    self.selected_point = pt
                    self.selected_roads = [road]
                    self._undo_before_drag = copy.deepcopy(self.data) if self.data else None
                    self._drag_start_point = list(pt) if pt else None
                    self.update_info()
                    self.render()
                    return

        road = self._find_nearest_road(wx, wy)
        if not road:
            # start lasso selection (or simple deselect if no drag)
            self.select_start = (x, y)
            self._lasso_add = bool(ctrl)
            if not ctrl:
                # wait until mouse-up to clear, in case a lasso follows
                self.selected_road = None
                self.selected_point = None
                self.selected_roads = []
                self.update_info()
                self.render()
            return

        selected_ids = {id(r) for r in self.selected_roads}
        if ctrl:
            if id(road) in selected_ids:
                for i, r in enumerate(self.selected_roads):
                    if r is road:
                        self.selected_roads.pop(i)
                        break
                if self.selected_road is road:
                    self.selected_road = self.selected_roads[-1] if self.selected_roads else None
                    self.selected_point = None
            else:
                self.selected_roads.append(road)
                self.selected_road = road
        else:
            self.selected_road = road
            self.selected_roads = [road]
            self.selected_point = None
        self.update_info()
        self.render()

    def on_left_drag(self, event):
        x, y = self.canvas.canvasx(event.x), self.canvas.canvasy(event.y)
        if self.selected_point is not None and self.selected_road:
            wx, wy = self.screen_to_world(x, y)
            px, py = round(wx), round(wy)
            self.selected_point[0] = px
            self.selected_point[1] = py
            self.render()
        elif self.select_start and self.mode == "pan":
            sx, sy = self.select_start
            dx, dy = x - sx, y - sy
            if dx * dx + dy * dy < 25:
                return
            if self.select_rect is None:
                self.select_rect = self.canvas.create_rectangle(
                    sx, sy, x, y, outline="white", dash=(4, 4), width=1, tags="lasso"
                )
            else:
                self.canvas.coords(self.select_rect, sx, sy, x, y)

    def on_left_up(self, event):
        x, y = self.canvas.canvasx(event.x), self.canvas.canvasy(event.y)
        if self._undo_before_drag and self.selected_point and self._drag_start_point:
            if self.selected_point[0] != self._drag_start_point[0] or self.selected_point[1] != self._drag_start_point[1]:
                self.undo_stack.append(self._undo_before_drag)
                if len(self.undo_stack) > self.max_undo:
                    self.undo_stack.pop(0)
                self.redo_stack.clear()
        self._undo_before_drag = None
        self._drag_start_point = None

        if self.select_start:
            sx, sy = self.select_start
            dx, dy = x - sx, y - sy
            if dx * dx + dy * dy >= 25:
                self._finish_lasso(sx, sy, x, y)
            else:
                # click to empty area -> already deselected in on_left_down
                self.set_status("Auswahl aufgehoben")
            self.select_start = None
            if self.select_rect:
                self.canvas.delete(self.select_rect)
                self.select_rect = None

    def _finish_lasso(self, sx, sy, ex, ey):
        wx1, wy1 = self.screen_to_world(sx, sy)
        wx2, wy2 = self.screen_to_world(ex, ey)
        minx, maxx = sorted([wx1, wx2])
        miny, maxy = sorted([wy1, wy2])
        selected = set()
        for road in self.roads:
            for p in road.get("points", []):
                if minx <= p[0] <= maxx and miny <= p[1] <= maxy:
                    selected.add(id(road))
                    break
        if not selected:
            self.set_status("Lasso: nichts ausgewählt")
            return
        if not self._lasso_add:
            self.selected_roads = []
        existing_ids = {id(r) for r in self.selected_roads}
        for road in self.roads:
            if id(road) in selected and id(road) not in existing_ids:
                self.selected_roads.append(road)
        self.selected_road = self.selected_roads[-1]
        self.selected_point = None
        self._lasso_add = False
        self.update_info()
        self.render()
        self.set_status(f"Lasso: {len(self.selected_roads)} Straße(n) ausgewählt")

    def _find_nearest_road(self, wx, wy):
        # 12 screen pixels radius, converted to world pixels
        radius = 12 / max(0.001, self.scale)
        best = None
        best_d = radius * radius
        for road in self.roads:
            pts = road.get("points", [])
            if len(pts) < 2:
                continue
            for p in pts:
                d = dist_sq(p[0], p[1], wx, wy)
                if d < best_d:
                    best_d = d
                    best = road
        return best

    def _find_nearest_point(self, wx, wy):
        radius = 10 / max(0.001, self.scale)
        best_road = None
        best_pt = None
        best_d = radius * radius
        for road in self.roads:
            for p in road.get("points", []):
                d = dist_sq(p[0], p[1], wx, wy)
                if d < best_d:
                    best_d = d
                    best_road = road
                    best_pt = p
        return best_road, best_pt

    def _project_point_on_segment(self, px, py, ax, ay, bx, by):
        """Return closest point on segment a-b and t in [0,1]."""
        abx = bx - ax
        aby = by - ay
        ab_len_sq = abx * abx + aby * aby
        if ab_len_sq == 0:
            return ax, ay, 0.0
        t = max(0.0, min(1.0, ((px - ax) * abx + (py - ay) * aby) / ab_len_sq))
        cx = ax + abx * t
        cy = ay + aby * t
        return cx, cy, t

    def _find_insert_point(self, wx, wy):
        """Find nearest road segment and return (road, insert_index, point, dist_sq)."""
        radius = 15 / max(0.001, self.scale)
        max_d = radius * radius
        best_road = None
        best_idx = -1
        best_pt = None
        best_d = max_d
        for road in self.roads:
            pts = road.get("points", [])
            if len(pts) < 2:
                continue
            for i in range(len(pts) - 1):
                ax, ay = pts[i]
                bx, by = pts[i + 1]
                cx, cy, t = self._project_point_on_segment(wx, wy, ax, ay, bx, by)
                d = dist_sq(wx, wy, cx, cy)
                if d < best_d:
                    best_d = d
                    best_idx = i
                    best_pt = [round(cx), round(cy)]
                    best_road = road
        return best_road, best_idx, best_pt, best_d

    def _insert_point_on_road(self, road, wx, wy):
        pts = road.get("points", [])
        if len(pts) < 2:
            return None
        best_idx = -1
        best_d = float("inf")
        best_pt = None
        for i in range(len(pts) - 1):
            ax, ay = pts[i]
            bx, by = pts[i + 1]
            cx, cy, t = self._project_point_on_segment(wx, wy, ax, ay, bx, by)
            d = dist_sq(wx, wy, cx, cy)
            if d < best_d:
                best_d = d
                best_idx = i
                best_pt = [round(cx), round(cy)]
        radius = 15 / max(0.001, self.scale)
        if best_idx >= 0 and best_pt and best_d <= radius * radius:
            self._push_undo()
            road.get("points", []).insert(best_idx + 1, best_pt)
            return best_pt
        return None

    def _next_road_id(self):
        max_id = 0
        for r in self.roads:
            try:
                max_id = max(max_id, int(r.get("id", 0)))
            except Exception:
                pass
        return max_id + 1

    def _create_road(self, points, t="main"):
        if not points or len(points) < 2:
            return None
        self._push_undo()
        new_id = self._next_road_id()
        new_road = {
            "id": new_id,
            "type": t,
            "points": [list(p) for p in points],
        }
        self.roads.append(new_road)

        # insert into source structure
        if self.data and isinstance(self.data.get("networks"), list):
            parent = self.data["networks"][0].setdefault("roads", [])
            parent.append(new_road)
            self._road_parent[id(new_road)] = parent
            self._road_network[id(new_road)] = self.data["networks"][0]
        elif self.data:
            parent = self.data.setdefault("roads", [])
            parent.append(new_road)
            self._road_parent[id(new_road)] = parent

        self._recalc_statistics()
        self.render()
        return new_road

    def finish_new_road(self):
        if self.mode != "add" or len(self.new_points) < 2:
            return
        road = self._create_road(self.new_points, "main")
        self.new_points = []
        if road:
            self.set_status(f"Neue Straße #{road['id']} erstellt")

    def on_right_click(self, event):
        if not self.img or not self.data:
            return
        x, y = self.canvas.canvasx(event.x), self.canvas.canvasy(event.y)
        wx, wy = self.screen_to_world(x, y)
        road, pt = self._find_nearest_point(wx, wy)

        if not pt:
            self.set_status("Kein Punkt unter der Maus")
            return

        if self.selected_point is None:
            # select starting point
            self.selected_road = road
            self.selected_roads = [road] if road else []
            self.selected_point = pt
            self.update_info()
            self.render()
            self.set_status("Startpunkt gewählt – rechtsklicken Sie einen Zielpunkt")
            return

        if pt is self.selected_point or (pt[0] == self.selected_point[0] and pt[1] == self.selected_point[1]):
            self.set_status("Zielpunkt ist der Startpunkt")
            return

        t = self.selected_road.get("type", "main") if self.selected_road else "main"
        new_road = self._create_road([self.selected_point, pt], t)
        if new_road:
            self.selected_road = new_road
            self.selected_roads = [new_road]
            self.selected_point = None
            self.update_info()
            self.render()
            self.set_status(f"Direktverbindung #{new_road['id']} erstellt")

    def cancel_new_road(self):
        if self.new_points:
            self.new_points = []
            self.render()
        elif self.selected_roads:
            self.selected_roads = []
            self.selected_road = None
            self.update_info()
            self.render()

    def _chain_roads(self, roads):
        """Greedy end-to-end ordering. Returns flat list of [x, y] points."""
        first = roads[0]
        chain = [list(p) for p in first.get("points", [])]
        if len(chain) < 2:
            return chain
        used = {id(first)}
        while len(used) < len(roads):
            best = None
            best_is_start = True
            best_d = float("inf")
            end = chain[-1]
            for road in roads:
                if id(road) in used:
                    continue
                pts = road.get("points", [])
                if len(pts) < 2:
                    continue
                start = pts[0]
                last = pts[-1]
                d_start = dist_sq(end[0], end[1], start[0], start[1])
                d_last = dist_sq(end[0], end[1], last[0], last[1])
                if d_start < best_d:
                    best_d = d_start
                    best = road
                    best_is_start = True
                if d_last < best_d:
                    best_d = d_last
                    best = road
                    best_is_start = False
            if not best:
                break
            pts = [list(p) for p in best.get("points", [])]
            if not best_is_start:
                pts = pts[::-1]
            # avoid duplicate join point if endpoints coincide
            if chain and pts and dist_sq(chain[-1][0], chain[-1][1], pts[0][0], pts[0][1]) <= 2:
                chain.extend(pts[1:])
            else:
                chain.extend(pts)
            used.add(id(best))
        return chain

    def merge_selected_roads(self):
        if len(self.selected_roads) < 2:
            messagebox.showinfo("Verbinden", "Mindestens 2 Straßen mit Strg+Klick auswählen.")
            return
        self._push_undo()
        # all selected must be same type (or use first)
        types = {r.get("type", "secondary") for r in self.selected_roads}
        if len(types) > 1:
            if not messagebox.askyesno("Verbinden", f"Verschiedene Typen gewählt: {', '.join(types)}.\nMit Typ '{self.selected_road.get('type', 'secondary')}' verbinden?"):
                return
        t = self.selected_road.get("type", "secondary") if self.selected_road else "secondary"
        # keep id of first selected, or new max if missing
        first_id = self.selected_road.get("id") if self.selected_road else None
        if first_id is None:
            max_id = 0
            for r in self.roads:
                try:
                    max_id = max(max_id, int(r.get("id", 0)))
                except Exception:
                    pass
            first_id = max_id + 1

        # build merged points
        merged_points = self._chain_roads(self.selected_roads)
        if len(merged_points) < 2:
            messagebox.showwarning("Verbinden", "Konnte keine sinnvolle Kette bilden.")
            return

        merged = {
            "id": first_id,
            "type": t,
            "points": merged_points,
        }

        # remove old roads from source lists and flat list
        parent = None
        network = None
        for road in self.selected_roads:
            p = self._road_parent.pop(id(road), None)
            if p:
                self._remove_identity(p, road)
                if parent is None:
                    parent = p
            n = self._road_network.pop(id(road), None)
            if n and network is None:
                network = n
            self._remove_identity(self.roads, road)

        # insert merged into first suitable parent
        if parent is not None:
            parent.append(merged)
            self._road_parent[id(merged)] = parent
            if network:
                self._road_network[id(merged)] = network
        else:
            # fallback: add to data["roads"]
            if self.data and isinstance(self.data.get("networks"), list):
                parent = self.data["networks"][0].setdefault("roads", [])
                parent.append(merged)
                self._road_parent[id(merged)] = parent
                self._road_network[id(merged)] = self.data["networks"][0]
            elif self.data:
                parent = self.data.setdefault("roads", [])
                parent.append(merged)
                self._road_parent[id(merged)] = parent

        merged_count = len(self.selected_roads)
        self.roads.append(merged)
        self.selected_road = merged
        self.selected_roads = [merged]
        self._recalc_statistics()
        self.update_info()
        self.render()
        self.set_status(f"{merged_count} Straßen verbunden → #{merged['id']} ({len(merged_points)} Punkte)")

    def update_info(self):
        if self.selected_roads:
            total_pts = sum(len(r.get("points", [])) for r in self.selected_roads)
            self.info_label.config(text=f"{len(self.selected_roads)} ausgewählt · {total_pts} Punkte")
        elif self.selected_road:
            t = self.selected_road.get("type", "?")
            n = len(self.selected_road.get("points", []))
            self.info_label.config(text=f"#{self.selected_road.get('id', '?')} · {TYPE_LABELS.get(t, t)} · {n} Punkte")
        else:
            self.info_label.config(text="Keine Straße")

    def render(self):
        self.canvas.delete("all")
        cw = self.canvas.winfo_width()
        ch = self.canvas.winfo_height()
        if cw < 2 or ch < 2:
            return

        if self.img:
            self._render_image(cw, ch)
        else:
            self.canvas.create_text(cw // 2, ch // 2, text="Bitte Bild laden", fill="#555")

        self._render_roads(cw, ch)

    def _render_image(self, cw, ch):
        view_w = cw / self.scale
        view_h = ch / self.scale
        x0 = int(self.offset_x)
        y0 = int(self.offset_y)
        x1 = min(self.img_w, int(x0 + view_w) + 1)
        y1 = min(self.img_h, int(y0 + view_h) + 1)
        if x1 <= x0 or y1 <= y0:
            return
        crop = self.img.crop((x0, y0, x1, y1))
        disp_w = max(1, int((x1 - x0) * self.scale))
        disp_h = max(1, int((y1 - y0) * self.scale))
        # fast downscaling
        resized = crop.resize((disp_w, disp_h), Image.Resampling.BILINEAR)
        self.photo = ImageTk.PhotoImage(resized)
        # calculate top-left in screen coords
        sx0 = (x0 - self.offset_x) * self.scale
        sy0 = (y0 - self.offset_y) * self.scale
        self.canvas.create_image(sx0, sy0, anchor=tk.NW, image=self.photo)

    def _render_roads(self, cw, ch):
        selected_ids = {id(r) for r in self.selected_roads}
        for road in self.roads:
            pts = road.get("points", [])
            if len(pts) < 2:
                continue
            t = road.get("type", "secondary")
            color = COLORS.get(t, road.get("color", "#ffffff"))
            width = 3 if t in ("main", "primary") else 2
            screen_pts = []
            for p in pts:
                sx, sy = self.world_to_screen(p[0], p[1])
                screen_pts.extend([sx, sy])
            # draw line
            is_selected = id(road) in selected_ids
            line_width = width + (3 if is_selected else 0)
            dash = (8, 6) if t in ("rail", "railroad") else None
            self.canvas.create_line(screen_pts, fill=color, width=line_width, dash=dash, cap=tk.ROUND, join=tk.ROUND)

        # draw points
        for road in self.roads:
            pts = road.get("points", [])
            is_selected = id(road) in selected_ids
            for i, p in enumerate(pts):
                sx, sy = self.world_to_screen(p[0], p[1])
                r = 3 if is_selected else 2
                fill = "#00ffcc" if is_selected else "#aaa"
                self.canvas.create_oval(sx - r, sy - r, sx + r, sy + r, fill=fill, outline="")

        # draw new road in progress
        if self.new_points:
            pts = self.new_points
            screen_pts = []
            for p in pts:
                sx, sy = self.world_to_screen(p[0], p[1])
                screen_pts.extend([sx, sy])
            self.canvas.create_line(screen_pts, fill="#00ffcc", width=3, cap=tk.ROUND, join=tk.ROUND)
            for p in pts:
                sx, sy = self.world_to_screen(p[0], p[1])
                self.canvas.create_oval(sx - 3, sy - 3, sx + 3, sy + 3, fill="#00ffcc", outline="")


def main():
    root = tk.Tk()
    app = RoadEditor(root)
    root.mainloop()


if __name__ == "__main__":
    main()
