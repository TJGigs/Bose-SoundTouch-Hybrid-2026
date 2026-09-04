// ============================================================================
// PHASE 1: IMPORTS & CONSTANTS
// ============================================================================
const CURRENT_VERSION = "v4.3";
const ENV_SCHEMA_VERSION = "v4.2";
const SETTINGS_SCHEMA_VERSION = "v4.2";
const minReq = [2, 10, 1]; //MASS VERSION
let UPDATE_CACHED_DATA = { updateAvailable: false, current: CURRENT_VERSION };
const express = require('express');
const fs = require('fs');
const path = require('path');
const bodyParser = require('body-parser');
const axios = require('axios');
const xml2js = require('xml2js');
const cors = require('cors');

// ============================================================================
// PHASE 2: DIRECTORY SETUP & LIVE LOGGER
// ============================================================================
// Use process.cwd() to guarantee we are at the absolute root of the /app folder in Docker
const APP_ROOT = process.cwd();
const USER_ROOT = path.join(APP_ROOT, 'config');

if (!fs.existsSync(USER_ROOT)) {
    console.log(`[Boot] Creating missing config directory at ${USER_ROOT}`);
    fs.mkdirSync(USER_ROOT, { recursive: true });
}


const LOG_DIR = path.join(USER_ROOT, 'logs');
if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
}

// Archive watchdog logs from the previous session on every startup
try {
    const watchdogLogs = fs.readdirSync(LOG_DIR).filter(f => /^watchdog_.*\.json$/.test(f));
    for (const f of watchdogLogs) {
        fs.renameSync(path.join(LOG_DIR, f), path.join(LOG_DIR, f + '.bak'));
    }
    if (watchdogLogs.length > 0) {
        console.log(`[Boot] Archived ${watchdogLogs.length} watchdog log(s) from previous session to .bak`);
    }
} catch (e) {
    console.error(`[Boot] ⚠️ Could not archive watchdog logs: ${e.message}`);
}

const MAX_LOG_LINES = 1000;
const logBuffer = [];
const originalLog = console.log;
const originalError = console.error;

// ANSI color codes for terminal/Docker log output (docker logs, docker compose logs,
// etc. all render these). NOT rendered by the Tools page's live log viewer — that's a
// plain <textarea>, so captureLog() strips these back out before buffering so users
// there see clean text instead of literal escape-code gibberish.
const ANSI_BRIGHT_GREEN = '\x1b[92m';
const ANSI_RESET = '\x1b[0m';
const ANSI_CODE_PATTERN = /\x1b\[[0-9;]*m/g;

function captureLog(type, args) {
    const time = new Date().toLocaleTimeString([], { hour12: false });
    const msg = Array.from(args).map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' ').replace(ANSI_CODE_PATTERN, '');
    logBuffer.push(`[${time}] [${type}] ${msg}`);
    if (logBuffer.length > MAX_LOG_LINES) logBuffer.shift();
}

console.log = function() {
    captureLog('INFO', arguments);
    originalLog.apply(console, arguments);
    if (Array.isArray(global.WATCHDOG_SPEAKERS) && global.WATCHDOG_SPEAKERS.length > 0) {
        const msg = Array.from(arguments).map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
        for (const ip of global.WATCHDOG_SPEAKERS) {
            if (msg.includes(ip)) {
                try { require('./routes/utils').appendWatchdogLog(ip, { type: 'console_log', msg }); } catch(e) {}
                break;
            }
        }
    }
};
console.error = function() { captureLog('ERROR', arguments); originalError.apply(console, arguments); };

console.log("============================================================================");
console.log("====             STARTUP AND INITIALIZATION");
console.log("====           BOSE SOUNDTOUCH HYBRID: " + CURRENT_VERSION.toUpperCase());
console.log("============================================================================");

// ============================================================================
// PHASE 3: TEMPLATES & MIGRATION ENGINE
// ============================================================================
const envPath = path.join(USER_ROOT, '.env');
const speakersPath = path.join(USER_ROOT, 'speakers.json');
const libraryPath = path.join(USER_ROOT, 'library.json');

