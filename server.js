/* =========================================================
   포켓몬 쓰나미 구조대 - 서버
   - 로그인 / 회원가입
   - 쓰나미 구역의 야생 포켓몬, 쓰나미 파도
   - 창고 저장
   - 플레이어끼리 배틀 (이긴 사람이 진 사람의 포켓몬을 가져감)
   ========================================================= */
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "db.json");

/* ---------------- 게임 설정 (숫자를 바꿔서 난이도 조절!) ---------------- */
const WORLD = { w: 4000, h: 1200, safeX: 450 };
const PLAYER_SPEED = 280;          // 플레이어 속도 (px/초)
const CARRY_SPEED = 0.8;           // 포켓몬을 들고 있을 때 속도 배율
const WILD_COUNT = 45;             // 맵에 있는 야생 포켓몬 수
const PICKUP_RANGE = 80;           // E 키로 잡을 수 있는 거리
const CALM_TIME = 20;              // 평화로운 시간 (초)
const WARNING_TIME = 5;            // 쓰나미 경고 시간 (초)
const WAVE_SPEED = 430;            // 쓰나미 속도 (px/초)
const WAVE_WIDTH = 380;            // 쓰나미 두께
const BATTLE_TURN_TIME = 15;       // 배틀 한 턴 제한 시간 (초)

const ZONE_W = (WORLD.w - WORLD.safeX) / 5;
const ZONES = [
  { name: "1구역 · 바닷가 초원", pokemon: [[1,"이상해씨"],[4,"파이리"],[7,"꼬부기"],[10,"캐터피"],[13,"뿔충이"],[16,"구구"],[19,"꼬렛"],[21,"깨비참"],[23,"아보"],[25,"피카츄"]] },
  { name: "2구역 · 해변 동굴", pokemon: [[27,"모래두지"],[29,"니드런♀"],[32,"니드런♂"],[35,"삐삐"],[37,"식스테일"],[39,"푸린"],[41,"주뱃"],[43,"뚜벅쵸"],[46,"파라스"],[48,"콘팡"]] },
  { name: "3구역 · 항구 도시", pokemon: [[50,"디그다"],[52,"나옹"],[54,"고라파덕"],[56,"망키"],[58,"가디"],[60,"발챙이"],[63,"캐이시"],[66,"알통몬"],[69,"모다피"],[72,"왕눈해"]] },
  { name: "4구역 · 바위 산지", pokemon: [[74,"꼬마돌"],[77,"포니타"],[79,"야돈"],[81,"코일"],[83,"파오리"],[84,"두두"],[86,"쥬쥬"],[88,"질퍽이"],[90,"셀러"],[92,"고오스"]] },
  { name: "5구역 · 환상의 해안", pokemon: [[95,"롱스톤"],[96,"슬리프"],[98,"크랩"],[100,"찌리리공"],[102,"아라리"],[104,"탕구리"],[108,"내루미"],[133,"이브이"],[143,"잠만보"],[151,"뮤"]] }
].map((z, i) => ({ ...z, from: WORLD.safeX + ZONE_W * i, to: WORLD.safeX + ZONE_W * (i + 1) }));

// 언덕: 쓰나미가 와도 안전한 곳
const HILLS = [];
ZONES.forEach((z, i) => {
  HILLS.push({ x: z.from + ZONE_W * 0.3, y: 250 + (i % 2) * 450, r: 85 });
  HILLS.push({ x: z.from + ZONE_W * 0.75, y: 850 - (i % 2) * 450, r: 85 });
});

/* ---------------- 저장소 (파일) ---------------- */
let db = { users: {} };
try { db = JSON.parse(fs.readFileSync(DB_FILE, "utf8")); } catch (e) {}
let saveTimer = null;
function saveDb() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(DB_FILE + ".tmp", JSON.stringify(db));
      fs.renameSync(DB_FILE + ".tmp", DB_FILE);
    } catch (e) { console.error("저장 실패", e); }
  }, 300);
}

