const status = document.getElementById('status');
const progress = document.getElementById('progress');
const fill = document.getElementById('fill');
const btn = document.getElementById('btn');
const device = document.getElementById('device');
const count = document.getElementById('count');

function update(d) {
  if (!d) d = { status: 'idle' };
  status.className = 'status ' + d.status;
  
  if (d.status === 'idle') {
    status.textContent = 'Click to load model';
    btn.disabled = false;
    progress.style.display = 'none';
  } else if (d.status === 'loading') {
    status.textContent = d.message || 'Loading...';
    btn.disabled = true;
    progress.style.display = 'block';
    fill.style.width = (d.progress || 0) + '%';
  } else if (d.status === 'ready') {
    status.textContent = 'Ready! Visit a page with GIFs';
    btn.disabled = true;
    btn.textContent = 'Loaded ✓';
    progress.style.display = 'none';
    device.textContent = (d.device || '?').toUpperCase();
  } else if (d.status === 'error') {
    status.textContent = 'Error: ' + d.message;
    btn.disabled = false;
  }
  count.textContent = d.captionCount || 0;
}

setInterval(async () => {
  const d = await chrome.storage.local.get('modelStatus');
  update(d.modelStatus);
}, 500);

btn.onclick = () => {
  btn.disabled = true;
  chrome.runtime.sendMessage({ target: 'background', type: 'loadModel' });
};