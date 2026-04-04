const express = require('express');
const router = express.Router();
const axios = require('axios');
const xml2js = require('xml2js');
const fs = require('fs');
const path = require('path');
const mass = require('./mass'); 
const utils = require('./utils');
const deviceState = require('../device_state'); 
const WLA_PRESET_BYPASS = process.env.WLA_PRESET_BYPASS !== 'true';

// --- CONFIGURATION ---
const FAVORITES_FILE = path.join(__dirname, '../favorites.json');
const BOSE_HEADERS = { headers: { 'Content-Type': 'application/xml' } };
const PRESS_DELAY = 450; 

const SPEAKERS = require('../speakers.json');

// --- GLOBAL STATE ---
// CACHED_STATES: The central source of truth for the frontend. updated by the poller.
let CACHED_STATES = {};
// SYNC_LOCKS: Prevents multiple "Join" operations from overlapping on the same device.
const SYNC_LOCKS = new Set();
// CACHES: fast-access lookups to avoid iterating the full speaker list repeatedly.
const ZONE_CACHE = {}; 
const MAC_CACHE = {};
const DEVICE_STATES = {}; 
const BURST_TIMERS = {}; 

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// --- HELPER FUNCTIONS ---

// Wraps Bose API calls to standardize headers and error handling.
async function sendBoseXml(ip, endpoint, xmlData) {
    try {
        await axios.post(`http://${ip}:8090/${endpoint}`, xmlData, BOSE_HEADERS);
        return true;
    } catch (e) { return false; }
}

// Triggers "Burst Mode" polling for a specific device.
// When a user interacts with a device, the system temporarily increases the polling rate 
// (every 600ms for 16 cycles) to capture the hardware response as fast as possible.
async function triggerBurstMode(ip) {
    if (BURST_TIMERS[ip]) return; 
    BURST_TIMERS[ip] = true;
    let cycles = 0;
    const device = SPEAKERS.find(s => s.ip === ip);
    if (!device) return;
    
    const burstLoop = setInterval(async () => {
        cycles++;
        if (cycles > 16) { 
            clearInterval(burstLoop);
            delete BURST_TIMERS[ip];
            return;
        }
        const state = await deviceState.get(device);
        CACHED_STATES[ip] = state;
    }, 600);
}

// --- LOGIC HANDLERS ---

// Handles logic when a Transport Key (Play/Pause/Next) is pressed on a device driven by Music Assistant.
// Instead of sending the key to the Bose speaker (which might be dumb/passthrough),
// the system intercepts it and calls the 'mass' module to control the stream source directly.
async function handleMassTransport(ip, key, currentState) {
    console.log(`[Control] 📡 Delegating ${key} to MASS Driver`);
    
    // 1. EXECUTE ACTION
    if (key === 'NEXT_TRACK') await mass.next(ip);
    else if (key === 'PREV_TRACK') await mass.previous(ip);
    else if (key === 'PLAY_PAUSE') await mass.toggle(ip);
    else if (key === 'PAUSE') await mass.pause(ip); 
    else if (key === 'PLAY') await mass.resume(ip);
    else if (key === 'STOP') await mass.stop(ip, "Transport STOP");
    
    // 2. SET EXPECTATION (Optimistic UI)
    // Tells device_state to ignore stale polling data until the new state appears.
    const contextTitle = currentState.track || currentState.stationName || '';
    
    if (key === 'NEXT_TRACK' || key === 'PREV_TRACK') {
        console.log(`[Control] 🔒 Setting TRACK Lock for ${key}`);
        deviceState.setExpectation(ip, 'TRACK', null, contextTitle);
    } 
    else if (key === 'PLAY_PAUSE') {
        const isPlaying = (currentState.playStatus === 'PLAY_STATE' || currentState.playStatus === 'BUFFERING_STATE');
        const targetState = isPlaying ? 'NOT_PLAYING' : 'PLAYING';
        console.log(`[Control] 🔒 Setting STATE Lock for ${key} (Target: ${targetState})`);
        deviceState.setExpectation(ip, 'PLAY_STATUS', targetState);
    }

    triggerBurstMode(ip); 
}

