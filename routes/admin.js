const express = require('express');
const router = express.Router();
const axios = require('axios');
const xml2js = require('xml2js');
const net = require('net');
const BOSE_HEADERS = {
    headers: {
        'Content-Type': 'application/xml'
    }
};
const mass = require('./mass');
const { scheduleProviderReload } = require('./utils');

// --- UNIFIED SMART COMMAND ROUTER ---
// Forwards commands directly to controller.js to inherit Master/Slave and Queue cleanup logic
async function routeToSmartController(ip, key) {
    const LOCAL_PORT = process.env.APP_PORT;
    console.log(`[Admin] Routing ${key} command for ${ip} through the Smart Controller...`);
    await axios.post(`http://127.0.0.1:${LOCAL_PORT}/api/key`, {
        ip,
        key
    });
}

router.get('/admin/device_status', async(req, res) => {
    const { ip } = req.query;
    try {
        const [bass, clock, autoOff, nowPlaying, info, netStats] = await Promise.all([
                    axios.get(`http://${ip}:8090/bass`, {
                        timeout: 1500
                    }).catch(() => null),
                    axios.get(`http://${ip}:8090/clockDisplay`, {
                        timeout: 1500
                    }).catch(() => null),
                    axios.get(`http://${ip}:8090/systemtimeout`, {
                        timeout: 1500
                    }).catch(() => null),
                    axios.get(`http://${ip}:8090/now_playing`, {
                        timeout: 1500
                    }).catch(() => null),
                    axios.get(`http://${ip}:8090/info`, {
                        timeout: 1500
                    }).catch(() => null),
                    axios.get(`http://${ip}:8090/netStats`, {
                        timeout: 1500
                    }).catch(() => null)
                ]);

        const parser = new xml2js.Parser({
            explicitArray: false
        });
        const result = {
            bass: 0,
            clock: 'N/A',
            autoOff: 'N/A',
            power: 'UNKNOWN',
            name: '',
            nowPlaying: 'Unknown',
            ssid: '---',
            rssi: '---',
            freq: '',
            fw: '---',
            rawSource: 'UNKNOWN'
        };

        if (bass && bass.data) {
            const b = await parser.parseStringPromise(bass.data);
            result.bass = parseInt(b.bass.targetbass || b.bass.actualbass || 0);
        }
        if (nowPlaying && nowPlaying.data) {
            const np = await parser.parseStringPromise(nowPlaying.data);
            const source = np.nowPlaying.$.source;
            result.power = (source === 'STANDBY') ? 'STANDBY' : 'ON';
            result.nowPlaying = (np.nowPlaying.ContentItem && np.nowPlaying.ContentItem.itemName) ? np.nowPlaying.ContentItem.itemName : source;
            result.rawSource = source;
        }

        if (info && info.data) {
            const i = await parser.parseStringPromise(info.data);
            result.name = i.info.name;
            if (i.info.components && i.info.components.component) {
                const comps = i.info.components.component;
                const compArray = Array.isArray(comps) ? comps : [comps];
                const scm = compArray.find(c => c.componentCategory === 'SCM');
                if (scm && scm.softwareVersion) {
                    result.fw = scm.softwareVersion;
                }
            }
        }

        if (netStats && netStats.data) {
            const ns = await parser.parseStringPromise(netStats.data);
            const devices = ns['network-data']?.devices?.device;
            const device = Array.isArray(devices) ? devices[0] : devices;
            if (device?.interfaces?.interface) {
                const ifaces = Array.isArray(device.interfaces.interface) ? device.interfaces.interface : [device.interfaces.interface];
                const wifi = ifaces.find(iface => iface.kind === 'Wireless' || iface.ssid);
                if (wifi) {
                    result.ssid = wifi.ssid;
                    result.rssi = wifi.rssi;

                    // Parse the frequency into 5G or 2.4G
                    if (wifi.frequencyKHz) {
                        const freqNum = parseInt(wifi.frequencyKHz, 10);
                        if (freqNum >= 5000000)
                            result.freq = '5G';
                        else if (freqNum >= 2400000)
                            result.freq = '2.4G';
                    }
                }
            }
        }
        if (clock && clock.data) {
            const c = await parser.parseStringPromise(clock.data);
            if (c.clockDisplay && c.clockDisplay.clockConfig) {
                result.clock = c.clockDisplay.clockConfig.$.userEnable;
            }
        }
        if (autoOff && autoOff.data) {
            const a = await parser.parseStringPromise(autoOff.data);
            if (a.systemtimeout)
                result.autoOff = a.systemtimeout.powersaving_enabled;
        }
        res.json(result);
    } catch (e) {
        res.status(500).json({
            error: "Failed to fetch state"
        });
    }
});

