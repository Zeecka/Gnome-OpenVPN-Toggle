/* prefs.js
 *
 * OpenVPN Toggle – Preferences dialog
 * =====================================
 * Provides a GTK4 widget for configuring:
 *   - The directory containing .ovpn profile files
 *
 * Compatible with GNOME Shell 42–46.
 */

import {ExtensionPreferences} from 'resource:///org/gnome/shell/extensions/prefs.js';

import Gtk    from 'gi://Gtk';
import Gio    from 'gi://Gio';
import GLib   from 'gi://GLib';

export default class OpenVPNPreferences extends ExtensionPreferences {

    /**
     * getPreferencesWidget
     *
     * Returns the root GTK4 widget for the extension preferences page.
     * Called by GNOME Shell when the user opens the preferences dialog.
     */
    getPreferencesWidget() {
        let settings = this.getSettings();

    // ── Root container ────────────────────────────────────────────────────
    let root = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        margin_top: 24,
        margin_bottom: 24,
        margin_start: 24,
        margin_end: 24,
        spacing: 16,
    });

    // ── Section: Profiles directory ───────────────────────────────────────
    root.append(_makeLabel('Profiles Directory', true));
    root.append(_makeLabel(
        'Directory that contains your .ovpn profile files.'));

    let dirBox   = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 8 });
    let dirEntry = new Gtk.Entry({
        text    : settings.get_string('profiles-dir'),
        hexpand : true,
        tooltip_text: 'Absolute path or ~ for the home directory',
    });
    let dirBtn = new Gtk.Button({ label: 'Browse…' });

    dirEntry.connect('changed', () =>
        settings.set_string('profiles-dir', dirEntry.get_text()));

    dirBtn.connect('clicked', () => {
        let dialog = new Gtk.FileChooserDialog({
            title          : 'Select Profiles Directory',
            action         : Gtk.FileChooserAction.SELECT_FOLDER,
            transient_for  : root.get_root(),
            modal          : true,
        });
        dialog.add_button('Cancel', Gtk.ResponseType.CANCEL);
        dialog.add_button('Select', Gtk.ResponseType.ACCEPT);

        // Pre-navigate to current directory if it exists
        let current = dirEntry.get_text().replace(/^~/, GLib.get_home_dir());
        let f = Gio.File.new_for_path(current);
        if (f.query_exists(null))
            dialog.set_current_folder(f);

        dialog.connect('response', (dlg, response) => {
            if (response === Gtk.ResponseType.ACCEPT) {
                let path = dlg.get_file().get_path();
                dirEntry.set_text(path);
                settings.set_string('profiles-dir', path);
            }
            dlg.destroy();
        });
        dialog.show();
    });

    dirBox.append(dirEntry);
    dirBox.append(dirBtn);
    root.append(dirBox);

    return root;
    } // getPreferencesWidget
} // OpenVPNPreferences

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Create a simple Gtk.Label with optional bold styling */
function _makeLabel(text, bold = false) {
    let label = new Gtk.Label({
        label : bold ? `<b>${text}</b>` : text,
        xalign: 0,
        use_markup: bold,
        wrap  : true,
    });
    return label;
}
