// Sokoban solver for make.fun's sokoban-solver-01-run-20261121.
//
// Approach: the generator builds each level as a 1-wide hallway plus 1-4
// rooms off it, one door each; a box pushed out of a room can never return,
// so every room is an independent push-optimal subproblem and the level
// optimum is the sum of the room optima. Each room is solved with a
// push-based A* (player-reachability BFS between pushes, an assignment
// heuristic over wall-aware distances, and deadlock pruning), then the room
// solutions are stitched together with plain walks along the hallway.
//
// Deterministic: fixed direction order, a counter tie-break in the heap,
// no clock, no randomness, no environment reads beyond the two directories.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Directions in fixed order: up, down, left, right.
const DX = [0, 0, -1, 1];
const DY = [-1, 1, 0, 0];
const DC = ['u', 'd', 'l', 'r'];

interface Level {
  w: number;
  h: number;
  wall: Uint8Array;
  goal: Uint8Array;
  boxes: number[];
  player: number;
}

function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goal = new Uint8Array(w * h);
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goal[i] = 1;
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  return { w, h, wall, goal, boxes, player };
}

// BFS over cells where pass(c) is true, from `from`. Returns the prev-cell
// array (-1 unvisited, prev[from] = from) or null when `to` is unreachable.
function bfsPrev(
  w: number,
  h: number,
  pass: (c: number) => boolean,
  from: number,
  to: number,
): Int32Array | null {
  const prev = new Int32Array(w * h).fill(-1);
  if (!pass(from)) return null;
  prev[from] = from;
  const q = [from];
  for (let qi = 0; qi < q.length; qi++) {
    const c = q[qi];
    if (c === to) return prev;
    const x = c % w;
    const y = (c / w) | 0;
    for (let d = 0; d < 4; d++) {
      const nx = x + DX[d];
      const ny = y + DY[d];
      if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
      const n = ny * w + nx;
      if (prev[n] !== -1 || !pass(n)) continue;
      prev[n] = c;
      q.push(n);
    }
  }
  return prev[to] !== -1 ? prev : null;
}

// Rebuild the move string from a bfsPrev result.
function pathFrom(prev: Int32Array, from: number, to: number): string {
  if (from === to) return '';
  let out = '';
  let c = to;
  while (c !== from) {
    const p = prev[c];
    const d = c - p;
    out = (d === -1 ? 'l' : d === 1 ? 'r' : d < 0 ? 'u' : 'd') + out;
    c = p;
  }
  return out;
}

// Shortest walk from `from` to `to` avoiding walls and the cells in
// `blocked` (a Uint8Array); `allow` restricts the walk to a subset of cells
// when given. Null when unreachable.
function walk(
  w: number,
  h: number,
  wall: Uint8Array,
  blocked: Uint8Array | null,
  from: number,
  to: number,
  allow: Uint8Array | null,
): string | null {
  const pass = (c: number): boolean =>
    !wall[c] && (!blocked || !blocked[c]) && (!allow || !!allow[c]);
  const prev = bfsPrev(w, h, pass, from, to);
  return prev === null ? null : pathFrom(prev, from, to);
}

// Smallest cell reachable from `from` (canonical player position for a
// given box layout), over `allow` avoiding `blocked`.
function canonPlayer(
  w: number,
  h: number,
  allow: Uint8Array,
  blocked: Uint8Array,
  from: number,
): number {
  const seen = new Uint8Array(w * h);
  let best = from;
  const q = [from];
  seen[from] = 1;
  for (let qi = 0; qi < q.length; qi++) {
    const c = q[qi];
    if (c < best) best = c;
    const x = c % w;
    const y = (c / w) | 0;
    for (let d = 0; d < 4; d++) {
      const nx = x + DX[d];
      const ny = y + DY[d];
      if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
      const n = ny * w + nx;
      if (!seen[n] && allow[n] && !blocked[n]) {
        seen[n] = 1;
        q.push(n);
      }
    }
  }
  return best;
}

