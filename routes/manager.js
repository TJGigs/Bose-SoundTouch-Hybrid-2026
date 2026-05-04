const express = require('express');
const router = express.Router();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mass = require('./mass'); // Core Music Assistant logic
const utils = require('./utils'); // Shared utilities (IP parsing, etc.)
const deviceState = require('../device_state'); // REQUIRED for UI Stability (Anti-Flash locks)
// --- GLOBAL CACHE VARIABLES ---
let cachedProviders = [];
let lastProviderFetch = 0;
const PROVIDER_CACHE_TTL = 5 * 60 * 1000; // 5 minutes in milliseconds


// --- CONFIGURATION ---
// Retrieves sensitive connection details from environment variables.
const MASS_IP = process.env.MASS_IP;
const MASS_PORT = process.env.MASS_PORT;
const MASS_BASE_URL = `http://${MASS_IP}:${MASS_PORT}`;

const LIBRARY_FILE = path.join(__dirname, '../config/library.json');

// --- HELPER: API WRAPPER ---
// Centralizes communication with Music Assistant.
// Handles authentication (Token fetching) and standardizes error responses.
async function massRequest(command, args = {}) {
    try {
        const token = await mass.getToken();
        if (!token)
            throw new Error("Failed to authenticate with Mass");

        const res = await axios.post(`${MASS_BASE_URL}/api`, {
            command: command,
            args: args,
            message_id: Date.now()
        }, {
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });

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
    if (!i)
        return utils.DEFAULT_ICON;

    // Helper to safely extract string values from potentially nested objects
    const unwrap = (val) => {
        if (!val)
            return null;
        if (typeof val === 'string')
            return val;
        if (typeof val === 'object')
            return val.path || val.url || val._ || null;
        return null;
    };

    // prioritized extraction strategy
    const resolve = (obj) => {
        if (!obj)
            return null;

        // 1. Check for Provider Image (Best Quality)
        let img = obj.image || obj.img;
        if (img && typeof img === 'object' && img.provider) {
            return {
                path: img.path,
                provider: img.provider
            };
        }

        // 2. Check for Metadata Image Array
        if (obj.metadata && obj.metadata.images && obj.metadata.images.length > 0) {
            const mImg = obj.metadata.images[0];
            return {
                path: mImg.path,
                provider: mImg.provider
            };
        }

        // 3. Check for Simple HTTP String
        let simpleStr = unwrap(img) || unwrap(obj.metadata?.image);
        if (simpleStr && simpleStr.startsWith('http')) {
            return {
                path: simpleStr,
                provider: null
            };
        }
        return null;
    };

    // Attempt to resolve image from Item -> Album -> Artist
    let info = resolve(i);
    if (!info && i.album)
        info = resolve(i.album);
    if (!info && i.artist)
        info = resolve(i.artist);

    const finalPath = info ? info.path : null;
    const finalProv = info ? info.provider : null;

    // If the image is already a direct web link, bypass the local proxy!
    if (finalPath && finalPath.startsWith('http')) {
        return finalPath;
    }

    return utils.buildImageUrl(finalPath, finalProv, i.uri);
}

// --- HELPER: SUBTITLE BUILDER ---

// Generates a strictly uniform subtitle across all views: Search, Recents, and Library.
// --- HELPER: SUBTITLE BUILDER ---
// Generates a strictly uniform subtitle across all views: Search, Recents, and Library.
function buildSubtitle(i, cat, showType = false) {
    const cleanProv = (p) => {
        if (!p) return "Unknown";
        let clean = p.split('--')[0].toLowerCase();
        if (clean.includes('file') || clean.includes('library') || clean.includes('nas')) return "Local NAS";
        if (clean.includes('builtin') || clean.includes('url')) return "URL Stream";
        return clean.charAt(0).toUpperCase() + clean.slice(1);
    };

    const getName = (obj) => utils.scrubText(typeof obj === 'string' ? obj : (obj?.name || ""));

    let rawProv = i.provider || (i.provider_mappings?.[0]?.provider_domain) || "unknown";
    let pName = cleanProv(rawProv);
    
    let parts = [];

    // --- RECENTS SPECIFIC RULE ---
    if (showType) {
        parts.push(cat.charAt(0).toUpperCase() + cat.slice(1));
    }

    // 1. PLAYLIST
    if (cat === 'playlist') {
        parts.push(pName);
        let owner = i.owner || i.metadata?.owner;
        if (owner && owner.includes('--')) owner = cleanProv(owner);
        if (owner && owner.toLowerCase() !== pName.toLowerCase() && owner.toLowerCase() !== rawProv.toLowerCase()) {
            parts.push(`By ${owner}`);
        }
        return parts.join(' • ');
    }
    
    // 2. TRACK
    if (cat === 'track') {
        let album = getName(i.album) || getName(i.metadata?.album);
        let artist = getName(i.artist) || getName(i.artists?.[0]) || getName(i.metadata?.artist);
        if (album) parts.push(album);
        if (artist) parts.push(artist);
    } 
    // 3. ALBUM
    else if (cat === 'album') {
        let artist = getName(i.artist) || getName(i.artists?.[0]) || getName(i.metadata?.artist);
        if (artist) parts.push(artist);
    }
    
    // Finally, append the provider to the end
    parts.push(pName);
    return parts.join(' • ');
}


// --- HELPER: SEARCH FILTER ---
// Determines if an item belongs to the selected source (Spotify, Radio, or NAS/Local).
function isSourceMatch(item, activeSource) {
    // NEW: If Global is selected, bypass all filters and let everything through!
    if (activeSource === 'global')
        return true;

    // Strip instance IDs (e.g., filesystem_local--xyz -> filesystem_local)
    const providers = (item.provider_mappings || []).map(p => (p.provider_domain || '').split('--')[0]);
    const mainProvider = (item.provider || '').split('--')[0];

    if (activeSource === 'spotify') {
        return providers.includes('spotify') || mainProvider === 'spotify';
    }
    if (activeSource === 'radio') {
        return true; 
    }
    if (activeSource === 'nas') {
        // NAS includes everything that IS NOT Spotify or Radio
        return !providers.includes('spotify') && mainProvider !== 'spotify' && mainProvider !== 'radio';
    }
    return false;
}

// --- PROXY ENDPOINT ---
// Relays images from Music Assistant to the frontend, handling authentication tokens automatically.
router.get('/manager/proxy_image', async(req, res) => {
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
            url: imageUrl,
            method: 'GET',
            responseType: 'stream',
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });

        if (response.headers['content-type'])
            res.set('Content-Type', response.headers['content-type']);
        response.data.pipe(res);
    } catch (e) {
        res.status(404).send('Image not found');
    }
});

