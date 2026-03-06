/* extension.js
 *
 * OpenVPN Toggle – GNOME Shell Extension
 * =======================================
 * Manages multiple OpenVPN profiles directly from the GNOME top panel.
 * Does NOT rely on NetworkManager; it manages OpenVPN CLI processes
 * directly using GLib/Gio subprocess APIs.
 *
 * Supports GNOME Shell 43 and 44 (traditional imports, not ESM).
 *
 * Architecture overview
 * ---------------------
 *  - OpenVpnIndicator  : PanelMenu.Button that owns the dropdown menu and
 *                        all OpenVPN process state.
 *  - VpnProfileMenuItem: A custom PopupBaseMenuItem showing name, status
 *                        label, and toggle switch for one .ovpn profile.
 *
 * How OpenVPN is started
 * ----------------------
 * When the user toggles a profile ON the extension runs:
 *
 *   expect <extdir>/scripts/askpin.exp  <ovpn_file>  <pkcs11_provider>
 *
 * with the environment variable SUDO_ASKPASS pointing to:
 *
 *   <extdir>/scripts/askpass.exp
 *
 * askpin.exp in turn spawns:
 *
 *   sudo -A openvpn --config <ovpn_file> --pkcs11-providers <provider>
 *
 * sudo calls SUDO_ASKPASS (askpass.exp) to obtain the sudo password via a
 * pinentry-gnome3 GUI dialog.  askpin.exp also monitors OpenVPN stdout for
 * PKCS#11 PIN prompts and feeds the PIN retrieved from a second
 * pinentry-gnome3 dialog back to OpenVPN.
 *
 * How process monitoring works
 * ----------------------------
 * The extension reads stdout of the askpin.exp process line-by-line
 * (Gio.DataInputStream.read_line_async).  When the line
 * "Initialization Sequence Completed" appears, the profile state moves to
 * CONNECTED and public-IP polling starts.  When stdout reaches EOF (process
 * exits for any reason) the state returns to DISCONNECTED.
 */

'use strict';

const { GLib, Gio, GObject, St, Clutter } = imports.gi;
const Main            = imports.ui.main;
const PanelMenu       = imports.ui.panelMenu;
const PopupMenu       = imports.ui.popupMenu;
const ExtensionUtils  = imports.misc.extensionUtils;

/** Reference to this extension's metadata / directory */
const ME = ExtensionUtils.getCurrentExtension();

// ── Constants ────────────────────────────────────────────────────────────────

/** Possible states for a VPN profile */
const VPN_STATE = {
    DISCONNECTED : 'disconnected',
    CONNECTING   : 'connecting',
    CONNECTED    : 'connected',
};

/** Public-IP service used to show the current IP when connected */
const IP_CHECK_URL = 'https://api.ipify.org';

/** How often (ms) to refresh the public IP while connected */
const IP_POLL_INTERVAL_MS = 15000;

// ── VpnProfileMenuItem ───────────────────────────────────────────────────────

/**
 * VpnProfileMenuItem
 *
 * A single row in the OpenVPN menu showing:
 *   [profile name ──────────] [status label] [toggle switch]
 *
 * Clicking anywhere on the row toggles the switch and calls onToggle().
 */
