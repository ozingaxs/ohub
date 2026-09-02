const adjectives = ['Silent', 'Clever', 'Rapid', 'Mystic', 'Cosmic', 'Vivid', 'Brave', 'Hidden', 'Lunar', 'Nova', 'Electric', 'Velvet', 'Icy', 'Ember', 'Golden', 'Rusty', 'Wild', 'Swift', 'Calm', 'Neon'];
const animals = ['Lion', 'Fox', 'Wolf', 'Panda', 'Otter', 'Falcon', 'Tiger', 'Dolphin', 'Raven', 'Panther', 'Leopard', 'Eagle', 'Koala', 'Cobra', 'Shark', 'Bear', 'Whale', 'Lynx', 'Moose', 'Jaguar'];

export function generateUsername() {
  const adjective = adjectives[Math.floor(Math.random() * adjectives.length)];
  const animal = animals[Math.floor(Math.random() * animals.length)];
  const number = Math.floor(Math.random() * 900) + 100;
  return `${adjective}${animal}${number}`;
}

export function formatTimestamp(dateInput = new Date()) {
  const date = new Date(dateInput);
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const time = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (date.toDateString() === yesterday.toDateString()) return `Yesterday ${time}`;
  return time;
}

export function generateRoomCode() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

export function sanitizeMessage(text = '') {
  return text.replace(/<[^>]*>/g, '').replace(/[\u0000-\u001F]/g, '').trim().slice(0, 500);
}

export function showNotification(title, body) {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'granted') {
    new Notification(title, { body });
  } else if (Notification.permission !== 'denied') {
    Notification.requestPermission().then((permission) => {
      if (permission === 'granted') new Notification(title, { body });
    });
  }
}

export async function copyToClipboard(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return true;
  }
  const area = document.createElement('textarea');
  area.value = text;
  document.body.appendChild(area);
  area.select();
  document.execCommand('copy');
  area.remove();
  return true;
}

export function debounce(fn, delay = 300) {
  let timeout;
  return (...args) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => fn(...args), delay);
  };
}
