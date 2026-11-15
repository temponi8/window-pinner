// Window Pinner Extension for GNOME Shell
// Maintains and restores window positions after screen unlock or monitor reconnect.
// Author: David Harker
// License: MIT
//
// Local patch (GNOME 49/50):
//  - GNOME 49+ maximize()/unmaximize() API (no flags), with fallback for 46-48
//  - Saves and restores maximized state (moved back to the right monitor)
//  - Skips fullscreen windows
//  - Keeps one saved layout per monitor configuration (keyed by monitor
//    geometries), so the layout GNOME produces after a monitor disconnects
//    never overwrites the multi-monitor layout
//  - Restores on unlock AND whenever a monitor (re)connects or the monitor
//    configuration changes without losing a monitor
//  - Recording is paused while a restore is pending, so the scrambled
//    layout is never saved over the good one
//  - Takes a fresh snapshot at disable (i.e. the moment the screen locks)

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Mtk from 'gi://Mtk';
import { CHECK_INTERVAL_MIN, CHECK_INTERVAL_MAX, DELAY_AFTER_UNLOCK_MIN, DELAY_AFTER_UNLOCK_MAX } from './constants.js';

// Fixed settle time (ms) after a monitor change / unlock, added to the
// configurable delay. Monitor changes arriving within this window reset it.
const SETTLE_MS = 500;
// Max number of distinct monitor configurations to remember.
const MAX_LAYOUTS = 8;
const STATE_VERSION = 2;

function isFullyMaximized(win) {
    return win.maximized_horizontally && win.maximized_vertically;
}

function isAnyMaximized(win) {
    return win.maximized_horizontally || win.maximized_vertically;
}

function unmaximizeCompat(win) {
    if (win.unmaximize.length === 0)
        win.unmaximize();                        // GNOME 49+
    else
        win.unmaximize(Meta.MaximizeFlags.BOTH); // GNOME 46-48
}

function maximizeCompat(win) {
    if (win.maximize.length === 0)
        win.maximize();                          // GNOME 49+
    else
        win.maximize(Meta.MaximizeFlags.BOTH);   // GNOME 46-48
}

function monitorCount() {
    return global.display.get_n_monitors();
}

// Identifies the current monitor configuration by the logical geometry of
// every monitor, e.g. "0,0,1536x960|1536,0,1920x1080".
function monitorKey() {
    const parts = [];
    for (let i = 0; i < monitorCount(); i++) {
        const g = global.display.get_monitor_geometry(i);
        parts.push(`${g.x},${g.y},${g.width}x${g.height}`);
    }
    return parts.sort().join('|');
}

export default class WindowPinnerExtension extends Extension {
    constructor(meta) {
        super(meta);
        this._settings = null;
        this._layouts = {};
        this._lockKey = null;
        this._currentKey = null;
        this._currentCount = 0;
        this._restorePending = false;
        this._timerId = null;
        this._restoreTimerId = null;
        this._monitorsChangedId = null;
    }

    enable() {
        this._settings = this.getSettings();
        this._layouts = {};
        this._lockKey = null;
        this._restorePending = false;
        this._loadState();

        this._currentKey = monitorKey();
        this._currentCount = monitorCount();
        this._monitorsChangedId = Main.layoutManager.connect(
            'monitors-changed', () => this._onMonitorsChanged());

        // Unlock: if the monitors are already the same as when we locked,
        // restore now. Otherwise the restore happens when the missing
        // monitor comes back (see _onMonitorsChanged).
        if (this._lockKey && this._lockKey === this._currentKey && this._layouts[this._currentKey])
            this._scheduleRestore('unlock');
        this._lockKey = null;

        this._startMainTimer();
    }

    disable() {
        if (this._monitorsChangedId) {
            Main.layoutManager.disconnect(this._monitorsChangedId);
            this._monitorsChangedId = null;
        }
        if (this._timerId) {
            GLib.source_remove(this._timerId);
            this._timerId = null;
        }

        // Snapshot right now (screen is being locked) unless a restore is
        // pending — then the current layout is the scrambled one and the
        // saved layout must be kept.
        if (!this._restorePending) {
            try {
                this._recordWindowInfo(false);
            } catch (e) {
                console.error(`[window-pinner] Snapshot failed: ${e}`);
            }
        }
        this._cancelRestore();
        this._lockKey = monitorKey();
        this._writeState();
        this._settings = null;
    }

