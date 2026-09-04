const { URL } = require('url'); // Standard Node.js library
const fs = require('fs');
const path = require('path');
const net = require('net');
const dns = require('dns');
const axios = require('axios');
const xml2js = require('xml2js');
const DEFAULT_ICON = "";

const LOG_DIR = path.resolve(process.cwd(), "config", "logs");
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

function localTimestamp(d = new Date()) {
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function buildImageUrl(artPath, provider, uri, proxyId) {
    if (artPath && typeof artPath === 'string' && artPath.startsWith('http') && !artPath.includes('imageproxy')) {
        return artPath;
    }
    // proxy_id is MASS's current image-proxy addressing scheme (replaced the old
    // path+provider+checksum query string, which now 400s). Prefer it whenever MASS
    // supplies one; fall back to path+provider for any image object that doesn't.
    if (proxyId) {
        return `api/manager/proxy_image?mode=id&id=${encodeURIComponent(proxyId)}`;
    }
    if (artPath && provider) {
        return `api/manager/proxy_image?mode=raw&path=${encodeURIComponent(artPath)}&provider=${encodeURIComponent(provider)}`;
    }
    if (uri) {
        return `api/manager/proxy_image?uri=${encodeURIComponent(uri)}`;
    }
    return DEFAULT_ICON;
}

// --- CENTRALIZED IP PARSER ---
function parseIp(input) {
    if (!input)
        return null;
    let str = String(input);

    // 1. Handle UPnP/XML URLs
    if (str.includes("http")) {
        try {
            str = new URL(str).hostname;
        } catch (e) {
            // If URL parsing fails, fall through to regex
        }
    }

    // 2. Handle IPv6 mapped IPv4 (e.g., ::ffff:192.168.1.50)
    str = str.replace('::ffff:', '');

    // 3. Extract pure IPv4 if garbage remains
    const match = str.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
    return match ? match[0] : str;
}

// --- CONFIGURED HOST RESOLUTION (hostname-safe APP_IP/MASS_IP) ---
// APP_IP/MASS_IP are usually numeric, but users can configure a local DNS
// hostname instead (#155). Everywhere those values get baked into a URL sent
// to the speaker (NVRAM injection in preflight.js, preset URLs here, the
// discovery scan's subnet math) needs a real IP — the speaker's own embedded
// firmware can't be trusted to resolve an arbitrary local hostname itself.
// Design: Docs/design_subnet_and_hostname_resolution.md
let _resolvedAppIp = null;
let _resolvedMassIp = null;

// Resolves one configured value if it's a hostname, leaves it alone if it's
// already numeric. Retries on cold-start DNS hiccups (mirrors the discovery
// scan's own cold-start retry pattern), then falls back to the raw value —
// never blocks boot, and never crashes the app — logging clearly either way.
async function _resolveConfiguredHost(raw, label) {
    if (!raw || net.isIP(raw)) return raw;
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const { address } = await dns.promises.lookup(raw);
            console.log(`[Boot] ${label} '${raw}' resolved to ${address}.`);
            return address;
        } catch (e) {
            if (attempt < maxAttempts) {
                console.log(`[Boot] ${label} '${raw}' did not resolve yet (attempt ${attempt}/${maxAttempts}) — retrying in 5s...`);
                await new Promise(r => setTimeout(r, 5000));
            } else {
                console.error(`[Boot] ⚠️ ${label} '${raw}' could not be resolved via DNS after ${maxAttempts} attempts (${e.message}). Falling back to the raw value — speaker-facing URLs and the discovery scan may not work correctly until this resolves.`);
            }
        }
    }
    return raw;
}

// Runs once at boot, and again on each scheduled speaker audit (runSpeakerAudit)
// so a hostname's underlying IP drifting mid-runtime gets caught and re-resolved
// on the same cadence preflight.js already uses to detect other config drift —
// no new schedule invented. Caches results for the sync getResolvedAppIp()/
// getResolvedMassIp() accessors below.
async function resolveConfiguredIps() {
    _resolvedAppIp = await _resolveConfiguredHost(process.env.APP_IP, 'APP_IP');
    _resolvedMassIp = await _resolveConfiguredHost(process.env.MASS_IP, 'MASS_IP');
    return { appIp: _resolvedAppIp, massIp: _resolvedMassIp };
}

// Sync accessors for every call site that builds a speaker-facing URL. Before
// resolveConfiguredIps() has run once (should only happen if something calls
// this ahead of boot's resolution step), falls back to the raw env var —
// identical to today's pre-fix behavior, so this is never worse than what
// exists now, only better once resolution has completed.
function getResolvedAppIp() {
    return _resolvedAppIp || process.env.APP_IP;
}
function getResolvedMassIp() {
    return _resolvedMassIp || process.env.MASS_IP;
}

// --- SHARED MASS PLAYER MATCHER ---
// Finds the MASS player object whose device_info.ip_address matches a given
// speaker IP. This is the one thing mass.js's resolvePlayer and
// mass_utils.js's config audit were each separately (and differently)
// implementing — centralized here so there's exactly one place that knows
// how to turn a speaker IP into a MASS player match.
function findPlayerForIp(players, ip) {
    if (!Array.isArray(players) || !ip) return null;
    return players.find(p => parseIp(p.device_info?.ip_address) === ip) || null;
}
// --- SHARED PRESET LOOKUP ---
function getPresetAssignment(ip, slotId) {
    const libPath = path.join(__dirname, '../config/library.json');
    if (!fs.existsSync(libPath))
        return null;

    const library = JSON.parse(fs.readFileSync(libPath));

    let match = library.find(item => item.slot === slotId && item.speakerIp === ip);
    if (!match)
        match = library.find(item => item.slot === slotId && !item.speakerIp);

    return match || null;
}
// --- TEXT SANITIZER ---
// Safely replaces broken Bose encoding diamonds with an 'a' to preserve word structure.
// Music Assistant will instantly overwrite this with the perfect UTF-8 accents anyway!
function scrubText(str) {
    if (!str) return "";
    return str.replace(/[\ufffd]/g, 'a').normalize('NFC');
}

