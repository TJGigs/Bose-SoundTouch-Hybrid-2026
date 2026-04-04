const express = require('express');
const router = express.Router();
const { Client } = require('ssh2');
const mass = require('./mass');

// Route to restart the Music Assistant container
// POST /api/admin/restart_ma
router.post('/restart_ma', (req, res) => {
    console.log("Received request to restart Music Assistant (bose-mass)...");

    // SAFETY CHECK: Ensure ALL credentials exist in .env
    const config = {
        host: process.env.HOST_IP,
        port: parseInt(process.env.QNAP_HOST_PORT), // Convert string to number
        username: process.env.HOST_SSH_USER,
        password: process.env.HOST_SSH_PASS
    };

    if (!config.host || !config.password || !config.username) {
        console.error("Missing SSH Credentials in .env file");
        return res.json({ success: false, error: "Server Configuration Error: Missing SSH Credentials" });
    }

    const conn = new Client();

    conn.on('ready', () => {
        console.log(`SSH Connection :: Ready (${config.host})`);
        
        // Command to restart the specific container
        const cmd = '/share/CACHEDEV1_DATA/.qpkg/container-station/bin/docker restart bose-mass';
        
        conn.exec(cmd, (err, stream) => {
            if (err) {
                console.error("SSH Exec Error:", err);
                conn.end();
                return res.json({ success: false, error: err.message });
            }

            stream.on('close', (code, signal) => {
                console.log('SSH Stream :: close :: code: ' + code);
                conn.end(); 
                
                if (code === 0) {
					mass.resetHealth();
                    res.json({ success: true, message: "Restart command executed successfully." });
                } else {
                    res.json({ success: false, error: "Restart failed. Check server logs." });
                }
            }).on('data', (data) => {
                console.log('STDOUT: ' + data);
            }).stderr.on('data', (data) => {
                console.log('STDERR: ' + data);
            });
        });
    });

    conn.on('error', (err) => {
        console.error("SSH Connection Error:", err);
        res.json({ success: false, error: "SSH Connection Failed: " + err.message });
    });

    // --- CONFIGURATION (STRICTLY FROM ENV) ---
    conn.connect(config);
});

module.exports = router;