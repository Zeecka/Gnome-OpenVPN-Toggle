# Developer Documentation

This document covers local development, packaging, and release workflow for
`gnome-openvpn-toggle@ovpntoggle`.

## Prerequisites

- `gnome-shell` (for testing the extension)
- `gnome-extensions` CLI
- `glib-compile-schemas`
- `python3`
- `openvpn`, `expect`, `pinentry-gnome3` (runtime dependencies)

## Local reload workflow

Use:

```bash
bash dev/reload.sh
```

What it does:

1. Disables the extension.
2. Resets extension dconf/gsettings keys.
3. Reinstalls current repo files into the local GNOME extensions directory.
4. Compiles schemas.
5. Restores executable permissions on expect scripts.
6. Waits for shell reload confirmation and then re-enables the extension.

Notes:

- On X11: use `Alt+F2`, type `r`, press Enter.
- On Wayland: log out and log back in to reload GNOME Shell.

## Build package for extensions.gnome.org

Use:

```bash
bash dev/build-ego.sh
```

What it does:

1. Validates required project files.
2. Reads `uuid` and `version` from `src/metadata.json`.
3. Stages a clean build in `.build/ego/`.
4. Compiles schemas in the staged directory.
5. Runs `gnome-extensions pack`.
6. Writes artifact to:

```text
dist/<uuid>-v<version>.zip
```

## Release checklist

1. Update `version` in `src/metadata.json`.
2. Verify `shell-version` list is current.
3. Run `bash dev/build-ego.sh`.
4. Upload the generated zip from `dist/` to extensions.gnome.org.
5. Run a final local smoke test with `bash dev/reload.sh`.

## Common issues

- `Missing required command`: install the reported CLI dependency.
- `Build failed: no zip artifact found`: ensure `gnome-extensions pack` is available and successful.
- Extension not visible after reload: confirm shell reload (X11) or re-login (Wayland).
