const express = require('express');
const router = express.Router();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mass = require('./mass'); // Core Music Assistant logic
const utils = require('./utils'); // Shared utilities (IP parsing, etc.)
const deviceState = require('../device_state'); // REQUIRED for UI Stability (Anti-Flash locks)

// --- CONFIGURATION ---
// Retrieves sensitive connection details from environment variables.
const MASS_IP = process.env.MASS_IP;
const MASS_PORT = process.env.MASS_PORT;
const MASS_BASE_URL = `http://${MASS_IP}:${MASS_PORT}`;

const LIBRARY_FILE = path.join(__dirname, '../library.json');

// --- HELPER: API WRAPPER ---
// Centralizes communication with Music Assistant.
// Handles authentication (Token fetching) and standardizes error responses.
async function massRequest(command, args = {}) {
    try {
        const token = await mass.getToken();
        if (!token) throw new Error("Failed to authenticate with Mass");

        const res = await axios.post(`${MASS_BASE_URL}/api`, {
            command: command,
            args: args,
            message_id: Date.now()
        }, { headers: { 'Authorization': `Bearer ${token}` } });

        return res.data;
    } catch (e) {
        console.error(`[Manager] MASS Error (${command}):`, e.message);
        throw e;
    }
}

// --- HELPER: IMAGE NORMALIZATION ---
// Extracts a valid image URL from the complex nested objects returned by Mass.
// Handles various formats: direct strings, metadata objects, and provider paths.
function normalizeImage(i) {
    if (!i) return utils.DEFAULT_ICON; 

    // Helper to safely extract string values from potentially nested objects
    const unwrap = (val) => {
        if (!val) return null;
        if (typeof val === 'string') return val;
        if (typeof val === 'object') return val.path || val.url || val._ || null;
        return null;
    };

    // prioritized extraction strategy
    const resolve = (obj) => {
        if (!obj) return null;
        
        // 1. Check for Provider Image (Best Quality)
        let img = obj.image || obj.img;
        if (img && typeof img === 'object' && img.provider) {
            return { path: img.path, provider: img.provider };
        }
        
        // 2. Check for Metadata Image Array
        if (obj.metadata && obj.metadata.images && obj.metadata.images.length > 0) {
            const mImg = obj.metadata.images[0];
            return { path: mImg.path, provider: mImg.provider };
        }
        
        // 3. Check for Simple HTTP String
        let simpleStr = unwrap(img) || unwrap(obj.metadata?.image);
        if (simpleStr && simpleStr.startsWith('http')) {
            return { path: simpleStr, provider: null };
        }
        return null;
    };

    // Attempt to resolve image from Item -> Album -> Artist
    let info = resolve(i);
    if (!info && i.album) info = resolve(i.album);
    if (!info && i.artist) info = resolve(i.artist);

    const finalPath = info ? info.path : null;
    const finalProv = info ? info.provider : null;
	
	// If the image is already a direct web link, bypass the local proxy!
    if (finalPath && finalPath.startsWith('http')) {
        return finalPath;
    }
    
    return utils.buildImageUrl(finalPath, finalProv, i.uri);
}