let lastAuditDate = null;
let lastRestartDate = null;
let lastWatchdogRunMs = null;      // set when startScheduler() actually starts the clock
let lastObserveRunMs = null;       // separate 5-min clock for observe mode
let lastObserveHourlyLogMs = null; // hourly "still watching" heartbeat for observe mode
const firedToday = new Set();
const stuckStateStreak = {};       // ip → consecutive 5-min polls seen with PLAY_STATE + INVALID_SOURCE
const powerOffTimerLastOnState = {};  // ip → last observed "is on" bool, for power-on edge detection
const powerOffTimerDeadline = {};     // ip → epoch ms when an armed power off timer should fire

// --- SHARED HYBRID PRESET DEFINITIONS ---
// Single source of truth for what "Hybrid Preset N" is: the URL, the display name.
// Consumed by bose_cloud.js (cloud-delivered presets XML, pulled by the speaker
// during its handshake) and pushPresetsToSpeaker() below (direct local WAPI write).
// Keeping both fed from here means the two delivery paths can never drift apart.
function getHybridPresetDefinitions() {
    const IP = getResolvedAppIp();
    const PORT = process.env.APP_PORT;
    const definitions = [];
    for (let i = 1; i <= 6; i++) {
        definitions.push({
            id: i,
            name: `Hybrid Preset ${i}`,
            url: `http://${IP}:${PORT}/preset/${i}.mp3`
        });
    }
    return definitions;
}

// Synchronous inline check used by the nowSelectionUpdated WebSocket handler in device_state.js.
// Returns true when the ContentItem in the event is one of our own bridge preset URLs, meaning
// the bridge will handle the press via the /preset/:id.mp3 HTTP route — no MASS call needed here.
function isHybridContentItem(source, location) {
    const APP_IP   = getResolvedAppIp();
    const APP_PORT = process.env.APP_PORT;
    return source === 'LOCAL_INTERNET_RADIO' &&
           typeof location === 'string' &&
           location.includes(`${APP_IP}:${APP_PORT}/preset/`);
}

// --- PRESET HEALTH CHECK ---
// speakerHasHybridPresets: confirms slots contain LOCAL_INTERNET_RADIO URLs pointing
// back to this bridge. Returns true on fetch error to avoid false-positive reboots.
async function speakerHasHybridPresets(ip) {
    const APP_IP = getResolvedAppIp();
    const APP_PORT = process.env.APP_PORT;
    try {
        const res = await axios.get(`http://${ip}:8090/presets`, { timeout: 3000 });
        const parser = new xml2js.Parser({ explicitArray: false });
        const data = await parser.parseStringPromise(res.data);
        const presets = data.presets?.preset;
        if (!presets) return false;
        const arr = Array.isArray(presets) ? presets : [presets];
        if (arr.length < 6) return false;
        return arr.every(p =>
            p.ContentItem?.$?.source === 'LOCAL_INTERNET_RADIO' &&
            p.ContentItem?.$?.location?.includes(`${APP_IP}:${APP_PORT}/preset/`)
        );
    } catch (e) {
        return true;
    }
}

// --- PRESET PUSH: Direct WAPI Write (storePreset) ---
// Universal non-destructive preset delivery path. Writes all 6 Hybrid presets
// directly into the speaker's NVRAM via the /storePreset endpoint — no reboot,
// no standby/wake cycle, no playback interruption. Called from:
//   - Pre-Flight Route D (wrong or missing presets, cloud config already correct)
//   - runSpeakerAudit (scheduled nightly audit)
//   - Preset Watchdog Push mode (recurring interval)
//   - Manual "Push Now" button (Tools page)
//   - Cloud handshake recovery (incomplete handshake — presets not injected via account/full)
async function pushPresetsToSpeaker(ip) {
    const definitions = getHybridPresetDefinitions();
    const nowSec = Math.floor(Date.now() / 1000);

    for (const preset of definitions) {
        const body = `<preset id="${preset.id}" createdOn="${nowSec}" updatedOn="${nowSec}">
            <ContentItem source="LOCAL_INTERNET_RADIO" type="stationurl" location="${preset.url}" sourceAccount="" isPresetable="true">
                <itemName>${preset.name}</itemName>
            </ContentItem>
        </preset>`;
        try {
            await axios.post(`http://${ip}:8090/storePreset`, body, {
                headers: { 'Content-Type': 'text/xml' },
                timeout: 3000
            });
        } catch (e) {
            console.error(`[Preset Push] ❌ Failed to push Preset ${preset.id} to ${ip}: ${e.message}`);
        }
    }
    console.log(`[Preset Push] ✅ All 6 presets pushed to ${ip}.`);
}

