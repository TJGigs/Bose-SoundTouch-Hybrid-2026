const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const xml2js = require('xml2js');
const WebSocket = require('ws'); // Gabbo Auto-Healer

// ============================================================================
// CONFIGURATION & SETUP
// ============================================================================
// WHAT: Basic server configuration.
// WHY: Need to know the App IP and Port to dynamically inject into the XML 
// payloads so the speaker knows exactly where to request the preset audio streams.
const IP = process.env.APP_IP;
const PORT = process.env.APP_PORT;
const envLogDir = process.env.LOG_DIR || "logs";
const LOG_DIR = path.resolve(process.cwd(), envLogDir);
// --- MAC ADDRESS CACHE ---
// Prevents the server from forgetting the speaker's identity if Port 8090 gets busy
const identityCache = {};

if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
}

// Helper to generate valid Bose-compatible ISO timestamps
function getTimestamp() {
    return new Date().toISOString();
}

// ============================================================================
// HELPER: IDENTITY FETCHER
// ============================================================================
// WHAT: Fetches the speaker's MAC address and Name from its internal server.
// WHY: When a Bose speaker boots, it aggressively contacts this Cloud server 
// BEFORE its own internal web server (port 8090) is fully awake. This function 
// loops up to 5 times to ensure we actually get the MAC address, which is 
// strictly required to format the XML payloads below.
async function getSpeakerIdentity(ip) {
	// If u know who this is, return it instantly
    if (identityCache[ip]) {
        return identityCache[ip];
    }
	
    for (let attempt = 1; attempt <= 5; attempt++) {
        try {
            const infoRes = await axios.get(`http://${ip}:8090/info`, { timeout: 2000 });
            const parser = new xml2js.Parser({ explicitArray: false });
            const infoData = await parser.parseStringPromise(infoRes.data);
            
            if (infoData && infoData.info) {
                const deviceId = infoData.info.$.deviceID || infoData.info.deviceID || "UNKNOWN";
                const name = infoData.info.name || "Bose Speaker";
                let serialNumber = "UNKNOWN";
                
                const comps = infoData.info.components?.component;
                const compArray = Array.isArray(comps) ? comps : [comps];
                const scm = compArray.find(c => c.componentCategory === 'SCM');
                
                if (scm && scm.serialNumber) {
                    serialNumber = scm.serialNumber;
                }
				// Save to cache so never drop it
                if (deviceId !== "UNKNOWN") {
                    identityCache[ip] = { deviceId, name, serialNumber };
                }			
                return { deviceId, name, serialNumber };
            }
        } catch (e) {
            console.log(`[Bose Cloud] ⏳ Waiting for ${ip}:8090 to wake up (Attempt ${attempt}/5)...`);
            await new Promise(r => setTimeout(r, 2000));
        }
    }
    return { deviceId: "UNKNOWN", name: "Bose Speaker", serialNumber: "UNKNOWN" };
}

// ============================================================================
// XML GENERATORS (THE DYNAMIC CLOUD INJECTION)
// ============================================================================
// WHAT: Generates the XML defining custom music source (Local Internet Radio).
// WHY: The speaker asks the cloud what providers are allowed. By sending this, 
//  authorize source "11" (LOCAL_INTERNET_RADIO), allowing it to appear in the app.
function generateSourceProviders(reqIp) {
    const time = getTimestamp();
    const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sourceProviders>
    <sourceprovider id="11">
        <name>LOCAL_INTERNET_RADIO</name>
        <createdOn>${time}</createdOn>
        <updatedOn>${time}</updatedOn>
    </sourceprovider>
</sourceProviders>`;
    fs.writeFileSync(path.join(LOG_DIR, `${reqIp}_sourceproviders.xml`), xml);
    return xml;
}

// WHAT: Generates the Master Account Profile (The most critical file).
// WHY: Inject Hybrid Presets directly into the speaker.
// When the speaker asks for its profile, build a fake account that maps Presets 1-6
// directly to the local bridge. This makes the physical buttons on the speaker 
// trigger the local Node server instead of Bose servers.
function generateAccountXml(reqIp, accountId, deviceId, serialNumber, deviceName) {
    const time = getTimestamp();
    const updateTime = Math.floor(Date.now() / 1000); // CACHE-BUSTER

    // 1. Build Presets mapping to the Bridge
    let presetsXml = '<presets>';
    for (let i = 1; i <= 6; i++) {
        const streamUrl = `http://${IP}:${PORT}/preset/${i}.mp3`;
        presetsXml += `
        <preset buttonNumber="${i}">
            <contentItemType>stationurl</contentItemType>
            <location>${streamUrl}</location>
            <name>Hybrid Preset ${i}</name>
            <createdOn>${time}</createdOn>
            <updatedOn>${time}</updatedOn>
            <source id="1001" type="Audio">
                <credential type="token" />
                <sourceproviderid>11</sourceproviderid>
                <createdOn>${time}</createdOn>
                <updatedOn>${time}</updatedOn>
            </source>
        </preset>`;
    }
    presetsXml += '</presets>';

    // 2. Build Sources
    const sourcesXml = `
    <sources>
        <source id="1001" type="Audio">
            <credential type="token" />
            <sourceproviderid>11</sourceproviderid>
            <createdOn>${time}</createdOn>
            <updatedOn>${time}</updatedOn>
        </source>
    </sources>`;

    // 3. Combine into the final payload
    const fullXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<account id="${accountId}">
    <accountStatus>OK</accountStatus>
    <updateTimestamp>${updateTime}</updateTimestamp>
    <devices>
        <device deviceid="${deviceId}">
            <name>${deviceName}</name>
            <serialnumber>${serialNumber}</serialnumber>
            <createdOn>${time}</createdOn>
            <updatedOn>${time}</updatedOn>
            ${presetsXml}
        </device>
    </devices>
    <mode>global</mode>
    ${sourcesXml}
