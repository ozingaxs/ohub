const path = require('path');
const http = require('http');
const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { Server } = require('socket.io');

dotenv.config();

const app = express();
const server = http.createServer(app);

const PORT = Number(process.env.PORT) || 3000;
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const ROOM_IDLE_DELETE_MS = 5 * 60 * 1000;
const MAX_MESSAGE_HISTORY = 100;
const MAX_FILE_SIZE_BYTES = 2 * 1024 * 1024;
const MESSAGE_RATE_LIMIT_WINDOW = 60 * 1000;
const MESSAGE_RATE_LIMIT_MAX = 30;

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: CORS_ORIGIN === '*' ? true : CORS_ORIGIN }));
app.use(express.json({ limit: '2mb' }));

const httpLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false
});
app.use(httpLimiter);

app.use(express.static(path.join(__dirname, 'public')));

const io = new Server(server, {
  cors: {
    origin: CORS_ORIGIN === '*' ? true : CORS_ORIGIN,
    methods: ['GET', 'POST']
  }
});

const users = new Map(); // socketId -> { username, room, joinedAt }
const rooms = new Map(); // roomName -> { users[], createdAt, messageCount, messages[], password, ownerId, messageTTL, cleanupTimer }
const activeCalls = new Map(); // roomId -> { participants[], startedAt }
const messageExpiryTimers = new Map(); // messageId -> timeout
const socketMessageBuckets = new Map(); // socketId -> timestamp[] for message/file rate limit

const adjectives = ['Silent', 'Cosmic', 'Neon', 'Hidden', 'Swift', 'Shadow', 'Golden', 'Lunar', 'Electric', 'Crimson'];
const animals = ['Fox', 'Wolf', 'Lion', 'Falcon', 'Panther', 'Otter', 'Raven', 'Tiger', 'Whale', 'Leopard'];
const allowedReactions = new Set(['👍', '❤️', '😂', '🔥', '👏', '😮', '🎉', '😢']);

const chatNamespace = io.of('/chat');
const callNamespace = io.of('/call');

function randomUsername() {
  const adjective = adjectives[Math.floor(Math.random() * adjectives.length)];
  const animal = animals[Math.floor(Math.random() * animals.length)];
  const suffix = Math.floor(Math.random() * 900 + 100);
  return `${adjective}${animal}${suffix}`;
}

function normalizeRoomOptions(raw = {}) {
  const name = String(raw?.name || raw?.roomName || '').trim().slice(0, 40);
  const password = String(raw?.password || '').trim().slice(0, 40);
  const ttl = Number(raw?.messageTTL || 0);
  const allowedTTLs = [0, 5 * 60 * 1000, 60 * 60 * 1000, 24 * 60 * 60 * 1000];
  return {
    name,
    password,
    messageTTL: allowedTTLs.includes(ttl) ? ttl : 0
  };
}

function clearRoomCleanupTimer(roomName) {
  const room = rooms.get(roomName);
  if (!room?.cleanupTimer) return;
  clearTimeout(room.cleanupTimer);
  room.cleanupTimer = null;
}

function scheduleRoomCleanup(roomName) {
  const room = rooms.get(roomName);
  if (!room || room.users.length > 0 || roomName === 'Default') return;
  clearRoomCleanupTimer(roomName);
  room.cleanupTimer = setTimeout(() => {
    const pendingRoom = rooms.get(roomName);
    if (!pendingRoom || pendingRoom.users.length > 0 || roomName === 'Default') return;

    // clear message timers for this room
    pendingRoom.messages.forEach((message) => {
      const timer = messageExpiryTimers.get(message.id);
      if (timer) {
        clearTimeout(timer);
        messageExpiryTimers.delete(message.id);
      }
    });

    rooms.delete(roomName);
    chatNamespace.emit('rooms-updated');
    emitRoomList(chatNamespace);
  }, ROOM_IDLE_DELETE_MS);
}

