// routes/tools.js — Backend for tools.html
const express = require('express');
const router = express.Router();
const net = require('net');
const fs = require('fs');
const path = require('path');
const { executeSmartShutdown, runSpeakerAudit, pushPresetsToSpeaker, updateWatchdogGlobals, fetchSpeakerDeviceId } = require('./utils');
const deviceState = require('../device_state');

const SETTINGS_FILE = path.join(process.cwd(), 'config', 'settings.json');

function getSettings() {
    try {
        if (fs.existsSync(SETTINGS_FILE)) {
            return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
        }
    } catch (e) {
        console.error("[Tools] Error reading settings.json", e);
    }

    // Master Fallback Schema
    return {
        autoResumePreset: false,
        autoRestartMass: false,
        autoSyncVolume: false,
        mobileAutoSortSpeakers: true,
        scheduledSpeakerAudit: true,
        scheduledRestart: false,
        includeReboot: false,
        doubleTapPresets: false,
        presetPreview: true,
        presetWatchdogSpeakers: [],
        speakerBlacklist: [],
        searchMenuOrder: [
            { key: 'global',           name: 'Global',       icon: null,                       enabled: true, sourceType: 'global' },
            { key: 'tunein',           name: 'TuneIn Radio', icon: 'images/TuneIn_icon.png',  enabled: true, sourceType: 'radio'  },
            { key: 'filesystem_local', name: 'Local NAS',    icon: 'images/nas_icon.png',     enabled: true, sourceType: 'music'  }
        ]
    };
}

// --- SETTINGS API ---
router.get('/admin/settings', (req, res) => {
    res.json(getSettings());
});

router.post('/admin/settings', (req, res) => {
    try {
        const currentSettings = getSettings();
        const newSettings = { ...currentSettings, ...req.body };

        // Log watchdog speaker list changes
        const oldSpeakers = Array.isArray(currentSettings.presetWatchdogSpeakers) ? currentSettings.presetWatchdogSpeakers : [];
        const newSpeakers = Array.isArray(newSettings.presetWatchdogSpeakers)     ? newSettings.presetWatchdogSpeakers     : [];
        const added   = newSpeakers.filter(ip => !oldSpeakers.includes(ip));
        const removed = oldSpeakers.filter(ip => !newSpeakers.includes(ip));
        if (added.length) {
            console.log(`[Watchdog] ➕ Speaker(s) added to watchdog: ${added.join(', ')}`);
            const logDir = path.join(process.cwd(), 'config', 'logs');
            for (const ip of added) {
                const logFile = path.join(logDir, `watchdog_${ip.replace(/\./g, '_')}.json`);
                if (fs.existsSync(logFile)) {
                    fs.unlinkSync(logFile);
                    console.log(`[Watchdog] Cleared stale log for ${ip}`);
                }
            }
        }
        if (removed.length) console.log(`[Watchdog] ➖ Speaker(s) removed from watchdog: ${removed.join(', ')}`);

        fs.writeFileSync(SETTINGS_FILE, JSON.stringify(newSettings, null, 4));
        updateWatchdogGlobals();
        if (!newSettings.autoResumePreset) deviceState.clearAllResumeState();
        else if (!newSettings.doubleTapPresets) deviceState.pruneExtendedPresetsFromMemory();
        res.json({ success: true });
    } catch (e) {
        console.error("[Tools] Failed to save settings:", e);
        res.status(500).json({ error: "Failed to save settings.json" });
    }
});

