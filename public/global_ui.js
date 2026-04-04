const boseMassBannerHTML = `
<div id="mass-error-banner">
    <div class="banner-header">
        <span class="banner-title">⚠️ Music Assistant Error</span>
        <button class="banner-close" onclick="dismissMassBanner()">&times;</button>
    </div>
    <div class="banner-body">
        Music Assistant reported a playback failure. How to fix it:
        <ul>
            <li>
                <strong>Invalid Media (Empty album, dead stream, missing file):</strong><br>
                No restart needed. You can <strong>Dismiss</strong> this message. It will also automatically clear the next time you successfully play a valid preset or library item on this same speaker.
            </li>
            <li>
                <strong>Dropped DLNA Socket:</strong><br>
                The connection to the speaker has died. You must click <strong>Restart Service</strong> below to recover.
            </li>
        </ul>
    </div>
    <div class="banner-actions">
        <button class="btn-dismiss" onclick="dismissMassBanner()">Dismiss</button>
        <button class="btn-restart" onclick="restartMassFromBanner(this)">Restart Service</button>
    </div>
</div>
`;

// Inject the banner HTML into the DOM as soon as the page loads
document.addEventListener("DOMContentLoaded", () => {
    document.body.insertAdjacentHTML('afterbegin', boseMassBannerHTML);
    makeBannerDraggable();
});

// FIX: Changed from 'let' to a window property to prevent SyntaxError collisions 
// if old code fragments were accidentally left behind in manager.html
window.isMaRestartingProcess = false;

setInterval(async () => {
    if (window.isMaRestartingProcess) return;
    try {
        const res = await fetch(`/api/health?t=${Date.now()}`, { cache: 'no-store' });
        const h = await res.json();
        const banner = document.getElementById('mass-error-banner');
        
        if (h && h.healthy === false) {
            // FIX: Added 'banner &&' to prevent null reference errors
            if (banner && banner.style.display !== 'flex' && !banner.dataset.dismissed) banner.style.display = 'flex';
        } else {
            if (banner) {
                banner.style.display = 'none';
                banner.dataset.dismissed = "";
            }
        }
    } catch(e) {}
}, 5000);

function makeBannerDraggable() {
    const banner = document.getElementById('mass-error-banner');
    if (!banner) return;
    const header = banner.querySelector('.banner-header');
    if (!header) return;

    header.style.cursor = 'grab';
    let pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;

    header.onmousedown = dragMouseDown; header.ontouchstart = dragTouchStart;

    function prepareDrag() {
        if (banner.style.transform !== 'none') {
            const rect = banner.getBoundingClientRect();
            banner.style.transform = 'none';
            banner.style.left = rect.left + 'px'; banner.style.top = rect.top + 'px'; banner.style.margin = '0'; 
        }
        header.style.cursor = 'grabbing';
    }

    function dragMouseDown(e) { e.preventDefault(); pos3 = e.clientX; pos4 = e.clientY; document.onmouseup = closeDragElement; document.onmousemove = elementDrag; prepareDrag(); }
    function dragTouchStart(e) { const touch = e.touches[0]; pos3 = touch.clientX; pos4 = touch.clientY; document.ontouchend = closeDragElement; document.ontouchmove = elementTouchDrag; prepareDrag(); }
    function elementDrag(e) { e.preventDefault(); pos1 = pos3 - e.clientX; pos2 = pos4 - e.clientY; pos3 = e.clientX; pos4 = e.clientY; banner.style.top = (banner.offsetTop - pos2) + "px"; banner.style.left = (banner.offsetLeft - pos1) + "px"; }
    function elementTouchDrag(e) { const touch = e.touches[0]; pos1 = pos3 - touch.clientX; pos2 = pos4 - touch.clientY; pos3 = touch.clientX; pos4 = touch.clientY; banner.style.top = (banner.offsetTop - pos2) + "px"; banner.style.left = (banner.offsetLeft - pos1) + "px"; }
    function closeDragElement() { document.onmouseup = null; document.onmousemove = null; document.ontouchend = null; document.ontouchmove = null; header.style.cursor = 'grab'; }
}

async function dismissMassBanner() {
    const banner = document.getElementById('mass-error-banner');
    if(banner) {
        banner.style.display = 'none'; banner.dataset.dismissed = "true";
        banner.style.transform = ''; banner.style.left = ''; banner.style.top = '';
    }
    try { await fetch('/api/health/reset', { method: 'POST' }); } catch (e) { }
}

async function restartMassFromBanner(btn) {
    btn.innerText = "Restarting... (Wait 60s)"; btn.disabled = true; window.isMaRestartingProcess = true;
    await fetch('/api/admin/restart_ma', { method: 'POST' });
    dismissMassBanner();
    setTimeout(() => { btn.innerText = "Restart Service"; btn.disabled = false; window.isMaRestartingProcess = false; }, 60000); 
}

// --- GLOBAL SYSTEM ACTIONS ---
window.triggerGlobalAllOff = async function() {
    if(!confirm("Turn off ALL speakers?")) return;

    const btns = document.querySelectorAll('.btn-all-off');
    btns.forEach(b => b.style.opacity = '0.5');

    try {
        // 1. Fetch current states to know who is currently ON
        const res = await fetch('/api/status');
        const devices = await res.json();

        // 2. OPTIMISTIC UI (Adapts to current page)
        // -> If user is on control.html
        if (typeof window.isPollingFrozen !== 'undefined') {
            window.isPollingFrozen = true;
        }
        if (window.LockManager && window.currentDevices) {
            window.currentDevices.forEach(d => {
                if (!d.isStandby) window.LockManager.set(d.ip, 'POWER', 'OFF');
            });
        }
        // -> If user is on admin.html
        devices.forEach(d => {
            const pwrBtn = document.getElementById(`pwr-${d.ip}`);
            const modeBadge = document.getElementById(`mode-${d.ip}`);
            if (pwrBtn && !d.isStandby) {
                pwrBtn.className = 'pwr-off'; 
                pwrBtn.innerText = 'OFF';
                if (modeBadge) modeBadge.innerText = '(STANDBY)';
            }
        });

        // 3. FILTER: Command only Masters and Standalone speakers
        const onDevices = devices.filter(d => {
            const isSlave = (d.zone && d.zone.master && d.zone.master !== d.mac);
            return !d.isStandby && !isSlave;
        });

        // 4. Send individual POWER keys
        for (const d of onDevices) {
            await fetch('/api/key', { 
                method: 'POST', 
                headers: {'Content-Type': 'application/json'}, 
                body: JSON.stringify({ ip: d.ip, key: 'POWER' }) 
            });
        }

        // Wait 1.5s for hardware to process (Matches the individual toggle delay)
        await new Promise(r => setTimeout(r, 1500));

        // 5. Unfreeze and Quietly Refresh specific elements
        if (typeof window.isPollingFrozen !== 'undefined') {
            window.isPollingFrozen = false;
        }

        // FIX: Quietly fetch individual states instead of nuking the grid with loadAdmin()
        if (typeof window.fetchDeviceState === 'function') {
            devices.forEach(d => window.fetchDeviceState(d.ip));
        } else if (typeof window.loadStatus === 'function') {
            window.loadStatus();
        }
    } catch (e) {
        console.error("Failed to power off speakers", e);
    } finally {
        btns.forEach(b => b.style.opacity = '1');
    }
};