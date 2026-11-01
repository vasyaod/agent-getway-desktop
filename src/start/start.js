// The start page: Sign in, and what happened last (signed out, sign-in ended, offline, an error).
// window.getway is preload-start.cjs; it is only there inside the app.
const $ = (id) => document.getElementById(id);
const bridge = window.getway;

function render(s) {
  const msg = $('message');
  msg.hidden = !s.message;
  msg.textContent = s.message || '';
  msg.classList.toggle('error', !!s.error);
  const primary = $('primary');
  const secondary = $('secondary');
  if (s.phase === 'waiting') {
    primary.textContent = 'Waiting for your browser…';
    primary.disabled = true;
    secondary.hidden = false;
  } else if (s.phase === 'finishing') {
    primary.textContent = 'Signing in…';
    primary.disabled = true;
    secondary.hidden = true;
  } else if (s.phase === 'offline') {
    primary.textContent = 'Try again';
    primary.disabled = false;
    secondary.hidden = true;
  } else {
    primary.textContent = 'Sign in';
    primary.disabled = false;
    secondary.hidden = true;
  }
  $('hint').hidden = s.phase === 'offline';
  primary.dataset.action = s.phase === 'offline' ? 'retry' : 'sign-in';
  $('version').textContent = s.version ? `Version ${s.version}` : '';
}

if (bridge) {
  bridge.onStatus(render);
  bridge.status().then(render);
  $('primary').addEventListener('click', () => {
    if ($('primary').dataset.action === 'retry') bridge.retry(); else bridge.signIn();
  });
  $('secondary').addEventListener('click', () => bridge.cancel());
} else {
  render({ phase: 'idle', message: 'Signing in works in the Getway Chat app only.', error: true });
  $('primary').disabled = true;
}