</account>`;

    fs.writeFileSync(path.join(LOG_DIR, `${reqIp}_account.xml`), fullXml);
    return fullXml;
}

// ============================================================================
// MIDDLEWARE
// ============================================================================
// WHAT: Formats all outgoing responses to match Bose's strict XML requirements.
// WHY: If the Content-Type header doesn't exactly match 'application/vnd.bose...', 
// the speaker will reject the payload and refuse to boot.
router.use((req, res, next) => {
    if (req.url.includes('/streaming') || req.url === '/') {
        res.set('Content-Type', 'application/vnd.bose.streaming-v1.2+xml');
    }
    res.set('Etag', Date.now().toString());
    next();
});

const getIp = (req) => (req.ip || req.connection.remoteAddress || '').replace('::ffff:', '');

// ============================================================================
// THE ROUTES
// ============================================================================
router.get('/', (req, res) => {
    res.send('<?xml version="1.0" encoding="UTF-8" ?><marge><status>success</status></marge>');
});

// ============================================================================
// ROUTE: POWER ON & THE NVRAM AUTO-HEALER
// ============================================================================
// WHAT: The first call the speaker makes when connected to Wi-Fi.
// WHY: This is the intercept point. If a speaker is factory reset or stuck in a 
// setup loop, use the Gabbo System Bus (Port 8080) to inject the official setup 
// choreography (Language -> Name -> Account -> Seal) to permanently cure the NVRAM.
router.post('/streaming/support/power_on', (req, res) => {
    const reqIp = getIp(req);
    console.log(`[Bose Cloud] ⚡ Power On Signal Handled for ${reqIp}`);
    res.send('<status>success</status>'); // Acknowledge immediately to prevent panic

    setTimeout(async () => {
        try {
            // Check for the "Triple Threat" of unconfigured speakers
            const infoRes = await axios.get(`http://${reqIp}:8090/info`, { timeout: 2000 });
            const npRes = await axios.get(`http://${reqIp}:8090/now_playing`, { timeout: 2000 });
            const setupRes = await axios.get(`http://${reqIp}:8090/setup`, { timeout: 2000 });
            
            const parser = new xml2js.Parser({ explicitArray: false });
            const infoData = await parser.parseStringPromise(infoRes.data);
            const npData = await parser.parseStringPromise(npRes.data);
            const setupData = await parser.parseStringPromise(setupRes.data);
            
            const margeId = infoData?.info?.margeAccountUUID;
            const isBlank = !margeId || (typeof margeId === 'string' && margeId.trim() === '');
            const isStuckInSetup = (npData?.nowPlaying?.['$']?.source === 'SETUP');
            const isLangNotSet = (setupData?.setupStateResponse?.['$']?.systemstate === 'SETUP_LANG_NOT_SET');

            if (isBlank || isStuckInSetup || isLangNotSet) {
                console.log(`[Bose Cloud] 🔧 Speaker ${reqIp} failed Triple Threat Check. Executing NVRAM Gabbo Fix...`);
                
                let deviceId = "UNKNOWN";
                if (infoData?.info?.networkInfo) {
                    const networks = Array.isArray(infoData.info.networkInfo) ? infoData.info.networkInfo : [infoData.info.networkInfo];
                    const scm = networks.find(n => n?.['$']?.type === 'SCM');
                    if (scm) deviceId = scm.macAddress;
                }

                if (deviceId === "UNKNOWN") return;

                // Open Privileged System Bus
                console.log(`[Bose Cloud] 🔌 Opening Gabbo System Bus to ${reqIp}:8080...`);
                const ws = new WebSocket(`ws://${reqIp}:8080/`, 'gabbo');
                const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

                ws.on('open', async () => {
                    const sendCommand = async (xml, stepName) => {
                        ws.send(xml);
                        console.log(`[Bose Cloud] ↳ Sent: ${stepName} - Waiting 2s for NVRAM commit...`);
                        await sleep(2000); 
                    };

                    try {
                        // The Master Choreography to seal the disk
                        await sendCommand(`<?xml version="1.0"?><msg><header deviceID="${deviceId}" url="language" method="POST"><request requestID="74"><info mainNode="language" type="new"/><sourceItem source="SETTINGS" sourceAccount="${deviceId}"/></request></header><body><sysLanguage>3</sysLanguage></body></msg>`, 'Language (English)');
                        await sendCommand(`<msg><header deviceID="${deviceId}" url="name" method="POST"><request requestID="30"></request></header><body><name>Bose Hybrid</name></body></msg>`, 'Speaker Name');
                        await sendCommand(`<msg><header deviceID="${deviceId}" url="setMargeAccount" method="POST"><request requestID="31"></request></header><body><PairDeviceWithAccount><accountId>1234567</accountId></PairDeviceWithAccount></body></msg>`, 'Account Binding');
                        await sendCommand(`<msg><header deviceID="${deviceId}" url="setup" method="POST"><request requestID="100"></request></header><body><setupState state="SETUP_READY"/></body></msg>`, 'Setup Ready');
                        await sendCommand(`<msg><header deviceID="${deviceId}" url="setup" method="POST"><request requestID="32"></request></header><body><setupState state="SETUP_LEAVE" /></body></msg>`, 'Setup Leave & Seal');

                        console.log(`[Bose Cloud] 🎉 Auto-Setup complete! Persistence flags set for ${reqIp}.`);
                        ws.close();
                    } catch (error) {
                        console.error(`[Bose Cloud] ❌ Gabbo Sequence Error:`, error);
                    }
                });
            }
        } catch (e) {
            // Ignore if speaker isn't ready
        }
    }, 3000);
});