// --- 0. GET MUSIC PROVIDERS ---
router.get('/manager/providers', async(req, res) => {
    
    // 1. Check the Cache first! (Lightning fast, no MA network requests)
    if (cachedProviders.length > 0 && (Date.now() - lastProviderFetch < PROVIDER_CACHE_TTL)) {
        return res.json(cachedProviders);
    }

    try {
        const token = await mass.getToken();
        const headers = { 'Authorization': `Bearer ${token}` };
        
        let providers = [];
        
        // 2. Fetch fresh data. We omit the 'args' object entirely to comply with MA 2.8.5 strict OpenAPI rules.
        try {
            // In 2.8.5+, the proper endpoint is usually 'music/providers' or 'providers'
            const response = await axios.post(`${MASS_BASE_URL}/api`, { command: "music/providers", message_id: Date.now() }, { headers });
            providers = Array.isArray(response.data) ? response.data : [];
        } catch (e1) {
            try {
                // Fallback for slightly older 2.x versions
                const response2 = await axios.post(`${MASS_BASE_URL}/api`, { command: "providers", message_id: Date.now() }, { headers });
                providers = Array.isArray(response2.data) ? response2.data : [];
            } catch (e2) {
                throw new Error("Provider API rejected commands");
            }
        }

        // Filter for music providers, EXCLUDING 'builtin' and 'url' since they cannot be searched
        const musicProviders = providers.filter(p => 
            p.type === 'music' && 
            p.domain !== 'builtin' && 
            p.domain !== 'url'
        );
        
        const results = musicProviders.map(p => ({
            domain: p.domain,
            name: p.name || p.domain
        }));
        
        if (results.length > 0) {
            // 3. Save to memory and update the clock
            cachedProviders = results;
            lastProviderFetch = Date.now();
            return res.json(results);
        } else {
            throw new Error("Empty providers list");
        }

    } catch (e) {
        // --- SILENT FALLBACK ---
        // If MA rejects the command or is offline, serve standard providers + dynamic extraction
        let fallbackProviders = [
            { domain: 'spotify', name: 'Spotify' },
            { domain: 'tunein', name: 'TuneIn' },
            { domain: 'file', name: 'Local NAS' }
        ];
        
        try {
            if (fs.existsSync(LIBRARY_FILE)) {
                const lib = JSON.parse(fs.readFileSync(LIBRARY_FILE));
                const uniqueDomains = [...new Set(lib.map(i => (i.provider || 'unknown').split('--')[0]))];
                uniqueDomains.forEach(domain => {
                    if (domain !== 'unknown' && domain !== 'builtin' && domain !== 'url' && !fallbackProviders.some(f => f.domain === domain)) {
                        fallbackProviders.push({ 
                            domain: domain, 
                            name: domain.charAt(0).toUpperCase() + domain.slice(1) 
                        });
                    }
                });
            }
        } catch (err) {}

        // We DO NOT cache the fallback list. We want it to keep trying MA on the next refresh.
        res.json(fallbackProviders);
    }
});

