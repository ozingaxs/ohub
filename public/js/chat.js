import { createSocket } from './socket-client.js';
import { debounce, formatTimestamp, generateUsername, sanitizeMessage, showNotification } from './utils.js';

const socket = createSocket('/chat');
const usernameDisplay = document.getElementById('usernameDisplay');
const onlineCountEl = document.getElementById('onlineCount');
const roomListEl = document.getElementById('roomList');
const currentRoomNameEl = document.getElementById('currentRoomName');
const currentRoomCountEl = document.getElementById('currentRoomCount');
const messageFeed = document.getElementById('messageFeed');
const typingIndicator = document.getElementById('typingIndicator');
const messageForm = document.getElementById('messageForm');
const messageInput = document.getElementById('messageInput');
const roomUsersEl = document.getElementById('roomUsers');
const roomModal = document.getElementById('roomModal');
const roomNameInput = document.getElementById('roomNameInput');
const roomPasswordInput = document.getElementById('roomPasswordInput');
const roomTTLSelect = document.getElementById('roomTTLSelect');
const emojiPanel = document.getElementById('emojiPanel');
const fileInput = document.getElementById('fileInput');

const emojis = ['😀', '😂', '😍', '😎', '🤖', '🔥', '🎉', '✨', '🙌', '🤝', '💡', '🚀', '👏', '🥳', '😴', '🤔', '😇', '😅', '🎧', '🫶'];
const reactionChoices = ['👍', '❤️', '😂', '🔥', '👏'];
let currentRoom = 'Default';
let mySocketId = '';
let myUsername = localStorage.getItem('anon_username') || generateUsername();
let pendingPasswords = new Map();

localStorage.setItem('anon_username', myUsername);
usernameDisplay.textContent = myUsername;

function getOrAskPassword(roomName, isPrivate) {
  if (!isPrivate) return '';
  if (pendingPasswords.has(roomName)) return pendingPasswords.get(roomName);
  const typed = prompt(`Room "${roomName}" is private. Enter password:`) || '';
  pendingPasswords.set(roomName, typed);
  return typed;
}

function joinRoom(roomName, isPrivate = false) {
  const password = getOrAskPassword(roomName, isPrivate);
  socket.emit('join-room', { roomName, password }, (response) => {
    if (!response?.ok) {
      renderSystemMessage(response?.error || 'Unable to join room.');
      if (isPrivate) pendingPasswords.delete(roomName);
      return;
    }

    currentRoom = roomName;
    currentRoomNameEl.textContent = roomName;
    typingIndicator.textContent = '';
  });
}

function renderReactions(messageEl, reactions = []) {
  let reactionWrap = messageEl.querySelector('.reactions');
  if (!reactionWrap) {
    reactionWrap = document.createElement('div');
    reactionWrap.className = 'reactions';
    messageEl.querySelector('.bubble').appendChild(reactionWrap);
  }

  reactionWrap.innerHTML = '';
  reactions.forEach((reaction) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'reaction-btn';
    btn.textContent = `${reaction.emoji} ${reaction.count}`;
    btn.addEventListener('click', () => socket.emit('add-reaction', { messageId: messageEl.dataset.messageId, emoji: reaction.emoji }));
    reactionWrap.appendChild(btn);
  });
}

function renderMessage(data) {
  const item = document.createElement('div');
  const own = data.socketId === mySocketId;
  item.className = `message ${own ? 'own' : ''}`;
  item.dataset.messageId = data.id;

  const imageHTML = data.type === 'image' && data.imageData
    ? `<img src="${data.imageData}" class="message-image" alt="shared image" />`
    : '';
  const textHTML = data.text ? `<div>${data.text}</div>` : '';

  item.innerHTML = `
    <div class="avatar small">${data.username[0].toUpperCase()}</div>
    <div class="bubble">
      <div class="meta">${data.username} • ${formatTimestamp(data.timestamp)}</div>
      ${textHTML}
      ${imageHTML}
      <div class="reaction-quick">
        ${reactionChoices.map((emoji) => `<button class="reaction-btn" type="button" data-emoji="${emoji}">${emoji}</button>`).join('')}
      </div>
    </div>`;

  item.querySelectorAll('[data-emoji]').forEach((btn) => {
    btn.addEventListener('click', () => {
      socket.emit('add-reaction', { messageId: data.id, emoji: btn.dataset.emoji });
    });
  });

  if (data.reactions?.length) {
    renderReactions(item, data.reactions);
  }

  messageFeed.appendChild(item);
  messageFeed.scrollTop = messageFeed.scrollHeight;
}

function renderSystemMessage(text) {
  const item = document.createElement('div');
  item.className = 'system-message';
  item.textContent = text;
  messageFeed.appendChild(item);
  messageFeed.scrollTop = messageFeed.scrollHeight;
}

function loadRooms(rooms) {
  roomListEl.innerHTML = '';
  const defaultRoomMissing = !rooms.some((room) => room.name === 'Default');
  const renderRooms = defaultRoomMissing ? [{ name: 'Default', count: 0, isPrivate: false }, ...rooms] : rooms;

  renderRooms.forEach((room) => {
    const li = document.createElement('li');
    li.className = `room-item ${room.name === currentRoom ? 'active' : ''}`;
    const lock = room.isPrivate ? '🔒 ' : '';
    li.innerHTML = `<span>${lock}${room.name}</span><span class="badge">${room.count}</span>`;
    li.addEventListener('click', () => joinRoom(room.name, room.isPrivate));
    roomListEl.appendChild(li);
  });
}

