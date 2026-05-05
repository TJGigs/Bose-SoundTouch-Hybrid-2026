# <img src="public/images/hybrid_icon.png" width="30"> Bose SoundTouch Hybrid 2026 - V3

**A free, open-source private cloud streaming service replacing the Bose Cloud Service to maintain 100% of the smart speaker functionality of your SoundTouch 10, 20, & 30 Speakers and Wireless Link. Physical Presets Included!**

<img src="public/images/bose_icon.png" width="20">  The Bose shut down of their SoundTouch Cloud Service (May 2026) degraded the Bose SoundTouch intelligent, multi-room audio speakers into "dumb" receivers dependent on a phone's active connection. This represents a **significant loss of functionality** for the SoundTouch 10, 20, and 30 Speakers and Wireless Link Adapter. 

<img src="public/images/hybrid_icon.png" width="20">  **This solution provides a self-hosted "Private Cloud" to emulate and replace the Bose Cloud Service**. It runs locally on your network (NAS, PC, etc.) and intercepts and actively manages the complex server handshakes required to keep the SoundTouch Speakers authenticated and functional, providing the **same phone-free audio streaming capabilities** as the original SoundTouch Application and Speakers. 

### ✨ V3 Enhancements:

* ✅ **Custom URL Streaming Library Integration:** Moved the "play custom URL stream" function to the Library Manager and added the ability to assign custom streams directly to favorites and physical speaker presets.

* ✅ **Advanced Global and Favorites Search:** Expanded the search functionality with additional filters, including the ability to perform provider-specific searches.

* ✅ **Auto-Resume Presets:** Speakers now remember if a preset was active when powered off and will automatically resume that specific preset upon the next power-on.

* ✅ **In-App Update Notifications:** Automatically checks for new releases and displays a notification banner within the UI when a new version is available.

* ✅ **Live Console Logging:** Integrated a real-time server log viewer directly into the System Tools page.

* ✅ **Streamlined GHCR Deployment:** Transitioned from manual repository cloning to a pre-built GitHub Container Registry image. The system now automatically generates required configuration templates on first boot and performs startup configuration and version validation checks.

* ✅ **Improved State Synchronization:** Completely replaced backend REST API polling with a more efficient, stable, and event-driven WebSocket architecture for improved speaker state and audio stream tracking.

* ✅ **Music Assistant Native DLNA Metadata:** Takes advantage of Music Assistant's improved DLNA streaming by reading track metadata directly from the audio stream. The original API-based fetch has been streamlined into a lightweight "Watchdog" function that executes as a fallback only when needed. *(MASS v2.8.5 or later required)*

* ✅ **Music Assistant Smart Startup & Version Checks:** On boot, the app now verifies the Music Assistant version and automatically launches the container if it detects it isn't running.  *(MASS v2.8.5 or later required)*


### ✨ Application Key Features:
* **100% Local Control:** Your data and control logic stay on your LAN. No reliance on external Bose servers.
* **Complete App Replacement:** A single, responsive web interface for **Desktop** and **Mobile** that handles both streaming and speaker maintenance, completely eliminating the need for the legacy SoundTouch app or provider-specific streaming apps. Includes support for initial speaker setup, factory resets, WiFi provisioning, and the one-time automated injection of a speaker's internal cloud emulation configuration (`OverrideSdkPrivateCfg.xml`).

* **Hardware Intelligence Preserved:** 
  * ✅ **Local Bose Cloud Emulation:** Local replacement emulating  the required Bose Cloud handshakes to keeping the speakers authenticated and fully functional.
  * ✅ **The Physical 1-6 Preset Buttons:** Remain assignable to any source via the Hybrid Bridge and work instantly.
  * ✅ **Volume, Power, & Presets:** Physical speaker buttons remain fully functional and sync perfectly with the new Hybrid app.
  * ✅ **Native Hardware Grouping:** Utilizes Bose's near-zero-latency Master/Slave hardware grouping instead of software-level sync. This guarantees perfect multi-speaker audio regardless of whether you are streaming from a new Hybrid cloud source or a local input.