// Point explicitly to the /templates subfolder!
const envTemplatePath = path.join(APP_ROOT, 'templates', '.env.template');
const libraryTemplatePath = path.join(APP_ROOT, 'templates', 'library.template.json');

let isReady = true;

// Handle .env and Migration
if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf8');
    const parsedEnv = require('dotenv').parse(envContent);

    if (parsedEnv.ENV_SCHEMA_VERSION !== ENV_SCHEMA_VERSION) {
        console.log(`[Boot] Outdated .env format detected. Backing up to .env.bak...`);
        fs.renameSync(envPath, path.join(USER_ROOT, '.env.bak'));
        
        console.log(`[Boot] Copying new ${ENV_SCHEMA_VERSION} .env.template...`);
        if (fs.existsSync(envTemplatePath)) {
            fs.copyFileSync(envTemplatePath, envPath);
        } else {
            console.error(`[Boot] CRITICAL: .env.template is missing from ${envTemplatePath}`);
        }
        
        console.log(`[!!] Validation Failed: .env file updated to ${ENV_SCHEMA_VERSION}  Old settings saved to config/.env.bak`);
        isReady = false; 
    } else {
        console.log(`[Boot] .env ${ENV_SCHEMA_VERSION} already exists. Skipping generation.`);
    }
} else {
    console.log(`[Boot] .env not found. Copying template...`);
    if (fs.existsSync(envTemplatePath)) {
        fs.copyFileSync(envTemplatePath, envPath);
        console.log(`[!!] Validation Failed: Fresh .env file created. Requires user configuration.`);
    } else {
        console.error(`[Boot] CRITICAL: .env.template is missing from ${envTemplatePath}`);
    }
    isReady = false; 
}

// Ensure speakers.json exists — starts empty and gets populated by the parallel
// discovery block in systemBoot(), which runs on every boot regardless.
if (!fs.existsSync(speakersPath)) {
    console.log(`[Boot] speakers.json not found. Creating empty file — auto-discovery will populate it.`);
    fs.writeFileSync(speakersPath, '[]');
} else {
    console.log(`[Boot] speakers.json already exists. Skipping generation.`);
}

// Ensure library.json exists
if (!fs.existsSync(libraryPath)) {
    console.log(`[Boot] library.json not found. Copying template...`);
    if (fs.existsSync(libraryTemplatePath)) {
        fs.copyFileSync(libraryTemplatePath, libraryPath);
    } else {
        console.error(`[Boot] CRITICAL: library.template.json is missing from ${libraryTemplatePath}`);
    }
} else {
    console.log(`[Boot] library.json already exists. Skipping generation.`);
}

// ---------------------------------------------------------
// ⚙️ AUTO-GENERATE DEFAULT SETTINGS
// ---------------------------------------------------------
const settingsPath = path.join(USER_ROOT, 'settings.json');

const DEFAULT_SEARCH_MENU_ORDER = [
    { key: 'global',           name: 'Global',       icon: null,                       enabled: true, sourceType: 'global' },
    { key: 'tunein',           name: 'TuneIn Radio', icon: 'images/TuneIn_icon.png',  enabled: true, sourceType: 'radio'  },
    { key: 'filesystem_local', name: 'Local NAS',    icon: 'images/nas_icon.png',     enabled: true, sourceType: 'music'  }
];

const DEFAULT_SETTINGS = {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    autoResumePreset: false,
    autoRestartMass: false,
    autoSyncVolume: false,
    mobileAutoSortSpeakers: true,
    scheduledSpeakerAudit: false,
    scheduledAuditHour: 2,
    scheduledRestart: true,
    scheduledRestartHour: 3,
    includeReboot: true,
    doubleTapPresets: false,
    presetPreview: true,
    descriptivePresets: false,
    restrictedMode: false,
    adminPin: "",
    scheduledEvents: [],
    powerOffTimers: [],
    presetWatchdogSpeakers: [],
    speakerBlacklist: [],
    searchMenuOrder: DEFAULT_SEARCH_MENU_ORDER
};