// ============================================================================
// DUMMY ROUTES & "TRAPS" (Protecting the Speaker from itself)
// ============================================================================

// WHAT: Analytics Trap
// WHY: The speaker tries to send telemetry home, drop it and return 200 OK 
// to instantly free up the speaker's CPU.
router.post('/events*', (req, res) => {
    console.log(`[Bose Cloud] 🗑️ Dropped Analytics Payload from ${getIp(req)}`);
    res.status(200).send("OK");
});

// WHAT: The Delete Trap
// WHY: If the speaker fails to boot properly, it might attempt to delete its 
// own account to start over (boot loop). This blocks the deletion but tells 
// the speaker it succeeded, saving the device profile.
router.delete('/streaming/account/:id/device/:deviceId', (req, res) => {
    const reqIp = getIp(req);
    console.log(`[Bose Cloud] 🛡️ BLOCKED Account Deletion request from ${reqIp}. Sending fake success.`);
    res.send('<?xml version="1.0" encoding="UTF-8" ?><status>success</status>');
});

// WHAT: SCM UDC Telemetry Trap
// WHY: Drops undocumented internal metrics pings to save speaker bandwidth.
router.post('/v1/scmudc/*', (req, res) => {
    console.log(`[Bose Cloud] 🗑️ Dropped SCM UDC Telemetry ping from ${getIp(req)}`);
	// Force the exact header like done for BMX Registry
    res.set('Content-Type', 'application/json');
    res.status(200).send('{"nextReportIn": 86400}');
});

// WHAT: Firmware Update Trap
// WHY: Tells the speaker there are no updates available, so it stops searching 
// and boots faster.
router.get('/updates*', (req, res) => {
    res.status(404).send("Not Found");
});

// WHAT: Factory Reset Handshake Trap
// WHY: When a speaker is totally wiped, it asks the cloud to register a new account.
// Returning 201 (Created) tricks the speaker into thinking the cloud accepted it.
router.post(['/streaming/account/:id/device', '/streaming/account/:id/device/'], (req, res) => {
    const reqIp = getIp(req);
    console.log(`[Bose Cloud] 🚨 Factory-Reset Speaker (${reqIp}) is asking to register!`);   
    res.status(201).send('<?xml version="1.0" encoding="UTF-8" ?><status>success</status>');
});

// WHAT: Device Profile Update Trap
// WHY: If you rename the speaker in the app, it sends a PUT request to the cloud.
// Acknowledging this prevents the speaker from reverting to its old name.
router.put('/streaming/account/:id/device/:deviceId', (req, res) => {
    const reqIp = getIp(req);
    console.log(`[Bose Cloud] 📝 Acknowledged Cloud Sync (Rename/Update) from ${reqIp}`);
    res.send('<?xml version="1.0" encoding="UTF-8" ?><status>success</status>');
});

