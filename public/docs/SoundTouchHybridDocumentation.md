# <img src="../images/hybrid_icon.png" width="30"> Bose SoundTouch Hybrid v4.2

**A free, open-source private SoundTouch cloud streaming service and application replacing the deactivated Bose Cloud Service to maintain 100% of the smart speaker functionality of SoundTouch Speakers and Wireless Link. Physical Presets Included!**

It runs locally on the user's network (NAS, PC, or Home Assistant add-on) and intercepts and actively manages the complex server handshakes required to keep SoundTouch Speakers authenticated and functional — delivering the **same phone-free audio streaming capabilities** as the original SoundTouch Application and Speakers.

---

*For the full feature list, see the README's [Application Key Features](../../README.md#-application-key-features) section. For installation and setup — both the standalone Docker deployment and the Home Assistant Supervisor add-on — see the README's [Installations](../../README.md#installations) section. For a visual walkthrough, see the [Demo Videos playlist](https://www.youtube.com/playlist?list=PLS5KFF3Xd1vmpmRJuNjAk_L_JJNcCjsnr). This document covers the technical architecture and design decisions behind those features, not a feature list or setup walkthrough.*

## Table of Contents

1. Introduction & Vision — the Bose Cloud's end-of-life and the goal to preserve the native SoundTouch experience
2. System Architecture — Cloud Emulation, Music Assistant, Hybrid Bridge, Unified Web App, Standalone Docker and Home Assistant add-on
3. Technical Constraints & Adaptations — solutions behind cloud emulation, presets, speaker detection, hardware grouping, stereo pairing, self-healing, preset recovery, and protocol tradeoffs

---

## 1. Introduction & Vision

### Preserving Bose SoundTouch "Smart" Speaker Functionality

The reason for this project was Bose's May 2026 shutdown of its SoundTouch Cloud Service, which degraded the Bose SoundTouch intelligent, multi-room audio speakers into "dumb" receivers dependent on a phone's active connection. This represents a significant loss of functionality for the SoundTouch Speakers and Wireless Link Adapter.

While Bose suggests using AirPlay or Aux connections as a fallback, these solutions fundamentally break the core experience of the speakers. Users are forced to use a "dumbed-down" native SoundTouch app for basic grouping, speaker administration, and local NAS music sources, while jumping to third-party apps to stream cloud-based music sources. Without the Bose Cloud and its integrated SoundTouch application, the speakers lose much of their functionality.

**The Problems.** The shutdown created three distinct critical failures in the ecosystem:

- **The Loss of Physicality** — the physical Preset Buttons (1–6) on the device, a defining feature of the SoundTouch speakers, become useless for cloud sources, turning a sophisticated speaker into a passive one.
- **The "Phone Tether"** — to play music, users must open an app and "cast" the audio. The phone becomes the mandatory "brain"; if the device leaves the network or the battery dies, playback stops.
- **App Fragmentation** — users are forced to juggle multiple apps: the legacy SoundTouch app for setup, management, and grouping, and separate streaming apps (Spotify, Apple Music, etc.) for content.

**The Vision.** The goal is not only to keep the speakers playing, but to replicate the full experience of the original Bose SoundTouch ecosystem without relying on Bose's cloud services or app. The ultimate objective is complete independence from any Bose software — for streaming, speaker management, connectivity, or even provisioning of factory-reset speakers.

The SoundTouch experience is defined by three distinct interaction modes, all of which this implementation preserves:

- **The Headless Experience** — walking into a room and pressing "Preset 1" on a physical speaker to start music immediately, with no app or mobile device required.
- **The Remote Experience** — using a phone, tablet, or computer purely as a controller to browse libraries, manage queues, favorite tracks, and group speakers, without the controller acting as the audio source.
- **The Administration Experience** — retaining control over hardware settings such as preset assignments, speaker naming, bass EQ, power saving modes, and stereo pairing, plus application-level settings like scheduling a speaker to play or power off at a set time, a Power Off Timer to auto-off a set number of minutes after playing, auto-resume presets, and other automation options.

**The Solution.** A new architecture necessitated a self-hosted "Private Cloud" to replace the missing logic and authentication handshakes of the Bose Cloud, alongside a new Integrated SoundTouch Hybrid app hosted on the local network with a browser and mobile UI. This shifts the "brain" from remote Bose servers back to the local network, restoring the SoundTouch experience through four architectural principles:

- **The Private Cloud Core** — a self-contained Dockerized environment acting as the central intelligence. It emulates the speaker's internal handshakes with the Bose Cloud, redirecting them to the SoundTouch Hybrid's own Bose Cloud emulation, and intercepts physical preset button presses to route them to modern streaming APIs (Spotify, TuneIn, Apple Music, local NAS, etc.).
- **A Unified App** — a single, mobile-responsive web application that consolidates music browsing, queue management, hardware administration, and speaker setup into one interface, eliminating the split between a "Settings App" and a "Music App."
- **Hardware-First** — leverage native Bose hardware capabilities wherever possible: internal DSP, native multi-speaker synchronization, and low latency, rather than brute-forcing software alternatives.
- **Open-Source** — built entirely on open standards (Node.js, UPnP/DLNA, Music Assistant) so the system stays transparent and extensible.

---

## 2. System Architecture: The Hybrid Overview

This solution is a "Hybrid" because it merges native Bose hardware capabilities with locally hosted server applications, preserving the original SoundTouch ecosystem experience. It replaces the decommissioned Bose Cloud with a private, local cloud emulator, and rather than building a proprietary streaming engine from scratch, it uses an abstraction layer to tap into an existing, mature, open-source backend — Music Assistant — as the streaming brain.

**The Components:**

- **Cloud Emulation ("The Bose Cloud")** — with the official Bose Cloud decommissioned, speakers need a local emulator to authorize sources, manage accounts, and maintain presets. The local implementation (`bose_cloud.js`) also acts as a "sinkhole," gracefully intercepting obsolete cloud handshakes and trapping unnecessary telemetry, firmware checks, and destructive account-deletion requests with fake "success" responses.
- **Music Assistant ("The Brain")** — serves as the backend core. MASS acts as a universal provider aggregator: it manages streaming credentials, scans local NAS libraries, and controls the master playback queue (v2.9.9+ required). Because MASS normalizes disparate providers (Spotify, Apple Music, TuneIn, local files, etc.) into one API, adding a new provider requires zero code changes on the Hybrid side — only configuration inside MASS itself.
- **The Hybrid Bridge ("The Translator")** — a custom Node.js application bridging the legacy Bose LAN API and the modern Music Assistant API. It intercepts requests from physical speakers and translates them into backend commands.
- **The Unified Web App ("The Interface")** — a comprehensive web app that directly replaces the SoundTouch app: playback, library management, multi-speaker grouping, and device administration all in one place.

**Two deployment topologies, one backend.** The system runs identically whether deployed as a standalone Docker container (NAS or PC) or as a native Home Assistant Supervisor add-on — same Node.js backend, same Hybrid Bridge, same cloud emulation. The add-on path exists for users who already run Home Assistant as their home automation hub and want SoundTouch Hybrid managed through the same Supervisor lifecycle (install, update, logs) as their other add-ons, rather than a separate Docker Compose stack. Section §3.14 describes how the two topologies affect restarting Music Assistant.

![SoundTouch Hybrid Architecture Diagram](ArchitectureIntro.png)

---

## 3. Technical Constraints & Adaptations

Implementing this architecture required extensive trial and error — from bypassing Bose cloud authentication to replicating low-latency hardware synchronization, to handling network, software, and speaker hardware timing inconsistencies. Some adaptations built on prior research from the GitHub developer community also addressing the Bose SoundTouch shutdown.

### 3.1 Automated Bose Cloud Redirection

**The Problem.** By default, Bose speakers are hardcoded to seek `bose.com` servers for their cloud handshake. Without redirecting that traffic to the local emulator, none of the rest of this system can function.

**The Fix.** Speaker onboarding is a fully automated injection sequence that runs on first boot — no USB drive, no Telnet backdoor, no manual firmware step required from the user. The system opens a connection to the speaker's Gabbo System Bus (port 8080) directly over the network and injects the override sequence, permanently redirecting `margeServerUrl`, `statsServerUrl`, and the BMX registry to the local Private Cloud. (These URLs are always numeric IPs by the time they reach the speaker, never a hostname — see §3.4's *Hostname-Safe Configuration* for why that matters.)