// --- WATCHDOG OBSERVE: 24-HOUR ROLLING LOG ---
// Appends one entry (JSON object) to config/logs/watchdog_<ip>.json.
// On every write, entries older than 24 hours are pruned so the file self-limits.
function appendWatchdogLog(ip, entry) {
    const { ts: _ignored, ...rest } = entry;
    const stamped = { ts: localTimestamp(), ...rest };
    const logPath = path.join(LOG_DIR, `watchdog_${ip.replace(/\./g, '_')}.json`);
    const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;
    const cutoff = Date.now() - TWENTY_FOUR_HOURS;

    let entries = [];
    try {
        if (fs.existsSync(logPath)) entries = JSON.parse(fs.readFileSync(logPath, 'utf8'));
    } catch (e) {
        entries = [];
    }

    entries.push(stamped);
    entries = entries.filter(e => new Date(e.ts).getTime() > cutoff);

    try {
        fs.writeFileSync(logPath, '[\n  ' + entries.map(e => JSON.stringify(e)).join(',\n  ') + '\n]');
    } catch (e) {
        console.error(`[Watchdog] ❌ Failed to write log for ${ip}:`, e.message);
    }
}

// --- WATCHDOG OBSERVE: 5-MINUTE PRESET SNAPSHOT ---
async function queryPresetsForSpeaker(ip, phase = null) {
    if (!global.WATCHDOG_SPEAKERS?.includes(ip)) return;
    const parser = new xml2js.Parser({ explicitArray: false });
    const entry = { ts: new Date().toISOString(), type: 'preset_snapshot', ...(phase ? { phase } : {}), presets: [] };

    try {
        const res = await axios.get(`http://${ip}:8090/presets`, { timeout: 3000 });
        const data = await parser.parseStringPromise(res.data);
        const raw = data.presets?.preset;
        if (raw) {
            const arr = Array.isArray(raw) ? raw : [raw];
            entry.presets = arr.map(p => ({
                id:       p.$?.id,
                name:     p.ContentItem?.itemName || 'Unknown',
                source:   p.ContentItem?.$?.source || 'Unknown',
                location: p.ContentItem?.$?.location || ''
            }));
        }
    } catch (e) {
        entry.error = e.message;
    }

    appendWatchdogLog(ip, entry);
    if (global.DEBUG_MODE) {
        console.log(`[Watchdog] Preset snapshot for ${ip}${phase ? ' (' + phase + ')' : ''}: ${entry.presets.length} preset(s)${entry.error ? ' — ERROR: ' + entry.error : ''}`);
    }
}

// --- WATCHDOG: SYNC GLOBALS FROM SETTINGS ---
// Called on startup and after every settings save so all modules
// can check global.WATCHDOG_SPEAKERS without disk reads.
function updateWatchdogGlobals() {
    const settingsPath = path.join(process.cwd(), 'config', 'settings.json');
    try {
        const settings = fs.existsSync(settingsPath) ? JSON.parse(fs.readFileSync(settingsPath, 'utf8')) : {};
        global.WATCHDOG_SPEAKERS = Array.isArray(settings.presetWatchdogSpeakers) ? settings.presetWatchdogSpeakers : [];
    } catch (e) {
        console.error('[Watchdog] Failed to sync globals from settings:', e.message);
    }
}

function fmtScheduledTime(h, m) {
    if (h == null) return 'Manual Trigger';
    const ampm = h < 12 ? 'AM' : 'PM';
    const h12  = h % 12 || 12;
    return `${h12}:${String(m ?? 0).padStart(2, '0')} ${ampm}`;
}

async function runSpeakerAudit(hour = null, minute = null) {
    console.log(`\n=======================================================================`);
    console.log(`[Scheduler] 🕒 ${fmtScheduledTime(hour, minute)} Routine: Executing Speaker Preset Audit...`);
    console.log(`=======================================================================`);

    // Re-resolve APP_IP/MASS_IP if either is configured as a hostname, so a
    // changed IP behind a stable hostname gets caught on the same cadence
    // this audit already re-checks everything else — see
    // Docs/design_subnet_and_hostname_resolution.md.
    await resolveConfiguredIps();

    const speakersPath = path.join(process.cwd(), 'config', 'speakers.json');
    const speakers = fs.existsSync(speakersPath) ? JSON.parse(fs.readFileSync(speakersPath, 'utf8')) : [];

    for (const speaker of speakers) {
        try {
            console.log(`[Scheduler] 🔍 Checking presets for ${speaker.name} (${speaker.ip})...`);
            if (!(await speakerHasHybridPresets(speaker.ip))) {
                console.log(`   └─ ⚠️ Hybrid presets missing or stale — pushing directly (no reboot required).`);
                await pushPresetsToSpeaker(speaker.ip);
            } else {
                console.log(`   └─ ✅ Presets intact. Speaker is healthy.`);
            }
        } catch (e) {
            console.log(`   └─ ❌ Failed to reach ${speaker.name}: ${e.message}`);
        }
    }

    console.log(`[Scheduler] ✅ Speaker Preset Audit Complete.\n`);
}

// routes/utils.js — Update this function verbatim
async function runSystemRestart(hour = null, minute = null) {
    console.log(`\n=======================================================================`);
    console.log(`[Scheduler] 🕒 ${fmtScheduledTime(hour, minute)} Routine: Executing Scheduled System Restart...`);
    console.log(`=======================================================================`);
    
    try {
        const settingsPath = path.join(process.cwd(), 'config', 'settings.json');
        const settings = fs.existsSync(settingsPath) ? JSON.parse(fs.readFileSync(settingsPath, 'utf8')) : {};
        
        // Match the checkbox options from the tools UI layout
        const forceInjectTarget = null; 
        const forceRebootTarget = settings.includeReboot ? 'all' : null;
        
        // Fire the unified execution engine using the parameters expected by preflight.runSetup
        await executeSmartShutdown(forceInjectTarget, forceRebootTarget);
    } catch (e) {
        console.error(`[Scheduler] ❌ Scheduled restart script failed: ${e.message}`);
    }
}

