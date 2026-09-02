import { createSocket } from './socket-client.js';
import { copyToClipboard, formatTimestamp, generateRoomCode, sanitizeMessage } from './utils.js';
import { addRemoteStream, createOffer, createPeerConnection, getUserMediaStream, handleAnswer, handleIceCandidate, handleOffer, handlePeerDisconnect } from './webrtc.js';

const socket = createSocket('/call');
const params = new URLSearchParams(location.search);
const roomCode = (params.get('room') || generateRoomCode()).toUpperCase();
const peers = new Map();
const participants = new Map();
let localStream;
let isMuted = false;
let isVideoOff = false;
let screenTrack = null;
let callStartedAt = null;

const roomCodeText = document.getElementById('roomCodeText');
const copyRoomBtn = document.getElementById('copyRoomBtn');
const joinCallBtn = document.getElementById('joinCallBtn');
const permissionOverlay = document.getElementById('permissionOverlay');
const localVideo = document.getElementById('localVideo');
const videoGrid = document.getElementById('videoGrid');
const waitingState = document.getElementById('waitingState');
const participantsList = document.getElementById('participantsList');
const callTimer = document.getElementById('callTimer');
const callChatPanel = document.getElementById('callChatPanel');
const callMessages = document.getElementById('callMessages');

roomCodeText.textContent = roomCode;

copyRoomBtn.addEventListener('click', async () => {
  await copyToClipboard(`${location.origin}/call.html?room=${roomCode}`);
  copyRoomBtn.textContent = 'Copied!';
  setTimeout(() => (copyRoomBtn.textContent = 'Copy'), 1000);
});

async function setupLocalMedia() {
  localStream = await getUserMediaStream();
  localVideo.srcObject = localStream;
}

function renderParticipantsList() {
  participantsList.innerHTML = '';
  Array.from(participants.entries()).forEach(([id, data]) => {
    const li = document.createElement('li');
    li.innerHTML = `<div class="avatar small">${(data.name || 'A')[0]}</div><span>${data.name || id.slice(0, 6)}</span><span class="badge">${data.muted ? 'Muted' : 'Live'}</span>`;
    participantsList.appendChild(li);
  });
}

function updateWaitingState() {
  waitingState.classList.toggle('hidden', peers.size > 0);
}

async function initPeer(targetPeerId, initiator = true) {
  if (peers.size >= 4 || peers.has(targetPeerId)) return;

  const peer = createPeerConnection({
    localStream,
    onIceCandidate: (candidate) => socket.emit('webrtc-ice-candidate', { roomId: roomCode, target: targetPeerId, candidate }),
    onTrack: (stream) => addRemoteStream(stream, targetPeerId, videoGrid)
  });

  peers.set(targetPeerId, peer);
  participants.set(targetPeerId, { name: `Anon-${targetPeerId.slice(0, 4)}`, muted: false });
  renderParticipantsList();

  if (initiator) {
    const offer = await createOffer(peer);
    socket.emit('webrtc-offer', { roomId: roomCode, target: targetPeerId, offer });
  }

  updateWaitingState();
}

joinCallBtn.addEventListener('click', async () => {
  try {
    await setupLocalMedia();
    permissionOverlay.classList.add('hidden');
    callStartedAt = Date.now();
    socket.emit('join-call-room', roomCode);
  } catch (error) {
    alert(error.message);
  }
});

socket.on('call-room-joined', async ({ participants: existing }) => {
  for (const participantId of existing) {
    await initPeer(participantId, true);
  }
});

socket.on('peer-joined', async ({ peerId }) => {
  await initPeer(peerId, true);
  socket.emit('call-request', { roomId: roomCode, caller: socket.id });
});

socket.on('peer-left', ({ peerId }) => {
  handlePeerDisconnect(peerId, peers);
  participants.delete(peerId);
  renderParticipantsList();
  updateWaitingState();
});

socket.on('webrtc-offer', async ({ from, offer }) => {
  if (!peers.has(from)) await initPeer(from, false);
  const peer = peers.get(from);
  const answer = await handleOffer(peer, offer);
  socket.emit('webrtc-answer', { roomId: roomCode, target: from, answer });
});