    _startMainTimer() {
        const interval = this._clampSetting(this._settings.get_int('check-interval'));
        console.log(`[window-pinner] Watching for window changes every ${interval} seconds`);
        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, interval, () => {
            try {
                this._recordWindowInfo(true);
            } catch (e) {
                console.error(`[window-pinner] Record failed: ${e}`);
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    _onMonitorsChanged() {
        const newKey = monitorKey();
        const newCount = monitorCount();
        if (newKey === this._currentKey)
            return;

        const lostMonitor = newCount < this._currentCount;
        this._currentKey = newKey;
        this._currentCount = newCount;

        if (lostMonitor) {
            // Let GNOME place the windows; the multi-monitor layout stays
            // saved under its own key for when the monitor comes back.
            this._cancelRestore();
            console.log(`[window-pinner] Monitor disconnected (${newCount} left)`);
            return;
        }
        this._scheduleRestore('monitor change');
    }

    _scheduleRestore(reason) {
        this._cancelRestore();
        this._restorePending = true;
        const delayS = this._clampSetting(this._settings.get_int('delay-after-unlock'), 'delay-after-unlock');
        this._restoreTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SETTLE_MS + delayS * 1000, () => {
            this._restoreTimerId = null;
            this._restorePending = false;
            const layout = this._layouts[monitorKey()];
            if (layout) {
                try {
                    this._restoreWindowLayout(layout, reason);
                } catch (e) {
                    console.error(`[window-pinner] Restore failed: ${e}`);
                }
            } else {
                console.log(`[window-pinner] No saved layout for this monitor setup (${reason})`);
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelRestore() {
        if (this._restoreTimerId) {
            GLib.source_remove(this._restoreTimerId);
            this._restoreTimerId = null;
        }
        this._restorePending = false;
    }

    _restoreWindowLayout(layout, reason) {
        const idMap = new Map();
        for (const actor of global.get_window_actors()) {
            const win = actor.meta_window;
            if (win)
                idMap.set(win.get_id(), win);
        }

        let movedCount = 0;
        for (const saved of layout.windows) {
            const win = idMap.get(saved.id);
            if (!win || saved.fullscreen || win.is_fullscreen())
                continue;

            if (saved.maximized) {
                const target = global.display.get_monitor_index_for_rect(new Mtk.Rectangle({
                    x: saved.x, y: saved.y, width: saved.width, height: saved.height,
                }));
                if (isFullyMaximized(win) && win.get_monitor() === target)
                    continue;
                if (isAnyMaximized(win))
                    unmaximizeCompat(win);
                if (target >= 0)
                    win.move_to_monitor(target);
                maximizeCompat(win);
            } else {
                const r = win.get_frame_rect();
                if (!isAnyMaximized(win) && r.x === saved.x && r.y === saved.y &&
                    r.width === saved.width && r.height === saved.height)
                    continue;
                if (isAnyMaximized(win))
                    unmaximizeCompat(win);
                win.move_resize_frame(false, saved.x, saved.y, saved.width, saved.height);
            }
            movedCount++;
        }
        console.log(`[window-pinner] Moved ${movedCount} windows to original locations (${reason})`);
    }

    _takeSnapshot() {
        const info = {
            timestamp: Date.now(),
            numScreens: monitorCount(),
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
        // Stable order so focus/stacking changes don't count as changes.
        info.windows.sort((a, b) => a.id - b.id);
        return info;
    }

    _windowInfoMateriallyDiffers(a, b) {
        if (!a || !b) return true;
        if (a.windows.length !== b.windows.length) return true;
        for (let i = 0; i < a.windows.length; i++) {
            const wa = a.windows[i], wb = b.windows[i];
            for (const k of ['id', 'x', 'y', 'width', 'height', 'monitor', 'maximized', 'fullscreen']) {
                if (wa[k] !== wb[k]) return true;
            }
        }
        return false;
    }

    _recordWindowInfo(write) {
        if (this._restorePending)
            return;
        const key = monitorKey();
        const info = this._takeSnapshot();
        const prev = this._layouts[key];
        if (prev && !this._windowInfoMateriallyDiffers(info, prev)) {
            prev.timestamp = info.timestamp; // keep LRU order fresh, no write
            return;
        }
        this._layouts[key] = info;
        this._pruneLayouts(key);
        if (write)
            this._writeState();
    }

    _pruneLayouts(keepKey) {
        const keys = Object.keys(this._layouts);
        if (keys.length <= MAX_LAYOUTS)
            return;
        keys.filter(k => k !== keepKey)
            .sort((a, b) => this._layouts[a].timestamp - this._layouts[b].timestamp)
            .slice(0, keys.length - MAX_LAYOUTS)
            .forEach(k => delete this._layouts[k]);
    }

    _loadState() {
        const stateFile = this._getStateFilePath();
        if (!GLib.file_test(stateFile, GLib.FileTest.EXISTS))
            return;
        try {
            const [ok, contents] = GLib.file_get_contents(stateFile);
            if (!ok || !contents)
                return;
            const json = JSON.parse(new TextDecoder('utf-8').decode(contents));
            if (json?.version !== STATE_VERSION || typeof json.layouts !== 'object')
                return; // old format: ignore
            for (const [k, v] of Object.entries(json.layouts)) {
                if (v && Array.isArray(v.windows))
                    this._layouts[k] = v;
            }
            this._lockKey = typeof json.lockKey === 'string' ? json.lockKey : null;
        } catch (e) {
            console.error(`[window-pinner] Failed to read state file: ${e}`);
        }
    }

    _writeState() {
        const state = { version: STATE_VERSION, lockKey: this._lockKey, layouts: this._layouts };
        try {
            GLib.file_set_contents(this._getStateFilePath(), JSON.stringify(state));
        } catch (e) {
            console.error(`[window-pinner] Failed to write window state file: ${e}`);
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