// Handles sophisticated Power Logic.
// If a Group Master is turned off, the system automatically finds all Slave members
// and powers them down first to ensure a clean group shutdown.
async function handlePowerLogic(ip, currentState) {
    const isStandby = currentState.isStandby;
    
    // 1. RESET SESSION
    if (isStandby) {
        deviceState.clearSession(ip);
    } else {
        // TURNING OFF: Check for Group Slaves
        if (currentState.zone && currentState.zone.master === currentState.mac && currentState.zone.member) {
            const members = Array.isArray(currentState.zone.member) ? currentState.zone.member : [currentState.zone.member];
            console.log(`[Control] ⏻ Powering Down Group Slaves (${members.length})...`);
            
            const xml = `<key state="press" sender="Gabbo">POWER</key>`;
            const xmlRel = `<key state="release" sender="Gabbo">POWER</key>`;
            
            // Fire-and-forget power commands to slaves
            members.forEach(m => {
                const slaveIp = m.ipaddress || m.$.ipaddress;
                if (slaveIp) {
                    sendBoseXml(slaveIp, 'key', xml);
                    sendBoseXml(slaveIp, 'key', xmlRel);
                }
            });
        }
        
        // Stop Mass stream if active
        if (currentState.massIsActiveDriver) mass.stop(ip, "Manual Power OFF"); 
    }

    console.log(`[Control] ⏻ Power Toggle (Current: ${isStandby ? 'Off' : 'On'})`);
    
    // 2. TOGGLE POWER
    const xml = `<key state="press" sender="Gabbo">POWER</key>`;
    const xmlRel = `<key state="release" sender="Gabbo">POWER</key>`;
    
    if (!isStandby) mass.setPresetMemory(ip, 0); 
    
    await sendBoseXml(ip, 'key', xml);
    await sendBoseXml(ip, 'key', xmlRel);
    
    triggerBurstMode(ip); 
}

// Handles Preset Selection.
// Fetches the specific content associated with the preset ID from the speaker API,
// then manually constructs a "Select" command to enforce the change.
async function handlePresetSelection(ip, presetNum, currentState) {
    console.log(`[Control] 🔘 Preset Click: ${presetNum} (Processing...)`);
    
    if (currentState.isStandby) deviceState.clearSession(ip);

    try {
        // 1. FETCH DATA
        const [pRes, npRes] = await Promise.all([
            axios.get(`http://${ip}:8090/presets`),
            axios.get(`http://${ip}:8090/now_playing`).catch(() => ({ data: '' }))
        ]);

        const parser = new xml2js.Parser({ explicitArray: false });
        const pData = await parser.parseStringPromise(pRes.data);
        
        // Capture current track name to use as context for the Lock
        let liveContext = currentState.track || currentState.stationName || '';
        try {
            if (npRes.data) {
                const npData = await parser.parseStringPromise(npRes.data);
                liveContext = npData.nowPlaying.track || npData.nowPlaying.stationName || '';
            }
        } catch(e) {}

        if (!pData.presets || !pData.presets.preset) return false;
        
        const allPresets = Array.isArray(pData.presets.preset) ? pData.presets.preset : [pData.presets.preset];
        const match = allPresets.find(p => p.$.id == presetNum);
        if (!match) return false;

        // 2. SEND SELECTION
        const c = match.ContentItem;
        const xml = `<ContentItem source="${c.$.source}" type="${c.$.type}" location="${c.$.location}" sourceAccount="${c.$.sourceAccount || ''}" isPresetable="true"><itemName>${c.itemName}</itemName><containerArt>${c.containerArt || ''}</containerArt></ContentItem>`;
        await sendBoseXml(ip, 'select', xml);
        
        // 3. SET EXPECTATION
        mass.setPresetMemory(ip, presetNum);
        const lockContext = currentState.isStandby ? '' : liveContext;
        deviceState.setExpectation(ip, 'PRESET', presetNum, lockContext);
        console.log(`[Control] 🔒 Preset Expectation Set: ${presetNum} | Context: "${lockContext}"`);

        // Optimistically clear UI to show loading state
        if (CACHED_STATES[ip]) {
            CACHED_STATES[ip].art = ""; 
            CACHED_STATES[ip].track = "Loading...";
        }
        
        triggerBurstMode(ip); 
        return true;
    } catch (e) { console.log(`Preset Error: ${e.message}`); return false; }
}

