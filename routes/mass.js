// ==========================================
// SECTION 1: SETUP & CONFIGURATION
// ==========================================
const axios = require('axios');
const http = require('http'); 
const { URL } = require('url');
const MASS_IP = process.env.MASS_IP;
const MASS_PORT = process.env.MASS_PORT;
const MASS_USERNAME = process.env.MASS_USERNAME; 
const MASS_PASSWORD = process.env.MASS_PASSWORD; 
const BASE_URL = `http://${MASS_IP}:${MASS_PORT}/api`;
const BOSE_PORT = process.env.BOSE_PORT || 8090;

// Turns a bare 401 into an actionable message instead of a cryptic error string —
// a stale/mismatched auth credential otherwise just looks like a generic network
// failure with no hint about what actually went wrong or how to fix it.
function describeMassAuthError(e) {
    if (e.response?.status === 401) {
        return `MASS rejected the current credentials (401 Unauthorized). Usually means MASS_TOKEN is stale — left over from a different MASS instance, or orphaned by a MASS reinstall resetting its user database. Clear MASS_TOKEN in .env to use MASS_USERNAME/MASS_PASSWORD instead, or generate a fresh token from MASS's own Settings page.`;
    }
    return e.message;
}

const PLAYER_ID_CACHE = {}; // Caches Player IDs, IPs, Names to reduce 'players/all' network calls.
const PLAYER_IP_CACHE = {}; 
const PLAYER_NAME_CACHE = {}; 
const PRESET_MEMORY = {}; // Stores last used Preset ID for each speaker IP.
const LAST_PLAY_TS = {}; // ip -> epoch ms of the last playMedia() call, any caller/reason
const httpAgent = new http.Agent({ keepAlive: true });
const client = axios.create({httpAgent,timeout: 28000});

// =======================================================================
// SECTION 2: MEMORY & STATE MANAGEMENT
// =======================================================================
function setPresetMemory(ip, id) {
    if (id === 0) {
        // Clears memory if the ID is 0 (indicating a non-preset source).
        delete PRESET_MEMORY[ip]; 
    } else {
        PRESET_MEMORY[ip] = { id: parseInt(id), timestamp: Date.now() };
    }
}

function getPresetMemory(ip) {return PRESET_MEMORY[ip] || null;}
function getLastPlayTs(ip) {return LAST_PLAY_TS[ip] || null;}

// --- GLITCH RECOVERY SYSTEM  ---
// Tracks speakers that recently had timeout error so device_state knows to ignore "Idle" status.
const RECOVERY_MODE = new Set();
let isMassHealthy = true; 
function isRecovering(ip) {return RECOVERY_MODE.has(ip);}
function getHealth() {return isMassHealthy;}
function resetHealth() {isMassHealthy = true;}

// =======================================================================
// SECTION 3: PUBLIC API (PLAYBACK & CONTROL)
// =======================================================================

// play (The Unpauser - Restarts an existing queue)
async function play(target) {
    const player = await resolveTargetPlayer(target);
    if (!player)
        return false;

    console.log(`[MASS] Sending PLAY/UPPAUSE command to ${player.targetName}`);

    try {
        // 1. Attempt standard MA 2.8.5 Native Recovery
        const success = await sendWithRetry(
                player.targetId,
                player.targetIp,
                "player_queues/play", {
                queue_id: player.targetId
            });

        // ========================================================
        // 🛡️ THE AUTO-RESCUE FAILSAFE
        // If native play completely fails (e.g. lost queue context),
        // we extract the URI and force a brand new stream!
        // ========================================================
        if (!success) {
            console.error(`[MASS] ⚠️ Native Playy/UNPAUSE failed. Attempting Hard Stream Rescue via play_media...`);

            // Ask MA what was *supposed* to be playing
            const maData = await getRawMetadata(player.targetIp);

            if (maData && maData.item && maData.item.uri) {
                console.log(`[MASS] 🚑 Rescuing Stream: ${maData.item.name || 'Unknown Track'}`);

                // Force a hard restart using playMedia
                return await playMedia(player.targetIp, {
                    uri: maData.item.uri,
                    name: maData.item.name || "Rescued Stream"
                });
            } else {
                console.error(`[MASS] 💀 Rescue Failed: Could not determine the original URI to restart.`);
                return false;
            }
        }

        return success;

    } catch (error) {
        console.error(`[MASS] ⚠️ Exception during Play/UNPAUSE: ${error.message}`);
        return false;
    }
}