// Push-optimal A* for one room. `cells` are the room's floor cells (door
// cell included), `outside` is the hallway cell just outside the door and
// is walkable by the player only. Returns the move string from `outside`
// (player starts there) that puts every room box on a room goal, or null.
function solveRoom(
  w: number,
  h: number,
  wall: Uint8Array,
  goal: Uint8Array,
  cells: number[],
  outside: number,
  boxes0: number[],
  goals: number[],
): string | null {
  const allow = new Uint8Array(w * h);
  for (const c of cells) allow[c] = 1;
  allow[outside] = 1;
  const n = boxes0.length;
  // The door cell: the room cell touching the hallway cell outside.
  let door = -1;
  {
    const x = outside % w;
    const y = (outside / w) | 0;
    for (let d = 0; d < 4; d++) {
      const nx = x + DX[d];
      const ny = y + DY[d];
      if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
      const c = ny * w + nx;
      if (allow[c] && !wall[c]) door = c;
    }
  }

  // Wall-aware distance from every cell to each goal (BFS over room floor,
  // ignoring boxes): a push moves one box one step, so the assignment total
  // below is an admissible heuristic. Cells no goal reaches are dead.
  const dist: Int32Array[] = [];
  const dead = new Uint8Array(w * h);
  for (const c of cells) dead[c] = 1;
  for (const g of goals) {
    const d = new Int32Array(w * h).fill(-1);
    d[g] = 0;
    const q = [g];
    for (let qi = 0; qi < q.length; qi++) {
      const c = q[qi];
      dead[c] = 0;
      const x = c % w;
      const y = (c / w) | 0;
      for (let k = 0; k < 4; k++) {
        const nx = x + DX[k];
        const ny = y + DY[k];
        if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
        const m = ny * w + nx;
        if (d[m] === -1 && allow[m] && !wall[m]) {
          d[m] = d[c] + 1;
          q.push(m);
        }
      }
    }
    dist.push(d);
  }

  // Minimum assignment of boxes to goals over the wall-aware distances
  // (n <= 4, so all permutations). Infinity when no assignment reaches.
  const perms: number[][] = [];
  const used = new Array(n).fill(false);
  const cur: number[] = [];
  const genPerm = (): void => {
    if (cur.length === n) {
      perms.push([...cur]);
      return;
    }
    for (let i = 0; i < n; i++) {
      if (!used[i]) {
        used[i] = true;
        cur.push(i);
        genPerm();
        cur.pop();
        used[i] = false;
      }
    }
  };
  genPerm();
  const heuristic = (boxes: number[]): number => {
    let best = Infinity;
    for (const p of perms) {
      let s = 0;
      for (let i = 0; i < n; i++) {
        const d = dist[p[i]]![boxes[i]!];
        if (d < 0) {
          s = Infinity;
          break;
        }
        s += d;
      }
      if (s < best) best = s;
    }
    return best;
  };

  // Deadlock tests on a box layout (boxMask marks box cells). All are
  // sound: a flagged layout can never reach all goals. Only walls count as
  // blockers here: a neighbouring box may still move away, so treating
  // boxes as walls would prune solvable layouts.
  const deadlocked = (boxes: number[], boxMask: Uint8Array): boolean => {
    const isWall = (c: number): boolean => c < 0 || c >= w * h || wall[c] || !allow[c];
    for (const b of boxes) {
      if (goal[b]) continue;
      if (dead[b]) return true;
      const x = b % w;
      const y = (b / w) | 0;
      // Corner: walls on two perpendicular sides.
      for (const [d1, d2] of [[0, 2], [0, 3], [1, 2], [1, 3]] as const) {
        if (isWall(b + DY[d1] * w + DX[d1]) && isWall(b + DY[d2] * w + DX[d2])) return true;
      }
      // Frozen against walls alone: no push direction is open even
      // ignoring the other boxes.
      let movable = false;
      for (let d = 0; d < 4; d++) {
        if (!isWall(b + DY[d] * w + DX[d]) && !isWall(b - DY[d] * w - DX[d])) {
          movable = true;
          break;
        }
      }
      if (!movable) return true;
      // 2x2 block of walls/boxes holding a box and no goal: no box in
      // such a block can ever be pushed first (each push direction has a
      // wall/box as its target or as the square the player would stand on).
      for (let ox = 0; ox <= 1; ox++) {
        for (let oy = 0; oy <= 1; oy++) {
          const bx = x - ox;
          const by = y - oy;
          if (bx < 0 || by < 0 || bx + 1 >= w || by + 1 >= h) continue;
          let all = true;
          let hasGoal = false;
          for (let a = 0; a < 2; a++) {
            for (let c = 0; c < 2; c++) {
              const cell = (by + a) * w + bx + c;
              if (goal[cell]) hasGoal = true;
              if (!isWall(cell) && !boxMask[cell]) all = false;
            }
          }
          if (all && !hasGoal) return true;
        }
      }
      // Along a wall: a box that can only slide along a wall segment whose
      // both ends are shut (a wall, or the board's edge, beyond each end)
      // and which holds no goal can never reach a goal. An open end lets
      // the box slide off the segment, so it is not a deadlock.
      for (let d = 0; d < 4; d++) {
        const wx = x + DX[d];
        const wy = y + DY[d];
        if (wx < 0 || wx >= w || wy < 0 || wy >= h) continue;
        if (!wall[wy * w + wx]) continue;
        const px = DX[(d + 2) % 4];
        const py = DY[(d + 2) % 4];
        let hasGoal = false;
        let closed = true;
        for (const s of [1, -1]) {
          let cx = x;
          let cy = y;
          for (;;) {
            if (goal[cy * w + cx]) hasGoal = true;
            const nx = cx + px * s;
            const ny = cy + py * s;
            if (nx < 0 || nx >= w || ny < 0 || ny >= h) break;
            const nc = ny * w + nx;
            if (wall[nc] || !allow[nc]) break;
            const sx = nx + DX[d];
            const sy = ny + DY[d];
            if (sx < 0 || sx >= w || sy < 0 || sy >= h || !wall[sy * w + sx]) {
              closed = false;
              break;
            }
            cx = nx;
            cy = ny;
          }
        }
        if (closed && !hasGoal) return true;
      }
    }
    return false;
  };

  interface Node {
    boxes: number[];
    player: number;
    parent: number;
    depth: number;
    moves: string;
  }
  const nodes: Node[] = [];
  const startBoxes = [...boxes0].sort((a, b) => a - b);
  const h0 = heuristic(startBoxes);
  if (!Number.isFinite(h0)) return null;
  nodes.push({ boxes: startBoxes, player: outside, parent: -1, depth: 0, moves: '' });

  // Binary heap of [f, counter, nodeIdx]; the counter keeps ties in
  // insertion order so the search is fully deterministic.
  const heap: [number, number, number][] = [];
  let counter = 0;
  const heapPush = (f: number, idx: number): void => {
    heap.push([f, counter++, idx]);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p]![0] < heap[i]![0] || (heap[p]![0] === heap[i]![0] && heap[p]![1] < heap[i]![1])) break;
      [heap[p], heap[i]] = [heap[i]!, heap[p]!];
      i = p;
    }
  };
  const heapPop = (): number => {
    const top = heap[0]![2];
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < heap.length && (heap[l]![0] < heap[m]![0] || (heap[l]![0] === heap[m]![0] && heap[l]![1] < heap[m]![1]))) m = l;
        if (r < heap.length && (heap[r]![0] < heap[m]![0] || (heap[r]![0] === heap[m]![0] && heap[r]![1] < heap[m]![1]))) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i]!, heap[m]!];
        i = m;
      }
    }
    return top;
  };
  heapPush(h0, 0);

  const seen = new Map<string, number>();
  const keyOf = (boxes: number[], player: number, boxMask: Uint8Array): string =>
    boxes.join(',') + '|' + canonPlayer(w, h, allow, boxMask, player);
  {
    const m = new Uint8Array(w * h);
    for (const b of startBoxes) m[b] = 1;
    seen.set(keyOf(startBoxes, outside, m), 0);
  }

  let expansions = 0;
  const MAX_EXPANSIONS = 4000000;
  while (heap.length > 0) {
    const idx = heapPop();
    const node = nodes[idx]!;
    const boxMask = new Uint8Array(w * h);
    for (const b of node.boxes) boxMask[b] = 1;
    // Goal: every box on a goal and the player can still walk out to the
    // door (so the finished room never shuts the player in).
    let solved = true;
    for (const b of node.boxes) if (!goal[b]) { solved = false; break; }
    if (solved && door >= 0) {
      const out = walk(w, h, wall, boxMask, node.player, door, allow);
      if (out !== null) {
        const parts: string[] = [];
        let cur = idx;
        while (cur !== -1) {
          parts.push(nodes[cur]!.moves);
          cur = nodes[cur]!.parent;
        }
        parts.reverse();
        return parts.join('');
      }
    }
    if (++expansions > MAX_EXPANSIONS) return null;
    // Expand: every push of every box the player can reach.
    for (let bi = 0; bi < n; bi++) {
      const b = node.boxes[bi]!;
      for (let d = 0; d < 4; d++) {
        const t = b + DY[d] * w + DX[d];
        const p = b - DY[d] * w - DX[d];
        if (t < 0 || t >= w * h || p < 0 || p >= w * h) continue;
        if (!allow[t] || wall[t] || boxMask[t]) continue;
        if (!allow[p] || wall[p] || boxMask[p]) continue;
        const wpath = walk(w, h, wall, boxMask, node.player, p, allow);
        if (wpath === null) continue;
        const nb = [...node.boxes];
        nb[bi] = t;
        nb.sort((a, c) => a - c);
        const nm = new Uint8Array(w * h);
        for (const x of nb) nm[x] = 1;
        if (deadlocked(nb, nm)) continue;
        const hh = heuristic(nb);
        if (!Number.isFinite(hh)) continue;
        const key = keyOf(nb, b, nm);
        const ng = node.depth + 1;
        const prev = seen.get(key);
        if (prev !== undefined && prev <= ng) continue;
        seen.set(key, ng);
        nodes.push({ boxes: nb, player: b, parent: idx, depth: ng, moves: wpath + DC[d] });
        heapPush(ng + hh, nodes.length - 1);
      }
    }
  }
  return null;
}

