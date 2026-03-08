/* prefs.js
 *
 * OpenVPN Toggle – Preferences dialog
 * =====================================
 * Provides a GTK4 widget for configuring:
 *   - The directory containing .ovpn profile files
 *
 * Compatible with GNOME Shell 42–46.
 */

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import Gtk    from 'gi://Gtk';
import Gio    from 'gi://Gio';
import GLib   from 'gi://GLib';

const CONFIG_TYPE_OPTIONS = ['static', 'prompt'];

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

    // ── Section: Debug logging ────────────────────────────────────────────
    root.append(_makeLabel('Debug Logging', true));
    root.append(_makeLabel(
        'When enabled, profile.ovpn.log files are written next to .ovpn files '
        + 'and include expect/spawn output plus extension errors.'));

    let debugBox = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 8,
    });
    let debugLabel = new Gtk.Label({
        label: 'Enable debug logs',
        xalign: 0,
        hexpand: true,
    });
    let debugSwitch = new Gtk.Switch({
        active: settings.get_boolean('debug-enabled'),
        halign: Gtk.Align.END,
        valign: Gtk.Align.CENTER,
    });
    debugSwitch.connect('notify::active', sw =>
        settings.set_boolean('debug-enabled', sw.get_active()));
    debugBox.append(debugLabel);
    debugBox.append(debugSwitch);
    root.append(debugBox);

    // ── Section: Interactive inputs configuration (GUI only) ─────────────
    root.append(_makeLabel('Interactive Inputs', true));
    root.append(_makeLabel(
        'Configure expected prompts per VPN profile using the form below. '
        + 'Direct RAW JSON editing is disabled.'));

    let statusLabel = _makeLabel('');
    let interactiveRaw = settings.get_string('interactive-config');
    let parsedConfig = [];
    try {
        parsedConfig = JSON.parse(interactiveRaw || '[]');
        _validateInteractiveConfig(parsedConfig);
    } catch (e) {
        parsedConfig = [];
        statusLabel.set_text(`Invalid existing config ignored: ${e.message}`);
    }

    let profilePaths = _listOvpnProfiles(settings.get_string('profiles-dir'));
    let configContainer = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 8,
    });

    let uiState = {
        rowsByProfile: new Map(),
        legacyEntries: _collectLegacyEntries(parsedConfig, profilePaths),
    };

    for (let profilePath of profilePaths) {
        let existingEntry = _findProfileConfigEntry(parsedConfig, profilePath);
        let rows = _normalizeInputs(existingEntry ? existingEntry.inputs : []);
        uiState.rowsByProfile.set(profilePath, rows);

        let section = _buildProfileConfigSection(profilePath, rows,
            nextRows => {
                uiState.rowsByProfile.set(profilePath, nextRows);
                _saveGuiConfig(settings, uiState, statusLabel);
            });
        configContainer.append(section);
    }

    if (profilePaths.length === 0)
        configContainer.append(_makeLabel('No .ovpn profile found in Profiles Directory.'));

    root.append(configContainer);
    root.append(statusLabel);

    _saveGuiConfig(settings, uiState, statusLabel, false);

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

function _validateInteractiveConfig(config) {
    if (!Array.isArray(config))
        throw new Error('Root value must be an array');

    for (let i = 0; i < config.length; i++) {
        let profile = config[i];
        if (!profile || typeof profile !== 'object')
            throw new Error(`Entry ${i} must be an object`);
        if (typeof profile.vpn !== 'string' || profile.vpn.trim() === '')
            throw new Error(`Entry ${i}.vpn must be a non-empty string`);
        if (!Array.isArray(profile.inputs))
            throw new Error(`Entry ${i}.inputs must be an array`);

        for (let j = 0; j < profile.inputs.length; j++) {
            let input = profile.inputs[j];
            if (!input || typeof input !== 'object')
                throw new Error(`Entry ${i}.inputs[${j}] must be an object`);
            if (typeof input.input !== 'string' || input.input.length === 0)
                throw new Error(`Entry ${i}.inputs[${j}].input must be a non-empty string`);
            if (input.type !== 'static' && input.type !== 'prompt')
                throw new Error(`Entry ${i}.inputs[${j}].type must be static or prompt`);
            if (typeof input.value !== 'string')
                throw new Error(`Entry ${i}.inputs[${j}].value must be a string`);
        }
    }
}

function _listOvpnProfiles(rawDir) {
    let profilesDir = _expandPath(rawDir || '');
    if (!profilesDir)
        return [];

    let dir = Gio.File.new_for_path(profilesDir);
    if (!dir.query_exists(null))
        return [];

    let found = [];
    try {
        let en = dir.enumerate_children(
            'standard::name,standard::type',
            Gio.FileQueryInfoFlags.NONE,
            null);
        let info;
        while ((info = en.next_file(null)) !== null) {
            let name = info.get_name();
            if (info.get_file_type() === Gio.FileType.REGULAR &&
                name.endsWith('.ovpn')) {
                found.push(GLib.build_filenamev([profilesDir, name]));
            }
        }
        en.close(null);
    } catch (_e) {
        return [];
    }

    found.sort((a, b) => a.localeCompare(b));
    return found;
}

function _expandPath(p) {
    if (!p)
        return '';
    if (p.startsWith('~'))
        return GLib.get_home_dir() + p.slice(1);
    return p;
}

