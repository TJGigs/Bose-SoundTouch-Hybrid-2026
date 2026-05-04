// --- APP VERSION ---
const CURRENT_VERSION = "v3";
let UPDATE_CACHED_DATA = {updateAvailable: false,current: CURRENT_VERSION};
const express = require('express');
const fs = require('fs');
const path = require('path');
const bodyParser = require('body-parser');
const axios = require('axios');
const xml2js = require('xml2js');
const cors = require('cors');
// --- 1. READ .ENV DIRECTLY FROM FILE FIRST ---
require('dotenv').config({path: path.join(__dirname, 'config', '.env')})
const deviceState = require('./device_state');
const { dockerAction, getMassHealth } = require('./routes/mass_utils');

// --- DIRECTORY SETUP ---
// USER_ROOT links to the volume mapped in .yml file.
// Files saved appear in bose-soundtouch-hybrid dir.
const USER_ROOT = path.join(__dirname, 'config');
if (!fs.existsSync(USER_ROOT)) fs.mkdirSync(USER_ROOT);
// Create the logs subdirectory directly in the bose-soundtouch-hybrid DIR
const LOG_DIR = path.join(USER_ROOT, 'logs');if (!fs.existsSync(LOG_DIR))fs.mkdirSync(LOG_DIR);


// --- LIVE LOG INTERCEPTOR ---
// Captures console output into a rolling buffer for the Web UI
const MAX_LOG_LINES = 300; 
const logBuffer = [];
const originalLog = console.log;
const originalError = console.error;

function captureLog(type, args) {
    // Format timestamp nicely
    const time = new Date().toLocaleTimeString([], { hour12: false });
    // Convert arguments to a single string
    const msg = Array.from(args).map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' ');
    
    logBuffer.push(`[${time}] [${type}] ${msg}`);
    if (logBuffer.length > MAX_LOG_LINES) logBuffer.shift(); // Keep it from eating all your RAM
}

// Override the native functions
console.log = function() { captureLog('INFO', arguments); originalLog.apply(console, arguments); };
console.error = function() { captureLog('ERROR', arguments); originalError.apply(console, arguments); };



// --- TEMPLATE GENERATOR ---
const ensureConfig = (targetName, templateName) => {
    const livePath = path.join(USER_ROOT, targetName);
    const templatePath = path.join(__dirname, 'templates', templateName);

    // OVERWRITE PROTECTION: Only copies if the file DOES NOT exist
    if (!fs.existsSync(livePath)) {
        if (fs.existsSync(templatePath)) {
            fs.copyFileSync(templatePath, livePath);
            console.log(`[Boot] Generated default ${targetName} in main directory.`);
        } else {
            console.warn(`[Boot Warning] Template ${templateName} not found!`);
        }
    } else {
        console.log(`[Boot] ${targetName} already exists. Skipping generation.`);
    }

    return livePath;
};

// --- CONFIGURATION VALIDATION ---
async function checkGitHubForUpdates() {
    try {
        const githubRes = await axios.get('https://api.github.com/repos/TJGigs/Bose-SoundTouch-Hybrid-2026/releases/latest', {
            headers: {
                'User-Agent': 'Bose-Hybrid-App'
            }
        });

        const latestVersion = githubRes.data.tag_name;
        const releaseUrl = githubRes.data.html_url;

        if (latestVersion !== CURRENT_VERSION) {
            console.log(" ");
            console.log(`[Boot] 🚀  SOUNDTOUCH HYBRID UPDATE AVAILABLE! Current: ${CURRENT_VERSION} | Latest: ${latestVersion}`);
            UPDATE_CACHED_DATA = {
                updateAvailable: true,
                current: CURRENT_VERSION,
                latest: latestVersion,
                url: releaseUrl
            };
        } else {
            console.log(`[Boot] ✓ App is up to date (${CURRENT_VERSION})`);
        }
    } catch (e) {
        console.log(`[Boot] ⚠️ Could not check for updates on GitHub (No release found or offline).`);
    }
}

const validateConfig = (envPath, speakersPath) => {
    let isReady = true;
    const placeholderRegex = /xx+/i; // Matches 2 or more consecutive 'x's

    // Check .env for 'xx' placeholders
    if (fs.existsSync(envPath)) {
        const envContent = fs.readFileSync(envPath, 'utf8');
        if (placeholderRegex.test(envContent)) {
            console.error('[!!] HALTED: Unconfigured placeholder (contains "xx") found in .env');
            isReady = false;
        }
    }

    // Check speakers.json for empty arrays or default IPs
    if (fs.existsSync(speakersPath)) {
        try {
            const speakers = JSON.parse(fs.readFileSync(speakersPath, 'utf8'));
            if (speakers.length === 0 || placeholderRegex.test(JSON.stringify(speakers))) {
                console.error('[!!] HALTED: Unconfigured placeholder (contains "xx") or empty data found in speakers.json');
                isReady = false;
            }
        } catch (e) {
            console.error('[!!] HALTED: speakers.json format is invalid.');
            isReady = false;
        }
    }

    return isReady;
};

// 1. Generate/Ensure User Files Exist in /app/config
const envPath = ensureConfig('.env', '.env.template');
const speakersPath = ensureConfig('speakers.json', 'speakers.template.json');
const libraryPath = ensureConfig('library.json', 'library.template.json');

