const express = require('express');
const router = express.Router();
const axios = require('axios');
const xml2js = require('xml2js');
const net = require('net'); 
const BOSE_HEADERS = { headers: { 'Content-Type': 'application/xml' } };
const mass = require('./mass');

router.post('/admin/play_stream', async (req, res) => {
    const { ip, url, name } = req.body;
    
    console.log(`[Admin] Requesting MASS to stream custom URL on ${ip}: ${url}`);
    
    try {
        // Hand the raw URL directly to Music Assistant. 
        // MA will do the UPnP/DLNA conversion and push it to the speaker seamlessly.
        const success = await mass.play(ip, { uri: url, name: name });
        
        if (success) {
            res.send({ success: true });
        } else {
            res.status(500).send({ error: "Music Assistant failed to play the stream." });
        }
    } catch (e) { 
        res.status(500).send({ error: e.message }); 
    }
});

router.get('/admin/device_status', async (req, res) => {
    const { ip } = req.query;
    try {
        const [bass, clock, autoOff, nowPlaying, info, netStats] = await Promise.all([
            axios.get(`http://${ip}:8090/bass`, { timeout: 1500 }).catch(() => null),
            axios.get(`http://${ip}:8090/clockDisplay`, { timeout: 1500 }).catch(() => null),
            axios.get(`http://${ip}:8090/systemtimeout`, { timeout: 1500 }).catch(() => null),
            axios.get(`http://${ip}:8090/now_playing`, { timeout: 1500 }).catch(() => null),
            axios.get(`http://${ip}:8090/info`, { timeout: 1500 }).catch(() => null),
            axios.get(`http://${ip}:8090/netStats`, { timeout: 1500 }).catch(() => null)
        ]);

        const parser = new xml2js.Parser({ explicitArray: false });
        const result = { bass: 0, clock: 'N/A', autoOff: 'N/A', power: 'UNKNOWN', name: '', nowPlaying: 'Unknown', ssid: '---', rssi: '---', freq: '', fw: '---',rawSource: 'UNKNOWN' };

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
                         if (freqNum >= 5000000) result.freq = '5G';
                         else if (freqNum >= 2400000) result.freq = '2.4G';
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
             if (a.systemtimeout) result.autoOff = a.systemtimeout.powersaving_enabled;
        }
        res.json(result);
    } catch (e) { res.status(500).json({ error: "Failed to fetch state" }); }
});

router.post('/admin/key', async (req, res) => { try { await axios.post(`http://${req.body.ip}:8090/key`, `<key state="press" sender="Gabbo">${req.body.key}</key>`, BOSE_HEADERS); await axios.post(`http://${req.body.ip}:8090/key`, `<key state="release" sender="Gabbo">${req.body.key}</key>`, BOSE_HEADERS); res.send({success:true}); } catch(e) { res.status(500).send(e.message); } });

// RENAME ROUTE WITH LOGGING
router.post('/admin/name', async (req, res) => { 
    try { 
        console.log(`[Admin] Attempting to rename ${req.body.ip} to "${req.body.name}"...`);
        const boseRes = await axios.post(`http://${req.body.ip}:8090/name`, `<name>${req.body.name}</name>`, BOSE_HEADERS); 
        console.log(`[Admin] Rename response from speaker: HTTP ${boseRes.status}`);
        res.send({success:true}); 
    } catch(e) { 
        console.log(`[Admin] Rename failed on ${req.body.ip}: ${e.response?.data || e.message}`);
        res.status(500).send(e.response?.data || e.message); 
    } 
});

router.post('/admin/bass', async (req, res) => { try { await axios.post(`http://${req.body.ip}:8090/bass`, `<bass>${req.body.value}</bass>`, BOSE_HEADERS); res.send({success:true}); } catch(e) { res.status(500).send(e.message); } });
router.post('/admin/bluetooth', async (req, res) => { try { await axios.post(`http://${req.body.ip}:8090/select`, `<ContentItem source="BLUETOOTH" />`, BOSE_HEADERS); res.send({success:true}); } catch(e) { res.status(500).send(e.message); } });

