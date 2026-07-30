const express = require('express');
const router = express.Router();
const axios = require('axios');
const xml2js = require('xml2js');
const fs = require('fs');
const path = require('path');
const mass = require('./mass');
const deviceState = require('../device_state');

// --- CONFIGURATION ---
const BOSE_HEADERS = { headers: { 'Content-Type': 'application/xml' } };
const PRESS_DELAY = 450;

// Fresh read every call, not require() — speakers.json changes at runtime (boot-time
// auto-discovery, the Tools page reorder/delete UI), and require()'s module cache
// would otherwise freeze this to whatever was on disk the moment this file was first
// loaded, silently serving stale/template speaker data for the rest of the process.
const speakersPath = path.join(process.cwd(), 'config', 'speakers.json');
function getSpeakers() {
    return JSON.parse(fs.readFileSync(speakersPath, 'utf8'));
}

// Fresh read every call, same reasoning as getSpeakers() — stereo_pairs.json changes
// at runtime via the Tools page. RIGHT channels are never independently addressable
// as a Zone master (no audio of their own, only what LEFT relays to them).
const stereoPairsPath = path.join(process.cwd(), 'config', 'stereo_pairs.json');
function getStereoPairRightIps() {
    try {
        if (!fs.existsSync(stereoPairsPath)) return new Set();
        const pairs = JSON.parse(fs.readFileSync(stereoPairsPath, 'utf8'));
        return new Set(pairs.map(p => p.rightIp));
    } catch (e) {
        return new Set();
    }
}

// SYNC_LOCKS: Prevents multiple "Join" operations from overlapping on the same device.
const SYNC_LOCKS = new Set();
const MAC_CACHE = {};
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// --- HELPER FUNCTIONS ---
async function sendBoseXml(ip, endpoint, xmlData) {
    try {
        await axios.post(`http://${ip}:8090/${endpoint}`, xmlData, BOSE_HEADERS);
        return true;
    } catch (e) {
        return false;
    }
}

// --- RESTORED V2 LOGIC HANDLER ---
async function handleMassTransport(ip, key, currentState) {
    console.log(`[Control] Delegating ${key} to MASS Driver`);
    const isActuallyPlaying = (currentState.playStatus === 'PLAY_STATE' || currentState.playStatus === 'BUFFERING_STATE');

    if (key === 'NEXT_TRACK') { await mass.next(ip); }
    else if (key === 'PREV_TRACK') { await mass.previous(ip); }
    else if (key === 'PLAY_PAUSE') {

        // =======================================================
        // 🎯 AIRPLAY TEARDOWN GUARD: A prior UI pause on this speaker may
        // still be tearing down (12-14s). currentState.playStatus is stale
        // during that window, so isActuallyPlaying can't be trusted — it
        // would re-send PAUSE on what the user means as a resume. Queue the
        // resume instead, same as the physical-remote deferred-resume path.
        // =======================================================
        if (deviceState.isAirplayTearingDown(ip)) {
            console.log(`[Control] AirPlay teardown in progress for ${ip}. Queuing resume for when it lands.`);
            deviceState.setExpectation(ip, 'PLAY_STATUS', 'PLAYING');
            deviceState.armAirplayPendingResume(ip);
            return;
        }

        // =======================================================
        // 🛡️ THE V2 SHIELD: Set the expectation BEFORE executing
        // =======================================================
        const targetState = isActuallyPlaying ? 'NOT_PLAYING' : 'PLAYING';
        console.log(`[Control] Setting STATE Lock for PLAY_PAUSE (Target: ${targetState})`);
        deviceState.setExpectation(ip, 'PLAY_STATUS', targetState);

        if (isActuallyPlaying) {
            console.log(`[Control] Speaker is Playing. Sending explicit PAUSE.`);
            if (currentState.source === 'AIRPLAY') {
                deviceState.setAirplayPauseIntent(ip);
                console.log(`[Control] AirPlay pause intent saved (session will terminate).`);
            }
            await mass.pause(ip);
        } else {
            console.log(`[Control] Speaker is Silent. Sending explicit RESUME/PLAY.`);
            deviceState.clearAirplayPauseIntent(ip);
            await mass.play(ip);
        }
    }
    else if (key === 'STOP') { 
        await mass.stop(ip, "Manual Stop"); 
    }
}

