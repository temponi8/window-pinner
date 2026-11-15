// Window Pinner Extension for GNOME Shell
// Maintains and restores window positions after screen unlock or session restart.
// Author: David Harker
// License: MIT
//
// Local patch (GNOME 49/50):
//  - GNOME 49+ maximize()/unmaximize() API (no flags), with fallback for 46-48
//  - Saves and restores maximized state and monitor (previously maximized
//    windows stayed stuck on the wrong monitor)
//  - Skips fullscreen windows
//  - Takes a fresh snapshot at disable (i.e. the moment the screen locks)
//  - Gives up waiting for the monitor count after a timeout instead of
//    never resuming tracking
//  - Removed unused imports

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import { CHECK_INTERVAL_MIN, CHECK_INTERVAL_MAX, DELAY_AFTER_UNLOCK_MIN, DELAY_AFTER_UNLOCK_MAX } from './constants.js';

// Max seconds to wait for the monitor count to match after unlock.
const MONITOR_WAIT_TIMEOUT = 120;

function isFullyMaximized(win) {
    return win.maximized_horizontally && win.maximized_vertically;
}

function isAnyMaximized(win) {
    return win.maximized_horizontally || win.maximized_vertically;
}

function unmaximizeCompat(win) {
    if (win.unmaximize.length === 0)
        win.unmaximize();                       // GNOME 49+
    else
        win.unmaximize(Meta.MaximizeFlags.BOTH); // GNOME 46-48
}

function maximizeCompat(win) {
    if (win.maximize.length === 0)
        win.maximize();                         // GNOME 49+
    else
        win.maximize(Meta.MaximizeFlags.BOTH);  // GNOME 46-48
}

export default class WindowPinnerExtension extends Extension {
    constructor(meta) {
        super(meta);
        this._settings = null;
        this._lastSnapshot = null;
        this._cachedState = null;
        this.previousWindowLayout = null;
        this._timerId = null;
        this._monitorPollId = null;
        this._restoreDelayTimerId = null;
        this._restoredOrAbandoned = false;
    }

    enable() {
        this._settings = this.getSettings();
        this._lastSnapshot = null;
        this._cachedState = null;
        this.previousWindowLayout = null;
        this._restoredOrAbandoned = false;

        const stateFile = this._getStateFilePath();
        if (GLib.file_test(stateFile, GLib.FileTest.EXISTS)) {
            try {
                const [ok, contents] = GLib.file_get_contents(stateFile);
                if (ok && contents) {
                    const json = JSON.parse(new TextDecoder('utf-8').decode(contents));
                    if (json && Array.isArray(json.windows)) {
                        this._cachedState = this.previousWindowLayout = json;
                        this._lastSnapshot = json;
                        this._waitForMonitorMatch();
                        return;
                    }
                }
            } catch (e) {
                console.error(`[window-pinner] Failed to read state file: ${e}`);
            }
        }
        this._startMainTimer();
    }

    disable() {
        this._clearTimers();

        // Snapshot right now (screen is being locked) unless we are still
        // waiting to restore — in that case the current layout is the
        // scrambled one and the previous layout must be kept.
        let toSave = this._lastSnapshot;
        if (!this.previousWindowLayout || this._restoredOrAbandoned) {
            try {
                toSave = this._takeSnapshot();
            } catch (e) {
                console.error(`[window-pinner] Snapshot failed: ${e}`);
            }
        }
        if (toSave)
            this._writeState(toSave);

        this._restoredOrAbandoned = false;
        this._settings = null;
    }

    _clearTimers() {
        for (const key of ['_timerId', '_monitorPollId', '_restoreDelayTimerId']) {
            if (this[key]) {
                GLib.source_remove(this[key]);
                this[key] = null;
            }
        }
    }

