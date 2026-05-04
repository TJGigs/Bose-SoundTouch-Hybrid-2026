const express = require('express');
const router = express.Router();
const http = require('http');
const axios = require('axios');
const mass = require('./mass');

function dockerAction(action = 'restart') {
    return new Promise((resolve, reject) => {
        const containerName = process.env.MASS_CONTAINER_NAME;
        if (!containerName) return reject(new Error("MASS_CONTAINER_NAME not set in .env"));

        const options = {
            socketPath: '/var/run/docker.sock',
            path: `/v1.41/containers/${containerName}/${action}`,
            method: 'POST',
        };

        const req = http.request(options, (res) => {
            if (res.statusCode === 204 || res.statusCode === 200) resolve(true);
            else reject(new Error(`Docker API Status: ${res.statusCode}`));
        });

        req.on('error', (err) => reject(err));
        req.end();
    });
}

// --- NEW BULLETPROOF HEALTH CHECK ---
async function getMassHealth() {
    const massIp = process.env.MASS_IP;
    const massPort = process.env.MASS_PORT;

    if (!massIp || !massPort) {
        console.log(`[Boot] MASS Health Check Aborted: Missing Config in .env`);
        return { isOnline: false, version: "Unknown" };
    }

    try {
        // Use the explicitly documented unauthenticated /info endpoint
        const infoRes = await axios.get(`http://${massIp}:${massPort}/info`, { timeout: 3500 });
        
        let version = "Running";
        if (infoRes.data) {
            // Extract the version from the JSON response
            version = infoRes.data.server_version || infoRes.data.version || "Running";
        }

        return { isOnline: true, version: version };

    } catch (e) {
        // If we get an HTTP error like 403 or 401, the server is still technically online and responding!
        if (e.response) {
            return { isOnline: true, version: "2.x (Auth Required)" };
        }
        
        // A true network error means the Docker container is completely unreachable
        return { isOnline: false, version: "Offline" };
    }
}

// POST /api/admin/restart_ma
router.post('/restart_ma', async (req, res) => {
    console.log(`[Admin] Manual MASS restart requested...`);
    try {
        await dockerAction('restart');
        mass.resetHealth();
        res.json({ success: true, message: "Restart triggered via Docker socket." });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = {
    router,
    dockerAction,
    getMassHealth
};