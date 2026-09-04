const express = require('express');
const router = express.Router();
const http = require('http');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const mass = require('./mass');
const { powerOffAllSpeakers, findPlayerForIp } = require('./utils');

// Talks to the Home Assistant Supervisor's internal API (only reachable from inside
// HA's own container network, at the special hostname "supervisor"). SUPERVISOR_TOKEN
// is auto-injected by HA into every add-on's environment — never set manually, never
// present unless this app is itself running as an HA add-on.
function supervisorRequest(reqPath, method = 'GET') {
    return new Promise((resolve, reject) => {
        const token = process.env.SUPERVISOR_TOKEN;
        if (!token) {
            return reject(new Error('SUPERVISOR_TOKEN missing.'));
        }
        const req = http.request({
            hostname: 'supervisor',
            path: reqPath,
            method,
            headers: { Authorization: `Bearer ${token}` },
            timeout: 5000,
        }, (res) => {
            let body = '';
            res.on('data', (chunk) => { body += chunk; });
            res.on('end', () => {
                try { resolve(JSON.parse(body)); }
                catch (e) { resolve({}); }
            });
        });
        req.on('error', reject);
        req.end();
    });
}

// Finds the installed Music Assistant add-on's slug dynamically (handles beta/dev/
// nightly channel variants and repo forks) instead of assuming a fixed slug — a given
// HA instance's Music Assistant add-on slug depends on which repository it was installed from.
async function discoverMusicAssistantAppSlug() {
    const payload = await supervisorRequest('/addons');
    const selfPayload = await supervisorRequest('/addons/self/info').catch(() => ({}));
    const apps = payload.data?.addons || payload.addons || [];
    const self = selfPayload.data || selfPayload || {};
    const selfSlug = String(self.slug || '').toLowerCase();

    const candidate = apps.find((app) => {
        const slug = String(app.slug || '').toLowerCase();
        const name = String(app.name || '').toLowerCase();
        if (selfSlug && slug === selfSlug) return false;
        if (slug.includes('bose_soundtouch_hybrid') || name.includes('soundtouch hybrid')) return false;
        return slug === 'music_assistant' ||
            slug.endsWith('_music_assistant') ||
            slug === 'music_assistant_beta' ||
            slug.endsWith('_music_assistant_beta') ||
            slug === 'music_assistant_dev' ||
            slug.endsWith('_music_assistant_dev') ||
            slug === 'music_assistant_nightly' ||
            slug.endsWith('_music_assistant_nightly') ||
            name === 'music assistant' ||
            name.includes('music assistant');
    });
    return candidate ? candidate.slug : null;
}

// Path 1 of the cascade below: this app installed AS an HA add-on, restarting the
// sibling Music Assistant add-on via the Supervisor's own internal API
// (SUPERVISOR_TOKEN, auto-provided, no setup).
async function restartViaSupervisor() {
    const appSlug = await discoverMusicAssistantAppSlug();
    if (!appSlug) {
        throw new Error('Music Assistant was not found via Supervisor.');
    }
    console.log(`[MASS Restart] Trying HA Supervisor restart for "${appSlug}"...`);
    await supervisorRequest(`/addons/${appSlug}/restart`, 'POST');
    console.log(`[MASS Restart] ✓ HA Supervisor: MASS restart command accepted.`);
    return true;
}

