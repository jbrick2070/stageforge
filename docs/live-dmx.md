# Live DMX Output (Milestone 4)

StageForge outputs its live 2-universe DMX512 desk state (Universes 1 and 2, 512 slots each) over:

- **sACN (ANSI E1.31-2018)** — desktop app (`desktop/dmx-packets.cjs`, `desktop/dmx-sender.cjs`) over Node `dgram` in the Electron main process.
- **Art-Net 4** — desktop app over Node `dgram` in the Electron main process, with `ArtPoll` / `ArtPollReply` node discovery and unicast `ArtDmx` (plus optional directed broadcast).
- **Enttec DMX USB Pro (Web Serial)** — browser (Chromium/Edge) and desktop app (`src/dmx/enttecPro.ts`), single universe (choose SF U1 or U2).

## Architecture & Security

- **Main-process frame loop:** UDP sockets and the rate-capped refresh timer live in Electron's main process so network DMX remains immune to renderer throttling. While output is active, main temporarily disables Chromium background throttling on the owning window (`setBackgroundThrottling(false)`) and restores it when output stops.
- **Explicit interface binding:** Output always binds to a specific IPv4 address returned by a fresh `os.networkInterfaces()` scan (including `127.0.0.1` for local visualizers). sACN multicast sets both multicast TTL and `setMulticastInterface(iface)`. Note that on Windows, weak-host routing may still route out-of-subnet unicast targets via the OS default route; keep unicast lighting nodes on the selected NIC's subnet.
- **Validated IPC:**
  - Universe buffers cross a single fire-and-forget IPC channel (`stageforge:dmx-frame`). Main verifies `event.senderFrame === event.sender.mainFrame`, `isAppPage(url)`, owning window ID, active running state, `universe ∈ {1, 2}`, and exact `Uint8Array(512)` byte length, then copies into main-owned buffers.
  - Control commands cross `stageforge:dmx-control` (`listInterfaces`, `getStatus`, `enable`, `disable`, `discover`) with strict schema/key validation, window-ownership enforcement, and no unknown keys allowed.
  - Web Serial in Electron requires an explicit native `select-serial-port` chooser (never auto-selected) and stores device grants only in memory for the current session.

## Safety Model

1. **Off by default:** StageForge never auto-enables DMX output on launch. Transport configuration (interface, universes, targets) is remembered in `localStorage`, but the enabled/live state is never persisted.
2. **Two-step arming:** Starting live output requires clicking **Arm output**, then confirming **Go live**.
3. **Always-visible LIVE indicator:** Whenever any live output is active, a fixed top-right **LIVE** badge with a one-click **Blackout & stop** button stays visible—including in Cinema mode (`H`).
4. **Hard 44 Hz rate ceiling:** Both the UI/config validator and the main-process `hrtime` inter-frame guard refuse to emit faster than 44 Hz (`22.727 ms` minimum spacing). On Windows, default 15.6 ms timer granularity may yield ~32 Hz measured output when targeting 40 Hz; the badge displays measured Hz.
5. **Guaranteed blackout on stop/crash/quit:**
   - Triggered by **Blackout & stop**, renderer crash (`render-process-gone`), main-frame navigation/reload (`did-start-navigation`), window close/destroy, OS logoff/shutdown (`session-end`, `powerMonitor.shutdown`), system suspend (`powerMonitor.suspend`), and app quit (`before-quit`).
   - Order for **sACN**: sends **3 paced all-zero data ticks first**, then **3 `Stream_Terminated` (`0x40`) packets**, then closes sockets (capped by a 750 ms shutdown timeout). Sending zeros before termination ensures nodes that ignore data in terminate packets or hold-last-look on stream loss actually black out.
   - Order for **Art-Net 4**: sends **3 paced all-zero `ArtDmx` ticks**, then closes sockets.
   - **Deliberate limitations:**
     - If the renderer becomes temporarily `unresponsive` (without crashing), main keeps sending the last frame like a hardware console holding its look.
     - If the Electron **main process itself** crashes (e.g. `SIGKILL`), no blackout packet can be sent; receivers fall back to their configured data-loss behaviour (sACN sources time out after 2.5 s).
     - For **Web Serial (Enttec USB Pro)**, the transport lives in the renderer so the widget holds the last frame if the window reloads (F5), closes abruptly, or crashes (`pagehide` performs a best-effort zero frame). Always click **Blackout & stop** before reloading or closing when driving USB DMX.
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
