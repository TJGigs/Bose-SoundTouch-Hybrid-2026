const axios = require('axios');
const xml2js = require('xml2js');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

// --- IMPORTS ---
const mass = require('./routes/mass');
const utils = require('./routes/utils');

// --- NEW STATE ENGINE ---
const NATIVE_CACHE = {};   // Holds raw data pushed by WebSocket
const FINAL_STATE = {};    // Holds fully processed data (after MASS overrides and scrubbing)
const DEBOUNCE_TIMERS = {};
const DEBOUNCE_DELAY_MS = 500; // The "Anti-Flicker" window
const LAST_VALID_STATE = {};
const MAX_OFFLINE_RETRIES = 5;
const OFFLINE_COUNTS = {};
const LAST_METADATA = {};
const STOP_TIMERS = {}; // Replaces STOP_COUNTS for WebSocket time
const EXPECTATIONS = {}; // Tracks active UI Locks
const TRACK_TIME_ANCHOR = {}; // Fixes Bose gapless time accumulation
const WAKE_MEMORY = {}; // App Mem for Behavior 4
const AUTO_RESUME_PRESET = process.env.AUTO_RESUME_PRESET !== 'false'; //if not false fallback is true

// BAD_META: List of keywords indicating the speaker is not playing real content.
const BAD_META = ["MUSIC ASSISTANT", "READY", "OBJECT", "LOADING...", "", "AIRPLAY", "UNKNOWN", "STOPPED", "STANDBY", "UPNP", "INVALID_SOURCE", "NULL"];

// --- HELPERS (UNTOUCHED) ---
const isBadMeta = (t) => !t || BAD_META.includes(t.toUpperCase());

function scrubText(str) {
    if (!str) return "";
    return str.replace(/\ufffd/g, 'a').normalize('NFC');
}

function cleanContentItem(raw, playStatus) {
    if (!raw) return { source: "Ready" };
    const attr = raw.$ || {};
    let source = raw.source || attr.source || "Ready";
    let type = raw.type || attr.type || "";
    let location = raw.location || attr.location || "";
    let itemName = raw.itemName || "";

    if (playStatus === 'STOP_STATE') source = 'Ready';

    return { source, type, location, itemName, containerArt: raw.containerArt || raw.art || (raw.img ? raw.img._ : "") || "" };
}