**The Local Emulator (Core Provisioning & Authorization).** Once redirected, the SoundTouch Hybrid server completely replaces the Bose servers, actively managing the handshakes required to keep the hardware authenticated:

- **The BMX Registry Handshake** — silently handles background authentication and enables physical preset control by injecting the response the speaker expects from the Bose cloud.
- **Dynamic Account Generation** — when a speaker requests its profile, the emulator confirms or assigns a `MargeAccountID`, including for factory-reset speakers.
- **Source Authorization** — the emulator explicitly authorizes source `11` (`LOCAL_INTERNET_RADIO`), ensuring the speaker's firmware accepts the custom stream format used for preset injection (see §3.2).
- **Hybrid Preset Injection** — maps the Hybrid presets directly into the speaker's memory, assigning the physical hardware buttons as triggers that request audio from the local Hybrid library instead of the (dead) Bose cloud.

**The Local Emulator ("Traps" & NVRAM Healing).** In addition to provisioning, the emulator acts as a defensive sinkhole:

- **NVRAM Auto-Healer** — if a factory-reset speaker connects, the emulator automatically completes the "Setup" phase (otherwise broken by the decommissioned Bose cloud), injecting a master sequence (Language → Name → Account → Seal) that permanently cures the NVRAM and forces the speaker into a "Ready" state.
- **Telemetry Traps** — the speaker attempts to send heavy telemetry home; the emulator catches these and returns a fake `200 OK`, freeing CPU and network bandwidth.
- **The Delete Trap** — if a speaker fails to boot cleanly, it may attempt to delete its own account to start over. The emulator blocks the deletion but reports success, preventing a boot-loop.