router.post('/admin/key', async(req, res) => {
    try {
        await routeToSmartController(req.body.ip, req.body.key);
        res.send({
            success: true
        });
    } catch (e) {
        console.error(`[Admin] Failed to route key ${req.body.key} to smart controller:`, e.message);
        res.status(500).send(e.message);
    }
});

// RENAME ROUTE WITH LOGGING
router.post('/admin/name', async(req, res) => {
    try {
        console.log(`[Admin] Attempting to rename ${req.body.ip} to "${req.body.name}"...`);
        const boseRes = await axios.post(`http://${req.body.ip}:8090/name`, `<name>${req.body.name}</name>`, BOSE_HEADERS);
        console.log(`[Admin] Rename response from speaker: HTTP ${boseRes.status}`);
        res.send({
            success: true
        });
    } catch (e) {
        console.log(`[Admin] Rename failed on ${req.body.ip}: ${e.response?.data || e.message}`);
        res.status(500).send(e.response?.data || e.message);
    }
});

router.post('/admin/bass', async(req, res) => {
    try {
        await axios.post(`http://${req.body.ip}:8090/bass`, `<bass>${req.body.value}</bass>`, BOSE_HEADERS);
        res.send({
            success: true
        });
    } catch (e) {
        res.status(500).send(e.message);
    }
});
router.post('/admin/bluetooth', async(req, res) => {
    try {
        await axios.post(`http://${req.body.ip}:8090/select`, `<ContentItem source="BLUETOOTH" />`, BOSE_HEADERS);
        res.send({
            success: true
        });
    } catch (e) {
        res.status(500).send(e.message);
    }
});

router.post('/admin/settings_toggle', async(req, res) => {
    const { ip, tag } = req.body;
    let endpoint = `/${tag}`;
    try {
        const check = await axios.get(`http://${ip}:8090${endpoint}`);
        const parser = new xml2js.Parser({
            explicitArray: false
        });
        const data = await parser.parseStringPromise(check.data);
        let newState = 'true';
        let xmlBody = '';
        if (tag === 'clockDisplay') {
            let current = 'false';
            if (data.clockDisplay && data.clockDisplay.clockConfig)
                current = data.clockDisplay.clockConfig.$.userEnable;
            newState = (current === 'true') ? 'false' : 'true';
            let raw = check.data;
            if (raw.includes('userEnable="'))
                xmlBody = raw.replace(/userEnable="\w+"/, `userEnable="${newState}"`);
            else
                xmlBody = raw.replace('/>', ` userEnable="${newState}" />`);
        } else {
            let current = data[tag] || (data[tag] && data[tag]._) || 'false';
            newState = (current === 'true' || current === 'On') ? 'false' : 'true';
            xmlBody = `<${tag}>${newState}</${tag}>`;
        }
        await axios.post(`http://${ip}:8090${endpoint}`, xmlBody, BOSE_HEADERS);
        res.send({
            success: true,
            state: newState
        });
    } catch (e) {
        res.status(500).send({
            error: e.message
        });
    }
});

router.post('/admin/auto_off', async(req, res) => {
    const { ip } = req.body;
    try {
        const check = await axios.get(`http://${ip}:8090/systemtimeout`);
        const parser = new xml2js.Parser({
            explicitArray: false
        });
        const data = await parser.parseStringPromise(check.data);
        let currentVal = 'true';
        if (data.systemtimeout)
            currentVal = data.systemtimeout.powersaving_enabled;
        const newState = (currentVal === 'true') ? 'false' : 'true';
        const xml = `<systemtimeout><powersaving_enabled>${newState}</powersaving_enabled></systemtimeout>`;
        await axios.post(`http://${ip}:8090/systemtimeout`, xml, BOSE_HEADERS);
        res.send({
            success: true,
            state: newState
        });
    } catch (e) {
        res.status(500).send({
            error: e.message
        });
    }
});

