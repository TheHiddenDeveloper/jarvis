---
title: "check-wifi-status"
status: active
created: 2026-08-14
last_verified: 2026-08-14
tags: [engineering, procedures, jarvis, desktop]
---

# check-wifi-status

## Trigger phrases
check the wifi status
check wifi
what's my wifi state
is my wifi connected

## Preconditions
KDE Plasma desktop visible. wifi-icon landmark recorded in Screen/Landmarks.md (pos 97%,1% on 6072x2000). System panel (quick settings) closed.

## Steps
1. **Action:** Recall: memory_read('procedures') for index; grep Landmarks.md for wifi-icon landmark.
   **Expect:** Landmark found: wifi-icon at (97%, 1%)
2. **Action:** Orient: see_screen asking 'Is the KDE system panel currently open?'
   **Expect:** Panel is closed; wifi icon visible in top-right status bar
3. **Action:** Open panel: mouse_move to wifi-icon landmark pixels (97% width, 1% height of screen) then mouse_click left. If landmark fails, fall back to click_on 'the wifi signal icon in the top status bar'.
   **Expect:** System panel opens on the right side
4. **Action:** Read state: see_screen asking 'Did the system panel open? Read the wifi/Internet state and Bluetooth state.'
   **Expect:** Panel shows Internet section with network name (e.g. connected to 'Hannah's Galaxy A...') and Bluetooth state
5. **Action:** Close panel: click the wifi icon again (mouse_move to same landmark pixels + mouse_click).
   **Expect:** System panel closes; only the top status bar remains
6. **Action:** Verify: see_screen asking 'Is the system panel now closed?'
   **Expect:** Panel is closed

## Failure handling
If the landmark click doesn't open the panel, re-locate the wifi icon with click_on (vision) and re-record the landmark with record_landmark. If Gemini quota is exhausted (429/503), retry after ~30s or use the stored landmark coordinates directly.

## Last verified
- 2026-08-14