// playMedia (The New Streamer - Starts a brand new track/station)
async function playMedia(target, item) {
    const player = await resolveTargetPlayer(target);
    if (!player) return false;

    // Marks "a play attempt started for this ip right now" — any caller, any reason.
    // Lets other flows (e.g. the handshake-recovery stream rescue) tell whether
    // something already acted on this speaker since a given point in time, so they
    // don't stomp on a fix that already landed.
    LAST_PLAY_TS[player.targetIp] = Date.now();

    console.log(`[MASS] 🎵 Play Request: ${item.name} on ${player.targetName}`);
    await ensureSpeakerOn(player.targetIp);

    // Strip provider instance ID suffix (e.g. spotify--UgwRanCa:// → spotify://) so
    // stored URIs remain valid even if the user re-adds a provider and it gets a new
    // instance ID. MASS accepts the bare domain and routes to the active instance.
    const rawUri = (Array.isArray(item.uri) ? item.uri[0] : item.uri) || "";
    const uri = rawUri.replace(/^([a-zA-Z_]+)--[^:]+:\/\//, '$1://');

    // --- NUCLEAR FIX: CLEAR + DELAY + PLAY ---
    console.log(`[MASS] 🧹 Clearing Queue for ${player.targetName}...`);
    await sendWithRetry(player.targetId, player.targetIp, "player_queues/clear", { queue_id: player.targetId }, { kickstart: false });

    // Safety Pause
    await new Promise(r => setTimeout(r, 250));

    // Play Command with explicit OpenAPI parameters
    const args = { 
        queue_id: player.targetId, 
        media: [uri], 
        enqueue: "play",      
        radio_mode: false,    
        autostart: true
    };

    const success = await sendWithRetry(player.targetId, player.targetIp, "player_queues/play_media", args, { kickstart: false, forceSuccess: true });
    
    // (Ensure you keep your applySettings function if you had one, otherwise remove this line)
    if (success && item.settings && typeof applySettings === 'function') applySettings(player.targetId, item.settings);
    return success;
}

//  Command Wrappers using executeCommand helper
async function next(target) { await executeCommand(target, "player_queues/next"); }
async function previous(target) { await executeCommand(target, "player_queues/previous"); }
async function pause(target) { await executeCommand(target, "player_queues/pause", { kickstart: false }); }
async function stop(target, reason="Unknown") { await executeCommand(target, "player_queues/stop", { kickstart: false }); }
async function cmdStop(target) {
    const { id, ip } = await resolvePlayer(target);
    if (!id) return;
    return await sendWithRetry(id, ip, "players/cmd/stop", { player_id: id }, { kickstart: false });
}
// Applies Shuffle/Repeat settings after playback starts.
// 2-second delay to ensure player has fully transitioned to Playing state before accepting settings.
async function applySettings(playerId, settings) {
    const token = await getToken();
    const headers = { 'Authorization': `Bearer ${token}` };
    setTimeout(() => {
        if (settings.shuffle !== undefined) client.post(`${BASE_URL}`, { command: "player_queues/shuffle", args: { queue_id: playerId, shuffle_enabled: settings.shuffle }, message_id: Date.now() }, { headers }).catch(()=>{});
        if (settings.repeat && settings.repeat !== 'off') client.post(`${BASE_URL}`, { command: "player_queues/repeat", args: { queue_id: playerId, repeat_mode: settings.repeat }, message_id: Date.now() }, { headers }).catch(()=>{});
    }, 2000); 
}

async function clearQueue(target) {
    const { id, ip } = await resolvePlayer(target);
    if (!id) return;
    console.log(`[MASS] 🧹 Manual Queue Clear for ${id}`);
    return await sendWithRetry(id, ip, "player_queues/clear", { queue_id: id }, { kickstart: false });
}

// =======================================================================
// SECTION 4: RESOLUTION & METADATA
// =======================================================================

// Resolves a target (IP or ID) into a full Player Object (ID, IP, Name).
// checks local cache first; if missing, queries Music Assistant API.
async function resolvePlayer(target, maxRetries = 8) {
    if (PLAYER_ID_CACHE[target]) {
        const id = PLAYER_ID_CACHE[target];
        return { id: id, ip: target, name: PLAYER_NAME_CACHE[id] || "Unknown Speaker" };
    }
    if (PLAYER_IP_CACHE[target]) {
        const ip = PLAYER_IP_CACHE[target];
        return { id: target, ip: ip, name: PLAYER_NAME_CACHE[target] || "Unknown Speaker" };
    }

    let playerId = null;
    let playerIp = null;
    let playerName = "Unknown Speaker";
    
    const token = await getToken();
    
    if (token) {
        // THE FIX: Loop to wait for Bose UPnP discovery after waking from standby!
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                const res = await client.post(`${BASE_URL}`, { command: "players/all", message_id: 99 }, { headers: { 'Authorization': `Bearer ${token}` } });
                const players = res.data || [];
                
                // Finds the player by ID, IP, or Partial IP.
                const match = players.find(p => {
                    const pIp = p.device_info?.ip_address || "";
                    if (p.player_id === target) return true;
                    if (pIp === target) return true;
                    if (pIp.includes(target)) return true;
                    return false;
                });

				if (match) {
                    // --- THE DLNA DROP DETECTOR ---
                    // If MA sees the speaker but marks it "unavailable" (Greyed out in UI)
                    if (match.available === false) {
                        if (attempt < maxRetries) {
                            console.log(`[MASS] ⏳ Speaker ${target} found, but MA says it's unavailable. Waiting (Attempt ${attempt}/${maxRetries})...`);
                            await new Promise(r => setTimeout(r, 2000));
                            continue; // Skip cache save and try again!
                        } else {
                            console.error(`[MASS] 🚨 MA permanently lost DLNA connection to ${target}. Marking MA Unhealthy!`);
                            isMassHealthy = false; // Trigger the red UI banner!
							// 🌟 NEW: Extract the real IP from the MA device info
							const pingIp = match.device_info?.ip_address || target;
							playHealthWarning(pingIp);
                            break; // Abort
                        }
                    }

                    playerId = match.player_id;
                    playerName = match.display_name || match.name || "Unknown Speaker";
                    let rawIp = match.device_info?.ip_address || target;
                    
                    // Normalizes IP if it comes formatted as a URL.
                    if (rawIp.includes("http")) {
                        try { playerIp = new URL(rawIp).hostname; } catch(e) { playerIp = target; }
                    } else { playerIp = rawIp; }
                    
                    // Updates the cache for future lookups.
                    PLAYER_ID_CACHE[playerIp] = playerId;
                    PLAYER_IP_CACHE[playerId] = playerIp;
                    PLAYER_NAME_CACHE[playerId] = playerName;
                    
                    return { id: playerId, ip: playerIp, name: playerName }; // SUCCESS!
                } else {
                    if (attempt < maxRetries) {
                        console.log(`[MASS] ⏳ Speaker ${target} not visible to MASS yet. Waiting for UPnP discovery (Attempt ${attempt}/${maxRetries})...`);
                        await new Promise(r => setTimeout(r, 2000)); // Wait 2 seconds and check again
					} else {
                        console.error(`\n[MASS] 🚨 CRITICAL: MASS completely dropped ${target} from its registry!`);
                        console.error(`[MASS] 🚨 Cause: The DLNA socket died. Marking MASS Unhealthy and triggering UI Banner.\n`);
                        isMassHealthy = false; // Trigger the red UI banner!
						// 🌟 Extract the real IP from the MA device info
						const pingIp = match.device_info?.ip_address || target;
						playHealthWarning(pingIp);
						
                    }
                }
            } catch (e) {
                console.error(`[MASS] ⚠️ resolvePlayer API Error for ${target}: ${describeMassAuthError(e)}`);
                break; // Exit loop on hard network crashes
            }
        }
    } else {
        console.error(`[MASS] ⚠️ resolvePlayer failed: Auth Token is null.`);
    }
    return { id: playerId, ip: playerIp, name: playerName };
}