function ensureRoom(roomName, options = {}) {
  if (!rooms.has(roomName)) {
    rooms.set(roomName, {
      users: [],
      createdAt: new Date().toISOString(),
      messageCount: 0,
      messages: [],
      password: options.password || '',
      ownerId: options.ownerId || null,
      messageTTL: options.messageTTL || 0,
      cleanupTimer: null
    });
  }
  const room = rooms.get(roomName);
  if (options.password !== undefined && room.ownerId === options.ownerId) {
    room.password = options.password;
  }
  if (options.messageTTL !== undefined && room.ownerId === options.ownerId) {
    room.messageTTL = options.messageTTL;
  }
  return room;
}

function sanitizeText(text, maxLength = 500) {
  return String(text || '').replace(/<[^>]*>/g, '').replace(/[\u0000-\u001F]/g, '').trim().slice(0, maxLength);
}

function buildReactionPayload(reactions = {}) {
  return Object.entries(reactions).map(([emoji, userSet]) => ({ emoji, count: userSet.size }));
}

function roomUsers(roomName) {
  const room = rooms.get(roomName);
  if (!room) return [];
  return room.users
    .map((socketId) => {
      const user = users.get(socketId);
      return user ? { socketId, username: user.username } : null;
    })
    .filter(Boolean);
}

function emitRoomList(targetSocket) {
  const roomList = Array.from(rooms.entries()).map(([name, details]) => ({
    name,
    count: details.users.length,
    createdAt: details.createdAt,
    messageCount: details.messageCount,
    isPrivate: Boolean(details.password),
    messageTTL: details.messageTTL
  }));
  targetSocket.emit('rooms-list', roomList);
}

function emitOnlineCount() {
  chatNamespace.emit('online-count', users.size);
}

function checkMessageRateLimit(socketId) {
  const now = Date.now();
  const timestamps = socketMessageBuckets.get(socketId) || [];
  const valid = timestamps.filter((stamp) => now - stamp < MESSAGE_RATE_LIMIT_WINDOW);
  if (valid.length >= MESSAGE_RATE_LIMIT_MAX) {
    socketMessageBuckets.set(socketId, valid);
    return false;
  }
  valid.push(now);
  socketMessageBuckets.set(socketId, valid);
  return true;
}

function normalizeBase64Image(dataUrl) {
  const value = String(dataUrl || '');
  const match = value.match(/^data:(image\/(png|jpeg|jpg|gif|webp));base64,([A-Za-z0-9+/=]+)$/i);
  if (!match) return null;
  const mimeType = match[1].toLowerCase() === 'image/jpg' ? 'image/jpeg' : match[1].toLowerCase();
  const base64Body = match[3];
  const bytes = Math.floor((base64Body.length * 3) / 4) - (base64Body.endsWith('==') ? 2 : base64Body.endsWith('=') ? 1 : 0);
  if (bytes > MAX_FILE_SIZE_BYTES) return null;
  return `data:${mimeType};base64,${base64Body}`;
}

function pushRoomMessage(roomName, message) {
  const room = rooms.get(roomName);
  if (!room) return;
  room.messages.push(message);
  if (room.messages.length > MAX_MESSAGE_HISTORY) {
    const removed = room.messages.shift();
    const timer = messageExpiryTimers.get(removed.id);
    if (timer) {
      clearTimeout(timer);
      messageExpiryTimers.delete(removed.id);
    }
  }

  if (room.messageTTL > 0) {
    const timer = setTimeout(() => {
      const targetRoom = rooms.get(roomName);
      if (!targetRoom) return;
      const index = targetRoom.messages.findIndex((item) => item.id === message.id);
      if (index === -1) return;
      targetRoom.messages.splice(index, 1);
      messageExpiryTimers.delete(message.id);
      chatNamespace.to(roomName).emit('message-deleted', { messageId: message.id, reason: 'expired' });
      emitRoomList(chatNamespace);
    }, room.messageTTL);
    messageExpiryTimers.set(message.id, timer);
  }
}