function startScheduler() {
    console.log(`[Scheduler] Background automation engine started.`);

    // Preset Watchdog interval starts counting from here — NOT from 0/boot. Pre-Flight
    // already reboots/heals speakers as needed on startup, so re-running this within the
    // first minute of every restart would be redundant. The clock starts only once the
    // app is actually up and the scheduler is live.
    lastWatchdogRunMs      = Date.now();
    lastObserveRunMs       = Date.now();
    lastObserveHourlyLogMs = Date.now();

    // Prime globals so bose_cloud.js middleware has them from the first request.
    updateWatchdogGlobals();

    setInterval(async () => {
        const now = new Date();
        const hours = now.getHours();
        const minutes = now.getMinutes();
        const today = now.toDateString();
        const dayOfWeek = now.getDay(); // 0=Sun..6=Sat, for scheduled-event 'days' filtering below
		
		// ==========================================================
        // 🕒 PERMANENT DEBUG LOGGER (Prints every 60 seconds)
        // ==========================================================
        if (global.DEBUG_MODE) {
            console.log(`[Scheduler-Debug] 🕒 Current Docker Time -> ${hours}:${minutes}`);
        }
        
        const settingsPath = path.join(process.cwd(), 'config', 'settings.json');
        const settings = fs.existsSync(settingsPath) ? JSON.parse(fs.readFileSync(settingsPath, 'utf8')) : {};

        // ====================================================================
        // 🕰️ SCHEDULER CONFIGURATION — read from settings.json (24-hour)
        // ====================================================================
        const AUDIT_HOUR    = settings.scheduledAuditHour   ?? 2;
        const AUDIT_MINUTE  = 0;

        const RESTART_HOUR   = settings.scheduledRestartHour ?? 3;
        const RESTART_MINUTE = 0;
        // ====================================================================
        // 1. SPEAKER AUDIT SEQUENCE
        if (hours === AUDIT_HOUR && minutes === AUDIT_MINUTE && settings.scheduledSpeakerAudit) {
            if (lastAuditDate !== today) {
                lastAuditDate = today;
                await runSpeakerAudit(AUDIT_HOUR, AUDIT_MINUTE);
            }
        }
        // 2. SYSTEM RESTART SEQUENCE
        if (hours === RESTART_HOUR && minutes === RESTART_MINUTE && settings.scheduledRestart) {
            if (lastRestartDate !== today) {
                lastRestartDate = today;
                await runSystemRestart(RESTART_HOUR, RESTART_MINUTE);
            }
        }
        // 3. PRESET WATCHDOG (observe mode — rolling interval, not tied to a fixed hour)
        const watchdogSpeakers = Array.isArray(settings.presetWatchdogSpeakers) ? settings.presetWatchdogSpeakers : [];

        if (watchdogSpeakers.length > 0) {
            // Hourly heartbeat — always visible so you know the watchdog is alive
            if (Date.now() - lastObserveHourlyLogMs >= 60 * 60000) {
                lastObserveHourlyLogMs = Date.now();
                console.log(`[Watchdog] Monitoring ${watchdogSpeakers.length} speaker(s). Querying every 5 min, logging to watchdog_*.json.`);
            }
            // Query every 5 min
            if (Date.now() - lastObserveRunMs >= 5 * 60000) {
                lastObserveRunMs = Date.now();
                if (global.DEBUG_MODE) {
                    console.log(`\n[Scheduler] 🔍 Preset Watchdog: querying ${watchdogSpeakers.length} speaker(s)...`);
                }
                for (const ip of watchdogSpeakers) {
                    await queryPresetsForSpeaker(ip);
                    await checkAndRecoverStuckSpeaker(ip);
                }
            }
        }

        // 4. SCHEDULED EVENTS (Play a preset, or Power Off — same clock-time trigger, different action)
        const scheduledEvents = Array.isArray(settings.scheduledEvents) ? settings.scheduledEvents : [];
        for (const evt of scheduledEvents) {
            if (!evt.speakerIp || evt.hour == null) continue;
            if (evt.action === 'play' && !evt.preset) continue;
            if (evt.enabled === false) continue;
            // evt.days restricts which day-of-week this fires on — omitted means every
            // day. The add-schedule UI only ever offers a value here that doesn't
            // overlap another schedule for the same speaker+action (see tools.html's
            // getAvailableDaysFor), so this is just honoring that at fire time.
            if (evt.days === 'weekday' && (dayOfWeek === 0 || dayOfWeek === 6)) continue;
            if (evt.days === 'weekend' && dayOfWeek >= 1 && dayOfWeek <= 5) continue;
            const evtHour   = parseInt(evt.hour, 10);
            const evtMinute = parseInt(evt.minute ?? 0, 10);
            if (hours !== evtHour || minutes !== evtMinute) continue;
            // Includes hour/minute so a weekday schedule and a weekend schedule for the
            // same speaker/action/preset don't collide in the same day's dedup set —
            // only possible now that more than one schedule per speaker/action can exist.
            const evtKey = `${today}-${evt.speakerIp}-${evt.action}-${evt.preset ?? ''}-${evtHour}:${evtMinute}`;
            if (firedToday.has(evtKey)) continue;
            firedToday.add(evtKey);
			    console.log(`\n=======================================================================`);
            if (evt.action === 'off') {
                console.log(`[Scheduler] Scheduled Off: Speaker ${evt.speakerIp}`);
			    console.log(`=======================================================================`);
                try {
                    await powerOffSpeaker(evt.speakerIp);
                } catch (e) {
                    console.error(`[Scheduler] ❌ Scheduled Off failed (${evt.speakerIp}):`, e.message);
                }
            } else {
                console.log(`[Scheduler] Scheduled Play: Speaker ${evt.speakerIp} Preset ${evt.preset}`);
			    console.log(`=======================================================================`);
                try {
                    await firePlayEvent(evt);
                } catch (e) {
                    console.error(`[Scheduler] ❌ Scheduled Play failed (${evt.speakerIp} P${evt.preset}):`, e.message);
                }
            }
        }

        // 5. POWER OFF TIMER WATCHER — duration-from-power-on, not clock time. Edge-detects the
        // STANDBY→on transition each tick (same direct now_playing poll checkAndRecoverStuckSpeaker
        // uses above) and arms a deadline; fires powerOffSpeaker once that deadline passes.
        const powerOffTimers = Array.isArray(settings.powerOffTimers) ? settings.powerOffTimers : [];
        for (const timer of powerOffTimers) {
            if (!timer.speakerIp || !timer.durationMinutes) continue;
            const ip = timer.speakerIp;

            if (timer.enabled === false) {
                delete powerOffTimerDeadline[ip];
                continue;
            }

            let isOn;
            try {
                const statusRes = await axios.get(`http://${ip}:8090/now_playing`, { timeout: 2000 });
                isOn = !statusRes.data.includes('source="STANDBY"');
            } catch (e) {
                continue; // unreachable this tick — leave any armed deadline as-is, retry next tick
            }

            const wasOn = powerOffTimerLastOnState[ip];
            if (isOn && wasOn !== true) {
                powerOffTimerDeadline[ip] = Date.now() + timer.durationMinutes * 60000;
                console.log(`[Scheduler] Power Off Timer armed for ${ip} — powers off in ${timer.durationMinutes} min.`);
            }
            powerOffTimerLastOnState[ip] = isOn;

            if (powerOffTimerDeadline[ip] && Date.now() >= powerOffTimerDeadline[ip]) {
                delete powerOffTimerDeadline[ip];
                console.log(`[Scheduler] Power Off Timer expired for ${ip} — powering off.`);
                try {
                    await powerOffSpeaker(ip);
                    // mode: 'once' timers disable themselves after firing — reusing the same
                    // `enabled` flag the UI's checkbox already controls, so re-arming one is
                    // just re-checking that box. This is the first thing this loop persists
                    // back to settings.json rather than only reading it; `settings` here is
                    // this same tick's freshly-parsed object, so this can't clobber a change
                    // from an earlier point in the same tick — only a near-simultaneous save
                    // from the Tools UI could race it, which is an acceptable, low-stakes edge
                    // case consistent with how settings.json is written elsewhere in the app.
                    if (timer.mode === 'once') {
                        timer.enabled = false;
                        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 4));
                        console.log(`[Scheduler] Power Off Timer for ${ip} was one-time — disabled after firing.`);
                    }
                } catch (e) {
                    console.error(`[Scheduler] ❌ Power Off Timer failed (${ip}):`, e.message);
                }
            }
        }
    }, 60000);
}