function determineActivePreset(cleanItem, presetsD, isStandby, source, massIsActiveDriver, deviceIp) {
    let activePreset = 0;
    if (cleanItem.source === 'Preset') activePreset = parseInt(cleanItem.location) || 0;
    if (activePreset === 0 && cleanItem.itemName) {
        const m = cleanItem.itemName.match(/Preset (\d+)/i);
        if (m) activePreset = parseInt(m[1]);
    }
    if (activePreset === 0 && cleanItem.location) {
        const m = cleanItem.location.match(/\/preset\/(\d+)\.mp3/);
        if (m) activePreset = parseInt(m[1]);
    }
    if (activePreset === 0 && !isStandby && cleanItem.location && presetsD && presetsD.presets && presetsD.presets.preset) {
        const allPresets = Array.isArray(presetsD.presets.preset) ? presetsD.presets.preset : [presetsD.presets.preset];
        const match = allPresets.find(p => p.ContentItem && p.ContentItem.$.location === cleanItem.location);
        if (match) activePreset = parseInt(match.$.id);
    }
    if (activePreset === 0 && !isStandby && massIsActiveDriver) {
        const mem = mass.getPresetMemory(deviceIp);
        if (mem) {
			// Added INVALID_SOURCE and Ready so the preset button stays lit while paused
            const stickySources = ['LOCAL_INTERNET_RADIO', 'AIRPLAY', 'UPNP', 'INVALID_SOURCE', 'READY', 'Ready'];
            if (stickySources.includes(source)) activePreset = mem.id;
        }
    }
    return activePreset;
}
function resolveMetadataAndStatus(nativeData, massData, source, isPausedByShadow, deviceIp) {
    let finalTrack = nativeData.track;
    let finalArtist = nativeData.artist;
    let finalAlbum = nativeData.album;
    let finalArt = nativeData.art; 
    let rawArtUrl = ""; 
	let rawProvider = "";	
    // 1. Establish baseline status directly from the hardware
    let finalStatus = isPausedByShadow ? 'PAUSE_STATE' : (nativeData.rawStatus === 'BUFFERING_STATE' ? 'PLAY_STATE' : nativeData.rawStatus);  
    let wipeMetadata = false;
    let finalMediaType = nativeData.type || ''; 
    let isMaActive = false; 
    
    if (massData) {
        if ((massData.state === 'idle' || massData.state === 'stopped') && !mass.isRecovering(deviceIp)) {
            finalStatus = 'STOP_STATE';
            wipeMetadata = true;
        } else if (isPausedByShadow) {
            finalStatus = 'PAUSE_STATE';
            isMaActive = true; 
        } else {
            isMaActive = true;           
            // 🛡️ Never override native PLAY/PAUSE state with MASS queue state.
            // MASS state can lag behind native hardware by 10+ seconds. Trust speaker
            // ONLY use MASS state to override a STOP_STATE to mask gapless track loading.
            if (finalStatus === 'STOP_STATE' && massData.state === 'playing') {
                finalStatus = 'PLAY_STATE';
            }
        }
        if (massData.item && massData.item.media_type) finalMediaType = massData.item.media_type;
    }

    const keepNative = ((source === 'AIRPLAY' || source === 'UPNP') && !isBadMeta(finalTrack) && !isMaActive); 

    if (wipeMetadata) {
        finalTrack = ""; finalArtist = ""; finalAlbum = ""; finalArt = null;
    } else if (!keepNative && massData && massData.meta) {
        const meta = massData.meta;
        finalTrack = utils.scrubText(meta.name || massData.item.name || finalTrack);
        if (meta.artists && Array.isArray(meta.artists)) {
            finalArtist = utils.scrubText(meta.artists.map(a => a.name).join(', '));
        } else if (meta.artist) {
            finalArtist = utils.scrubText(meta.artist.name || meta.artist);
        } else {finalArtist = "";}
		
        finalAlbum = utils.scrubText(meta.album ? (meta.album.name || meta.album) : finalAlbum);        
        // --- SMART ARTWORK SELECTION  ---
        if (meta.metadata && meta.metadata.images && meta.metadata.images.length > 0) {
            const imgs = meta.metadata.images;
			const bestImg = imgs.find(i => i.type === 'thumb') || imgs.find(i => i.type === 'landscape') || imgs[0];            
            rawArtUrl = bestImg.path;
            rawProvider = bestImg.provider;
        } else if (massData.item.image) {
            rawArtUrl = massData.item.image.path || massData.item.image;
            if (typeof massData.item.image === 'object') rawProvider = massData.item.image.provider;
        }

        if (rawArtUrl) finalArt = utils.buildImageUrl(rawArtUrl, rawProvider, massData.item.uri);
    }

    const isJunkArt = !finalArt || finalArt.includes('default-image') || finalArt.includes('placeholder') || finalArt.includes('Unknown');
    if (isJunkArt) finalArt = "";
    if (finalTrack === "Music Assistant") finalTrack = "";

	return { track: finalTrack, artist: finalArtist, album: finalAlbum, art: finalArt, playStatus: finalStatus, mediaType: finalMediaType, provider: rawProvider || '' };

}

// =========================================================
// --- HELPER: BEHAVIOR 4 (AUTO-RESUME PRESET) ---
// =========================================================
function handleWakeMemory(ip, isStandby, activePreset, finalPlayStatus) {
    if (!AUTO_RESUME_PRESET) return; // Exit immediately if the user disabled this feature

    // 1. RECORDING
    if (!isStandby) {
        if (activePreset > 0) {
            // Playing a preset -> Remember it for the next boot
            WAKE_MEMORY[ip] = activePreset;
        } else if (finalPlayStatus === 'PLAY_STATE') {
            // Playing generic Wi-Fi stream -> Forget memory so it boots to vanilla Wi-Fi
            delete WAKE_MEMORY[ip]; 
        }
    }
    
    // 2. WAKE-UP TRIGGER
    const oldState = LAST_VALID_STATE[ip];
    if (oldState && oldState.isStandby && !isStandby) {
        // The speaker just woke up!
        if (WAKE_MEMORY[ip]) {
            const presetId = WAKE_MEMORY[ip];
            console.log(`\n[DeviceState] 🌅 Auto-Resume Enabled: Waking up ${ip}. Resuming Preset ${presetId}...`);
            
            // Wait 2 seconds for the speaker's network stack to fully settle
            setTimeout(async () => {
                try {
                    await axios.post(`http://${ip}:8090/key`, `<key state="press" sender="Gabbo">PRESET_${presetId}</key>`);
                    await axios.post(`http://${ip}:8090/key`, `<key state="release" sender="Gabbo">PRESET_${presetId}</key>`);
                } catch(e) {
                    console.log(`[DeviceState] ⚠️ Failed to auto-resume preset for ${ip}`);
                }
            }, 2000);
        }
    }
}

