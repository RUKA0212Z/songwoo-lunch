const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');
const webpush = require('web-push');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 10 * 1024 }); // 비정상적으로 큰 요청 차단

// 예기치 못한 오류로 서버 전체가 내려가지 않도록 기록만 남기고 계속 동작
process.on('uncaughtException', (err) => console.error('[uncaughtException]', err));
process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err));

app.use(express.static('public', {
  setHeaders(res, filePath) {
    // 서비스 워커와 매니페스트는 항상 최신본을 확인하게 한다
    if (/(sw\.js|manifest\.webmanifest)$/.test(filePath)) res.setHeader('Cache-Control', 'no-cache');
  },
}));

// ===== 관리자 인증 =====
// 비밀번호는 코드에 두지 않고 환경변수로만 받는다. 없으면 관리자 로그인을 막는다.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
if (!ADMIN_PASSWORD) {
  console.warn('[경고] ADMIN_PASSWORD 환경변수가 없어 관리자 로그인이 비활성화됩니다.');
}
const MAX_LOGIN_FAILS = 5;                    // 연속 실패 허용 횟수
const LOGIN_LOCK_MS = 10 * 60 * 1000;         // 초과 시 잠금 시간 (10분)
const ADMIN_TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // 재연결용 토큰 유효기간 (12시간)

const loginAttempts = new Map(); // ip -> { fails, lockedUntil }
const adminTokens = new Map();   // token -> expiresAt

function sha256(v) {
  return crypto.createHash('sha256').update(String(v)).digest();
}
function passwordMatches(input) {
  if (!ADMIN_PASSWORD || typeof input !== 'string' || input.length > 200) return false;
  return crypto.timingSafeEqual(sha256(input), sha256(ADMIN_PASSWORD));
}
// 프록시(Render 등) 뒤에서는 프록시가 덧붙인 마지막 x-forwarded-for 값을 신뢰한다
function clientIp(socket) {
  const xff = socket.handshake.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',').pop().trim();
  return socket.handshake.address;
}
function lockRemainingMs(ip) {
  const a = loginAttempts.get(ip);
  return a && a.lockedUntil > Date.now() ? a.lockedUntil - Date.now() : 0;
}
function recordLoginFailure(ip) {
  const a = loginAttempts.get(ip) || { fails: 0, lockedUntil: 0 };
  a.fails += 1;
  if (a.fails >= MAX_LOGIN_FAILS) { a.lockedUntil = Date.now() + LOGIN_LOCK_MS; a.fails = 0; }
  loginAttempts.set(ip, a);
}
function issueAdminToken() {
  const token = crypto.randomBytes(32).toString('hex');
  adminTokens.set(token, Date.now() + ADMIN_TOKEN_TTL_MS);
  return token;
}
function tokenValid(token) {
  if (typeof token !== 'string') return false;
  const exp = adminTokens.get(token);
  if (!exp) return false;
  if (exp < Date.now()) { adminTokens.delete(token); return false; }
  return true;
}
// 만료된 기록 정리
setInterval(() => {
  const now = Date.now();
  for (const [t, exp] of adminTokens) if (exp < now) adminTokens.delete(t);
  for (const [ip, a] of loginAttempts) if (a.lockedUntil < now && a.fails === 0) loginAttempts.delete(ip);
}, 10 * 60 * 1000).unref();

// ===== 푸시 알림 (웹 푸시) =====
// VAPID 키가 없으면 알림 기능만 꺼지고 나머지는 정상 동작한다.
// 키 만들기: npx web-push generate-vapid-keys
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@songwoo-lunch.invalid';
let pushEnabled = !!(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);
if (pushEnabled) {
  try { webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY); }
  catch (e) { console.error('[경고] VAPID 키가 올바르지 않아 푸시 알림을 끕니다:', e.message); pushEnabled = false; }
} else {
  console.warn('[안내] VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY 가 없어 푸시 알림이 비활성화됩니다. (npx web-push generate-vapid-keys)');
}
const MAX_PUSH_SUBS = 5;

app.get('/api/push-key', (req, res) => {
  if (!pushEnabled) return res.status(404).json({ error: 'push disabled' });
  res.json({ key: VAPID_PUBLIC_KEY });
});

