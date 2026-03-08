/* extension.js
 *
 * OpenVPN Toggle – GNOME Shell Extension
 * =======================================
 * Manages multiple OpenVPN profiles directly from the GNOME top panel.
 * Does NOT rely on NetworkManager; it manages OpenVPN CLI processes
 * directly using GLib/Gio subprocess APIs.
 *
 * Supports GNOME Shell 42–46 (ES module format required by GNOME 45+).
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
 *   expect <extdir>/scripts/askpin.exp <ovpn_file>
 *
 * with the environment variable SUDO_ASKPASS pointing to:
 *
 *   <extdir>/scripts/askpass.exp
 *
 * askpin.exp in turn spawns:
 *
 *   sudo -A openvpn --config <ovpn_file>
 *
 * sudo calls SUDO_ASKPASS (askpass.exp) to obtain the sudo password via a
 * pinentry-gnome3 GUI dialog.  askpin.exp also monitors OpenVPN stdout for
 * PIN prompts and feeds the PIN retrieved from a second pinentry-gnome3
 * dialog back to OpenVPN.
 *
 * How process monitoring works
 * ----------------------------
 * The extension reads stdout of the askpin.exp process line-by-line
 * (Gio.DataInputStream.read_line_async).  When the line
 * "Initialization Sequence Completed" appears, the profile state moves to
 * CONNECTED and IP polling starts.  When stdout reaches EOF (process
 * exits for any reason) the state returns to DISCONNECTED.
 */

import GLib    from 'gi://GLib';
import Gio     from 'gi://Gio';
import GObject from 'gi://GObject';
import St      from 'gi://St';
import Clutter from 'gi://Clutter';

import * as Main      from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

// ── Constants ────────────────────────────────────────────────────────────────

/** Possible states for a VPN profile */
const VPN_STATE = {
    DISCONNECTED : 'disconnected',
    CONNECTING   : 'connecting',
    CONNECTED    : 'connected',
};

/** Regex matching common VPN interface prefixes */
const VPN_IFACE_REGEX = /^(tun|tap|wg|ppp)/;

/** How often (ms) to refresh the displayed IP while connected */
const IP_POLL_INTERVAL_MS = 15000;