// ====================================================================
// --- UNIFIED SMART PRESET ENGINE ---
// ====================================================================
async function executeSmartPreset(ip, id) {
    // Dynamic requires to prevent circular dependency loops
    const mass = require('./mass'); 
    const deviceState = require('../device_state');

    console.log(`\n[Smart Engine] Executing Preset ${id} for ${ip}...`);
    
    // 1. Log the memory (Moved from old Bridge)
    mass.setPresetMemory(ip, id);

    // 2. Fetch the assignment (Moved from old Bridge)
    const match = module.exports.getPresetAssignment(ip, id);
    
    if (match && match.uri) {
        console.log(`   ✅ Triggering via MASS: ${match.name}`);
        
        // 3. Lock the UI to prevent bouncing
        deviceState.setExpectation(ip, 'PRESET', id);
        
        try {
            // Preset's own default Start Volume (discussion #174), if set, is applied
            // inside playMedia() itself — see mass.js — so it fires for every caller of
            // playMedia(), not just the ones that go through this function.
            await mass.playMedia(ip, match);
            return true; // 🌟 Tells bridge.js it was successful!
        } catch (e) {
            console.error(`[Smart Engine] ❌ Failed to play preset: ${e.message}`);
            return false;
        }
    } else {
        console.log(`   ⚠️ No item assigned to Slot ${id}`);
        return false; // 🌟 Tells bridge.js to abort the silence stream!
    }
}

// Shared "play this preset, then apply this optional volume" — used by the scheduler's
// clock-triggered 'play' events above and by triggerOnDemand() below, so the HA webhook
// and Scheduled Play fire identically instead of each having their own copy of this.
async function firePlayEvent(evt) {
    const success = await executeSmartPreset(evt.speakerIp, evt.preset);
    if (success && evt.volume != null) {
        const mass = require('./mass'); // dynamic require — see circular-dependency note elsewhere in this file
        await mass.setVolume(evt.speakerIp, evt.volume);
    }
    return success;
}