router.post('/admin/settings_toggle', async (req, res) => { 
    const { ip, tag } = req.body; 
    let endpoint = `/${tag}`; 
    try { 
        const check = await axios.get(`http://${ip}:8090${endpoint}`); 
        const parser = new xml2js.Parser({ explicitArray: false }); 
        const data = await parser.parseStringPromise(check.data); 
        let newState = 'true'; 
        let xmlBody = ''; 
        if (tag === 'clockDisplay') { 
            let current = 'false'; 
            if (data.clockDisplay && data.clockDisplay.clockConfig) current = data.clockDisplay.clockConfig.$.userEnable; 
            newState = (current === 'true') ? 'false' : 'true'; 
            let raw = check.data;
            if (raw.includes('userEnable="')) xmlBody = raw.replace(/userEnable="\w+"/, `userEnable="${newState}"`);
            else xmlBody = raw.replace('/>', ` userEnable="${newState}" />`);
        } else { 
            let current = data[tag] || (data[tag] && data[tag]._) || 'false'; 
            newState = (current === 'true' || current === 'On') ? 'false' : 'true'; 
            xmlBody = `<${tag}>${newState}</${tag}>`; 
        } 
        await axios.post(`http://${ip}:8090${endpoint}`, xmlBody, BOSE_HEADERS); 
        res.send({ success: true, state: newState }); 
    } catch(e) { res.status(500).send({ error: e.message }); } 
});

router.post('/admin/auto_off', async (req, res) => { 
    const { ip } = req.body; 
    try { 
        const check = await axios.get(`http://${ip}:8090/systemtimeout`); 
        const parser = new xml2js.Parser({ explicitArray: false }); 
        const data = await parser.parseStringPromise(check.data); 
        let currentVal = 'true'; 
        if (data.systemtimeout) currentVal = data.systemtimeout.powersaving_enabled; 
        const newState = (currentVal === 'true') ? 'false' : 'true'; 
        const xml = `<systemtimeout><powersaving_enabled>${newState}</powersaving_enabled></systemtimeout>`; 
        await axios.post(`http://${ip}:8090/systemtimeout`, xml, BOSE_HEADERS); 
        res.send({ success: true, state: newState }); 
    } catch(e) { res.status(500).send({ error: e.message }); } 
});
    
router.get('/admin/deepscan', async (req, res) => { 
    const targets = ["info", "netStats","now_playing", "presets","sources","setup"]; 
    const results = {}; 
    for (const t of targets) { 
        try { const r = await axios.get(`http://${req.query.ip}:8090/${t}`); results[t] = r.data; } 
        catch (e) { results[t] = "Error"; } 
    } 
    res.json(results); 
});

// --- SMART SOURCE TOGGLE (Wi-Fi -> AUX -> Bluetooth) ---
router.post('/admin/toggle_source', async (req, res) => {
    const { ip } = req.body;
    const parser = new xml2js.Parser({ explicitArray: false });

    try {
        // 1. Check what the speaker is currently playing
        const npRes = await axios.get(`http://${ip}:8090/now_playing`, { timeout: 3000 });
        const npData = await parser.parseStringPromise(npRes.data);
        
        const currentSource = npData.nowPlaying.$.source;
        let nextPayload = "";

        // 2. The Toggle Logic
        if (currentSource === 'AUX') {
            // If AUX, switch to BLUETOOTH
            console.log(`[Admin] Toggling ${ip} from AUX to BLUETOOTH`);
            nextPayload = `<ContentItem source="BLUETOOTH" />`;
            
        } else if (currentSource === 'BLUETOOTH') {
            // If BLUETOOTH, switch back to "Wi-Fi" (By triggering Preset 1)
            // Note: Since there is no generic "Wi-Fi" source, we wake it up with a preset.
            console.log(`[Admin] Toggling ${ip} from BLUETOOTH to WI-FI (Preset 1)`);
            await axios.post(`http://${ip}:8090/key`, `<key state="press" sender="Gabbo">PRESET_1</key>`, BOSE_HEADERS);
            await axios.post(`http://${ip}:8090/key`, `<key state="release" sender="Gabbo">PRESET_1</key>`, BOSE_HEADERS);
            return res.send({ success: true, new_state: "WIFI" });
            
        } else {
            // If it's playing Internet Radio, Spotify, or is in Standby, switch to AUX
            console.log(`[Admin] Toggling ${ip} from ${currentSource} to AUX`);
            nextPayload = `<ContentItem source="AUX" sourceAccount="AUX" />`;
        }

        // 3. Send the command to change the source
        await axios.post(`http://${ip}:8090/select`, nextPayload, BOSE_HEADERS);
        res.send({ success: true, new_state: nextPayload.includes("AUX") ? "AUX" : "BLUETOOTH" });

    } catch (e) {
        console.log(`[Admin] Toggle Error: ${e.message}`);
        res.status(500).send({ error: e.message });
    }
});