function resetRoomMessages(roomName) {
  const room = rooms.get(roomName);
  if (!room) return;

  room.messages.forEach((message) => {
    const timer = messageExpiryTimers.get(message.id);
    if (timer) {
      clearTimeout(timer);
      messageExpiryTimers.delete(message.id);
    }
  });
  room.messages = [];
  room.messageCount = 0;
  chatNamespace.to(roomName).emit('messages-reset');
}

ensureRoom('Default', { ownerId: null, password: '', messageTTL: 0 });

chatNamespace.on('connection', (socket) => {
  const username = randomUsername();
  users.set(socket.id, { username, room: null, joinedAt: new Date().toISOString() });

  socket.emit('welcome', { username, socketId: socket.id });
  emitOnlineCount();
  emitRoomList(socket);

  socket.on('get-rooms', () => emitRoomList(socket));

  socket.on('create-room', (payload, callback) => {
    const { name, password, messageTTL } = normalizeRoomOptions(payload);
    if (!name) {
      callback?.({ ok: false, error: 'Room name is required.' });
      return;
    }

    if (rooms.has(name)) {
      callback?.({ ok: false, error: 'Room already exists.' });
      return;
    }

    ensureRoom(name, { ownerId: socket.id, password, messageTTL });
    chatNamespace.emit('room-created', { name });
    emitRoomList(chatNamespace);
    callback?.({ ok: true, room: name });
  });

  socket.on('join-room', (payload = {}, callback) => {
    const requestedName = typeof payload === 'string' ? payload : payload.roomName;
    const suppliedPassword = typeof payload === 'string' ? '' : String(payload.password || '');
    const targetRoom = String(requestedName || 'Default').trim().slice(0, 40) || 'Default';

    if (!rooms.has(targetRoom)) {
      callback?.({ ok: false, error: 'Room does not exist.' });
      return;
    }

    const roomToJoin = rooms.get(targetRoom);
    if (roomToJoin.password && roomToJoin.password !== suppliedPassword) {
      callback?.({ ok: false, error: 'Invalid room password.' });
      socket.emit('join-room-error', { room: targetRoom, error: 'Invalid room password.' });
      return;
    }

    const user = users.get(socket.id);
    if (!user) return;

    if (user.room && rooms.has(user.room)) {
      const previousRoom = rooms.get(user.room);
      previousRoom.users = previousRoom.users.filter((id) => id !== socket.id);
      socket.leave(user.room);
      socket.to(user.room).emit('system-message', {
        text: `${user.username} left the room.`,
        timestamp: new Date().toISOString(),
        room: user.room
      });
      chatNamespace.to(user.room).emit('room-users', roomUsers(user.room));
      if (previousRoom.users.length === 0) scheduleRoomCleanup(user.room);
    }

    user.room = targetRoom;
    users.set(socket.id, user);
    clearRoomCleanupTimer(targetRoom);

    if (!roomToJoin.users.includes(socket.id)) roomToJoin.users.push(socket.id);
    socket.join(targetRoom);

    socket.emit('room-joined', {
      room: targetRoom,
      users: roomUsers(targetRoom),
      messageCount: roomToJoin.messageCount,
      history: roomToJoin.messages.map((message) => ({
        ...message,
        reactions: buildReactionPayload(message.reactions)
      })),
      isPrivate: Boolean(roomToJoin.password),
      messageTTL: roomToJoin.messageTTL
    });

    socket.to(targetRoom).emit('system-message', {
      text: `${user.username} joined the room.`,
      timestamp: new Date().toISOString(),
      room: targetRoom
    });

    chatNamespace.to(targetRoom).emit('room-users', roomUsers(targetRoom));
    chatNamespace.emit('rooms-updated');
    emitRoomList(chatNamespace);
    callback?.({ ok: true, room: targetRoom });
  });

  socket.on('send-message', (payload, callback) => {
    if (!checkMessageRateLimit(socket.id)) {
      callback?.({ ok: false, error: 'Rate limit exceeded. Max 30 messages/minute.' });
      socket.emit('rate-limit-hit', { message: 'Rate limit exceeded. Try again in a moment.' });
      return;
    }

    const user = users.get(socket.id);
    if (!user || !user.room || typeof payload?.text !== 'string') return;

    const text = sanitizeText(payload.text, 500);
    if (!text) return;

    const room = rooms.get(user.room);
    if (!room) return;

    room.messageCount += 1;
    const message = {
      id: `${socket.id}-${Date.now()}`,
      room: user.room,
      text,
      username: user.username,
      socketId: socket.id,
      timestamp: new Date().toISOString(),
      type: 'text',
      reactions: {}
    };

    pushRoomMessage(user.room, message);

    chatNamespace.to(user.room).emit('new-message', {
      ...message,
      reactions: []
    });
    if (room.messageCount >= MAX_MESSAGE_HISTORY) resetRoomMessages(user.room);
    emitRoomList(chatNamespace);
    callback?.({ ok: true, messageId: message.id });
  });

  socket.on('send-file', (payload, callback) => {
    if (!checkMessageRateLimit(socket.id)) {
      callback?.({ ok: false, error: 'Rate limit exceeded. Max 30 messages/minute.' });
      socket.emit('rate-limit-hit', { message: 'Rate limit exceeded. Try again in a moment.' });
      return;
    }

    const user = users.get(socket.id);
    if (!user || !user.room) return;

    const imageData = normalizeBase64Image(payload?.dataUrl);
    const caption = sanitizeText(payload?.caption || '', 200);
    if (!imageData) {
      callback?.({ ok: false, error: 'Only images up to 2MB are allowed.' });
      return;
    }

    const room = rooms.get(user.room);
    if (!room) return;

    room.messageCount += 1;
    const message = {
      id: `${socket.id}-${Date.now()}`,
      room: user.room,
      text: caption,
      username: user.username,
      socketId: socket.id,
      timestamp: new Date().toISOString(),
      type: 'image',
      imageData,
      reactions: {}
    };

    pushRoomMessage(user.room, message);
    chatNamespace.to(user.room).emit('new-message', { ...message, reactions: [] });
    if (room.messageCount >= MAX_MESSAGE_HISTORY) resetRoomMessages(user.room);
    emitRoomList(chatNamespace);
    callback?.({ ok: true, messageId: message.id });
  });

  socket.on('add-reaction', ({ messageId, emoji }) => {
    if (!allowedReactions.has(emoji)) return;
    const user = users.get(socket.id);
    if (!user?.room) return;

    const room = rooms.get(user.room);
    if (!room) return;
    const message = room.messages.find((item) => item.id === messageId);
    if (!message) return;

    if (!message.reactions[emoji]) {
      message.reactions[emoji] = new Set();
    }

    if (message.reactions[emoji].has(socket.id)) {
      message.reactions[emoji].delete(socket.id);
      if (message.reactions[emoji].size === 0) {
        delete message.reactions[emoji];
      }
    } else {
      message.reactions[emoji].add(socket.id);
    }

    chatNamespace.to(user.room).emit('reaction-updated', {
      messageId,
      reactions: buildReactionPayload(message.reactions)
    });
  });

  socket.on('typing-start', () => {
    const user = users.get(socket.id);
    if (!user?.room) return;
    socket.to(user.room).emit('typing-start', { username: user.username, socketId: socket.id });
  });

  socket.on('typing-stop', () => {
    const user = users.get(socket.id);
    if (!user?.room) return;
    socket.to(user.room).emit('typing-stop', { socketId: socket.id });
  });

  socket.on('disconnect', () => {
    const user = users.get(socket.id);
    if (user?.room && rooms.has(user.room)) {
      const room = rooms.get(user.room);
      room.users = room.users.filter((id) => id !== socket.id);

      socket.to(user.room).emit('system-message', {
        text: `${user.username} disconnected.`,
        timestamp: new Date().toISOString(),
        room: user.room
      });

      chatNamespace.to(user.room).emit('room-users', roomUsers(user.room));
      if (room.users.length === 0) scheduleRoomCleanup(user.room);
    }

    socketMessageBuckets.delete(socket.id);
    users.delete(socket.id);
    emitOnlineCount();
    emitRoomList(chatNamespace);
  });
});

