import crypto from 'node:crypto';

export const COLS = 10;
export const ROWS = 20;
export const ACTIONS = new Set(['left', 'right', 'down', 'rotate', 'drop', 'hold']);
const PIECES = {
  I: [[1, 1, 1, 1]], J: [[1, 0, 0], [1, 1, 1]], L: [[0, 0, 1], [1, 1, 1]],
  O: [[1, 1], [1, 1]], S: [[0, 1, 1], [1, 1, 0]], T: [[0, 1, 0], [1, 1, 1]], Z: [[1, 1, 0], [0, 1, 1]]
};
const TYPES = Object.keys(PIECES);
const SCORE = [0, 100, 300, 500, 800];

function hashString(value) {
  let hash = 2166136261 >>> 0;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
function rngFor(seed) {
  let state = hashString(String(seed || '12345'));
  return () => {
    state = (state + 0x6D2B79F5) | 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}
function clone(matrix) { return matrix.map((row) => row.slice()); }
function board() { return Array.from({ length: ROWS }, () => Array(COLS).fill(0)); }
function rotate(matrix) { return matrix[0].map((_, index) => matrix.map((row) => row[index]).reverse()); }
function collides(grid, matrix, x, y) {
  for (let row = 0; row < matrix.length; row++) for (let column = 0; column < matrix[row].length; column++) {
    if (!matrix[row][column]) continue;
    const targetX = x + column;
    const targetY = y + row;
    if (targetX < 0 || targetX >= COLS || targetY >= ROWS) return true;
    if (targetY >= 0 && grid[targetY][targetX]) return true;
  }
  return false;
}

export class TetrisEngine {
  constructor(seed = '12345') {
    this.rng = rngFor(seed);
    this.grid = board(); this.score = 0; this.lines = 0; this.level = 1;
    this.combo = 0; this.pendingGarbage = 0; this.hold = null; this.canHold = true;
    this.next = this.createPiece(this.randomType()); this.current = null;
    this.gameOver = false; this.lastAttack = 0; this.gravityAccumulator = 0; this.spawn();
  }
  randomType() { return TYPES[Math.floor(this.rng() * TYPES.length)]; }
  createPiece(type) { return { type, matrix: clone(PIECES[type]), x: 0, y: -1 }; }
  spawn() {
    this.current = this.next || this.createPiece(this.randomType());
    this.current.x = Math.floor((COLS - this.current.matrix[0].length) / 2);
    this.current.y = -1;
    this.next = this.createPiece(this.randomType()); this.canHold = true;
    if (collides(this.grid, this.current.matrix, this.current.x, this.current.y)) this.gameOver = true;
  }
  move(dx, dy) {
    if (this.gameOver || collides(this.grid, this.current.matrix, this.current.x + dx, this.current.y + dy)) return false;
    this.current.x += dx; this.current.y += dy; return true;
  }
  hardDrop() {
    let distance = 0;
    while (this.move(0, 1)) distance++;
    this.score += distance * 2; this.lock();
  }
  holdPiece() {
    if (this.gameOver || !this.canHold) return;
    if (!this.hold) { this.hold = this.current.type; this.spawn(); }
    else { const type = this.hold; this.hold = this.current.type; this.current = this.createPiece(type); this.current.x = Math.floor((COLS - this.current.matrix[0].length) / 2); }
    this.canHold = false;
  }
  lock() {
    this.current.matrix.forEach((row, y) => row.forEach((value, x) => {
      const targetY = this.current.y + y; const targetX = this.current.x + x;
      if (value && targetY >= 0 && targetY < ROWS && targetX >= 0 && targetX < COLS) this.grid[targetY][targetX] = this.current.type;
    }));
    const cleared = [];
    for (let y = ROWS - 1; y >= 0; y--) if (this.grid[y].every(Boolean)) cleared.push(y);
    cleared.forEach((y) => { this.grid.splice(y, 1); this.grid.unshift(Array(COLS).fill(0)); });
    if (cleared.length) {
      this.lines += cleared.length; this.combo += 1; this.level = Math.floor(this.lines / 10) + 1;
      this.score += SCORE[cleared.length] * this.level * 10 + Math.max(0, this.combo - 1) * 50 * this.level;
      this.lastAttack = cleared.length >= 2 ? cleared.length + Math.floor(Math.max(0, this.combo - 1) / 2) : 0;
    } else this.combo = 0;
    if (this.pendingGarbage) this.applyGarbage();
    this.spawn();
  }
  applyGarbage() {
    while (this.pendingGarbage-- > 0) { const row = Array(COLS).fill('garbage'); row[Math.floor(this.rng() * COLS)] = 0; this.grid.shift(); this.grid.push(row); }
    this.pendingGarbage = 0;
  }
  action(action) {
    if (!ACTIONS.has(action) || this.gameOver) return;
    if (action === 'left') this.move(-1, 0);
    else if (action === 'right') this.move(1, 0);
    else if (action === 'down') { if (!this.move(0, 1)) this.lock(); }
    else if (action === 'rotate') { const turned = rotate(this.current.matrix); for (const kick of [0, -1, 1, -2, 2]) if (!collides(this.grid, turned, this.current.x + kick, this.current.y)) { this.current.matrix = turned; this.current.x += kick; break; } }
    else if (action === 'drop') this.hardDrop();
    else if (action === 'hold') this.holdPiece();
  }
  tick(milliseconds) {
    this.gravityAccumulator += Math.min(250, Math.max(0, milliseconds));
    while (!this.gameOver) {
      const interval = Math.max(120, 700 - (this.level - 1) * 40);
      if (this.gravityAccumulator < interval) break;
      this.gravityAccumulator -= interval;
      if (!this.move(0, 1)) this.lock();
    }
  }
  snapshot() { return { board: this.grid, score: this.score, lines: this.lines, level: this.level, gameOver: this.gameOver }; }
}

export function verifyReplayPayload(replay) {
  let parsed;
  try { parsed = JSON.parse(Buffer.from(replay, 'base64url').toString('utf8')); } catch { return { valid: false }; }
  if (!parsed || typeof parsed.seed !== 'string' || !Array.isArray(parsed.actions) || parsed.actions.length > 20000) return { valid: false };
  const engine = new TetrisEngine(parsed.seed); let last = 0;
  for (const item of parsed.actions) {
    if (!Array.isArray(item) || item.length !== 3 || !Number.isInteger(item[0]) || item[0] < last || item[0] > 600000 || item[1] !== 1 || !ACTIONS.has(item[2])) return { valid: false };
    engine.tick(item[0] - last); engine.action(item[2]); last = item[0];
    if (engine.gameOver) break;
  }
  const hash = crypto.createHash('sha256').update(replay).digest('hex');
  return { valid: true, score: engine.score, hash };
}