// Looks up and fires the configured "On Demand" entry for a speaker — the backend for
// the /api/ondemand/:speakerIp webhook (routes/controller.js), which Home Assistant (or
// anything else on the LAN) can call to trigger playback without going through the
// SoundTouch Hybrid UI. On-demand entries are 'play'-only scheduledEvents with no hour
// set (already skipped by the clock loop above) and an explicit trigger: 'ondemand'
// marker. No preset/volume override accepted here by design — all configuration stays
// in the app's own Scheduled Play page, not scattered into external automation configs.
async function triggerOnDemand(speakerIp) {
    const settingsPath = path.join(process.cwd(), 'config', 'settings.json');
    const speakersPath = path.join(process.cwd(), 'config', 'speakers.json');
    const settings = fs.existsSync(settingsPath) ? JSON.parse(fs.readFileSync(settingsPath, 'utf8')) : {};
    const speakers = fs.existsSync(speakersPath) ? JSON.parse(fs.readFileSync(speakersPath, 'utf8')) : [];

    // Checked separately from "no entry configured" below so a caller gets a distinct
    // answer for "you typo'd/misconfigured the IP" vs. "the IP is right, you just
    // haven't set up an On Demand entry for it yet" — otherwise both look identical.
    if (!speakers.some(s => s.ip === speakerIp)) {
        return { success: false, reason: 'unknown_speaker' };
    }

    const events = Array.isArray(settings.scheduledEvents) ? settings.scheduledEvents : [];
    const evt = events.find(e => e.speakerIp === speakerIp && e.trigger === 'ondemand' && e.enabled !== false);
    if (!evt) return { success: false, reason: 'not_configured' };
    const success = await firePlayEvent(evt);
    return { success, reason: success ? null : 'play_failed' };
}


// --- SMART POWER OFF (single speaker) ---
// Shared by powerOffAllSpeakers, Scheduled Off, and the Power Off Timer watcher.
// Routes through the Smart Controller (not a raw WAPI call) so it inherits
// the same optimistic-execution/self-healing key handling as every other
// POWER command in the app. Returns true only if a power-down was actually sent.
async function powerOffSpeaker(ip, label = ip) {
    const LOCAL_PORT = process.env.APP_PORT || 3000;
    try {
        const statusRes = await axios.get(`http://${ip}:8090/now_playing`, { timeout: 2000 });
        if (statusRes.data.includes('source="STANDBY"')) return false;
        console.log(`   └─ Initiating smart power-down for ${label}...`);
        console.log(`   └─ Routing POWER command through the Smart Controller...`);
        await axios.post(`http://127.0.0.1:${LOCAL_PORT}/api/key`, { ip, key: 'POWER' });
        return true;
    } catch (e) {
        console.error(`   └─ ⚠️ Could not reach ${label} to power it down.`);
        return false;
    }
}

// --- CLEAN SLATE PROTOCOL (SMART POWER OFF ALL) ---
async function powerOffAllSpeakers() {
    const speakersPath = path.join(process.cwd(), 'config', 'speakers.json');
    if (!fs.existsSync(speakersPath)) return;

    const SPEAKERS = JSON.parse(fs.readFileSync(speakersPath, 'utf8'));
    console.log(`\n[Admin] 🧹 Putting all active speakers to sleep for a clean restart...`);

    const sleepTasks = SPEAKERS.map(speaker => powerOffSpeaker(speaker.ip, speaker.name));

    await Promise.allSettled(sleepTasks);
    await new Promise(r => setTimeout(r, 1500));
}

// --- UNIFIED SMART SHUTDOWN ENGINE ---
// Used by both the UI restart button and the background scheduler
async function executeSmartShutdown(injectTarget = null, rebootTarget = null) {
    console.log(`\n=======================================================================`);
    console.log(`🚨 SOUNDTOUCH HYBRID RESTART SEQUENCE INITIATED`);
    if (injectTarget) console.log(`Inject Target: ${injectTarget === 'all' ? 'ALL SPEAKERS' : injectTarget}`);
    if (rebootTarget) console.log(`Reboot Target: ${rebootTarget === 'all' ? 'ALL SPEAKERS' : rebootTarget}`);
    console.log(`=======================================================================`);

    if (injectTarget || rebootTarget) {
        const flagPath = path.join(process.cwd(), 'config', 'force_inject.json');
        fs.writeFileSync(flagPath, JSON.stringify({
            forceMode: true,
            forceInjectTarget: injectTarget,
            forceRebootTarget: rebootTarget,
            debugMode: global.DEBUG_MODE === true
        }));
    }

    try {
        await powerOffAllSpeakers();
    } catch (e) {
        console.error(`[Admin] Could not power off speakers during shutdown:`, e.message);
    }

    setTimeout(async () => {
        // Under HA Supervisor, process.exit(0) alone just leaves the add-on
        // Stopped — Supervisor only auto-restarts on a clean exit if Watchdog
        // is enabled, which isn't the default. SUPERVISOR_TOKEN's presence
        // means we're running as the actual HA add-on, so ask Supervisor to
        // restart us via its own API first. Dynamic require to avoid a
        // circular dependency (mass_utils.js already requires this file at
        // its own top level) — same pattern executeSmartPreset() uses above.
        if (process.env.SUPERVISOR_TOKEN) {
            console.log(`[Admin] Running as HA add-on — requesting restart via Supervisor API...`);
            try {
                const { supervisorRequest } = require('./mass_utils');
                await supervisorRequest('/addons/self/restart', 'POST');
                console.log(`[Admin] ✓ Supervisor restart command accepted.`);
            } catch (e) {
                console.log(`[Admin] ⚠️ Supervisor restart request failed: ${e.message} — exiting process as a fallback.`);
            }
        }

        console.log(`[Admin] Exiting process to apply restart sequence...`);
        process.exit(0);
    }, 1000);
}

