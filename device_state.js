const axios = require('axios');
const xml2js = require('xml2js');
const fs = require('fs');
const path = require('path');

// --- IMPORTS ---
const mass = require('./routes/mass'); 
const utils = require('./routes/utils'); 

// --- STATE MANAGEMENT ---
// SHADOWS: Temporarily stores expected states (Locks) to mask latency during user interactions.
const SHADOWS = {};
// LAST_METADATA: Remembers track info during Pause states so the UI doesn't go blank.
const LAST_METADATA = {}; 
const DEBUG_STATE = {}; 
const LAST_READY_STATE = {}; 

// NEW: Offline Masking (Debounce)
// Prevents the UI from flickering "Offline" during brief network blips.
const LAST_VALID_STATE = {};
const OFFLINE_COUNTS = {};
const STOP_COUNTS = {}; 
const MAX_OFFLINE_RETRIES = 5; 

// TIMEOUT CONFIGURATION
const TRANSITION_TIMEOUT = 60000;  
const PAUSE_TIMEOUT = 600000;      

// BAD_META: List of keywords indicating the speaker is not playing real content.
const BAD_META = ["MUSIC ASSISTANT", "READY", "OBJECT", "LOADING...", "", "AIRPLAY", "UNKNOWN", "STOPPED", "STANDBY", "UPNP", "INVALID_SOURCE"];

// --- HELPERS ---

// Checks if the provided track string matches any invalid or placeholder keywords.
// Returns true if the metadata is considered "junk" or empty.
const isBadMeta = (t) => !t || BAD_META.includes(t.toUpperCase());

// --- EXPORTED ACTIONS ---

// Clears all locks and memory for a specific device IP.
// Used when the device is powered off or a new session begins.
function clearSession(ip) {
    console.log(`[DeviceState] 🧹 Session Cleared for ${ip}`);
    delete SHADOWS[ip];
    delete LAST_METADATA[ip];
    STOP_COUNTS[ip] = 0; 
}

// Sets a "Shadow Lock" (Expectation) for the device.
// This tells the system to ignore polling data until the device matches the expected value (e.g., "PLAYING").
function setExpectation(ip, type, value, extraContext = null) {
    SHADOWS[ip] = {
        type: type,       
        value: value,     
        context: extraContext ? extraContext.trim() : '', 
        timestamp: Date.now(),
        stability: 0,
        seenBuffering: false, 
        verified: false 
    };
    STOP_COUNTS[ip] = 0; 
}

// Normalizes the ContentItem object from the Bose XML.
// Ensures consistent field names for source, type, and location.
function cleanContentItem(raw, playStatus) {
  if (!raw) return { source: "Ready" };
  const attr = raw.$ || {};
  let source = raw.source || attr.source || "Ready";
  let type = raw.type || attr.type || "";
  let location = raw.location || attr.location || "";
  let itemName = raw.itemName || "";
  
  // Standardizes "STORED_MUSIC" (Presets) to a simpler "Preset" label.
  if (source === 'STORED_MUSIC') source = 'Preset'; 
  
  // Defaults the source to 'Ready' if the device is stopped or the source is invalid.
  if (playStatus === 'STOP_STATE' || source === 'INVALID_SOURCE') source = 'Ready';
  
  return { 
      source, type, location, itemName, 
      containerArt: raw.containerArt || raw.art || (raw.img ? raw.img._ : "") || "" 
  };
}