// --- 1. SEARCH ENDPOINT ---
// Performs a unified search across Music Assistant providers.
router.post('/manager/search', async(req, res) => {
    let { query, source, type, limit, providerFilter } = req.body;
    let searchLimit = parseInt(limit) || 100;
    if (searchLimit > 1000)
        searchLimit = 1000;
    if (!query || query.trim() === "")
        return res.json([]);

    // Force 'all' search for radio to ensure we catch stations
    if (source === 'radio')
        type = 'all';

    try {
        let mediaTypes = ["artist", "album", "track", "playlist"];
        if (source === 'radio')
            mediaTypes = ["radio"];
        if (source === 'global')
            mediaTypes.push("radio"); // Add radio to Global searches

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
            if (!val)
                return "";
            if (typeof val === 'string')
                return val.toLowerCase();
            if (val.name)
                return String(val.name).toLowerCase();
            return "";
        };

		// Processes a specific category list (e.g. playlists)
        const processList = (list, cat) => {
            if (!list || list.length === 0)
                return;
            let categoryItems = [];

            list.forEach(i => {
                // Filter by Source (Spotify vs NAS)
                if (!isSourceMatch(i, source))
                    return;
				
			// --- DYNAMIC PROVIDER FILTER (Global Tab Only) ---
                if (source === 'global' && providerFilter && providerFilter !== 'all') {
                    const domains = (i.provider_mappings || []).map(p => (p.provider_domain || '').split('--')[0]);
                    const mainProv = (i.provider || '').split('--')[0];
                    
                    // Fuzzy matching: MA often tags local NAS items as 'library' or 'file' interchangeably
                    const isLocalFilter = providerFilter.includes('file') || providerFilter === 'library' || providerFilter.includes('nas');
                    const itemIsLocal = domains.some(d => d.includes('file') || d.includes('library')) || mainProv.includes('file') || mainProv.includes('library');
                    
                    if (isLocalFilter) {
                        // If the dropdown is looking for NAS, accept anything tagged file/library
                        if (!itemIsLocal) return;
                    } else {
                        // Otherwise, do a strict match for Spotify, TuneIn, etc.
                        if (!domains.includes(providerFilter) && mainProv !== providerFilter) return;
                    }
                }
                
                // --- GHOST FILTER ---
                const prov = (i.provider_mappings?.[0]?.provider_domain) || i.provider || "";
                const isLocal = prov.includes('file') || prov.includes('library');

                if (cat === 'artist' && !isLocal) {
                    const hasArt = i.image || i.img || (i.metadata && i.metadata.images && i.metadata.images.length > 0) || (i.metadata && i.metadata.image);
                    if (!hasArt) return; 
                }
                
                // --- STRICT TEXT MATCHING (Updated for NAS Metadata) ---
                let content = safeStr(i.name);
                
                // Ensure we catch metadata specific to NAS files
                let artName = i.artist?.name || i.artist || i.metadata?.artist || "";
                let albName = i.album?.name || i.album || i.metadata?.album || "";
                
                content += " " + safeStr(artName) + " " + safeStr(albName);
                
                if (i.artists) {
                    i.artists.forEach(a => content += " " + safeStr(a.name || a));
                }

                if ((type === 'all' || type === cat) && content.includes(qLower)) {
                    categoryItems.push({
                        uri: i.uri,
                        name: utils.scrubText(i.name),
                        subtitle: buildSubtitle(i, cat, false),
                        image: normalizeImage(i),
                        type: cat,
                        provider: (i.provider_mappings?.[0]?.provider_domain) || i.provider || 'unknown'
                    });
                }
            });

            if (categoryItems.length > 0) {
                if (type === 'all') {
                    const titleMap = {
                        playlist: 'Playlists',
                        artist: 'Artists',
                        album: 'Albums',
                        track: 'Tracks',
                        radio: 'Radio'
                    };
                    results.push({
                        type: 'HEADER',
                        title: titleMap[cat]
                    });
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
            if (source === 'global')
                processList(data.radio, 'radio'); // Process radio items if Global
        }

        res.json(results);
    } catch (e) {
        res.status(500).json({
            error: e.message
        });
    }
});

// --- 2. RECENTS ENDPOINT ---
// Retrieves recently played items. Requires a two-step fetch (List -> Details) for full metadata.
router.get('/manager/recents', async(req, res) => {
    try {
        const token = await mass.getToken(); // Still need raw token for the loop below

        // 1. Get List of URIs
        const recentRes = await massRequest("music/recently_played_items", {
            limit: 100,
            media_types: ["track", "album", "playlist", "radio"]
        });

        const skeletonItems = recentRes.items || recentRes || [];

		// 2. Hydrate Details (Parallel Fetch)
        const fullItems = await Promise.all(skeletonItems.map(async(skel) => {
                    const hasImage = skel.image || skel.img || (skel.metadata && (skel.metadata.images || skel.metadata.image));
                    
                    // NEW: Ensure we actually have the artist name for tracks/albums!
                    const hasArtist = skel.artist || (skel.artists && skel.artists.length > 0) || (skel.metadata && skel.metadata.artist);
                    const isTrackOrAlbum = skel.media_type === 'track' || skel.media_type === 'album';

                    // Only skip the API call if we have ALL the data needed for the UI
                    if (hasImage && skel.provider && (!isTrackOrAlbum || hasArtist)) {
                        return skel; 
                    }

                    try {
                        const itemRes = await axios.post(`${MASS_BASE_URL}/api`, {
                            command: "music/item_by_uri",
                            args: {
                                uri: skel.uri
                            },
                            message_id: Date.now() + Math.random()
                        }, {
                            headers: {
                                'Authorization': `Bearer ${token}`
                            }
                        });
                        return itemRes.data || skel;
                    } catch (e) {
                        return skel;
                    }
                }));

        const results = fullItems.map(i => {
            let cat = i.media_type || 'unknown';
            return {
                uri: i.uri,
                name: utils.scrubText(i.name),
                subtitle: buildSubtitle(i, cat, true),
                image: normalizeImage(i),
                type: cat,
                provider: (i.provider_mappings?.[0]?.provider_domain) || i.provider || 'unknown'
            };
        });
        res.json(results);
    } catch (e) {
        res.json([]);
    }
});

// --- 3. GET PLAYERS ---
// Returns a list of available players, cleaning up their IP addresses.
router.get('/manager/players', async(req, res) => {
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
    } catch (e) {
        res.status(500).json({
            error: e.message
        });
    }
});