// Solve one whole level. Returns the move string, or '' when unsolved.
function solveLevel(text: string): string {
  const { w, h, wall, goal, boxes, player } = parseLevel(text);
  const hallRow = (player / w) | 0;
  const inHall = (c: number): boolean => ((c / w) | 0) === hallRow;

  // Rooms: connected components of floor cells outside the hallway row.
  const seenCell = new Uint8Array(w * h);
  const rooms: { cells: number[]; boxes: number[]; goals: number[]; door: number; outside: number }[] = [];
  for (let c = 0; c < w * h; c++) {
    if (wall[c] || inHall(c) || seenCell[c]) continue;
    const cells: number[] = [];
    const q = [c];
    seenCell[c] = 1;
    for (let qi = 0; qi < q.length; qi++) {
      const cur = q[qi]!;
      cells.push(cur);
      const x = cur % w;
      const y = (cur / w) | 0;
      for (let d = 0; d < 4; d++) {
        const nx = x + DX[d];
        const ny = y + DY[d];
        if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
        const n = ny * w + nx;
        if (!wall[n] && !inHall(n) && !seenCell[n]) {
          seenCell[n] = 1;
          q.push(n);
        }
      }
    }
    const rboxes = boxes.filter((b) => cells.includes(b));
    const rgoals = cells.filter((x) => goal[x]);
    if (rboxes.length === 0) continue;
    // Door candidates: room cells touching a hallway floor cell.
    const doors: { door: number; outside: number }[] = [];
    for (const cell of cells) {
      const x = cell % w;
      const y = (cell / w) | 0;
      for (let d = 0; d < 4; d++) {
        const nx = x + DX[d];
        const ny = y + DY[d];
        if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
        const n = ny * w + nx;
        if (inHall(n) && !wall[n]) doors.push({ door: cell, outside: n });
      }
    }
    doors.sort((a, b) => a.door - b.door);
    rooms.push({ cells, boxes: rboxes, goals: rgoals, door: doors[0]?.door ?? -1, outside: doors[0]?.outside ?? -1 });
    // Keep every door candidate for the fallback loop in the stitcher.
    (rooms[rooms.length - 1] as unknown as { doors: typeof doors }).doors = doors;
  }

  rooms.sort((a, b) => a.door - b.door);

  let moves = '';
  let curPlayer = player;
  const curBoxes = [...boxes];
  for (const room of rooms) {
    const doors = (room as unknown as { doors: { door: number; outside: number }[] }).doors;
    let roomMoves: string | null = null;
    let usedDoor = doors[0]!;
    for (const cand of doors) {
      const m = solveRoom(w, h, wall, goal, room.cells, cand.outside, room.boxes, room.goals);
      if (m !== null) {
        roomMoves = m;
        usedDoor = cand;
        break;
      }
    }
    if (roomMoves === null) return '';
    // Walk along the hallway to this room's door, then play its solution.
    const boxMask = new Uint8Array(w * h);
    for (const b of curBoxes) boxMask[b] = 1;
    const toDoor = walk(w, h, wall, boxMask, curPlayer, usedDoor.outside, null);
    if (toDoor === null) return '';
    moves += toDoor;
    curPlayer = usedDoor.outside;
    moves += roomMoves;
    // Simulate the room's moves on the whole level to track the player
    // and the boxes for the next room's walk.
    for (const ch of roomMoves) {
      const d = DC.indexOf(ch);
      const next = curPlayer + DY[d] * w + DX[d];
      const bi = curBoxes.indexOf(next);
      if (bi !== -1) curBoxes[bi] = next + DY[d] * w + DX[d];
      curPlayer = next;
    }
  }
  // Verify the replay solves the level.
  for (const b of curBoxes) if (!goal[b]) return '';
  return moves;
}

for (const id of readdirSync(I).sort()) {
  const moves = solveLevel(readFileSync(join(I, id, 'level.txt'), 'utf8'));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