// Main polling function. Retrieves, sanitizes, and consolidates device state.
async function get(device) {
    try {
        // ADDED: Fetch /presets to do the reverse lookup
        const [np, vol, info, zone, presets] = await Promise.all([
            axios.get(`http://${device.ip}:8090/now_playing`, { timeout: 1000 }).catch(() => null),
            axios.get(`http://${device.ip}:8090/volume`, { timeout: 1000 }).catch(() => null),
            axios.get(`http://${device.ip}:8090/info`, { timeout: 1000 }).catch(() => null),
            axios.get(`http://${device.ip}:8090/getZone`, { timeout: 1000 }).catch(() => null),
            axios.get(`http://${device.ip}:8090/presets`, { timeout: 1000 }).catch(() => null) 
        ]);

        if (np && vol && info) {
            const parser = new xml2js.Parser({ explicitArray: false });
            const [npD, volD, infoD, zoneD, presetsD] = await Promise.all([
                parser.parseStringPromise(np.data),
                parser.parseStringPromise(vol.data),
                parser.parseStringPromise(info.data),
                zone && zone.data ? parser.parseStringPromise(zone.data) : { zone: null },
                presets && presets.data ? parser.parseStringPromise(presets.data) : { presets: null }
            ]);
            
            // Resets offline counter on successful fetch.
            OFFLINE_COUNTS[device.ip] = 0;

            const myMac = infoD.info.deviceID || (infoD.info.$ && infoD.info.$.deviceID);
            
            // Determines if this device is a Master or a Slave in a SoundTouch Group.
            let masterMac = null;
            if (zoneD.zone) {
                if (zoneD.zone.master) masterMac = zoneD.zone.master;
                else if (zoneD.zone.$ && zoneD.zone.$.master) masterMac = zoneD.zone.$.master;
            }
            const isMaster = (!masterMac || masterMac === myMac);

            // --- RAW DATA EXTRACT ---
			let track = (npD.nowPlaying.track || '').trim();
            let artist = (npD.nowPlaying.artist || '').trim();
            let album = (npD.nowPlaying.album || '').trim();
            let art = npD.nowPlaying.art ? npD.nowPlaying.art._ : null;
            let station = npD.nowPlaying.stationName || '';
            const source = npD.nowPlaying.$.source;
            const isStandby = source === 'STANDBY';
            const rawStatus = npD.nowPlaying.playStatus || 'STOP_STATE'; 

            // --- 1. DETERMINE "REAL" STATUS (Virtual State) ---
            // Checks if a Shadow Lock exists that forces the state to "NOT_PLAYING".
            // This allows the UI to show "Paused" immediately, even if the hardware lags.
            const isPausedByShadow = (SHADOWS[device.ip] && SHADOWS[device.ip].type === 'PLAY_STATUS' && SHADOWS[device.ip].value === 'NOT_PLAYING');
            
            let finalPlayStatus = rawStatus;
            if (rawStatus === 'BUFFERING_STATE') finalPlayStatus = 'PLAY_STATE';
            if (isPausedByShadow) finalPlayStatus = 'PAUSE_STATE'; 

            // NOTE: We don't use 'const isStopped' here anymore because we might override finalPlayStatus below.
            
            // --- FLICKER PREVENTION ---
            // If the device reports STOP briefly during a network track change (UPnP/AirPlay),
            // this logic holds the previous valid state for 3 polls (approx 6s) to prevent UI flashing.
            const networkSources = ['UPNP', 'AIRPLAY', 'STORED_MUSIC'];
            if (finalPlayStatus === 'STOP_STATE' && !isPausedByShadow && !isStandby && networkSources.includes(source)) {
                STOP_COUNTS[device.ip] = (STOP_COUNTS[device.ip] || 0) + 1;
                if (STOP_COUNTS[device.ip] < 3 && LAST_VALID_STATE[device.ip]) {
                    return LAST_VALID_STATE[device.ip]; 
                }
            } else {
                STOP_COUNTS[device.ip] = 0;
            }

            // Logs state changes for debugging purposes.
            const debugKey = `${isStandby ? 'OFF' : 'ON'}_${rawStatus}_${track}`;
            if (DEBUG_STATE[device.ip] !== debugKey) {
                console.log(`[DeviceState] 📢 State Change ${device.ip}: ${DEBUG_STATE[device.ip] || 'INIT'} -> ${rawStatus} (Power: ${isStandby ? 'OFF' : 'ON'}, Track: ${track || 'None'})`);
                DEBUG_STATE[device.ip] = debugKey;
            }

            if (track && track.toUpperCase() === 'UPNP') track = '';

			// Wipes session data if the device is turned off.
            if (isStandby) {
                mass.setPresetMemory(device.ip, 0);
                delete LAST_METADATA[device.ip];
				// --- GHOST WAKE KILL-SWITCH ---
                // When physical power button is pressed the speaker drops the audio stream and send a UDP Multicast "Standby"
				//	broadcast to the network. Issue found that on some networks (like Ubiquiti)	this UDP packet
				// is often swallowed (IGMP Snooping). Because MA never gets this it assumes the TCP stream merely glitched
				// and its UPnP auto-recovery loop forces the speaker to wake right back up (The "Zombie" stream issue #8).				
	            // Explicitly halt MA to prevent its auto-recovery from waking the speaker back up.
                if (LAST_VALID_STATE[device.ip] && LAST_VALID_STATE[device.ip].isStandby === false) {
					// --- ANTI-LOOP LOCK ---
                    // Instantly update the local state before firing the external HTTP requests below to prevent
					// asynchronous overlapping "Burst Mode" polls hitting this block multiple times, and causing infinite loops.
                    LAST_VALID_STATE[device.ip].isStandby = true;
                    console.log(`[DeviceState] 🛑 Physical Power-Off detected for ${device.ip}. Forcing MASS to stop...`);
                    mass.stop(device.ip).catch(err => console.log(`[DeviceState] MASS Stop Error: ${err.message}`));
					// explicitly delete MA queue so it doesn't try to wake speaker.
                    mass.clearQueue(device.ip).catch(err => console.log(`[DeviceState] MASS Clear Queue Error: ${err.message}`));
                }
                
                // --- PRESERVE JOIN LOCKS ---
                // If in middle of a JOIN operation, the speaker MUST reboot.
                // so preserve the lock so the UI knows to say "Joining..." instead of "Off".
                const currentLock = SHADOWS[device.ip];
                if (currentLock && currentLock.type === 'JOIN') {
                    // Keep the lock alive
                } else {
                    delete SHADOWS[device.ip];
                }
            }

            // --- DRIVER DETERMINATION ---
            // Checks if Music Assistant (MASS) is the active driver for this device.
            // This occurs if the source is UPnP/AirPlay or if we are Paused via Shadow.
            let massIsActiveDriver = false;
            
            const isGenericMeta = BAD_META.includes(track.toUpperCase()) || !track;
            const isMassSourceType = (source === 'UPNP' || source === 'AIRPLAY');
            const shouldCheckMass = isPausedByShadow || isMassSourceType || (source === 'STORED_MUSIC' && isGenericMeta);       
			
            if (shouldCheckMass && !isStandby) {
                if (isPausedByShadow) massIsActiveDriver = true; 

                try {
                    const maData = await mass.getRawMetadata(device.ip);
                    if (maData) {
                        massIsActiveDriver = true;
                        // If source  AirPlay and Speaker XML gives valid track use it
                        // else use MA data if the speaker is sending "junk" (e.g. "AirPlay" or empty).
                        const keepNativeMeta = (source === 'AIRPLAY' && !isBadMeta(track));
						if (!keepNativeMeta) {
                        // --- SOURCE OF TRUTH OVERRIDE ---
                        // If MA says IDLE, force STOP, regardless of what the speaker is doing (buffering/UPnP/etc)
                        // UNLESS recovering from a timeout glitch.
							if ((maData.state === 'idle' || maData.state === 'stopped') && !mass.isRecovering(device.ip)) {
								finalPlayStatus = 'STOP_STATE'; // <--- FORCE STOP STATE
								track = "";
								artist = "";
								album = "";
								art = null;
								activePreset = 0;
							} 
							else {
								// Extract Metadata only if Playing/Paused
								const meta = maData.meta;
								if (meta) {
									track = meta.name || maData.item.name || "";
									if (meta.artists && Array.isArray(meta.artists)) {
										artist = meta.artists.map(a => a.name).join(', ');
									} else if (meta.artist) {
										artist = meta.artist.name || meta.artist;
									} else { artist = ""; }
									album = meta.album ? (meta.album.name || meta.album) : "";
									
									let rawArtUrl = "";
									let rawProvider = "";
									if (meta.metadata && meta.metadata.images && meta.metadata.images.length > 0) {
										rawArtUrl = meta.metadata.images[0].path;
										rawProvider = meta.metadata.images[0].provider;
									} else if (maData.item.image) {
										rawArtUrl = maData.item.image.path || maData.item.image;
										if (typeof maData.item.image === 'object') rawProvider = maData.item.image.provider;
									}
									art = utils.buildImageUrl(rawArtUrl, rawProvider, maData.item.uri);
								}
							}
                        }
                    }
                } catch(e) { }
            }

            if (track === "Music Assistant") track = ""; 
            
			// --- ZOMBIE KILLER ---
            // If Source is UPnP/AirPlay and metadata is junk, usually force STOP.
            // EXCEPTION: If device is in a Zone (Group), allow it to live because
            // the Controller will overwrite its metadata with the Master's info shortly.
            const inGroup = (zoneD.zone && zoneD.zone.master); // Check if grouped

            if ((source === 'UPNP' || source === 'AIRPLAY') && finalPlayStatus === 'PLAY_STATE') {
                const isJunkMeta = (!track || track === "Ready" || BAD_META.includes(track.toUpperCase()));
                
                // Only kill state if NOT recovering AND NOT in a group AND system is NOT currently "Locked" (expecting a change).
				if (isJunkMeta && !mass.isRecovering(device.ip) && !inGroup && !SHADOWS[device.ip]) {
                    finalPlayStatus = 'STOP_STATE'; 
                    track = "Ready";
                }
            }
										
			const displayTitle = track || station || "";
            const isMetaValid = (displayTitle && !BAD_META.includes(displayTitle.toUpperCase()));

            // --- METADATA PERSISTENCE (Pause/Transition Memory) ---
            if (isMetaValid && !isStandby) {
                LAST_METADATA[device.ip] = { track, artist, album, art, station };
            }
            // If Locked (transitioning) and current meta is junk, keep showing the old meta.
			else if (!isMetaValid && !isStandby && (finalPlayStatus === 'PAUSE_STATE' || SHADOWS[device.ip]) && LAST_METADATA[device.ip]) {
                const saved = LAST_METADATA[device.ip];
                track = saved.track;
                artist = saved.artist;
                album = saved.album;
                art = saved.art;
                station = saved.station;
            }

            const cleanItem = cleanContentItem(npD.nowPlaying.ContentItem, finalPlayStatus);

            // --- DETERMINING ACTIVE PRESET ---
            let activePreset = 0;
            
            if (cleanItem.source === 'Preset' || cleanItem.source === 'STORED_MUSIC') activePreset = parseInt(cleanItem.location) || 0;
            if (activePreset === 0 && cleanItem.itemName) {
                const m = cleanItem.itemName.match(/Preset (\d+)/i);
                if (m) activePreset = parseInt(m[1]);
            }
            if (activePreset === 0 && cleanItem.location) {
                const m = cleanItem.location.match(/\/preset\/(\d+)\.mp3/);
                if (m) activePreset = parseInt(m[1]);
            }

            if (activePreset === 0 && !isStandby && cleanItem.location && presetsD.presets && presetsD.presets.preset) {
                const allPresets = Array.isArray(presetsD.presets.preset) ? presetsD.presets.preset : [presetsD.presets.preset];
                const match = allPresets.find(p => p.ContentItem && p.ContentItem.$.location === cleanItem.location);
                if (match) {
                    activePreset = parseInt(match.$.id);
                }
            }

            // Fallback: Uses Mass Preset Memory for sticky sources (like Spotify/AirPlay).
            if (activePreset === 0 && !isStandby && massIsActiveDriver) {
                const mem = mass.getPresetMemory(device.ip); 
                if (mem) {
                    const stickySources = ['INTERNET_RADIO', 'STORED_MUSIC', 'PANDORA', 'SPOTIFY', 'AIRPLAY', 'UPNP'];
                    if (stickySources.includes(source)) activePreset = mem.id;
                }
            }

			// --- UNIVERSAL HARD STOP CLEANUP ---
            // Centralizes cleanup. If the device is determined to be in 'STOP_STATE',
            // wipe metadata to prevent "Ghost Metadata".
            
            // --- RESPECT LOCKS ---
            // If a Lock exists (e.g. Join or Track Change),  DO NOT wipe the screen
            // even if the hardware reports STOP momentarily.
            const hasActiveLock = (SHADOWS[device.ip] !== undefined);

            if (finalPlayStatus === 'STOP_STATE' && !isStandby && !hasActiveLock) {
                activePreset = 0;
                art = null; 
            }
            
            // --- 2. CALCULATE DISPLAY READINESS (Normalized) ---
            // Determines if the data is complete enough to be rendered on the frontend.
            let readyForDisplay = false;
            
            if (!isStandby) {
                // STOP state is always considered "Ready".
                // PLAY/PAUSE states are only "Ready" if they contain valid (non-generic) metadata.
                const isActive = (finalPlayStatus === 'PLAY_STATE' || finalPlayStatus === 'PAUSE_STATE');
                const hasValidMeta = !isBadMeta(track || station);

                if (finalPlayStatus === 'STOP_STATE' || (isActive && hasValidMeta)) {
                    readyForDisplay = true;
                }
            }

            // --- STABILITY GATEKEEPER ---
            // Checks against any active Shadow Locks (User Expectations).
            // If a lock exists (e.g., user just clicked "Next"), the system verifies if the new data matches the expectation.
            const lock = SHADOWS[device.ip];
            if (lock) {
                const elapsed = Date.now() - lock.timestamp;
                if (rawStatus === 'BUFFERING_STATE') lock.seenBuffering = true;

                let timeoutLimit = TRANSITION_TIMEOUT;
                if (lock.type === 'PLAY_STATUS' && lock.value === 'NOT_PLAYING') timeoutLimit = PAUSE_TIMEOUT;

                if (elapsed > timeoutLimit) { 
                    console.log(`[DeviceState] ⚠️ TIMEOUT for ${device.ip}. Clearing Lock.`);
                    delete SHADOWS[device.ip];
                    if (lock.type === 'PLAY_STATUS' && lock.value === 'NOT_PLAYING') {
                        delete LAST_METADATA[device.ip];
                        track = ""; artist = ""; art = ""; activePreset = 0;
                    }
                    readyForDisplay = true; 
                }
                else {
                    const isNew = (displayTitle && displayTitle !== lock.context && !isBadMeta(displayTitle));
                    let satisfied = false;
                    let debugReason = "";
                    let requiredStability = 2; 

                    if (lock.type === 'TRACK') {
                        if (finalPlayStatus === 'PLAY_STATE' && isNew) {
                            satisfied = true;
                            if (lock.seenBuffering) { requiredStability = 1; debugReason = "Fast Track"; } 
                            else { requiredStability = 6; debugReason = "New Track"; }
                        }
                    }
                    else if (lock.type === 'PLAY_STATUS') {
                        requiredStability = 4;
                        if (lock.value === 'PLAYING') {
                            if (finalPlayStatus === 'PLAY_STATE') { satisfied = true; debugReason = "Resumed"; }
                        } else {
                            if (finalPlayStatus === 'PAUSE_STATE' || finalPlayStatus === 'STOP_STATE') { satisfied = true; debugReason = "Paused/Stopped"; }
                        }
                    }
                    else if (lock.type === 'PRESET') {
                        const idMatch = (activePreset === lock.value);
                        if (idMatch && finalPlayStatus === 'PLAY_STATE') {
                            satisfied = true;
                            if (lock.seenBuffering) { requiredStability = 1; debugReason = "Fast Preset"; }
                            else { requiredStability = 4; debugReason = "Preset + Meta"; }
                        }
                        else if (!idMatch) debugReason = `Wait Preset ID (Want ${lock.value})`;
                        else if (rawStatus === 'BUFFERING_STATE') debugReason = "Buffering";
                    }
                    else if (lock.type === 'JOIN') {
                        if (!isMaster && masterMac) { satisfied = true; debugReason = "Slave Mode"; }
                    }

                    if (satisfied) {
                        lock.stability++; 
                        if (lock.stability >= requiredStability) {
                            if (!lock.verified) {
                                console.log(`[DeviceState] 🔓 VERIFIED ${device.ip} | ${debugReason}`);
                                lock.verified = true;
                            }
                            if (lock.type === 'PLAY_STATUS' && lock.value === 'NOT_PLAYING') { } 
                            else { delete SHADOWS[device.ip]; }
                            readyForDisplay = true;
                        } else {
                            readyForDisplay = false;
                            if (elapsed % 500 < 250) console.log(`[DeviceState] ⏳ STABILIZING ${device.ip} (${lock.stability}/${requiredStability})`);
                        }
                    } else {
                        lock.stability = 0;
                        readyForDisplay = false; 
                    }
                }
            } 

            // Forces slave devices to wait for Master sync data.
            if (!isMaster) readyForDisplay = false;

            if (readyForDisplay && !LAST_READY_STATE[device.ip]) {
                console.log(`[DeviceState] ✅ READY for Display ${device.ip}`);
            }
            LAST_READY_STATE[device.ip] = readyForDisplay;

            const result = {
                ...device,
                online: true,
                mac: myMac,
                type: (infoD.info.type || "Speaker"),
                volume: parseInt(volD.volume.actualvolume),
                activePreset: activePreset,
                isStandby: isStandby,
                source: source,
                playStatus: finalPlayStatus,
                track: track,
                artist: artist,
                album: album, 
                art: art,
                stationName: station,
                ContentItem: cleanItem,
                mode: isMaster ? "MASTER" : "SLAVE", 
                zone: zoneD.zone ? { master: masterMac, member: zoneD.zone.member || [] } : null,
                massIsActiveDriver: massIsActiveDriver,
                readyForDisplay: readyForDisplay 
            };

            LAST_VALID_STATE[device.ip] = result;
            return result;

        } else {
            throw new Error("Missing Data");
        }
    } catch (e) {
        // Handles offline devices with a retry mechanism (Offline Masking).
        // Returns the last known valid state for a few cycles to prevent UI flickering.
        OFFLINE_COUNTS[device.ip] = (OFFLINE_COUNTS[device.ip] || 0) + 1;
        if (OFFLINE_COUNTS[device.ip] <= MAX_OFFLINE_RETRIES && LAST_VALID_STATE[device.ip]) {
            return LAST_VALID_STATE[device.ip];
        }
        return { ...device, online: false };
    }
}

module.exports = { get, setExpectation, clearSession };