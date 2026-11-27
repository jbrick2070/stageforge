# Live DMX Output (Experimental)

> **Experimental feature:** Live output to real lights has only been tested against a local DMX receiver (`127.0.0.1`), not real fixtures, and its pre-flight checks are guidance, not certification. Transport settings and Arm / Go live controls live inside the collapsed **"Advanced: live output to real lights (experimental)"** section of the DMX Monitor drawer so simulator users are never shown live output controls by default. The manual hardware checklist at the bottom of this document is still unticked.

StageForge outputs its live 2-universe DMX512 desk state (Universes 1 and 2, 512 slots each) over:

- **sACN (ANSI E1.31-2018)** — desktop app (`desktop/dmx-packets.cjs`, `desktop/dmx-sender.cjs`) over Node `dgram` in the Electron main process.
- **Art-Net 4** — desktop app over Node `dgram` in the Electron main process, with `ArtPoll` / `ArtPollReply` node discovery and unicast `ArtDmx` (plus optional directed broadcast).
- **Enttec DMX USB Pro (Web Serial)** — browser (Chromium/Edge) and desktop app (`src/dmx/enttecPro.ts`), single universe (choose SF U1 or U2).

## Architecture & Security

- **Main-process frame loop:** UDP sockets and the rate-capped refresh timer live in Electron's main process so network DMX remains immune to renderer throttling. While output is active, main temporarily disables Chromium background throttling on the owning window (`setBackgroundThrottling(false)`) and restores it when output stops.
- **Explicit interface binding:** Output always binds to a specific IPv4 address returned by a fresh `os.networkInterfaces()` scan (including `127.0.0.1` for local visualizers). sACN multicast sets both multicast TTL and `setMulticastInterface(iface)`. Note that on Windows, weak-host routing may still route out-of-subnet unicast targets via the OS default route; keep unicast lighting nodes on the selected NIC's subnet.
- **Validated IPC:**
  - Universe buffers cross a single fire-and-forget IPC channel (`stageforge:dmx-frame`). Main verifies `event.senderFrame === event.sender.mainFrame`, `isAppPage(url)`, owning window ID, active running state, `universe ∈ {1, 2}`, and exact `Uint8Array(512)` byte length, then copies into main-owned buffers.
  - Renderer liveness heartbeats cross `stageforge:dmx-heartbeat` (~1 Hz while live, validated identically to `stageforge:dmx-frame`). Because unchanged-frame suppression stops `stageforge:dmx-frame` on static cues, frame updates never renew the heartbeat lease.
  - Control commands cross `stageforge:dmx-control` (`listInterfaces`, `getStatus`, `enable`, `disable`, `discover`) with strict schema/key validation, window-ownership enforcement, and no unknown keys allowed.
  - Web Serial in Electron requires an explicit native `select-serial-port` chooser (never auto-selected) and stores device grants only in memory for the current session.

## Physical Personalities vs Simulation Layout

StageForge separates its **simulation / DMX monitor buffers** (`dmxUniverse1/2`) from its **physical wire buffers** (`physicalDmxU1/U2`) sent over sACN, Art-Net 4, and Web Serial:

- **Implemented datasheet personalities** (each backed by golden-byte tests):
  - ETC ColorSource PAR (`1-Ch`, `RGB (3-Ch)`, `5-Ch (Default)` — hardware strobe held at `0`)
  - CHAUVET Professional STRIKE 4 (`1-Ch`, `4-Ch`)
  - Martin JEM ZR45 (`1-Ch`: `0` idle, `13–240` variable, `241–255` max)
- **Unimplemented catalogue & generic non-catalogue fixtures** (including moving heads, battens, strobes, external-switchpack fixtures, hazers, unverified catalogue laser modes, and generic non-catalogue fixtures): listed as **`not driven (simulation only)`** in DMX Output and transmit **neutral `0` across their entire footprint** on `physicalDmxU1/U2` so StageForge's generic simulator channel layout never reaches physical hardware (while `dmxUniverse1/2` preserves the simulated layout for 3D preview, the `SIM` monitor, and v1–v13 show compatibility).

