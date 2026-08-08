(function () {
  'use strict';

  // Default SCUM world bounds (game coordinates)
  const DEFAULT_BOUNDS = {
    min_x: -904800,
    max_x: 619318,
    min_y: -904800,
    max_y: 618818
  };

  const DEFAULT_IMAGE_SIZE = { width: 14481, height: 14481 };
  const SNAP_PX = 30; // merge nodes within 30 image pixels (same as road editor)

  // ------- Binary min-heap -------
  class MinHeap {
    constructor() { this.data = []; }
    push(value, priority) {
      this.data.push({ value, priority });
      this._up(this.data.length - 1);
    }
    pop() {
      if (this.data.length === 0) return null;
      const top = this.data[0];
      const end = this.data.pop();
      if (this.data.length > 0) {
        this.data[0] = end;
        this._down(0);
      }
      return top;
    }
    _up(i) {
      while (i > 0) {
        const p = Math.floor((i - 1) / 2);
        if (this.data[p].priority <= this.data[i].priority) break;
        [this.data[p], this.data[i]] = [this.data[i], this.data[p]];
        i = p;
      }
    }
    _down(i) {
      while (true) {
        const l = 2 * i + 1;
        const r = 2 * i + 2;
        let min = i;
        if (l < this.data.length && this.data[l].priority < this.data[min].priority) min = l;
        if (r < this.data.length && this.data[r].priority < this.data[min].priority) min = r;
        if (min === i) break;
        [this.data[i], this.data[min]] = [this.data[min], this.data[i]];
        i = min;
      }
    }
  }

  // ------- Graph -------
  class RoadGraph {
    constructor(meta) {
      this.image = Object.assign({}, DEFAULT_IMAGE_SIZE, meta && meta.image ? meta.image : {});
      this.bounds = Object.assign({}, DEFAULT_BOUNDS, meta && meta.world_bounds ? meta.world_bounds : {});
      this.nodeMap = new Map(); // "x,y" -> index
      this.nodes = [];          // { x, y, gameX, gameY }
      this.edges = [];          // [{ to, dist }, ...] per node
      this.snapPx = SNAP_PX;
      this.cellSize = SNAP_PX;
      this.grid = new Map();    // "cx,cy" -> [node indices]
    }

    _cellKey(x, y) {
      const cx = Math.floor(x / this.cellSize);
      const cy = Math.floor(y / this.cellSize);
      return `${cx},${cy}`;
    }

    _addToGrid(idx) {
      const n = this.nodes[idx];
      const key = this._cellKey(n.x, n.y);
      if (!this.grid.has(key)) this.grid.set(key, []);
      this.grid.get(key).push(idx);
    }

    _findNearbyNode(x, y) {
      const cx = Math.floor(x / this.cellSize);
      const cy = Math.floor(y / this.cellSize);
      const snap2 = this.snapPx * this.snapPx;
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const key = `${cx + dx},${cy + dy}`;
          const list = this.grid.get(key);
          if (!list) continue;
          for (let i = 0; i < list.length; i++) {
            const n = this.nodes[list[i]];
            const dxx = n.x - x;
            const dyy = n.y - y;
            if (dxx * dxx + dyy * dyy <= snap2) return list[i];
          }
        }
      }
      return -1;
    }

    pixelToGame(px, py) {
      const w = this.bounds.max_x - this.bounds.min_x;
      const h = this.bounds.max_y - this.bounds.min_y;
      const gameX = this.bounds.max_x - (px / this.image.width) * w;
      const gameY = this.bounds.max_y - (py / this.image.height) * h;
      return { x: gameX, y: gameY };
    }

    _nodeKey(x, y) {
      return `${Math.round(x)},${Math.round(y)}`;
    }

    getOrAddNode(x, y) {
      const existing = this._findNearbyNode(x, y);
      if (existing !== -1) return existing;
      const game = this.pixelToGame(x, y);
      const idx = this.nodes.length;
      this.nodes.push({ x, y, gameX: game.x, gameY: game.y });
      this.edges.push([]);
      this.nodeMap.set(this._nodeKey(x, y), idx);
      this._addToGrid(idx);
      return idx;
    }

    addEdge(a, b, costMul) {
      if (a === b) return;
      costMul = costMul || 1.0;
      const na = this.nodes[a];
      const nb = this.nodes[b];
      const dx = na.gameX - nb.gameX;
      const dy = na.gameY - nb.gameY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const cost = dist * costMul;
      this.edges[a].push({ to: b, dist, cost });
      this.edges[b].push({ to: a, dist, cost });
    }

    loadFromData(data) {
      if (!data) return;
      let roads = [];
      if (Array.isArray(data.roads)) roads = roads.concat(data.roads);
      if (Array.isArray(data.rails)) roads = roads.concat(data.rails);
      if (Array.isArray(data.networks)) {
        data.networks.forEach(nw => {
          if (Array.isArray(nw.roads)) roads = roads.concat(nw.roads);
        });
      }

      // Collect all segments first (no edges yet)
      const allSegments = [];

      const ROAD_WEIGHTS = { primary: 1.0, main: 1.0, secondary: 1.6, tertiary: 1.6 };
      roads.forEach(road => {
        const pts = road.points || [];
        if (pts.length < 2) return;
        if (road.type === 'rail') return;
        const weight = ROAD_WEIGHTS[road.type] || 1.6;
        let prev = this.getOrAddNode(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length; i++) {
          const cur = this.getOrAddNode(pts[i][0], pts[i][1]);
          if (cur !== prev) {
            allSegments.push({ a: prev, b: cur, costMul: weight });
          }
          prev = cur;
        }
      });

      // Find intersections and split segments at crossing points
      this._splitAtIntersections(allSegments);
    }

    _splitAtIntersections(segments) {
      // Precompute bounding boxes
      const boxes = segments.map(s => {
        const na = this.nodes[s.a], nb = this.nodes[s.b];
        return { minX: Math.min(na.x, nb.x), minY: Math.min(na.y, nb.y), maxX: Math.max(na.x, nb.x), maxY: Math.max(na.y, nb.y) };
      });

      // For each segment, collect intersection points on it
      const splits = segments.map(() => []);

      for (let i = 0; i < segments.length; i++) {
        const s1 = segments[i];
        const na = this.nodes[s1.a];
        const nb = this.nodes[s1.b];
        const bi = boxes[i];
        for (let j = i + 1; j < segments.length; j++) {
          const bj = boxes[j];
          if (bi.maxX < bj.minX || bj.maxX < bi.minX || bi.maxY < bj.minY || bj.maxY < bi.minY) continue;
          const s2 = segments[j];
          if (s1.a === s2.a || s1.a === s2.b || s1.b === s2.a || s1.b === s2.b) continue;
          const nc = this.nodes[s2.a];
          const nd = this.nodes[s2.b];
          const ip = this._segIntersect(na.x, na.y, nb.x, nb.y, nc.x, nc.y, nd.x, nd.y);
          if (!ip) continue;
          const nodeIdx = this.getOrAddNode(ip.x, ip.y);
          if (nodeIdx === s1.a || nodeIdx === s1.b || nodeIdx === s2.a || nodeIdx === s2.b) continue;
          splits[i].push(nodeIdx);
          splits[j].push(nodeIdx);
        }
      }

      // Now build edges: for each segment, sort intersection points along the segment
      // and create sub-edges a -> split1 -> split2 -> ... -> b
      for (let i = 0; i < segments.length; i++) {
        const s = segments[i];
        const na = this.nodes[s.a];
        const nb = this.nodes[s.b];
        const pts = splits[i];
        // Sort intersection points by position along segment (a -> b)
        pts.sort((p1, p2) => {
          const n1 = this.nodes[p1], n2 = this.nodes[p2];
          const t1 = (n1.x - na.x) * (nb.x - na.x) + (n1.y - na.y) * (nb.y - na.y);
          const t2 = (n2.x - na.x) * (nb.x - na.x) + (n2.y - na.y) * (nb.y - na.y);
          return t1 - t2;
        });
        // Remove duplicates
        const unique = [];
        for (let k = 0; k < pts.length; k++) {
          if (k === 0 || pts[k] !== pts[k - 1]) unique.push(pts[k]);
        }
        // Build chain: a -> split[0] -> ... -> b
        let prev = s.a;
        for (let k = 0; k < unique.length; k++) {
          this.addEdge(prev, unique[k], s.costMul);
          prev = unique[k];
        }
        this.addEdge(prev, s.b, s.costMul);
      }
    }

    _segIntersect(x1, y1, x2, y2, x3, y3, x4, y4) {
      const denom = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
      if (Math.abs(denom) < 1e-10) return null;
      const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / denom;
      const u = -((x1 - x2) * (y1 - y3) - (y1 - y2) * (x1 - x3)) / denom;
      if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
        return { x: x1 + t * (x2 - x1), y: y1 + t * (y2 - y1) };
      }
      return null;
    }

    nearestNode(gameX, gameY) {
      let best = -1;
      let bestD = Infinity;
      for (let i = 0; i < this.nodes.length; i++) {
        const n = this.nodes[i];
        const dx = n.gameX - gameX;
        const dy = n.gameY - gameY;
        const d = dx * dx + dy * dy;
        if (d < bestD) { bestD = d; best = i; }
      }
      return best;
    }

    distance(a, b) {
      const dx = this.nodes[a].gameX - this.nodes[b].gameX;
      const dy = this.nodes[a].gameY - this.nodes[b].gameY;
      return Math.sqrt(dx * dx + dy * dy);
    }

    findRoute(startGameX, startGameY, endGameX, endGameY) {
      if (this.nodes.length === 0) return null;
      const start = this.nearestNode(startGameX, startGameY);
      const end = this.nearestNode(endGameX, endGameY);
      if (start === -1 || end === -1 || start === end) return null;

      const heap = new MinHeap();
      const g = new Float64Array(this.nodes.length).fill(Infinity);
      const f = new Float64Array(this.nodes.length).fill(Infinity);
      const cameFrom = new Int32Array(this.nodes.length).fill(-1);
      const open = new Set();

      g[start] = 0;
      f[start] = this.heuristic(start, end);
      heap.push(start, f[start]);
      open.add(start);

      while (heap.data.length > 0) {
        const { value: current } = heap.pop();
        open.delete(current);
        if (current === end) {
          return this._reconstruct(cameFrom, end);
        }

        const edges = this.edges[current];
        for (let i = 0; i < edges.length; i++) {
          const e = edges[i];
          const neighbor = e.to;
          const tentative = g[current] + e.cost;
          if (tentative < g[neighbor]) {
            cameFrom[neighbor] = current;
            g[neighbor] = tentative;
            f[neighbor] = tentative + this.heuristic(neighbor, end);
            if (!open.has(neighbor)) {
              heap.push(neighbor, f[neighbor]);
              open.add(neighbor);
            }
          }
        }
      }
      return null;
    }

    heuristic(a, b) {
      const dx = this.nodes[a].gameX - this.nodes[b].gameX;
      const dy = this.nodes[a].gameY - this.nodes[b].gameY;
      return Math.sqrt(dx * dx + dy * dy);
    }

    _reconstruct(cameFrom, end) {
      const path = [];
      let current = end;
      while (current !== -1) {
        const n = this.nodes[current];
        path.unshift({ x: n.gameX, y: n.gameY });
        current = cameFrom[current];
      }
      return path;
    }
  }

  // ------- Navigator API -------
  const RoadNavigator = {
    graph: null,
    target: null,
    status: 'not loaded',

    async init(options) {
      options = options || {};
      const urls = options.urls || ['roads.json', 'scum_map_roads.json'];
      for (const url of urls) {
        try {
          const res = await fetch(url, { cache: 'no-store' });
          if (!res.ok) continue;
          const data = await res.json();
          this.graph = new RoadGraph(data);
          this.graph.loadFromData(data);
          this.status = `loaded: ${this.graph.nodes.length} nodes, ${this.graph.edges.reduce((s, e) => s + e.length, 0) / 2} edges`;
          return this.graph;
        } catch (e) {
          // try next
        }
      }
      this.status = 'no road file found';
      return null;
    },

    setTarget(gameX, gameY) {
      this.target = { x: gameX, y: gameY };
    },

    clearTarget() {
      this.target = null;
    },

    findRoute(startX, startY) {
      if (!this.graph || !this.target) return null;
      return this.graph.findRoute(startX, startY, this.target.x, this.target.y);
    }
  };

  window.RoadNavigator = RoadNavigator;
})();
