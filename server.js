require('dotenv').config(); // Load environment variables
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const xml2js = require('xml2js');
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = process.env.APP_PORT;

// --- CONFIGURATION ---
// Load speakers from external file
const SPEAKERS = require('./speakers.json');

app.use(cors());
app.use(bodyParser.json());

// --- DIAGNOSTIC LOGGER ---
// app.use((req, res, next) => {
    // const ip = (req.ip || req.connection.remoteAddress).replace('::ffff:', '');
    // console.log(`[TRAFFIC] 🚦 ${req.method} request to: ${req.url} from IP: ${ip}`);
    // next();
// });

// 1. SERVE STATIC FILES
app.use(express.static(path.join(__dirname, 'public')));

// 2. IMPORT MODULES (From the 'routes' folder)
const controllerRoutes = require('./routes/controller');
const managerRoutes = require('./routes/manager');  
const adminRoutes = require('./routes/admin');
const bridgeRoutes = require('./routes/bridge');   // The Listener

// 3. MOUNT ROUTES
app.use('/api', controllerRoutes);
app.use('/api', managerRoutes);
app.use('/api', adminRoutes);
app.use('/', bridgeRoutes); // Must be root for /preset/1.mp3
app.use('/api/admin', require('./routes/restart_ma'));

// 4. AUTO-REDIRECT ROOT
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'control.html'));
});

// 5. SYSTEM BOOT CHECK
async function systemBoot() {
    console.log("----------------------------------------------------------");
    console.log(" BOSE SOUNDTOUCH HYBRID 2026 V2 (MUSIC ASSISTANT EDITION) ");
    console.log("----------------------------------------------------------");
    
    const parser = new xml2js.Parser({ explicitArray: false });

    for (const s of SPEAKERS) {
        try {
            const res = await axios.get(`http://${s.ip}:8090/info`, { timeout: 1500 });
            const data = await parser.parseStringPromise(res.data);
            const type = data.info.type || data.info.$.type || "Unknown";
            console.log(` [OK] ${s.name.padEnd(20)} | Type: ${type.padEnd(15)} | IP: ${s.ip}`);
        } catch (e) {
            console.log(` [!!] ${s.name.padEnd(20)} | IP: ${s.ip.padEnd(15)} | OFFLINE`);
        }
    }
    console.log("----------------------------------------------------------------");
    console.log(` Server running at http://0.0.0.0:${PORT}`);
}

app.listen(PORT, '0.0.0.0', systemBoot);