socket.on('webrtc-answer', async ({ from, answer }) => {
  const peer = peers.get(from);
  if (peer) await handleAnswer(peer, answer);
});

socket.on('webrtc-ice-candidate', async ({ from, candidate }) => {
  const peer = peers.get(from);
  if (peer) await handleIceCandidate(peer, candidate);
});

socket.on('mute-toggle', ({ peerId, muted }) => {
  if (participants.has(peerId)) {
    participants.set(peerId, { ...participants.get(peerId), muted });
    renderParticipantsList();
  }
});

socket.on('call-ended', () => {
  hangUp(false);
});

function appendCallMessage(text) {
  const p = document.createElement('p');
  p.textContent = text;
  callMessages.appendChild(p);
  callMessages.scrollTop = callMessages.scrollHeight;
}

document.getElementById('callMessageForm').addEventListener('submit', (event) => {
  event.preventDefault();
  const input = document.getElementById('callMessageInput');
  const text = sanitizeMessage(input.value).slice(0, 300);
  if (!text) return;
  socket.emit('call-chat-message', { roomId: roomCode, text, at: new Date().toISOString() });
  appendCallMessage(`You (${formatTimestamp(new Date())}): ${text}`);
  input.value = '';
});

socket.on('call-chat-message', ({ from, text, at }) => {
  appendCallMessage(`${from.slice(0, 6)} (${formatTimestamp(at)}): ${text}`);
});

function toggleMute() {
  isMuted = !isMuted;
  localStream.getAudioTracks().forEach((track) => (track.enabled = !isMuted));
  document.getElementById('muteBtn').textContent = isMuted ? 'Unmute' : 'Mute';
  socket.emit('mute-toggle', { roomId: roomCode, muted: isMuted });
}

function toggleCamera() {
  isVideoOff = !isVideoOff;
  localStream.getVideoTracks().forEach((track) => (track.enabled = !isVideoOff));
  document.getElementById('cameraBtn').textContent = isVideoOff ? 'Camera On' : 'Camera Off';
  socket.emit('video-toggle', { roomId: roomCode, videoOff: isVideoOff });
}

async function startScreenShare() {
  if (screenTrack) {
    stopScreenShare();
    return;
  }
  const display = await navigator.mediaDevices.getDisplayMedia({ video: true });
  screenTrack = display.getVideoTracks()[0];
  for (const peer of peers.values()) {
    const sender = peer.getSenders().find((s) => s.track && s.track.kind === 'video');
    if (sender) sender.replaceTrack(screenTrack);
  }
  screenTrack.onended = stopScreenShare;
}

function stopScreenShare() {
  if (!screenTrack) return;
  const cameraTrack = localStream.getVideoTracks()[0];
  for (const peer of peers.values()) {
    const sender = peer.getSenders().find((s) => s.track && s.track.kind === 'video');
    if (sender && cameraTrack) sender.replaceTrack(cameraTrack);
  }
  screenTrack.stop();
  screenTrack = null;
}

function hangUp(emit = true) {
  if (emit) socket.emit('call-ended', { roomId: roomCode });
  peers.forEach((peer) => peer.close());
  peers.clear();
  localStream?.getTracks().forEach((track) => track.stop());
  window.location.href = '/';
}

document.getElementById('muteBtn').addEventListener('click', toggleMute);
document.getElementById('cameraBtn').addEventListener('click', toggleCamera);
document.getElementById('screenBtn').addEventListener('click', startScreenShare);
document.getElementById('hangupBtn').addEventListener('click', () => hangUp(true));
document.getElementById('chatToggleBtn').addEventListener('click', () => callChatPanel.classList.toggle('open'));

setInterval(() => {
  if (!callStartedAt) return;
  const elapsed = Math.floor((Date.now() - callStartedAt) / 1000);
  const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
  const ss = String(elapsed % 60).padStart(2, '0');
  callTimer.textContent = `${mm}:${ss}`;
}, 1000);