// --- 4. PLAY NOW ---
// Commands a specific speaker to play an item.
// Includes critical "Anti-Flash" logic to prevent the UI from flickering 'Ready'.
router.post('/manager/play_now', async(req, res) => {
    const { uri, name, settings, player_id, ip } = req.body;
    
    const item = {
        uri: uri,
        name: name || "Manager Selection",
        settings: settings || {}
    };
    
    console.log(`[Manager] Request: ${item.name}`);

    // --- STABILITY LOCK (Critical for UI) ---
    // Pass the explicit IP for lock engine
    if (deviceState && deviceState.setExpectation) {
        // Fallback to player_id if ip is missing for any reason
        deviceState.setExpectation(ip || player_id, 'TRACK', null, item.name);
    }

    try {
        const success = await mass.playMedia(player_id, item);

        // If playing on a Preset/Group, reset the memory so buttons sync up.
        if (player_id.includes(".")) {
            mass.setPresetMemory(player_id, 0);
        }

        if (success) {
            res.json({ success: true });
        } else {
            // Unlock if failed so UI doesn't hang
            if (deviceState) deviceState.clearSession(ip || player_id);
            res.status(500).json({ error: "Playback failed via MASS" });
        }
    } catch (e) {
        if (deviceState) deviceState.clearSession(ip || player_id);
        res.status(500).json({ error: e.message });
    }
});