// Synchronizes metadata for Slave devices.
// If a device is a Slave, it suppresses its own (often incomplete) metadata
// and instead copies the full metadata (Art, Artist, Track) from its Master.
function syncSlaveMetadata() {
    SPEAKERS.forEach(d => {
        const state = CACHED_STATES[d.ip];
        if (state && state.mode === 'SLAVE' && state.zone && state.zone.master) {
            
            const masterIp = Object.keys(MAC_CACHE).find(key => MAC_CACHE[key] === state.zone.master);
            
            if (masterIp && CACHED_STATES[masterIp]) {
                const m = CACHED_STATES[masterIp];
                
                // Only sync if Master is fully "Ready" to avoid syncing loading/buffering states
                if (m.readyForDisplay) {
                    state.track = m.track;
                    state.artist = m.artist;
                    state.album = m.album;
                    state.art = m.art;
                    state.massIsActiveDriver = m.massIsActiveDriver;
                    state.readyForDisplay = true; // FORCE READY
                } else {
                    // Master is busy -> Slave waits
                    state.readyForDisplay = false; 
                    state.track = "Joining..."; 
                    state.artist = ""; 
                    state.art = ""; 
                }
            } else {
                // Master not found
                state.readyForDisplay = false;
                state.track = "Joining...";
                state.artist = "";
                state.art = "";
            }
        }
    });
}

// --- POLLER ---
// Periodically fetches state from all devices and updates the global cache.
async function pollDevices() {
    const updates = SPEAKERS.map(async (d) => {
        const state = await deviceState.get(d);
        CACHED_STATES[d.ip] = state;
        if (state.online) {
            MAC_CACHE[d.ip] = state.mac;
            DEVICE_STATES[d.ip] = state.isStandby ? 'OFF' : 'ON';
            if (state.zone && state.zone.master) {
                ZONE_CACHE[d.ip] = state.zone.master;
            }
        } else {
            DEVICE_STATES[d.ip] = 'OFFLINE';
        }
    });
    await Promise.all(updates);
    
    // Run post-fetch synchronization
    syncSlaveMetadata();
}
setInterval(pollDevices, 2000);

// --- ROUTES ---

router.get('/status', (req, res) => {
    const results = SPEAKERS.map(d => CACHED_STATES[d.ip] || { ...d, online: false });
    res.json(results);
});

// Central Command Handler
// Routes incoming requests to specific logic handlers based on key type.
router.post('/key', async (req, res) => { 
    const { ip, key } = req.body;
    console.log(`[Control] Request: ${key} -> ${ip}`);

    const currentState = CACHED_STATES[ip] || {};
    const transportKeys = ['NEXT_TRACK', 'PREV_TRACK', 'PLAY_PAUSE', 'PAUSE', 'PLAY', 'STOP'];

    // 1. MASS DELEGATION
    if (transportKeys.includes(key) && currentState.massIsActiveDriver) {
        await handleMassTransport(ip, key, currentState);
        return res.send({success:true});
    }
    
    // 2. POWER LOGIC
    if (key === 'POWER') {
        await handlePowerLogic(ip, currentState);
        return res.send({success:true});
    }

	// 3. PRESET LOGIC (The Triple-Path Strategy)
    if (key.startsWith('PRESET_')) {
        const presetNum = parseInt(key.split('_')[1]);
        const isLink = currentState.type && currentState.type.toLowerCase().includes('link');

        // --- PATH A: WIRELESS LINK + BYPASS ENABLED ---
        if (isLink && WLA_PRESET_BYPASS) {
            console.log(`[Control] 🔗 WLA Bypass: Direct MASS Trigger for ${ip}`);
            const match = utils.getPresetAssignment(ip, presetNum);
            if (match && match.uri) {
                mass.setPresetMemory(ip, presetNum); 
                deviceState.setExpectation(ip, 'PRESET', presetNum, '');
                await mass.play(ip, match);          
                return res.send({ success: true });
            }
        }

        // --- PATH B: WIRELESS LINK (Bypass Off) ---
        if (isLink) {
            console.log(`[Control] 📡 WLA (Native): Forcing manual selection for ${ip}`);
            const success = await handlePresetSelection(ip, presetNum, currentState);
            if (success) return res.send({ success: true });
        }

        // --- PATH C: STANDARD SPEAKERS ---
        console.log(`[Control] 📡 Standard Speaker: Attempting native hardware key for ${ip}`);
        mass.setPresetMemory(ip, presetNum);
        deviceState.setExpectation(ip, 'PRESET', presetNum, '');

        try {
            if (currentState.isStandby) {
                console.log(`[Control] 💤 Speaker is in Standby. Waking up first...`);
                await sendBoseXml(ip, 'key', `<key state="press" sender="Gabbo">POWER</key>`);
                await sendBoseXml(ip, 'key', `<key state="release" sender="Gabbo">POWER</key>`);
                await sleep(1500); 
            }

            const press = `<key state="press" sender="Gabbo">${key}</key>`;
            const release = `<key state="release" sender="Gabbo">${key}</key>`;
            
            const keySuccess = await sendBoseXml(ip, 'key', press);
            await sleep(PRESS_DELAY); 
            await sendBoseXml(ip, 'key', release);
            
            if (keySuccess) {
                triggerBurstMode(ip);
                return res.send({success:true});
            }
        } catch (e) {
            console.log(`[Control] ⚠️ Hardware key failed. Falling back to manual selection...`);
        }

        // FINAL FALLBACK
        const fallbackSuccess = await handlePresetSelection(ip, presetNum, currentState);
        if (fallbackSuccess) return res.send({ success: true });
        
        return res.status(500).send({ error: "Preset logic failed on all paths" });
    }

    // 4. STANDARD KEY FALLBACK
    // Simply passes volume or other standard key presses to the hardware.
    const press = `<key state="press" sender="Gabbo">${key}</key>`;
    const release = `<key state="release" sender="Gabbo">${key}</key>`;
    try {
        await sendBoseXml(ip, 'key', press);
        await sleep(PRESS_DELAY); 
        await sendBoseXml(ip, 'key', release);
        triggerBurstMode(ip); 
        res.send({success:true});
    } catch(e) { res.status(500).send(e.message); }
});