async function handlePowerLogic(ip, currentState) {
    const isStandby = currentState.isStandby;

    // SHATTER ANY PENDING LOCKS:
    // If the user hits power while the UI is locked (e.g., waiting for a preset to load),
    // this instantly unlocks the UI so it can update to the new power state.
    deviceState.clearSession(ip);

    if (isStandby) {
        // Speaker is currently OFF, turning ON.
        // No extra logic needed, the XML power command is sent below.
    } else {
        // Speaker is currently ON, turning OFF.
        
        // 1. If it's a Master, power down the Slaves
        if (currentState.zone && currentState.zone.master === currentState.mac && currentState.zone.member) {
            const members = Array.isArray(currentState.zone.member) ? currentState.zone.member : [currentState.zone.member];
            console.log(`\n[Control] ⏻ Powering Down Group Slaves (${members.length})...`);
            const xml = `<key state="press" sender="Gabbo">POWER</key>`;
            const xmlRel = `<key state="release" sender="Gabbo">POWER</key>`;

            members.forEach(m => {
                const slaveIp = m.ipaddress || m.$.ipaddress;
                if (slaveIp) {
                    sendBoseXml(slaveIp, 'key', xml);
                    sendBoseXml(slaveIp, 'key', xmlRel);
                }
            });
        }
        
		// 2. The 1-2 Punch: Stop active stream, then clear the queue to prevent DLNA ghost-resumes
        if (currentState.massIsActiveDriver) {
            await mass.stop(ip, "Manual Power OFF");
            await mass.clearQueue(ip);
        }
        
        // 3. Clear the green preset highlight
        mass.setPresetMemory(ip, 0);
    }

    console.log(`\n[Control] ⏻ Power Toggle (Current: ${isStandby ? 'Off' : 'On'})`);
    const xml = `<key state="press" sender="Gabbo">POWER</key>`;
    const xmlRel = `<key state="release" sender="Gabbo">POWER</key>`;

    await sendBoseXml(ip, 'key', xml);
    await sendBoseXml(ip, 'key', xmlRel);
}

async function handlePresetSelection(ip, presetNum, currentState) {
    console.log(`[Control] Preset Click: ${presetNum} (Processing...)`);
    if (currentState.isStandby) deviceState.clearSession(ip);

    try {
        const [pRes, npRes] = await Promise.all([
            axios.get(`http://${ip}:8090/presets`),
            axios.get(`http://${ip}:8090/now_playing`).catch(() => ({ data: '' }))
        ]);

        const parser = new xml2js.Parser({ explicitArray: false });
        const pData = await parser.parseStringPromise(pRes.data);

        let liveContext = currentState.track || currentState.stationName || '';
        try {
            if (npRes.data) {
                const npData = await parser.parseStringPromise(npRes.data);
                liveContext = npData.nowPlaying.track || npData.nowPlaying.stationName || '';
            }
        } catch (e) {}

        if (!pData.presets || !pData.presets.preset) return false;

        const allPresets = Array.isArray(pData.presets.preset) ? pData.presets.preset : [pData.presets.preset];
        const match = allPresets.find(p => p.$.id == presetNum);
        if (!match) return false;

        const c = match.ContentItem;
        const xml = `<ContentItem source="${c.$.source}" type="${c.$.type}" location="${c.$.location}" sourceAccount="${c.$.sourceAccount || ''}" isPresetable="true"><itemName>${c.itemName}</itemName><containerArt>${c.containerArt || ''}</containerArt></ContentItem>`;
        await sendBoseXml(ip, 'select', xml);

        mass.setPresetMemory(ip, presetNum);
        const lockContext = currentState.isStandby ? '' : liveContext;
        deviceState.setExpectation(ip, 'PRESET', presetNum, lockContext);
        console.log(`[Control] Preset Expectation Set: ${presetNum} | Context: "${lockContext}"`);

        return true;
    } catch (e) {
        console.log(`Preset Error: ${e.message}`);
        return false;
    }
}

// --- ROUTES ---

