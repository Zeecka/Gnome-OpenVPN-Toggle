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

## Install from release (recommended)

Download the latest zip from the [Releases page](https://github.com/Zeecka/Gnome-OpenVPN-Toggle/releases/latest)
and install it with one command:

```bash
gnome-extensions install gnome-openvpn-toggle@ovpntoggle-v<VERSION>.zip --force
gnome-extensions enable gnome-openvpn-toggle@ovpntoggle
```

Or, using `curl` to grab the latest release automatically:

```bash
TAG=$(curl -s https://api.github.com/repos/Zeecka/Gnome-OpenVPN-Toggle/releases/latest | grep '"tag_name"' | cut -d'"' -f4)
curl -L "https://github.com/Zeecka/Gnome-OpenVPN-Toggle/releases/download/${TAG}/gnome-openvpn-toggle@ovpntoggle-${TAG}.zip" -o gnome-openvpn-toggle.zip
gnome-extensions install gnome-openvpn-toggle.zip --force
gnome-extensions enable gnome-openvpn-toggle@ovpntoggle
```

On X11, reload GNOME Shell after install using `Alt+F2`, then `r`.
On Wayland, log out and back in.

## Install (manual)

```bash
git clone https://github.com/Zeecka/Gnome-OpenVPN-Toggle.git
cd Gnome-OpenVPN-Toggle

DEST="$HOME/.local/share/gnome-shell/extensions/gnome-openvpn-toggle@ovpntoggle"
mkdir -p "$DEST"
cp -r src/metadata.json src/extension.js src/prefs.js src/stylesheet.css src/scripts src/schemas "$DEST/"
glib-compile-schemas "$DEST/schemas/"
chmod +x "$DEST/scripts/askpass.exp" "$DEST/scripts/askpin.exp"
```

Enable:

```bash
gnome-extensions enable gnome-openvpn-toggle@ovpntoggle
```

On X11, reload GNOME Shell after install using `Alt+F2`, then `r`.
On Wayland, log out and back in.

## Configure

Open preferences:

```bash
gnome-extensions prefs gnome-openvpn-toggle@ovpntoggle
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
gnome-extensions disable gnome-openvpn-toggle@ovpntoggle
rm -rf "$HOME/.local/share/gnome-shell/extensions/gnome-openvpn-toggle@ovpntoggle"
```