// Restart MASS with a three-path cascade:
//   1. Native HA Supervisor — this app running AS an HA add-on; SUPERVISOR_TOKEN is
//                             auto-injected, nothing to configure. Tried first since
//                             its presence is a hard signal of which scenario we're in.
//   2. Docker socket        — works when MASS is on the same Docker host as this app
//   3. HA Supervisor (public API) — MASS is a Home Assistant add-on on a separate VM;
//                             requires HA_TOKEN in .env (long-lived HA token)
// Returns true if any path succeeded, false if all paths failed (non-fatal).
async function restartMassContainer() {
    const containerName = process.env.MASS_CONTAINER_NAME;
    const massIp        = process.env.MASS_IP;
    const haToken       = process.env.HA_TOKEN;
    const haPort        = process.env.HA_PORT;

    // --- Path 1: Native HA Supervisor (this app IS the HA add-on) ---
    if (process.env.SUPERVISOR_TOKEN) {
        try {
            return await restartViaSupervisor();
        } catch (e) {
            console.log(`[MASS Restart] ⚠️  Supervisor restart failed: ${e.message}`);
        }
    }

    if (!containerName) {
        console.log(`[MASS Restart] ⚠️  MASS_CONTAINER_NAME not set in .env — skipping restart.`);
        return false;
    }

    // --- Path 2: Docker socket (MASS co-hosted with this app) ---
    console.log(`[MASS Restart] Trying Docker socket restart for "${containerName}"...`);
    try {
        await new Promise((resolve, reject) => {
            const req = http.request({
                socketPath: '/var/run/docker.sock',
                path: `/v1.41/containers/${containerName}/restart`,
                method: 'POST',
            }, (res) => {
                if (res.statusCode === 204 || res.statusCode === 200) resolve(true);
                else reject(new Error(`Docker API Status: ${res.statusCode}`));
            });
            req.on('error', reject);
            req.end();
        });
        console.log(`[MASS Restart] ✓ Docker socket restart successful.`);
        return true;
    } catch (dockerErr) {
        console.log(`[MASS Restart] ⚠️  Docker socket failed: ${dockerErr.message}`);
    }

    // --- Path 3: HA Supervisor API, public (MASS as HA add-on on a separate VM) ---
    if (haToken && massIp) {
        console.log(`[MASS Restart] Trying HA Supervisor API at ${massIp}:${haPort} ("${containerName}")...`);
        try {
            await axios.post(
                `http://${massIp}:${haPort}/api/services/hassio/addon_restart`,
                { addon: containerName },
                { headers: { 'Authorization': `Bearer ${haToken}`, 'Content-Type': 'application/json' }, timeout: 60000 }
            );
            console.log(`[MASS Restart] ✓ HA Supervisor: MASS restart command accepted.`);
            return true;
        } catch (haErr) {
            const detail = haErr.response ? `HTTP ${haErr.response.status}` : haErr.message;
            console.log(`[MASS Restart] ⚠️  HA Supervisor: MASS restart failed: ${detail}`);
        }
    } else if (!haToken) {
        console.log(`[MASS Restart] ⚠️  HA_TOKEN not set — HA Supervisor path unavailable.`);
        console.log(`[MASS Restart] ⚠️  For HA / separate VM setups, add HA_TOKEN to config/.env.`);
    }

    // --- All paths exhausted ---
    console.log(`[MASS Restart] ⚠️  Could not restart MASS — it will continue running in its current state.`);
    return false;
}

// --- BULLETPROOF HEALTH CHECK ---
async function getMassHealth() {
    const massIp = process.env.MASS_IP;
    const massPort = process.env.MASS_PORT;

    if (!massIp || !massPort) {
        console.log(`[Boot] MASS Health Check Aborted: Missing Config in .env`);
        return { isOnline: false, version: "Unknown" };
    }

    try {
        // Use the explicitly documented unauthenticated /info endpoint
        const infoRes = await axios.get(`http://${massIp}:${massPort}/info`, { timeout: 3500 });
        
        let version = "Running";
        if (infoRes.data) {
            // Extract the version from the JSON response
            version = infoRes.data.server_version || infoRes.data.version || "Running";
        }

        return { isOnline: true, version: version };

    } catch (e) {
        // If we get an HTTP error like 403 or 401, the server is still technically online and responding!
        if (e.response) {
            return { isOnline: true, version: "2.x (Auth Required)" };
        }
        
        // A true network error means the Docker container is completely unreachable
        return { isOnline: false, version: "Offline" };
    }
}


