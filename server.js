const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const ADMIN_PASSWORD = 'songwoo2026'; // 원하는 비밀번호로 바꾸세요


// ===== NEIS 급식 API =====
const NEIS_KEY = process.env.NEIS_KEY || 'e0abd2795b4e49e0aabf24a60a04194c';
const OFFICE_CODE = 'J10';
const SCHOOL_CODE = '7530806';

app.get('/api/meal', async (req, res) => {
  const today = new Date();
  const ymd = today.toISOString().slice(0, 10).replace(/-/g, '');
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
let seats = [];
let reservations = []; // { id, className, number, name, type, size, groupCode, members, skipCount, priorityLocked, status, seatIds }
let currentTurnIndex = -1;
let adminStarted = false;

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

function commitAssignment(res, chosenSeats) {
  for (const s of chosenSeats) {
    s.status = 'occupied';
    s.occupiedBy = res.id;
  }
  res.status = 'assigned';
  res.seatIds = chosenSeats.map(s => s.id);
}

function checkPriorityLocked() {
  for (const res of reservations) {
    if (res.status !== 'waiting' || !res.priorityLocked) continue;
    const chosen = findAvailableSeats(res.size);
    if (chosen) {
      commitAssignment(res, chosen);
      checkPriorityLocked();
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
      status: r.status, seatIds: r.seatIds,
    })),
    currentTurnIndex,
    adminStarted,
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
    reservations.push({
      id: `r${Date.now()}${Math.floor(Math.random() * 1000)}`,
      className, number, name, type: 'solo', size: 1,
      members: [{ className, number, name }],
      skipCount: 0, priorityLocked: false, status: 'waiting', seatIds: [],
    });
    if (adminStarted && currentTurnIndex === -2) {
      currentTurnIndex = reservations.length - 1;
    }
    broadcastState();
  });

  socket.on('group:create', ({ className, number, name, size }) => {
    const code = Math.random().toString(36).slice(2, 6).toUpperCase();
    reservations.push({
      id: `r${Date.now()}${Math.floor(Math.random() * 1000)}`,
      className, number, name, type: 'group', size: Number(size), groupCode: code,
      members: [{ className, number, name }],
      skipCount: 0, priorityLocked: false, status: 'waiting', seatIds: [],
    });
    socket.emit('group:created', { code });
    if (adminStarted && currentTurnIndex === -2) {
      currentTurnIndex = reservations.length - 1;
    }
    broadcastState();
  });

  socket.on('group:join', ({ className, number, name, code }) => {
    const target = reservations.find(r => r.groupCode === code);
    if (!target) {
      socket.emit('group:joinError', '코드를 찾을 수 없어요');
      return;
    }
    target.members.push({ className, number, name });
    broadcastState();
  });

  socket.on('admin:start', () => {
  if (!socket.data.isAdmin) return; // 관리자 인증 안 됐으면 무시
  if (adminStarted) return;
  adminStarted = true;
  currentTurnIndex = reservations.findIndex(r => r.status === 'waiting' && !r.priorityLocked);
  if (currentTurnIndex === -1) currentTurnIndex = -2;
  broadcastState();
});

  socket.on('confirmSeat', ({ reservationId }) => {
    if (currentTurnIndex < 0) return;
    const res = reservations[currentTurnIndex];
    if (!res || res.id !== reservationId) return;

    const chosen = findAvailableSeats(res.size);
    if (chosen) {
      commitAssignment(res, chosen);
    } else {
      res.skipCount += 1;
      if (res.skipCount >= SKIP_CAP) res.priorityLocked = true;
    }
    advanceToNextEligible();
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

  socket.on('admin:reset', () => {
    if (!socket.data.isAdmin) return; // 관리자 인증 안 됐으면 무시
    reservations = [];
    resetSeats();
    currentTurnIndex = -1;
    adminStarted = false;
    broadcastState();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`서버 실행중: 포트 ${PORT}`));