* **Expanded Music Universe:** Bridges your speakers to modern sources powered by Music Assistant (MASS v2.8.5 or later requried) <img src="public/images/ma_icon.png" width="15">
  * Spotify, Apple Music, YouTube Music
  * Local NAS Files, Plex, Jellyfin
  * Internet Radio (TuneIn, DI.fm)
  * Others from MASS
  * Global Agnostic Search within SoundTouch Hybrid Library of all your MASS sources

## 🛠 Architecture
* **Backend:** Custom Node.js/server acting as the "Audio Engine" (Music Assistant <img src="public/images/ma_icon.png" width="15"> ) and local Bose Cloud Emulation ☁️.
* **Frontend:** Responsive Web App deployable to any browser.
* **Connectivity:** Direct IP control over Bose WebSockets & XML API. 
<img src="public/docs/ArchitectureIntro.png" alt="SoundTouch Hybrid Architecture Diagram" width="700">

### ☁️ BOSE CLOUD EMULATION AND HYBRID FEATURES:

### Authentication & Provisioning
* Full BMX Registry and MargeID handshakes
* Dynamic account profile generation
* Source Providers Authorization (e.g., `11`, `LOCAL_INTERNET_RADIO`)
* Automated injection of Hybrid Preset Physical Buttons (1-6)
* Automated Cloud Redirect Setup (points speakers to local server)

### Device Rescue (NVRAM Auto-Healer)
* Factory-reset speaker detection and setup
* Gabbo System Bus (Port `8080`) websocket backdoor access
* Automated UI setup bypass (Language → Name → Account Binding → Seal)
* Permanent NVRAM persistence flag generation (`<setupState state="SETUP_LEAVE" />`)

### System Traps & Speaker Protection
* Dummy radio base URL generation (streaming check bypass)
* DRM streaming token mocks
* Boot-loop prevention (Account deletion trap)
* Telemetry and analytics blocking
* Firmware update bypass 
* Factory reset request spoofing (Fake `201 Created`)
* Device rename and profile sync spoofing

### Server Stability & Caching
* Real-time speaker identity fetching (MAC, Serial, Name)
* Local identity caching to handle heavy network traffic
* Failsafe request dropping (protects busy speakers from accidental preset wipes)

## 📺 <img src="public/images/hybrid_icon.png" width="20"> Demo Videos
<a href="https://youtu.be/R6mbTRBEBYA" target="_blank">
  <img src="https://img.youtube.com/vi/R6mbTRBEBYA/maxresdefault.jpg" alt="Bose SoundTouch Hybrid 2026 Initial Demo Video" width="300">
</a>
<a href="https://youtu.be/3BhAkpsZjBI" target="_blank">
  <img src="https://img.youtube.com/vi/3BhAkpsZjBI/maxresdefault.jpg" alt="Bose SoundTouch Hybrid 2026 V2 Enhancements Demo Video" width="300">
</a>
<a href="https://youtu.be/ERsoMmyOpEU" target="_blank">
  <img src="https://img.youtube.com/vi/ERsoMmyOpEU/maxresdefault.jpg" alt="Bose SoundTouch Hybrid 2026 V3 Enhancements Demo Video" width="300">
</a>



## <img src="public/images/hybrid_icon.png" width="20"> Getting Started