// Fetches the raw queue and metadata for a specific player.
async function getRawMetadata(targetIp) {
    const { id: playerId } = await resolvePlayer(targetIp);
    if (!playerId) return null;

    const token = await getToken();
    if (!token) return null;

    try {
        const res = await client.post(`${BASE_URL}`, { 
            command: "player_queues/all", 
            message_id: Date.now() 
        }, { headers: { 'Authorization': `Bearer ${token}` } });
        
        const queues = res.data || [];
        const queue = queues.find(q => q.queue_id === playerId);

        if (queue && queue.current_item) {
            return {
                meta: queue.current_item.media_item || queue.current_item,
                item: queue.current_item,
                state: queue.state
            };
        }
    } catch (e) { }
    return null;
}

// Checks the playback state (playing, paused, idle) of a player.
async function getMassState(playerId) {
    const token = await getToken();
    if (!token) return 'UNKNOWN';
    try {
        const res = await client.post(`${BASE_URL}`, { 
            command: "players/all", 
            message_id: Date.now() 
        }, { headers: { 'Authorization': `Bearer ${token}` } });
        const players = res.data || [];
        const p = players.find(x => x.player_id === playerId);
        return p ? p.state : 'UNKNOWN'; 
    } catch(e) { return 'UNKNOWN'; }
}


