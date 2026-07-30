// routes/preflight.js
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const xml2js = require('xml2js');
const net = require('net');
const { pushPresetsToSpeaker, speakerHasHybridPresets } = require('./utils');

async function auditSpeakerClock(ip, name) {
    try {
        const now = new Date();
        const utcUnixTime = Math.floor(now.getTime() / 1000); 
        const offsetMinutes = -now.getTimezoneOffset(); 
        const offsetSeconds = offsetMinutes * 60;
        const localUnixTime = utcUnixTime + offsetSeconds; 

        const checkRes = await axios.get(`http://${ip}:8090/clockTime`, { timeout: 1500 });
        const parser = new xml2js.Parser({ explicitArray: false });
        const data = await parser.parseStringPromise(checkRes.data);
        
        // Extract the attribute from the '$' object
        const currentUtc = parseInt(data.clockTime?.$?.utcTime || "0");
        const timeDrift = Math.abs(currentUtc - utcUnixTime);

        // Only push an update if the clock has drifted by > 120 seconds.
        if (timeDrift > 120) {
            console.log(`[Pre-Flight] 🕒 Adjusting clock on ${name} (Drift: ${timeDrift}s)...`);
            
            const timeXml = `
                <clockTime>
                    <state>SYNC_VALID</state>
                    <utcTime>${utcUnixTime}</utcTime>
                    <localTime>${localUnixTime}</localTime>
                    <offset>${offsetSeconds}</offset>
                </clockTime>
            `.trim();
            
            await axios.post(`http://${ip}:8090/clockTime`, timeXml, {
                headers: { 'Content-Type': 'application/xml' },
                timeout: 2000
            });
        }
    } catch (e) {
        console.error(`[Pre-Flight] ⚠️ Clock audit failed for ${name}: ${e.message}`);
    }
}

// 1. THE NATIVE INJECTOR (Universal Timing Sequence)
function injectPort17000Commands(ip, commands) {
    return new Promise((resolve) => {
        const client = new net.Socket();
        client.setTimeout(20000); 
        let isSocketAlive = true; // 🌟 THE FIX: Flag to abort the loop
        
        client.on('error', (err) => {
            console.log(`   ├─ ❌ Port 17000 Error: ${err.message}`);
            isSocketAlive = false; // Kill the loop
            resolve(false);
        });
        
        client.on('timeout', () => { 
            console.log(`   ├─ ⚠️ Port 17000 Connection Timed Out.`);
            isSocketAlive = false; // Kill the loop
            client.destroy(); 
            resolve(true); 
        });
        
        client.connect(17000, ip, async () => {
            console.log(`   ├─ 🔌 Port 17000 connected. Initiating universal timing sequence...`);
            
            // Bypass lazy-load bug with wake-up carriage returns
            client.write('\r\n');
            await new Promise(r => setTimeout(r, 1000));
            if (!isSocketAlive) return; // Check heartbeat
            client.write('sys configuration\r\n');
            await new Promise(r => setTimeout(r, 1500));
            if (!isSocketAlive) return; // Check heartbeat

			// Sequential injection with universal NVRAM delays
            for (let i = 0; i < commands.length; i++) {
                if (!isSocketAlive) break; // THE FIX: Immediately halt injection if socket died

                let cmdLog = commands[i].split(' ')[1] || 'command';
                
                // Extract the actual values for the console log
                if (cmdLog === 'AccountId') {
                    cmdLog = `AccountId -> ${commands[i].split(' ')[3]}`;
                } else if (cmdLog === 'configuration') {
                    cmdLog = `${commands[i].split(' ')[2]}`; 
                } else if (cmdLog === 'boseurls') {
                    cmdLog = `boseurls`;
                }

                console.log(`   ├─ [${i+1}/${commands.length}] Injecting: ${cmdLog}`);
                client.write(commands[i] + '\r\n');
                await new Promise(r => setTimeout(r, 1000)); // Crucial 1000ms universal delay
            }
            
            if (isSocketAlive) {
                client.destroy();
                resolve(true);
            }
        });
    });
}