// =========================================================
// --- HELPER: EXPECTATION LOCK EVALUATION ---
// =========================================================
function evaluateExpectationLocks(ip, finalTrack, finalPlayStatus, isStandby, isMaster) {
// Slaves must be allowed to be displayed so ReadyForDisplay returns true
    if (!EXPECTATIONS[ip]) return true; // No lock exists, UI is ready for display!

    const exp = EXPECTATIONS[ip];
    const elapsed = Date.now() - (exp.expires - 8000);

    // 1. Check for Safety Timeout
    if (Date.now() > exp.expires) {
        console.log(`[DeviceState] 🔓 Safety Timeout: UI Unlocked for ${ip}`);
        console.log(`[DeviceState] 🚨 Deleting EXPECTATION lock for ${ip}!`);
        delete EXPECTATIONS[ip];
        return true;
    }

    // 2. Evaluate specific lock conditions
    let lockMet = false;

    if (exp.type === 'TRACK' || exp.type === 'PRESET') {
        if (finalTrack && finalTrack !== 'Ready' && finalTrack !== 'Music Assistant') {
            if (finalPlayStatus === 'PLAY_STATE') {
                if (finalTrack !== exp.context || elapsed > 3000) {
                    lockMet = true;
                }
            }
        }
    } else if (exp.type === 'PLAY_STATUS') {
        if (exp.value === 'PLAYING' && finalPlayStatus === 'PLAY_STATE') lockMet = true;
        if (exp.value === 'NOT_PLAYING' && finalPlayStatus !== 'PLAY_STATE') lockMet = true;
    } else if (exp.type === 'POWER') {
        if (isStandby) lockMet = true;
    } else if (exp.type === 'JOIN') {
        // Instantly unlock the UI as soon as speaker confirms it's a slave
        if (!isMaster) lockMet = true;
    }

    // 3. Resolve the lock
    if (lockMet) {
        console.log(`[DeviceState] 🔓 Lock Met (${exp.type}): UI Unlocked for ${ip}`);
        console.log(`[DeviceState] 🚨 Deleting EXPECTATION lock for ${ip}`);
        delete EXPECTATIONS[ip];
        return true;
    } else {
        return false; // 🚫 REJECT THE OVERWRITE! KEEP THE UI LOCKED!
    }
}