### 3.2 Restoring Physical Preset Control

**Bypassing the Cloud Handshake.** Writing directly to native API source candidates (like Spotify) requires a cryptographic handshake with the decommissioned Bose Cloud. Without it, the speaker rejects a preset write. A backdoor was required to make the physical buttons trigger the local server without cloud validation.

**The "Local Radio" Backdoor.** Deep scans of the native input sources (via the `/sources` endpoint) identified several candidates for stream injection, including Spotify, UPnP, and AirPlay. Testing showed `LOCAL_INTERNET_RADIO` was the only source that accepted a direct URL write without a Bose cloud-side handshake.

**Execution flow:** the physical buttons (1–6) are configured to play a "fake radio station" hosted on the Hybrid Bridge (e.g., `http://192.168.x.x:3000/preset/1.mp3`). When the user presses Preset 1, the speaker requests that URL; the Bridge recognizes the request not as a desire for audio but as a trigger event, fires a command to Music Assistant to start the actual associated content, and Music Assistant hijacks the session via DLNA almost instantly.

**Latency Management: The "Silence" Buffer.** A race condition can occur where the speaker rejects the Music Assistant stream because it hasn't fully established the "fake radio" connection yet. The fix: the file served by the Bridge is a silent audio buffer. The speaker connects to the silence first (satisfying its internal state machine), and the Bridge waits 500ms–1000ms before instructing Music Assistant to take over — a smooth, pop-free handoff.

### 3.3 Extended Presets: Double-Tap Detection

**The Feature.** Each of the six physical preset buttons now holds two assignments — a single-tap preset and a "double-tap" preset (1→11, 2→22, and so on) — doubling the presets available per speaker without touching the hardware.

