const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const ADMIN_PASSWORD = 'songwoo2026';

// ===== NEIS 급식 API =====
const NEIS_KEY = process.env.NEIS_KEY || 'e0abd2795b4e49e0aabf24a60a04194c';
const OFFICE_CODE = 'J10';
const SCHOOL_CODE = '7530806';

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.get('/api/meal', async (req, res) => {
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
let seats = [];
let reservations = [];
let pendingGroups = []; // 아직 예약 확정 안 하고 모여만 있는 모둠들
let currentTurnIndex = -1;
let adminStarted = false;
let reservationsOpen = false;
const TURN_TIMEOUT_MS = 5 * 60 * 1000; // 5분
let turnTimers = {}; // { [reservationId]: timeoutHandle }
let currentTurnDeadline = null;

function makeSeats(tableId, count) {
  return Array.from({ length: count }, (_, i) => ({
    id: `${tableId}${i + 1}`,
    tableId,
    status: 'empty',
    occupiedBy: null,
  }));
}
function resetSeats() {
  seats = [...makeSeats('A', 4), ...makeSeats('B', 4), ...makeSeats('C', 6)];
}
resetSeats();

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

function finalizeAssignment(res) {
  res.status = 'assigned';
  res.seatIds = res.pendingSeatIds;
  res.pendingSeatIds = [];
}

function checkPriorityLocked() {
  for (const res of reservations) {
    if (res.status !== 'waiting' || !res.priorityLocked) continue;
    if (res.pendingSeatIds && res.pendingSeatIds.length) continue;
    const chosen = findAvailableSeats(res.size);
    if (chosen) {
      reserveSeatsTemporarily(res, chosen);
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

function broadcastState() {
  io.emit('state', {
    seats,
    reservations: reservations.map(r => ({
      id: r.id, className: r.className, number: r.number, name: r.name, type: r.type,
      size: r.size, groupCode: r.groupCode, members: r.members,
      skipCount: r.skipCount, priorityLocked: r.priorityLocked,
      status: r.status, seatIds: r.seatIds, pendingSeatIds: r.pendingSeatIds,
      confirmedSeatIds: r.confirmedSeatIds, seatConfirmedBy: r.seatConfirmedBy,
    })),
    pendingGroups,
    currentTurnIndex,
    adminStarted,
    reservationsOpen,
    turnDeadline: currentTurnDeadline,   // 이 줄 추가
  });
}

io.on('connection', (socket) => {
socket.data.isAdmin = false;

socket.on('admin:login', (password) => {
  if (password === ADMIN_PASSWORD) {
    socket.data.isAdmin = true;
    socket.emit('admin:loginResult', { success: true });
  } else {
    socket.emit('admin:loginResult', { success: false });
  }
});

  broadcastState();

  socket.on('reserve:solo', ({ className, number, name }) => {
    if (!reservationsOpen) { socket.emit('reserve:error', '아직 예약을 받지 않아요'); return; }
    reservations.push({
      id: `r${Date.now()}${Math.floor(Math.random() * 1000)}`,
      className, number, name, type: 'solo', size: 1,
      members: [{ className, number, name }],
      skipCount: 0, priorityLocked: false, status: 'waiting', seatIds: [], pendingSeatIds: [], confirmedSeatIds: [], seatConfirmedBy: {},
    });
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
    const isMember = group.members.some(m => m.className === className && m.number === number);
    if (!isMember) return;

    pendingGroups.splice(idx, 1);
    reservations.push({
      id: `r${Date.now()}${Math.floor(Math.random() * 1000)}`,
      className: group.members[0].className, number: group.members[0].number, name: group.members[0].name,
      type: 'group', size: group.members.length, groupCode: group.code,
      members: group.members,
      skipCount: 0, priorityLocked: false, status: 'waiting', seatIds: [], pendingSeatIds: [], confirmedSeatIds: [], seatConfirmedBy: {},
    });

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

  function tryAssignTurn() {
  if (currentTurnIndex < 0) return;
  const res = reservations[currentTurnIndex];
  if (!res) return;

  const chosen = findAvailableSeats(res.size);
  if (chosen) {
    reserveSeatsTemporarily(res, chosen);
    currentTurnDeadline = Date.now() + TURN_TIMEOUT_MS;
    turnTimers[res.id] = setTimeout(() => handleTurnTimeout(res.id), TURN_TIMEOUT_MS);
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
  res.status = res.confirmedSeatIds.length > 0 ? 'assigned' : 'expired';
  res.timedOut = true;

  if (currentTurnIndex === reservations.indexOf(res)) {
    currentTurnDeadline = null;
    advanceToNextEligible();
    tryAssignTurn();
  }
  checkPriorityLocked();
  broadcastState();
}

  socket.on('confirmSeat', ({ reservationId, seatId, className, number, name }) => {
  if (currentTurnIndex < 0) return;
  const res = reservations[currentTurnIndex];
  if (!res || res.id !== reservationId) return;

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
    clearTimeout(turnTimers[res.id]);
    delete turnTimers[res.id];
    finalizeAssignment(res);
    currentTurnDeadline = null;
    advanceToNextEligible();
    tryAssignTurn();
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
  
    if (turnTimers[res.id]) {
      clearTimeout(turnTimers[res.id]);
      delete turnTimers[res.id];
      currentTurnDeadline = null;
    }
    for (const seatId of res.pendingSeatIds) {
      const seat = seats.find(s => s.id === seatId);
      if (seat) { seat.status = 'empty'; seat.occupiedBy = null; }
    }
  
    const idx = reservations.indexOf(res);
    reservations.splice(idx, 1);
  
    if (currentTurnIndex === idx) {
      currentTurnIndex -= 1;
      advanceToNextEligible();
      tryAssignTurn();
    } else if (currentTurnIndex > idx) {
      currentTurnIndex -= 1;
    }
  
    broadcastState();
  });

  socket.on('admin:reset', () => {
    if (!socket.data.isAdmin) return;
    Object.values(turnTimers).forEach(t => clearTimeout(t));
    turnTimers = {};
    currentTurnDeadline = null;
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