// WHAT: Device Group Trap
// WHY: Speaker asks if it's in a stereo pair. Return an empty group to satisfy the parser.
router.get('/streaming/account/:id/device/:deviceId/group/', (req, res) => {
    res.send('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><group/>');
});

// WHAT: Presets Fetch Trap
// WHY: Speaker occasionally asks for presets directly. Return an empty shell 
// since the /full account profile already injects the real hybrid ones.
router.get('/streaming/account/:id/device/:deviceId/presets', (req, res) => {
    res.send('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><presets/>');
});

// WHAT: True Firmware Update Trap
// WHY: Matches the actual UberBose spec path so the speaker doesn't parse a 404 HTML error.
router.get('/streaming/software/update/account/:id', (req, res) => {
    res.send('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><software_update><softwareUpdateLocation></softwareUpdateLocation></software_update>');
});

// ============================================================================
// PROFILE & BMX DELIVERY ROUTES
// ============================================================================

// WHAT: Delivers the source providers list.
// WHY: Triggers generator function above to inject source 11 (Internet Radio).
router.get('/streaming/sourceproviders', (req, res) => {
    const reqIp = getIp(req);
    console.log(`[Bose Cloud] 📋 Delivered SourceProviders to ${reqIp}`);
    res.send(generateSourceProviders(reqIp));
});

// WHAT: Account Profile Delivery
// WHY: Uses the identity fetcher to get the MAC address, then dynamically builds 
// the Account XML using the generator. This physically inserts Presets 1-6 
// into the speaker's memory.
router.get('/streaming/account/:id/full', async (req, res) => {
    const reqIp = getIp(req);
    const accountId = req.params.id || "6261590";
    
    console.log(`[Bose Cloud] 📥 Account Profile requested by ${reqIp}. Fetching identity...`);
    const identity = await getSpeakerIdentity(reqIp);
	
	// THE FAILSAFE: Do not wipe the speaker if it's too busy to answer!
    if (identity.deviceId === "UNKNOWN") {
        console.log(`[Bose Cloud] ⚠️ Speaker ${reqIp} is too busy to identify. Dropping request in order to protect presets.`);
        return res.status(503).send("Speaker Busy");
    }

    console.log(`[Bose Cloud] 🚀 Delivered Account Profile to ${reqIp} (${identity.name} - ID: ${identity.deviceId})`);
    res.send(generateAccountXml(reqIp, accountId, identity.deviceId, identity.serialNumber, identity.name)); 
});

// WHAT: Provider Settings Mock
// WHY: Satisfies the speaker's internal checks so it doesn't throw a "Cannot connect" error.
router.get('/streaming/account/:id/provider_settings', (req, res) => {
    res.send('<?xml version="1.0" encoding="UTF-8" ?><providerSettings><status>success</status></providerSettings>');
});

// WHAT: DRM Streaming Token Mock
// WHY: Don't authenticate with Spotify here. Returning 404 cleanly hides premium options.
router.get('/streaming/device/:id/streaming_token', (req, res) => {
    res.status(404).send('Not Found');
});

// WHAT: Dummy Radio Base URL
// WHY: Required by the BMX registry to validate the Local Radio service endpoint.
router.use('/radio', (req, res) => {
    res.status(200).send("OK");
});

// WHAT: BMX Registry (The UI Injection)
// WHY: Tells the speaker's UI to actually display the Internet Radio icon. Because 
// baseUrl to the local server, any preset mapped to this source routes 
// directly to Hybrid bridge instead of Bose.
router.get('/bmx/registry/v1/services', (req, res) => {
    const reqIp = getIp(req);
    console.log(`[Bose Cloud] ☁️ Delivered BMX Registry to ${reqIp}`);
    res.set('Content-Type', 'application/json');
    
    const registryData = {
        "_links": { "bmx_services_availability": { "href": "../servicesAvailability" } },
        "askAgainAfter": 1230482,
        "bmx_services": [
            {
                "id": { "name": "LOCAL_INTERNET_RADIO", "value": 11 },
                "baseUrl": `http://${IP}:${PORT}/radio`,
                "_links": { "bmx_token": { "href": "/token" }, "self": { "href": "/" } },
                "askAdapter": false,
                "authenticationModel": { "anonymousAccount": { "autoCreate": true, "enabled": true } },
                "streamTypes": ["liveRadio"],
                "assets": { "name": "Hybrid Radio" }
            }
        ]
    };

    fs.writeFileSync(path.join(LOG_DIR, `${reqIp}_bmx_registry.json`), JSON.stringify(registryData, null, 2));
    res.json(registryData);
});
module.exports = router;