function hashPw(pw, salt) { return crypto.scryptSync(pw, salt, 32).toString("hex"); }
const sessions = new Map(); // token -> username

/* ---------------- 웹서버 + 로그인 API ---------------- */
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const NAME_RE = /^[가-힣a-zA-Z0-9_]{2,12}$/;

app.post("/api/register", (req, res) => {
  const { name, password } = req.body || {};
  if (!NAME_RE.test(name || "")) return res.json({ ok: false, error: "이름은 2~12자 (한글/영어/숫자)로 해주세요." });
  if (!password || password.length < 4) return res.json({ ok: false, error: "비밀번호는 4자 이상이어야 해요." });
  if (db.users[name]) return res.json({ ok: false, error: "이미 있는 이름이에요." });
  const salt = crypto.randomBytes(16).toString("hex");
  db.users[name] = { salt, hash: hashPw(password, salt), storage: [], wins: 0, losses: 0 };
  saveDb();
  const token = crypto.randomBytes(24).toString("hex");
  sessions.set(token, name);
  res.json({ ok: true, token, name });
});

app.post("/api/login", (req, res) => {
  const { name, password } = req.body || {};
  const u = db.users[name];
  if (!u || hashPw(String(password || ""), u.salt) !== u.hash)
    return res.json({ ok: false, error: "이름 또는 비밀번호가 틀렸어요." });
  const token = crypto.randomBytes(24).toString("hex");
  sessions.set(token, name);
  res.json({ ok: true, token, name });
});

const server = http.createServer(app);
const io = new Server(server);

/* ---------------- 게임 상태 ---------------- */
const players = new Map();   // socket.id -> player
const wild = new Map();      // id -> 야생 포켓몬
const challenges = new Map();
const battles = new Map();
let wave = { phase: "calm", t: CALM_TIME, x: WORLD.w + 100 };

const rnd = (a, b) => a + Math.random() * (b - a);
const uid = () => crypto.randomBytes(8).toString("hex");
const onHill = (x, y) => HILLS.some(h => Math.hypot(h.x - x, h.y - y) < h.r);

function spawnWild() {
  const zi = Math.floor(Math.random() * ZONES.length);
  const z = ZONES[zi];
  let pick = z.pokemon[Math.floor(Math.random() * z.pokemon.length)];
  if (pick[0] === 151 && Math.random() > 0.25) pick = z.pokemon[Math.floor(Math.random() * 9)]; // 뮤는 희귀!
  let x, y;
  do { x = rnd(z.from + 40, z.to - 40); y = rnd(60, WORLD.h - 60); } while (onHill(x, y));
  const power = Math.round(40 + zi * 55 + rnd(0, 50) + (pick[0] === 151 ? 120 : 0));
  const p = { id: uid(), no: pick[0], name: pick[1], x, y, power };
  wild.set(p.id, p);
}
for (let i = 0; i < WILD_COUNT; i++) spawnWild();

function inSafe(p) { return p.x < WORLD.safeX; }
function spawnPoint() { return { x: rnd(80, WORLD.safeX - 80), y: rnd(300, WORLD.h - 300) }; }
function storageOf(name) { return db.users[name].storage; }
function sendStorage(p) {
  const u = db.users[p.name];
  p.socket.emit("storage", { list: u.storage, wins: u.wins || 0, losses: u.losses || 0 });
}
function playerByName(name) { for (const p of players.values()) if (p.name === name) return p; }

/* ---------------- 접속 ---------------- */
io.use((socket, next) => {
  const name = sessions.get(socket.handshake.auth && socket.handshake.auth.token);
  if (!name || !db.users[name]) return next(new Error("login"));
  socket.data.name = name;
  next();
});

