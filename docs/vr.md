# Immersive VR audience preview

StageForge includes an experimental, browser-only WebXR audience preview. It is a device-local opt-in, is **off by default**, and is not saved in show files, rig files, bundles, exports, or the desktop app. Nothing in this page is evidence of real-headset comfort, performance, legibility, or laser safety.

## Enter VR

1. Open **Display → Immersive VR audience preview (experimental)**. The setting is stored only in this browser under `stageforge.render.v1`.
2. Use a secure page:
   - **Standalone Meta Quest:** open the [StageForge HTTPS site](https://jbrick2070.github.io/stageforge/) in Meta Quest Browser.
   - **PC-linked headset:** connect the headset through its PC link/runtime, then open the same HTTPS URL in a Chromium browser that exposes WebXR `immersive-vr` for that headset.
3. StageForge shows **Enter VR** only when `navigator.xr.isSessionSupported('immersive-vr')` succeeds. Browser and headset support changes, so this runtime check—not a browser name or user-agent string—is authoritative.
4. Select **Enter VR**, read the flashing-light, moving-beam, motion-sickness, and simulated-laser warning, then select **I understand — enter VR**. The immersive session request is made from that confirmation action and requires `local-floor`.

WebXR requires a secure context for a hosted page; localhost is the development exception. Meta documents hosted immersive pages in [Meta's VR browser overview](https://developers.meta.com/vr/documentation/web/) and recommends runtime feature detection in [Browser specifications](https://developers.meta.com/vr/documentation/web/browser-specs/). The Electron editions deliberately hide the VR opt-in and entry button.

The acknowledgement lasts for the current page load only. Reloading restores the first-entry warning. The opt-in remains off on another device or browser profile and stays off by default until StageForge has real-headset evidence and a separate promotion decision.

## Controllers and menu

Both tracked controllers have a four-metre pointer ray and a reticle over selectable menu controls. Aim at a highlighted control, then use either input below. One press edge activates at most one control; holding or repeating a start event does not repeat it.

| Controller input | StageForge action |
| --- | --- |
| Primary select / trigger (`select`) | Activate the highlighted menu control |
| Squeeze / grip (`squeeze`) | Activate the highlighted menu control |
| Thumbsticks and free movement | No smooth locomotion; not mapped |

The in-scene menu contains only preview actions:

| Menu controls | Action |
| --- | --- |
| Stage front, Floor, Mezzanine, Balcony, FOH | Blink-teleport to the selected audience viewpoint; FOH reuses StageForge's authored FOH framing |
| Seated 1.2 m / Standing 1.6 m | Set eye height above the selected viewpoint floor, then blink-teleport |
| Snap −30° / +30° | Turn in 30-degree steps, with the same blink transition |
| Reset view | Clear the snap-turn offset and blink back to the selected viewpoint |
| Vignette | Toggle the optional view vignette |
| Cue Back / Cue Go | Operate the existing preview cue stack |
| Haze − / + | Change preview haze in 10% steps |
| Demo Play / Pause; Mute / Unmute | Control the bundled demo preview |
| Preview limit / full-rate preview | Show limiter state; disabling the limiter requires two deliberate selections after the entry warning |
| Standalone Low / PC Link High | Save the profile for the **next VR entry**; it does not rebuild the current session |
| Exit VR | Ask the browser to end the immersive session |

The menu cannot arm physical output, acknowledge real-world pre-flight items, open files, or enable the AI bridge. Mezzanine and balcony can be labelled virtual preview elevations when the venue has no authored tier.

## Comfort and quality controls

- Movement is viewpoint teleport only, with a 0.12-second fade-to-black/fade-in blink. There is no default smooth locomotion.
- Snap turning is 30 degrees. The vignette is optional and off until selected.
- **Standalone Low** uses framebuffer scale `0.75` and foveation `0.65`; **PC Link High** uses scale `1.0` and foveation `0.25`. The choice is stored device-locally as `stageforge.webxr.profile.v1` and applies on the next entry.
- `OculusBrowser` selects Standalone Low as an initial heuristic; other user agents select PC Link High. This heuristic does not establish compatibility: the WebXR feature check and StageForge's detected renderer tier remain authoritative, including scenery, particle, and laser caps.
- Sprint 23 optional looks are suppressed in VR until headset evidence exists. The XR path renders directly without the desktop bloom composer.

## Flash, laser, pre-flight, and physical-output interlocks

- Before the first immersive request in each page load, StageForge warns about flashing lights, moving beams, photosensitivity, motion sickness, and stopping if unwell.
- Entry forces the preview flash limiter on. StageForge source events are capped at no more than three flashes per second. Uploaded video, animated ILDA clips, and camera motion are outside that source-event limiter. Full-rate preview requires two menu selections, clears on exit or headset hiding, and cannot be enabled while the device requests reduced motion.
- Beams and laser ribbons fade near each eye from 1.0 m and are gone by 0.3 m. This reduces preview white-out; it is not a laser-safety calculation or certification.
- The warning and menu state that lasers are simulated visualization only and require real pre-flight/LSO review. The menu displays the existing pre-flight badge, but cannot acknowledge or bypass it.
- VR entry is blocked while physical DMX output is armed or live. Physical output cannot be armed while an XR chooser, session, teardown, or unresolved late browser session owns the page-level interlock. A rejected `session.end()` remains fail-closed until the browser supplies an authoritative `end` event or the page is reloaded after leaving VR.

## Evidence boundary

The automated acceptance uses a scoped WebXR emulator that drives Three.js r187's real `WebXRManager`/`XRWebGLLayer` path. It covers capability detection, warning and output-gate order, `local-floor`, two-eye rendering, reference-space and late-session failures, normal/system/rejected exit, React unmount/remount, ten entry/exit cycles, controller selection, every menu workflow, visibility hiding, resource/listener/loop restoration, and unchanged non-VR tests.

The Arena Rock emulator sample measured **262 draw calls, 745,712 triangles, 25 renderer textures, and one VR-owned menu texture**, within the conservative emulator caps of 270 / 760,000 / 26 / 1. Those are software-emulator counts, not headset frame-time, comfort, thermal, battery, legibility, or safety measurements.

No real headset has been tested. Sprint 22 can finish with emulator acceptance while the renderer flag remains default-off. Promotion requires both the completed real-headset checklist below and a distinct owner decision; completing the checklist does not promote the flag automatically.

## Owner on-headset checklist

Record headset model, OS/browser version, connection mode (standalone or PC link), selected quality, exact StageForge revision, and venue before starting.

1. **Initial scale:** Enter at Audience Floor / Standing and record whether the stage, people, fixtures, deck height, and one-metre scene scale feel physically plausible; note any immediate stereo mismatch.
2. **First warning:** On a fresh page load, confirm the photosensitivity/motion-sickness and simulated-laser warning appears before the headset permission/session request, and that cancel leaves the desk unchanged.
3. **Every seat and posture:** Visit Stage Front, Floor, Mezzanine, Balcony, and FOH in both Standing (1.6 m) and Seated (1.2 m). Record scale, clipping, floor height, sightline, and whether virtual-tier labels are honest for this venue.
4. **Reach:** From every seat/posture combination, confirm the menu is comfortably reachable with each controller without leaning, twisting, or crossing the guardian boundary.
5. **Menu legibility:** Read the cue/haze/demo status, pre-flight badge, laser note, quality state, limiter state, and every button at normal posture; record blur, eye strain, overlap, or clipped text.
6. **Controller mappings:** With left and right controllers, verify the ray/reticle, primary trigger/select, and squeeze/grip each activate exactly one highlighted item per press and never repeat while held.
7. **Teleport and comfort:** Exercise every seat teleport, Reset, repeated ±30-degree snap turns, and vignette off/on. Confirm the blink fully covers movement and record nausea, disorientation, unexpected smooth movement, or controller drift.
8. **Ten-minute use:** Run a representative cue/demo sequence for at least ten continuous minutes. Record comfort symptoms, heat, battery change, tracking loss, browser warnings, crashes, and whether optional work pauses when the system menu hides the session.
9. **Stereo rendering and performance:** Inspect near and far beams, laser ribbons, LED walls, smoke/CO2, crowd, deck, and scenery in both eyes while turning the head. Record per-eye mismatch, shimmer, near-eye white-out, judder, dropped-frame feel, and measured browser/headset performance telemetry if available—do not substitute emulator counts.
10. **Laser note and pre-flight:** Confirm the simulated-visualization/LSO note and current pre-flight label remain visible and cannot arm or acknowledge real output. Verify beams/ribbons fade before crossing the face without treating that as real laser-safety evidence.
11. **Exit and re-entry:** Exit from the menu and the headset system UI, then re-enter at least ten times. Confirm one render loop, restored desktop camera/controls/size, no stale controller rays/menu, limiter reset, and physical output remains blocked until each session authoritatively ends.
12. **Demo sync:** Play, pause, mute/unmute, Cue Go/Back, and run the full bundled demo. Compare visible hits, breakdown, finale, audio, and left/right-eye timing; record drift or actions that fire twice.