// --- SYSTEM VERSIONS & TIMEZONE ---
router.get('/admin/system_versions', (req, res) => {
    try {
        res.json({
            app: global.APP_VERSION || "????",
            mass: global.MASS_VERSION || "????",
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "????"
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// --- RESTRICTED ACCESS SESSION STORE (cleared on server restart) ---
const ADMIN_SESSIONS = new Set();

router.post('/admin/verify-pin', (req, res) => {
    const { pin, token } = req.body;
    if (!pin || !token) return res.status(400).json({ success: false, error: 'Missing pin or token' });
    const settings = getSettings();
    if (!settings.restrictedMode || !settings.adminPin) return res.json({ success: true });
    if (pin !== settings.adminPin) {
        console.log(`[Tools] Failed admin unlock attempt`);
        return res.json({ success: false });
    }
    ADMIN_SESSIONS.add(token);
    console.log(`[Tools] Admin session unlocked (token: ...${token.slice(-6)})`);
    res.json({ success: true });
});

router.get('/admin/check-session', (req, res) => {
    const { token } = req.query;
    const settings = getSettings();
    if (!settings.restrictedMode) return res.json({ valid: true });
    if (!token) return res.json({ valid: false });
    res.json({ valid: ADMIN_SESSIONS.has(token) });
});

// --- TOGGLE VERBOSE DEBUG ---
router.post('/admin/toggle_debug', (req, res) => {
    global.DEBUG_MODE = req.body.debug === true;
    console.log(`[Tools] Verbose Debug Mode set to: ${global.DEBUG_MODE ? 'ON' : 'OFF'}`);
    res.send({ success: true, debug: global.DEBUG_MODE });
});

// --- GET CURRENT DEBUG STATE ---
router.get('/admin/debug_state', (req, res) => {
    res.json({ debug: global.DEBUG_MODE === true });
});

// --- APP RESTART ---
router.post('/admin/restart', async (req, res) => {
    const { injectTarget, rebootTarget } = req.body;
    try {
        await executeSmartShutdown(injectTarget, rebootTarget);
        res.status(200).json({ success: true });
    } catch (e) {
        console.error(`[Tools] Failed to execute manual system restart: ${e.message}`);
        res.status(500).json({ error: e.message });
    }
});

// --- MANUAL SPEAKER AUDIT TRIGGER ---
router.post('/admin/force_audit', async (req, res) => {
    try {
        console.log(`[Tools] 🛠️ Manual Speaker Audit triggered via API.`);
        runSpeakerAudit(); // Executes asynchronously in the background
        res.status(200).json({ success: true, message: "Audit initiated" });
    } catch (e) {
        console.error(`[Tools] Failed to trigger manual audit: ${e.message}`);
        res.status(500).json({ success: false });
    }
});

// --- PRESET WATCHDOG: MANUAL "PUSH NOW" ---
router.post('/admin/force_preset_push', async (req, res) => {
    const { ip } = req.body;
    if (!ip) return res.status(400).json({ success: false, error: "Missing speaker IP" });
    try {
        console.log(`[Tools] 🛠️ Manual Preset Push triggered via API for ${ip}.`);
        pushPresetsToSpeaker(ip); // Executes asynchronously in the background
        res.status(200).json({ success: true, message: "Preset push initiated" });
    } catch (e) {
        console.error(`[Tools] Failed to trigger manual preset push: ${e.message}`);
        res.status(500).json({ success: false });
    }
});

// --- PRESET WATCHDOG: LOG VIEWER/DOWNLOAD ---
// Serves watchdog_<ip>.json exactly as written to disk — no headers, no
// reformatting — so it reads the same in the UI/download as it does when
// pulled straight from config/logs via SSH/Samba, which HA add-on installs
// typically don't have access to. :ip is only ever used to build the
// filename after being matched against the watchdog list below, so there's
// no path-traversal surface here.
router.get('/watchdog-log/:ip', (req, res) => {
    const { ip } = req.params;
    const settings = getSettings();
    const watched = Array.isArray(settings.presetWatchdogSpeakers) ? settings.presetWatchdogSpeakers : [];
    if (!watched.includes(ip)) {
        return res.status(404).type('text/plain').send(`${ip} is not on the Preset Watchdog list.`);
    }

    const logPath = path.join(process.cwd(), 'config', 'logs', `watchdog_${ip.replace(/\./g, '_')}.json`);
    const watchdogLog = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : null;
    res.type('text/plain').send(watchdogLog || 'No watchdog events logged yet for this speaker.');
});

// ============================================================================
// ST10 STEREO PAIRING API (Configuration)
// ============================================================================
const stereoPairsFile = path.join(process.cwd(), 'config', 'stereo_pairs.json');

const getStereoPairs = () => {
    try {
        if (!fs.existsSync(stereoPairsFile)) return [];
        return JSON.parse(fs.readFileSync(stereoPairsFile, 'utf8'));
    } catch (err) {
        console.error(`[Tools] ❌ Error reading stereo pairs file:`, err.message);
        return [];
    }
};

const saveStereoPairs = (data) => {
    try {
        fs.writeFileSync(stereoPairsFile, JSON.stringify(data, null, 2));
        console.log(`[Tools] Successfully saved ${data.length} stereo pair(s) to disk.`);
    } catch (err) {
        console.error(`[Tools] ❌ Error writing stereo pairs file:`, err.message);
    }
};

// Boot-time stereo pair consistency check.
// 1. Prunes pairs whose speaker IPs are no longer in speakers.json (speaker was deleted).
// 2. Updates stale IPs in pairs that have deviceIds stored, if speakers.json (v4 auto-discovery)
//    has the same device at a new IP. Does nothing in v3 — speakers.json has no deviceId fields.
(function syncStereoPairsOnBoot() {
    try {
        const speakersPath = path.join(process.cwd(), 'config', 'speakers.json');
        if (!fs.existsSync(stereoPairsFile) || !fs.existsSync(speakersPath)) return;

        const speakers = JSON.parse(fs.readFileSync(speakersPath, 'utf8'));
        const knownIps = new Set(speakers.map(s => s.ip));
        const deviceIdToIp = {};
        for (const s of speakers) {
            if (s.deviceId) deviceIdToIp[s.deviceId] = s.ip;
        }

        let pairs = getStereoPairs();
        const before = pairs.length;
        let ipUpdates = 0;

        pairs = pairs.filter(p => {
            const leftOk  = knownIps.has(p.leftIp);
            const rightOk = knownIps.has(p.rightIp);
            if (!leftOk || !rightOk) {
                console.log(`[Tools] 🧹 Removed stereo pair "${p.name}" — speaker ${!leftOk ? p.leftIp : p.rightIp} not in speakers.json.`);
                return false;
            }
            return true;
        });

        for (const p of pairs) {
            if (p.leftDeviceId && deviceIdToIp[p.leftDeviceId] && deviceIdToIp[p.leftDeviceId] !== p.leftIp) {
                console.log(`[Tools] Stereo pair "${p.name}": left IP updated ${p.leftIp} → ${deviceIdToIp[p.leftDeviceId]}`);
                p.leftIp = deviceIdToIp[p.leftDeviceId];
                ipUpdates++;
            }
            if (p.rightDeviceId && deviceIdToIp[p.rightDeviceId] && deviceIdToIp[p.rightDeviceId] !== p.rightIp) {
                console.log(`[Tools] Stereo pair "${p.name}": right IP updated ${p.rightIp} → ${deviceIdToIp[p.rightDeviceId]}`);
                p.rightIp = deviceIdToIp[p.rightDeviceId];
                ipUpdates++;
            }
        }

        if (pairs.length < before || ipUpdates > 0) saveStereoPairs(pairs);
    } catch (e) {
        console.error('[Tools] ⚠️ Stereo pair boot sync error:', e.message);
    }
})();

router.get('/admin/stereo-pairs', (req, res) => {
    if (global.DEBUG_MODE) {
        console.log(`[Tools] Fetching active stereo pairs...`);
    }
    res.json(getStereoPairs());
});

router.post('/admin/stereo-pairs', async (req, res) => {
    const { leftIp, rightIp, name } = req.body;
    console.log(`[Tools] ➕ Creating new stereo pair: "${name}" (L: ${leftIp} | R: ${rightIp})`);

    const [leftDeviceId, rightDeviceId] = await Promise.all([
        fetchSpeakerDeviceId(leftIp),
        fetchSpeakerDeviceId(rightIp)
    ]);

    if (leftDeviceId)  console.log(`[Tools] Left deviceId stored: ${leftDeviceId}`);
    else               console.log(`[Tools] ⚠️ Could not fetch deviceId for ${leftIp} — pair created without it.`);
    if (rightDeviceId) console.log(`[Tools] Right deviceId stored: ${rightDeviceId}`);
    else               console.log(`[Tools] ⚠️ Could not fetch deviceId for ${rightIp} — pair created without it.`);

    const pairs = getStereoPairs();
    const newPair = {
        id: Date.now().toString(),
        name,
        leftIp,
        rightIp,
        ...(leftDeviceId  && { leftDeviceId  }),
        ...(rightDeviceId && { rightDeviceId }),
        stereoXml: true
    };

    pairs.push(newPair);
    saveStereoPairs(pairs);
    res.json({ success: true, pair: newPair });
});

router.delete('/admin/stereo-pairs/:id', (req, res) => {
    console.log(`[Tools] Deleting stereo pair ID: ${req.params.id}`);
    let pairs = getStereoPairs();
    pairs = pairs.filter(p => p.id !== req.params.id);
    saveStereoPairs(pairs);
    res.json({ success: true });
});

// --- UNIFIED WI-FI PROVISIONING ---
router.post('/admin/set_wifi', async (req, res) => {
    const { ip, ssid, password } = req.body;
    console.log(`[Tools] Sending Wi-Fi Provisioning to ${ip}... (SSID: ${ssid})`);

    const isUsb = (ip === "203.0.113.1" || ip === "192.168.1.1");
    let hasResponded = false;
    const client = new net.Socket();

    client.on('error', (err) => {
        console.log(`[Tools] Telnet error on ${ip}: ${err.message}`);
        if (!hasResponded) {
            res.status(500).send({ error: `Telnet Error: ${err.message}` });
            hasResponded = true;
        }
    });

    if (isUsb) {
        // ==========================================
        // PATH A: USB CONNECTION (Verified)
        // ==========================================
        let outputBuffer = "";

        client.on('data', (data) => {
            outputBuffer += data.toString();

            // Wait until the speaker prints the </WiFiProfiles> closing tag
            if (outputBuffer.includes('</WiFiProfiles>')) {
                if (outputBuffer.includes(`SSID="${ssid}"`)) {
                    console.log(`[Tools] ✅ USB Setup Verified: Profile saved! Waiting for UI to trigger reboot...`);
                    if (!hasResponded) {
                        res.send({ success: true });
                        hasResponded = true;
                    }
                } else {
                    console.log(`[Tools] ❌ USB Setup Failed: SSID not found in memory.`);
                    if (!hasResponded) {
                        res.status(500).send({ error: "Wi-Fi profile did not save to the speaker." });
                        hasResponded = true;
                    }
                }
                setTimeout(() => client.destroy(), 500);
            }
        });

        client.connect(17000, ip, () => {
            console.log(`[Tools] Connected to ${ip}:17000 (USB) - Pushing and Verifying...`);
            const tapCommands = `async_responses on\r\nnetwork wifi profiles clear\r\nnetwork wifi profiles add ${ssid} wpa_or_wpa2 ${password}\r\nnetwork wifi profiles info\r\n`;
            client.write(tapCommands);

            setTimeout(() => {
                if (!hasResponded) {
                    res.status(500).send({ error: "Verification timed out. Check speaker." });
                    hasResponded = true;
                    client.destroy();
                }
            }, 5000);
        });
    } else {
        // ==========================================
        // PATH B: NETWORK CONNECTION (Network Switch)
        // No 90s DLNA reload: speaker is switching Wi-Fi networks.
        // MASS will rediscover it naturally once it comes back on the new network.
        // ==========================================
        client.connect(17000, ip, () => {
            console.log(`[Tools] Connected to ${ip}:17000 (Network) - Executing Clean Wi-Fi Switch...`);

            // 1. Wipe the flash memory
            client.write('network wifi profiles clear\r\n');
            console.log(`[Tools] Sent 'clear'. Waiting 3 seconds...`);

            setTimeout(() => {
                // 2. Inject the new Wi-Fi credentials
                client.write(`network wifi profiles add "${ssid}" wpa_or_wpa2 "${password}"\r\n`);
                console.log(`[Tools] Sent 'add'. Waiting 12 seconds for NVRAM save...`);

                // 3. Reboot the speaker to apply changes
                setTimeout(() => {
                    client.write('sys reboot\r\n');
                    console.log(`[Tools] Sent 'reboot'. Closing connection.`);

                    if (!hasResponded) {
                        res.send({ success: true });
                        hasResponded = true;
                    }
                    setTimeout(() => client.destroy(), 500);
                }, 12000); // 12-second delay for saving

            }, 3000); // 3-second delay for clearing
        });
    }
});

// --- SPEAKER DISCOVERY ---
router.get('/admin/discover', async (req, res) => {
    try {
        const { discoverSpeakers, getScanTarget, resolveConfiguredIps } = require('./utils');
        if (!process.env.MASS_IP) return res.status(500).json({ error: 'MASS_IP not configured' });
        await resolveConfiguredIps(); // re-resolve in case a configured hostname's IP has changed
        const scanTarget = getScanTarget(); // SCAN_SUBNET override, or MASS_IP-derived /24 — see #143
        console.log(`[Tools] 🔍 Manual speaker discovery triggered on ${scanTarget}`);
        const speakers = await discoverSpeakers(scanTarget);
        console.log(`[Tools] 🔍 Discovery complete — found ${speakers.length} speaker(s).`);
        res.json(speakers);
    } catch (e) {
        console.error(`[Tools] Discovery error: ${e.message}`);
        res.status(500).json({ error: e.message });
    }
});

// --- SPEAKER CONFIG — returns speakers.json content ---
router.get('/admin/v4-speakers', (req, res) => {
    const speakersPath = path.join(process.cwd(), 'config', 'speakers.json');
    try {
        const speakers = fs.existsSync(speakersPath) ? JSON.parse(fs.readFileSync(speakersPath, 'utf8')) : [];
        res.json({ enabled: true, speakers });
    } catch (e) {
        res.json({ enabled: true, speakers: [] });
    }
});

// --- SAVE SPEAKER ORDER — position only, no adds/removes here ---
router.post('/admin/speakers-order', (req, res) => {
    const { speakers } = req.body;
    if (!Array.isArray(speakers)) return res.status(400).json({ error: 'speakers must be an array' });
    try {
        const speakersPath = path.join(process.cwd(), 'config', 'speakers.json');
        fs.writeFileSync(speakersPath, JSON.stringify(speakers, null, 2));
        console.log(`[Tools] 🔃 Saved new speaker display order (${speakers.length} speaker(s)).`);
        res.json({ success: true });
    } catch (e) {
        console.error('[Tools] ❌ Error saving speaker order:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// --- DELETE A CONFIGURED SPEAKER ---
// User-initiated only (the "x" on the Tools page speaker list) — a truly deleted
// speaker should leave no trace anywhere else in config, so this cascades into
// every other file that can reference a speaker by IP. If the speaker is still
// reachable on the network, the next boot's discovery pass will re-add it to
// speakers.json (by design — this deletes config, not the physical speaker).
router.delete('/admin/speakers/:ip', (req, res) => {
    const ip = req.params.ip;
    const shouldBlacklist = req.body && req.body.blacklist === true;
    try {
        const speakersPath = path.join(process.cwd(), 'config', 'speakers.json');
        if (!fs.existsSync(speakersPath)) return res.status(404).json({ error: 'speakers.json not found' });

        let speakers = JSON.parse(fs.readFileSync(speakersPath, 'utf8'));
        const deletedSpeaker = speakers.find(s => s.ip === ip);
        if (!deletedSpeaker) {
            return res.status(404).json({ error: `No speaker with IP ${ip} found` });
        }
        speakers = speakers.filter(s => s.ip !== ip);
        fs.writeFileSync(speakersPath, JSON.stringify(speakers, null, 2));
        console.log(`[Tools] 🗑️ Deleted speaker ${ip} from speakers.json`);

        // Cascade: library.json preset assignments for this speaker
        const libraryPath = path.join(process.cwd(), 'config', 'library.json');
        if (fs.existsSync(libraryPath)) {
            let lib = JSON.parse(fs.readFileSync(libraryPath, 'utf8'));
            const before = lib.length;
            lib = lib.filter(item => !(item.slot > 0 && item.speakerIp === ip));
            if (lib.length !== before) {
                fs.writeFileSync(libraryPath, JSON.stringify(lib, null, 2));
                console.log(`[Tools] 🗑️ Removed ${before - lib.length} preset assignment(s) for ${ip} from library.json`);
            }
        }

        // Cascade: settings.json — scheduled events, power off timers + preset watchdog list
        const settings = getSettings();
        let settingsChanged = false;

        if (Array.isArray(settings.scheduledEvents)) {
            const before = settings.scheduledEvents.length;
            settings.scheduledEvents = settings.scheduledEvents.filter(e => e.speakerIp !== ip);
            if (settings.scheduledEvents.length !== before) {
                console.log(`[Tools] 🗑️ Removed ${before - settings.scheduledEvents.length} scheduled event(s) for ${ip}`);
                settingsChanged = true;
            }
        }
        if (Array.isArray(settings.powerOffTimers)) {
            const before = settings.powerOffTimers.length;
            settings.powerOffTimers = settings.powerOffTimers.filter(t => t.speakerIp !== ip);
            if (settings.powerOffTimers.length !== before) {
                console.log(`[Tools] 🗑️ Removed ${before - settings.powerOffTimers.length} power off timer(s) for ${ip}`);
                settingsChanged = true;
            }
        }
        if (Array.isArray(settings.presetWatchdogSpeakers) && settings.presetWatchdogSpeakers.includes(ip)) {
            settings.presetWatchdogSpeakers = settings.presetWatchdogSpeakers.filter(wip => wip !== ip);
            console.log(`[Tools] 🗑️ Removed ${ip} from preset watchdog list`);
            settingsChanged = true;
        }
        if (shouldBlacklist) {
            if (!Array.isArray(settings.speakerBlacklist)) settings.speakerBlacklist = [];
            if (!settings.speakerBlacklist.some(b => (deletedSpeaker.deviceId && b.deviceId === deletedSpeaker.deviceId) || b.ip === deletedSpeaker.ip)) {
                settings.speakerBlacklist.push({
                    deviceId: deletedSpeaker.deviceId || null,
                    name: deletedSpeaker.name,
                    ip: deletedSpeaker.ip
                });
                console.log(`[Tools] 🚫 Blacklisted ${deletedSpeaker.name} (deviceId: ${deletedSpeaker.deviceId || 'n/a'}) — won't be rediscovered`);
                settingsChanged = true;
            }
        }
        if (settingsChanged) {
            fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 4));
            updateWatchdogGlobals();
        }

        // Cascade: stereo_pairs.json
        let pairs = getStereoPairs();
        const pairsBefore = pairs.length;
        pairs = pairs.filter(p => p.leftIp !== ip && p.rightIp !== ip);
        if (pairs.length !== pairsBefore) {
            saveStereoPairs(pairs);
            console.log(`[Tools] 🗑️ Removed stereo pair referencing ${ip}`);
        }

        res.json({ success: true });
    } catch (e) {
        console.error(`[Tools] ❌ Error deleting speaker ${ip}:`, e.message);
        res.status(500).json({ error: e.message });
    }
});

// --- REMOVE A SPEAKER FROM THE BLACKLIST ---
// deviceId takes priority when present (stable across DHCP changes); falls back
// to ip for entries saved before a deviceId could be resolved.
router.post('/admin/speakers/unblacklist', (req, res) => {
    const { deviceId, ip } = req.body || {};
    if (!deviceId && !ip) return res.status(400).json({ error: 'deviceId or ip required' });
    try {
        const settings = getSettings();
        if (!Array.isArray(settings.speakerBlacklist)) settings.speakerBlacklist = [];
        const before = settings.speakerBlacklist.length;
        settings.speakerBlacklist = settings.speakerBlacklist.filter(b => deviceId ? b.deviceId !== deviceId : b.ip !== ip);
        if (settings.speakerBlacklist.length === before) {
            return res.status(404).json({ error: 'Not found in blacklist' });
        }
        fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 4));
        console.log(`[Tools] ✅ Removed ${deviceId || ip} from speaker blacklist`);
        res.json({ success: true });
    } catch (e) {
        console.error('[Tools] ❌ Error removing from blacklist:', e.message);
        res.status(500).json({ error: e.message });
    }
});

module.exports = { router };