io.on("connection", socket => {
  const name = socket.data.name;
  // 같은 계정이 다른 곳에서 접속 중이면 그쪽을 끊어요
  const old = playerByName(name);
  if (old) { old.socket.emit("kicked", "다른 곳에서 같은 계정으로 접속했어요."); old.socket.disconnect(true); }

  const sp = spawnPoint();
  const hue = parseInt(crypto.createHash("md5").update(name).digest("hex").slice(0, 2), 16) / 255 * 360;
  const me = { id: socket.id, name, x: sp.x, y: sp.y, carry: null, color: `hsl(${hue|0},75%,55%)`, socket, freezeUntil: 0, battle: null };
  players.set(socket.id, me);

  socket.emit("init", {
    me: { id: socket.id, name, x: me.x, y: me.y },
    world: WORLD, zones: ZONES, hills: HILLS,
    speed: PLAYER_SPEED, carrySpeed: CARRY_SPEED, pickupRange: PICKUP_RANGE
  });
  sendStorage(me);
  io.emit("toast", `👋 ${name}님이 들어왔어요!`);

  socket.on("move", d => {
    if (!d || Date.now() < me.freezeUntil || me.battle) return;
    me.x = Math.max(20, Math.min(WORLD.w - 20, +d.x || 0));
    me.y = Math.max(20, Math.min(WORLD.h - 20, +d.y || 0));
    // 안전구역에 포켓몬을 들고 오면 창고에 보관!
    if (me.carry && inSafe(me)) {
      const c = me.carry; me.carry = null;
      storageOf(name).push({ id: c.id, no: c.no, name: c.name, power: c.power });
      saveDb();
      sendStorage(me);
      socket.emit("toast", `📦 ${c.name}(CP ${c.power})을(를) 창고에 보관했어요!`);
    }
  });

  socket.on("pickup", () => {
    if (me.carry || me.battle) return;
    let best = null, bd = PICKUP_RANGE;
    for (const w of wild.values()) {
      const d = Math.hypot(w.x - me.x, w.y - me.y);
      if (d < bd) { bd = d; best = w; }
    }
    if (!best) return socket.emit("toast", "가까이에 포켓몬이 없어요.");
    wild.delete(best.id);
    me.carry = best;
    socket.emit("toast", `🙌 ${best.name}을(를) 구했어요! 안전구역으로 돌아가요!`);
    setTimeout(spawnWild, 4000);
  });

  /* ----- 배틀 신청 ----- */
  socket.on("challenge", ({ targetId, pokeId } = {}) => {
    const target = players.get(targetId);
    if (!target || target === me) return;
    if (me.battle || target.battle) return socket.emit("toast", "지금은 배틀 중이에요.");
    if (!inSafe(me) || !inSafe(target)) return socket.emit("toast", "배틀은 둘 다 안전구역에 있을 때만 할 수 있어요!");
    const poke = storageOf(name).find(p => p.id === pokeId);
    if (!poke) return socket.emit("toast", "그 포켓몬은 창고에 없어요.");
    if (!storageOf(target.name).length) return socket.emit("toast", `${target.name}님은 포켓몬이 없어요.`);
    const ch = { id: uid(), from: me.id, to: target.id, pokeId, created: Date.now() };
    challenges.set(ch.id, ch);
    target.socket.emit("challenged", { challengeId: ch.id, fromName: name, poke });
    socket.emit("toast", `⚔️ ${target.name}님에게 배틀을 신청했어요. 기다리는 중...`);
    setTimeout(() => {
      if (challenges.delete(ch.id)) socket.emit("toast", `${target.name}님이 응답하지 않았어요.`);
    }, 25000);
  });

  socket.on("challengeReply", ({ challengeId, accept, pokeId } = {}) => {
    const ch = challenges.get(challengeId);
    if (!ch || ch.to !== me.id) return;
    challenges.delete(challengeId);
    const from = players.get(ch.from);
    if (!from) return socket.emit("toast", "상대가 나갔어요.");
    if (!accept) return from.socket.emit("toast", `😅 ${name}님이 배틀을 거절했어요.`);
    if (me.battle || from.battle) return socket.emit("toast", "지금은 배틀할 수 없어요.");
    if (!inSafe(me) || !inSafe(from)) {
      socket.emit("toast", "둘 다 안전구역에 있어야 해요!"); from.socket.emit("toast", "둘 다 안전구역에 있어야 해요!"); return;
    }
    const pa = storageOf(from.name).find(p => p.id === ch.pokeId);
    const pb = storageOf(name).find(p => p.id === pokeId);
    if (!pa || !pb) return socket.emit("toast", "포켓몬을 찾을 수 없어요.");
    startBattle(from, pa, me, pb);
  });

  socket.on("battleMove", move => {
    const b = me.battle && battles.get(me.battle);
    if (!b || !["tackle", "special", "guard"].includes(move)) return;
    const side = b.sides.find(s => s.p === me);
    if (side.move) return;
    side.move = move;
    if (b.sides.every(s => s.move)) resolveTurn(b);
  });

  socket.on("disconnect", () => {
    players.delete(socket.id);
    if (me.battle) {
      const b = battles.get(me.battle);
      if (b) endBattle(b, b.sides.find(s => s.p !== me), "상대가 나가서 이겼어요!");
    }
    io.emit("toast", `${name}님이 나갔어요.`);
  });
});