// The new source of truth for the UI
router.get('/status', async (req, res) => {
    try {
        // 1. Fetch the real-time WebSocket state for every speaker
        let states = await Promise.all(getSpeakers().map(s => deviceState.get(s)));
        
        // Clone the array so we don't accidentally mutate the backend cache
        states = JSON.parse(JSON.stringify(states));

		// --- NEW: STEREO PAIRING UI INJECTION ---
        try {
            const fs = require('fs');
            const path = require('path');
            const stereoFile = path.join(process.cwd(), 'config', 'stereo_pairs.json');
            
            if (fs.existsSync(stereoFile)) {
                const pairs = JSON.parse(fs.readFileSync(stereoFile, 'utf8'));
                states.forEach(state => {
                    if (!state) return; 
					//SAVE Original Name for Tools
					state.originalName = state.name;
                    const pairAsLeft = pairs.find(p => p.leftIp === state.ip);
                    const pairAsRight = pairs.find(p => p.rightIp === state.ip);

                    if (pairAsLeft) {
                        state.stereoRole = 'LEFT';
                        state.name = `${pairAsLeft.name} (L+R Pair)`; 
                    } else if (pairAsRight) {
                        state.stereoRole = 'RIGHT';
                    }
                });
            }
        } catch (err) {
            console.error("[Control] ⚠️ Error processing stereo_pairs.json:", err.message);
        }


        // 2. MASTER-TO-SLAVE UI INHERITANCE
        // Find all active Master speakers
        const masters = states.filter(s => s.zone && s.zone.master === s.mac);
        
        // Loop through and find the Slaves
        states.forEach(slave => {
            if (slave.zone && slave.zone.master && slave.zone.master !== slave.mac) {
                // Find the Master that controls this Slave
                const master = masters.find(m => m.mac === slave.zone.master);
                if (master) {
                    // Copy the Master's UI data to the Slave so they look perfectly synced!
                    slave.track = master.track;
                    slave.artist = master.artist;
                    slave.album = master.album;
                    slave.art = master.art;
                    slave.playStatus = master.playStatus;
                    slave.mediaType = master.mediaType;
                    slave.stationName = master.stationName;
                    slave.artPlaceholder = master.artPlaceholder;
                }
            }
        });

        res.json(states);
    } catch (e) {
        res.status(500).send(e.message);
    }
});

router.post('/key', async(req, res) => {
    const { ip, key } = req.body;
    const requestIcons = { PLAY_PAUSE: '⏯️ ', NEXT_TRACK: '⏭️ ', PREV_TRACK: '⏮️ ' };
    const requestIcon = key.startsWith('PRESET_') ? '🅿️ ' : (requestIcons[key] || '');
    console.log(`\n[Control] ${requestIcon}Request: ${key} -> ${ip}`);

    const device = getSpeakers().find(s => s.ip === ip);
    const currentState = await deviceState.get(device) || {};
    const transportKeys = ['NEXT_TRACK', 'PREV_TRACK', 'PLAY_PAUSE', 'PAUSE', 'PLAY', 'STOP'];

    if (transportKeys.includes(key) && currentState.massIsActiveDriver) {
        await handleMassTransport(ip, key, currentState);
        return res.send({ success: true });
    }

    if (key === 'POWER') {
        await handlePowerLogic(ip, currentState);
        return res.send({ success: true });
    }

	if (key.startsWith('PRESET_')) {
        const presetNum = parseInt(key.split('_')[1]);
        const isExtended = presetNum > 6;
        const baseNum = isExtended ? Math.floor(presetNum / 11) : presetNum;
        const baseKey = `PRESET_${baseNum}`;

        if (isExtended) {
            const bridge = require('./bridge');
            bridge.setExtendedIntent(ip, baseNum);
        }

        mass.setPresetMemory(ip, presetNum);
        deviceState.setExpectation(ip, 'PRESET', presetNum, '');

        try {
            if (currentState.isStandby) {
                await sendBoseXml(ip, 'key', `<key state="press" sender="Gabbo">POWER</key>`);
                await sendBoseXml(ip, 'key', `<key state="release" sender="Gabbo">POWER</key>`);
                await sleep(1500);
            }

            const press = `<key state="press" sender="Gabbo">${baseKey}</key>`;
            const release = `<key state="release" sender="Gabbo">${baseKey}</key>`;

            const keySuccess = await sendBoseXml(ip, 'key', press);
            await sleep(PRESS_DELAY);
            await sendBoseXml(ip, 'key', release);

            if (keySuccess) return res.send({ success: true });
        } catch (e) {}

        const fallbackSuccess = await handlePresetSelection(ip, baseNum, currentState);
        if (fallbackSuccess) return res.send({ success: true });

        return res.status(500).send({ error: "Preset logic failed" });
    }

    const press = `<key state="press" sender="Gabbo">${key}</key>`;
    const release = `<key state="release" sender="Gabbo">${key}</key>`;
    try {
        await sendBoseXml(ip, 'key', press);
        await sleep(PRESS_DELAY);
        await sendBoseXml(ip, 'key', release);
        res.send({ success: true });
    } catch (e) {
        res.status(500).send(e.message);
    }
});