/** Max time (ms) allowed to establish VPN before considering it stuck */
const CONNECT_TIMEOUT_MS = 120000;
/** Max time (ms) after init-complete to detect a real VPN interface/IP */
const VPN_READY_TIMEOUT_MS = 20000;
/** Poll interval (ms) while waiting for VPN interface/IP after init-complete */
const VPN_READY_POLL_INTERVAL_MS = 1000;

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
    _init(profile, onToggle, onConfigure) {
        super._init({ reactive: true });

        this._profile      = profile;
        this._onToggle     = onToggle;
        this._onConfigure  = onConfigure;
        this._suppressNext = false; // guard against re-entrancy

        // ── Layout box ────────────────────────────────────────────────────
        let box = new St.BoxLayout({ x_expand: true });
        this.add_child(box);

        // Profile name (expands to fill available width)
        this._nameLabel = new St.Label({
            text: profile.needsConfig ? `⚠️\ ${profile.name}` : profile.name,
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

            if (this._profile.needsConfig) {
                if (this._onConfigure)
                    this._onConfigure(this._profile);
                return;
            }

            let newState = !this._getSwitchState();
            this._setSwitchState(newState);
            this._onToggle(this._profile, newState);
        });
    }

    _getSwitchState() {
        if (this._switch && typeof this._switch.state === 'boolean')
            return this._switch.state;
        if (this._switch && typeof this._switch.checked === 'boolean')
            return this._switch.checked;
        return false;
    }

    _setSwitchState(enabled) {
        if (typeof this.setToggleState === 'function') {
            this.setToggleState(enabled);
            return;
        }

        if (!this._switch)
            return;

        if (typeof this._switch.setToggleState === 'function') {
            this._switch.setToggleState(enabled);
            return;
        }

        if ('state' in this._switch)
            this._switch.state = enabled;
        else if ('checked' in this._switch)
            this._switch.checked = enabled;
    }

    /**
     * Programmatically update the displayed state (does NOT trigger onToggle).
     *
     * @param {string}      state     - One of VPN_STATE values
    * @param {string|null} ipAddress - IP to display when connected
     */
    updateState(state, ipAddress = null) {
        this._suppressNext = true;
        this._setSwitchState(state !== VPN_STATE.DISCONNECTED);
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

    _init(extension, settings) {
        super._init(0.0, 'OpenVPN Toggle');

        /** Extension path – used to locate helper scripts */
        this._extPath = extension.path;
        /** Callback to open the preferences dialog */
        this._openPrefs = () => extension.openPreferences();

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
        /** GLib timeout source ID for IP polling, or null */
        this._ipTimer           = null;
        /** GLib timeout source ID for connection watchdog, or null */
        this._connectTimer      = null;
        /** GLib timeout source ID for VPN interface/IP readiness checks */
        this._vpnReadyTimer     = null;
        /** Number of readiness polls attempted for current connection */
        this._vpnReadyChecks    = 0;
        /** Temporary rules file path used by askpin.exp for active profile */
        this._activeRulesFile   = null;
        /** Last askpin error text observed from merged process output */
        this._lastAskpinError   = null;
        /** Current profile debug log path (.ovpn.log), or null */
        this._activeDebugLogPath = null;
        /** Baseline VPN iface/IP records captured before connecting */
        this._connectBaselineVpnRecords = [];
        /** Fast lookup set for baseline VPN iface/IP tuples */
        this._connectBaselineVpnRecordSet = new Set();

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
        prefsItem.connect('activate', () => this._openPrefs());
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
                debugLogPath: existing ? existing.debugLogPath : null,
                needsConfig: !this._hasInteractiveConfigForProfile(f),
            };
            this._profiles.set(f.name, profile);

            let item = new VpnProfileMenuItem(
                profile,
                (p, on) => this._handleToggle(p, on),
                p => this._openProfileConfiguration(p));
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
    *   expect <extdir>/scripts/askpin.exp <ovpn_file>
     *
     * with SUDO_ASKPASS pointing to askpass.exp.  askpin.exp is responsible
     * for spawning the actual OpenVPN process and handling authentication
     * prompts (see scripts/askpin.exp for details).
     *
     * @param {object} profile - Profile to connect
     */
    _connectVpn(profile) {
        this._captureConnectBaseline(profile);
        this._updateProfileState(profile, VPN_STATE.CONNECTING, null);

        if (this._isDebugEnabled())
            this._activeDebugLogPath = this._prepareDebugLog(profile);
        else
            this._activeDebugLogPath = null;

        profile.debugLogPath = this._activeDebugLogPath;

        let extDir    = this._extPath;
        let askpass   = GLib.build_filenamev([extDir, 'scripts', 'askpass.exp']);
        let askpin    = GLib.build_filenamev([extDir, 'scripts', 'askpin.exp']);

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

        let rulesFile = this._createInteractiveRulesFile(profile);

        try {
            // Launch: expect askpin.exp <ovpn_path> [rules_file]
            let argv = ['expect', askpin, profile.path];
            if (rulesFile)
                argv.push(rulesFile);
            else if (this._activeDebugLogPath)
                argv.push('');

            if (this._activeDebugLogPath)
                argv.push(this._activeDebugLogPath);

            this._activeProcess = launcher.spawnv(argv);
            this._activeProfileName = profile.name;
            this._cancellable       = new Gio.Cancellable();
            this._activeRulesFile   = rulesFile;
            this._lastAskpinError   = null;

            this._appendDebugLog(profile,
                `[${new Date().toISOString()}] [extension] Spawned askpin wrapper for ${profile.path}`);
            this._appendDebugLog(profile,
                `[${new Date().toISOString()}] [extension] askpin script=${askpin} askpass script=${askpass}`);
            this._appendDebugLog(profile,
                `[${new Date().toISOString()}] [extension] interactive rules file=${rulesFile ?? '(none)'}`);

            this._startConnectTimeout(profile);

            // Start monitoring stdout for status messages and process exit
            this._monitorProcess(profile);
        } catch (e) {
            this._logProfileError(profile, 'Failed to start OpenVPN process', e);
            this._updateProfileState(profile, VPN_STATE.DISCONNECTED, null);
            this._activeProcess     = null;
            this._activeProfileName = null;
            this._activeDebugLogPath = null;
            this._clearConnectBaseline();
            this._cleanupRulesFile();
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
        this._stopConnectTimeout();
        this._stopVpnReadyValidation();
        this._clearConnectBaseline();

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

        this._cleanupRulesFile();

        if (this._activeProfileName === profile.name)
            this._activeProfileName = null;

        if (profile.debugLogPath)
            this._appendDebugLog(profile,
                `[${new Date().toISOString()}] [extension] Disconnect requested by user`);

        this._activeDebugLogPath = null;

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
            base_stream: this._activeProcess.get_stdout_pipe(),
        });
        if (typeof stream.set_close_base_stream === 'function')
            stream.set_close_base_stream(true);
        let cancellable = this._cancellable;

        // Recursive async line reader
        const readLine = () => {
            stream.read_line_async(GLib.PRIORITY_DEFAULT, cancellable,
                (s, res) => {
                    let line;
                    try {
                        [line] = s.read_line_finish_utf8(res);
                    } catch (e) {
                        if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
                            this._logProfileError(profile, 'Process read error', e);
                        }
                        return;
                    }

                    if (line === null) {
                        // EOF – the process ended
                        this._onProcessExit(profile);
                        return;
                    }

                    if (line.startsWith('askpin:'))
                        this._lastAskpinError = line.replace(/^askpin:\s*/, '');

                    this._appendDebugLog(profile,
                        `[${new Date().toISOString()}] [askpin] ${line}`);

                    // Detect successful VPN initialization on real OpenVPN
                    // output lines (including timestamp-prefixed variants),
                    // while avoiding expect debug trace lines.
                    let trimmedLine = line.trim();
                    let isExpectTrace = trimmedLine.startsWith('expect:') ||
                        trimmedLine.includes('match regular expression') ||
                        trimmedLine.includes('expect_out(');
                    let isInitComplete = /Initialization Sequence Completed\s*$/.test(trimmedLine);

                    if (!isExpectTrace && isInitComplete) {
                        this._stopConnectTimeout();
                        this._appendDebugLog(profile,
                            `[${new Date().toISOString()}] [extension] OpenVPN reported initialization complete; waiting for VPN interface/IP`);
                        this._startVpnReadyValidation(profile);
                    }

                    readLine(); // schedule read of next line
                });
        };
        readLine();

        // Secondary watcher: fires when the process exits (covers the case
        // where stdout closes without a final newline)
        this._activeProcess.wait_async(cancellable, (_proc, res) => {
            try {
                _proc.wait_finish(res);

                if (this._activeProfileName === profile.name &&
                    profile.state !== VPN_STATE.CONNECTED) {
                    let reason = this._lastAskpinError;
                    if (!reason) {
                        if (_proc.get_if_exited()) {
                            let code = _proc.get_exit_status();
                            if (code !== 0)
                                reason = `OpenVPN exited before connection was established (exit code ${code}).`;
                        } else if (_proc.get_if_signaled()) {
                            reason = `OpenVPN process was interrupted (signal ${_proc.get_term_sig()}).`;
                        }
                    }

                    if (reason)
                        this._notifyConnectionError(profile, reason);

                    this._appendDebugLog(profile,
                        `[${new Date().toISOString()}] [extension] Connection ended before ready${reason ? `: ${reason}` : ''}`);
                }
            } catch (_e) { /* cancelled */ }
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
        this._stopConnectTimeout();
        this._stopVpnReadyValidation();
        this._updateProfileState(profile, VPN_STATE.DISCONNECTED, null);

        if (this._activeProfileName === profile.name) {
            this._activeProcess     = null;
            this._activeProfileName = null;
            this._cleanupRulesFile();
            this._activeDebugLogPath = null;
            this._clearConnectBaseline();
        }
    }

    // ── IP polling ───────────────────────────────────────────────────────────

    /**
     * Start periodic IP checks.
     * Immediately fires one check then repeats every IP_POLL_INTERVAL_MS.
     *
     * The check runs: ip -4 -o addr show scope global
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

    _startConnectTimeout(profile) {
        this._stopConnectTimeout();
        this._connectTimer = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            CONNECT_TIMEOUT_MS,
            () => {
                this._connectTimer = null;

                if (this._activeProfileName !== profile.name ||
                    profile.state !== VPN_STATE.CONNECTING) {
                    return GLib.SOURCE_REMOVE;
                }

                let reason = 'VPN appears stuck while connecting (timeout).';
                this._lastAskpinError = reason;
                this._notifyConnectionError(profile, reason);
                this._appendDebugLog(profile,
                    `[${new Date().toISOString()}] [extension] ${reason}`);

                if (this._activeProcess) {
                    try { this._activeProcess.send_signal(15); } catch (_e) { /* ignore */ }
                }

                return GLib.SOURCE_REMOVE;
            });
    }

    _stopConnectTimeout() {
        if (this._connectTimer !== null) {
            GLib.source_remove(this._connectTimer);
            this._connectTimer = null;
        }
    }

    _startVpnReadyValidation(profile) {
        this._stopVpnReadyValidation();
        this._vpnReadyChecks = 0;

        this._checkPublicIp(profile, {allowPromoteFromConnecting: true});

        this._vpnReadyTimer = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            VPN_READY_POLL_INTERVAL_MS,
            () => {
                if (this._activeProfileName !== profile.name)
                    return this._stopVpnReadyValidation();

                if (profile.state === VPN_STATE.CONNECTED)
                    return this._stopVpnReadyValidation();

                if (profile.state !== VPN_STATE.CONNECTING)
                    return this._stopVpnReadyValidation();

                this._vpnReadyChecks += 1;
                this._checkPublicIp(profile, {allowPromoteFromConnecting: true});

                let elapsedMs = this._vpnReadyChecks * VPN_READY_POLL_INTERVAL_MS;
                if (elapsedMs >= VPN_READY_TIMEOUT_MS) {
                    let reason = 'OpenVPN initialized but no VPN interface/IP was detected.';
                    this._lastAskpinError = reason;
                    this._notifyConnectionError(profile, reason);
                    this._appendDebugLog(profile,
                        `[${new Date().toISOString()}] [extension] ${reason}`);

                    if (this._activeProcess) {
                        try { this._activeProcess.send_signal(15); } catch (_e) { /* ignore */ }
                    }

                    return this._stopVpnReadyValidation();
                }

                return GLib.SOURCE_CONTINUE;
            });
    }

    _stopVpnReadyValidation() {
        if (this._vpnReadyTimer !== null) {
            GLib.source_remove(this._vpnReadyTimer);
            this._vpnReadyTimer = null;
        }
        return GLib.SOURCE_REMOVE;
    }

    _captureConnectBaseline(profile) {
        this._connectBaselineVpnRecords = [];
        this._connectBaselineVpnRecordSet = new Set();

        try {
            let proc = Gio.Subprocess.new(
                ['ip', '-4', '-o', 'addr', 'show', 'scope', 'global'],
                Gio.SubprocessFlags.STDOUT_PIPE |
                Gio.SubprocessFlags.STDERR_SILENCE);

            let [, stdout] = proc.communicate_utf8(null, null);
            let records = this._parseIpAddressRecords(stdout ?? '');
            let vpnRecords = records.filter(record => VPN_IFACE_REGEX.test(record.iface));

            this._connectBaselineVpnRecords = vpnRecords;
            this._connectBaselineVpnRecordSet = new Set(
                vpnRecords.map(record => `${record.iface}|${record.ip}`)
            );

            let baselineText = vpnRecords.length > 0
                ? vpnRecords.map(record => `${record.iface}:${record.ip}`).join(', ')
                : '(none)';
            this._appendDebugLog(profile,
                `[${new Date().toISOString()}] [extension] connect baseline vpn-iface/ip=${baselineText}`);
        } catch (_e) {
            this._appendDebugLog(profile,
                `[${new Date().toISOString()}] [extension] connect baseline capture unavailable`);
        }
    }

    _clearConnectBaseline() {
        this._connectBaselineVpnRecords = [];
        this._connectBaselineVpnRecordSet = new Set();
    }

    /**
     * Fetch the current local IPv4 address via the ip command and update the
     * menu item. Prefers VPN-style interfaces (tun/tap/wg/ppp) when present.
     *
     * @param {object} profile - Profile to update with the retrieved IP
     */
    _checkPublicIp(profile, options = {}) {
        let allowPromoteFromConnecting = options.allowPromoteFromConnecting === true;
        try {
            let proc = Gio.Subprocess.new(
                ['ip', '-4', '-o', 'addr', 'show', 'scope', 'global'],
                Gio.SubprocessFlags.STDOUT_PIPE |
                Gio.SubprocessFlags.STDERR_SILENCE);

            proc.communicate_utf8_async(null, null, (_p, res) => {
                try {
                    let [, stdout] = _p.communicate_utf8_finish(res);
                    let records = this._parseIpAddressRecords(stdout ?? '');
                    let vpnRecords = records.filter(record => VPN_IFACE_REGEX.test(record.iface));
                    let currentRecord = vpnRecords.length > 0 ? vpnRecords[0] : null;
                    let diffRecord = this._findVpnDiffRecord(vpnRecords);
                    let ip = (diffRecord ?? currentRecord)?.ip ?? null;

                    let diffText = diffRecord ? `${diffRecord.iface}:${diffRecord.ip}` : '(none)';
                    this._appendDebugLog(profile,
                        `[${new Date().toISOString()}] [extension] ip probe: vpn-ip=${ip ?? '(none)'} diff=${diffText}`);

                    if (ip && profile.state === VPN_STATE.CONNECTED) {
                        profile.ipAddress = ip;
                        let item = this._menuItems.get(profile.name);
                        if (item) item.updateState(VPN_STATE.CONNECTED, ip);
                    } else if (diffRecord && allowPromoteFromConnecting && profile.state === VPN_STATE.CONNECTING) {
                        this._appendDebugLog(profile,
                            `[${new Date().toISOString()}] [extension] VPN iface/IP diff detected (${diffRecord.iface}:${diffRecord.ip}); promoting state to CONNECTED`);
                        this._updateProfileState(profile, VPN_STATE.CONNECTED, diffRecord.ip);
                        this._startIpPoll(profile);
                        this._stopVpnReadyValidation();
                    }
                } catch (_e) { /* ignore transient command errors */ }
            });
        } catch (_e) { /* ip command unavailable; silently skip */ }
    }

    _findVpnDiffRecord(vpnRecords) {
        if (!Array.isArray(vpnRecords) || vpnRecords.length === 0)
            return null;

        for (let record of vpnRecords) {
            let key = `${record.iface}|${record.ip}`;
            if (!this._connectBaselineVpnRecordSet.has(key))
                return record;
        }

        return null;
    }

    _extractIpFromIpCommandOutput(stdout) {
        let records = this._parseIpAddressRecords(stdout);
        let vpnRecord = records.find(record => VPN_IFACE_REGEX.test(record.iface));
        return vpnRecord ? vpnRecord.ip : null;
    }

    _parseIpAddressRecords(stdout) {
        if (!stdout)
            return [];

        let records = [];
        for (let rawLine of stdout.split('\n')) {
            let line = rawLine.trim();
            if (!line)
                continue;

            let match = line.match(/^\d+:\s+([^\s]+)\s+inet\s+([0-9.]+)\/\d+/);
            if (!match)
                continue;

            let iface = match[1];
            let ip    = match[2];
            records.push({iface, ip});
        }

        return records;
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    _getInteractiveInputsForProfile(profile) {
        let raw = this._settings.get_string('interactive-config');
        if (!raw || raw.trim() === '')
            return [];

        let parsed;
        try {
            parsed = JSON.parse(raw);
        } catch (e) {
            console.error('[OpenVPN Toggle] interactive-config is not valid JSON', e);
            return [];
        }

        if (!Array.isArray(parsed)) {
            console.error('[OpenVPN Toggle] interactive-config must be a JSON array');
            return [];
        }

        let baseName = GLib.path_get_basename(profile.path);
        let altName  = `${profile.name}.ovpn`;
        let matched = parsed.find(entry => {
            if (!entry || typeof entry !== 'object')
                return false;
            if (typeof entry.vpn !== 'string')
                return false;
            return entry.vpn === profile.path ||
                   entry.vpn === baseName ||
                   entry.vpn === profile.name ||
                   entry.vpn === altName;
        });

        if (!matched || !Array.isArray(matched.inputs))
            return [];

        let validInputs = [];
        for (let input of matched.inputs) {
            if (!input || typeof input !== 'object')
                continue;
            if (typeof input.input !== 'string' || input.input.length === 0)
                continue;
            if (input.type !== 'static' && input.type !== 'prompt')
                continue;
            if (typeof input.value !== 'string')
                continue;

            validInputs.push({
                input: input.input,
                type : input.type,
                value: input.value,
            });
        }

        return validInputs;
    }

    _hasInteractiveConfigForProfile(profile) {
        return this._getInteractiveInputsForProfile(profile).length > 0;
    }

    _openProfileConfiguration(_profile) {
        this._openPrefs();
    }

    _notifyConnectionError(profile, message) {
        let profileName = profile && profile.name ? profile.name : 'Unknown profile';
        Main.notifyError('OpenVPN Toggle', `${profileName}: ${message}`);
        this._appendDebugLog(profile,
            `[${new Date().toISOString()}] [extension-error] ${profileName}: ${message}`);
    }

    _isDebugEnabled() {
        return this._settings.get_boolean('debug-enabled');
    }

    _debugLogPathForProfile(profile) {
        return `${profile.path}.log`;
    }

    _prepareDebugLog(profile) {
        let logPath = this._debugLogPathForProfile(profile);
        let header = [
            `# OpenVPN Toggle debug log`,
            `# profile: ${profile.path}`,
            `# started: ${new Date().toISOString()}`,
            '',
        ].join('\n');

        try {
            GLib.file_set_contents(logPath, header);
            return logPath;
        } catch (e) {
            console.error('[OpenVPN Toggle] Failed to create debug log file', e);
            return null;
        }
    }

    _appendDebugLog(profile, text) {
        if (!profile || !profile.debugLogPath)
            return;

        try {
            let file = Gio.File.new_for_path(profile.debugLogPath);
            let stream = file.append_to(Gio.FileCreateFlags.NONE, null);
            stream.write_all(`${text}\n`, null);
            stream.close(null);
        } catch (_e) {
            /* ignore debug log write failures */
        }
    }

    _logProfileError(profile, message, error) {
        if (error)
            console.error(`[OpenVPN Toggle] ${message}`, error);
        else
            console.error(`[OpenVPN Toggle] ${message}`);

        let details = error && error.message ? `${message}: ${error.message}` : message;
        this._appendDebugLog(profile,
            `[${new Date().toISOString()}] [extension-error] ${details}`);
    }

    _escapeRuleField(value) {
        return value
            .replaceAll('\\', '\\\\')
            .replaceAll('\t', '\\t')
            .replaceAll('\n', '\\n')
            .replaceAll('\r', '\\r');
    }

    _createInteractiveRulesFile(profile) {
        let inputs = this._getInteractiveInputsForProfile(profile);
        if (inputs.length === 0)
            return null;

        try {
            let [fd, path] = GLib.file_open_tmp('openvpn-toggle-rules-XXXXXX');
            try { GLib.close(fd); } catch (_e) { /* ignore */ }

            let rows = inputs.map(input => [
                this._escapeRuleField(input.input),
                this._escapeRuleField(input.type),
                this._escapeRuleField(input.value),
            ].join('\t'));
            GLib.file_set_contents(path, `${rows.join('\n')}\n`);
            return path;
        } catch (e) {
            console.error('[OpenVPN Toggle] Failed creating interactive rules file', e);
            return null;
        }
    }

    _cleanupRulesFile() {
        if (!this._activeRulesFile)
            return;
        try {
            GLib.unlink(this._activeRulesFile);
        } catch (_e) {
            /* ignore cleanup failures */
        }
        this._activeRulesFile = null;
    }

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
        this._stopConnectTimeout();

        if (this._cancellable) {
            this._cancellable.cancel();
            this._cancellable = null;
        }

        if (this._activeProcess) {
            try { this._activeProcess.send_signal(15); } catch (_e) { /* gone */ }
            this._activeProcess = null;
        }

        this._cleanupRulesFile();
        this._activeDebugLogPath = null;

        super.destroy();
    }
});

// ── Extension lifecycle ──────────────────────────────────────────────────────

/**
 * The exported Extension class is instantiated once by GNOME Shell.
 * enable() / disable() are called each time the extension is toggled.
 */
export default class OpenVPNExtension extends Extension {

    enable() {
        let settings = this.getSettings();
        this._indicator = new OpenVpnIndicator(this, settings);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        if (this._indicator !== null) {
            this._indicator.destroy();
            this._indicator = null;
        }
    }
}
