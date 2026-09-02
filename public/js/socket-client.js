export function createSocket(namespace = '/chat') {
  const socket = io(namespace, { transports: ['websocket', 'polling'] });
  const banner = document.getElementById('connectionBanner');

  socket.on('connect', () => {
    if (banner) banner.classList.add('hidden');
  });

  socket.on('disconnect', () => {
    if (banner) {
      banner.textContent = 'Disconnected... attempting reconnect';
      banner.classList.remove('hidden');
    }
  });

  socket.io.on('reconnect', () => {
    if (banner) {
      banner.textContent = 'Reconnected';
      setTimeout(() => banner.classList.add('hidden'), 1200);
    }
  });

  return socket;
}