// INTERNAL HELPER: Resolve Master/Slave Grouping
// Contains the complete Bose XML and MASS MAC-fallback logic.
async function resolveTargetPlayer(target) {
    const initial = await resolvePlayer(target);
    
    if (!initial || !initial.id) {
        console.error(`[MASS] ❌ Play Aborted! Could not resolve MASS Player ID for target: ${target}`);
        return null;
    }

    let targetId = initial.id;
    let targetIp = initial.ip;
    let targetName = initial.name;

    try {
        // Redirection Logic: Checks if the speaker is a "Slave" in a SoundTouch Group.
        const [zoneRes, infoRes] = await Promise.all([
            axios.get(`http://${targetIp}:8090/getZone`, { timeout: 1500 }).catch(()=>({data:"ERR"})),
            axios.get(`http://${targetIp}:8090/info`, { timeout: 1500 }).catch(()=>({data:"ERR"}))
        ]);

        if (zoneRes.data !== "ERR" && infoRes.data !== "ERR") {
            const masterMatch = zoneRes.data.match(/master="([^"]+)"/);
            const myMacMatch = infoRes.data.match(/deviceID="([^"]+)"/);

            const masterMac = masterMatch ? masterMatch[1] : "NONE";
            const myMac = myMacMatch ? myMacMatch[1] : "UNKNOWN";

            if (masterMac !== "NONE" && masterMac !== myMac) {
                let masterFound = false;
                // Extracts Master IP from the Zone XML.
                const ipRegex = new RegExp(`ipaddress="([^"]+)">\\s*${masterMac}`, 'i');
                const ipMatch = zoneRes.data.match(ipRegex);

                if (ipMatch) {
                    const masterIpFromXml = ipMatch[1];
                    const resolvedByIp = await resolvePlayer(masterIpFromXml);
                    if (resolvedByIp && resolvedByIp.id) {
                        targetId = resolvedByIp.id;
                        targetIp = resolvedByIp.ip;
                        targetName = resolvedByIp.name;
                        masterFound = true;
                        console.log(`[MASS] Redirection: Slave detected. Redirecting to Master -> ${targetName}`);
                    }
                }

                // Fallback: Resolves Master by MAC address if IP extraction fails.
                if (!masterFound) {
                    const token = await getToken();
                    if (token) {
                        const playersRes = await client.post(`${BASE_URL}`, { command: "players/all", message_id: Date.now() }, { headers: { 'Authorization': `Bearer ${token}` } });
                        const allPlayers = playersRes.data || [];
                        const cleanMasterMac = masterMac.replace(/[:\-]/g, '').toUpperCase();
                        
                        const masterPlayer = allPlayers.find(p => {
                            const pMac = p.device_info?.mac_address || "";
                            if (pMac.replace(/[:\-]/g, '').toUpperCase() === cleanMasterMac) return true;
                            if (p.player_id.toUpperCase().includes(cleanMasterMac)) return true;
                            return false;
                        });
                        
                        if (masterPlayer) {
                            targetId = masterPlayer.player_id;
                            targetName = masterPlayer.display_name || masterPlayer.name;
                            let rawIp = masterPlayer.device_info?.ip_address || "";
                            if (rawIp.includes("http")) { try { targetIp = new URL(rawIp).hostname; } catch(e) {} } else if (rawIp) { targetIp = rawIp; }
                            console.log(`[MASS] Redirection (via MAC): Slave detected. Redirecting to Master -> ${targetName}`);
                        }
                    }
                }
            }
        }
    } catch (e) { }

    return { targetId, targetIp, targetName };
}