// --- 90-SECOND DLNA/AIRPLAY PROVIDER RELOAD TIMER ---
// Called after any mid-session speaker hardware reboot (Type A only).
// Waits for the speaker to fully boot and broadcast UPnP before asking MASS to rediscover it.
function scheduleProviderReload(context) {
    const label = context || 'rebooted speakers';
    console.log(`[Scheduler] ⏱️ Starting 90-second Music Assistant recovery timer for ${label}...`);
    setTimeout(async () => {
        console.log(`[Scheduler] Reloading Music Assistant DLNA & AirPlay providers for ${label}...`);
        try {
            const LOCAL_PORT = process.env.APP_PORT || 8080;
            await axios.post(`http://127.0.0.1:${LOCAL_PORT}/api/admin/rescan_ma`, { aggressive: true, provider: 'dlna' });
            await axios.post(`http://127.0.0.1:${LOCAL_PORT}/api/admin/rescan_ma`, { aggressive: true, provider: 'airplay' });
            console.log(`[Scheduler] ✅ Music Assistant providers successfully reloaded.`);
        } catch (err) {
            console.error(`[Scheduler] ❌ Failed to reload MA providers:`, err.message);
        }
    }, 90000);
}

// --- TARGETED SPEAKER REBOOT (PORT 17000) + PROVIDER RELOAD ---
// Same recipe as the manual admin.js "Telnet Reboot" route (POST /admin/reboot_speaker):
// clean POWER shutdown if the speaker is awake, hard reboot via port 17000, then the
// 90s MASS provider reload so DLNA/AirPlay don't error out on a stale player afterward.
// Unlike executeSmartShutdown, this touches only the one target IP — no other speakers
// are powered off and the app process is not restarted.
async function rebootSpeakerAndReload(ip) {
    const LOCAL_PORT = process.env.APP_PORT;

    try {
        const statusRes = await axios.get(`http://${ip}:8090/now_playing`, { timeout: 2000 });
        if (!statusRes.data.includes('source="STANDBY"')) {
            console.log(`[Watchdog] 💤 Clean shutdown: Routing POWER command for ${ip} before Telnet reboot...`);
            await axios.post(`http://127.0.0.1:${LOCAL_PORT}/api/key`, { ip, key: 'POWER' });
            await new Promise(r => setTimeout(r, 1500));
        }
    } catch (e) {
        console.log(`[Watchdog] ⚠️ Could not verify power state for ${ip} before reboot. Proceeding anyway.`);
    }

    console.log(`[Watchdog] Sending Telnet 'sys reboot' to ${ip} on port 17000...`);
    const client = new net.Socket();
    client.on('error', (err) => console.log(`[Watchdog] Telnet error on ${ip}: ${err.message}`));
    client.connect(17000, ip, () => {
        client.write('sys reboot\r\n');
        setTimeout(() => client.destroy(), 500);
    });

    scheduleProviderReload(ip);
}

// --- STUCK-STATE DETECTION (WATCHDOG-MONITORED SPEAKERS ONLY) ---
// Observed failure mode: speaker reports PLAY_STATE + INVALID_SOURCE (a contradictory
// combo device_state.js already treats as an edge case — normally a transient AirPlay
// teardown artifact) and never recovers. No BMX/power-on cloud event follows, so the
// preset-recovery handshake logic in bose_cloud.js never fires, and /info on 8090 keeps
// answering 200 the whole time, so the offline watchdog in device_state.js never fires
// either. Two consecutive 5-min polls (~5-10 min stuck) triggers a targeted reboot.
async function checkAndRecoverStuckSpeaker(ip) {
    try {
        const res = await axios.get(`http://${ip}:8090/now_playing`, { timeout: 3000 });
        const parser = new xml2js.Parser({ explicitArray: false });
        const data = await parser.parseStringPromise(res.data);
        const np = data.nowPlaying;
        const source = np && np.$ ? np.$.source : null;
        const playStatus = np ? np.playStatus : null;

        if (playStatus === 'PLAY_STATE' && source === 'INVALID_SOURCE') {
            stuckStateStreak[ip] = (stuckStateStreak[ip] || 0) + 1;
            console.log(`[Watchdog] ⚠️ ${ip} reporting PLAY_STATE + INVALID_SOURCE (streak: ${stuckStateStreak[ip]}/2).`);

            if (stuckStateStreak[ip] >= 2) {
                stuckStateStreak[ip] = 0;
                console.log(`[Watchdog] 🚨 ${ip} stuck in PLAY_STATE + INVALID_SOURCE across 2 consecutive polls — forcing targeted reboot...`);
                appendWatchdogLog(ip, {
                    type:   'watchdog_recovery',
                    action: 'stuck_state_reboot',
                    reason: 'PLAY_STATE + INVALID_SOURCE persisted across 2 consecutive 5-min polls'
                });
                await rebootSpeakerAndReload(ip);
            }
        } else {
            stuckStateStreak[ip] = 0;
        }
    } catch (e) {
        // Unreachable speaker is the offline watchdog's job (device_state.js), not this one.
        stuckStateStreak[ip] = 0;
    }
}