// --- LIBRARY (CRUD Operations) ---
// Handles reading/writing the JSON database for Favorites and Presets.

router.get('/manager/library', (req, res) => {
    if (fs.existsSync(LIBRARY_FILE))
        res.json(JSON.parse(fs.readFileSync(LIBRARY_FILE)));
    else
        res.json([]);
});

router.post('/manager/save', (req, res) => {
    const { uuid, name, uri, image, type, slot, settings, subtitle, speakerIp, provider } = req.body;
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
    if (uuid)
        itemIndex = lib.findIndex(i => i.uuid === uuid);

    const newItem = {
        uuid: uuid || crypto.randomUUID().split('-')[0],
        slot: targetSlot,
        speakerIp: targetIp,
        name,
        subtitle: subtitle || type,
        uri,
        image,
        type,
		provider: provider || 'unknown', 
        settings: {
            shuffle: settings?.shuffle || false,
            repeat: settings?.repeat || 'off'
        }
    };

    if (itemIndex >= 0)
        lib[itemIndex] = newItem;
    else
        lib.push(newItem);

    fs.writeFileSync(LIBRARY_FILE, JSON.stringify(lib, null, 2));
    res.json({
        success: true
    });
});

router.delete('/manager/delete/:uuid', (req, res) => {
    if (!fs.existsSync(LIBRARY_FILE))
        return res.json({
            success: true
        });
    let lib = JSON.parse(fs.readFileSync(LIBRARY_FILE));
    lib = lib.filter(i => i.uuid !== req.params.uuid);
    fs.writeFileSync(LIBRARY_FILE, JSON.stringify(lib, null, 2));
    res.json({
        success: true
    });
});

// --- 5. CUSTOM URL STREAMING & HISTORY ---
router.post('/manager/play_stream', async(req, res) => {
    const { player_id, url, name } = req.body;

    try {
        // 1. Tell MASS to play the raw URL
        const success = await mass.playMedia(player_id, {uri: url, name: name});

        if (success) {
            // 2. Save to History (Slot -1)
            let lib = fs.existsSync(LIBRARY_FILE) ? JSON.parse(fs.readFileSync(LIBRARY_FILE)) : [];

            // Remove exact URL duplicates from history so it bumps to the top
            lib = lib.filter(i => !(i.slot === -1 && i.uri === url));

            // Add new item to the history list
            lib.push({
                uuid: crypto.randomUUID().split('-')[0],
                slot: -1,
                speakerIp: "",
                name: name || "Custom Station",
                subtitle: "URL Stream",
                uri: url,
                image: utils.DEFAULT_ICON,
				type: "radio", // <-- Aligned with Music Assistant
                provider: "builtin", // <-- Aligned with Music Assistant
                settings: {
                    shuffle: false,
                    repeat: 'off'
                }
            });

            // Limit history to the 10 most recent items
            const historyItems = lib.filter(i => i.slot === -1).reverse();
            if (historyItems.length > 10) {
                const toRemove = historyItems.slice(10).map(i => i.uuid);
                lib = lib.filter(i => !toRemove.includes(i.uuid));
            }

            fs.writeFileSync(LIBRARY_FILE, JSON.stringify(lib, null, 2));
            res.send({
                success: true
            });
        } else {
            res.status(500).send({
                error: "Music Assistant failed to play the stream."
            });
        }
    } catch (e) {
        res.status(500).send({
            error: e.message
        });
    }
});

module.exports = router;