    _startMainTimer() {
        if (this._timerId) {
            GLib.source_remove(this._timerId);
            this._timerId = null;
        }
        this._restoredOrAbandoned = true;
        const interval = this._clampSetting(this._settings.get_int('check-interval'));
        console.log(`[window-pinner] Watching for window changes every ${interval} seconds`);
        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, interval, () => {
            this._recordWindowInfo();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _waitForMonitorMatch() {
        if (this._monitorPollId) {
            GLib.source_remove(this._monitorPollId);
            this._monitorPollId = null;
        }
        const expectedMonitors = this.previousWindowLayout.numScreens;
        let waited = 0;
        this._monitorPollId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            waited++;
            const currentMonitors = global.display.get_n_monitors();
            if (currentMonitors === expectedMonitors) {
                this._monitorPollId = null;
                const unlockDelay = this._clampSetting(
                    this._settings.get_int('delay-after-unlock'), 'delay-after-unlock');
                this._restoreDelayTimerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, unlockDelay, () => {
                    this._restoreDelayTimerId = null;
                    try {
                        this._restoreWindowLayout();
                    } catch (e) {
                        console.error(`[window-pinner] Restore failed: ${e}`);
                    }
                    this._startMainTimer();
                    return GLib.SOURCE_REMOVE;
                });
                return GLib.SOURCE_REMOVE;
            }
            if (waited >= MONITOR_WAIT_TIMEOUT) {
                console.log(`[window-pinner] Monitor count stayed at ${currentMonitors} (expected ${expectedMonitors}); giving up restore`);
                this._monitorPollId = null;
                this._startMainTimer();
                return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    _restoreWindowLayout() {
        const layout = this.previousWindowLayout;
        if (!layout || !Array.isArray(layout.windows))
            return;

        const idMap = new Map();
        for (const actor of global.get_window_actors()) {
            const win = actor.meta_window;
            if (win)
                idMap.set(win.get_id(), win);
        }

        const nMonitors = global.display.get_n_monitors();
        let movedCount = 0;
        for (const saved of layout.windows) {
            const win = idMap.get(saved.id);
            if (!win || saved.fullscreen || win.is_fullscreen())
                continue;

            if (isAnyMaximized(win))
                unmaximizeCompat(win);

            if (saved.maximized) {
                if (typeof saved.monitor === 'number' && saved.monitor < nMonitors)
                    win.move_to_monitor(saved.monitor);
                maximizeCompat(win);
            } else {
                win.move_resize_frame(false, saved.x, saved.y, saved.width, saved.height);
            }
            movedCount++;
        }
        console.log(`[window-pinner] Moved ${movedCount} windows to original locations`);
    }

    _takeSnapshot() {
        const info = {
            timestamp: Date.now(),
            numScreens: global.display.get_n_monitors(),
            windows: [],
        };
        for (const actor of global.get_window_actors()) {
            const win = actor.meta_window;
            if (!win || win.is_override_redirect())
                continue;
            const rect = win.get_frame_rect();
            info.windows.push({
                id: win.get_id(),
                x: rect.x,
                y: rect.y,
                width: rect.width,
                height: rect.height,
                monitor: win.get_monitor(),
                maximized: isFullyMaximized(win),
                fullscreen: win.is_fullscreen(),
            });
        }
        return info;
    }

    _windowInfoMateriallyDiffers(a, b) {
        if (!a || !b) return true;
        if (a.numScreens !== b.numScreens) return true;
        if (!Array.isArray(a.windows) || !Array.isArray(b.windows)) return true;
        if (a.windows.length !== b.windows.length) return true;
        for (let i = 0; i < a.windows.length; i++) {
            const wa = a.windows[i], wb = b.windows[i];
            if (!wa || !wb) return true;
            for (const k of ['id', 'x', 'y', 'width', 'height', 'monitor', 'maximized', 'fullscreen']) {
                if (wa[k] !== wb[k]) return true;
            }
        }
        return false;
    }

    _recordWindowInfo() {
        const info = this._takeSnapshot();
        this._lastSnapshot = info;
        if (this._windowInfoMateriallyDiffers(info, this._cachedState)) {
            if (this._writeState(info))
                this._cachedState = info;
        }
    }

    _writeState(info) {
        try {
            GLib.file_set_contents(this._getStateFilePath(), JSON.stringify(info));
            return true;
        } catch (e) {
            console.error(`[window-pinner] Failed to write window state file: ${e}`);
            return false;
        }
    }

    _getStateFilePath() {
        return `${GLib.get_user_runtime_dir()}/window-pinner-state.json`;
    }

    _clampSetting(val, type = 'check-interval') {
        if (type === 'delay-after-unlock')
            return Math.max(DELAY_AFTER_UNLOCK_MIN, Math.min(val, DELAY_AFTER_UNLOCK_MAX));
        return Math.max(CHECK_INTERVAL_MIN, Math.min(val, CHECK_INTERVAL_MAX));
    }
}
