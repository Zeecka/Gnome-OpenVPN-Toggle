# Gnome-OpenVPN-Toggle

A GNOME Shell extension that lets you toggle multiple OpenVPN profiles directly
from the top panel.  It manages OpenVPN CLI processes **without NetworkManager**
and supports hardware tokens via PKCS#11.

Supports **GNOME Shell 43** and **44**.

---

## Features

- **Panel icon** – click to open the profile list.
- **Toggle switch** per profile – enable / disable with one click.
- **Status indicator** – Disconnected / Connecting… / ● IP address.
- **Public IP display** – shown next to the profile name once connected.
- **One-at-a-time enforcement** – enabling a new profile automatically
  disconnects the active one.
- **Auto-scan** – `.ovpn` files in the configured directory are detected
  automatically; the list refreshes each time the menu opens.
- **Hardware-token (PKCS#11) support** – PIN is requested via a native GNOME
  pinentry dialog.
- **Configurable** – profiles directory and PKCS#11 library path can be changed
  in the extension preferences.

---

## Directory layout

```
gnome-openvpn-toggle@zeecka/   ← install root
├── metadata.json
├── extension.js
├── prefs.js
├── stylesheet.css
├── schemas/
│   ├── org.gnome.shell.extensions.gnome-openvpn-toggle.gschema.xml
│   └── gschemas.compiled          ← generated; do not edit by hand
└── scripts/
    ├── askpass.exp                ← SUDO_ASKPASS helper (pinentry for password)
    └── askpin.exp                 ← OpenVPN wrapper (spawns openvpn, handles PIN)
```

VPN profiles live in a separate directory (default `~/.config/openvpn`):

```
~/.config/openvpn/
├── work.ovpn
├── home-lab.ovpn
└── ...
```

---

## Dependencies

| Package | Purpose |
|---|---|
| `gnome-shell` ≥ 43 | Shell extension runtime |
| `openvpn` | OpenVPN CLI |
| `sudo` | Run OpenVPN as root |
| `expect` | Wrapper / interactive automation scripts |
| `pinentry-gnome3` | Native GNOME GUI dialogs for password / PIN |
| `curl` | Public-IP lookup (optional; IP display silently skipped if absent) |

Install on Debian/Ubuntu:

```bash
sudo apt install openvpn expect pinentry-gnome3 curl
```

Install on Fedora/RHEL:

```bash
sudo dnf install openvpn expect pinentry-gnome3 curl
```

---

## Installation

### 1 – Copy extension files

Clone the repository and copy the extension directory into GNOME's user
extension path:

```bash
git clone https://github.com/Zeecka/Gnome-OpenVPN-Toggle.git
cd Gnome-OpenVPN-Toggle

DEST="$HOME/.local/share/gnome-shell/extensions/gnome-openvpn-toggle@zeecka"
mkdir -p "$DEST"
cp -r metadata.json extension.js prefs.js stylesheet.css scripts "$DEST/"
cp -r schemas "$DEST/"
```

### 2 – Compile the GSettings schema

The compiled schema ships in the repository (`schemas/gschemas.compiled`).
If you need to recompile it after changes to the XML:

```bash
glib-compile-schemas "$DEST/schemas/"
```

### 3 – Make the helper scripts executable

```bash
chmod +x "$DEST/scripts/askpass.exp" "$DEST/scripts/askpin.exp"
```

### 4 – Enable the extension

```bash
gnome-extensions enable gnome-openvpn-toggle@zeecka
```

Or use **GNOME Extensions** app / **Extensions Manager**.

### 5 – Configure sudoers (recommended)

To avoid being prompted for a sudo password on every connection, add a
sudoers rule for openvpn:

```
# /etc/sudoers.d/openvpn-toggle
# Allow the current user to run openvpn as root without a password
yourusername ALL=(root) NOPASSWD: /usr/sbin/openvpn
```

Create the file with:

```bash
sudo visudo -f /etc/sudoers.d/openvpn-toggle
```

If you keep sudo authentication active, a GNOME pinentry dialog will appear
automatically to collect your password (handled by `askpass.exp`).

### 6 – Add VPN profiles

Place `.ovpn` files in `~/.config/openvpn/` (or the directory you configured
in the preferences):

```bash
cp ~/Downloads/myvpn.ovpn ~/.config/openvpn/
```

Then click **⟳ Reload Profiles** in the panel menu (or simply re-open it).

---

## Configuration

Open the preferences dialog from the extension menu (⚙ Preferences) or via:

```bash
gnome-extensions prefs gnome-openvpn-toggle@zeecka
```

| Setting | Default | Description |
|---|---|---|
| **Profiles directory** | `~/.config/openvpn` | Directory scanned for `.ovpn` files |
| **PKCS#11 provider** | `/usr/lib/libIDPrimePKCS11.so` | Shared library for hardware-token auth |

---

## How authentication works

### Sudo password (`scripts/askpass.exp`)

`askpass.exp` is set as the `SUDO_ASKPASS` environment variable before
OpenVPN is started.  When `sudo -A` needs a password it calls this script
(passing the prompt text as the first argument).  The script:

1. Spawns `pinentry-gnome3`.
2. Sends the prompt text via the Assuan protocol (`SETDESC`, `SETPROMPT`).
3. Sends `GETPIN` and waits for the user to confirm.
4. Receives the password on a `D <value>` line.
5. Prints the password to stdout so sudo can use it.

### PKCS#11 PIN (`scripts/askpin.exp`)

`askpin.exp` is the main entry point called by the extension.  It:

1. Receives the `.ovpn` file path and PKCS#11 provider path as arguments.
2. Spawns `sudo -A openvpn --config … --pkcs11-providers …`.
3. Monitors OpenVPN stdout for PIN prompts using `expect` pattern matching.
4. When a PIN prompt is detected, temporarily spawns a `pinentry-gnome3`
   dialog to collect the PIN (saving and restoring `spawn_id`).
5. Sends the PIN back to OpenVPN.
6. Forwards all OpenVPN output to its own stdout so the GNOME extension can
   detect `"Initialization Sequence Completed"`.

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Profile list empty | Profiles directory missing or no `.ovpn` files; check preferences |
| Toggle has no effect | `expect` not installed; check with `which expect` |
| No PIN dialog appears | `pinentry-gnome3` not installed; `DISPLAY` / `WAYLAND_DISPLAY` not set |
| "Failed to start OpenVPN" | `openvpn` or `expect` not in `$PATH` |
| IP address not shown | `curl` not installed; IP display is silently skipped |

Enable GNOME Shell logs to see extension errors:

```bash
journalctl -f /usr/bin/gnome-shell
```

---

## Uninstall

```bash
gnome-extensions disable gnome-openvpn-toggle@zeecka
rm -rf "$HOME/.local/share/gnome-shell/extensions/gnome-openvpn-toggle@zeecka"
```