// --- SHARED SINGLE-SPEAKER CONFIG AUDIT HELPER ---
// Reads current MASS player config, diffs against target, and pushes corrections.
// Called by both enforcePlayerConfigs (boot, multi-speaker) and
// enforcePlayerConfigsForSpeaker (late-join, single speaker).
async function auditSpeakerConfig(baseUrl, reqConfig, massPlayers, speaker) {
    const player = findPlayerForIp(massPlayers, speaker.ip);
    if (!player) {
        console.log(`[MASS Utils] ⚠️ ${speaker.name || speaker.ip}: No matching MASS player found. Skipping config audit.`);
        return;
    }

    const configRes = await axios.post(`${baseUrl}/api`, {
        command: "config/players/get", args: { player_id: player.player_id }
    }, reqConfig).catch(() => null);

    if (!configRes?.data?.values) return;
    const currentValues = configRes.data.values;

    const dlnaId     = Object.keys(currentValues).find(k => k.startsWith('uuid:') && k.includes('||protocol||'))?.split('||')[0];
    const airplayId  = Object.keys(currentValues).find(k => k.startsWith('ap')   && k.includes('||protocol||'))?.split('||')[0];
    const sendspinId = Object.keys(currentValues).find(k => k.startsWith('spb_') && k.includes('||protocol||'))?.split('||')[0];

    if (!dlnaId && !airplayId) {
        console.log(`[MASS Utils] ⏭️ ${player.name}: Protocols not yet populated by MA. Skipping — will enforce on next boot.`);
        return;
    }

    const currentPref = currentValues['preferred_output_protocol']?.value || '';

    let activeMode, activeId;
    // 1. If currently set to AirPlay, leave it alone
    if (currentPref.includes(airplayId)) {
        activeMode = 'airplay';
        activeId = airplayId;
    }
    // 2. If currently set to DLNA, leave it alone
    else if (currentPref.includes(dlnaId)) {
        activeMode = 'dlna';
        activeId = dlnaId;
    }
    // 3. Auto, blank, Sendspin, or bogus — force DLNA
    else {
        activeMode = 'dlna';
        activeId = dlnaId;
    }

    const targetConfigs = {
        "power_control": "none",
        "auto_play": false,
        "tts_pre_announce": false,
        "volume_control": dlnaId,
        "mute_control":   dlnaId,
        "play_media_overrides_group": true,
        "preferred_output_protocol": activeId,
        [`${activeId}||protocol||enabled`]: true,
        ...(sendspinId ? { [`${sendspinId}||protocol||enabled`]: false } : {})
    };

    const batchPayload = {};
    for (const [key, targetValue] of Object.entries(targetConfigs)) {
        if (targetValue !== undefined && (!currentValues[key] || currentValues[key].value !== targetValue)) {
            batchPayload[key] = targetValue;
        }
    }

    if (Object.keys(batchPayload).length > 0) {
        console.log(`[MASS Utils] ⚠️ UI drift detected on ${player.name}. Pushing user-facing settings (${activeMode.toUpperCase()})...`);
        if (global.DEBUG_MODE) console.log(`[MASS Utils] Payload: ${JSON.stringify(batchPayload)}`);
        await axios.post(`${baseUrl}/api`, {
            command: "config/players/save", args: { player_id: player.player_id, values: batchPayload }
        }, reqConfig);
    } else {
        console.log(`[MASS Utils] ${player.name} (${activeMode.toUpperCase()}) user-facing config verified.`);
    }
}


// --- DYNAMIC PLAYER CONFIGURATION ENFORCER (BOOT-TIME, MULTI-SPEAKER) ---
// Runs at boot against all speakers found online. Waits up to ~3 minutes for
// MASS to discover them (worst case: 18 attempts x (5s request timeout + 5s
// sleep) — sized for a freshly-restarted MASS still running its own SSDP/DLNA
// player rediscovery, which is slower than a normal healthy REST round-trip),
// then waits 15s for protocol config keys to hydrate.
async function enforcePlayerConfigs(speakers) {
    const baseUrl = `http://${process.env.MASS_IP}:${process.env.MASS_PORT}`;
    console.log(`\n[Boot] ⏳ Waiting up to 3 minutes for Music Assistant to discover speakers...`);

    try {
        const token = await mass.getToken();
        if (!token) throw new Error('getToken() returned null — MASS may be unreachable');
        const reqConfig = { headers: { 'Authorization': `Bearer ${token}` }, timeout: 5000 };

        // --- STAGE 1: Discovery Watchdog ---
        let massPlayers = [];
        let allDiscovered = false;

        for (let attempt = 1; attempt <= 18; attempt++) {
            const { data } = await axios.post(`${baseUrl}/api`, { command: "players/all", args: {} }, reqConfig).catch((e) => {
                console.log(`[MASS Utils] ⚠️ players/all request failed (attempt ${attempt}): ${mass.describeMassAuthError(e)}`);
                return { data: [] };
            });
            massPlayers = data || [];

            allDiscovered = speakers.every(speaker => !!findPlayerForIp(massPlayers, speaker.ip));

            if (allDiscovered) {
                console.log(`[Boot] ✓ All configured speakers discovered by MA network scan.`);
                break;
            }
            await new Promise(resolve => setTimeout(resolve, 5000));
        }

        if (!allDiscovered) console.log(`[Boot] ⚠️ Discovery timeout. Auditing only available speakers.`);

        // Brief settle: MASS marks players discovered before protocol keys are fully hydrated.
        // Without this, config/players/get returns incomplete data for slow-to-respond speakers.
        console.log(`[MASS Utils] ⏳ Waiting 15s for MA to finish loading protocol configs...`);
        await new Promise(resolve => setTimeout(resolve, 15000));

        // --- STAGE 2: Core Configuration Audit ---
        console.log(`[MASS Utils] Auditing user-facing UI configurations...`);
        for (const speaker of speakers) {
            await auditSpeakerConfig(baseUrl, reqConfig, massPlayers, speaker);
        }
    } catch (e) {
        console.error(`[MASS Utils] ❌ Verification failed: ${e.response?.data || e.message}`);
    }
}