Review **[SoundTouch Hybrid 2026 Technical Documentation](https://github.com/TJGigs/Bose-SoundTouch-Hybrid-2026/blob/main/public/docs/SoundTouchHybridDocumentation.pdf)** for detailed system architecture, technical development findings and solutions, and visual setup screenshots.

## Installations via Docker Compose

***You must verify your SoundTouch speakers and streaming providers are fully working inside of Music Assistant prior to using the SoundTouch Hybrid Application.***

### <img src="public/images/ma_icon.png" width="18"> Setting up Music Assistant (MASS)
Install Music Assistant (MASS):  ***version 2.8.5 or later is required***

1. **For installation instructions and troubleshooting, use Music Assistant Help:** This includes help for setup, providers, speakers testing, playback issues, etc.
   * See [MASS GitHub](https://github.com/music-assistant/server) 
   * See [MASS Website](https://www.music-assistant.io/installation)
   * To run MASS using my specific configuration, I included my `mass_docker.yml` and `mass_package.json` files located in the `examples` subfolder. Your MASS install may or may not be the same but these are provided as reference.

2.	**Initial Setup:** Once MASS is installed go to it's web interface to create your login ID and password. These will be used by the SoundTouch Hybrid system to access MASS. *(the SoundTouch Hybrid system does not require a MASS "Long-lived Access Token").*

3.	**Configure Providers:** Add your desired streaming providers (e.g., Local NAS, TuneIn, Spotify, etc.) and configure any local Music Library synchronization options. Examples of synchronization options are on Page 13 in the [SoundTouch Hybrid Documentation](https://cdn.jsdelivr.net/gh/TJGigs/Bose-SoundTouch-Hybrid-2026@main/public/docs/SoundTouchHybridDocumentation.pdf#page=13)
    * *I choose not to enable MASS local library synchronization for my providers to ensure that content search using the SoundTouch Hybrid Library search function (via MASS Search) is directly accessing the most recent data from streaming providers rather than relying on a local MASS cached and periodically sync'd copy. You may decide otherwise.*
   
5.	**Configure UPnP:** Enable the DLNA/UPnP provider, and for each of your SoundTouch speakers ensure you select DLNA as your **"Preferred Output Protocol."** DLNA is recommended because the Bose SoundTouch Hybrid system’s self-healing logic, latency management, and real-time state synchronization are heavily optimized for DLNA/UPnP. The majority of stabilization regression testing was done with this protocol. See Page 12 in the [SoundTouch Hybrid Documentation](https://cdn.jsdelivr.net/gh/TJGigs/Bose-SoundTouch-Hybrid-2026@main/public/docs/SoundTouchHybridDocumentation.pdf#page=12) for an example.
    * *NOTE: AirPlay is supported but not as fully tested. In the future I'll spend more time testing and optimizing for AirPlay*

8.	**Very Important:** Make sure Music Assistant itself can play audio to your speakers and you hear the audio. Do this completely independent of the Bose SoundTouch Hybrid app. Do this for every provider and speaker you add. This way you know Music Assistant is fully working first before proceeding to install/use the Bose SoundTouch Hybrid system

### <img src="public/images/hybrid_icon.png" width="18"> Setting up SoundTouch Hybrid

⚠️ **Important Upgrade Note For Existing V1 & V2 SoundTouch Hybrid Installations:** V3 has significant architectural changes including transitioning to streamlined pre-built Docker image. Because of fundamental changes to the system and file structures, you cannot simply update your existing container. This requires a complete fresh install.

Before proceeding with the instructions below, please do the following:
   * **Backup Your Data:** Save a copy of your existing `.env`, `library.json` and `speakers.json` files. You need these to reference your specific IPs/ports/etc configs.
   * **Destroy the Old System:** Completely stop and remove your old SoundTouch Hybrid container, and delete your old project folder.
   * **Do Not Reuse These Old Files:** The internal structure of the `.env` and `.yml` files have changed. When you deploy V3, the system will generate new configuration templates. Copy your IP's, credentials etc from your old backup files into the new files. Do not overwrite the new `.env` file with your old one. You can reuse your `speakers.json` and `library.json` files so after the fresh install just overlay the new same named files in you container directory. A `provider` key was added to  `library.json` so until an existing favorite/presets is resaved the `provider` value will not exist for object. This only impacts the new optional provider specific selection filter within the new library search function.

#### <img src="public/images/hybrid_icon.png" width="18"> **Install Bose SoundTouch Hybrid 2026**
1. **Create Directory & Download the Compose File:** Create a new folder on your local NAS or server named `bose-soundtouch-hybrid`. Download only the `bose-soundtouch-hybrid.yml` file from this repository and place it inside your new  `bose-soundtouch-hybrid` folder.

2. **Configure Docker Volume Path:** Open `bose-soundtouch-hybrid.yml` and locate the `volumes:` section. Change everything to the left side of /bose-soundtouch-hybrid  (e.g. `/share/Container`/bose-soundtouch-hybrid) to match the actual absolute path of your specific NAS storage structure of where you created the `bose-soundtouch-hybrid`folder.

3. **Initial Deploy / Template Generation:** Launch the container to generate your configuration files.
   * NAS/GUI: Import the `bose-soundtouch-hybrid.yml` file into your container manager (like Container Station or Portainer) and deploy.
   * Command Line: Navigate to your folder and run: `docker compose -f bose-soundtouch-hybrid.yml up -d`
   * Note: The container will download the image, create the necessary configuration files in your folder, and then pause waiting for you to fill them out.
   * <img width="686" height="191" alt="image" src="https://github.com/user-attachments/assets/f1727099-a2f4-4b94-b884-3a25cb13900c" />


  
4. **Configure Your Environment & Speakers:** Navigate to your `bose-soundtouch-hybrid` folder on your server. You will see the automatically generated `.env` and `speakers.json` files.
   * Edit `.env`: Update it with your local server IP addresses, Music Assistant (MASS) credentials, and port configurations. Replace all `xx` placeholders.(Note: Your actual streaming provider passwords are managed inside Music Assistant, not here).
   * Edit `speakers.json`: Update it with your speakers' names and their static IP addresses. Replace all `xx` placeholders.
   * See Page 15 in the [SoundTouch Hybrid Documentation](https://cdn.jsdelivr.net/gh/TJGigs/Bose-SoundTouch-Hybrid-2026@main/public/docs/SoundTouchHybridDocumentation.pdf#page=15) for examples.

5. Restart Appliocation: Once the files are configured restart the container to launch Bose SoundTouch Hybrid 2026
   * NAS/GUI: Click "`Restart`" on the container in your management interface.
   * Command Line: Run `docker compose -f bose-soundtouch-hybrid.yml restart`

6. **Install the Web App:** Open your mobile browser and navigate to the SoundTouch Hybrid local web address (e.g., http://<YOUR_SERVER_IP>:3000/control.html). Tap **"Add to Home Screen"** to install it as a native-feeling app with a launch icon.

7. **Redirect SoundTouch Speakers to Your Local Cloud:** The final configuration step is to redirect your physical speakers away from the decommissed Bose SoundTouch Servers and route them to the SoundTouch Hybrid's Bose Cloud replacement emulator. Open the Speaker Admin/System Tools page and follow the on-screen **"Bose Cloud Emulation Setup"** instructions to prepare a USB drive and inject the configuration override (`OverrideSdkPrivateCfg.xml`) into each of your speakers.

8. **Demo Video Reviews:**
   *  **Initial V1 Core Functionality: 📺[Bose SoundTouch Hybrid 2026](https://www.youtube.com/watch?v=R6mbTRBEBYA)** 
   *  **V2 Enhancements: 📺[V2 Enhancements Bose SoundTouch Hybrid 2026 V2](https://www.youtube.com/watch?v=3BhAkpsZjBI)** 
   *  **V3 Enhancements: 📺[V3 Enhancements Bose SoundTouch Hybrid 2026 V3](https://www.youtube.com/watch?v=ERsoMmyOpEU)**  Review the latest V3 functionality changes and additions.


## 🔗 Resources
<img src="public/images/hybrid_icon.png" width="18"> **[Bose SoundTouch Hybrid 2026 - Project Announcement](https://www.reddit.com/r/bose/comments/1rdzs7z/bose_soundtouch_hybrid_2026_official_public/)**

<img src="public/images/ma_icon.png" width="18"> **Music Assistant:** This project relies on  [Music Assistant](https://music-assistant.io/) for backend audio routing and provider aggregation. 

**Community Discussions:**
* **Official Shutdown Discussion:** The original community thread tracking Bose's EOL announcement and API release [Bose EOL Reddit](https://www.reddit.com/r/bose/comments/1o2cnhw/bose_ending_cloud_support_for_soundtouch/).
* **The Reddit "Alternative App" Megathread:** Ongoing conversation about replacing the Bose App. [Bose Alternatives Reddit](https://www.reddit.com/r/bose/comments/1o8my2n/soundtouch_app_alternatives/).
* **The Bose Wiki (App Alternatives):** A community-maintained list of current workarounds and projects. [Bose Alternatives Wiki](https://bose.fandom.com/wiki/SoundTouch_app_alternatives).
* **[GitHub Soundcork-repo](https://github.com/deborahgu/soundcork).**
* **[GitHub Ueberboese-repo](https://github.com/julius-d/ueberboese-api).**
