const rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

export async function getUserMediaStream() {
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
  } catch (error) {
    throw new Error(`Unable to access media devices: ${error.message}`);
  }
}

export function createPeerConnection({ localStream, onIceCandidate, onTrack }) {
  const peer = new RTCPeerConnection(rtcConfig);
  localStream.getTracks().forEach((track) => peer.addTrack(track, localStream));

  peer.onicecandidate = (event) => {
    if (event.candidate) onIceCandidate(event.candidate);
  };

  peer.ontrack = (event) => {
    const [stream] = event.streams;
    onTrack(stream);
  };

  return peer;
}

export async function createOffer(peer) {
  const offer = await peer.createOffer();
  await peer.setLocalDescription(offer);
  return offer;
}

export async function handleOffer(peer, offer) {
  await peer.setRemoteDescription(new RTCSessionDescription(offer));
  const answer = await peer.createAnswer();
  await peer.setLocalDescription(answer);
  return answer;
}

export async function handleAnswer(peer, answer) {
  await peer.setRemoteDescription(new RTCSessionDescription(answer));
}

export async function handleIceCandidate(peer, candidate) {
  if (!candidate) return;
  await peer.addIceCandidate(new RTCIceCandidate(candidate));
}

export function addRemoteStream(stream, peerId, videoGrid) {
  const existing = document.getElementById(`remote-${peerId}`);
  if (existing) {
    existing.srcObject = stream;
    return existing;
  }
  const video = document.createElement('video');
  video.id = `remote-${peerId}`;
  video.autoplay = true;
  video.playsInline = true;
  video.srcObject = stream;
  videoGrid.appendChild(video);
  return video;
}

export function removeRemoteStream(peerId) {
  document.getElementById(`remote-${peerId}`)?.remove();
}

export function handlePeerDisconnect(peerId, peers) {
  if (peers.has(peerId)) {
    peers.get(peerId).close();
    peers.delete(peerId);
  }
  removeRemoteStream(peerId);
}