var VpnProfileMenuItem = GObject.registerClass(
class VpnProfileMenuItem extends PopupMenu.PopupBaseMenuItem {

    /**
     * @param {object}   profile  - Profile data object (name, path, state…)
     * @param {Function} onToggle - Callback(profile, enabled) when switch changes
     */
    _init(profile, onToggle) {
        super._init({ reactive: true });

        this._profile      = profile;
        this._onToggle     = onToggle;
        this._suppressNext = false; // guard against re-entrancy

        // ── Layout box ────────────────────────────────────────────────────
        let box = new St.BoxLayout({ x_expand: true });
        this.add_child(box);

        // Profile name (expands to fill available width)
        this._nameLabel = new St.Label({
            text       : profile.name,
            x_expand   : true,
            y_align    : Clutter.ActorAlign.CENTER,
            style_class: 'vpn-profile-name',
        });
        box.add_child(this._nameLabel);

        // State / IP label
        this._statusLabel = new St.Label({
            text       : _stateLabel(VPN_STATE.DISCONNECTED),
            y_align    : Clutter.ActorAlign.CENTER,
            style_class: `vpn-status vpn-${VPN_STATE.DISCONNECTED}`,
        });
        box.add_child(this._statusLabel);

        // Toggle switch (St widget styled by GNOME Shell theme)
        this._switch = new PopupMenu.Switch(false);
        box.add_child(this._switch);

        // Activate fires when the user clicks the item
        this.connect('activate', () => {
            if (this._suppressNext) return;
            let newState = !this._switch.state;
            this._switch.setToggleState(newState);
            this._onToggle(this._profile, newState);
        });
    }

    /**
     * Programmatically update the displayed state (does NOT trigger onToggle).
     *
     * @param {string}      state     - One of VPN_STATE values
     * @param {string|null} ipAddress - Public IP to display when connected
     */
    updateState(state, ipAddress = null) {
        this._suppressNext = true;
        this._switch.setToggleState(state !== VPN_STATE.DISCONNECTED);
        this._suppressNext = false;

        this._statusLabel.text        = _stateLabel(state, ipAddress);
        this._statusLabel.style_class = `vpn-status vpn-${state}`;
    }
});

/** Return a short human-readable string for a VPN state */
function _stateLabel(state, ip = null) {
    switch (state) {
    case VPN_STATE.CONNECTING:
        return '⟳ Connecting…';
    case VPN_STATE.CONNECTED:
        return ip ? `● ${ip}` : '● Connected';
    default:
        return '○';
    }
}

// ── OpenVpnIndicator ─────────────────────────────────────────────────────────

/**
 * OpenVpnIndicator
 *
 * The panel button and its drop-down menu.  Owns all VPN process state.
 */