// 2. Validate configuration before starting
if (!validateConfig(envPath, speakersPath)) {
    console.error('========================================================');
    console.error(' ACTION REQUIRED: Setup Incomplete');
    console.error(' 1. Open the folder where your .yml file is located.');
    console.error(' 2. Edit your .env and speakers.json files.');
    console.error(' 3. Restart this container (docker compose restart).');
    console.error('========================================================');
    console.error(' App is halted. Waiting for user configuration...');

    // Gracefully halt without crashing Docker
    setInterval(() => {}, 1000 * 60 * 60);
} else {
    // ====================================================================
    // 3. SAFE BOOT: Configuration Validated. Load App.
    // ====================================================================

    const app = express();
    const PORT = process.env.APP_PORT;

    // Load User's specific speakers from the config folder
    const SPEAKERS = require(speakersPath);

    app.use(cors());
    app.use(bodyParser.json());

    // 1. SERVE STATIC FILES
    app.use(express.static(path.join(__dirname, 'public')));

    // 2. IMPORT MODULES (From the 'routes' folder)
    const controllerRoutes = require('./routes/controller');
    const managerRoutes = require('./routes/manager');
    const adminRoutes = require('./routes/admin');
    const bridgeRoutes = require('./routes/bridge'); // The Listener

    
	
	// --- LIVE LOG ENDPOINT ---
    app.get('/api/logs', (req, res) => {
        // Send the array as a single block of text separated by line breaks
        res.type('text/plain').send(logBuffer.join('\n'));
    });
	
	// --- UPDATE CHECKER ROUTE
    app.get('/api/check_update', (req, res) => {
        res.json(UPDATE_CACHED_DATA);
    });

    // 3. MOUNT ROUTES
    app.use('/api', controllerRoutes);
    app.use('/api', managerRoutes);
    app.use('/api', adminRoutes);
    app.use('/', bridgeRoutes); // Must be root for /preset/1.mp3
    app.use('/api/admin', require('./routes/mass_utils').router);


    // 4. AUTO-REDIRECT ROOT
    app.get('/', (req, res) => {
        res.sendFile(path.join(__dirname, 'public', 'control.html'));
    });

    // 5. SYSTEM BOOT CHECK
    async function systemBoot() {
        // --- MASS HEALTH & AUTO-HEAL ---
        let massHealth = await getMassHealth();

        if (!massHealth.isOnline) {
            console.log("[Boot] ⚠️ Music Assistant is offline or unresponsive.");
            console.log("[Boot] 🚀 Triggering Music Assistant Start/Restart via Docker...");
            try {
                await dockerAction('restart');
                console.log("[Boot] ⏳ Waiting 15s for Music Assistant to initialize...");
                await new Promise(r => setTimeout(r, 15000));
                massHealth = await getMassHealth();
                console.log("[Boot] ✅ Music Assistant restarted successfully.");
            } catch (e) {
                console.error("[Boot] ❌ Docker Start Failed: Check socket permissions.");
                massHealth = {
                    isOnline: false,
                    version: "Error"
                };
            }
        }

        // --- Version & Health Confirmation ---
        if (massHealth.isOnline) {
			console.log(``);
            console.log(`[Boot] ✅  Music Assistant is running (v${massHealth.version}).`);

            // --- Version Requirement Check (Minimum 2.8.5) ---
            const minReq = [2, 8, 5];
            const current = massHealth.version.split('.').map(Number);

            const isOutdated = current.some((num, i) => {
                if (num < minReq[i])
                    return true;
                if (num > minReq[i])
                    return false;
                return false;
            });

            if (isOutdated) {
                console.log("=======================================================================");
                console.log(`[Boot] ⚠️  NOTICE: Music Assistant version ${massHealth.version} is below 2.8.5.`);
                console.log(`[Boot] ⚠️  Music Assistant 2.8.5 or later is required.`);
                console.log("=======================================================================");
            }
        }

        // update check
        await checkGitHubForUpdates();

        // Clean up the display version so the banner always looks good
        const displayVersion = massHealth.version === "Unknown" ? "2.x" : massHealth.version;

        console.log(" ");
        console.log("=======================================================================");
        console.log(`====      BOSE SOUNDTOUCH HYBRID 2026:  ${CURRENT_VERSION.toUpperCase()}`);
        console.log(`====                  MUSIC ASSISTANT:  v${massHealth.version}`);
        console.log("=======================================================================");

        const parser = new xml2js.Parser({
            explicitArray: false
        });

        for (const s of SPEAKERS) {
            try {
                const res = await axios.get(`http://${s.ip}:8090/info`, {
                    timeout: 1500
                });
                const data = await parser.parseStringPromise(res.data);
                const type = data.info.type || data.info.$.type || "Unknown";
                console.log(` [OK] ${s.name.padEnd(20)} | Type: ${type.padEnd(15)} | IP: ${s.ip}`);
            } catch (e) {
                console.log(` [!!] ${s.name.padEnd(20)} | IP: ${s.ip.padEnd(15)} | OFFLINE`);
            }
        }
        console.log("-----------------------------------------------------------------------");
        console.log(`[Boot] Connecting Real-time WebSockets...`);
        SPEAKERS.forEach(s => {
            deviceState.initDevice(s);
        });
        console.log("-----------------------------------------------------------------------");
        console.log(`➡️  Web UI accessible at: http://${process.env.APP_IP}:${PORT}/control.html`);
        console.log("");
    }

    //  0.0.0.0 so Docker binds correctly
    app.listen(PORT, '0.0.0.0', systemBoot);
}