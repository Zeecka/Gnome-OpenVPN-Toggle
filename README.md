# Gnome-OpenVPN-Toggle

A GNOME Shell extension that lets you toggle OpenVPN profiles directly from the
top panel without using NetworkManager.

Supports **GNOME Shell 42 – 46**.

## What it does

- Shows detected `.ovpn` profiles in the panel menu.
- Lets you connect/disconnect with a switch.
- Displays connection state and connected IP.
- Supports interactive credentials with GNOME pinentry dialogs.
- Automatically disconnects an active profile when you connect another.

## Dependencies

Debian/Ubuntu:

```bash
sudo apt install openvpn expect pinentry-gnome3 iproute2
```

Fedora/RHEL:

```bash
sudo dnf install openvpn expect pinentry-gnome3 iproute
```

## Install (manual)

```bash
git clone https://github.com/Zeecka/Gnome-OpenVPN-Toggle.git
cd Gnome-OpenVPN-Toggle

DEST="$HOME/.local/share/gnome-shell/extensions/gnome-openvpn-toggle@zeecka"
mkdir -p "$DEST"
cp -r src/metadata.json src/extension.js src/prefs.js src/stylesheet.css src/scripts src/schemas "$DEST/"
glib-compile-schemas "$DEST/schemas/"
chmod +x "$DEST/scripts/askpass.exp" "$DEST/scripts/askpin.exp"
```

Enable:

```bash
gnome-extensions enable gnome-openvpn-toggle@zeecka
```

On X11, reload GNOME Shell after install using `Alt+F2`, then `r`.
On Wayland, log out and back in.

## Configure

Open preferences:

```bash
gnome-extensions prefs gnome-openvpn-toggle@zeecka
```

Default profiles directory is `~/.config/openvpn`.

## Troubleshooting (quick)

- Empty profile list: verify `.ovpn` files exist in your configured directory.
- Toggle does nothing: ensure `expect` and `openvpn` are installed and in `PATH`.
- No credential dialog: ensure `pinentry-gnome3` is installed.
- Stuck on connecting: verify interactive input rules in preferences.

For detailed troubleshooting and maintainer/development workflow, see:

- [dev/README.md](dev/README.md)

## Uninstall

```bash
gnome-extensions disable gnome-openvpn-toggle@zeecka
rm -rf "$HOME/.local/share/gnome-shell/extensions/gnome-openvpn-toggle@zeecka"
```