## Safety Model

1. **Off by default & tucked under Advanced:** StageForge never auto-enables DMX output on launch. Transport settings and **Arm output / Go live** sit inside a collapsed **Advanced: live output to real lights (experimental)** disclosure (`localStorage` remembers only whether Advanced is expanded, never armed or live state). The **LIVE** badge, **Pre-flight status badge**, any live safety warning, and **Blackout & stop** always stay outside the collapsed section and visible while output is live.
2. **Visible pre-flight gate, two-step arming & fail-closed live TOCTOU shutdown:** **Arm output** stays disabled (and both `useLiveDmxOutput.enable()` and Electron main `stageforge:dmx-control` `enable` require an active `'armed'` interlock claim) until the [pre-flight safety check](measure.md) has been run for the current rig/patch/look/aim revision, zero hard failures exist (patch conflicts/overflow, rigging overload/uplift, electrical circuit/feeder overload, active laser audience scanning, or hazardous fixtures on USB Serial), every warning is explicitly acknowledged, and every laser projector is individually addressed (acknowledged when assessed & clear, or inhibited to physical DMX `0` with no cue/bump bypass). Starting live output always requires clicking **Arm output**, then confirming **Go live**. If any rig, patch, power, ILDA, DMX-routing, or cue edit makes pre-flight **stale or blocked** (including enabling `audienceScan`) while output is live, StageForge immediately executes paced all-zero blackout, stops live output, clears momentary holds, and requires fresh pre-flight + two-step re-arming. Continuous live monitoring also raises a warning next to the **LIVE** badge if a moving head enters the 3.0 m audience zone during motion.
3. **Always-visible LIVE indicator:** Whenever any live output is active, a fixed top-right **LIVE** badge with a one-click **Blackout & stop** button stays visible—including in Cinema mode (`H`). If output stops automatically due to heartbeat loss, control-loop stall, or WebGL context loss, a persistent stopped notice appears until dismissed or re-armed.
4. **Hard 44 Hz rate ceiling:** Both the UI/config validator and the main-process `hrtime` inter-frame guard refuse to emit faster than 44 Hz (`22.727 ms` minimum spacing). On Windows, default 15.6 ms timer granularity may yield ~32 Hz measured output when targeting 40 Hz; the badge displays measured Hz.
5. **Emergency blackout (`Space`, desk toggle, OSC `/stageforge/blackout`, MSC `ALL_OFF`):**
   - Zeroes lighting master, lasers, blinders, strobes, **CO2 jets, smoke machines, and haze** in both the simulation and DMX buffers, overriding active momentary bumps and audio mappings while preserving programmed atmosphere levels underneath blackout.
   - While live DMX output is enabled, `StageEngine` decouples control/DMX ticks from WebGL rendering and backs `requestAnimationFrame` with a ~33 ms non-rendering fallback timer so blackout, cue changes, and bump releases still propagate even when a window is backgrounded or occluded.