if (!fs.existsSync(settingsPath)) {
    console.log(`[Boot] settings.json not found. Generating defaults...`);
    fs.writeFileSync(settingsPath, JSON.stringify(DEFAULT_SETTINGS, null, 4));
} else {
    try {
        const existing = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        if (existing.schemaVersion !== SETTINGS_SCHEMA_VERSION) {
            console.log(`[Boot] settings.json schema mismatch (found: ${existing.schemaVersion || 'none'}, expected: ${SETTINGS_SCHEMA_VERSION}). Backing up to settings.json.bak...`);
            fs.renameSync(settingsPath, path.join(USER_ROOT, 'settings.json.bak'));
            fs.writeFileSync(settingsPath, JSON.stringify(DEFAULT_SETTINGS, null, 4));
            console.log(`[Boot] Fresh settings.json written. Old config saved to config/settings.json.bak.`);
        } else {
            console.log(`[Boot] settings.json schema ${SETTINGS_SCHEMA_VERSION} OK.`);
        }
    } catch (e) {
        console.error(`[Boot] settings.json read error — regenerating defaults:`, e.message);
        fs.writeFileSync(settingsPath, JSON.stringify(DEFAULT_SETTINGS, null, 4));
    }
}

// ============================================================================
// PHASE 4: CONFIGURATION VALIDATION (The "Bouncer")
// ============================================================================
if (isReady) {
    // Only parse the file if we know it's not a fresh, empty template
    require('dotenv').config({ path: envPath, override: true });

    // Check required variables
    const requiredEnvVars = ['APP_IP', 'MASS_IP'];
    for (const v of requiredEnvVars) {
        if (!process.env[v] || process.env[v].trim() === '') {
            console.log(`[!!] Validation Failed: Missing or empty variable -> ${v}`);
            isReady = false;
        }
    }

    // MASS credentials: either MASS_TOKEN alone, or MASS_USERNAME + MASS_PASSWORD together
    if (!process.env.MASS_TOKEN || process.env.MASS_TOKEN.trim() === '') {
        for (const v of ['MASS_USERNAME', 'MASS_PASSWORD']) {
            if (!process.env[v] || process.env[v].trim() === '') {
                console.log(`[!!] Validation Failed: Missing or empty variable -> ${v} (or provide MASS_TOKEN instead)`);
                isReady = false;
            }
        }
    }

    // speakers.json just needs to be valid JSON — auto-discovery (systemBoot's
    // parallel discovery block) populates it on every boot regardless of content.
    if (fs.existsSync(speakersPath)) {
        try {
            JSON.parse(fs.readFileSync(speakersPath, 'utf8'));
        } catch (e) {
            console.log(`[!!] Validation Failed: speakers.json is invalid JSON.`);
            isReady = false;
        }
    }
}