// On-demand trigger for external callers (e.g. a Home Assistant automation via its
// built-in rest_command: integration) — plays whichever preset+volume is configured
// as this speaker's "On Demand" entry on the Scheduled Play page. Deliberately takes
// no parameters beyond the speaker IP: all configuration stays in the app itself,
// not scattered into external automation configs. Requires an On Demand entry to
// already exist for this speaker (set up via the Tools page, behind the admin PIN
// if one's configured) — this route itself has no auth of its own.
router.post('/ondemand/:speakerIp', async (req, res) => {
    const { speakerIp } = req.params;
    const utils = require('./utils');
    console.log(`\n[Controller] 🔔 On-Demand trigger received for ${speakerIp}`);
    const result = await utils.triggerOnDemand(speakerIp);
    if (result.success) return res.json({ success: true });
    if (result.reason === 'unknown_speaker') {
        return res.status(404).json({ error: `Unknown speaker IP '${speakerIp}' — check it matches a speaker on the Speaker Configuration page.` });
    }
    if (result.reason === 'not_configured') {
        return res.status(404).json({ error: `No On Demand entry configured for ${speakerIp} — set one up on the Scheduled Play page.` });
    }
    return res.status(500).json({ error: 'Failed to trigger playback — check the SoundTouch Hybrid server logs.' });
});

router.post('/volume', async(req, res) => {
    try {
        await sendBoseXml(req.body.ip, 'volume', `<volume>${req.body.value}</volume>`);
        res.send({ success: true });
    } catch (e) {
        res.status(500).send(e.message);
    }
});

router.post('/balance', async(req, res) => {
    const { ip, value } = req.body;
    const normalizedValue = Math.max(-50, Math.min(50, parseInt(value, 10) || 0));
    console.log(`[Control] ⚖️ L/R Balance adjusted for ${ip} to value: ${normalizedValue}`);
    
    try {
        // Public SoundTouch libraries and the Bose WAPI examples use the XML envelope:
        // <balance><targetBalance>...</targetBalance></balance>
        const xmlPayload = `<balance><targetBalance>${normalizedValue}</targetBalance></balance>`;
        
        await sendBoseXml(ip, 'balance', xmlPayload);
        res.send({ success: true });
    } catch (e) {
        console.error(`[Control] ❌ Failed to set balance on ${ip}: ${e.message}`);
        res.status(500).send(e.message);
    }
});