6. **Best-effort blackout on stop, heartbeat loss, context loss, crash, and quit (what each failure does):**
   - **Normal stop / Blackout & stop, WebGL context loss (`webglcontextlost`), control-loop stall (`> 2.5 s`), navigation/reload (`did-start-navigation`), window close/destroy, OS logoff/shutdown (`session-end`, `powerMonitor.shutdown`), system suspend (`powerMonitor.suspend`), app quit (`before-quit`), and renderer crash (`render-process-gone`):** main stops live ticks, clears momentary holds (on UI/context-loss stop), releases any armed claim, sends **3 paced all-zero data ticks** (followed by **3 sACN `Stream_Terminated` (`0x40`) packets** for E1.31), and closes sockets (bounded by a 750 ms shutdown timeout). Restoring a lost WebGL context never auto-resumes DMX; fresh two-step human arming is required.
   - **Frozen or hung renderer / stalled control loop (network sACN / Art-Net 4):** while live, the renderer's 1 Hz watchdog verifies that `StageEngine`'s control loop is actively advancing (`seq` progress, `lastTickMs ≤ 2.5 s`, and context not lost) before sending `stageforge:dmx-heartbeat`. If the control loop stalls (`> 2.5 s`) or 5 s pass without a heartbeat (or Electron fires `unresponsive`), output shuts down with the paced all-zero blackout (+ sACN `Stream_Terminated`) and reports `"Output stopped: control loop stalled"` or `"Output stopped: app stopped responding"`. Re-arming and clicking **Go live** is required to resume.
   - **Electron main-process crash (`SIGKILL` / power loss):** no blackout packet can be sent; receivers fall back to their own signal-loss behaviour (sACN sources time out after 2.5 s; note that some fixtures like the Martin JEM ZR45 can revert to a saved RUN MODE and Look Solutions hazers can enter a purge cycle on DMX loss—sending zeros and stopping DMX does not guarantee continued physical inactivity on all hardware).
   - **Web Serial (Enttec DMX USB Pro):** because the Web Serial transport runs inside the renderer process and an Enttec DMX USB Pro's internal microcontroller retains its last received DMX frame if the window freezes or crashes (`pagehide`/`beforeunload` attempt a best-effort zero frame), StageForge **hard-blocks Web Serial (`outcome: 'fail'`, un-acknowledgeable) in pre-flight and `useLiveDmxOutput` whenever any laser, blinder, strobe, or atmospheric effect (`Martin JEM ZR45`, smoke, haze, CO2) is patched**, and masks `serialPhysicalDmxU1/U2` at the byte level so only passive `ETC ColorSource PAR` LED channels (hardware strobe = `0`) can ever be non-zero over Web Serial. Use desktop network output (`sACN` or `Art-Net 4`) whenever driving blinders or atmospheric effects, and always click **Blackout & stop** before reloading or closing.
   - StageForge does not reply to incoming `ArtPoll` requests in v1 (output-only controller).

## Universe Numbering

- **sACN:** 1-based universes `1..63999` (default SF U1 → `1`, SF U2 → `2`; multicast `239.255.(u >> 8).(u & 0xff)` on UDP `5568`).
- **Art-Net 4:** 0-based 15-bit Port-Address `0..32767` (`SubUni = (SubNet << 4) | Universe`, `Net = PortAddress >> 8`; default SF U1 → `0`, SF U2 → `1` on UDP `6454`). Because some lighting consoles display Art-Net universes starting at 1, the UI displays both the 0-based Port-Address and its `Net · Sub · Uni` breakdown.

## Manual Hardware & Cross-Tool Checklist

Run these checks manually when physical gear or peer software is available:

- [ ] **Local peer — BlenderDMX / QLC+ (sACN unicast on `127.0.0.1`):** Select `127.0.0.1`, sACN Unicast → `127.0.0.1`, universes 1 & 2, Arm → Go live. Confirm fixtures respond to cues, faders, and blackout, and that clicking **Blackout & stop** zeroes fixtures before the source drops.
- [ ] **Local peer — QLC+ / grandMA3 onPC (Art-Net 4):** Select LAN interface, click **Scan** (`ArtPoll`) — verify either the node appears or, if another app owns UDP `6454` on the same PC, the friendly `EADDRINUSE` guidance appears while manual unicast IP entry still sends cleanly.
- [ ] **Physical LAN — sACN multicast (`239.255.0.1` / `239.255.0.2`):** Bind to a real Ethernet NIC with a multicast DMX node (or Wireshark/sACNView on another host). Verify IGMP/multicast delivery, priority arbitration (e.g. 100 vs 120), persistent CID across restarts, and clean stream termination.
- [ ] **Background throttling (Windows & macOS):** Enable live output, trigger an animated look (chase/demo), then minimize the StageForge window and cover it with another window. Confirm DMX channel values keep animating smoothly on the receiving node.
- [ ] **Enttec DMX USB Pro (Web Serial):** Connect a real FTDI Enttec DMX USB Pro in both Chrome and Electron desktop. Confirm the chooser lists the FTDI device first, never auto-connects on launch, drives Universe 1 or 2 smoothly, zeroes the rig on **Blackout & stop**, and surfaces an error cleanly if unplugged mid-show.