router.get('/admin/deepscan', async(req, res) => {
    const targets = ["info", "netStats", "now_playing", "presets", "sources", "setup"];
    const results = {};
    for (const t of targets) {
        try {
            const r = await axios.get(`http://${req.query.ip}:8090/${t}`);
            results[t] = r.data;
        } catch (e) {
            results[t] = "Error";
        }
    }
    res.json(results);
});

// --- SMART SOURCE TOGGLE (Wi-Fi -> AUX -> Bluetooth) ---
router.post('/admin/toggle_source', async(req, res) => {
    const { ip } = req.body;
    const parser = new xml2js.Parser({
        explicitArray: false
    });

    try {
        // 1. Check what the speaker is currently playing
        const npRes = await axios.get(`http://${ip}:8090/now_playing`, {
            timeout: 3000
        });
        const npData = await parser.parseStringPromise(npRes.data);

        const currentSource = npData.nowPlaying.$.source;
        let nextPayload = "";
        let finalUiState = ""; // Track the exact string to send back to the UI

        // 2. The Toggle Logic
        if (currentSource === 'AUX') {
            console.log(`[Admin] Toggling ${ip} from AUX to BLUETOOTH`);
            nextPayload = `<ContentItem source="BLUETOOTH" />`;
            finalUiState = "BLUETOOTH";

        } else if (currentSource === 'BLUETOOTH') {
            console.log(`[Admin] Toggling ${ip} from BLUETOOTH to WI-FI (Via Silent Stream)`);
            const { getResolvedAppIp } = require('./utils');
            const host = `${getResolvedAppIp()}:${process.env.APP_PORT}`;
            // Standard Bose tag for custom URLs
            nextPayload = `<ContentItem source="LOCAL_INTERNET_RADIO" location="http://${host}/silent.mp3"><itemName>Ready</itemName></ContentItem>`;
            mass.setPresetMemory(ip, 0);
            finalUiState = "WIFI";

        } else {
            console.log(`[Admin] Toggling ${ip} from ${currentSource} to AUX`);
            nextPayload = `<ContentItem source="AUX" sourceAccount="AUX" />`;
            finalUiState = "AUX";
        }

        // 3. Send the command to change the source
        try {
            await axios.post(`http://${ip}:8090/select`, nextPayload, BOSE_HEADERS);
        } catch (boseErr) {
            // Bose throws a 500 Server Error on dummy URL.
            // But it successfully drops the Bluetooth/AUX connection and enters
            // INVALID_SOURCE (Network Ready). So this specific 500 error is a success
            if (finalUiState !== 'WIFI') {
                throw boseErr; // If AUX or BT fail, throw a real error
            }
        }

        // 4. Return the correct explicit state to the UI
        res.send({
            success: true,
            new_state: finalUiState
        });

    } catch (e) {
        console.log(`[Admin] Toggle Error: ${e.message}`);
        res.status(500).send({
            error: e.message
        });
    }
});

// --- TELNET REBOOT ROUTE (PORT 17000) ---
router.post('/admin/reboot_speaker', async(req, res) => {
    const { ip } = req.body;

    try {
        // 1. SMART SHUTDOWN: Check if it's awake before rebooting
        const statusRes = await axios.get(`http://${ip}:8090/now_playing`, {
            timeout: 2000
        });

        if (!statusRes.data.includes('source="STANDBY"')) {
            console.log(`[Admin] 💤 Clean shutdown: Routing POWER command for ${ip} before Telnet reboot...`);
            await routeToSmartController(ip, 'POWER');

            // Give controller.js and the hardware 1.5 seconds to finish clearing queues
            await new Promise(r => setTimeout(r, 1500));
        }
    } catch (e) {
        console.log(`[Admin] ⚠️ Could not verify power state for ${ip} before reboot. Proceeding anyway.`);
    }

    // 2. EXECUTE THE HARDWARE REBOOT
    console.log(`[Admin] Sending Telnet 'sys reboot' to ${ip} on port 17000...`);

    const client = new net.Socket();
    client.on('error', (err) => console.log(`[Admin] Telnet error on ${ip}: ${err.message}`));

    client.connect(17000, ip, () => {
        client.write('sys reboot\r\n');
        setTimeout(() => client.destroy(), 500);
    });

    // 3. 90-SECOND SMART RECOVERY FOR DLNA & AIRPLAY
    scheduleProviderReload(ip);

    res.send({
        success: true
    });
});

module.exports = router;