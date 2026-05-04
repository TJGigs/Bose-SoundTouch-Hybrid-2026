const express = require('express');
const router = express.Router();
const axios = require('axios');
const xml2js = require('xml2js');
const mass = require('./mass');
const utils = require('./utils');
const deviceState = require('../device_state');
const WLA_PRESET_BYPASS = process.env.WLA_PRESET_BYPASS === 'true';

// --- CONFIGURATION ---
const BOSE_HEADERS = { headers: { 'Content-Type': 'application/xml' } };
const PRESS_DELAY = 450;
const SPEAKERS = require('../config/speakers.json');

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
    console.log(`[Control] 📡 Delegating ${key} to MASS Driver`);
    const isActuallyPlaying = (currentState.playStatus === 'PLAY_STATE' || currentState.playStatus === 'BUFFERING_STATE');

    if (key === 'NEXT_TRACK') { await mass.next(ip); }
    else if (key === 'PREV_TRACK') { await mass.previous(ip); }
    else if (key === 'PLAY_PAUSE') {
        
        // =======================================================
        // 🛡️ THE V2 SHIELD: Set the expectation BEFORE executing
        // =======================================================
        const targetState = isActuallyPlaying ? 'NOT_PLAYING' : 'PLAYING';
        console.log(`[Control] 🔒 Setting STATE Lock for PLAY_PAUSE (Target: ${targetState})`);
        deviceState.setExpectation(ip, 'PLAY_STATUS', targetState);
        
        if (isActuallyPlaying) {
            console.log(`[Control] Hardware is Playing. Sending explicit PAUSE.`);
            await mass.pause(ip);
        } else {
            console.log(`[Control] Hardware is Silent. Sending explicit RESUME/PLAY.`);
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
            console.log(`[Control] ⏻ Powering Down Group Slaves (${members.length})...`);
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
        
        // 2. Stop Music Assistant before the speaker goes offline
        if (currentState.massIsActiveDriver) mass.stop(ip, "Manual Power OFF");
        
        // 3. Clear the green preset highlight
        mass.setPresetMemory(ip, 0);
    }

    console.log(`[Control] ⏻ Power Toggle (Current: ${isStandby ? 'Off' : 'On'})`);
    const xml = `<key state="press" sender="Gabbo">POWER</key>`;
    const xmlRel = `<key state="release" sender="Gabbo">POWER</key>`;

    await sendBoseXml(ip, 'key', xml);
    await sendBoseXml(ip, 'key', xmlRel);
}

async function handlePresetSelection(ip, presetNum, currentState) {
    console.log(`[Control] 🔘 Preset Click: ${presetNum} (Processing...)`);
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
        console.log(`[Control] 🔒 Preset Expectation Set: ${presetNum} | Context: "${lockContext}"`);

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
        let states = await Promise.all(SPEAKERS.map(s => deviceState.get(s)));
        
        // Clone the array so we don't accidentally mutate the backend cache
        states = JSON.parse(JSON.stringify(states));

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
    console.log(`[Control] Request: ${key} -> ${ip}`);

    const device = SPEAKERS.find(s => s.ip === ip);
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
        const isLink = currentState.type && currentState.type.toLowerCase().includes('link');

        if (isLink && WLA_PRESET_BYPASS) {
            const match = utils.getPresetAssignment(ip, presetNum);
            if (match && match.uri) {
                mass.setPresetMemory(ip, presetNum);
                deviceState.setExpectation(ip, 'PRESET', presetNum, '');
                await mass.playMedia(ip, match);
                return res.send({ success: true });
            }
        }

        if (isLink) {
            const success = await handlePresetSelection(ip, presetNum, currentState);
            if (success) return res.send({ success: true });
        }

        mass.setPresetMemory(ip, presetNum);
        deviceState.setExpectation(ip, 'PRESET', presetNum, '');

        try {
            if (currentState.isStandby) {
                await sendBoseXml(ip, 'key', `<key state="press" sender="Gabbo">POWER</key>`);
                await sendBoseXml(ip, 'key', `<key state="release" sender="Gabbo">POWER</key>`);
                await sleep(1500);
            }

            const press = `<key state="press" sender="Gabbo">${key}</key>`;
            const release = `<key state="release" sender="Gabbo">${key}</key>`;

            const keySuccess = await sendBoseXml(ip, 'key', press);
            await sleep(PRESS_DELAY);
            await sendBoseXml(ip, 'key', release);

            if (keySuccess) return res.send({ success: true });
        } catch (e) {}

        const fallbackSuccess = await handlePresetSelection(ip, presetNum, currentState);
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

router.post('/volume', async(req, res) => {
    try {
        await sendBoseXml(req.body.ip, 'volume', `<volume>${req.body.value}</volume>`);
        res.send({ success: true });
    } catch (e) {
        res.status(500).send(e.message);
    }
});

router.post('/play_content', async(req, res) => {
    const { ip, contentItem } = req.body;
    mass.setPresetMemory(ip, 0);
    deviceState.clearSession(ip);

    let xml = `<ContentItem source="${contentItem.source}" type="${contentItem.type}" location="${contentItem.location}" sourceAccount="${contentItem.sourceAccount || ''}" isPresetable="${contentItem.isPresetable || 'true'}"><itemName>${contentItem.itemName}</itemName><containerArt>${contentItem.containerArt || ''}</containerArt></ContentItem>`;

    const success = await sendBoseXml(ip, 'select', xml);
    if (success) {
        deviceState.setExpectation(ip, 'TRACK', null, '');
        res.send({ success: true });
    } else {
        res.status(500).send({ error: "Selection failed" });
    }
});

router.post('/join', async(req, res) => {
    const { slaveIp } = req.body;
    if (SYNC_LOCKS.has(slaveIp)) return res.send({ success: false, message: "Sync Busy" });
    SYNC_LOCKS.add(slaveIp);

    try {
        const slaveDevice = SPEAKERS.find(s => s.ip === slaveIp);
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
        const candidates = [];

        for (const d of SPEAKERS) {
            if (d.ip === slaveIp) continue;
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

        if (!masterIp) {
            deviceState.clearSession(slaveIp);
            await sendBoseXml(slaveIp, 'key', `<key state="press" sender="Gabbo">POWER</key>`);
            await sleep(PRESS_DELAY);
            await sendBoseXml(slaveIp, 'key', `<key state="release" sender="Gabbo">POWER</key>`);
            return res.send({ success: true, message: "Fallback to Power On" });
        }

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

        setTimeout(() => {
            const xml = `<zone master="${masterMac}"><member ipaddress="${slaveIp}">${slaveMac}</member></zone>`;
            sendBoseXml(masterIp, 'setZone', xml);
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

router.get('/health', (req, res) => res.json({ healthy: mass.getHealth() }));
router.post('/health/reset', (req, res) => { mass.resetHealth(); res.json({ success: true }); });

module.exports = router;