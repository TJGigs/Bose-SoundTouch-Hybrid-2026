const { URL } = require('url'); // Standard Node.js library
const fs = require('fs');
const path = require('path');

const DEFAULT_ICON = "";

function buildImageUrl(artPath, provider, uri) {
    if (artPath && typeof artPath === 'string' && artPath.startsWith('http') && !artPath.includes('imageproxy')) {
        return artPath;
    }
    if (artPath && provider) {
        return `/api/manager/proxy_image?mode=raw&path=${encodeURIComponent(artPath)}&provider=${encodeURIComponent(provider)}`;
    }
    if (uri) {
        return `/api/manager/proxy_image?uri=${encodeURIComponent(uri)}`;
    }
    return DEFAULT_ICON;
}

// --- NEW: CENTRALIZED IP PARSER ---
function parseIp(input) {
    if (!input)
        return null;
    let str = String(input);

    // 1. Handle UPnP/XML URLs
    if (str.includes("http")) {
        try {
            str = new URL(str).hostname;
        } catch (e) {
            // If URL parsing fails, fall through to regex
        }
    }

    // 2. Handle IPv6 mapped IPv4 (e.g., ::ffff:192.168.1.50)
    str = str.replace('::ffff:', '');

    // 3. Extract pure IPv4 if garbage remains
    const match = str.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
    return match ? match[0] : str;
}
// --- SHARED PRESET LOOKUP ---
function getPresetAssignment(ip, slotId) {
    const libPath = path.join(__dirname, '../config/library.json');
    if (!fs.existsSync(libPath))
        return null;

    const library = JSON.parse(fs.readFileSync(libPath));

    let match = library.find(item => item.slot === slotId && item.speakerIp === ip);
    if (!match)
        match = library.find(item => item.slot === slotId && !item.speakerIp);

    return match || null;
}
// --- TEXT SANITIZER ---
// Detects common encoding errors (like the replacement character) and fixes them.
function scrubText(str) {
    if (!str)
        return "";
    // Replaces broken diamond symbol with correct accented 'á'
    return str.replace(/[\ufffd]/g, 'á').normalize('NFC');
}

module.exports = {
    DEFAULT_ICON,
    buildImageUrl,
    getPresetAssignment,
    parseIp,
    scrubText 
};