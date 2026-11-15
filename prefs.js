import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import { CHECK_INTERVAL_MIN, CHECK_INTERVAL_MAX, CHECK_INTERVAL_STEP, DELAY_AFTER_UNLOCK_MIN, DELAY_AFTER_UNLOCK_MAX, DELAY_AFTER_UNLOCK_STEP } from './constants.js';

export default class WindowPinnerPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        // Create a preferences page
        const page = new Adw.PreferencesPage();

        // Create a preferences group
        const group = new Adw.PreferencesGroup({ title: 'Window Pinner Settings' });

        // Check interval row
        const checkRow = new Adw.ActionRow({ title: 'Check for moved windows every (seconds):' });
        const checkSpin = new Gtk.SpinButton({
            adjustment: new Gtk.Adjustment({
                lower: CHECK_INTERVAL_MIN,
                upper: CHECK_INTERVAL_MAX,
                step_increment: CHECK_INTERVAL_STEP
            })
        });
        checkSpin.set_value(settings.get_int('check-interval'));
        checkSpin.connect('value-changed', () => settings.set_int('check-interval', checkSpin.get_value_as_int()));
        checkRow.add_suffix(checkSpin);
        checkSpin.set_hexpand(false);
        group.add(checkRow);

        // Delay after unlock row
        const delayRow = new Adw.ActionRow({ title: 'Delay after unlock / monitor reconnect before repositioning windows (seconds):' });
        const delaySpin = new Gtk.SpinButton({
            adjustment: new Gtk.Adjustment({
                lower: DELAY_AFTER_UNLOCK_MIN,
                upper: DELAY_AFTER_UNLOCK_MAX,
                step_increment: DELAY_AFTER_UNLOCK_STEP
            })
        });
        delaySpin.set_value(settings.get_int('delay-after-unlock'));
        delaySpin.connect('value-changed', () => settings.set_int('delay-after-unlock', delaySpin.get_value_as_int()));
        delayRow.add_suffix(delaySpin);
        delaySpin.set_hexpand(false);
        group.add(delayRow);

        // Add group to page, and page to window
        page.add(group);
        window.add(page);
    }
} 