// --- TELNET REBOOT ROUTE (PORT 17000) ---
router.post('/admin/reboot_speaker', (req, res) => {
    const { ip } = req.body;
    console.log(`[Admin] Sending Telnet 'sys reboot' to ${ip} on port 17000...`);
    
    const client = new net.Socket();
    client.on('error', (err) => console.log(`[Admin] Telnet error on ${ip}: ${err.message}`));

    client.connect(17000, ip, () => {
        client.write('sys reboot\r\n');
        setTimeout(() => client.destroy(), 500);
    });

    res.send({ success: true });
});

// --- SMART INJECT CLOUD CONFIGURATION ---
router.post('/admin/inject_cloud', async (req, res) => {
    const { ip, script } = req.body;
    console.log(`[Admin] Bose Cloud Independence Sequence started for ${ip}...`);

    try {
        // TELNET INJECTION ONLY (The Cloud Hijack)
        const client = new net.Socket();
        client.on('error', (err) => {
            console.log(`[Admin] Telnet Error: ${err.message}`);
            if (!res.headersSent) res.status(500).send({ error: "Telnet refused. Is the USB stick with 'remote_services' inserted?" });
        });

        client.connect(23, ip, () => {
            console.log(`[Admin] 1. Connected to Telnet. Sending override XML...`);
            setTimeout(() => {
                client.write('root\r\n'); // Log in
                
                setTimeout(() => {
                    // Inject the Override XML script, and force a disk sync
                    const payload = script.replace(/\r\n/g, '\n') + '\n\nsync\n';
                    client.write(payload);
                    
                    console.log(`[Admin] 2. Script sent. Waiting 10 seconds for the speaker to process and save...`);
                    
                    // Give the CPU 10 seconds to process the text dump and save to NVRAM
                    setTimeout(() => {
                        console.log(`[Admin] 3. Save complete. Sending beep and rebooting...`);                    
                        
                        // Send the audio notification / beep command right before it goes down
                        axios.get(`http://${ip}:8090/playNotification`).catch(() => {});
                        client.write('reboot\r\n'); // Reboot speaker
                        
                        setTimeout(() => {
                            client.destroy();
                            if (!res.headersSent) res.send({ success: true });
                        }, 500);
                        
                    }, 10000); // 10-second delay for saving
                }, 1000);
            }, 500);
        });

    } catch (e) {
        console.log(`[Admin] Injection Error: ${e.message}`);
        if (!res.headersSent) res.status(500).send({ error: e.message });
    }
});

// --- REMOVE CLOUD CONFIGURATION VIA TELNET (PORT 23) ---
router.post('/admin/remove_cloud', (req, res) => {
    const { ip } = req.body;
    console.log(`[Admin] Removing Cloud Config from ${ip} via Telnet (Port 23)...`);

    const client = new net.Socket();

    client.on('error', (err) => {
        console.log(`[Admin] Telnet Port 23 Error on ${ip}: ${err.message}`);
        if (!res.headersSent) res.status(500).send({ error: "Connection refused. Ensure the USB stick with 'remote_services' is inserted." });
    });

    client.connect(23, ip, () => {
        console.log(`[Admin] Connected to ${ip}:23. Sending 'root' login...`);
        
        setTimeout(() => {
            client.write('root\r\n');
            
            setTimeout(() => {
                console.log(`[Admin] Deleting Override XML...`);
                // Delete the file and immediately force a disk sync
                client.write('rm /var/lib/Bose/PersistenceDataRoot/OverrideSdkPrivateCfg.xml\r\nsync\r\n');
                
                // Give it 2 seconds to delete and sync
                setTimeout(() => {
                    console.log(`[Admin] Override deleted. Sending beep and rebooting...`);
                    
                    // Send the audio notification / beep command right before it goes down
                    axios.get(`http://${ip}:8090/playNotification`).catch(() => {});
                    
                    client.write('reboot\r\n'); // Reboot speaker
                    
                    setTimeout(() => {
                        client.destroy();
                        if (!res.headersSent) res.send({ success: true });
                    }, 500);
                }, 2000); 
            }, 1000);
        }, 500);
    });
});