/* ---------------- 배틀 ---------------- */
function stats(poke) {
  const max = Math.round(80 + poke.power * 0.7);
  return { poke, hp: max, max, atk: 10 + poke.power * 0.09 };
}
function startBattle(pa, pokeA, pb, pokeB) {
  const b = { id: uid(), sides: [{ p: pa, ...stats(pokeA), move: null }, { p: pb, ...stats(pokeB), move: null }], turn: 0 };
  battles.set(b.id, b);
  pa.battle = pb.battle = b.id;
  b.sides.forEach((s, i) => {
    const o = b.sides[1 - i];
    s.p.socket.emit("battleStart", {
      you: { poke: s.poke, hp: s.hp, max: s.max },
      foe: { name: o.p.name, poke: o.poke, hp: o.hp, max: o.max },
      turnTime: BATTLE_TURN_TIME
    });
  });
  armTimer(b);
}
function armTimer(b) {
  clearTimeout(b.timer);
  b.timer = setTimeout(() => {
    b.sides.forEach(s => { if (!s.move) s.move = "tackle"; });
    resolveTurn(b);
  }, BATTLE_TURN_TIME * 1000 + 500);
}
const MOVE_NAME = { tackle: "몸통박치기", special: "필살기", guard: "방어" };
function resolveTurn(b) {
  clearTimeout(b.timer);
  const log = [];
  const dmg = [0, 0];
  b.sides.forEach((s, i) => {
    const o = b.sides[1 - i];
    let d = 0, missed = false;
    if (s.move === "tackle") d = s.atk * rnd(0.85, 1.15);
    if (s.move === "special") {
      if (Math.random() < 0.55) d = s.atk * 2.2 * rnd(0.9, 1.1);
      else { missed = true; log.push(`${s.poke.name}의 필살기가 빗나갔다!`); }
    }
    if (o.move === "guard") d *= 0.35;
    d = Math.round(d);
    dmg[1 - i] += d;
    if (!missed) log.push(`${s.poke.name}의 ${MOVE_NAME[s.move]}!` + (d ? ` (${o.poke.name}에게 ${d} 데미지)` : ""));
  });
  b.sides.forEach((s, i) => {
    if (s.move === "guard") { const h = Math.round(s.max * 0.08); s.hp = Math.min(s.max, s.hp + h); log.push(`${s.poke.name}이(가) 체력을 ${h} 회복했다.`); }
    s.hp -= dmg[i];
  });
  b.sides.forEach((s, i) => {
    const o = b.sides[1 - i];
    s.p.socket.emit("battleTurn", { log, youHp: Math.max(0, s.hp), foeHp: Math.max(0, o.hp), youMove: s.move, foeMove: o.move });
    s.move = null;
  });
  const dead = b.sides.filter(s => s.hp <= 0);
  if (dead.length) {
    const winner = dead.length === 2 ? (b.sides[0].hp >= b.sides[1].hp ? b.sides[0] : b.sides[1]) : b.sides.find(s => s.hp > 0);
    setTimeout(() => endBattle(b, winner), 1500);
  } else armTimer(b);
}
function endBattle(b, winner, reason) {
  if (!battles.has(b.id)) return;
  battles.delete(b.id);
  clearTimeout(b.timer);
  const loser = b.sides.find(s => s !== winner);
  // 진 쪽의 포켓몬을 이긴 쪽 창고로 옮겨요
  const ls = storageOf(loser.p.name);
  const idx = ls.findIndex(p => p.id === loser.poke.id);
  if (idx >= 0) {
    const [taken] = ls.splice(idx, 1);
    storageOf(winner.p.name).push(taken);
  }
  db.users[winner.p.name].wins = (db.users[winner.p.name].wins || 0) + 1;
  db.users[loser.p.name].losses = (db.users[loser.p.name].losses || 0) + 1;
  saveDb();
  winner.p.battle = loser.p.battle = null;
  winner.p.socket.emit("battleEnd", { win: true, poke: loser.poke, reason });
  loser.p.socket.emit("battleEnd", { win: false, poke: loser.poke });
  [winner.p, loser.p].forEach(p => { if (players.has(p.id)) sendStorage(p); });
  io.emit("toast", `🏆 ${winner.p.name}님이 배틀에서 이겨서 ${loser.poke.name}을(를) 데려갔어요!`);
}

