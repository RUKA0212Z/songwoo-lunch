const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

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
  turnTimers[res.id] = setTimeout(() => handleTurnTimeout(res.id), TURN_TIMEOUT_MS);
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

io.on('connection', (socket) => {
  socket.data.isAdmin = false;

  socket.on('admin:login', (password) => {
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
  socket.on('admin:resume', (token) => {
    if (tokenValid(token)) {
      socket.data.isAdmin = true;
      socket.emit('admin:loginResult', { success: true, token, resumed: true });
    } else {
      socket.emit('admin:loginResult', { success: false, resumed: true });
    }
  });

  broadcastState();

  socket.on('reserve:solo', ({ className, number, name }) => {
    if (!reservationsOpen) { socket.emit('reserve:error', '아직 예약을 받지 않아요'); return; }
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

  socket.on('group:create', ({ className, number, name }) => {
    const code = Math.random().toString(36).slice(2, 6).toUpperCase();
    pendingGroups.push({ code, members: [{ className, number, name }] });
    socket.emit('group:created', { code });
    broadcastState();
  });

  socket.on('group:join', ({ className, number, name, code }) => {
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

  socket.on('group:submit', ({ code, className, number }) => {
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

  socket.on('group:leave', ({ code, className, number }) => {
    const group = pendingGroups.find(g => g.code === code);
    if (!group) return;
    group.members = group.members.filter(m => !(m.className === className && m.number === number));
    if (group.members.length === 0) {
      pendingGroups = pendingGroups.filter(g => g.code !== code);
    }
    broadcastState();
  });

  socket.on('admin:openReservations', () => {
    if (!socket.data.isAdmin) return;
    reservationsOpen = true;
    broadcastState();
  });

  socket.on('admin:start', () => {
    if (!socket.data.isAdmin) return;
    if (adminStarted) return;
    adminStarted = true;
    currentTurnIndex = reservations.findIndex(r => r.status === 'waiting' && !r.priorityLocked);
    if (currentTurnIndex === -1) currentTurnIndex = -2;
    tryAssignTurn();
    broadcastState();
  });

  // 내 차례 전에 원하는 자리를 미리 고른다 (개인: 1석, 모둠: 시작 좌석부터 인원수만큼 연속)
  socket.on('seat:select', ({ reservationId, seatId, className, number }) => {
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
  socket.on('confirmSeat', ({ reservationId, seatId, className, number, name }) => {
    const res = reservations.find(r => r.id === reservationId);
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

  socket.on('release', ({ reservationId }) => {
    const res = reservations.find(r => r.id === reservationId);
    if (!res || res.status !== 'assigned') return;
    for (const s of seats) {
      if (res.seatIds.includes(s.id)) { s.status = 'empty'; s.occupiedBy = null; }
    }
    res.status = 'released';
    checkPriorityLocked();
    broadcastState();
  });

  socket.on('cancelReservation', ({ reservationId, className, number }) => {
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

  socket.on('admin:reset', () => {
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