// --- SCAN TARGET RESOLUTION (#143, #155) ---
// Expands a CIDR block (e.g. "192.168.4.0/23") into its usable host IPs,
// skipping the network and broadcast addresses. Supports anything from /16
// to /30 — the VLAN-split case in #143 needs at least /23.
function expandCidr(cidr) {
    const [base, prefixStr] = cidr.split('/');
    const prefix = parseInt(prefixStr, 10);
    const octets = base.split('.').map(Number);
    if (octets.length !== 4 || octets.some(o => Number.isNaN(o) || o < 0 || o > 255) ||
        Number.isNaN(prefix) || prefix < 16 || prefix > 30) {
        return null;
    }
    const baseInt = ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
    const hostBits = 32 - prefix;
    const blockSize = Math.pow(2, hostBits);
    const networkInt = (baseInt & (~(blockSize - 1) >>> 0)) >>> 0;

    const ips = [];
    for (let i = 1; i < blockSize - 1; i++) { // skip .0 (network) and the last address (broadcast)
        const ipInt = (networkInt + i) >>> 0;
        ips.push([(ipInt >>> 24) & 255, (ipInt >>> 16) & 255, (ipInt >>> 8) & 255, ipInt & 255].join('.'));
    }
    return ips;
}

// Single source of truth for "what should the discovery scan sweep?" —
// SCAN_SUBNET (a full CIDR, e.g. "192.168.1.0/23") wins if the user set it,
// for the split-VLAN case (#143) where MASS_IP's own subnet genuinely isn't
// the speakers' subnet and can't be inferred. Otherwise falls back to the
// existing MASS_IP-derived /24 — now hostname-safe via getResolvedMassIp().
function getScanTarget() {
    const override = (process.env.SCAN_SUBNET || '').trim();
    if (override) return override;
    const massIp = getResolvedMassIp();
    return massIp ? `${massIp.split('.').slice(0, 3).join('.')}.0/24` : null;
}

// --- SPEAKER DISCOVERY ---
// Scans a CIDR block for Bose SoundTouch speakers via parallel /info requests.
// Accepts a full CIDR ("192.168.4.0/24") from getScanTarget(); a bare
// "a.b.c" prefix is still accepted for backward compatibility and treated as
// a /24. Used both at boot (auto-discovery when speakers.json has template
// data) and by the manual discovery endpoint in tools.js.
async function discoverSpeakers(subnetOrCidr) {
    const parser = new xml2js.Parser({ explicitArray: false });
    const promises = [];

    const targets = subnetOrCidr.includes('/')
        ? expandCidr(subnetOrCidr)
        : Array.from({ length: 254 }, (_, i) => `${subnetOrCidr}.${i + 1}`);

    if (!targets) {
        console.error(`[Discovery] ⚠️ Invalid scan target "${subnetOrCidr}" — skipping scan.`);
        return [];
    }

    for (const ip of targets) {
        promises.push(
            axios.get(`http://${ip}:8090/info`, { timeout: 1500 })
                .then(async res => {
                    try {
                        const data = await parser.parseStringPromise(res.data);
                        if (!data || !data.info) return null;
                        const type = data.info.type ? String(data.info.type) : '';
                        const typeLower = type.toLowerCase();
                        // Lifestyle systems (550/600/650) report <type>Lifestyle</type>, not
                        // "SoundTouch" — same WAPI (SCM component on 8090), just a different
                        // product line label. See #191.
                        if (!typeLower.includes('soundtouch') && !typeLower.includes('lifestyle')) return null;
                        const name = data.info.name ? String(data.info.name) : 'Unknown Speaker';
                        const deviceId = data.info.deviceID ? String(data.info.deviceID)
                                       : (data.info.$ && data.info.$.deviceID) ? String(data.info.$.deviceID)
                                       : null;
                        return { name, ip, deviceId, type };
                    } catch {
                        return null;
                    }
                })
                .catch(() => null)
        );
    }

    const results = await Promise.allSettled(promises);
    return results
        .filter(r => r.status === 'fulfilled' && r.value !== null)
        .map(r => r.value);
}

// Single-attempt deviceId fetch for enriching a stereo pair or library preset
// at creation/save time. No retry — the speaker must be online right then anyway.
// Returns null silently if it doesn't respond.
async function fetchSpeakerDeviceId(ip) {
    try {
        const res = await axios.get(`http://${ip}:8090/info`, { timeout: 3000 });
        const parser = new xml2js.Parser({ explicitArray: false });
        const data = await parser.parseStringPromise(res.data);
        return data?.info?.$?.deviceID || data?.info?.deviceID || null;
    } catch (e) {
        return null;
    }
}

module.exports = {
    DEFAULT_ICON,
    buildImageUrl,
    getPresetAssignment,
    parseIp,
    findPlayerForIp,
    scrubText,
	startScheduler,
	runSpeakerAudit,
	executeSmartPreset,
    powerOffAllSpeakers,
    powerOffSpeaker,
    executeSmartShutdown,
    scheduleProviderReload,
    isHybridContentItem,
    speakerHasHybridPresets,
    getHybridPresetDefinitions,
    pushPresetsToSpeaker,
    appendWatchdogLog,
    queryPresetsForSpeaker,
    updateWatchdogGlobals,
    discoverSpeakers,
    fetchSpeakerDeviceId,
    resolveConfiguredIps,
    getResolvedAppIp,
    getResolvedMassIp,
    getScanTarget,
    expandCidr,
    triggerOnDemand
};