router.post('/join', async(req, res) => {
    const { slaveIp, targetMasterIp } = req.body;
    if (SYNC_LOCKS.has(slaveIp)) return res.send({ success: false, message: "Sync Busy" });
    SYNC_LOCKS.add(slaveIp);

    try {
        const slaveDevice = getSpeakers().find(s => s.ip === slaveIp);
        const slaveState = await deviceState.get(slaveDevice);
        if (!slaveState || slaveState.isStandby) deviceState.clearSession(slaveIp);
    } catch (e) {}

    deviceState.setExpectation(slaveIp, 'JOIN', 'SLAVE');

    let restoreVol = 20;
    try {
        const v = await axios.get(`http://${slaveIp}:8090/volume`);
        const p = new xml2js.Parser({ explicitArray: false });
        const vd = await p.parseStringPromise(v.data);
        restoreVol = parseInt(vd.volume.actualvolume);
    } catch (e) {}

    try {
        let masterIp = null, masterMac = null;
        const speakers = getSpeakers();

        if (targetMasterIp) {
            // User explicitly chose a target from the picker — resolve directly
            const targetDevice = speakers.find(s => s.ip === targetMasterIp);
            if (targetDevice) {
                const targetState = await deviceState.get(targetDevice);
                if (targetState && !targetState.isStandby && targetState.mac) {
                    masterIp = targetMasterIp;
                    masterMac = targetState.mac;
                }
            }
        } else {
            // Auto-pick: find the best eligible master (existing behavior)
            const rightIps = getStereoPairRightIps();
            const candidates = [];
            for (const d of speakers) {
                if (d.ip === slaveIp) continue;
                if (rightIps.has(d.ip)) continue; // RIGHT can't be auto-picked as master
                try {
                    const state = await deviceState.get(d);
                    if (state && !state.isStandby) {
                        const zoneMaster = state.zone ? state.zone.master : null;
                        const myMac = state.mac;
                        if (!zoneMaster || zoneMaster === myMac) {
                            candidates.push({ ...d, mac: myMac, playing: (state.playStatus === 'PLAY_STATE') });
                        }
                    }
                } catch (e) {}
            }
            const playingCandidate = candidates.find(c => c.playing);
            if (playingCandidate) {
                masterIp = playingCandidate.ip;
                masterMac = playingCandidate.mac;
            } else if (candidates.length > 0) {
                masterIp = candidates[0].ip;
                masterMac = candidates[0].mac;
            }
        }

        if (!masterIp) {
            deviceState.clearSession(slaveIp);
            await sendBoseXml(slaveIp, 'key', `<key state="press" sender="Gabbo">POWER</key>`);
            await sleep(PRESS_DELAY);
            await sendBoseXml(slaveIp, 'key', `<key state="release" sender="Gabbo">POWER</key>`);
            return res.send({ success: true, message: "Fallback to Power On" });
        }
		
		// =================================================================================
        // 🔊 AUTO-SYNC SLAVE VOLUME TO MASTER
        // Reads user preferences. If enabled, fetches Master volume and applies it to Slave.
        // =================================================================================
        try {
            const fs = require('fs');
            const path = require('path');
            const settingsPath = path.join(process.cwd(), 'config', 'settings.json');
            const settings = fs.existsSync(settingsPath) ? JSON.parse(fs.readFileSync(settingsPath, 'utf8')) : {};

            if (settings.autoSyncVolume) {
                const mv = await axios.get(`http://${masterIp}:8090/volume`);
                const mp = new xml2js.Parser({ explicitArray: false });
                const mvd = await mp.parseStringPromise(mv.data);
                const masterVol = parseInt(mvd.volume.actualvolume);

                if (masterVol !== restoreVol) {
                    console.log(`[Control] 🔊 Auto-Sync: Matching Slave (${slaveIp}) to Master (${masterIp}) at Vol: ${masterVol}`);
                    restoreVol = masterVol; // Overwrite the slave's original volume
                }
            }
        } catch (e) {
            console.log(`[Control] ⚠️ Auto-Sync failed to read Master Volume. Using Slave's default.`);
        }
        // =================================================================================
				

        let slaveMac = MAC_CACHE[slaveIp];
        if (!slaveMac) {
            const i = await axios.get(`http://${slaveIp}:8090/info`);
            const p = new xml2js.Parser({ explicitArray: false });
            const id = await p.parseStringPromise(i.data);
            slaveMac = id.info.deviceID || id.info.$.deviceID;
        }

        await sendBoseXml(slaveIp, 'key', `<key state="press" sender="Gabbo">POWER</key>`);
        await sleep(PRESS_DELAY);
        await sendBoseXml(slaveIp, 'key', `<key state="release" sender="Gabbo">POWER</key>`);

		// ================================================================================
        // 🎵 NATIVE MULTI-ROOM SYNC (SYNC_TO_ZONE)
        // Sending 'rebroadcastlatencymode' to the Master speaker right before grouping 
        // forces its hardware to use AV-grade kernel timestamping. This locks the internal 
        // clocks of the Master and Slave together, preventing the "hallway echo" effect.
        // =================================================================================
        // Use addZoneSlave when the master already has members (documented Bose spec);
        // setZone for a new group. Both accept the same XML payload.
        const masterDevice = getSpeakers().find(s => s.ip === masterIp);
        const masterState = masterDevice ? await deviceState.get(masterDevice) : null;
        const masterHasSlaves = masterState && masterState.zone && masterState.zone.member &&
            (Array.isArray(masterState.zone.member) ? masterState.zone.member.length > 0 : !!masterState.zone.member);
        const zoneEndpoint = masterHasSlaves ? 'addZoneSlave' : 'setZone';

        setTimeout(() => {
            sendBoseXml(masterIp, 'rebroadcastlatencymode', '<rebroadcastlatencymode mode="SYNC_TO_ZONE"/>');
            const xml = `<zone master="${masterMac}"><member ipaddress="${slaveIp}">${slaveMac}</member></zone>`;
            sendBoseXml(masterIp, zoneEndpoint, xml);
        }, 500);

        setTimeout(() => sendBoseXml(slaveIp, 'volume', `<volume>${restoreVol}</volume>`), 3000);

        res.send({ success: true });
			} catch (err) {
				res.status(500).send({ error: err.message });
			} finally {
				SYNC_LOCKS.delete(slaveIp);
			}
		});

