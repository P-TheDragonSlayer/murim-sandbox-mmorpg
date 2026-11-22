const music = document.getElementById('background-music');
const toggle = document.getElementById('music-toggle');
const preferenceKey = 'murim.music.enabled';

let enabled = true;
try { enabled = localStorage.getItem(preferenceKey) !== 'off'; } catch { /* Storage is optional. */ }
let starting = false;
music.volume = 0.2;

function updateToggle() {
  toggle.textContent = enabled ? '♫ เปิด' : '♫ ปิด';
  toggle.setAttribute('aria-pressed', String(enabled));
  toggle.setAttribute('aria-label', enabled ? 'ปิดเพลงพื้นหลัง' : 'เปิดเพลงพื้นหลัง');
}

function startMusic() {
  if (!enabled || !music.paused || starting) return;
  starting = true;
  // Browsers, especially on phones, require a real user gesture before audio starts.
  const promise = music.play();
  if (promise && typeof promise.then === 'function') promise.catch(() => {}).finally(() => { starting = false; });
  else starting = false;
}

toggle.addEventListener('click', () => {
  enabled = !enabled;
  try { localStorage.setItem(preferenceKey, enabled ? 'on' : 'off'); } catch { /* Storage is optional. */ }
  updateToggle();
  if (enabled) startMusic();
  else music.pause();
});

// Retry on the next gesture if playback was blocked or interrupted. Ignore the
// toggle's pointer/key events so that turning music off never starts it first.
function unlockMusic(event) {
  if (event.target instanceof Element && event.target.closest('#music-toggle')) return;
  startMusic();
}
document.addEventListener('pointerdown', unlockMusic);
document.addEventListener('keydown', unlockMusic);
updateToggle();