function _findProfileConfigEntry(config, profilePath) {
    if (!Array.isArray(config))
        return null;

    let baseName = GLib.path_get_basename(profilePath);
    let bareName = baseName.replace(/\.ovpn$/, '');

    return config.find(entry => {
        if (!entry || typeof entry !== 'object' || typeof entry.vpn !== 'string')
            return false;
        return entry.vpn === profilePath ||
               entry.vpn === baseName ||
               entry.vpn === bareName;
    }) || null;
}

function _normalizeInputs(inputs) {
    if (!Array.isArray(inputs))
        return [];

    let normalized = [];
    for (let input of inputs) {
        if (!input || typeof input !== 'object')
            continue;
        if (typeof input.input !== 'string' || input.input.length === 0)
            continue;
        if (input.type !== 'static' && input.type !== 'prompt')
            continue;
        if (typeof input.value !== 'string')
            continue;

        normalized.push({
            input: input.input,
            type: input.type,
            value: input.value,
        });
    }
    return normalized;
}

function _buildProfileConfigSection(profilePath, initialRows, onRowsChanged) {
    let frame = new Gtk.Frame({ hexpand: true });
    let section = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 8,
        margin_top: 8,
        margin_bottom: 8,
        margin_start: 8,
        margin_end: 8,
    });
    frame.set_child(section);

    let profileName = GLib.path_get_basename(profilePath).replace(/\.ovpn$/, '');
    section.append(_makeLabel(profileName, true));
    section.append(_makeLabel(profilePath));

    let rowsBox = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 6,
    });
    section.append(rowsBox);

    let rows = [...initialRows];

    let renderRows = () => {
        while (rowsBox.get_first_child())
            rowsBox.remove(rowsBox.get_first_child());

        if (rows.length === 0)
            rowsBox.append(_makeLabel('⚠️\ No interactive input configured for this profile.'));

        for (let i = 0; i < rows.length; i++) {
            let rowData = rows[i];
            let row = new Gtk.Box({
                orientation: Gtk.Orientation.HORIZONTAL,
                spacing: 8,
            });

            let inputEntry = new Gtk.Entry({
                hexpand: true,
                placeholder_text: 'Expected prompt text',
                text: rowData.input,
            });
            inputEntry.connect('changed', () => {
                rows[i].input = inputEntry.get_text();
                onRowsChanged(_normalizeInputs(rows));
            });

            let typeCombo = new Gtk.ComboBoxText();
            for (let type of CONFIG_TYPE_OPTIONS)
                typeCombo.append_text(type);
            typeCombo.set_active(CONFIG_TYPE_OPTIONS.indexOf(rowData.type));
            typeCombo.connect('changed', () => {
                rows[i].type = typeCombo.get_active_text();
                onRowsChanged(_normalizeInputs(rows));
            });

            let valueEntry = new Gtk.Entry({
                hexpand: true,
                placeholder_text: 'Value or prompt label',
                text: rowData.value,
            });
            valueEntry.connect('changed', () => {
                rows[i].value = valueEntry.get_text();
                onRowsChanged(_normalizeInputs(rows));
            });

            let removeBtn = new Gtk.Button({ label: 'Remove' });
            removeBtn.connect('clicked', () => {
                rows.splice(i, 1);
                onRowsChanged(_normalizeInputs(rows));
                renderRows();
            });

            row.append(inputEntry);
            row.append(typeCombo);
            row.append(valueEntry);
            row.append(removeBtn);
            rowsBox.append(row);
        }
    };

    let addBtn = new Gtk.Button({ label: 'Add input' });
    addBtn.connect('clicked', () => {
        rows.push({ input: '', type: 'prompt', value: '' });
        renderRows();
        onRowsChanged(_normalizeInputs(rows));
    });

    section.append(addBtn);
    renderRows();
    return frame;
}

function _collectLegacyEntries(config, profilePaths) {
    if (!Array.isArray(config))
        return [];

    let profileNames = new Set(profilePaths.map(p => GLib.path_get_basename(p)));
    let profileBareNames = new Set(profilePaths.map(
        p => GLib.path_get_basename(p).replace(/\.ovpn$/, '')));
    let profilePathSet = new Set(profilePaths);

    return config.filter(entry => {
        if (!entry || typeof entry !== 'object' || typeof entry.vpn !== 'string')
            return false;

        return !profilePathSet.has(entry.vpn) &&
               !profileNames.has(entry.vpn) &&
               !profileBareNames.has(entry.vpn);
    }).map(entry => ({
        vpn: entry.vpn,
        inputs: _normalizeInputs(entry.inputs),
    })).filter(entry => entry.inputs.length > 0);
}

function _saveGuiConfig(settings, uiState, statusLabel, showStatus = true) {
    let config = [];

    for (let [profilePath, rows] of uiState.rowsByProfile.entries()) {
        let inputs = _normalizeInputs(rows);
        if (inputs.length === 0)
            continue;

        config.push({
            vpn: profilePath,
            inputs,
        });
    }

    for (let entry of uiState.legacyEntries)
        config.push(entry);

    try {
        _validateInteractiveConfig(config);
        settings.set_string('interactive-config', JSON.stringify(config, null, 2));
        if (showStatus)
            statusLabel.set_text('Saved.');
    } catch (e) {
        if (showStatus)
            statusLabel.set_text(`Invalid entry: ${e.message}`);
    }
}