// ===== NEIS 급식 API =====
const NEIS_KEY = process.env.NEIS_KEY || '';
const OFFICE_CODE = 'J10';
const SCHOOL_CODE = '7530806';

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.get('/api/meal', async (req, res) => {
  if (!NEIS_KEY) {
    return res.json({ date: '', menu: [], notice: '급식 정보를 불러올 수 없어요 (서버 설정 필요)' });
  }
  const kstNow = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const ymd = kstNow.toISOString().slice(0, 10).replace(/-/g, '');
  const url = `https://open.neis.go.kr/hub/mealServiceDietInfo?KEY=${NEIS_KEY}&Type=json&ATPT_OFCDC_SC_CODE=${OFFICE_CODE}&SD_SCHUL_CODE=${SCHOOL_CODE}&MLSV_YMD=${ymd}`;

  try {
    const response = await fetch(url);
    const data = await response.json();
    const row = data?.mealServiceDietInfo?.[1]?.row?.[0];
    if (!row) {
      return res.json({ date: ymd, menu: [], notice: '오늘은 급식 정보가 없어요' });
    }
    const menu = row.DDISH_NM.split('<br/>').map(item => item.replace(/\([^)]*\)/g, '').trim());
    res.json({ date: ymd, menu });
  } catch (err) {
    console.error('급식 API 오류:', err);
    res.status(500).json({ error: '급식 정보를 가져오지 못했어요' });
  }
});

// ===== 좌석 배정 상태 =====
const SKIP_CAP = 1;
const MAX_GROUP_SIZE = 6;
const SELECT_WINDOW = 3; // 내 앞 N번째 차례가 시작되면 좌석을 미리 고를 수 있다
const MAX_NAME_LEN = 20;
const MAX_PENDING_GROUPS = 300;