// ============================================================================
// THE GATEKEEPER: SLEEP OR BOOT?
// ============================================================================
if (!isReady) {
    console.error('========================================================');
    console.error(' ACTION REQUIRED: Setup Incomplete');
    if (process.env.SUPERVISOR_TOKEN) {
        console.error(` 1. Open this add-on's Configuration tab.`);
        console.error(' 2. Fill in (or re-confirm) the required fields.');
        console.error(' 3. Restart this add-on from the Info tab.');
    } else {
        console.error(' 1. Open the folder where your docker .yml file is located.');
        console.error(' 2. Edit the config/.env file.');
        console.error(' 3. Restart this container (docker compose restart).');
    }
    console.error('========================================================');
    console.error(' App is safely halted. Fix your config to boot.');

    // This puts Docker to sleep instead of crashing it (No more infinite restart loops!)
    setInterval(() => {}, 1000 * 60 * 60);
} else {

// ============================================================================
// PHASE 5: ENVIRONMENT INITIALIZATION
// ============================================================================
    const deviceState = require('./device_state');
    const { restartMassContainer, getMassHealth } = require('./routes/mass_utils');
    const preflight = require('./routes/preflight');

    // Smart Timezone Detection & Logging
    if (process.env.TZ) {
        // Docker passed it successfully from the .yml file
        console.log(`[Boot] 🕒 Timezone loaded from Docker config: ${process.env.TZ}`);
    } else {
        // User forgot to set it in the .yml file
        process.env.TZ = 'UTC';
        console.log(`[Boot] ⚠️ No Timezone found in Docker .yml. Defaulting to UTC.`);
    }

    const PORT = process.env.APP_PORT;

    // ============================================================================
    // PHASE 6: WEB SERVER & ROUTING
    // ============================================================================
    const app = express();

    if (process.env.TRUST_PROXY === 'true') {
        app.set('trust proxy', true);
        console.log("[Boot] 🛡️  Running behind Reverse Proxy (Trust Proxy Enabled)");
    }		

    app.use(cors());
    app.use(bodyParser.json());
    app.use(express.static(path.join(__dirname, 'public')));

    app.use('/api', require('./routes/controller'));
    app.use('/api', require('./routes/manager'));
    app.use('/api', require('./routes/admin'));
    app.use('/api', require('./routes/tools').router);
    app.use('/api/admin', require('./routes/mass_utils').router);

    // bose_cloud is NOT mounted separately here — bridge.js already mounts it
    // internally (router.use('/', boseCloudRoutes) near the top of bridge.js),
    // and require()'s module cache means that's the same router instance a
    // second app.use('/', ...) here would just re-run redundantly on every
    // request (double Content-Type/ETag stamping, double watchdog log entries).
    app.use('/', require('./routes/bridge'));

    app.get('/api/logs', (req, res) => res.type('text/plain').send(logBuffer.join('\n')));
    app.get('/api/check_update', (req, res) => res.json(UPDATE_CACHED_DATA));
    app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'control.html')));