// ---  AUTO-HEALING WEBSOCKET INITIALIZER ---
async function initDevice(device) {
    console.log(`[DeviceState] 🔌 Initializing WebSocket for ${device.name} (${device.ip})`);
    
    // 1. Setup Baseline Cache (Only if it doesn't exist, to preserve locks during reconnects)
    if (!NATIVE_CACHE[device.ip]) {
        NATIVE_CACHE[device.ip] = { device: device, playStatus: 'STOP_STATE', volume: 0, nowPlaying: {} };
        FINAL_STATE[device.ip] = { ...device, online: true, readyForDisplay: true };
    }

    // --- NEW: Exponential Backoff State ---
    let reconnectDelay = 5000;
    let failedAttempts = 0;

    // Wrap the connection logic so it can restart itself
    async function fetchInitialAndConnect() {
        // 2. INITIAL SEED FETCH (Catches up on missed tracks like Mozart after a drop!)
        try {
            const [npRes, volRes] = await Promise.all([
                axios.get(`http://${device.ip}:8090/now_playing`, { timeout: 3500 }).catch(() => null),
                axios.get(`http://${device.ip}:8090/volume`, { timeout: 3500 }).catch(() => null)
            ]);
            const parser = new xml2js.Parser({ explicitArray: false });
            
			if (npRes && npRes.data) {
                // --- THE HTTP SCRUBBER ---
                let cleanXml = npRes.data.replace(/\ufffd/g, 'a').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
                const npData = await parser.parseStringPromise(cleanXml);
                if (npData.nowPlaying) {
                    NATIVE_CACHE[device.ip].nowPlaying = npData.nowPlaying;
                    if (npData.nowPlaying.playStatus !== undefined) NATIVE_CACHE[device.ip].playStatus = npData.nowPlaying.playStatus;
                }
            }
            if (volRes && volRes.data) {
                let cleanVol = volRes.data.replace(/\ufffd/g, 'a').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
                const volData = await parser.parseStringPromise(cleanVol);
                if (volData.volume && volData.volume.actualvolume) {
                    NATIVE_CACHE[device.ip].volume = parseInt(volData.volume.actualvolume);
                }
            } 
        } catch (e) {
            // Silently ignore HTTP seed failures on sleeping devices
        }

        // 3. Process the state so the UI updates immediately
        // Only print the UI State block if it's the first few attempts to prevent spam
        const originalLog = console.log;
        if (failedAttempts >= 3) console.log = function() {}; // Mute standard logs temporarily
        await processSettledState(device.ip);
        console.log = originalLog; // Restore logs

        // 4. Start the WebSocket Listener
        const ws = new WebSocket(`ws://${device.ip}:8080`, 'gabbo');

        ws.on('open', () => {
            if (failedAttempts > 0) {
                console.log(`[DeviceState] 🔌 WS Reconnected to ${device.ip}! Resuming normal operations.`);
            }
            // Reset the timers when successfully connected
            reconnectDelay = 5000;
            failedAttempts = 0;
        });

        ws.on('message', async (data) => {
            try {
                // 1. Convert the raw WebSocket buffer to a string first
                let rawXml = data.toString('utf8');
                
                // --- 🚨 THE UNFILTERED RAW WEBSOCKET LOGGER 🚨 ---
                // prints everything before the code can filter it out
                /* console.log(`\n[RAW WS DUMP] 📥 from ${device.ip}:`);
                console.log(rawXml);
                console.log(`--------------------------------------\n`);
                */

                // 2. THE PRE-SCRUBBER: Sanitize the raw XML before parsing
                rawXml = rawXml.replace(/\ufffd/g, 'a').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');

                // 3. Give clean XML to strict parser
                const parser = new xml2js.Parser({ explicitArray: false });
                const result = await parser.parseStringPromise(rawXml);

                // If it's not a standard update, we still return
                if (!result.updates) return;

                // UPDATE NATIVE CACHE INSTANTLY
                if (result.updates.nowPlayingUpdated) {
                    const np = result.updates.nowPlayingUpdated.nowPlaying;
                    NATIVE_CACHE[device.ip].nowPlaying = np; 
                    if (np.playStatus !== undefined) NATIVE_CACHE[device.ip].playStatus = np.playStatus;
                }
                if (result.updates.volumeUpdated) {
                    NATIVE_CACHE[device.ip].volume = parseInt(result.updates.volumeUpdated.volume.actualvolume);
                }

                // A hardware change occurred! Re-lock the UI if an expectation isn't already active.
                if (!EXPECTATIONS[device.ip]) FINAL_STATE[device.ip].readyForDisplay = false; 

                if (DEBOUNCE_TIMERS[device.ip]) clearTimeout(DEBOUNCE_TIMERS[device.ip]);

                DEBOUNCE_TIMERS[device.ip] = setTimeout(async () => {
                    // HARDWARE SETTLED. RUN THE BUSINESS LOGIC ONCE.
                    await processSettledState(device.ip);
                }, DEBOUNCE_DELAY_MS);

            } catch (err) {
                console.log(`[DeviceState] ⚠️ XML Parsing Error on ${device.ip}: ${err.message}`);
            }
        });

		ws.on('error', (err) => {
            // --- THE SILENCER ---
            // Acknowledge protocol-level crash, but don't treat it as a hard failure.
            if (err.message.includes('UTF-8')) {
                console.log(`[DeviceState] 🧽 Bad metadata from ${device.ip} broke the socket. Auto-recovering via HTTP...`);
                return; // Ignore and let the auto-reconnect handle it cleanly!
            }
            
            failedAttempts++;
            
            // --- THE MISSING 'IF' STATEMENT IS RESTORED HERE ---
            if (failedAttempts < 3) {
                console.log(`[DeviceState] ⚠️ WS Error on ${device.ip}: ${err.message}`);
            } else if (failedAttempts === 3) {
                console.log(`[DeviceState] 🔇 Speaker ${device.ip} is unreachable. Suppressing WS logs until it wakes up.`);
                // flag it as offline so UI grays it out
                if (FINAL_STATE[device.ip]) FINAL_STATE[device.ip].online = false;
            }
        });

        // --- AUTO-RECONNECT LOOP ---
        ws.on('close', () => {
            if (failedAttempts < 3) {
                console.log(`[DeviceState] 🔌 WS Disconnected from ${device.ip}. Reconnecting in ${reconnectDelay / 1000}s...`);
            }
            
            setTimeout(fetchInitialAndConnect, reconnectDelay);
            
            // THE SNOOZE: Double the delay each time it fails, capping at 60 seconds
            if (reconnectDelay < 60000) {
                reconnectDelay = Math.min(reconnectDelay * 2, 60000);
            }
        });
    }

    // Start the engine
    fetchInitialAndConnect();

}

