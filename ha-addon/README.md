## About

This add-on runs a private, self-hosted Bose Cloud Service replacement — preserving full speaker functionality, including physical preset buttons (1-6, plus extended double-tap presets 7-12), multi-room hardware grouping, stereo pairing, and streaming from a wide range of music sources via Music Assistant.

## Before You Start

**Music Assistant must already be installed and fully working** — confirmed playing audio to every SoundTouch speaker — before you install this add-on. See the **Documentation** tab for the full setup checklist.

## ⚠️ On First Boot, Watch the Log Tab

When you start this add-on for the first time (or after any restart), the **Info** page won't show any progress — it'll look like nothing is happening. That's expected. All of the real work — speaker discovery, the cloud handshake with each speaker, and the Music Assistant restart/reconnect — happens during boot and is only visible on the **Log** tab.

The add-on is fully up and ready when the log reaches its last line:

```
➡️  Web UI accessible at: http://<your-HA-host-IP>:<port>/control.html
```
(port shown is the free port Home Assistant automatically assigned this add-on — also visible, read-only, in the **Assigned App Port** Configuration field)

Once you see that line, click **Open Web UI** (or the link it prints) — the app is ready to use.


## Features

- **Fully Automated Bose Cloud Injection** — the entire cloud-redirect and preset setup sequence runs automatically on first boot. No USB stick, no manual firmware step — nothing to do on a previously configured or factory-reset speaker but let it join.
- **Automatic Speaker Detection** — a network scan finds every SoundTouch speaker on first boot and every reboot after. No manual IP entry, no speaker list to maintain.  
- **12 Physical Presets, Not 6** — double-tap any of the six buttons to unlock six more (1→11, 2→22, and so on), all mapped to your SoundTouch Hybrid Library (powered by Music Assistant).
- **Hardware-Native Multi-Room Grouping** — uses the speakers' own near-zero-latency master/slave hardware instead of software sync, across multiple independent groups at once, each with its own selectable master.
- **ST10 Stereo Pairing** — pair two ST10 units together as a true stereo left/right pair.
- **100% Local Control** — application and speaker credentials, playback, preset logic all stay on your own LAN. No Bose cloud dependency or external servers.
- **Physical Remote Control Hijacks** — Pause/Play and Next/Prev works again over DLNA, and Pause/Play over AirPlay, augmenting the volume, power, and preset controls that never stopped working.
- **Real-Time Preset Self-Healing** — if a speaker's presets get wiped (a known legacy-firmware degraded WiFi failure mode), they're detected and re-injected automatically, no restart required.
- **DLNA and AirPlay, Both Fully Supported** — side by side, your choice per speaker.
- **On Demand External Trigger:** Configure a speaker's preset (and optional volume) as an "On Demand" entry on the Scheduled Play page, then trigger it from outside the app — e.g. a Home Assistant automation — via a simple webhook, with no separate integration to install. See the Technical Documentation for setup details.

For the complete feature list see **Application Key Features** in the [main README](https://github.com/TJGigs/Bose-SoundTouch-Hybrid#readme).

## Getting Help

Full setup instructions, Music Assistant configuration, and troubleshooting live in the **Documentation** tab, or in the main repository README:
[github.com/TJGigs/Bose-SoundTouch-Hybrid](https://github.com/TJGigs/Bose-SoundTouch-Hybrid)

For the technical architecture and design decisions behind this add-on, see the [Technical Documentation](https://github.com/TJGigs/Bose-SoundTouch-Hybrid/blob/main/public/docs/SoundTouchHybridDocumentation.md).

![Supports aarch64 Architecture][aarch64-shield] ![Supports amd64 Architecture][amd64-shield] ![Supports armv7 Architecture][armv7-shield]

[aarch64-shield]: https://img.shields.io/badge/aarch64-yes-green.svg
[amd64-shield]: https://img.shields.io/badge/amd64-yes-green.svg
[armv7-shield]: https://img.shields.io/badge/armv7-yes-green.svg