// --- HELPER: SUBTITLE BUILDER ---
// Generates a descriptive subtitle (e.g., "Album • Artist") based on the item type and context.
function buildSubtitle(i, cat, isRecent = false) {
    // Utility to clean up provider names (e.g., "spotify--user" -> "Spotify")
    const cleanProv = (p) => {
        if (!p) return "";
        let clean = p.split('--')[0];
        return clean.charAt(0).toUpperCase() + clean.slice(1);
    };

    const getName = (obj) => (typeof obj === 'string' ? obj : (obj?.name || ""));

    // Logic for "Recents" and "Library" (Detailed Metadata)
    if (isRecent) {
        let parts = [];
        
        if (cat === 'track') {
            let artist = getName(i.artist) || getName(i.artists?.[0]) || getName(i.metadata?.artist);
            let album = getName(i.album) || getName(i.metadata?.album);
            if (album) parts.push(album);
            if (artist) parts.push(artist);
        }
        else if (cat === 'album') {
            parts.push("album");
            let artist = getName(i.artist) || getName(i.artists?.[0]) || getName(i.metadata?.artist);
            if (artist) parts.push(artist);
        }
        else if (cat === 'playlist') {
            parts.push("playlist");
            let owner = i.owner || i.metadata?.owner;
            if (!owner) {
                let prov = i.provider || (i.provider_mappings?.[0]?.provider_domain) || "";
                owner = cleanProv(prov);
            }
            if (owner.includes('--')) owner = cleanProv(owner);
            parts.push(owner);
        }
        else {
            // Fallback for Artist/Radio
            parts.push(cat);
            let prov = i.provider || (i.provider_mappings?.[0]?.provider_domain) || "Library";
            parts.push(cleanProv(prov));
        }
        return parts.join(' • ');
    }

    // Logic for "Search" Results (Standard/Concise)

    let rawProv = i.provider || (i.provider_mappings?.[0]?.provider_domain) || "Library";
    if (rawProv.includes('file') || rawProv.includes('library')) rawProv = "Local NAS";
    let pName = cleanProv(rawProv);

    if (cat === 'playlist') {
        let who = i.owner || i.metadata?.owner || "Unknown";
        return `By ${who} • ${pName}`; 
    }
    if (cat === 'track') {
        let artist = getName(i.artist) || getName(i.artists?.[0]);
        let album = getName(i.album);
        if (artist && album) return `${album} • ${artist} • ${pName}`;
        if (artist) return `${artist} • ${pName}`;
    }
    if (cat === 'album') {
        let artist = getName(i.artist) || getName(i.artists?.[0]) || "";
        if (artist) return `${artist} • ${pName}`;
    }
    if (cat === 'artist') {
        return `Artist • ${pName}`;
    }
    return `${cat} • ${pName}`;
}

// --- HELPER: SEARCH FILTER ---
// Determines if an item belongs to the selected source (Spotify, Radio, or NAS/Local).
function isSourceMatch(item, activeSource) {
    // NEW: If Global is selected, bypass all filters and let everything through!
    if (activeSource === 'global') return true;

    const providers = (item.provider_mappings || []).map(p => p.provider_domain);
    const mainProvider = item.provider;

    if (activeSource === 'spotify') {
        return providers.includes('spotify') || mainProvider ===('spotify');
    }
    if (activeSource === 'radio') {
        return true; // Radio tab allows everything returned by the radio query
    }
    if (activeSource === 'nas') {
        // NAS includes everything that IS NOT Spotify or Radio
        return !providers.includes('spotify') && mainProvider !== 'spotify' && mainProvider !== 'radio';
    }
    return false;
}

// --- PROXY ENDPOINT ---
// Relays images from Music Assistant to the frontend, handling authentication tokens automatically.
router.get('/manager/proxy_image', async (req, res) => {
    try {
        const token = await mass.getToken();
        let imageUrl = "";
        
        // Mode 1: Proxy a Raw path via 'imageproxy' endpoint
        if (req.query.mode === 'raw') {
            const rawPath = req.query.path;
            const provider = req.query.provider;
            imageUrl = `${MASS_BASE_URL}/imageproxy?path=${encodeURIComponent(rawPath)}&provider=${encodeURIComponent(provider)}&checksum=`;
        } 
        // Mode 2: Proxy a standard URI thumb
        else {
            const uri = req.query.uri;
            imageUrl = `${MASS_BASE_URL}/api/image/thumb/${encodeURIComponent(uri)}`;
        }
        
        // Stream the image response directly to the client
        const response = await axios({
            url: imageUrl, method: 'GET', responseType: 'stream',
            headers: { 'Authorization': `Bearer ${token}` }
        });
        
        if (response.headers['content-type']) res.set('Content-Type', response.headers['content-type']);
        response.data.pipe(res);
    } catch (e) { res.status(404).send('Image not found'); }
});

