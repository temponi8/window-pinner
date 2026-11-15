# Window Pinner (GNOME 49/50 patched fork)

> Personal fork of [dhharker/window-pinner](https://github.com/dhharker/window-pinner) (MIT, © 2025 David Harker), patched to run on GNOME Shell 49 and 50.

## Changes in this fork (v6)

- **GNOME 49/50 support**: uses the new `maximize()` / `unmaximize()` API (no flags), with a fallback for GNOME 46–48.
- **Maximized windows**: saves maximized state and monitor; on restore, moves the window back to its monitor and re-maximizes it. (Originally, maximized windows stayed on the wrong monitor.)
- **Fullscreen windows** are left alone.
- **Fresh snapshot on lock**: the layout is captured the moment the extension is disabled (screen lock), not up to `check-interval` seconds earlier.
- **Restore on monitor reconnect** (v6): one layout is saved per monitor configuration (keyed by monitor geometries). When a monitor connects again — after unplugging, or after it wakes up later than the unlock — the saved layout for that setup is restored. When a monitor disconnects, GNOME places the windows as usual and the multi-monitor layout stays saved. Recording pauses while a restore is pending so a scrambled layout is never saved over a good one.
- Removed unused imports; error handling around state file read/write.
- **Default `delay-after-unlock` is 0 s** (was 3 s): windows are restored 0.5 s after the monitor setup settles.

Install: copy this directory to `~/.local/share/gnome-shell/extensions/window-pinner@dhharker.net/`, log out and back in, then `gnome-extensions enable window-pinner@dhharker.net`.

---

## Original README


A GNOME Shell extension to remember window positions and restore them on unlock.

You don't need this unless you have a multi-monitor setup (also I think only wayland affected) where your windows get moved around after monitor wake from screen lock.

This seems possibly something to do with windows getting moved around as monitors wake up one by one at different speeds, but I'm not sure the exact cause. There are several bugs open in different places describing this effect. Anyway it was annoying me so I vibe coded this in an evening using Cursor to fix the problem.

## Reporting Bugs

I have never written a GNOME Shell extension before literally yesterday and am not at all familiar with how to do it well. Also a bunch of generative AIs collaborated (badly) to write most of this, so there *are* probably bugs. If you find one please open an issue https://github.com/dhharker/window-pinner/issues or show me how it's done and make a PR.

## Manual Installation

1. Find the latest release at https://github.com/dhharker/window-pinner/tree/master/dist-zip 
2. Extract the zip file in `~/.local/share/gnome-shell/extensions/window-pinner@dhharker.net/`
3. Restart GNOME (on Wayland that means logging out and in again, in X11 you can probably Alt+F2 and run `r`)
4. Enable the extension using GNOME Extensions app or `gnome-extensions enable window-pinner@dhharker.net`

## Notes

After writing this I found https://extensions.gnome.org/extension/5353/window-state-manager/ which sets out to do the same thing. I guess that takes a different approach because it runs when the screen is locked whereas window-pinner does not.

This extension does not run when the screen is locked. It periodically saves the position of windows. When enabled (on screen unlock) it restores window positions - if it has any stored - after a configurable delay and once the previous number of monitors are detected. Windows are matched to their previous x,y,w,h by window id. Window positions are written to disk only when they change.

### Window Pinner isn't a very good name for this

I know, sorry, I wasn't really thinking about releasing this when I inited it. I mostly just wanted to see if Cursor could vibe code this thing for myself but then I discovered that actually it'd be pretty useful as window-state-manager is apparently broken in recent gnome shell versions so... here it is.