// =======================================================================
// SECTION 5: HARDWARE & LOW-LEVEL HELPERS
// =======================================================================

// Token cache — one login per 24h; re-auth on explicit forceRefresh (triggered on 401)
let _cachedToken = null;
let _tokenExpiry  = 0;

// Username/password is tried first: it always resolves to whichever user
// currently exists on the MASS instance. A static MASS_TOKEN is permanently
// bound to the user_id it was issued for, so it silently breaks forever if
// that user ever gets recreated (e.g. a MASS reinstall resetting the user
// database) — username/password survives that, so it's the more resilient
// default. MASS_TOKEN is kept only as a fallback for setups without
// MASS_USERNAME/MASS_PASSWORD configured, or if login itself fails.
async function getToken(forceRefresh = false) {
    if (!forceRefresh && _cachedToken && Date.now() < _tokenExpiry - 60_000) {
        return _cachedToken;
    }

    const reason = forceRefresh ? 'token rejected by MASS (re-auth)' : 'no valid cached token';
    console.log(`[MASS] Authenticating with Music Assistant (${reason})...`);

    if (MASS_USERNAME && MASS_PASSWORD) {
        try {
            const res = await axios.post(`http://${MASS_IP}:${MASS_PORT}/auth/login`, {
                credentials: { username: MASS_USERNAME, password: MASS_PASSWORD }
            }, { timeout: 8000 });

            _cachedToken = res.data.token || res.data.access_token || res.data.sid || null;
            _tokenExpiry  = Date.now() + 24 * 60 * 60 * 1000;

            if (_cachedToken) {
                console.log(`[MASS] ✓ Auth token ${forceRefresh ? 're-acquired' : 'acquired'} via username/password — cached for 24h.`);
                return _cachedToken;
            }
            console.error(`[MASS] ❌ Auth request succeeded but response contained no token. Check MASS API format.`);
        } catch (e) {
            console.error(`[MASS] ⚠️ Username/password login failed: ${e.message}${process.env.MASS_TOKEN ? ' — falling back to MASS_TOKEN.' : ''}`);
        }
    }

    if (process.env.MASS_TOKEN) {
        _cachedToken = process.env.MASS_TOKEN;
        _tokenExpiry  = Date.now() + 24 * 60 * 60 * 1000;
        console.log(`[MASS] ✓ Using MASS_TOKEN fallback — cached for 24h.`);
        return _cachedToken;
    }

    _cachedToken = null;
    _tokenExpiry  = 0;
    console.error(`[MASS] ❌ Authentication failed: no working username/password or MASS_TOKEN available.`);
    return null;
}

// Sends a physical key press simulation to the Bose speaker (e.g., POWER, PLAY).
async function sendBoseKey(ip, key) {
    try {
        const keyXml = `<key state="press" sender="Gabbo">${key}</key>`;
        await axios.post(`http://${ip}:${BOSE_PORT}/key`, keyXml, { timeout: 2000 });
        await axios.post(`http://${ip}:${BOSE_PORT}/key`, keyXml.replace("press", "release"), { timeout: 2000 });
        return true;
    } catch (e) { return false; }
}

// Retrieves the hardware status from the Bose speaker directly (bypassing Mass).
async function getBoseStatus(ip) {
    try {
        const res = await axios.get(`http://${ip}:${BOSE_PORT}/now_playing`, { timeout: 2000 });
        const sourceMatch = res.data.match(/source="([^"]+)"/);
        const statusMatch = res.data.match(/playStatus="([^"]+)"/); 
        const trackMatch  = res.data.match(/<track>([^<]+)<\/track>/); 
        return {
            source: sourceMatch ? sourceMatch[1] : "UNKNOWN",
            state: statusMatch ? statusMatch[1] : "UNKNOWN",
            track: trackMatch ? trackMatch[1] : null
        };
    } catch(e) { return null; }
}