// --- UNIFIED WI-FI PROVISIONING ---
router.post('/admin/set_wifi', async (req, res) => {
    const { ip, ssid, password } = req.body;
    console.log(`[Admin] Sending Wi-Fi Provisioning to ${ip}... (SSID: ${ssid})`);
    
    const isUsb = (ip === "203.0.113.1" || ip === "192.168.1.1");
    let hasResponded = false;
    const client = new net.Socket();

    client.on('error', (err) => {
        console.log(`[Admin] Telnet error on ${ip}: ${err.message}`);
        if (!hasResponded) {
            res.status(500).send({ error: `Telnet Error: ${err.message}` });
            hasResponded = true;
        }
    });

    if (isUsb) {
        // ==========================================
        // PATH A: USB CONNECTION (Verified)
        // ==========================================
        let outputBuffer = "";
        
        client.on('data', (data) => {
            outputBuffer += data.toString();
            
            // Wait until the speaker prints the </WiFiProfiles> closing tag
            if (outputBuffer.includes('</WiFiProfiles>')) {
                if (outputBuffer.includes(`SSID="${ssid}"`)) {
					console.log(`[Admin] ✅ USB Setup Verified: Profile saved! Waiting for UI to trigger reboot...`);
                    
                    if (!hasResponded) {
                        res.send({ success: true });
                        hasResponded = true;
                    }
                } else {
                    console.log(`[Admin] ❌ USB Setup Failed: SSID not found in memory.`);
                    if (!hasResponded) {
                        res.status(500).send({ error: "Wi-Fi profile did not save to the speaker." });
                        hasResponded = true;
                    }
                }
                setTimeout(() => client.destroy(), 500);
            }
        });

        client.connect(17000, ip, () => {
            console.log(`[Admin] Connected to ${ip}:17000 (USB) - Pushing and Verifying...`);
            // Turn on async responses, clear old profiles, add the new one, and check the file!
            const tapCommands = `async_responses on\r\nnetwork wifi profiles clear\r\nnetwork wifi profiles add ${ssid} wpa_or_wpa2 ${password}\r\nnetwork wifi profiles info\r\n`;
            client.write(tapCommands);
            
            setTimeout(() => {
                if (!hasResponded) {
                    res.status(500).send({ error: "Verification timed out. Check speaker." });
                    hasResponded = true;
                    client.destroy();
                }
            }, 5000);
        });
} else {
        // ==========================================
        // PATH B: NETWORK CONNECTION (Network Switch)
        // ==========================================
        const SERVER_IP = process.env.APP_IP;

        client.connect(17000, ip, () => {
            console.log(`[Admin] Connected to ${ip}:17000 (Network) - Executing Clean Wi-Fi Switch...`);
            
            // 1. Wipe the flash memory
            client.write('network wifi profiles clear\r\n');
            console.log(`[Admin] Sent 'clear'. Waiting 3 seconds...`);
            
            setTimeout(() => {
                // 2. Inject the new Wi-Fi credentials
                client.write(`network wifi profiles add "${ssid}" wpa_or_wpa2 "${password}"\r\n`);
                console.log(`[Admin] Sent 'add'. Waiting 12 seconds for NVRAM save...`);
                
                // 3. Reboot the speaker to apply changes
                setTimeout(() => {
                    client.write('sys reboot\r\n');
                    console.log(`[Admin] Sent 'reboot'. Closing connection.`);
                    
                    if (!hasResponded) {
                        res.send({ success: true });
                        hasResponded = true;
                    }
                    setTimeout(() => client.destroy(), 500);
                }, 12000); // 12-second delay for saving
                    
            }, 3000); // 3-second delay for clearing
        });
    }
});

// --- RESTART SOUNDTOUCH HYBRID ---
router.post('/admin/restart_hybrid', (req, res) => {
    console.log(`[Admin] Hybrid App restart requested via Web UI.`);
    res.send({ success: true });
    
    // Wait 1 second to ensure the UI gets the 'success' response, then kill the process.
    // Docker will immediately detect the exit and spin it back up!
    setTimeout(() => {
        console.log(`[Admin] Exiting process now...`);
        process.exit(0); 
    }, 1000);
});

module.exports = router;