var OpenVpnIndicator = GObject.registerClass(
class OpenVpnIndicator extends PanelMenu.Button {

    _init(settings) {
        super._init(0.0, 'OpenVPN Toggle');

        this._settings          = settings;
        /** name → profile data object */
        this._profiles          = new Map();
        /** name → VpnProfileMenuItem */
        this._menuItems         = new Map();
        /** Currently running Gio.Subprocess (the askpin.exp process), or null */
        this._activeProcess     = null;
        /** Profile name whose process is running, or null */
        this._activeProfileName = null;
        /** Gio.Cancellable for async I/O on the active process */
        this._cancellable       = null;
        /** GLib timeout source ID for public-IP polling, or null */
        this._ipTimer           = null;

        // ── Panel icon ────────────────────────────────────────────────────
        this.add_child(new St.Icon({
            icon_name  : 'network-vpn-symbolic',
            style_class: 'system-status-icon',
        }));

        // ── Menu layout ───────────────────────────────────────────────────
        this.menu.addMenuItem(new PopupMenu.PopupMenuItem('OpenVPN Profiles', {
            reactive   : false,
            style_class: 'vpn-menu-header',
        }));
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._profileSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._profileSection);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        let reloadItem = new PopupMenu.PopupMenuItem('⟳  Reload Profiles');
        reloadItem.connect('activate', () => this._loadProfiles());
        this.menu.addMenuItem(reloadItem);

        let prefsItem = new PopupMenu.PopupMenuItem('⚙  Preferences');
        prefsItem.connect('activate', () => ExtensionUtils.openPrefs());
        this.menu.addMenuItem(prefsItem);

        // Load profiles now and re-scan each time the menu opens
        this._loadProfiles();
        this.menu.connect('open-state-changed', (_menu, isOpen) => {
            if (isOpen) this._loadProfiles();
        });
    }

    // ── Profile loading ──────────────────────────────────────────────────────

    /**
     * Scan the configured profiles directory for .ovpn files and rebuild
     * the menu items.  The connected state of any already-active profile is
     * preserved across reloads.
     */
    _loadProfiles() {
        let profilesDir = this._expandPath(
            this._settings.get_string('profiles-dir'));

        let dir = Gio.File.new_for_path(profilesDir);
        if (!dir.query_exists(null)) {
            this._setNoProfiles(`Profiles directory not found:\n${profilesDir}`);
            return;
        }

        // Enumerate .ovpn files
        let found = [];
        try {
            let en = dir.enumerate_children(
                'standard::name,standard::type',
                Gio.FileQueryInfoFlags.NONE, null);
            let info;
            while ((info = en.next_file(null)) !== null) {
                let name = info.get_name();
                if (info.get_file_type() === Gio.FileType.REGULAR &&
                    name.endsWith('.ovpn')) {
                    found.push({
                        name: name.replace(/\.ovpn$/, ''),
                        path: GLib.build_filenamev([profilesDir, name]),
                    });
                }
            }
            en.close(null);
        } catch (e) {
            this._setNoProfiles(`Error reading profiles directory:\n${e.message}`);
            return;
        }

        found.sort((a, b) => a.name.localeCompare(b.name));

        // Rebuild menu section
        this._profileSection.removeAll();
        this._menuItems.clear();

        if (found.length === 0) {
            this._setNoProfiles(`No .ovpn files found in:\n${profilesDir}`);
            return;
        }

        for (let f of found) {
            // Carry over state from a previous load (e.g. if profile was active)
            let existing = this._profiles.get(f.name);
            let profile  = {
                name     : f.name,
                path     : f.path,
                state    : existing ? existing.state    : VPN_STATE.DISCONNECTED,
                ipAddress: existing ? existing.ipAddress : null,
            };
            this._profiles.set(f.name, profile);

            let item = new VpnProfileMenuItem(
                profile, (p, on) => this._handleToggle(p, on));
            item.updateState(profile.state, profile.ipAddress);

            this._menuItems.set(f.name, item);
            this._profileSection.addMenuItem(item);
        }
    }

    /** Show a placeholder row when there are no profiles to display */
    _setNoProfiles(msg) {
        this._profileSection.removeAll();
        this._menuItems.clear();
        this._profileSection.addMenuItem(
            new PopupMenu.PopupMenuItem(msg, { reactive: false }));
    }

    // ── Toggle handling ──────────────────────────────────────────────────────

    /**
     * Called when the user clicks a profile's toggle switch.
     *
     * Only one VPN may be active at a time; enabling a new profile first
     * disconnects the currently active one.
     *
     * @param {object}  profile - Profile data for the toggled item
     * @param {boolean} enabled - New switch state (true = on)
     */
    _handleToggle(profile, enabled) {
        if (enabled) {
            // Disconnect the currently active profile if it is different
            if (this._activeProfileName &&
                this._activeProfileName !== profile.name) {
                let active = this._profiles.get(this._activeProfileName);
                if (active) this._disconnectVpn(active);
            }
            this._connectVpn(profile);
        } else {
            this._disconnectVpn(profile);
        }
    }

    // ── OpenVPN process management ───────────────────────────────────────────

    /**
     * Start OpenVPN for the given profile.
     *
     * The extension runs:
     *
     *   expect <extdir>/scripts/askpin.exp <ovpn_file> <pkcs11_provider>
     *
     * with SUDO_ASKPASS pointing to askpass.exp.  askpin.exp is responsible
     * for spawning the actual OpenVPN process and handling authentication
     * prompts (see scripts/askpin.exp for details).
     *
     * @param {object} profile - Profile to connect
     */
    _connectVpn(profile) {
        this._updateProfileState(profile, VPN_STATE.CONNECTING, null);

        let extDir    = ME.dir.get_path();
        let askpass   = GLib.build_filenamev([extDir, 'scripts', 'askpass.exp']);
        let askpin    = GLib.build_filenamev([extDir, 'scripts', 'askpin.exp']);
        let pkcs11    = this._settings.get_string('pkcs11-provider');

        // Make sure the helper scripts are executable
        try {
            GLib.spawn_sync(null, ['chmod', '+x', askpass, askpin], null,
                GLib.SpawnFlags.SEARCH_PATH, null);
        } catch (_e) { /* non-fatal */ }

        // Build the subprocess launcher with the required environment variables
        let launcher = new Gio.SubprocessLauncher({
            flags: Gio.SubprocessFlags.STDOUT_PIPE |
                   Gio.SubprocessFlags.STDERR_MERGE,
        });

        // SUDO_ASKPASS: sudo will call this script when it needs a password
        launcher.setenv('SUDO_ASKPASS', askpass, true);

        // Propagate display variables so pinentry-gnome3 can open a window
        for (let v of ['DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR',
                        'DBUS_SESSION_BUS_ADDRESS']) {
            let val = GLib.getenv(v);
            if (val) launcher.setenv(v, val, true);
        }

        try {
            // Launch: expect askpin.exp <ovpn_path> <pkcs11_provider>
            this._activeProcess = launcher.spawnv(
                ['expect', askpin, profile.path, pkcs11]);
            this._activeProfileName = profile.name;
            this._cancellable       = new Gio.Cancellable();

            // Start monitoring stdout for status messages and process exit
            this._monitorProcess(profile);
        } catch (e) {
            logError(e, '[OpenVPN Toggle] Failed to start OpenVPN');
            this._updateProfileState(profile, VPN_STATE.DISCONNECTED, null);
            this._activeProcess     = null;
            this._activeProfileName = null;
        }
    }

    /**
     * Stop OpenVPN for the given profile by sending SIGTERM to the wrapper
     * process (which in turn signals the underlying openvpn process).
     *
     * @param {object} profile - Profile to disconnect
     */
    _disconnectVpn(profile) {
        if (!profile) return;

        this._stopIpPoll();

        if (this._cancellable) {
            this._cancellable.cancel();
            this._cancellable = null;
        }

        if (this._activeProcess) {
            try {
                this._activeProcess.send_signal(15); // SIGTERM
            } catch (_e) { /* process may already be gone */ }
            this._activeProcess = null;
        }

        if (this._activeProfileName === profile.name)
            this._activeProfileName = null;

        this._updateProfileState(profile, VPN_STATE.DISCONNECTED, null);
    }

    /**
     * Monitor the askpin.exp process stdout line-by-line.
     *
     * Detection rules:
     *   "Initialization Sequence Completed" → profile moves to CONNECTED
     *   EOF (line === null)                 → profile moves to DISCONNECTED
     *
     * An independent wait_async() also fires on process exit so that the
     * state is always cleaned up even if stdout closes before a newline.
     *
     * @param {object} profile - The profile whose process is being monitored
     */
    _monitorProcess(profile) {
        let stream = new Gio.DataInputStream({
            base_stream          : this._activeProcess.get_stdout_pipe(),
            close_base_on_dispose: true,
        });
        let cancellable = this._cancellable;

        // Recursive async line reader
        const readLine = () => {
            stream.read_line_async(GLib.PRIORITY_DEFAULT, cancellable,
                (s, res) => {
                    let line;
                    try {
                        [line] = s.read_line_finish_utf8(res);
                    } catch (e) {
                        if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                            logError(e, '[OpenVPN Toggle] Process read error');
                        return;
                    }

                    if (line === null) {
                        // EOF – the process ended
                        this._onProcessExit(profile);
                        return;
                    }

                    // Detect successful VPN initialization
                    if (line.includes('Initialization Sequence Completed')) {
                        this._updateProfileState(
                            profile, VPN_STATE.CONNECTED, null);
                        this._startIpPoll(profile);
                    }

                    readLine(); // schedule read of next line
                });
        };
        readLine();

        // Secondary watcher: fires when the process exits (covers the case
        // where stdout closes without a final newline)
        this._activeProcess.wait_async(cancellable, (_proc, res) => {
            try { _proc.wait_finish(res); } catch (_e) { /* cancelled */ }
            this._onProcessExit(profile);
        });
    }

    /**
     * Called (potentially twice) when the monitored process ends.
     * Idempotent: the DISCONNECTED guard makes the second call a no-op.
     */
    _onProcessExit(profile) {
        if (profile.state === VPN_STATE.DISCONNECTED) return; // already handled

        this._stopIpPoll();
        this._updateProfileState(profile, VPN_STATE.DISCONNECTED, null);

        if (this._activeProfileName === profile.name) {
            this._activeProcess     = null;
            this._activeProfileName = null;
        }
    }

    // ── Public-IP polling ────────────────────────────────────────────────────

    /**
     * Start periodic public-IP checks.
     * Immediately fires one check then repeats every IP_POLL_INTERVAL_MS.
     *
     * The check runs: curl -s --max-time 5 <IP_CHECK_URL>
     *
     * @param {object} profile - The connected profile to update with the IP
     */
    _startIpPoll(profile) {
        this._stopIpPoll();
        this._checkPublicIp(profile); // immediate

        this._ipTimer = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, IP_POLL_INTERVAL_MS, () => {
                if (profile.state === VPN_STATE.CONNECTED) {
                    this._checkPublicIp(profile);
                    return GLib.SOURCE_CONTINUE;
                }
                this._ipTimer = null;
                return GLib.SOURCE_REMOVE;
            });
    }

    _stopIpPoll() {
        if (this._ipTimer !== null) {
            GLib.source_remove(this._ipTimer);
            this._ipTimer = null;
        }
    }

    /**
     * Fetch the current public IP address via curl and update the menu item.
     * Silently ignores errors (temporary network issues should not crash).
     *
     * @param {object} profile - Profile to update with the retrieved IP
     */
    _checkPublicIp(profile) {
        try {
            let proc = Gio.Subprocess.new(
                ['curl', '-s', '--max-time', '5', IP_CHECK_URL],
                Gio.SubprocessFlags.STDOUT_PIPE |
                Gio.SubprocessFlags.STDERR_SILENCE);

            proc.communicate_utf8_async(null, null, (_p, res) => {
                try {
                    let [, stdout] = _p.communicate_utf8_finish(res);
                    let ip = stdout ? stdout.trim() : null;
                    if (ip && profile.state === VPN_STATE.CONNECTED) {
                        profile.ipAddress = ip;
                        let item = this._menuItems.get(profile.name);
                        if (item) item.updateState(VPN_STATE.CONNECTED, ip);
                    }
                } catch (_e) { /* ignore transient curl errors */ }
            });
        } catch (_e) { /* curl may not be installed; silently skip */ }
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    /** Expand a leading ~ to the user's home directory */
    _expandPath(p) {
        if (p.startsWith('~'))
            return GLib.get_home_dir() + p.slice(1);
        return p;
    }

    /** Update profile data and the corresponding menu item atomically */
    _updateProfileState(profile, state, ipAddress) {
        profile.state     = state;
        profile.ipAddress = ipAddress;
        let item = this._menuItems.get(profile.name);
        if (item) item.updateState(state, ipAddress);
    }

    // ── Cleanup ──────────────────────────────────────────────────────────────

    /** Called by GNOME Shell when the extension is disabled */
    destroy() {
        this._stopIpPoll();

        if (this._cancellable) {
            this._cancellable.cancel();
            this._cancellable = null;
        }

        if (this._activeProcess) {
            try { this._activeProcess.send_signal(15); } catch (_e) { /* gone */ }
            this._activeProcess = null;
        }

        super.destroy();
    }
});

// ── Extension lifecycle ──────────────────────────────────────────────────────

let _indicator = null;

/** Called once when the extension is first loaded */
function init() { // eslint-disable-line no-unused-vars
}

/**
 * Enable the extension: create the panel indicator and add it to the bar.
 * Settings are loaded from GSettings (schema compiled from schemas/).
 */
function enable() { // eslint-disable-line no-unused-vars
    let settings = ExtensionUtils.getSettings(
        'org.gnome.shell.extensions.gnome-openvpn-toggle');
    _indicator = new OpenVpnIndicator(settings);
    Main.panel.addToStatusArea(ME.metadata.uuid, _indicator);
}

/** Disable the extension: destroy the indicator and release all resources */
function disable() { // eslint-disable-line no-unused-vars
    if (_indicator !== null) {
        _indicator.destroy();
        _indicator = null;
    }
}