// --- THE LOGIC ENGINE ---
async function processSettledState(ip) {
    const cache = NATIVE_CACHE[ip];
    const device = cache.device;
    const npD = {
        nowPlaying: cache.nowPlaying
    };

    try {
        const [info, zone, presets] = await Promise.all([
                    axios.get(`http://${ip}:8090/info`, {
                        timeout: 3500
                    }).catch(() => null),
                    axios.get(`http://${ip}:8090/getZone`, {
                        timeout: 3500
                    }).catch(() => null),
                    axios.get(`http://${ip}:8090/presets`, {
                        timeout: 3500
                    }).catch(() => null)
                ]);
        // If info endpoint fails, the speaker is physically unplugged or off Wi-Fi.
        // Abort immediately before the engine hardcodes `online: true` below
        if (!info || !info.data) {
            FINAL_STATE[ip] = {
                ...device,
                online: false,
                readyForDisplay: true
            };
            return;
        }

        const parser = new xml2js.Parser({
            explicitArray: false
        });
        const [infoD, zoneD, presetsD] = await Promise.all([
                    info ? parser.parseStringPromise(info.data) : {
                        info: {}
                    },
                    zone ? parser.parseStringPromise(zone.data) : {
                        zone: null
                    },
                    presets ? parser.parseStringPromise(presets.data) : {
                        presets: null
                    }
                ]);

        const myMac = infoD.info.deviceID || (infoD.info.$ && infoD.info.$.deviceID);
        let masterMac = null;
        if (zoneD.zone)
            masterMac = zoneD.zone.master || (zoneD.zone.$ && zoneD.zone.$.master);
        const isMaster = (!masterMac || masterMac === myMac);

        let rawArt = typeof npD.nowPlaying.art === 'string' ? npD.nowPlaying.art : (npD.nowPlaying.art?._ || null);
        let rawTrack = utils.scrubText((npD.nowPlaying.track || '').trim());
        let rawArtist = utils.scrubText((npD.nowPlaying.artist || '').trim());
        let rawAlbum = utils.scrubText((npD.nowPlaying.album || '').trim());
        let station = utils.scrubText(npD.nowPlaying.stationName || '');
        const source = npD.nowPlaying.$ ? npD.nowPlaying.$.source : 'STANDBY';
        const isStandby = source === 'STANDBY';
        let rawStatus = npD.nowPlaying.playStatus || cache.playStatus || 'STOP_STATE';
        let finalMediaType = npD.nowPlaying.ContentItem ? (npD.nowPlaying.ContentItem.type || '') : '';
        // --- TIME & DURATION EXTRACTION ---
        let finalPosition = 0;
        let finalDuration = 0;
        if (npD.nowPlaying.time) {
            finalPosition = parseInt(npD.nowPlaying.time._ || npD.nowPlaying.time) || 0;
            finalDuration = parseInt(npD.nowPlaying.time.$ ? npD.nowPlaying.time.$.total : 0) || 0;
        }
        let finalTrack = rawTrack;
        let finalArtist = rawArtist;
        let finalAlbum = rawAlbum;
        let finalArt = rawArt;
        let finalPlayStatus = (rawStatus === 'BUFFERING_STATE') ? 'PLAY_STATE' : rawStatus;
        let finalProvider = "";

        // --- RESTORED: Standby Preset Wipe ---
        if (isStandby) {
            mass.setPresetMemory(ip, 0);
            delete LAST_METADATA[ip];
            if (LAST_VALID_STATE[ip] && LAST_VALID_STATE[ip].isStandby === false) {
                mass.stop(ip).catch(() => {});
            }

            finalPlayStatus = 'STOP_STATE'; // Forces play button to gray
            finalTrack = 'Off'; // Ensures the title resets
        }

        let massIsActiveDriver = false;
        const isMassSourceType = (source === 'UPNP' || source === 'AIRPLAY');
        // THE STICKY DRIVER
        // If Bose pauses a DLNA stream, it drops the socket and reports INVALID_SOURCE.
        // so remember MASS is still driving so the Resume button routes correctly
        const wasMassDriving = LAST_VALID_STATE[ip] && LAST_VALID_STATE[ip].massIsActiveDriver;
        const isOrphaned = (!source || source === 'INVALID_SOURCE' || source === 'Ready');
        // Use the variables to decide if we should check MASS!
        const shouldCheckMass = isMassSourceType || (wasMassDriving && isOrphaned);

        if (shouldCheckMass && !isStandby) {
            if (wasMassDriving && isOrphaned)
                massIsActiveDriver = true; // Lock the driver!
            try {
                const maData = await mass.getRawMetadata(ip);
                if (maData) {
                    massIsActiveDriver = true;
                    const item = maData.item || maData.current_item || {};
                    const meta = maData.meta || item.metadata || {};
                    finalProvider = meta.provider_mappings?.[0]?.provider_domain || meta.provider || 'unknown';

                    // 🛑 STRICT OVERRIDE: MA always knows the true duration during gapless!
                    if (item.duration)
                        finalDuration = parseInt(item.duration);

                    const nativeState = {
                        track: rawTrack,
                        artist: rawArtist,
                        album: rawAlbum,
                        art: rawArt,
                        rawStatus: rawStatus,
                        type: finalMediaType
                    };
                    const overrides = resolveMetadataAndStatus(nativeState, maData, source, false, ip);

                    finalTrack = overrides.track;
                    finalArtist = overrides.artist;
                    finalAlbum = overrides.album;
                    finalArt = overrides.art;
                    finalPlayStatus = overrides.playStatus;
                    finalMediaType = overrides.mediaType;

                    // 🛑 THE GAPLESS TIME FIX
                    // If Bose accumulates time across gapless tracks, anchor the offset when the track changes.
                    if (!TRACK_TIME_ANCHOR[ip] || TRACK_TIME_ANCHOR[ip].track !== finalTrack) {
                        TRACK_TIME_ANCHOR[ip] = {
                            track: finalTrack,
                            offset: finalPosition
                        };
                    }

                    if (TRACK_TIME_ANCHOR[ip].offset > 0) {
                        if (finalPosition >= TRACK_TIME_ANCHOR[ip].offset) {
                            // Gapless continuation: Subtract the accumulated offset
                            finalPosition = finalPosition - TRACK_TIME_ANCHOR[ip].offset;
                        } else {
                            // Hardware finally reset itself natively. Reset our anchor!
                            TRACK_TIME_ANCHOR[ip].offset = 0;
                        }
                    }
                }

                const overrides = resolveMetadataAndStatus(nativeState, maData, source, false, ip);

                finalTrack = overrides.track;
                finalArtist = overrides.artist;
                finalAlbum = overrides.album;
                finalArt = overrides.art;
                finalPlayStatus = overrides.playStatus;
                finalMediaType = overrides.mediaType;
            } catch (e) {
                // Silently ignore MA fetch errors
            }
        } else {
            if (!finalArt || finalArt.includes('default-image') || finalArt.includes('Unknown'))
                finalArt = "";
        }

    const inGroup = (zoneD.zone && zoneD.zone.master);
    if ((source === 'UPNP' || source === 'AIRPLAY') && finalPlayStatus === 'PLAY_STATE') {
        const isJunkMeta = (!finalTrack || finalTrack === "Ready" || BAD_META.includes(finalTrack.toUpperCase()));
        if (isJunkMeta && !mass.isRecovering(ip) && !inGroup) {
            finalPlayStatus = 'STOP_STATE';
            finalTrack = "Ready";
        }
    }

    // --- RESTORED: LAST_METADATA Persistence ---
    const displayTitle = finalTrack || station || "";
    const isMetaValid = (displayTitle && !BAD_META.includes(displayTitle.toUpperCase()));

    if (isMetaValid && !isStandby) {
        LAST_METADATA[ip] = {
            track: finalTrack,
            artist: finalArtist,
            album: finalAlbum,
            art: finalArt,
            station
        };
    } else if (!isMetaValid && !isStandby && finalPlayStatus === 'PAUSE_STATE' && LAST_METADATA[ip]) {
        const saved = LAST_METADATA[ip];
        finalTrack = saved.track;
        finalArtist = saved.artist;
        finalAlbum = saved.album;
        finalArt = saved.art;
        station = saved.station;
    }

    const cleanItem = cleanContentItem(npD.nowPlaying.ContentItem, finalPlayStatus);
    let activePreset = determineActivePreset(cleanItem, presetsD, isStandby, source, massIsActiveDriver, ip);

    if (finalPlayStatus === 'STOP_STATE' && !isStandby) {
        activePreset = 0;
        finalArt = null;
    }
	
	// --- DELEGATE BEHAVIOR 4 LOGIC ---
    handleWakeMemory(ip, isStandby, activePreset, finalPlayStatus);	

    let artPlaceholder = 'art-blank';
    if (isStandby) {
        artPlaceholder = 'art-off';
    } else {
        const isIdle = (finalPlayStatus === 'STOP_STATE' && (!finalTrack || finalTrack === 'Joining...' || isBadMeta(finalTrack)));
        if (!isIdle && finalProvider === 'builtin')
            artPlaceholder = 'art-globe';
    }

	// --- EXPECTATION LOCK EVALUATION ---
    let readyForDisplay = evaluateExpectationLocks(ip, finalTrack, finalPlayStatus, isStandby, isMaster);

    // --- DETAILED GROUPING LOGGING ---
    const mode = isMaster ? "MASTER" : "SLAVE";
    const oldState = LAST_VALID_STATE[ip];
    if (oldState && oldState.online) { // Only log if transitioning from a known online state
        const oldMode = oldState.mode;
        const oldMasterMac = oldState.zone ? oldState.zone.master : null;
        const newMembers = zoneD.zone && zoneD.zone.member ? (Array.isArray(zoneD.zone.member) ? zoneD.zone.member : [zoneD.zone.member]) : [];
        const oldMembers = oldState.zone && oldState.zone.member ? (Array.isArray(oldState.zone.member) ? oldState.zone.member : [oldState.zone.member]) : [];

        if (oldMode !== mode) {
            if (mode === 'MASTER')
                console.log(`\n[DeviceState] 👑 GROUP STATE: ${ip} became a MASTER / STANDALONE.`);
            if (mode === 'SLAVE')
                console.log(`\n[DeviceState] 🔗 GROUP STATE: ${ip} JOINED a group as a SLAVE (Master: ${masterMac}).`);
        } else if (mode === 'SLAVE' && oldMasterMac !== masterMac) {
            console.log(`\n[DeviceState] 🔀 GROUP STATE: ${ip} SWITCHED to a new Master (${masterMac}).`);
        } else if (mode === 'MASTER') {
            if (oldMembers.length !== newMembers.length) {
                if (newMembers.length > 0) {
                    console.log(`\n[DeviceState] 👥 GROUP STATE: ${ip} group updated. Now hosting ${newMembers.length} Slave(s).`);
                } else if (oldMembers.length > 0 && newMembers.length === 0) {
                    console.log(`\n[DeviceState] 💔 GROUP STATE: ${ip} group disbanded. All Slaves removed.`);
                }
            }
        }
    }
    // ----------------------------------------

    const result = {
        ...device,
        online: true,
        mac: myMac,
        type: (infoD.info.type || "Speaker"),
        volume: cache.volume,
        activePreset,
        isStandby,
        source,
        playStatus: finalPlayStatus,
        track: finalTrack,
        artist: finalArtist,
        album: finalAlbum,
        art: finalArt,
        stationName: station,
        ContentItem: cleanItem,
        mode: isMaster ? "MASTER" : "SLAVE",
        zone: zoneD.zone ? {
            master: masterMac,
            member: zoneD.zone.member || []
        }
         : null,
        massIsActiveDriver,
        readyForDisplay: readyForDisplay,
        artPlaceholder,
        provider: finalProvider,
        duration: finalDuration,
        position: finalPosition
    };

    // =========================================================
    // 🔍 STATE LOGGING (Concise vs Verbose)
    // =========================================================

	if (global.DEBUG_MODE) {
	 // =========================================================
    // 🔍 OMNI-LOG: Dumps ALL state values before updating cache
    // =========================================================	
    console.log(`\n=============================================`);
    console.log(`[DeviceState Engine] -> ${ip}`);
    console.log(`  • ReadyForDisplay : ${readyForDisplay} ${EXPECTATIONS[ip] ? '(LOCKED BY: ' + EXPECTATIONS[ip].type + ')' : ''}`);
    console.log(`  • Power (Standby) : ${isStandby ? 'OFF (true)' : 'ON (false)'}`);
    console.log(`  • Play Status     : ${finalPlayStatus}`);
    console.log(`  • Source          : ${source}`);
    console.log(`  • Media Type      : ${finalMediaType || 'Unknown'}`);
    console.log(`  • Provider        : ${finalProvider || 'Unknown'}`);
    console.log(`  • Track           : ${finalTrack || 'None'} (${finalPosition}s / ${finalDuration}s)`);
    console.log(`  • Artist          : ${finalArtist || 'None'}`);
    console.log(`  • Art URL         : ${finalArt || 'None'}`);
    console.log(`  • Volume          : ${cache.volume}`);
    console.log(`  • Active Preset   : ${activePreset}`);
    console.log(`  • Group Mode      : ${isMaster ? "MASTER" : "SLAVE"}`);
    console.log(`  • MASS is Driver? : ${massIsActiveDriver}`);
    console.log(`=============================================`);
	} else {
        // CONCISE: Print a single line ONLY when the state changes
        const lastState = LAST_VALID_STATE[ip];
        
        if (readyForDisplay) {
            if (finalPlayStatus === 'PLAY_STATE') {
                if (!lastState || lastState.track !== finalTrack || lastState.playStatus !== finalPlayStatus) {
                    console.log(`[DeviceState] 🎵 ${ip} playing "${finalTrack || 'Unknown'}" via ${finalProvider || source || 'Unknown'}`);
                }
            } else if (isStandby) {
                if (!lastState || !lastState.isStandby) {
                    console.log(`[DeviceState] 💤 ${ip} entered Standby.`);
                }
            }
        }
    }

    LAST_VALID_STATE[ip] = result;
    FINAL_STATE[ip] = result;
    OFFLINE_COUNTS[ip] = 0;

}
catch (error) {
    console.error(`[DeviceState] ❌ Error processing settled state for ${ip}:`, error.message);
}
}
// --- SYNCHRONOUS GETTER ---
async function get(device) {
    const currentState = FINAL_STATE[device.ip];

    if (currentState && currentState.online === false) {
        OFFLINE_COUNTS[device.ip] = (OFFLINE_COUNTS[device.ip] || 0) + 1;
        if (OFFLINE_COUNTS[device.ip] <= MAX_OFFLINE_RETRIES && LAST_VALID_STATE[device.ip]) {
            return LAST_VALID_STATE[device.ip];
        }
        return { ...device, online: false, readyForDisplay: true };
    }

    // --- RESTORED: Playlist Gap Masking (Replaces STOP_COUNTS) ---
    // If UPnP drops to STOP_STATE, we hold the UI in the previous PLAY_STATE for 4.5 seconds
    // to mask the gap between songs on a playlist.
    if (currentState && currentState.playStatus === 'STOP_STATE' && !currentState.isStandby) {
        const networkSources = ['UPNP', 'AIRPLAY'];
        if (networkSources.includes(currentState.source) && LAST_VALID_STATE[device.ip] && LAST_VALID_STATE[device.ip].playStatus === 'PLAY_STATE') {
            
            if (!STOP_TIMERS[device.ip]) {
                STOP_TIMERS[device.ip] = Date.now();
            }
            
            // If it's been less than 4500ms since we saw the STOP, fake it as still playing
            if (Date.now() - STOP_TIMERS[device.ip] < 4500) {
                return LAST_VALID_STATE[device.ip]; 
            }
        }
    } else {
        delete STOP_TIMERS[device.ip]; // Reset if it starts playing again
    }

    return currentState || { ...device, online: true, readyForDisplay: false };
}

