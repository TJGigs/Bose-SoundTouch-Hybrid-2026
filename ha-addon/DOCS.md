# Bose SoundTouch Hybrid — Home Assistant Add-on

Self-hosted replacement for Bose's discontinued SoundTouch Cloud service. Restores physical presets, multi-room grouping, and streaming via Music Assistant — running as a native Home Assistant add-on instead of a standalone Docker container.

---

## <img src="public/images/ma_icon.png" width="18"> Setting up Music Assistant (MASS)

***You must verify your SoundTouch speakers and streaming providers are fully working inside of Music Assistant before installing SoundTouch Hybrid.***

Install Music Assistant (MASS): ***version 2.10.1 or later is required***

1. **For installation instructions and troubleshooting, use Music Assistant Help** — setup, providers, speaker testing, playback issues, etc.
   * See [MASS GitHub](https://github.com/music-assistant/server) and [MASS Website](https://www.music-assistant.io/installation)
   * If you're running MASS as its own standalone Docker container (not the Home Assistant add-on), `mass_docker.yml` and `mass_package.json` in the `examples` folder of the main repository are provided as a reference for one working configuration. Your setup may differ.

2. **Initial Setup:** Once MASS is installed, go to its web interface and create your login. Bose SoundTouch Hybrid supports either way of authenticating to MASS:
   * **Username / Password:** your MASS login.
   * **Auth Token:** a long-lived access token generated from MASS's own Settings page

3. **Add/Configure Player Providers:** Add the DLNA provider. If desired also add AirPlay provider.
   * **DLNA is the recommended "Preferred Output Protocol"** for SoundTouch Hybrid, based on experience with greater stability and responsiveness:
     - It's the original protocol built into the SoundTouch speakers' internal OS; AirPlay was added later as a software add-on.
     - SoundTouch Hybrid's self-healing, latency management, and state sync logic are all optimized for DLNA.
     - The physical remote-control capability and hijacks are more complete with DLNA, including next/prev track and a more responsive pause/play.
   * **AirPlay** is supported. It does provide continuous live track-title updates on the speaker's LED display, whereas Music Assistant's DLNA stream currently only updates the speaker's LED display for the first track of a multi-track stream.

4. **Add/Configure Music Sources:** Add your streaming providers (Spotify, TuneIn, local NAS, etc). Uncheck any options to sync/import/cache the source into the local Music Assistant database. This ensures your providers are live rather than copied to a local cache.

5. **Configure Players (Speakers):** For each SoundTouch speaker Music Assistant discovers, set its **"Preferred Output Protocol"** to **DLNA** (recommended) or AirPlay. Change it from the **Auto-Select** default.
   * SoundTouch Hybrid enforces Preferred Output Protocol-specific required settings on startup and can also be triggered manually on the Tools page.
   * SoundTouch Hybrid uses Music Assistant only as the backend streaming engine. Once it's set up, there's no need to go back into its UI. MASS features like speaker grouping, automations, and favorites aren't used by SoundTouch Hybrid; leave them disabled.

6. **Very Important:** Confirm Music Assistant itself can play audio to every speaker and from every provider, and that you actually hear it on each speaker. Do this completely independent of Bose SoundTouch Hybrid. If Music Assistant can't reach a speaker, SoundTouch Hybrid can't either.

---


## <img src="public/images/hybrid_icon.png" width="18"> Installing SoundTouch Hybrid

* **Redirect to Local Cloud:** Happens automatically on first boot — no USB stick, no manual firmware step. Confirmed in the console/Pre-Flight log.
* **Speaker Discovery:** Runs automatically on first boot and re-syncs on every subsequent boot — you never manually look up, enter, or edit a speaker list. Discovery scans the same subnet as your Music Assistant server by default. If your speakers are on a different subnet/VLAN (e.g. Home Assistant routed separately from your speakers), set **Speaker Scan Subnet** below to override it.
* *A static IP address for each speaker is recommended, however, dynamic speaker IP addresses are supported.*

## Installing This Add-on

**Before you install:** Music Assistant must already be installed and fully working — see "Setting up Music Assistant" above.

1. In Home Assistant: **Settings → Add-ons → Add-on Store → ⋮ → Repositories**, add:
   `https://github.com/TJGigs/Bose-SoundTouch-Hybrid`
2. Find **Bose SoundTouch Hybrid** in the store and click **Install**.
3. Open the **Configuration** tab before starting it:
   * **Music Assistant Username / Password** Your MASS Username and Password. Both are required if not using a Music Assistant Auth Token.
   * **Music Assistant Auth Token** An alternative to the Username / Password. Both methods are fully supported; provide one or the other, not both.
   * **App IP / Music Assistant IP** — leave both blank, The add-on auto-detects the host address. Only set **Music Assistant IP** if MASS runs on a separate machine or VM.
   * **Speaker Scan Subnet** (optional) — leave blank for almost every setup; only needed if your speakers are on a different subnet/VLAN than Home Assistant. Enter the speakers' own subnet as a CIDR block, e.g. `192.168.1.0/24`.
   * **Assigned App Port** — Home Assistant automatically assigns this add-on a free port; it's shown here read-only, for reference only. Any value typed into this field is ignored. There's nothing to configure and nothing that can conflict with another port on your Home Assistant host.
4. Start the add-on. On first boot it scans your network and finds your SoundTouch speakers automatically.
5. Open the add-on's panel from the Home Assistant sidebar and use the **Open Web UI** button, or go directly to `http://<your-HA-host-IP>:<port>/control.html`, using the port shown in **Assigned App Port**.
6. **Install the Web App:** On your phone, open `http://<YOUR_SERVER_IP>:<port>/control.html` and tap **"Add to Home Screen"** to add the SoundTouch Hybrid icon and link to your home screen.

---

## On-Demand External Trigger (Optional)

Trigger a speaker's preset from outside the app — a Home Assistant automation, a motion sensor, etc without installing any separate integration.

1. **Create the On-Demand entry:** in SoundTouch Hybrid, go to **Tools → Scheduled Play / Off**. Add a new schedule, set **Trigger** to **On Demand**, then pick the speaker, preset, and (optionally) a volume. A speaker can have one On-Demand entry.
2. **Add a `rest_command:` in Home Assistant:** edit `configuration.yaml` and add one entry per speaker you want to trigger:
   ```yaml
   rest_command:
     soundtouch_hybrid_living_room:
       url: "http://<your-HA-host-IP>:<port>/api/ondemand/<SPEAKER_IP>"
       method: POST
   ```
   Use the same port shown in **Assigned App Port**, and the speaker's IP from the Speaker Configuration page.
3. **Call it from any automation:** use `rest_command.soundtouch_hybrid_living_room` as the action — a motion sensor, a time trigger, a scene, anything Home Assistant supports.

The webhook takes no parameters beyond the speaker's IP — it always plays whatever preset/volume you configured in step 1, so all the actual configuration stays in one place. If the URL or speaker IP is wrong, or nothing's configured yet, the call returns specific text explaining the error. Check the response in Home Assistant's automation trace if a call doesn't seem to work.

---

## Getting Help

Full technical documentation, architecture notes, and the standalone-Docker install path live in the main repository README:
[github.com/TJGigs/Bose-SoundTouch-Hybrid](https://github.com/TJGigs/Bose-SoundTouch-Hybrid)