function updateRoomUsers(users = []) {
  currentRoomCountEl.textContent = `${users.length} users`;
  roomUsersEl.innerHTML = '';
  users.forEach((user) => {
    const li = document.createElement('li');
    li.innerHTML = `<div class="avatar small">${user.username[0]}</div><span>${user.username}</span><span class="online-dot"></span>`;
    roomUsersEl.appendChild(li);
  });
}

function renderTypingIndicator(username) {
  typingIndicator.textContent = username ? `${username} is typing...` : '';
}

function sendMessage() {
  const text = sanitizeMessage(messageInput.value);
  if (!text) return;

  socket.emit('send-message', { text, room: currentRoom }, (response) => {
    if (response?.ok) {
      messageInput.value = '';
      socket.emit('typing-stop');
    } else if (response?.error) {
      renderSystemMessage(response.error);
    }
  });
}

const debouncedStopTyping = debounce(() => socket.emit('typing-stop'), 700);
messageInput.addEventListener('input', () => {
  socket.emit('typing-start');
  debouncedStopTyping();
});

messageForm.addEventListener('submit', (event) => {
  event.preventDefault();
  sendMessage();
});

document.getElementById('createRoomBtn').addEventListener('click', () => roomModal.classList.remove('hidden'));
document.getElementById('cancelRoom').addEventListener('click', () => roomModal.classList.add('hidden'));

document.getElementById('saveRoom').addEventListener('click', () => {
  const roomName = sanitizeMessage(roomNameInput.value).slice(0, 40);
  const password = sanitizeMessage(roomPasswordInput.value).slice(0, 40);
  const messageTTL = Number(roomTTLSelect.value);

  if (!roomName) {
    renderSystemMessage('Room name is required.');
    return;
  }

  socket.emit('create-room', { name: roomName, password, messageTTL }, (response) => {
    if (!response?.ok) {
      renderSystemMessage(response?.error || 'Failed to create room.');
      return;
    }

    roomModal.classList.add('hidden');
    roomNameInput.value = '';
    roomPasswordInput.value = '';
    roomTTLSelect.value = '0';
    if (password) pendingPasswords.set(roomName, password);
    joinRoom(roomName, Boolean(password));
  });
});

function setupEmojiPicker() {
  emojiPanel.innerHTML = '';
  emojis.forEach((emoji) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = emoji;
    button.addEventListener('click', () => {
      const start = messageInput.selectionStart;
      const end = messageInput.selectionEnd;
      messageInput.setRangeText(emoji, start, end, 'end');
      messageInput.focus();
    });
    emojiPanel.appendChild(button);
  });
}

document.getElementById('emojiToggle').addEventListener('click', () => {
  emojiPanel.classList.toggle('hidden');
});

document.getElementById('fileButton').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  if (!file) return;

  if (file.size > 2 * 1024 * 1024) {
    renderSystemMessage('Image too large. Max 2MB.');
    fileInput.value = '';
    return;
  }

  const reader = new FileReader();
  reader.onload = () => {
    socket.emit('send-file', { dataUrl: reader.result, caption: sanitizeMessage(messageInput.value).slice(0, 200) }, (response) => {
      if (!response?.ok) {
        renderSystemMessage(response?.error || 'Failed to send image.');
      }
    });
    messageInput.value = '';
    fileInput.value = '';
  };
  reader.readAsDataURL(file);
});

socket.on('welcome', (data) => {
  mySocketId = data.socketId;
  myUsername = data.username || myUsername;
  usernameDisplay.textContent = myUsername;
  showNotification('Welcome to Ohub', `You are ${myUsername}`);
  joinRoom('Default');
});

socket.on('online-count', (count) => {
  onlineCountEl.textContent = `Online: ${count}`;
});

socket.on('rooms-list', (rooms) => loadRooms(rooms));
socket.on('rooms-updated', () => socket.emit('get-rooms'));
socket.on('room-created', () => socket.emit('get-rooms'));
socket.on('room-joined', (data) => {
  updateRoomUsers(data.users);
  messageFeed.innerHTML = '';
  data.history?.forEach((message) => renderMessage(message));
});
socket.on('room-users', updateRoomUsers);
socket.on('new-message', renderMessage);
socket.on('messages-reset', () => {
  messageFeed.innerHTML = '';
  renderSystemMessage('Message history reset after 100 messages.');
});
socket.on('system-message', ({ text }) => renderSystemMessage(text));
socket.on('typing-start', ({ username }) => renderTypingIndicator(username));
socket.on('typing-stop', () => renderTypingIndicator(''));
socket.on('rate-limit-hit', ({ message }) => renderSystemMessage(message));
socket.on('join-room-error', ({ error }) => renderSystemMessage(error));
socket.on('message-deleted', ({ messageId }) => {
  const messageEl = messageFeed.querySelector(`[data-message-id="${messageId}"]`);
  if (messageEl) {
    messageEl.remove();
    renderSystemMessage('A disappearing message expired.');
  }
});
socket.on('reaction-updated', ({ messageId, reactions }) => {
  const messageEl = messageFeed.querySelector(`[data-message-id="${messageId}"]`);
  if (messageEl) renderReactions(messageEl, reactions);
});

setupEmojiPicker();
socket.emit('get-rooms');