function clearSession(ip) {
    console.log(`[DeviceState] 🧹 Session Cleared for ${ip} (Power Down / Reset)`);
    // Explicitly lock the UI during power down so the power button doesn't bounce!
    EXPECTATIONS[ip] = { type: 'POWER', expires: Date.now() + 5000 };
    if (FINAL_STATE[ip]) FINAL_STATE[ip].readyForDisplay = false;
}

function setExpectation(target, type, value, extraContext = null) {
    // 1. Resolve Target to IP
    let ip = target;
    if (!target.includes('.')) {
        // Normalize the target by stripping colons/dashes and forcing Uppercase
        const cleanTarget = target.replace(/[:-]/g, '').toUpperCase();
        
        for (const [deviceIp, state] of Object.entries(FINAL_STATE)) {
            if (state.mac && state.mac.toUpperCase() === cleanTarget) {
                ip = deviceIp;
                break;
            }
        }
    }

    if (!FINAL_STATE[ip]) return;
    
    // 2. Set the Lock
    EXPECTATIONS[ip] = { type, value, context: extraContext, expires: Date.now() + 8000 };
    console.log(`[DeviceState] 🔒 UI Locked for ${ip}: Waiting for ${type}...`);
    FINAL_STATE[ip].readyForDisplay = false; 
}