// --- 1. SEARCH ENDPOINT ---
// Performs a unified search across Music Assistant providers.
router.post('/manager/search', async (req, res) => {
    let { query, source, type, limit } = req.body; 
    let searchLimit = parseInt(limit) || 100;
    if (searchLimit > 1000) searchLimit = 1000;
    if (!query || query.trim() === "") return res.json([]); 
    
    // Force 'all' search for radio to ensure we catch stations
    if (source === 'radio') type = 'all'; 

    try {
        let mediaTypes = ["artist", "album", "track", "playlist"];
        if (source === 'radio') mediaTypes = ["radio"];
		if (source === 'global') mediaTypes.push("radio"); // Add radio to Global searches

        // 1. Fetch Data
        const data = await massRequest("music/search", { 
            search_query: query, 
            limit: searchLimit, 
            media_types: mediaTypes 
        });
        
        // 2. Process Results
        let results = [];
        const qLower = query.toLowerCase();
        
        const safeStr = (val) => {
            if (!val) return "";
            if (typeof val === 'string') return val.toLowerCase();
            if (val.name) return String(val.name).toLowerCase();
            return "";
        };

        // Processes a specific category list (e.g. playlists)
        const processList = (list, cat) => {
            if (!list || list.length === 0) return;
            let categoryItems = [];
            
            list.forEach(i => {
                // Filter by Source (Spotify vs NAS)
                if (!isSourceMatch(i, source)) return;

                // --- GHOST FILTER ---
                // Streaming services (Spotify, Apple, etc.) often return "stub" artists with zero playable tracks.
                // Since real streaming artists always have profile pictures, filter out any without artwork.
                // bypass this filter for Local NAS ('file') so don't accidentally hide personal ripped CDs!
                const prov = (i.provider_mappings?.[0]?.provider_domain) || i.provider || "";
                const isLocal = prov.includes('file') || prov.includes('library');
                
                if (cat === 'artist' && !isLocal) {
                    const hasArt = i.image || i.img || (i.metadata && i.metadata.images && i.metadata.images.length > 0) || (i.metadata && i.metadata.image);
                    if (!hasArt) return; // Skip this ghost item!
                }
                // Client-side text match (Strict Filtering)
                let content = safeStr(i.name);
                if (i.artist) content += " " + safeStr(i.artist);
                if (i.artists) i.artists.forEach(a => content += " " + safeStr(a));
                if (i.album) content += " " + safeStr(i.album);

                if ((type === 'all' || type === cat) && content.includes(qLower)) {
                    categoryItems.push({
                        uri: i.uri, 
                        name: i.name,
                        subtitle: buildSubtitle(i, cat, false), 
                        image: normalizeImage(i), 
                        type: cat,
                        provider: (i.provider_mappings?.[0]?.provider_domain) || i.provider || 'unknown'
                    });
                }
            });

            if (categoryItems.length > 0) {
                if (type === 'all') {
                    const titleMap = { playlist: 'Playlists', artist: 'Artists', album: 'Albums', track: 'Songs', radio: 'Radio' };
                    results.push({ type: 'HEADER', title: titleMap[cat] });
                }
                results.push(...categoryItems);
            }
        };

        if (source === 'radio') {
            processList(data.radio, 'radio');
        } else { 
            processList(data.playlists, 'playlist'); 
            processList(data.artists, 'artist'); 
            processList(data.albums, 'album'); 
            processList(data.tracks, 'track'); 
			if (source === 'global') processList(data.radio, 'radio'); // Process radio items if Global
        }
        
        res.json(results);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- 2. RECENTS ENDPOINT ---
// Retrieves recently played items. Requires a two-step fetch (List -> Details) for full metadata.
router.get('/manager/recents', async (req, res) => {
    try {
        const token = await mass.getToken(); // Still need raw token for the loop below
        
        // 1. Get List of URIs
        const recentRes = await massRequest("music/recently_played_items", { 
            limit: 200, 
            media_types: ["track", "album", "playlist", "radio"] 
        });

        const skeletonItems = recentRes.items || recentRes || [];

        // 2. Hydrate Details (Parallel Fetch)
        // Recents often lack image/provider data, so fetch details by URI.
        const fullItems = await Promise.all(skeletonItems.map(async (skel) => {
            try {
                //  use axios directly here for performance (skipping the wrapper overhead inside a loop)
                const itemRes = await axios.post(`${MASS_BASE_URL}/api`, {
                    command: "music/item_by_uri", 
                    args: { uri: skel.uri },
                    message_id: Date.now() + Math.random()
                }, { headers: { 'Authorization': `Bearer ${token}` }});
                return itemRes.data || skel; 
            } catch (e) { return skel; }
        }));

        const results = fullItems.map(i => {
            let cat = i.media_type || 'unknown'; 
            return {
                uri: i.uri, 
                name: i.name,
                subtitle: buildSubtitle(i, cat, true), 
                image: normalizeImage(i), 
                type: cat,
                provider: i.provider
            };
        });
        res.json(results);
    } catch (e) { res.json([]); }
});

// --- 3. GET PLAYERS ---
// Returns a list of available players, cleaning up their IP addresses.
router.get('/manager/players', async (req, res) => {
    try {
        const playersData = await massRequest("players/all", {});
        const players = Array.isArray(playersData) ? playersData : [];
        
		res.json(players.map(p => ({
            id: p.player_id, 
            name: p.display_name || p.name, 
            available: p.available,
            // Extracts pure IP address (removes http:// and ports) using shared utility
            ip: utils.parseIp((p.device_info && p.device_info.ip_address) || p.ip_address || (p.attributes ? p.attributes.ip_address : null))
        })));
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- 4. PLAY NOW ---
// Commands a specific speaker to play an item.
// Includes critical "Anti-Flash" logic to prevent the UI from flickering 'Ready'.
router.post('/manager/play_now', async (req, res) => {
    const { uri, name, settings, player_id } = req.body;
    const item = { uri: uri, name: name || "Manager Selection", settings: settings || {} };
    console.log(`[Manager] Request: ${item.name}`); 
    
    // --- STABILITY LOCK (Critical for UI) ---
    // This lock tells the frontend polling engine: "Ignore the fact that the speaker stops for a second."
    // It prevents the UI from flashing to "Ready/Off" while Music Assistant loads the stream.
    if (deviceState && deviceState.setExpectation) {
        deviceState.setExpectation(player_id, 'TRACK', null, item.name);
    }

    try {
        const success = await mass.play(player_id, item);
        
        // If playing on a Preset/Group, reset the memory so buttons sync up.
        if (player_id.includes(".")) {
             mass.setPresetMemory(player_id, 0);
        }
        
        if (success) res.json({ success: true });
        else {
            // Unlock if failed so UI doesn't hang
            if (deviceState) deviceState.clearSession(player_id); 
            res.status(500).json({ error: "Playback failed via MASS" });
        }
    } catch (e) { 
        if (deviceState) deviceState.clearSession(player_id);
        res.status(500).json({ error: e.message }); 
    }
});

// --- LIBRARY (CRUD Operations) ---
// Handles reading/writing the JSON database for Favorites and Presets.

router.get('/manager/library', (req, res) => {
    if (fs.existsSync(LIBRARY_FILE)) res.json(JSON.parse(fs.readFileSync(LIBRARY_FILE)));
    else res.json([]);
});

router.post('/manager/save', (req, res) => {
    const { uuid, name, uri, image, type, slot, settings, subtitle, speakerIp } = req.body;
    let lib = fs.existsSync(LIBRARY_FILE) ? JSON.parse(fs.readFileSync(LIBRARY_FILE)) : [];
    
    // Ensure unique slot assignment within the given scope
    const targetSlot = parseInt(slot) || 0;
    const targetIp = speakerIp || "";
    
    if (targetSlot > 0) {
        lib.forEach(i => { 
            const existingIp = i.speakerIp || "";
            if (i.slot === targetSlot && existingIp === targetIp) {
                i.slot = 0; 
            }
        });
    }
    
    let itemIndex = -1;
    if (uuid) itemIndex = lib.findIndex(i => i.uuid === uuid);
    
    const newItem = {
        uuid: uuid || crypto.randomUUID().split('-')[0],
        slot: targetSlot, 
        speakerIp: targetIp,
        name, 
        subtitle: subtitle || type, 
        uri, 
        image, 
        type,
        settings: { 
            shuffle: settings?.shuffle || false, 
            repeat: settings?.repeat || 'off' 
        }
    };
    
    if (itemIndex >= 0) lib[itemIndex] = newItem; else lib.push(newItem);
    
    fs.writeFileSync(LIBRARY_FILE, JSON.stringify(lib, null, 2));
    res.json({ success: true });
});

router.delete('/manager/delete/:uuid', (req, res) => {
    if (!fs.existsSync(LIBRARY_FILE)) return res.json({ success: true });
    let lib = JSON.parse(fs.readFileSync(LIBRARY_FILE));
    lib = lib.filter(i => i.uuid !== req.params.uuid);
    fs.writeFileSync(LIBRARY_FILE, JSON.stringify(lib, null, 2));
    res.json({ success: true });
});

module.exports = router;