// Verifies if the speaker is in STANDBY and wakes it up if necessary.
async function ensureSpeakerOn(ip) {
    if (!ip) return; 
    const status = await getBoseStatus(ip);
    
    if (status && status.source === "STANDBY") {
        console.log(`   💤 Speaker is OFF (Confirmed Standby). Waking up...`);
        await sendBoseKey(ip, "POWER");
        // Waits 4.5 seconds for the hardware to boot up and reconnect to Wi-Fi.
        await new Promise(r => setTimeout(r, 4500)); 
    } else if (!status) {
        console.log(`   ⚠️ Could not verify power state for ${ip}. Assuming ON to be safe.`);
    }
}

// =======================================================================
// SECTION 6: TRANSPORT)
// =======================================================================

// Sends a JSON-RPC command to Music Assistant with retry logic.
// Handles timeouts, socket disconnects, and kickstarting stalled speakers.
async function sendWithRetry(playerId, playerIp, command, args, options = {}) {
    let token = await getToken();
    if (!token) {
        console.error(`[MASS] ❌ sendWithRetry: No auth token available. Cannot execute "${command}".`);
        return false;
    }

    let headers = { 'Authorization': `Bearer ${token}` };
    const MAX_RETRIES = (options.retries !== undefined) ? options.retries : 2;
    const ALLOW_KICKSTART = (options.kickstart !== undefined) ? options.kickstart : true;
    const FORCE_SUCCESS = (options.forceSuccess !== undefined) ? options.forceSuccess : false;

    let attempt = 1;
    let lastStatus = null;

    while (attempt <= MAX_RETRIES) {
        try {
            if (attempt > 1) console.log(`   🔄 Retry ${attempt}/${MAX_RETRIES} for ${command}...`);
            await client.post(`${BASE_URL}`, { command, args, message_id: Date.now() }, { headers });

            isMassHealthy = true; // ✅ SOCKET IS HEALTHY
            return true;

        } catch (e) {
            lastStatus = e.response?.status;
            const isTimeout = e.code === 'ECONNABORTED' || e.message.includes('timeout');

            // --- DYNAMIC ERROR EXTRACTOR ---
            // Extract the exact error message text from Music Assistant
            let errorText = e.message; // Fallback to generic Node error
            if (e.response && e.response.data) {
                errorText = typeof e.response.data === 'object' ? JSON.stringify(e.response.data) : String(e.response.data);
            }

            // Print exactly what Music Assistant is complaining about
            if (lastStatus) {
                console.error(`\n❌ [ATTEMPT ${attempt}] MASS HTTP ${lastStatus} on ${command}`);
                console.error(`   Message: ${errorText}`);
            }

            // 401 = cached token was rejected (MASS restarted or token revoked).
            // Re-authenticate once and retry the command without burning the retry counter.
            if (lastStatus === 401) {
                console.warn(`[MASS] ⚠️ HTTP 401 on "${command}" — cached token rejected. Re-authenticating...`);
                const newToken = await getToken(true);
                if (!newToken) {
                    console.error(`[MASS] ❌ Re-authentication failed. Aborting "${command}".`);
                    return false;
                }
                token   = newToken;
                headers = { 'Authorization': `Bearer ${token}` };
                console.log(`[MASS] Re-auth successful. Retrying "${command}"...`);
                continue; // retry with fresh token, attempt counter unchanged
            }

			// If MA throws a 500 error, cannot tell if it's an Empty Playlist or a Dead Socket.
            // Gracefully abort and trigger the UI banner
            if (lastStatus === 500 && (errorText.toLowerCase().includes('playable') || errorText.toLowerCase().includes('found') || errorText.toLowerCase().includes('empty') || errorText.toLowerCase().includes('internal server error') || errorText.toLowerCase().includes('available'))) {
                console.error(`\n[MASS] 🚫 ACTION ABORTED: MA returned HTTP 500.`);
                console.error(`[MASS] 🚫 Cause: Invalid Media (Empty/Dead Stream) OR a Dropped DLNA Socket.`);
                console.error(`[MASS] 🚨 Marking MASS Unhealthy and triggering UI Banner.\n`);
                isMassHealthy = false; // ✅ THIS TRIGGERS THE UI BANNER!
				playHealthWarning(playerIp);
                return false;
            }

            // Handles connection errors (500, Reset, Timeout).
            if (lastStatus === 500 || e.code === 'ECONNRESET' || isTimeout) {
                
                // If FORCE_SUCCESS is true, assume the command worked to prevent double-firing.
                // HOWEVER: If it's a 500 error, do NOT blindly assume success. Force it to check the speaker!
                if (FORCE_SUCCESS) {
                    console.log(`      ⚠️ ${command} timed out/failed, but assuming success to prevent double-play.`);
                    
                    // --- RECORD THE GLITCH ---
                    if (playerIp) {
                        RECOVERY_MODE.add(playerIp);
                        // Flag this speaker as "Recovering" for 15 seconds so device_state ignores "Idle"
                        setTimeout(() => RECOVERY_MODE.delete(playerIp), 15000);
                    }
                    
                    return true;
                }
                
                console.error(`   ⚠️ Connection Error on ${command}. Checking Speaker State...`);
                await new Promise(r => setTimeout(r, 1000)); 
                
                // Checks if the speaker is actually playing despite the error.
                if (playerIp) {
                    const check = await getBoseStatus(playerIp);
                    if (check) {
                        const isPlaying = (check.state === 'PLAY_STATE' || check.state === 'BUFFERING_STATE');
                        if (isPlaying) {
                            console.log(`      ✅ Speaker IS playing. Ignoring timeout.`);
                            return true;
                        }
                        // If stalled, sends a physical PLAY key to kickstart the stream.
                        if (ALLOW_KICKSTART && check.track && !isPlaying) {
                            console.log(`      Starting stalled speaker (Native PLAY)...`);
                            await sendBoseKey(playerIp, "PLAY");
                            await new Promise(r => setTimeout(r, 1000));
                            return true; 
                        }
                    }
                }
                attempt++;
            } else {
                console.error(`   ❌ Fatal Error: ${e.message}`);
                return false;
            }
        }
    }
    // --- 🚨 THE TRUE DEATH TRAP 🚨 ---
    // If reached this point, it means ALL retries, kickstarts, and FORCE_SUCCESS 
    // bypasses failed. The command is genuinely dead and unrecoverable.
    if (lastStatus === 500) {
        console.error(`\n🚨 MASS DLNA SOCKET DEATH DETECTED! Unrecoverable 500 Error on ${command}`);
        isMassHealthy = false; 
		playHealthWarning(playerIp);
    }
    return false;
}