**How it works.** The same `/preset/:id.mp3` trigger endpoint used for the backdoor above (`routes/bridge.js`) tracks pending taps per speaker IP. On the first press, it opens a 500ms window and holds the request open (still streaming silence, so the speaker doesn't time out) rather than firing immediately:

- If a second press of the **same** preset ID arrives inside that window, it's confirmed as a double-tap and routed to slot `id × 11`.
- If the window expires with no second press, it fires as a normal single-tap to slot `id`.
- A separate "extended intent" flag lets the web UI trigger the extended slot directly (e.g., clicking "P11" in the app) without needing a physical double-tap at all, since the UI already knows unambiguously which slot the user means.

This is an extension of the same LOCAL_INTERNET_RADIO backdoor mechanism in §3.2 — no new interception point was needed, just a timing state machine layered on top of the existing one.

### 3.4 Automated Speaker Detection

**The Feature.** Speakers are found automatically via a network scan on first boot and every subsequent reboot — no manual IP entry, no speaker list to maintain by hand. A static IP is recommended for each speaker, but not required.

**Handling IP Changes.** Every persisted reference to "which speaker" in this system — preset assignments, stereo pairs, scheduled events, power off timers — stores a speaker's IP address alongside its `deviceId` (a stable identifier baked into the hardware, captured the same time the IP is). If a speaker's IP address changes — a DHCP lease renewal, a router reboot — the network scan that runs on every boot re-matches speakers by `deviceId` and corrects any stored IP that no longer points at the right hardware, for the speaker list itself and for every preset assignment and stereo pair that references it.

If a speaker's IP address changes while the app is already running, mid-session, that change won't be caught right away — a system restart is required, and once that happens, the speaker is found and corrected automatically. This also requires a `deviceId` to have been successfully captured when the reference was first created, which requires the speaker to have been reachable at that moment.

**Scan Target: Subnet Derivation and Override.** The discovery sweep needs a subnet to scan, and by default it derives one from `MASS_IP` — on the assumption that the server, Music Assistant, and the speakers all share the same local network. That assumption breaks in one specific, common topology: the Home Assistant add-on deployment, where `MASS_IP` is documented to be Home Assistant's own IP address whenever MASS runs as a separate HA add-on rather than alongside this app. If a user's speakers sit on a different subnet or VLAN than Home Assistant itself — a deliberate network segmentation, not a misconfiguration — the derived subnet is simply wrong, and no scan of it will ever find the speakers.

There's no way to infer the correct subnet in that case; it has to come from the user. `SCAN_SUBNET` (a CIDR block — e.g. `192.168.1.0/24`, or a larger non-`/24` range like `192.168.1.0/23` for a split network that spans two address blocks) overrides the derived value entirely when set, and is the only user-facing surface this fix adds. Everyone on a single flat network — the overwhelming majority of installs — sees no change at all.

**Hostname-Safe Configuration.** `APP_IP` and `MASS_IP` are also accepted as local DNS hostnames rather than numeric IPs. That's convenient for a user whose server's IP might change, but naive handling would be dangerous: both values get written directly into a speaker's own NVRAM as part of the cloud-redirect sequence in §3.1 (`bmxRegistryUrl`, `statsServerUrl`, `margeServerUrl`, and the preset stream URLs in §3.2). A hostname configured there would have to be resolved by the SoundTouch's own ~2013-era embedded firmware, on its own network stack, every time it phones home — and that firmware's DNS capability for an arbitrary local hostname is unverified and not something this system can control or test for.

The fix: any configured hostname is resolved to a numeric IP once, in this app's own code — using this app's own DNS resolution, not the speaker's — at boot, and again on the same cadence as the scheduled speaker audit (§3.11) so a hostname's underlying IP drifting mid-runtime still gets caught. Only the resolved numeric IP is ever written to a speaker's NVRAM or used for the discovery sweep; the raw hostname the user typed is never passed downstream, and a speaker is never asked to resolve anything itself, regardless of what's configured in `.env`.

### 3.5 Hardware Multi-Room Grouping

To maintain seamless multi-speaker synchronization, the system prioritizes Bose's native hardware grouping over software-level sync (such as Music Assistant's own synchronized streams).

**The Reasoning:**

- **Latency** — Bose's hardware sync operates at the chipset level, achieving near-perfect synchronization with extremely low latency.
- **Drift Avoidance** — pure software sync solutions often rely on NTP, which can drift over playback, causing an audible "echo" between speakers.

**Implementation.** The "Join/Group" controls don't ask the server to build a software group — they send commands directly to the Master speaker to add a slave IP, using the internal Bose chipset. Multiple independent groups can exist simultaneously, each with its own selectable master, rather than the system being limited to one all-or-nothing group.

**The Smart Grouping Redirect.** To preserve group integrity, the Hybrid Bridge implements an intelligent redirection layer: if a user changes the preset on a Slave speaker (say, the Kitchen, grouped to a Living Room Master), that command would normally fail or break the group, since the Slave is merely repeating the Master's stream. Instead, the Bridge detects that the target is currently a Slave and automatically redirects the command to the Master. The whole group's track changes, and the group stays intact — the user never needs to know which speaker is actually the Master.