router.post('/volume', async (req, res) => {
  try {
      await sendBoseXml(req.body.ip, 'volume', `<volume>${req.body.value}</volume>`);
      res.send({ success: true });
  } catch(e) { res.status(500).send(e.message); }
});

router.post('/play_content', async (req, res) => {
    const { ip, contentItem } = req.body;
    console.log(`[Control] Play Content: ${contentItem.itemName} -> ${ip}`);
    
    mass.setPresetMemory(ip, 0); 
    deviceState.clearSession(ip);
    
    let xml = `<ContentItem source="${contentItem.source}" type="${contentItem.type}" location="${contentItem.location}" sourceAccount="${contentItem.sourceAccount || ''}" isPresetable="${contentItem.isPresetable || 'true'}"><itemName>${contentItem.itemName}</itemName><containerArt>${contentItem.containerArt || ''}</containerArt></ContentItem>`;
    
    const success = await sendBoseXml(ip, 'select', xml);
    if (success) {
        deviceState.setExpectation(ip, 'TRACK', null, '');
        triggerBurstMode(ip); 
        res.send({ success: true });
    } else {
        res.status(500).send({ error: "Selection failed" });
    }
});

// Handles Multi-Room Grouping ("Join").
// Finds the best available Master speaker (prioritizing one that is playing)
// and bonds the requesting speaker (Slave) to it.
router.post('/join', async (req, res) => {
  const { slaveIp } = req.body; 
  if (SYNC_LOCKS.has(slaveIp)) return res.send({ success: false, message: "Sync Busy" });
  SYNC_LOCKS.add(slaveIp);
  console.log(`[Control] 🔗 Join Request: ${slaveIp} -> Master`);
  
  // Wipes stale session data if device was off or idle
  try {
      const slaveState = CACHED_STATES[slaveIp];
      if (!slaveState || slaveState.isStandby) {
          deviceState.clearSession(slaveIp);
      }
  } catch(e) {}

  deviceState.setExpectation(slaveIp, 'JOIN', 'SLAVE');

  // Saves current volume to restore it after the bond logic (which often resets volume).
  let restoreVol = 20;
  try {
      const v = await axios.get(`http://${slaveIp}:8090/volume`);
      const p = new xml2js.Parser({ explicitArray: false });
      const vd = await p.parseStringPromise(v.data);
      restoreVol = parseInt(vd.volume.actualvolume);
  } catch (e) {}
      
  try {
      // MASTER SELECTION STRATEGY:
      // 1. Prioritize a speaker that is currently PLAYING.
      // 2. Fallback to any active speaker.
      let masterIp = null, masterMac = null;
      const candidates = [];

      for (const d of SPEAKERS) {
          if (d.ip === slaveIp) continue;
          try {
              const state = CACHED_STATES[d.ip];
              if (state && !state.isStandby) {
                 const zoneMaster = state.zone ? state.zone.master : null;
                 const myMac = state.mac;
                 // Valid if it's not a slave to someone else (or is the master)
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
          console.log(`[Control] ⚠️ Join failed (No Master). Defaulting to Standard Power ON.`);         
		  // --- CANCEL JOIN LOCK ---
          // clear the "Expect Slave" lock set 20 lines up, 
          // otherwise  UI will hang for 60 seconds waiting for a Group that never exists.
          deviceState.clearSession(slaveIp);
          // Fallback: Just turn the speaker ON as a standalone device.
          await sendBoseXml(slaveIp, 'key', `<key state="press" sender="Gabbo">POWER</key>`);
          await sleep(PRESS_DELAY);
          await sendBoseXml(slaveIp, 'key', `<key state="release" sender="Gabbo">POWER</key>`);
          
          triggerBurstMode(slaveIp);
          return res.send({ success: true, message: "Fallback to Power On" });
      }
      
      triggerBurstMode(slaveIp); 
      
      // Determine Slave MAC (Check Cache first, then fetch)
      let slaveMac = MAC_CACHE[slaveIp];
      if (!slaveMac) {
          const i = await axios.get(`http://${slaveIp}:8090/info`);
          const p = new xml2js.Parser({ explicitArray: false });
          const id = await p.parseStringPromise(i.data);
          slaveMac = id.info.deviceID || id.info.$.deviceID;
      }

      // EXECUTE BOND: Power Cycle Slave -> Set Zone on Master -> Restore Volume
      await sendBoseXml(slaveIp, 'key', `<key state="press" sender="Gabbo">POWER</key>`);
      await sleep(PRESS_DELAY);
      await sendBoseXml(slaveIp, 'key', `<key state="release" sender="Gabbo">POWER</key>`);
      
      setTimeout(() => {
          const xml = `<zone master="${masterMac}"><member ipaddress="${slaveIp}">${slaveMac}</member></zone>`;
          sendBoseXml(masterIp, 'setZone', xml);
          triggerBurstMode(masterIp); 
      }, 500);
      
      setTimeout(() => {
          sendBoseXml(slaveIp, 'volume', `<volume>${restoreVol}</volume>`);
      }, 3000);
      
      res.send({ success: true });
  } catch (err) { res.status(500).send({ error: err.message }); } finally { SYNC_LOCKS.delete(slaveIp); }
});

// Updates volume for an entire Zone (Master + All Slaves).
// Calculates the volume delta applied to the master and applies it to all members.
router.post('/zone_volume', async (req, res) => {
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
        
        // Parallel updates for responsiveness
        const updates = ips.map(async (ip) => {
            try {
                const vRes = await axios.get(`http://${ip}:8090/volume`);
                const vData = await parser.parseStringPromise(vRes.data);
                let vol = parseInt(vData.volume.actualvolume) + parseInt(delta);
                if (vol > 100) vol = 100; if (vol < 0) vol = 0;
                await sendBoseXml(ip, 'volume', `<volume>${vol}</volume>`);
            } catch (e) {}
        });
        await Promise.all(updates);
        res.send({ success: true });
    } catch(e) { res.status(500).send(e.message); }
});

// --- FAVORITES CRUD ---
router.get('/favorites', (req, res) => { try { if (!fs.existsSync(FAVORITES_FILE)) return res.json([]); const content = fs.readFileSync(FAVORITES_FILE, 'utf8'); if (!content.trim()) return res.json([]); res.json(JSON.parse(content)); } catch(e) { res.json([]); } });
router.post('/favorites', (req, res) => { try { const data = fs.existsSync(FAVORITES_FILE) ? JSON.parse(fs.readFileSync(FAVORITES_FILE, 'utf8') || '[]') : []; data.push(req.body.contentItem); fs.writeFileSync(FAVORITES_FILE, JSON.stringify(data, null, 2)); res.json({ success: true }); } catch(e) { res.status(500).send(e.message); } });
router.delete('/favorites/:index', (req, res) => { try { const data = JSON.parse(fs.readFileSync(FAVORITES_FILE, 'utf8') || '[]'); data.splice(req.params.index, 1); fs.writeFileSync(FAVORITES_FILE, JSON.stringify(data, null, 2)); res.json({ success: true }); } catch(e) { res.status(500).send(e.message); } });

// --- HEALTH CHECK ---
router.get('/health', (req, res) => {
    res.json({ healthy: mass.getHealth() });
});

router.post('/health/reset', (req, res) => {
    mass.resetHealth();
    res.json({ success: true });
});

module.exports = router;