callNamespace.on('connection', (socket) => {
  socket.on('join-call-room', (roomId) => {
    const safeRoomId = String(roomId || '').trim().slice(0, 32);
    if (!safeRoomId) return;

    socket.join(safeRoomId);
    const call = activeCalls.get(safeRoomId) || { participants: [], startedAt: new Date().toISOString() };
    if (!call.participants.includes(socket.id)) call.participants.push(socket.id);
    activeCalls.set(safeRoomId, call);

    socket.emit('call-room-joined', {
      roomId: safeRoomId,
      participants: call.participants.filter((id) => id !== socket.id)
    });

    socket.to(safeRoomId).emit('peer-joined', { peerId: socket.id, participants: call.participants });
  });

  socket.on('call-request', ({ roomId, caller }) => {
    callNamespace.to(roomId).emit('call-request', { roomId, caller, from: socket.id });
  });

  socket.on('call-accepted', ({ roomId }) => {
    socket.to(roomId).emit('call-accepted', { roomId, by: socket.id });
  });

  socket.on('call-rejected', ({ roomId }) => {
    socket.to(roomId).emit('call-rejected', { roomId, by: socket.id });
  });

  socket.on('webrtc-offer', ({ target, offer, roomId }) => {
    callNamespace.to(target).emit('webrtc-offer', { from: socket.id, offer, roomId });
  });

  socket.on('webrtc-answer', ({ target, answer, roomId }) => {
    callNamespace.to(target).emit('webrtc-answer', { from: socket.id, answer, roomId });
  });

  socket.on('webrtc-ice-candidate', ({ target, candidate, roomId }) => {
    callNamespace.to(target).emit('webrtc-ice-candidate', { from: socket.id, candidate, roomId });
  });

  socket.on('call-chat-message', ({ roomId, text, at }) => {
    socket.to(roomId).emit('call-chat-message', {
      from: socket.id,
      text: String(text || '').slice(0, 300),
      at: at || new Date().toISOString()
    });
  });

  socket.on('mute-toggle', ({ roomId, muted }) => {
    socket.to(roomId).emit('mute-toggle', { peerId: socket.id, muted: Boolean(muted) });
  });

  socket.on('video-toggle', ({ roomId, videoOff }) => {
    socket.to(roomId).emit('video-toggle', { peerId: socket.id, videoOff: Boolean(videoOff) });
  });

  socket.on('call-ended', ({ roomId }) => {
    if (roomId) socket.to(roomId).emit('call-ended', { peerId: socket.id });
  });

  socket.on('disconnecting', () => {
    for (const roomId of socket.rooms) {
      if (roomId === socket.id || !activeCalls.has(roomId)) continue;
      const call = activeCalls.get(roomId);
      call.participants = call.participants.filter((id) => id !== socket.id);
      socket.to(roomId).emit('peer-left', { peerId: socket.id, participants: call.participants });
      if (call.participants.length === 0) {
        activeCalls.delete(roomId);
      } else {
        activeCalls.set(roomId, call);
      }
    }
  });
});

app.get('/health', (_, res) => {
  res.json({
    status: 'ok',
    users: users.size,
    rooms: rooms.size,
    activeCalls: activeCalls.size
  });
});

app.get('*', (_, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

server.listen(PORT, () => {
  console.log(`Ohub server running at http://localhost:${PORT}`);
});