// Helper to handle resolving player ID + executing a simple command (Next, Prev, Stop).
async function executeCommand(target, command, options = {}) {
    const { id, ip } = await resolvePlayer(target);
    if (!id) return;
    // Passes options (kickstart, retries) through to sendWithRetry.
    return await sendWithRetry(id, ip, command, { queue_id: id }, options);
}


async function sendAdminCommand(command, args = {}) {
    let token = await getToken();
    if (!token) throw new Error(`[MASS] Auth token unavailable — cannot execute admin command "${command}"`);

    const doRequest = async (tok) => {
        const res = await client.post(`${BASE_URL}`, {
            command, args, message_id: Date.now()
        }, { headers: { 'Authorization': `Bearer ${tok}` } });
        // 🚨 Catch MA JSON-RPC errors hiding inside HTTP 200 OK responses
        if (res.data && res.data.error) {
            throw new Error(res.data.error.message || JSON.stringify(res.data.error));
        }
        return res.data;
    };

    try {
        return await doRequest(token);
    } catch (e) {
        if (e.response?.status === 401) {
            console.warn(`[MASS] ⚠️ HTTP 401 on admin command "${command}" — cached token rejected. Re-authenticating...`);
            token = await getToken(true);
            if (!token) throw new Error(`[MASS] Re-authentication failed — cannot execute admin command "${command}"`);
            console.log(`[MASS] Re-auth successful. Retrying admin command "${command}"...`);
            return await doRequest(token);
        }
        throw e;
    }
}