/* ---------------- 게임 루프 (1초에 20번) ---------------- */
const TICK = 50;
setInterval(() => {
  const dt = TICK / 1000;
  wave.t -= dt;
  if (wave.phase === "calm" && wave.t <= 0) {
    wave.phase = "warning"; wave.t = WARNING_TIME;
    io.emit("toast", "⚠️ 쓰나미가 오고 있어요! 안전구역이나 언덕으로 피하세요!");
  } else if (wave.phase === "warning" && wave.t <= 0) {
    wave.phase = "wave"; wave.x = WORLD.w + 50;
  } else if (wave.phase === "wave") {
    wave.x -= WAVE_SPEED * dt;
    if (wave.x < WORLD.safeX - WAVE_WIDTH) { wave.phase = "calm"; wave.t = CALM_TIME; wave.x = WORLD.w + 100; }
    // 쓰나미에 휩쓸렸는지 확인
    for (const p of players.values()) {
      if (p.battle || inSafe(p) || onHill(p.x, p.y) || Date.now() < p.freezeUntil) continue;
      if (p.x >= wave.x && p.x <= wave.x + WAVE_WIDTH) {
        const lost = p.carry; p.carry = null;
        const sp = spawnPoint(); p.x = sp.x; p.y = sp.y; p.freezeUntil = Date.now() + 600;
        if (lost) setTimeout(spawnWild, 3000);
        p.socket.emit("hit", { x: p.x, y: p.y, lost: lost && lost.name });
      }
    }
  }
  io.volatile.emit("state", {
    players: [...players.values()].map(p => ({ id: p.id, name: p.name, x: Math.round(p.x), y: Math.round(p.y), color: p.color, carry: p.carry && p.carry.no, battle: !!p.battle })),
    wild: [...wild.values()].map(w => ({ id: w.id, no: w.no, x: Math.round(w.x), y: Math.round(w.y), power: w.power, name: w.name })),
    wave: { phase: wave.phase, t: Math.max(0, wave.t), x: Math.round(wave.x), width: WAVE_WIDTH }
  });
}, TICK);

server.listen(PORT, () => console.log(`🌊 포켓몬 쓰나미 구조대 서버 실행 중! http://localhost:${PORT}`));