module.exports = {
    initDevice,
    get,
    setExpectation,
    clearSession
};
 
// =================================================================
// --- THE GAPLESS WATCHDOG ---
// Bose WebSockets go completely silent during gapless UPnP streams.
// This ultra-lightweight loop pings Music Assistant directly every 2.5 seconds
// to catch track changes instantly without hammering the Bose hardware!
// =================================================================
setInterval(async () => {
    for (const [ip, state] of Object.entries(FINAL_STATE)) {
        // Only check if it's actively playing, driven by MASS, and NOT locked by a user click
        if (state && state.playStatus === 'PLAY_STATE' && state.massIsActiveDriver && !EXPECTATIONS[ip]) {
            try {
                const maData = await mass.getRawMetadata(ip);
                if (maData && maData.item) {
                    const meta = maData.meta || maData.item.metadata || {};
                    let newTrack = scrubText(meta.name || maData.item.name || "");
                    
                    // If MASS reports a new track that isn't the dummy name, trigger an update!
                    if (newTrack && newTrack !== state.track && newTrack !== "Music Assistant") {
                        console.log(`\n[DeviceState] 🐕 Gapless Watchdog caught track change on ${ip}: ${state.track} -> ${newTrack}`);
                        
                        // Force the engine to update the UI instantly
                        await processSettledState(ip);
                    }
                }
            } catch (e) {
                // Silently ignore network blips so the server doesn't crash
            }
        }
    }
}, 2500);	