This same native hardware relationship means powering off the Master powers off every Slave in the group too — the group's power state follows the Master, not just its playback.

### 3.6 ST10 Stereo Pairing

**The Feature.** Two ST10 units can be paired as a true stereo left/right pair, a distinct mechanism from the multi-room grouping in §3.5 — it locks two speakers together as permanent channels of one virtual product rather than just synchronizing independent playback.

**The Protocol.** A paired speaker phones home to the local cloud emulator asking for its group configuration (`GET /streaming/account/:id/device/:deviceId/group/`) and expects a `GroupService`-style XML response naming the master device and each unit's L/R role. Bose's own request already carries the asking speaker's `deviceId` directly in the URL — the same identifier used to track speakers and correct IP drift elsewhere in the system (see §3.4). The emulator resolves the pair using that deviceId, falling back to matching by source IP only for a pair that was created before a deviceId could be captured (e.g., a speaker briefly offline during setup).

### 3.7 Smart Polling & State Management

Beyond grouping, the system implements "Smart Polling" to keep software state in sync with physical hardware state.

**Power State Synchronization.** If a speaker is turned off via the physical remote or its power button, the Bridge detects the state change via the LAN API and immediately sends a STOP command to Music Assistant. Without this, the backend would continue "streaming" to a powered-off device ("ghost playing") — consuming bandwidth, corrupting playback history, and in some cases actually powering the speaker back on.

### 3.8 Physical Remote-Control Restoration

**The Problem.** Bose's own firmware changes broke certain physical remote and hardware transport controls — next/previous track and play/pause don't function against the now-defunct cloud-dependent playback pipeline for cloud sources.

**The Fix.** The `/api/key` handler checks whether Music Assistant is the currently active playback driver for a given speaker (`massIsActiveDriver`). If it is, transport keys (`NEXT_TRACK`, `PREV_TRACK`, `PLAY_PAUSE`, `PAUSE`, `PLAY`, `STOP`) are delegated to MASS instead of being sent as native Bose `/key` commands — MASS can reliably act on them where the speaker's own broken pipeline can't. Everything else (power, presets) still goes straight to the speaker's native WAPI.

**The AirPlay Wrinkle.** On this hardware, pausing an AirPlay stream terminates the session outright rather than actually pausing it — there's no clean "paused" state to resume from. An `AIRPLAY_PAUSE_INTENT` flag records that the user meant to pause (not stop), so a subsequent play resumes the intended track rather than starting fresh. This doesn't apply to DLNA, which maintains a proper paused session natively.