// --- LATE-JOIN CONFIGURATION ENFORCER (SINGLE SPEAKER) ---
// Triggered when a speaker that was offline at boot first connects via WebSocket.
// Skips the 60s discovery watchdog — the speaker is already up. Waits 12s for
// MASS to recognize it and hydrate protocol config keys, then runs the same audit.
async function enforcePlayerConfigsForSpeaker(ip) {
    const baseUrl = `http://${process.env.MASS_IP}:${process.env.MASS_PORT}`;
    console.log(`[MASS Utils] Late-join enforcement for ${ip} — waiting 12s for MA to recognize speaker...`);
    await new Promise(resolve => setTimeout(resolve, 12000));

    try {
        const token = await mass.getToken();
        if (!token) throw new Error('getToken() returned null — MASS may be unreachable');
        const reqConfig = { headers: { 'Authorization': `Bearer ${token}` }, timeout: 5000 };

        const { data: massPlayers } = await axios.post(`${baseUrl}/api`, { command: "players/all", args: {} }, reqConfig)
            .catch(() => ({ data: [] }));

        await auditSpeakerConfig(baseUrl, reqConfig, massPlayers || [], { ip, name: ip });
        console.log(`[MASS Utils] ✅ Late-join enforcement complete for ${ip}.`);
    } catch (e) {
        console.error(`[MASS Utils] ❌ Late-join enforcement failed for ${ip}: ${e.response?.data || e.message}`);
    }
}



// Reads speakers.json and runs the full player config audit against MASS.
// Shared by boot sequence, restart_ma, and the manual enforce endpoint.
async function runEnforcePlayerConfigs() {
    const speakersPath = path.join(process.cwd(), 'config', 'speakers.json');
    if (fs.existsSync(speakersPath)) {
        const speakers = JSON.parse(fs.readFileSync(speakersPath, 'utf8'));
        await enforcePlayerConfigs(speakers);
    }
}


// POST /api/admin/restart_ma
router.post('/restart_ma', async (req, res) => {
    console.log(`\n-----------------------------------------------------------------------`);
    console.log(`[Admin] 🧹 Manual MASS restart requested via Web UI...`);
    console.log(`-----------------------------------------------------------------------`);
	
	// 🔥 EXECUTE UNIFIED SMART SHUTDOWN BEFORE KILLING DOCKER
    await powerOffAllSpeakers();
	
	
    
    // 1. Instantly release the UI so the frontend button doesn't freeze
    res.json({ success: true, message: "Restarting Music Assistant..." });

    const restarted = await restartMassContainer();

    if (restarted) {
        if (mass && mass.resetHealth) mass.resetHealth();
        console.log(`[Admin] ⏳ Waiting for Music Assistant to come back online...`);

        let massHealth = { isOnline: false };
        let attempts = 0;
        while (!massHealth.isOnline && attempts < 15) {
            await new Promise(r => setTimeout(r, 2000));
            massHealth = await getMassHealth();
            if (!massHealth.isOnline) { process.stdout.write('.'); attempts++; }
        }
        if (attempts > 0) console.log();

        if (massHealth.isOnline) {
            console.log(`[Admin] ✅ Music Assistant is back online (v${massHealth.version})!`);
            await runEnforcePlayerConfigs();
        } else {
            console.log(`[Admin] ⚠️ MASS restart timeout. It may still be booting in the background.`);
        }
    } else {
        console.log(`[Admin] Running player config enforcement on the running MASS instance...`);
        await runEnforcePlayerConfigs();
    }
});

router.post('/rescan_ma', async (req, res) => {
    try {
        const aggressive = req.body.aggressive || false;
        const provider = req.body.provider || 'dlna'; 

        if (aggressive) {
            console.log(`\n[Admin] Reloading MA ${provider.toUpperCase()} Provider...`);
        } else {
            console.log(`\n[Admin] Pinging MA Providers (keep-alive)...`);
        }
        
        const success = await mass.forceRescan(aggressive, provider);
        
        if (success) {
            res.json({ success: true, message: `Recovery command sent to Music Assistant (${provider})` });
        } else {
            res.status(500).json({ error: "Failed to communicate with MA API" });
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});



// POST /api/admin/enforce_player_configs
router.post('/enforce_player_configs', async (req, res) => {
    console.log(`\n[Admin] Manual player config enforcement requested via Web UI...`);
    res.json({ success: true, message: "Enforcing player configs — check logs for progress." });
    runEnforcePlayerConfigs().catch(e => console.error(`[Admin] ❌ Enforce player configs failed: ${e.message}`));
});


module.exports = {
    router,
    restartMassContainer,
    getMassHealth,
    enforcePlayerConfigs,
    enforcePlayerConfigsForSpeaker,
    supervisorRequest
};