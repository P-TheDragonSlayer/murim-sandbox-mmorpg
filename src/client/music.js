const music = document.getElementById('background-music');
const playlist = [
  '/public/audio/background-ditto.mp3',
  '/public/audio/background-bubblegum.mp3',
  '/public/audio/background-super-shy.mp3',
];
let track = 0;
music.volume = 0.2;
let starting = false;

function startMusic() {
  if (!music.paused || starting) return;
  starting = true;
  const attempt = music.play();
  if (attempt && typeof attempt.then === 'function') {
    attempt.catch(() => {}).finally(() => { starting = false; });
  } else starting = false;
}

// Autoplay may be blocked until the player interacts, especially on mobile.
startMusic();
document.addEventListener('pointerdown', startMusic);
document.addEventListener('keydown', startMusic);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) startMusic();
});
music.addEventListener('ended', () => {
  track = (track + 1) % playlist.length;
  music.src = playlist[track];
  startMusic();
});