// =======================================================================
// SECTION: HEALTH WARNING (AUDIO BEEP)
// =======================================================================
async function playHealthWarning(speakerIp) {
    if (!speakerIp) return;
    
    // We use standard http:// (no 's') and LOCAL_INTERNET_RADIO.
    // This tricks the Bose API into playing a raw .mp3 file from the web.
    const xmlPayload = `
        <ContentItem source="LOCAL_INTERNET_RADIO" location="http://www.soundjay.com/buttons/sounds/beep-01a.mp3" isPresetable="false">
            <itemName>System Alert</itemName>
        </ContentItem>
    `;

    try {
        console.log(`[Alert] ⚠️ Sending beep warning to ${speakerIp}...`);
        await axios.post(`http://${speakerIp}:${BOSE_PORT}/select`, xmlPayload, {
            headers: { 'Content-Type': 'application/xml' },
            timeout: 3000
        });
    } catch (err) {
        console.error(`[Alert] ❌ Failed to play warning on ${speakerIp}`);
    }
}
// =======================================================================
// SECTION: NETWORK RECOVERY & KEEP-ALIVE (DLNA & AIRPLAY)
// =======================================================================
async function forceRescan(aggressive = false, targetProvider = 'dlna') {
    try {
        if (aggressive) {
            console.log(`[MASS] Reloading MA ${targetProvider.toUpperCase()} Provider...`);
            await sendAdminCommand('config/providers/reload', { instance_id: targetProvider });
			// ==============================================================
            // 🧹 NEW: FLUSH THE RAM CACHES
            // Because the provider reloaded, MASS generated new Player IDs.
            // We must wipe our memory so we are forced to fetch the new ones!
            // ==============================================================
            for (const key in PLAYER_ID_CACHE) delete PLAYER_ID_CACHE[key];
            for (const key in PLAYER_IP_CACHE) delete PLAYER_IP_CACHE[key];
            for (const key in PLAYER_NAME_CACHE) delete PLAYER_NAME_CACHE[key];			
            // Give the provider 1.5 seconds to boot up
            await new Promise(r => setTimeout(r, 1500));
            return true;
        }

        console.log(`[MASS] Sending keep-alive ping to MA (players/all)...`);
        await sendAdminCommand('players/all', {});
        return true;
        
    } catch (err) {
        // catches JSON errors from wrapper
        console.error(`[MASS] ❌ Failed to send rescan command: ${err.response?.data || err.message}`);
        return false;
    }
}
// =======================================================================
// SECTION 7: VOLUME SYNC
// =======================================================================

// Pushes the speaker's current volume to MASS so that MASS's stored volume
// stays in sync with what the user actually set (via remote, speaker buttons,
// or the Hybrid UI). Called on standby transition so MASS doesn't override the
// user's volume on the next power-on when "Volume Control" is enabled in MA.
async function syncVolumeToMass(ip, volumeLevel) {
    const { id } = await resolvePlayer(ip);
    if (!id) return;
    const token = await getToken();
    if (!token) return;
    try {
        await client.post(`${BASE_URL}`, {
            command: "players/cmd/volume_set",
            args: { player_id: id, volume_level: volumeLevel },
            message_id: Date.now()
        }, { headers: { 'Authorization': `Bearer ${token}` } });
        console.log(`[MASS] 🔊 Volume synced for ${ip}: MASS updated to ${volumeLevel}`);
    } catch (e) {
        console.log(`[MASS] ⚠️ Volume sync failed for ${ip}: ${e.message}`);
    }
}

// Sets a speaker's volume directly — same underlying MASS command as
// syncVolumeToMass above, but the other direction: that one pushes the
// speaker's observed volume up to MASS, this one tells MASS (and therefore
// the speaker) what volume to be at. Used by scheduled play's optional
// per-event volume override — left unset, a scheduled play leaves whatever
// volume the speaker is already at untouched.
async function setVolume(ip, volumeLevel) {
    const { id } = await resolvePlayer(ip);
    if (!id) return false;
    const token = await getToken();
    if (!token) return false;
    try {
        await client.post(`${BASE_URL}`, {
            command: "players/cmd/volume_set",
            args: { player_id: id, volume_level: volumeLevel },
            message_id: Date.now()
        }, { headers: { 'Authorization': `Bearer ${token}` } });
        console.log(`[MASS] 🔊 Volume set for ${ip}: ${volumeLevel}`);
        return true;
    } catch (e) {
        console.log(`[MASS] ⚠️ Volume set failed for ${ip}: ${e.message}`);
        return false;
    }
}

// =======================================================================
// SECTION 8: EXPORTS
// =======================================================================
module.exports = {
    play,
    playMedia,
    stop,
    cmdStop,
    next,
    previous,
    pause,
    clearQueue,
    getRawMetadata,
    getToken,
    describeMassAuthError,
    setPresetMemory,
    getPresetMemory,
    getLastPlayTs,
    isRecovering,
    getHealth,
    resetHealth,
    playHealthWarning,
    forceRescan,
    syncVolumeToMass,
    setVolume
};