// ===== 입력값 검증 =====
// 소켓으로 들어오는 값은 전부 신뢰하지 않고, 형식이 맞는 값만 통과시킨다.
const CLASS_RE = /^(?:[1-9]|10)$/;          // 1~10반
const NUMBER_RE = /^(?:[1-9]|1\d|2[01])$/;   // 1~21번
function cleanName(v) {
  if (typeof v !== 'string') return null;
  const n = v.normalize('NFC').replace(/\s+/g, ' ').trim();
  if (!n || [...n].length > MAX_NAME_LEN) return null;
  if (/[\u0000-\u001f\u007f<>]/.test(n)) return null;
  return n;
}
function cleanIdentity(p) {
  if (!p || typeof p !== 'object') return null;
  if (typeof p.className !== 'string' || !CLASS_RE.test(p.className)) return null;
  if (typeof p.number !== 'string' || !NUMBER_RE.test(p.number)) return null;
  return { className: p.className, number: p.number };
}
function cleanUser(p) {
  const id = cleanIdentity(p);
  const name = id && cleanName(p.name);
  return id && name ? { ...id, name } : null;
}
function cleanCode(v) {
  if (typeof v !== 'string') return null;
  const c = v.trim().toUpperCase();
  return /^[A-Z0-9]{4}$/.test(c) ? c : null;
}
function cleanId(v) {
  return typeof v === 'string' && /^[A-Za-z0-9]{1,64}$/.test(v) ? v : null;
}
function cleanSeatId(v) {
  return typeof v === 'string' && /^[A-O]\d{1,2}$/.test(v) ? v : null;
}
function cleanPin(v) {
  return typeof v === 'string' && /^\d{4}$/.test(v) ? v : null;
}
function cleanSubscription(v) {
  if (!v || typeof v !== 'object' || typeof v.endpoint !== 'string' || !v.keys || typeof v.keys !== 'object') return null;
  const { endpoint } = v;
  const { p256dh, auth } = v.keys;
  if (endpoint.length > 600 || !/^https:\/\//.test(endpoint)) return null;
  if (typeof p256dh !== 'string' || typeof auth !== 'string' || p256dh.length > 200 || auth.length > 100) return null;
  return { endpoint, keys: { p256dh, auth } };
}

// ===== 학생 계정 (반/번호 + 학생이 정한 PIN 4자리) =====
// 학교 코드 없이 신원을 지키기 위한 장치: 먼저 등록한 사람이 PIN 을 정하고, 이후 새 기기에서는 PIN 으로 로그인한다.
// 지금은 메모리에만 저장한다(서버가 재시작되면 학생들은 PIN 을 다시 정한다). 저장소만 바꾸면 DB 로 옮길 수 있다.
const MAX_PIN_FAILS = 5;
const PIN_LOCK_MS = 10 * 60 * 1000;
const MAX_DEVICES = 5;
const accounts = new Map(); // "반:번호" -> { name, salt, pinHash, tokens: [sha256], fails, lockedUntil }

const accountKey = (id) => `${id.className}:${id.number}`;
const sha256hex = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');
const hashPin = (pin, salt) => crypto.scryptSync(pin, salt, 32);
function pinMatches(acc, pin) {
  return crypto.timingSafeEqual(hashPin(pin, acc.salt), acc.pinHash);
}
function addDevice(acc) {
  const token = crypto.randomBytes(32).toString('hex');
  acc.tokens.push(sha256hex(token));
  if (acc.tokens.length > MAX_DEVICES) acc.tokens.shift();
  return token;
}
function hasDevice(acc, token) {
  return typeof token === 'string' && token.length <= 128 && acc.tokens.includes(sha256hex(token));
}
function createAccount(user, pin) {
  const salt = crypto.randomBytes(16);
  const acc = { name: user.name, salt, pinHash: hashPin(pin, salt), tokens: [], fails: 0, lockedUntil: 0, push: [] };
  accounts.set(accountKey(user), acc);
  return acc;
}

// ===== 푸시 발송 =====
function sendPush(identity, payload) {
  if (!pushEnabled) return;
  const acc = accounts.get(accountKey(identity));
  if (!acc || !acc.push.length) return;
  const body = JSON.stringify(payload);
  for (const sub of [...acc.push]) {
    webpush.sendNotification(sub, body, { TTL: 120, urgency: 'high' }).catch((err) => {
      if (err && (err.statusCode === 404 || err.statusCode === 410)) {
        acc.push = acc.push.filter(x => x.endpoint !== sub.endpoint);   // 만료된 구독 정리
      } else {
        console.error('[push 실패]', err && (err.statusCode || err.message));
      }
    });
  }
}
function seatLabel(ids) { return ids.join(', '); }
function durationText(ms) {
  return ms >= 60000 ? `${Math.round(ms / 60000)}분` : `${Math.round(ms / 1000)}초`;
}

// 상태가 바뀔 때마다 호출: 새로 알려야 할 사람에게만 한 번씩 알림을 보낸다
function dispatchPushes() {
  if (!pushEnabled) return;
  for (const r of reservations) {
    if (r.status !== 'waiting') continue;
    if (r.pendingSeatIds.length) {
      // 좌석이 배정됨 (일반 차례, 우선 확보 모두) -> 모둠원 전원에게, 몇 번 자리인지 같이
      if (r.pushedTurnFor !== r.turnDeadline) {
        r.pushedTurnFor = r.turnDeadline;
        const payload = {
          title: '내 차례예요! 🍽️',
          body: `${seatLabel(r.pendingSeatIds)} 자리예요. ${durationText(TURN_TIMEOUT_MS)} 안에 QR을 찍어 인증하세요.`,
          tag: 'turn', urgent: true,
        };
        for (const m of r.members) sendPush(m, payload);
      }
    } else if (!r.pushedSelect && canSelectSeat(r)) {
      // 좌석을 미리 고를 수 있게 됨 -> 선택 권한이 있는 사람(개인 본인, 모둠장)에게
      r.pushedSelect = true;
      const ahead = turnsUntil(reservations.indexOf(r));
      sendPush(r.members[0], {
        title: '곧 내 차례예요',
        body: adminStarted && ahead > 0
          ? `앞으로 ${ahead}번째예요. 지금 원하는 자리를 미리 고를 수 있어요.`
          : '곧 좌석 배정이 시작돼요. 지금 원하는 자리를 미리 고를 수 있어요.',
        tag: 'select', urgent: false,
      });
    }
  }
}
// 테스트할 때 TURN_TIMEOUT_SEC=20 처럼 주면 5분 대신 20초로 확인 가능
const TURN_TIMEOUT_MS = (parseInt(process.env.TURN_TIMEOUT_SEC) || 300) * 1000;

let seats = [];
let reservations = [];
let pendingGroups = [];
let currentTurnIndex = -1;
let adminStarted = false;
let reservationsOpen = false;
let turnTimers = {}; // { [reservationId]: timeoutHandle }

function makeSeats(tableId, count) {
  return Array.from({ length: count }, (_, i) => ({
    id: `${tableId}${i + 1}`,
    tableId,
    status: 'empty',
    occupiedBy: null,
  }));
}

function resetSeats() {
  if (process.env.TEST_LAYOUT === '1') {
    // 우선 확보 모드 테스트용 미니 좌석
    seats = [...makeSeats('A', 1), ...makeSeats('B', 2)];
    return;
  }
  const rows20 = ['A','B','C','D','E','F'];
  const rows24 = ['G','H','I','J','K'];
  const rows202 = ['L','M','N','O'];
  seats = [
    ...rows20.flatMap(r => makeSeats(r, 20)),
    ...rows24.flatMap(r => makeSeats(r, 24)),
    ...rows202.flatMap(r => makeSeats(r, 20)),
  ];
}
resetSeats();

// 내 차례가 오기 전에 몇 번째 앞인지 (1이면 바로 다음 차례).
// 아직 배정 시작 전이면 대기열 앞에서부터, 시작했으면 현재 차례 다음부터 센다.
function turnsUntil(idx) {
  const from = adminStarted && currentTurnIndex >= 0 ? currentTurnIndex + 1 : 0;
  if (idx < from) return 0;
  let ahead = 0;
  for (let i = from; i < idx; i++) {
    if (reservations[i].status === 'waiting' && !reservations[i].priorityLocked) ahead++;
  }
  return ahead + 1;
}

function canSelectSeat(res) {
  if (res.status !== 'waiting' || res.priorityLocked) return false;
  if (res.pendingSeatIds.length || res.heldSeatIds.length) return false;
  const dist = turnsUntil(reservations.indexOf(res));
  return dist >= 1 && dist <= SELECT_WINDOW;
}

// startSeatId부터 같은 테이블에서 번호가 이어지는 size개의 좌석. 하나라도 비어있지 않으면 null
function findContiguousSeats(startSeatId, size) {
  const start = seats.find(s => s.id === startSeatId);
  if (!start) return null;
  const startNo = parseInt(start.id.slice(start.tableId.length), 10);
  const picked = [];
  for (let k = 0; k < size; k++) {
    const seat = seats.find(s => s.id === `${start.tableId}${startNo + k}`);
    if (!seat || seat.status !== 'empty') return null;
    picked.push(seat);
  }
  return picked;
}

function findAvailableSeats(size) {
  const byTable = {};
  for (const s of seats) {
    if (s.status !== 'empty') continue;
    (byTable[s.tableId] ||= []).push(s);
  }
  for (const key in byTable) {
    if (byTable[key].length >= size) return byTable[key].slice(0, size);
  }
  return null;
}

function reserveSeatsTemporarily(res, chosenSeats) {
  res.pendingSeatIds = chosenSeats.map(s => s.id);
  res.confirmedSeatIds = [];
  res.seatConfirmedBy = {};
  for (const s of chosenSeats) {
    s.status = 'pending';
    s.occupiedBy = res.id;
  }
}

// 좌석을 잡고 + 그 예약만의 타이머를 시작 (일반 차례, 우선 확보 둘 다 사용)
function grantSeatsAndStartTimer(res, chosenSeats) {
  reserveSeatsTemporarily(res, chosenSeats);
  res.turnDeadline = Date.now() + TURN_TIMEOUT_MS;
  if (turnTimers[res.id]) clearTimeout(turnTimers[res.id]);
  turnTimers[res.id] = setTimeout(() => {
    try { handleTurnTimeout(res.id); } catch (e) { console.error('[turn timeout]', e); }
  }, TURN_TIMEOUT_MS);
}

function finalizeAssignment(res) {
  res.status = 'assigned';
  res.seatIds = res.pendingSeatIds;
  res.pendingSeatIds = [];
  res.turnDeadline = null;
}

function checkPriorityLocked() {
  for (const res of reservations) {
    if (res.status !== 'waiting' || !res.priorityLocked) continue;
    if (res.pendingSeatIds && res.pendingSeatIds.length) continue;
    const chosen = findAvailableSeats(res.size);
    if (chosen) {
      grantSeatsAndStartTimer(res, chosen);
      checkPriorityLocked(); // 연쇄 확인
      return;
    }
  }
}

function advanceToNextEligible() {
  for (let i = currentTurnIndex + 1; i < reservations.length; i++) {
    if (reservations[i].status === 'waiting' && !reservations[i].priorityLocked) {
      currentTurnIndex = i;
      return;
    }
  }
  currentTurnIndex = -2;
}

function tryAssignTurn() {
  if (currentTurnIndex < 0) return;
  const res = reservations[currentTurnIndex];
  if (!res) return;

  // 미리 고른 자리가 있으면 그 자리를, 없으면 자동 배정
  let chosen;
  if (res.heldSeatIds.length) {
    chosen = res.heldSeatIds.map(id => seats.find(s => s.id === id));
    res.heldSeatIds = [];
    for (const s of chosen) s.status = 'empty'; // 아래에서 pending 으로 바뀐다
  } else {
    chosen = findAvailableSeats(res.size);
  }
  if (chosen) {
    grantSeatsAndStartTimer(res, chosen);
  } else {
    res.skipCount += 1;
    if (res.skipCount >= SKIP_CAP) res.priorityLocked = true;
    advanceToNextEligible();
    tryAssignTurn();
  }
}

function handleTurnTimeout(resId) {
  const res = reservations.find(r => r.id === resId);
  if (!res || res.status !== 'waiting') return;
  delete turnTimers[resId];

  const unconfirmed = res.pendingSeatIds.filter(id => !res.confirmedSeatIds.includes(id));
  for (const seatId of unconfirmed) {
    const seat = seats.find(s => s.id === seatId);
    if (seat) { seat.status = 'empty'; seat.occupiedBy = null; }
  }

  res.seatIds = [...res.confirmedSeatIds];
  res.pendingSeatIds = [];
  res.turnDeadline = null;
  res.status = res.confirmedSeatIds.length > 0 ? 'assigned' : 'expired';
  res.timedOut = true;

  if (currentTurnIndex === reservations.indexOf(res)) {
    advanceToNextEligible();
    tryAssignTurn();
  }
  checkPriorityLocked();
  broadcastState();
}

function broadcastState() {
  io.emit('state', {
    seats,
    reservations: reservations.map(r => ({
      id: r.id, className: r.className, number: r.number, name: r.name, type: r.type,
      size: r.size, groupCode: r.groupCode, members: r.members,
      skipCount: r.skipCount, priorityLocked: r.priorityLocked,
      status: r.status, seatIds: r.seatIds, pendingSeatIds: r.pendingSeatIds,
      confirmedSeatIds: r.confirmedSeatIds, seatConfirmedBy: r.seatConfirmedBy,
      turnDeadline: r.turnDeadline,
      heldSeatIds: r.heldSeatIds,
      canSelect: canSelectSeat(r),
    })),
    pendingGroups,
    currentTurnIndex,
    adminStarted,
    reservationsOpen,
  });
  try { dispatchPushes(); } catch (e) { console.error('[push dispatch]', e); }
}

function newReservation(base) {
  return {
    id: `r${Date.now()}${Math.floor(Math.random() * 1000)}`,
    skipCount: 0, priorityLocked: false, status: 'waiting',
    seatIds: [], pendingSeatIds: [], heldSeatIds: [], confirmedSeatIds: [], seatConfirmedBy: {},
    turnDeadline: null,
    ...base,
  };
}

function sameUser(m, id) { return m.className === id.className && m.number === id.number; }
function hasActiveReservation(id) {
  return reservations.some(r => (r.status === 'waiting' || r.status === 'assigned') && r.members.some(m => sameUser(m, id)));
}
function inPendingGroup(id) {
  return pendingGroups.some(g => g.members.some(m => sameUser(m, id)));
}

io.on('connection', (socket) => {
  socket.data.isAdmin = false;

  // 모든 핸들러를 try/catch 로 감싸서, 잘못된 요청 하나가 서버를 멈추지 못하게 한다
  const safeOn = (event, handler) => {
    socket.on(event, (...args) => {
      try { handler(...args); }
      catch (e) { console.error(`[socket ${event}]`, e); socket.emit('app:error', '요청을 처리하지 못했어요'); }
    });
  };
  const bad = (event) => socket.emit(event, '입력 정보가 올바르지 않아요');
  // 요청에 적힌 반/번호/이름은 믿지 않고, 로그인 때 서버가 붙여 둔 신원만 사용한다
  const authed = (errEvent) => {
    const id = socket.data.identity;
    if (!id) {
      socket.emit(errEvent, '다시 로그인해 주세요');
      socket.emit('auth:required');
      return null;
    }
    return id;
  };

  safeOn('auth:login', (payload) => {
    const reply = (r) => socket.emit('auth:result', r);
    const user = cleanUser(payload);
    if (!user) return reply({ ok: false, error: '입력 정보가 올바르지 않아요' });
    const hasPin = payload.pin !== undefined && payload.pin !== null && payload.pin !== '';
    const pin = hasPin ? cleanPin(payload.pin) : null;
    if (hasPin && !pin) return reply({ ok: false, error: 'PIN은 숫자 4자리예요' });

    const enter = (acc, token) => {
      socket.data.identity = { className: user.className, number: user.number, name: acc.name };
      reply({ ok: true, token, name: acc.name, className: user.className, number: user.number });
    };

    let acc = accounts.get(accountKey(user));
    if (!acc) {                                   // 처음 쓰는 반/번호: PIN 을 정하면 등록
      if (!pin) return reply({ ok: false, needSetup: true });
      acc = createAccount(user, pin);
      return enter(acc, addDevice(acc));
    }
    if (hasDevice(acc, payload.token)) return enter(acc, payload.token); // 이 기기는 이미 인증됨

    if (acc.lockedUntil > Date.now()) {
      return reply({ ok: false, locked: true, retryAfterSec: Math.ceil((acc.lockedUntil - Date.now()) / 1000) });
    }
    if (!pin) return reply({ ok: false, needPin: true });
    if (pinMatches(acc, pin)) {
      acc.fails = 0;
      return enter(acc, addDevice(acc));
    }
    acc.fails += 1;
    if (acc.fails >= MAX_PIN_FAILS) {
      acc.fails = 0;
      acc.lockedUntil = Date.now() + PIN_LOCK_MS;
      return reply({ ok: false, locked: true, retryAfterSec: Math.ceil(PIN_LOCK_MS / 1000) });
    }
    reply({ ok: false, needPin: true, error: `PIN이 달라요 (${MAX_PIN_FAILS - acc.fails}번 남음)` });
  });

  // 이 기기의 푸시 알림 구독 등록 (같은 기기를 다른 학생이 쓰면 이전 학생 구독은 지운다)
  safeOn('push:subscribe', (payload) => {
    const id = authed('app:error');
    if (!id) return;
    const sub = cleanSubscription(payload && payload.subscription);
    if (!sub) return bad('app:error');
    const acc = accounts.get(accountKey(id));
    if (!acc) return;
    for (const other of accounts.values()) other.push = other.push.filter(x => x.endpoint !== sub.endpoint);
    acc.push.push(sub);
    if (acc.push.length > MAX_PUSH_SUBS) acc.push.shift();
    socket.emit('push:subscribed');
  });

  // 이 기기의 로그인 해제 (토큰을 서버에서도 지운다)
  safeOn('auth:logout', (payload) => {
    const id = socket.data.identity;
    if (id && payload && typeof payload.token === 'string') {
      const acc = accounts.get(accountKey(id));
      if (acc) acc.tokens = acc.tokens.filter(h => h !== sha256hex(payload.token));
    }
    socket.data.identity = null;
  });

  // 관리자: PIN 을 잊은 학생의 계정을 초기화 (그 학생은 PIN 을 다시 정한다)
  safeOn('admin:resetAccount', (payload) => {
    if (!socket.data.isAdmin) return;
    const id = cleanIdentity(payload);
    if (!id) return socket.emit('admin:resetAccountResult', { ok: false });
    const existed = accounts.delete(accountKey(id));
    for (const [, other] of io.sockets.sockets) {
      if (other.data.identity && sameUser(other.data.identity, id)) {
        other.data.identity = null;
        other.emit('auth:revoked');
      }
    }
    socket.emit('admin:resetAccountResult', { ok: true, existed, className: id.className, number: id.number });
  });

  safeOn('admin:login', (password) => {
    const ip = clientIp(socket);
    const lockMs = lockRemainingMs(ip);
    if (lockMs > 0) {
      socket.emit('admin:loginResult', { success: false, locked: true, retryAfterSec: Math.ceil(lockMs / 1000) });
      return;
    }
    if (passwordMatches(password)) {
      loginAttempts.delete(ip);
      socket.data.isAdmin = true;
      socket.emit('admin:loginResult', { success: true, token: issueAdminToken() });
    } else {
      recordLoginFailure(ip);
      const nowLocked = lockRemainingMs(ip);
      socket.emit('admin:loginResult', nowLocked > 0
        ? { success: false, locked: true, retryAfterSec: Math.ceil(nowLocked / 1000) }
        : { success: false });
    }
  });

  // 소켓이 재연결돼도 토큰으로 관리자 권한을 복구한다
  safeOn('admin:resume', (token) => {
    if (tokenValid(token)) {
      socket.data.isAdmin = true;
      socket.emit('admin:loginResult', { success: true, token, resumed: true });
    } else {
      socket.emit('admin:loginResult', { success: false, resumed: true });
    }
  });

  broadcastState();

  safeOn('reserve:solo', () => {
    const user = authed('reserve:error');
    if (!user) return;
    const { className, number, name } = user;
    if (!reservationsOpen) { socket.emit('reserve:error', '아직 예약을 받지 않아요'); return; }
    if (hasActiveReservation(user) || inPendingGroup(user)) { socket.emit('reserve:error', '이미 예약했거나 모둠에 참여 중이에요'); return; }
    reservations.push(newReservation({
      className, number, name, type: 'solo', size: 1,
      members: [{ className, number, name }],
    }));
    if (adminStarted && currentTurnIndex === -2) {
      currentTurnIndex = reservations.length - 1;
      tryAssignTurn();
    }
    broadcastState();
  });

  safeOn('group:create', () => {
    const user = authed('group:joinError');
    if (!user) return;
    const { className, number, name } = user;
    if (hasActiveReservation(user) || inPendingGroup(user)) { socket.emit('group:joinError', '이미 예약했거나 모둠에 참여 중이에요'); return; }
    if (pendingGroups.length >= MAX_PENDING_GROUPS) { socket.emit('group:joinError', '지금은 모둠을 만들 수 없어요'); return; }
    const code = Math.random().toString(36).slice(2, 6).toUpperCase();
    pendingGroups.push({ code, members: [{ className, number, name }] });
    socket.emit('group:created', { code });
    broadcastState();
  });

  safeOn('group:join', (payload) => {
    const user = authed('group:joinError');
    if (!user) return;
    const code = cleanCode(payload && payload.code);
    if (!code) return bad('group:joinError');
    const { className, number, name } = user;
    if (hasActiveReservation(user) || inPendingGroup(user)) { socket.emit('group:joinError', '이미 예약했거나 모둠에 참여 중이에요'); return; }
    const group = pendingGroups.find(g => g.code === code);
    if (!group) {
      socket.emit('group:joinError', '코드를 찾을 수 없어요');
      return;
    }
    if (group.members.length >= MAX_GROUP_SIZE) {
      socket.emit('group:joinError', `모둠 최대 인원(${MAX_GROUP_SIZE}명)을 초과했어요`);
      return;
    }
    const already = group.members.some(m => m.className === className && m.number === number);
    if (already) {
      socket.emit('group:joinError', '이미 참여한 모둠이에요');
      return;
    }
    group.members.push({ className, number, name });
    broadcastState();
  });

  safeOn('group:submit', (payload) => {
    const id = authed('group:submitError');
    if (!id) return;
    const code = cleanCode(payload && payload.code);
    if (!code) return bad('group:submitError');
    const { className, number } = id;
    if (!reservationsOpen) { socket.emit('group:submitError', '아직 예약을 받지 않아요'); return; }
    const idx = pendingGroups.findIndex(g => g.code === code);
    if (idx === -1) { socket.emit('group:submitError', '모둠 정보를 찾을 수 없어요'); return; }
    const group = pendingGroups[idx];
    const leader = group.members[0];
    if (leader.className !== className || leader.number !== number) {
      socket.emit('group:submitError', '모둠장만 모둠 예약을 할 수 있어요');
      return;
    }

    pendingGroups.splice(idx, 1);
    reservations.push(newReservation({
      className: group.members[0].className, number: group.members[0].number, name: group.members[0].name,
      type: 'group', size: group.members.length, groupCode: group.code,
      members: group.members,
    }));

    if (adminStarted && currentTurnIndex === -2) {
      currentTurnIndex = reservations.length - 1;
      tryAssignTurn();
    }
    broadcastState();
  });

  safeOn('group:leave', (payload) => {
    const id = authed('app:error');
    if (!id) return;
    const code = cleanCode(payload && payload.code);
    if (!code) return;
    const { className, number } = id;
    const group = pendingGroups.find(g => g.code === code);
    if (!group) return;
    group.members = group.members.filter(m => !(m.className === className && m.number === number));
    if (group.members.length === 0) {
      pendingGroups = pendingGroups.filter(g => g.code !== code);
    }
    broadcastState();
  });

  safeOn('admin:openReservations', () => {
    if (!socket.data.isAdmin) return;
    reservationsOpen = true;
    broadcastState();
  });

  safeOn('admin:start', () => {
    if (!socket.data.isAdmin) return;
    if (adminStarted) return;
    adminStarted = true;
    currentTurnIndex = reservations.findIndex(r => r.status === 'waiting' && !r.priorityLocked);
    if (currentTurnIndex === -1) currentTurnIndex = -2;
    tryAssignTurn();
    broadcastState();
  });

  // 내 차례 전에 원하는 자리를 미리 고른다 (개인: 1석, 모둠: 시작 좌석부터 인원수만큼 연속)
  safeOn('seat:select', (payload) => {
    const id = authed('seat:error');
    if (!id) return;
    const reservationId = cleanId(payload && payload.reservationId);
    const seatId = cleanSeatId(payload && payload.seatId);
    if (!reservationId || !seatId) return bad('seat:error');
    const { className, number } = id;
    const res = reservations.find(r => r.id === reservationId);
    if (!res) return;
    if (res.className !== className || res.number !== number) {
      socket.emit('seat:error', res.type === 'group' ? '모둠장만 자리를 고를 수 있어요' : '본인 예약이 아니에요');
      return;
    }
    if (res.heldSeatIds.length || res.pendingSeatIds.length) {
      socket.emit('seat:error', '이미 자리를 예약했어요');
      return;
    }
    if (!canSelectSeat(res)) {
      socket.emit('seat:error', '아직 자리를 고를 수 없어요');
      return;
    }
    const picked = findContiguousSeats(seatId, res.size);
    if (!picked) {
      socket.emit('seat:error', '자리가 부족합니다');
      return;
    }
    res.heldSeatIds = picked.map(s => s.id);
    for (const s of picked) { s.status = 'held'; s.occupiedBy = res.id; }
    socket.emit('seat:selected', { seatIds: res.heldSeatIds });
    broadcastState();
  });

  // 이제 "현재 차례"가 아니어도, 본인에게 배정된 좌석(pendingSeatIds)이 있으면 인증 가능
  safeOn('confirmSeat', (payload) => {
    const user = authed('confirmSeat:error');
    if (!user) return;
    const reservationId = cleanId(payload && payload.reservationId);
    const seatId = cleanSeatId(payload && payload.seatId);
    if (!reservationId || !seatId) return bad('confirmSeat:error');
    const { className, number, name } = user;
    const res = reservations.find(r => r.id === reservationId);
    if (res && !res.members.some(m => sameUser(m, user))) {   // 내 예약(또는 내 모둠)만 인증할 수 있다
      socket.emit('confirmSeat:error', '내 예약이 아니에요');
      return;
    }
    if (!res || !res.pendingSeatIds || res.pendingSeatIds.length === 0) {
      socket.emit('confirmSeat:error', '지금은 착석 인증을 할 수 없어요');
      return;
    }

    if (!res.pendingSeatIds.includes(seatId)) {
      socket.emit('confirmSeat:error', '배정된 좌석이 아니에요');
      return;
    }
    if (res.confirmedSeatIds.includes(seatId)) {
      socket.emit('confirmSeat:error', '이미 확인된 좌석이에요');
      return;
    }
    const alreadyDone = Object.values(res.seatConfirmedBy).some(
      m => m.className === className && m.number === number
    );
    if (alreadyDone) {
      socket.emit('confirmSeat:error', '이미 착석 인증을 완료했어요');
      return;
    }

    res.confirmedSeatIds.push(seatId);
    res.seatConfirmedBy[seatId] = { className, number, name };
    const seat = seats.find(s => s.id === seatId);
    if (seat) seat.status = 'occupied';
    socket.emit('confirmSeat:success');

    if (res.confirmedSeatIds.length >= res.size) {
      if (turnTimers[res.id]) { clearTimeout(turnTimers[res.id]); delete turnTimers[res.id]; }
      finalizeAssignment(res);
      if (currentTurnIndex === reservations.indexOf(res)) {
        advanceToNextEligible();
        tryAssignTurn();
      }
      checkPriorityLocked();
    }
    broadcastState();
  });

  safeOn('release', (payload) => {
    const user = authed('app:error');
    if (!user) return;
    const reservationId = cleanId(payload && payload.reservationId);
    if (!reservationId) return;
    const res = reservations.find(r => r.id === reservationId);
    if (!res || res.status !== 'assigned') return;
    if (!res.members.some(m => sameUser(m, user))) return;   // 남의 자리는 반납할 수 없다
    for (const s of seats) {
      if (res.seatIds.includes(s.id)) { s.status = 'empty'; s.occupiedBy = null; }
    }
    res.status = 'released';
    checkPriorityLocked();
    broadcastState();
  });

  safeOn('cancelReservation', (payload) => {
    const id = authed('cancel:error');
    if (!id) return;
    const reservationId = cleanId(payload && payload.reservationId);
    if (!reservationId) return bad('cancel:error');
    const { className, number } = id;
    const res = reservations.find(r => r.id === reservationId);
    if (!res) return;
    if (res.status !== 'waiting') {
      socket.emit('cancel:error', '이미 진행 중이거나 완료된 예약은 취소할 수 없어요');
      return;
    }
    const isMember = res.members.some(m => m.className === className && m.number === number);
    if (!isMember) return;

    if (turnTimers[res.id]) { clearTimeout(turnTimers[res.id]); delete turnTimers[res.id]; }
    for (const seatId of [...res.pendingSeatIds, ...res.heldSeatIds]) {
      const seat = seats.find(s => s.id === seatId);
      if (seat) { seat.status = 'empty'; seat.occupiedBy = null; }
    }
    res.heldSeatIds = [];

    const idx = reservations.indexOf(res);
    reservations.splice(idx, 1);

    if (currentTurnIndex === idx) {
      currentTurnIndex -= 1;
      advanceToNextEligible();
      tryAssignTurn();
    } else if (currentTurnIndex > idx) {
      currentTurnIndex -= 1;
    }
    checkPriorityLocked();
    broadcastState();
  });

  safeOn('admin:reset', () => {
    if (!socket.data.isAdmin) return;
    Object.values(turnTimers).forEach(t => clearTimeout(t));
    turnTimers = {};
    reservations = [];
    pendingGroups = [];
    resetSeats();
    currentTurnIndex = -1;
    adminStarted = false;
    reservationsOpen = false;
    broadcastState();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`서버 실행중: 포트 ${PORT}`));