// THE NATIVE TELNET JANITOR (Upgraded with Error Trapping & Test Mode)
function telnetJanitor(ip) {
    return new Promise(async (resolve) => {
        const client = new net.Socket();
        client.setTimeout(2000); // Give up fast if port 23 is closed
        let shellOutput = "";

        client.on('error', () => resolve(false));
        client.on('timeout', () => { client.destroy(); resolve(false); });

        // Capture shell data to trap errors
        client.on('data', (data) => {
            shellOutput += data.toString();
        });

        client.connect(23, ip, () => {
            console.log(`   ├─ 🚨 [Janitor] PORT 23 (TELNET) IS OPEN! USB Drive detected.`);
            console.log(`   ├─ [Janitor] Logging in as root...`);

            setTimeout(() => {
                client.write('root\r\n');

                setTimeout(() => {
                    console.log(`   ├─ [Janitor] 🧹 Deleting legacy V1/V2 OverrideSdkPrivateCfg.xml...`);
                    // Use -v for verbose output to catch success
                    client.write('rm -fv /var/lib/Bose/PersistenceDataRoot/OverrideSdkPrivateCfg.xml\r\nsync\r\n');

                    setTimeout(() => {
                        // Error trapping based on shell response					
                        if (shellOutput.includes('No such file')) {
                            console.log(`   ├─ ⚠️ [Janitor] Notice: File was already gone. Skipping reboot.`);
                            client.destroy();
                            resolve(false);
                        } else if (shellOutput.toLowerCase().includes('error')) {
                            console.log(`   ├─ ❌ [Janitor] Error wiping file! Check shell output.`);
                            client.destroy();
                            resolve(false);
                        } else {
                            console.log(`   ├─ [Janitor] ✅ File successfully deleted from memory.`);
                            console.log(`   ├─ [Janitor] Rebooting to clear memory...`);
                            client.write('reboot\r\n');

                            setTimeout(() => {
                                client.destroy();
                                resolve(true); 
                            }, 500);
                        }							
						
                    }, 2000); 
                }, 1000); 
            }, 500); 
        });
    });
}



// LEGACY USB WARNING BANNER
function showLegacyUSBWarning(ip) {
    console.log(`\n=======================================================================`);
    console.log(`🚨 LEGACY V1/V2 CONFIGURATION DETECTED ON ${ip}!`);
    console.log(`   The speaker is refusing the V3 update because an old USB HiJack file`);
    console.log(`   is overriding the internal memory.`);
    console.log(` `);
    console.log(`   TO FIX THIS AUTOMATICALLY:`);
    console.log(`   1. Plug your "remote_services" USB setup cable into the speaker.`);
    console.log(`   2. Reboot the speaker (unplug power, wait 10s, plug back in).`);
    console.log(`   3. Wait 1 minute for it to connect to Wi-Fi.`);
    console.log(`   4. Click "Restart SoundTouch Hybrid" in the System Tools menu.`);
    console.log(` `);
    console.log(`   The Telnet Janitor will detect the USB, safely wipe the file,`);
    console.log(`   reboot the speaker, and complete the V3 upgrade automatically!`);
    console.log(`=======================================================================\n`);
}

// PAUSE PREFLIGHT WHILE JANITOR REBOOTS SPEAKER
async function waitForJanitorReboot(ip) {
    console.log(`   ├─ ⏳ Allowing 35 seconds for ${ip} network stack to shut down...`);
    await new Promise(r => setTimeout(r, 35000)); // 🌟 THE FIX: Hard wait for hardware to drop

    let online = false, attempts = 0;
    process.stdout.write(`   ├─ ⏳ Polling ${ip} until network reconnects `);
    while (!online && attempts < 24) {
        try {
            await axios.get(`http://${ip}:8090/info`, { timeout: 2000 });
            online = true;
            console.log(` ✅ Back Online!`);
        } catch(e) {
            attempts++;
            process.stdout.write('.');
            await new Promise(r => setTimeout(r, 5000));
        }
    }
    return online;
}