router.post('/zone_volume', async(req, res) => {
    const { masterIp, delta } = req.body;
    try {
        const zRes = await axios.get(`http://${masterIp}:8090/getZone`);
        const parser = new xml2js.Parser({ explicitArray: false });
        const zData = await parser.parseStringPromise(zRes.data);

        const ips = [masterIp];
        if (zData.zone && zData.zone.member) {
            const m = Array.isArray(zData.zone.member) ? zData.zone.member : [zData.zone.member];
            m.forEach(x => ips.push(x.ipaddress || x.$.ipaddress));
        }

        const updates = ips.map(async(ip) => {
            try {
                const vRes = await axios.get(`http://${ip}:8090/volume`);
                const vData = await parser.parseStringPromise(vRes.data);
                let vol = parseInt(vData.volume.actualvolume) + parseInt(delta);
                if (vol > 100) vol = 100;
                if (vol < 0) vol = 0;
                await sendBoseXml(ip, 'volume', `<volume>${vol}</volume>`);
            } catch (e) {}
        });
        await Promise.all(updates);
        res.send({ success: true });
    } catch (e) {
        res.status(500).send(e.message);
    }
});

// =================================================================================
// HEALTH CHECK & AUTO-RECOVERY INTERCEPTOR
// If the UI asks for health and the system is down, check preferences BEFORE 
// telling the UI. If auto-recover is on, aggressively fix it and fake a healthy response.
// =================================================================================
let isAutoRecovering = false; // 🔒  RACE-CONDITION LOCK

router.get('/health', async (req, res) => {
    let isHealthy = mass.getHealth();

    // 1. If it's broken AND and aren't already fixing it
    if (!isHealthy && !isAutoRecovering) {
        try {
            const fs = require('fs');
            const path = require('path');
            const settingsPath = path.join(process.cwd(), 'config', 'settings.json');
            const settings = fs.existsSync(settingsPath) ? JSON.parse(fs.readFileSync(settingsPath, 'utf8')) : {};

            if (settings.autoRestartMass) {
                isAutoRecovering = true; // 🔒 Lock so other tabs don't fire this!
                console.log(`\n[Auto-Recovery] 🚨 Intercepted Health Check: MASS is down. Auto-reloading DLNA & AirPlay...`);
                
                await mass.forceRescan(true, 'dlna');
                await mass.forceRescan(true, 'airplay');
                
                mass.resetHealth();
                isAutoRecovering = false; // 🔓 Unlock
                isHealthy = true; 
            }
        } catch (e) {
            isAutoRecovering = false; // 🔓 Unlock on error
            console.error(`[Auto-Recovery] ⚠️ Failed to read settings or execute recovery: ${e.message}`);
        }
    } 
    // 2. If it's broken BUT currently in the middle of fixing it
    else if (!isHealthy && isAutoRecovering) {
        isHealthy = true; // tell this to duplicate tabs so they don't pop up the red modal
    }

    res.json({ healthy: isHealthy });
});

router.post('/health/reset', (req, res) => { mass.resetHealth(); res.json({ success: true }); });
module.exports = router;