// ============================================================================
    // PHASE 7: HARDWARE BOOT SEQUENCE
    // ============================================================================
    function parseSemver(tag) {
        return (tag || '').replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
    }
    function isNewerThan(a, b) {
        const [aMaj, aMin, aPatch = 0] = parseSemver(a);
        const [bMaj, bMin, bPatch = 0] = parseSemver(b);
        if (aMaj !== bMaj) return aMaj > bMaj;
        if (aMin !== bMin) return aMin > bMin;
        return aPatch > bPatch;
    }

    async function checkGitHubForUpdates() {
        try {

		   const githubRes = await axios.get(`https://api.github.com/repos/TJGigs/Bose-SoundTouch-Hybrid/releases/latest?t=${Date.now()}`, {
                headers: {
                    'User-Agent': 'Bose-Hybrid-App',
                    'Cache-Control': 'no-cache, no-store, must-revalidate',
                    'Pragma': 'no-cache'
                }
            });

            const latestVersion = githubRes.data.tag_name;
            if (isNewerThan(latestVersion, CURRENT_VERSION)) {
                console.log(`\n[Boot] 🚀 SOUNDTOUCH HYBRID UPDATE AVAILABLE! Current: ${CURRENT_VERSION} | Latest: ${latestVersion}\n`);
                UPDATE_CACHED_DATA = { updateAvailable: true, current: CURRENT_VERSION, latest: latestVersion, url: githubRes.data.html_url };
            } else {
                console.log(`\n[Boot] ✓ App is up to date (${CURRENT_VERSION})\n`);
            }
        } catch (e) {
            console.log(`\n[Boot] ⚠️ Could not check for updates on GitHub.\n`);
        }
    }

    async function systemBoot() {

        // PARALLEL DISCOVERY BLOCK — runs before the main roll call every boot.
        // Scans the network, merges results into speakers.json (preserving offline speakers,
        // self-healing any name/type/deviceId drift on ones it does find), then writes the file.
        {
            const { discoverSpeakers, getScanTarget, resolveConfiguredIps } = require('./routes/utils');

            // Resolve APP_IP/MASS_IP once, before anything below (or preflight's NVRAM
            // injection later this boot) reads a resolved value — hostname-safe for #155.
            // See Docs/design_subnet_and_hostname_resolution.md.
            await resolveConfiguredIps();

            const scanTarget = getScanTarget(); // SCAN_SUBNET override, or MASS_IP-derived /24 — see #143
            if (scanTarget) {
                console.log("\n============================================================================");
                console.log(`[Boot]  🔍  Speaker Discovery Scan (${scanTarget})...`);
                console.log("============================================================================");
                let discovered = await discoverSpeakers(scanTarget);
                let scanAttempt = 1;
                while (discovered.length === 0 && scanAttempt < 3) {
                    // A cold container start can beat the host's network stack to the punch —
                    // ARP/routing may not be settled yet for a 254-way parallel burst on the
                    // very first boot after install. A fresh install has nothing saved in
                    // speakers.json to fall back on if every attempt whiffs, so this gets a
                    // longer settle delay and one extra retry versus an established install
                    // (which just keeps its previously-saved speakers regardless).
                    scanAttempt++;
                    console.log(`[Boot] Scan found 0 speakers — retrying (attempt ${scanAttempt}/3) after a 10s delay (cold-start network settle)...`);
                    await new Promise(resolve => setTimeout(resolve, 10000));
                    discovered = await discoverSpeakers(scanTarget);
                }
                const discoveredIps = new Set(discovered.map(s => s.ip));

                let savedSpeakers = [];
                try { savedSpeakers = JSON.parse(fs.readFileSync(speakersPath, 'utf8')); } catch (e) { savedSpeakers = []; }

                let blacklist = [];
                try { blacklist = JSON.parse(fs.readFileSync(settingsPath, 'utf8')).speakerBlacklist || []; } catch (e) { blacklist = []; }

                for (const found of discovered) {
                    const existing = savedSpeakers.find(s => s.ip === found.ip);
                    if (existing) {
                        if (found.name) existing.name = found.name;
                        if (found.type) existing.type = found.type;
                        if (found.deviceId) existing.deviceId = found.deviceId;
                    } else if (blacklist.some(b => (found.deviceId && b.deviceId === found.deviceId) || b.ip === found.ip)) {
                        console.log(` [Scan] Skipped blacklisted speaker: ${found.name} (${found.ip})`);
                    } else {
                        savedSpeakers.push(found);
                        console.log(` [Scan] New speaker added: ${found.name} (${found.ip})`);
                    }
                }

                fs.writeFileSync(speakersPath, JSON.stringify(savedSpeakers, null, 2));

                for (const s of savedSpeakers) {
                    if (discoveredIps.has(s.ip)) {
                        console.log(` [Scan][OK] ${s.name.padEnd(20)} | Type: ${(s.type || 'Unknown').padEnd(15)} | IP: ${s.ip}`);
                    } else {
                        console.log(` [Scan][!!] ${s.name.padEnd(20)} | IP: ${s.ip.padEnd(15)} | Not seen this scan (offline, or outside this subnet)`);
                    }
                }
                console.log("============================================================================");
                if (savedSpeakers.length === 0) {
                    console.log(`[Boot] ⚠️ speakers.json has 0 speaker(s) — no Bose SoundTouch devices found on ${scanTarget}. Will retry on next restart.`);
                } else {
                    console.log(`[Boot]  speakers.json now has ${savedSpeakers.length} speaker(s) total.`);
                }
            }
        }

        // Load speakers fresh from file — picks up auto-discovery results and the
        // parallel discovery merge above, so the roll call below always reflects
        // this boot's latest data, not what was on disk before either ran.
        const SPEAKERS = JSON.parse(fs.readFileSync(speakersPath, 'utf8'));

        // This re-checks EVERY entry in speakers.json directly by its stored IP —
        // deliberately independent of the subnet-limited scan above, since
        // speakers.json can contain entries outside that subnet (manually added,
        // or just never matched by a sweep) that only this direct check can see.
        console.log("\n============================================================================");
        console.log(`[Boot]  🔍  Verifying All Configured Speakers (speakers.json, direct check)...`);
        console.log("============================================================================");

        const ALIVE_SPEAKERS = [];
        global.MISSED_AT_BOOT = new Set();
        const parser = new xml2js.Parser({ explicitArray: false });

        // STEP 1: The Hardware Roll Call (Ping Check)
        for (const s of SPEAKERS) {
            try {
                const res = await axios.get(`http://${s.ip}:8090/info`, { timeout: 1500 });
                const data = await parser.parseStringPromise(res.data);
                const type = data.info.type || data.info.$.type || "Unknown";
                console.log(` [Status][OK] ${s.name.padEnd(20)} | Type: ${type.padEnd(15)} | IP: ${s.ip}`);
                ALIVE_SPEAKERS.push(s);
            } catch (e) {
                console.log(` [Status][!!] ${s.name.padEnd(20)} | IP: ${s.ip.padEnd(15)} | OFFLINE (Skipping)`);
                global.MISSED_AT_BOOT.add(s.ip);
            }
        }
        console.log("============================================================================");

		// STEP 2: Force Injection Check & Pre-Flight Execution
        console.log(`\n----------------------------------------------------------------------------`);
        console.log(`[Boot] Handing over to Pre-Flight Speaker Configuration...`);
        console.log(`----------------------------------------------------------------------------`);
        
        let forceInjectTarget = null;
        let forceRebootTarget = null;
        const flagPath = path.join(USER_ROOT, 'force_inject.json');
        if (fs.existsSync(flagPath)) {
            try {
                const flagData = JSON.parse(fs.readFileSync(flagPath, 'utf8'));
                // Read the new variables safely from the JSON payload
                forceInjectTarget = flagData.forceInjectTarget || null;
                forceRebootTarget = flagData.forceRebootTarget || null;
                if (flagData.debugMode === true) {
                    global.DEBUG_MODE = true;
                    console.log(`[Boot] ⚠️ Verbose Debug Mode RESTORED from Force flag.`);
                }
                if (forceInjectTarget || forceRebootTarget) {
                    console.log(`[Boot] 🚨 FORCE SEQUENCE FLAG DETECTED!`);
                    if (forceInjectTarget) console.log(`   ├─ Inject Target: ${forceInjectTarget}`);
                    if (forceRebootTarget) console.log(`   ├─ Reboot Target: ${forceRebootTarget}`);
                }                
                // Delete the file so it only executes once!
                fs.unlinkSync(flagPath);
            } catch (e) {
                console.error("[Boot] ⚠️ Error reading force_inject.json flag file.", e);
            }
        }
        // Pass the new variables to the updated engine
        const preflightData = await preflight.runSetup(forceInjectTarget, forceRebootTarget);
        if (!preflightData.success) console.log(`[Boot] ⚠️ Pre-Flight encountered a soft error. Continuing boot...\n`);
        

// STEP 3: The Great Wait (Reboot Polling)
        if (preflightData.rebootedIps && preflightData.rebootedIps.length > 0) {
            console.log(`\n============================================================================`);
            console.log(`⏳ SPEAKER REBOOT SEQUENCE INITIATED`);
            console.log(`============================================================================\n`);
            console.log(`[Boot] Waiting for ${preflightData.rebootedIps.length} speaker(s) to finish rebooting...`);
            console.log(`[Boot] Bose SoundTouch speakers are historically very slow.`);
            console.log(`[Boot] Please wait ~90 seconds for shutdown and network reconnection.\n`);
            
            console.log(`[Boot] ⏳ Phase 1/2: Allowing 35 seconds for speakers to drop offline...`);
            await new Promise(r => setTimeout(r, 35000));
            
            console.log(`\n[Boot] ⏳ Phase 2/2: Polling speakers until network reconnects...`);

            for (const ip of preflightData.rebootedIps) {
                let online = false, attempts = 0;
                let finalInfo = null; 
                process.stdout.write(`[Boot] Polling ${ip} `); 
                
                while (!online && attempts < 24) { 
                    try {
                        const res = await axios.get(`http://${ip}:8090/info`, { timeout: 2000 });
                        online = true;
                        finalInfo = res.data;
                        console.log(` ✅ Online!`);
                        
                        if (!ALIVE_SPEAKERS.find(s => s.ip === ip)) {
                            const originalSpeaker = SPEAKERS.find(s => s.ip === ip);
                            if (originalSpeaker) ALIVE_SPEAKERS.push(originalSpeaker);
                        }
                    } catch (e) {
                        attempts++;
                        process.stdout.write('.'); 
                        await new Promise(r => setTimeout(r, 5000)); 
                    }
                }
                
                if (!online) {
                    console.log(` ⚠️ Timeout. Moving on.`);
                } else if (finalInfo) {
                    try {
                        const data = await parser.parseStringPromise(finalInfo);
                        const info = data.info || {};
                        const currentMargeUrl = info.margeURL || info.margeServerUrl || "";

                        const { getResolvedAppIp } = require('./routes/utils');
                        if (!currentMargeUrl.includes(`${getResolvedAppIp()}:${process.env.APP_PORT}`)) {
                            console.log(`\n============================================================================`);
                            console.log(`🚨 LEGACY V1/V2 CONFIGURATION DETECTED ON ${ip}!`);
                            console.log(`   The speaker is refusing the V3 update because an old USB hack file`);
                            console.log(`   is overriding the internal memory.`);
                            console.log(``);
                            console.log(`   TO FIX THIS AUTOMATICALLY:`);
                            console.log(`   1. Plug your "remote_services" USB setup cable into the speaker.`);
                            console.log(`   2. Reboot the speaker (unplug power, wait 10s, plug back in).`);
                            console.log(`   3. Wait 1 minute for it to connect to Wi-Fi.`);
                            console.log(`   4. Click "Restart SoundTouch Hybrid" in the System Tools menu.`);
                            console.log(``);
                            console.log(`   The Telnet Janitor will detect the USB, safely wipe the file,`);
                            console.log(`   reboot the speaker, and complete the V3 upgrade automatically!`);
                            console.log(`============================================================================\n`);
                        }
                    } catch (err) {}
                }
            }
            console.log(`\n============================================================================`);
            console.log(`✅ ALL SPEAKER REBOOTS COMPLETE`);
            console.log(`============================================================================\n`);
        }

        // STEP 4: Establish Territory (WebSockets)
        // All configured speakers get a WebSocket connection loop, including any that were
        // offline at boot. Speakers in global.MISSED_AT_BOOT will trigger late-join config
        // enforcement automatically on their first successful connection.
        console.log(`\n----------------------------------------------------------------------------`);
        console.log(`[Boot] Connecting Real-time WebSockets...`);
        console.log(`----------------------------------------------------------------------------`);
        SPEAKERS.forEach(s => deviceState.initDevice(s));

		// STEP 5: The Introduction (Restart MASS)
        console.log(`\n----------------------------------------------------------------------------`);
        console.log(`[Boot] Triggering Music Assistant restart for a clean network state...`);
        console.log(`----------------------------------------------------------------------------\n`);
        
        const dockerRestartSuccess = await restartMassContainer();
        if (dockerRestartSuccess) console.log(`\n[Boot] ⏳ Waiting for Music Assistant to come back online...`);

        let massHealth = { isOnline: false, version: "Unknown" };
        let healthAttempts = 0;
        
        // Loop every 2 seconds until the Health Check passes (Max 180 seconds —
        // doubled from the original 90s: MASS restarts noticeably slower when
        // it's itself a HA Supervisor add-on vs. a standalone Docker container).
        while (!massHealth.isOnline && healthAttempts < 90) {
            await new Promise(r => setTimeout(r, 2000)); 
            massHealth = await getMassHealth();
            if (!massHealth.isOnline) {
                process.stdout.write('.'); // Print dots while waiting
                healthAttempts++;
            }
        }
        if (healthAttempts > 0) console.log(); // Clear the line after dots finish

        if (massHealth.isOnline) {
            // Check the flag to print the correct message!
            if (dockerRestartSuccess) {
                console.log(`[Boot] ✓ Music Assistant restarted successfully (v${massHealth.version}).`);
            } else {
                console.log(`[Boot] ⚠️ Music Assistant is online (v${massHealth.version}), but was NOT restarted.`);
            }
            

            const current = massHealth.version.split('.').map(Number);
            const isOutdated = current.some((num, i) => num < minReq[i]);
            if (isOutdated) {console.log(`[Boot] ⚠️  NOTICE: Music Assistant ${minReq.join('.')} or later is required.\n`);}

          // STEP 6: Smart Polling & Configuration Injection
            const { enforcePlayerConfigs, enforcePlayerConfigsForSpeaker } = require('./routes/mass_utils');
            await enforcePlayerConfigs(ALIVE_SPEAKERS);

            // Register the late-join callback so device_state.js can trigger config
            // enforcement for any speaker that was offline at boot and connects later.
            deviceState.setLateJoinCallback(enforcePlayerConfigsForSpeaker);
            console.log(`----------------------------------------------------------------------------`);
            console.log(`[Boot] Prefetching recently played items to warm MASS cache...`);

            // Fire-and-forget: warms MASS's recently-played index so the first Recents
            // tab load in the UI is fast. Result is intentionally discarded.
            (async () => {
                try {
                    const massCore = require('./routes/mass');
                    const token = await massCore.getToken();
                    await axios.post(
                        `http://${process.env.MASS_IP}:${process.env.MASS_PORT || 8095}/api`,
                        { command: 'music/recently_played_items', args: { limit: 100, media_types: ['track', 'album', 'playlist', 'radio'] }, message_id: Date.now() },
                        { headers: { Authorization: `Bearer ${token}` } }
                    );
                } catch (e) {}
            })();

        } else {
            console.log(`\n[Boot] ⚠️ Music Assistant failed to report online after restart.\n`);
        }

        // STEP 7: Check Updates (Standalone Space)
        await checkGitHubForUpdates();

        // STEP 8: The Final Banner
		// 🌟 Cache globally so the frontend UI can fetch them instantly
        global.APP_VERSION = CURRENT_VERSION;
        global.MASS_VERSION = massHealth.version;
        console.log("============================================================================");
        console.log(`====      BOSE SOUNDTOUCH HYBRID:  ${CURRENT_VERSION.toUpperCase()}`);
        console.log(`====             MUSIC ASSISTANT:  v${massHealth.version}`);
        console.log("============================================================================\n");
        console.log(`${ANSI_BRIGHT_GREEN}➡️  Web UI accessible at: http://${process.env.APP_IP}:${PORT}/control.html${ANSI_RESET}\n`);
		
		// =======================================================================
        // STEP 9: NETWORK KEEP-ALIVE HEARTBEAT TEST AT 90 Min
        // =======================================================================
        const KEEP_ALIVE_INTERVAL_MS = 90 * 60 * 1000; // 90 minutes
        // Runs per the interval above to prevent network routers from killing idle DLNA/AirPlay sockets overnight.
        setInterval(async () => {
            console.log(`\n[Boot] Executing scheduled Network Keep-Alive ping to Music Assistant...`);
            try {
                const massCore = require('./routes/mass');

                // Runs the Soft Rescan (players/all) silently in the background
                // Passing the combined string ensures the backend logs perfectly match the UI
                await massCore.forceRescan(false, 'dlna & airplay');

            } catch (e) {
                // Silently catch network drops so the Docker container doesn't crash if MA is temporarily offline
                console.error(`[Boot] ⚠️ Keep-Alive heartbeat failed to reach MASS: ${e.message}`);
            }
        }, KEEP_ALIVE_INTERVAL_MS);
	}	

	const { startScheduler } = require('./routes/utils');
	startScheduler();
    app.listen(PORT, '0.0.0.0', systemBoot);
} // <--- closes the Gatekeeper "else" block