**Button-by-button behavior.** Community testing ([Discussion #120](https://github.com/TJGigs/Bose-SoundTouch-Hybrid/discussions/120)) mapped every physical remote and hardware button against both protocols:

| Button | Native Behavior | Hybrid Bridge Action | Status |
|---|---|---|---|
| Power | Turn speaker on/off | None needed | ✅ Native |
| AUX | Switch to AUX | None needed | ✅ Native |
| Bluetooth | Switch to Bluetooth | None needed | ✅ Native |
| Preset 1–6 | Load saved preset from Bose cloud | BMX handshake/WebSocket redirect to MASS | ✅ Hijacked |
| Volume +/− | Adjust volume | None needed | ✅ Native |
| Play/Pause (DLNA) | Pause/resume active stream | Remote pause detected via WebSocket, redirect to MASS | ✅ Hijacked |
| Play/Pause (AirPlay) | Pause AirPlay playback; session fully terminates after ~12–14s | Pause detected by context with two resume paths | ✅ Hijacked |
| Next / Prev Track (DLNA) | Skip to next/prev track | Skip command fails in Flow Mode — intercepts WebSocket error and redirects to MASS | ✅ Hijacked |
| Next / Prev Track (AirPlay) | Skip to next/prev track | Generic signal with no distinguishable intercept point | ❌ Dead |
| Thumbs Up / Down | Send like/dislike to streaming service via Bose cloud | Generic signal with no distinguishable intercept point | ❌ Dead |

DLNA exposes a distinguishable command for each button press, which is why it supports more hijacks than AirPlay — AirPlay's generic signaling gives the Bridge no way to tell Next/Prev or Thumbs Up/Down apart from each other.

### 3.9 The SoundTouch Hybrid User Experience

The Web Admin UI is a complete functional replacement for the native Bose SoundTouch app, accessible from any browser. It isn't required for daily listening — as long as SoundTouch Hybrid and Music Assistant are running, physical presets and volume controls work on their own.

- **Unified Global Control** — one application manages setup, cloud emulation, presets, settings, power, volume, and media for every speaker simultaneously.
- **Universal Search & Discovery** — provider-agnostic search across Spotify, TuneIn, local NAS, and any other configured provider in one place, rather than switching between isolated "service" tabs — and extensible to any new provider MASS supports, with no code changes on this side.
- **Native Visual Grouping** — the app exposes Bose's native hardware-level grouping directly, regardless of which source is currently streaming.

### 3.10 State Synchronization & Self-Healing Logic

Legacy SoundTouch hardware introduces significant latency (1–4 seconds) when changing states, creating race conditions where software believes the device is ready while the hardware is still catching up. A layer of self-healing logic in `mass.js` and `device_state.js` compensates:

- **Smart Resume** — a generic PLAY command to a stopped queue often restarts from index 0. The system first queries the player's internal state: if PAUSED, it sends a non-destructive resume; if STOPPED/UNKNOWN, it forces a fresh play command.
- **Kickstart** — occasionally MASS successfully pushes a stream but the hardware "stalls," buffering indefinitely. If the Bridge detects valid track data but a stuck audio state, it sends a native physical PLAY key press to "jolt" the DAC into engaging.
- **Zombie Stream Killer** — rapid source switching can leave the legacy Bose HTTP engine unable to close a previous connection, locking memory and draining resources. Before establishing a new stream, the system scans for orphaned sessions and forcefully terminates any it finds.
- **State Debouncing & Event Throttling** — adjusting volume or grouping speakers can trigger a flood of duplicate WebSocket updates (sliding a volume slider might fire ten XML blasts). A debounce filter waits for the hardware to settle before pushing the final state to the UI and MASS.
- **Optimistic Execution** — legacy HTTP timeouts (port 8090) frequently throw errors even when the command actually succeeded on the speaker milliseconds later. A `Force_Success` flag assumes success on a non-fatal timeout and updates the UI immediately, masking the hardware's slow response times.
- **Primary/Secondary Command Redirection** — sending a command directly to a Secondary (slave) speaker in a hardware group often fails or breaks sync. The Bridge pre-checks every command and transparently redirects it to the group's Primary if needed.

### 3.11 Observability: "Record Everything"

Because the legacy Bose API often fails silently (returning `200 OK` even when it ignores a command) and Music Assistant operates asynchronously, debugging state mismatches was nearly impossible with default logging.

**What it captures:** every physical key press and UI button click; detailed self-healing recovery actions (e.g., "Speaker is OFF. Waking up..." or "Retry 2/2 for play_media..."); real-time group topology changes; and the routing logic behind why a given command went to MASS instead of the speaker directly.

**Why it remains.** High-level logging is deliberately left active in production. In an environment where network latency or hardware quirks can cause random dropouts, these logs are the only way to trace why a speaker failed to group or play, and to distinguish a code bug from a hardware timeout.

### 3.12 Protocol Considerations: DLNA/UPnP vs. AirPlay 2

**DLNA's advantages:** it's the native implementation of the SoundTouch hardware, and the system's self-healing, latency management, and state polling were originally built and most heavily tested against it. DLNA also maintains a proper paused session (see §3.8) — AirPlay pause terminates the stream outright on this firmware, which the `AIRPLAY_PAUSE_INTENT` flag works around rather than something DLNA needs to compensate for at all. In hands-on testing, DLNA has also proven more stable overall and quicker to respond to transport controls and state changes than AirPlay.

**DLNA's Flow Mode trade-off:** older SoundTouch hardware won't automatically advance to the next track over DLNA/UPnP — it treats one song as a completed session and stops. Music Assistant detects this and applies "Flow Mode," stitching the entire queue into one continuous audio stream so the speaker never sees a track boundary to stop on. The trade-off: the continuous stream strips out per-track metadata normally found in individual file headers. The Web Admin UI works around this with a side-channel fetch — it queries the Music Assistant API directly for real-time artwork, artist, and track name rather than relying on the stream itself — but the speaker's own physical LED display has no equivalent workaround: it correctly shows the standard metadata (song title and artist) for the first track of the stream, then stays stuck on that same first-track info for every subsequent track in the same Flow Mode session.

**AirPlay's advantage:** it provides continuous, per-track metadata to the speaker's own physical LED display for every track, sidestepping the Flow Mode limitation above entirely.

**The result:** DLNA and AirPlay each solve half of the experience in a different place — DLNA for session stability, AirPlay for the LED display — so the system supports both protocols per speaker, as desired, rather than forcing one choice globally. A SoundTouch 20 or 30 might run AirPlay so its LED display always shows what's playing, while a SoundTouch 10 speaker might stay on DLNA for added stability.

### 3.13 Preset Resend: Recovering from Firmware Preset Loss

**The Problem.** Legacy SoundTouch firmware can silently lose an injected preset — a slot goes empty, or reverts to a stale non-Hybrid URL — independent of the speaker's cloud account configuration, which stays correctly pointed at the local Private Cloud. This is a known firmware degradation pattern, most commonly triggered by unstable WiFi, not something the app causes or can prevent at the source.

**The Fix.** `pushPresetsToSpeaker()` writes all 6 Hybrid presets directly into the speaker's NVRAM via a non-destructive `/storePreset` WAPI call — no reboot, no standby/wake cycle, no playback interruption. `speakerHasHybridPresets()` detects both failure modes (empty slots and slots pointing to non-Hybrid URLs).

This recovery is automatic out of the box — nothing to configure, nothing to opt into:

- **Every boot** — the Pre-Flight check pushes presets directly whenever the cloud config is already healthy but the presets aren't (skipped when a full injection already ran, since that handshake delivers presets on its own). This alone catches drift on every restart with zero setup.
- **Cloud handshake recovery** — fires automatically if a handshake completes but presets weren't part of it. If a stream was playing when the handshake broke, this path also attempts to restart it after the preset push, by checking MASS's queue for what was still active. 

Two optional extras add coverage beyond boot-time, for users who want them — neither is required for the recovery above to work:

- **Nightly scheduled audit** — `runSpeakerAudit`, opt-in via the Tools page, catches drift that happens mid-session between boots instead of waiting for the next restart.
- **Preset Watchdog** — opt-in, per-speaker recurring push, meant for actively debugging a specific speaker with a known history of chronic preset loss rather than for general protection.
- **Manual "Push Now"** — always available on the Tools page for a one-click re-push on demand, independent of either opt-in setting.

Because the push writes directly to NVRAM rather than replaying the original injection handshake, none of these paths require a reboot or interrupt whatever is currently playing.

### 3.14 Home Assistant Add-on: A Second Deployment Path

Running as a native HA Supervisor add-on introduces one additional logic path that doesn't exist in the standalone Docker deployment: restarting Music Assistant for a clean network state (part of the boot sequence in §3.1) can't assume a single fixed mechanism, because MASS itself might be a sibling HA add-on, a separately managed Docker container on the same host, or a Home Assistant instance running on an entirely different machine.

The restart logic tries three paths in order, the first that applies wins:

1. **Native HA Supervisor** — when this app is itself running as an HA add-on, `SUPERVISOR_TOKEN` is auto-injected into its environment with no configuration required. Its mere presence is a hard signal of which scenario applies, so it's tried first.
2. **Docker socket** — used when Music Assistant is a plain container co-hosted on the same Docker host as this app (the standalone deployment's default case).
3. **HA Supervisor, public API** — used when Music Assistant is a Home Assistant add-on running on a separate machine from this app; requires a long-lived HA access token (`HA_TOKEN`) configured in `.env`.

The logic cascades through all three paths in order; if every path fails, the system assumes Music Assistant is already in a good state and boot continues normally.

### 3.15 Home Assistant Ingress: Dynamic Port Assignment

`config.yaml` sets `ingress_port: 0`, which tells Supervisor to assign the add-on a free host port automatically rather than a fixed number — avoiding a collision with anything else already using a common port (Z-Wave.js on 3000, for example). Per Supervisor's source (`supervisor/ingress.py`, `get_dynamic_port()`), the assignment is looked up by the add-on's slug and persisted to disk, not re-rolled — the same port is returned every time, across add-on restarts, Supervisor restarts, and full HA host reboots. It only changes if the add-on is uninstalled and reinstalled.

`run.sh` reads the assigned value back via `bashio::app.ingress_port` (which queries `GET /addons/self/info`) and writes it into `.env` as `APP_PORT` — the same variable every other deployment method already uses. Preset NVRAM injection ([preflight.js:267](../../routes/preflight.js#L267)) and the Ingress proxy both resolve off that one value, so there's no separate static/dynamic pair to keep in sync and no second listener needed. If the assigned port ever changes (only possible via uninstall/reinstall), the existing boot-time preflight drift check re-injects the corrected URL onto speaker NVRAM automatically.

Since the port isn't something a user sets, `config.yaml`'s schema has no editable port field — only `assigned_app_port`, a read-only-in-practice field (Supervisor's schema has no native read-only type) that `run.sh` overwrites unconditionally on every boot regardless of what a user types into it, so the Configuration tab always displays the real value for reference.

### 3.16 Scheduled Automation & On-Demand External Trigger

**Scheduled Play — days and volume.** Each `scheduledEvents` entry can restrict itself to `weekday` or `weekend` (omitted means every day) and optionally carry a `volume` (omitted means leave the speaker at its current volume). The day-of-week check uses `now.getDay()`, read in the same scheduler tick (`routes/utils.js`) as the hour/minute already checked there. Volume is applied via `mass.setVolume()` — the same MASS command (`players/cmd/volume_set`) `syncVolumeToMass` uses in the opposite direction — after `executeSmartPreset()` succeeds, for `'play'` events only. The Tools page offers volume as a stepped select (5–100 in steps of 5, matching the hour/minute pickers).

A speaker's schedules for a given action can't overlap: `all` (every day) can't coexist with anything else, and `weekday`/`weekend` can each exist only once. This is enforced at creation time — the Tools page's DAYS field only ever offers a value that doesn't already overlap an existing schedule for that speaker+action — since there's no in-place edit for an existing schedule, only delete and re-add.

**Power Off Timer modes.** A timer's `mode` is `'always'` (default, omitted) or `'once'`. An always timer re-arms every time the speaker powers on. A once timer disables itself — the same `enabled` flag its own UI checkbox controls — the moment it successfully fires, persisted back to `settings.json`. Re-arming a fired one-time timer is just re-checking that same box.

**On-Demand external trigger.** `POST /api/ondemand/:speakerIp` ([routes/controller.js](../../routes/controller.js)) fires the one On-Demand entry configured for a speaker — a `scheduledEvents` row with no `hour` set and a `trigger: 'ondemand'` marker — through the same `firePlayEvent()` helper the scheduler uses. A speaker can have at most one On-Demand entry per action.

Setup steps, identical to the Home Assistant add-on's own Documentation tab (`ha-addon/DOCS.md`):

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

The webhook takes no parameters beyond the speaker's IP — it always plays whatever preset/volume you configured in step 1, so all the actual configuration stays in one place: this app, not scattered across Home Assistant automations. If the URL or speaker IP is wrong, or nothing's configured yet, the call returns a specific error explaining which — check the response in Home Assistant's automation trace if a call doesn't seem to work.

Failure responses:

| Scenario | Status | Response |
|---|---|---|
| Fired successfully | `200` | `{ "success": true }` |
| IP doesn't match any configured speaker | `404` | `Unknown speaker IP '...' — check it matches a speaker on the Speaker Configuration page.` |
| IP is a real speaker, but has no On-Demand entry | `404` | `No On Demand entry configured for ... — set one up on the Scheduled Play page.` |
| Entry exists, but playback itself failed | `500` | `Failed to trigger playback — check the SoundTouch Hybrid server logs.` |

`triggerOnDemand()` (`routes/utils.js`) checks whether the speaker is known and whether it has an On-Demand entry separately, so those two cases return distinct errors instead of an identical one.