/**
 * CORE BOOTLOADER ENGINE: Evaluates fleet state, processes NVRAM injections, and executes targeted reboots.
 * @param {string|null} forceInjectTarget - IP address of specific speaker to force-inject, or 'all'.
 * @param {string|null} forceRebootTarget - IP address of specific speaker to soft-reboot, or 'all'.
 */
async function runSetup(forceInjectTarget = null, forceRebootTarget = null) {
    const configPath = path.join(__dirname, '..', 'config', 'speakers.json');
    if (!fs.existsSync(configPath)) {
        console.error("[Pre-Flight] ❌ speakers.json not found!");
        return { success: false, rebootedIps: [] };
    }

    const SPEAKERS = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    // Resolved, never the raw env var — these get written straight into the
    // speaker's own NVRAM below, so a configured hostname must never reach it.
    // See Docs/design_subnet_and_hostname_resolution.md. Callers of runSetup()
    // (server.js's boot sequence) already call resolveConfiguredIps() first.
    const { getResolvedAppIp } = require('./utils');
    const APP_IP = getResolvedAppIp();
    const APP_PORT = process.env.APP_PORT;
    const parser = new xml2js.Parser({ explicitArray: false });
    const rebootedIps = [];

    // Utility: Safely extract string data from xml2js parsed objects
    const extractString = (val) => {
        if (!val) return "";
        if (typeof val === 'string') return val;
        if (val._) return String(val._);
        return String(val);
    };

    for (const speaker of SPEAKERS) {	
        console.log(`\n[Pre-Flight] 🔍 Auditing ${speaker.name} (${speaker.ip})...`);
        
        try {
            // ==========================================================
            // PHASE 1: PRE-FLIGHT JANITOR (Clean old hijack files)
            // ==========================================================
            const justCleaned = await telnetJanitor(speaker.ip);
            if (justCleaned) {
                const isBack = await waitForJanitorReboot(speaker.ip);
                if (!isBack) {
                    console.log(`   └─ ⚠️ Timed out waiting for speaker to return. Moving to next speaker.`);
                    continue;
                }
                console.log(`   ├─ Speaker is clean. Proceeding with standard V3 Setup...`);
            }

            // ==========================================================
            // PHASE 2: STATE ACQUISITION & CLOCK AUDIT
            // ==========================================================
            const res = await axios.get(`http://${speaker.ip}:8090/info`, { timeout: 2000 });
            const data = await parser.parseStringPromise(res.data);
            const info = data.info || {};
            
            // Extract core device identifiers
            const fallbackId = Math.floor(Math.random() * 10000000).toString();
            const macAddress = extractString(info.$ && info.$.deviceID) || fallbackId;          
            const currentMargeUrl = extractString(info.margeURL || info.margeServerUrl);
            const currentMargeId = extractString(info.margeAccountUUID);
            
            // Sync internal clock to prevent TLS/Cloud rejections
            await auditSpeakerClock(speaker.ip, speaker.name);

            // ==========================================================
            // PHASE 3: HIERARCHICAL EXECUTION LOGIC
            // ==========================================================
            // Condition Checks
            const isUrlConfigured = currentMargeUrl.includes(`${APP_IP}:${APP_PORT}`);
            const hasMargeId = currentMargeId !== "" && currentMargeId !== "0000000" && currentMargeId !== "UNKNOWN_MAC";
            const naturallyNeedsSetup = !isUrlConfigured || !hasMargeId;

            const isInjectTarget = forceInjectTarget === 'all' || forceInjectTarget === speaker.ip;
            const isRebootTarget = forceRebootTarget === 'all' || forceRebootTarget === speaker.ip;

            // Only check presets when the speaker would otherwise pass as healthy.
            // If injection is required (Route B), the post-reboot cloud handshake delivers
            // presets anyway — checking here adds no value and a separate push would race the reboot.
            // speakerHasHybridPresets covers both empty slots AND slots filled with non-Hybrid URLs.
            const needsPresetPush = (!naturallyNeedsSetup && !isInjectTarget)
                ? !(await speakerHasHybridPresets(speaker.ip))
                : false;

            // Decision Matrix
            const needsInjection = naturallyNeedsSetup || isInjectTarget;
            const needsReboot    = needsInjection || isRebootTarget;

            // Route A: Healthy & Ignored
            if (!needsReboot && !needsPresetPush) {
                console.log(`   └─ ✅ Fully configured and healthy (MargeID: ${currentMargeId}).`);
                continue;
            }

            // Route B: Requires NVRAM Injection (Implicitly includes a hardware reboot)
            if (needsInjection) {
                if (naturallyNeedsSetup) {
                    console.log(`   ├─ ⚠️ Action Required: Native setup missing or corrupted.`);
                    if (!hasMargeId) console.log(`   │  └─ Reason: Missing or invalid MargeID.`);
                    if (!isUrlConfigured) console.log(`   │  └─ Reason: Cloud URL mismatch (Found: "${currentMargeUrl}").`);
                } else if (isInjectTarget) {
                    console.log(`   ├─ 🚨 FORCE INJECTION ENABLED: Bypassing health checks.`);
                }

                console.log(`   ├─ Initiating NVRAM Injection sequence via Port 17000...`);
                const targetMargeId = hasMargeId ? currentMargeId : macAddress;
                console.log(`   ├─ Target MargeID: ${targetMargeId}`);
                
                // Build the execution stack
                const commandList = [
                    `sys configuration bmxRegistryUrl http://${APP_IP}:${APP_PORT}/bmx/registry/v1/services`,
                    `sys configuration statsServerUrl http://${APP_IP}:${APP_PORT}`,
                    `sys configuration margeServerUrl http://${APP_IP}:${APP_PORT}/marge`,
                    `sys configuration swUpdateUrl http://${APP_IP}:${APP_PORT}/updates/soundtouch`,
                    `envswitch boseurls set http://${APP_IP}:${APP_PORT} http://${APP_IP}:${APP_PORT}/updates/soundtouch`,
                    `sys remote_service on`,
                    `getpdo CurrentSystemConfiguration`
                ];
                
                if (!hasMargeId || isInjectTarget) {
                    commandList.push(`envswitch AccountId set ${targetMargeId}`);
                }

                console.log(`   ├─ Writing configurations sequentially...`);
                const injectionSuccess = await injectPort17000Commands(speaker.ip, commandList);

                if (!injectionSuccess) {
                    console.log(`   └─ ❌ Injection failed due to socket error. Aborting setup.`);
                    continue; 
                }

                console.log(`   ├─ ⏳ Waiting 10 seconds for NVRAM to safely write to flash memory...`);
                await new Promise(resolve => setTimeout(resolve, 10000));

                console.log(`   └─ Save complete. Hard-rebooting ${speaker.name}...`);
                await injectPort17000Commands(speaker.ip, [`sys reboot`]);
                rebootedIps.push(speaker.ip);
            
            // Route C: Force Reboot only (preset recovery no longer triggers a reboot)
            } else if (isRebootTarget) {
                console.log(`   └─ FORCE REBOOT SEQUENCE: Soft-rebooting ${speaker.name}...`);
                await injectPort17000Commands(speaker.ip, [`sys reboot`]);
                rebootedIps.push(speaker.ip);
            }

            // Route D: Preset Push — non-destructive, no reboot required.
            // Fires when cloud config (MargeURL/ID) is correct but presets are missing
            // or pointing to non-Hybrid URLs. Skipped if Route B ran (cloud handshake covers it).
            if (needsPresetPush && !needsInjection) {
                console.log(`   ├─ ⚠️ Action Required: Presets missing or not pointing to Hybrid Bridge.`);
                console.log(`   └─ Pushing Hybrid presets directly — no reboot required.`);
                await pushPresetsToSpeaker(speaker.ip);
            }

        } catch (err) {
            console.log(`[Pre-Flight] ❌ Critical failure reaching ${speaker.ip}: ${err.message}`);
        }
    }
    
    return { success: true, rebootedIps };
}

module.exports = { runSetup };