import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { randomBytes, randomInt } from 'node:crypto';

const PORT = Number(process.env.PORT || 3000);
const BOARD_SIZE = 15;
const WIN_LENGTH = 5;
const PLAYER_COUNT = 2;
const SEAT_RESERVE_MS = 2 * 60 * 1000;
const ROOM_TTL_MS = 30 * 60 * 1000;
const MAX_ROOMS = 200;
const rooms = new Map();
const sessions = new Map();
const publicRoot = new URL('./public/', import.meta.url);
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']]
]);
const lanAddresses = [...new Set(Object.values(networkInterfaces()).flat().filter(entry => entry.family === 'IPv4' && !entry.internal).map(entry => `http://${entry.address}:${PORT}`))];

function token() { return randomBytes(24).toString('hex'); }
function fail(message, status = 400) { throw Object.assign(new Error(message), { status }); }
function log(room, message) { room.log = [...room.log.slice(-39), { id: token().slice(0, 8), message }]; }
function nextSeat(seat) { return (seat + 1) % PLAYER_COUNT; }
function newBoard() { return Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(null)); }
function newPlayer(name, seat) { return { token: token(), name, seat, online: true, offlineAt: 0, score: 0, ready: false, requests: [] }; }
function bindSession(room, player) { sessions.set(player.token, { room, player, stream: null, requests: [] }); }
function view(room, player) {
  return {
    code: room.code,
    you: player.seat,
    host: room.host,
    players: room.players.map(entry => entry ? { seat: entry.seat, name: entry.name, online: entry.online, score: entry.score, ready: entry.ready } : null),
    phase: room.phase,
    turn: room.turn,
    board: room.board,
    moves: room.moves,
    lastMove: room.moves.at(-1) || null,
    winner: room.winner,
    undoRequest: room.undoRequest,
    rematchVotes: room.rematchVotes,
    deadline: room.deadline,
    serverTime: Date.now(),
    log: room.log
  };
}
function push(room) {
  room.updatedAt = Date.now();
  for (const player of room.players.filter(Boolean)) {
    const session = sessions.get(player.token);
    if (session?.stream && !session.stream.destroyed) {
      session.stream.write(`data: ${JSON.stringify(view(room, player))}\n\n`);
    }
  }
}
function makeRoom(name) {
  if (rooms.size >= MAX_ROOMS) { fail('Server full. Try later.', 503); }
  let code;
  do { code = String(randomInt(100000, 1000000)); } while (rooms.has(code));
  const room = {
    code, host: 0, players: [newPlayer(name, 0), null], board: newBoard(), moves: [],
    phase: 'waiting', turn: 0, winner: null, undoRequest: null, rematchVotes: [],
    log: [], updatedAt: Date.now(), deadline: 0
  };
  rooms.set(code, room);
  bindSession(room, room.players[0]);
  log(room, `${name} created room`);
  return room;
}
function requireSession(value) {
  const session = typeof value === 'string' ? sessions.get(value) : null;
  if (!session) { fail('Session expired. Rejoin.', 401); }
  return session;
}
function validName(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name || [...name].length > 16 || /[\x00-\x1f\x7f]/.test(name)) { fail('Name: 1–16 characters.'); }
  return name;
}
function validCoordinate(value) { return Number.isInteger(value) && value >= 0 && value < BOARD_SIZE; }
function hasFive(board, row, column, color) {
  const directions = [[0, 1], [1, 0], [1, 1], [1, -1]];
  for (const [rowStep, columnStep] of directions) {
    let count = 1;
    for (const sign of [-1, 1]) {
      let nextRow = row + rowStep * sign;
      let nextColumn = column + columnStep * sign;
      while (nextRow >= 0 && nextRow < BOARD_SIZE && nextColumn >= 0 && nextColumn < BOARD_SIZE && board[nextRow][nextColumn] === color) {
        count++;
        nextRow += rowStep * sign;
        nextColumn += columnStep * sign;
      }
    }
    if (count >= WIN_LENGTH) { return true; }
  }
  return false;
}
function startGame(room) {
  room.board = newBoard();
  room.moves = [];
  room.phase = 'playing';
  room.turn = 0;
  room.winner = null;
  room.undoRequest = null;
  room.rematchVotes = [];
  for (const player of room.players) { player.ready = false; }
  log(room, 'New game. Black moves first.');
}
function roomAction(room, player, path, body) {
  if (path === '/api/ready') {
    if (!['waiting', 'finished'].includes(room.phase)) { fail('Game in progress.'); }
    if (typeof body.ready !== 'boolean') { fail('Invalid ready state.'); }
    player.ready = body.ready;
    if (room.phase === 'finished') {
      if (body.ready) { room.rematchVotes = [...new Set([...room.rematchVotes, player.seat])]; }
      else { room.rematchVotes = room.rematchVotes.filter(seat => seat !== player.seat); }
      if (room.rematchVotes.length === PLAYER_COUNT) { startGame(room); }
    }
    return;
  }
  if (path === '/api/start') {
    if (room.host !== player.seat) { fail('Host only.'); }
    if (room.phase !== 'waiting') { fail('Game in progress.'); }
    if (!room.players.every(entry => entry?.online && entry.ready)) { fail('Both players must be ready.'); }
    startGame(room);
    return;
  }
  if (path === '/api/move') {
    if (room.phase !== 'playing') { fail('Game is not active.'); }
    if (room.undoRequest) { fail('Undo pending.'); }
    if (room.turn !== player.seat) { fail('Wait your turn.'); }
    if (!validCoordinate(body.row) || !validCoordinate(body.column)) { fail('Invalid square.'); }
    if (room.board[body.row][body.column] !== null) { fail('Square occupied.'); }
    const color = player.seat === 0 ? 'black' : 'white';
    room.board[body.row][body.column] = color;
    const move = { row: body.row, column: body.column, color, seat: player.seat, name: player.name };
    room.moves.push(move);
    if (hasFive(room.board, body.row, body.column, color)) {
      room.phase = 'finished';
      room.winner = player.seat;
      player.score++;
      log(room, `${player.name} wins`);
    } else if (room.moves.length === BOARD_SIZE * BOARD_SIZE) {
      room.phase = 'finished';
      room.winner = null;
      log(room, 'Draw.');
    } else {
      room.turn = nextSeat(player.seat);
      log(room, `${color === 'black' ? 'Black' : 'White'} · ${body.column + 1}, ${body.row + 1}`);
    }
    room.undoRequest = null;
    room.rematchVotes = [];
    room.players.forEach(entry => { entry.ready = false; });
    return;
  }
  if (path === '/api/undo/request') {
    if (room.phase !== 'playing') { fail('Game is not active.'); }
    if (room.undoRequest) { fail('Undo already pending.'); }
    if (room.moves.length === 0) { fail('Nothing to undo.'); }
    if (room.moves.at(-1).seat === player.seat) { fail('No opponent move to undo.'); }
    room.undoRequest = { from: player.seat, to: nextSeat(player.seat) };
    log(room, `${player.name} requests undo`);
    return;
  }
  if (path === '/api/undo/respond') {
    if (!room.undoRequest) { fail('No undo request.'); }
    const requesterCancels = body.cancel === true && room.undoRequest.from === player.seat;
    if (!requesterCancels && room.undoRequest.to !== player.seat) { fail('No undo request.'); }
    const accepted = !requesterCancels && body.accept === true;
    if (accepted) {
      const move = room.moves.pop();
      room.board[move.row][move.column] = null;
      room.turn = move.seat;
      log(room, 'Undo accepted.');
    } else { log(room, requesterCancels ? 'Undo cancelled.' : 'Undo declined.'); }
    room.undoRequest = null;
    return;
  }
  fail('Unknown action.', 404);
}
function removePlayer(room, player) {
  const session = sessions.get(player.token);
  sessions.delete(player.token);
  if (session?.stream) { session.stream.end(); }
  room.players[player.seat] = null;
  log(room, `${player.name} left`);
  const remaining = room.players.filter(Boolean);
  if (remaining.length === 0) { rooms.delete(room.code); return; }
  if (room.host === player.seat) { room.host = remaining[0].seat; }
  room.phase = 'waiting';
  room.board = newBoard();
  room.moves = [];
  room.turn = 0;
  room.winner = null;
  room.undoRequest = null;
  room.rematchVotes = [];
  remaining.forEach(entry => { entry.ready = false; });
  log(room, 'Opponent left. Game reset.');
  push(room);
}
async function readBody(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk.toString();
    if (body.length > 8192) { fail('Request too large.', 413); }
  }
  try {
    const value = JSON.parse(body);
    if (!value || typeof value !== 'object' || Array.isArray(value)) { fail('Invalid request.'); }
    return value;
  } catch (error) {
    if (error.status) { throw error; }
    fail('Invalid request.');
  }
}
function sendJson(response, value, status = 200) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}
function rateLimit(session) {
  session.requests = session.requests.filter(time => time > Date.now() - 10000);
  if (session.requests.length >= 60) { fail('Slow down.', 429); }
  session.requests.push(Date.now());
}
async function api(request, response, path) {
  const body = await readBody(request);
  if (path === '/api/create') {
    const room = makeRoom(validName(body.name));
    sendJson(response, { token: room.players[0].token, state: view(room, room.players[0]) });
    return;
  }
  if (path === '/api/join') {
    const name = validName(body.name);
    const room = rooms.get(String(body.code));
    if (!room) { fail('Room not found.', 404); }
    const seat = room.players.findIndex(entry => !entry);
    if (seat < 0) { fail('Room full.'); }
    if (room.players.some(entry => entry?.name === name)) { fail('Name taken.'); }
    const player = newPlayer(name, seat);
    room.players[seat] = player;
    bindSession(room, player);
    log(room, `${name} joined`);
    push(room);
    sendJson(response, { token: player.token, state: view(room, player) });
    return;
  }
  const session = requireSession(request.headers.authorization?.replace(/^Bearer /, ''));
  const { room, player } = session;
  rateLimit(session);
  if (path === '/api/resume') { sendJson(response, { state: view(room, player) }); return; }
  if (path === '/api/leave') { removePlayer(room, player); sendJson(response, { ok: true }); return; }
  if (!room.players.every(Boolean) && path !== '/api/resume') { fail('Waiting for another player.'); }
  roomAction(room, player, path, body);
  push(room);
  sendJson(response, { state: view(room, player) });
}
const server = http.createServer(async (request, response) => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  try {
    const url = new URL(request.url, 'http://localhost');
    if (request.method === 'POST' && url.pathname.startsWith('/api/')) {
      if (request.headers.origin && request.headers.origin !== `http://${request.headers.host}`) { fail('Invalid origin.', 403); }
      await api(request, response, url.pathname);
      return;
    }
    if (request.method !== 'GET') { fail('Method not allowed.', 405); }
    if (url.pathname === '/api/info') { sendJson(response, { addresses: lanAddresses, port: PORT }); return; }
    if (url.pathname === '/events') {
      const session = requireSession(url.searchParams.get('token'));
      if (session.stream) { session.stream.end(); }
      session.stream = response;
      session.player.online = true;
      session.player.offlineAt = 0;
      response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' });
      response.write('retry: 2000\n\n');
      const heartbeat = setInterval(() => { response.write(': heartbeat\n\n'); }, 15000);
      request.on('close', () => {
        clearInterval(heartbeat);
        if (session.stream !== response) { return; }
        session.stream = null;
        session.player.online = false;
        session.player.offlineAt = Date.now();
        if (rooms.has(session.room.code)) { push(session.room); }
      });
      push(session.room);
      return;
    }
    const asset = assets.get(url.pathname);
    if (!asset) { fail('Not found.', 404); }
    const content = await readFile(new URL(asset[0], publicRoot));
    response.writeHead(200, { 'Content-Type': asset[1], 'Cache-Control': 'no-cache' });
    response.end(content);
  } catch (error) {
    if (!error.status) { console.error('Request failed:', error); }
    if (!response.headersSent) { sendJson(response, { error: error.status ? error.message : 'Server error. Retry.' }, error.status || 500); }
    else { response.end(); }
  }
});
const maintenance = setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    const expired = room.players.filter(player => player && !player.online && player.offlineAt && now - player.offlineAt > SEAT_RESERVE_MS);
    for (const player of expired) { if (rooms.has(room.code)) { removePlayer(room, player); } }
    if (!rooms.has(room.code)) { continue; }
    if (now - room.updatedAt > ROOM_TTL_MS && !room.players.some(player => player?.online)) { rooms.delete(room.code); }
  }
}, 1000);
server.requestTimeout = 15000;
server.headersTimeout = 10000;
server.on('error', error => {
  console.error(error.code === 'EADDRINUSE' ? `Port ${PORT} busy. Choose another PORT.` : error.message);
  clearInterval(maintenance);
  process.exitCode = 1;
});
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  WZQ · FIVE IN A ROW\n  Local: http://localhost:${PORT}\n${lanAddresses.map(address => `  LAN: ${address}`).join('\n')}\n\n  Share the LAN address and six-digit room code.\n  Keep this window open. Ctrl+C to stop.\n`);
});
function shutdown() {
  clearInterval(maintenance);
  for (const session of sessions.values()) { session.stream?.end(); }
  server.close();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
