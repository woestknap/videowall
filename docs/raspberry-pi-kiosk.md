# Raspberry Pi OS videowall kiosk

## Findings and limits

The reported boot-only white window is most consistent with a startup readiness
race or a Chromium renderer/compositor startup stall. Manual launches work later
on the same OS/browser, including the actual player. A live browser PID does not
prove successful navigation or rendering. The precise cause is **not yet proven**:
we have no failing-boot journal, Chromium console/network trace, or access to a Pi.
“Pi 1” and “Pi 4” here are the user's device labels, not an assumption about models.

Repository inspection: `9be5358`/`8511cbf` isolate video playback and `34a5bbf`
adds safe mode. They do not control OS startup. `1d4a2a6` adds a React crash boundary,
but it cannot catch failure to download/evaluate the entry module. Previously
`index.html` contained an empty root and background styling arrived with the app.
We now provide an HTML loading message and a player animation-frame health signal.
Pairing/status render before backend requests finish; even an empty scene is black.
There is no evidence here that changing Supabase or Cloudflare configuration fixes
the boot failure. A network/TLS/asset-load failure at boot remains possible.

Three distinct areas:

* **Kiosk startup:** session environment, network/DNS/TLS/clock readiness, renderer
  stalls, duplicate launches. The supplied launcher addresses readiness and recovery.
* **Web app:** module-load failure now leaves a loading message; render errors have
  an error boundary. Supabase state is polled every four seconds and a running
  scene remains on connection errors. There is no offline cold-boot cache of scenes.
* **Codecs:** AV1 decoding failure can break a video while the rest of the player
  works. It cannot explain the reported white boot with no media.

This uses ordinary Raspberry Pi OS Desktop, Chromium, Python and systemd, all free.
No custom OS image, Docker, FullPageOS or subscription is required. It is a tested
software implementation, **not a hardware-validated cure**; do the acceptance test
below on the failing Pi before rolling it out.

## 1. Install regular Raspberry Pi OS

Use Raspberry Pi Imager and select your actual hardware, then **Raspberry Pi OS
with Desktop** (Trixie; not Lite). Use the same architecture across Pi 3/4 where
supported; 64-bit Desktop is the official kiosk tutorial's baseline. Set a unique
hostname such as `wall-01`, a desktop user such as `display`, Wi-Fi/country if needed,
and enable SSH with your public key. Do not clone an already paired browser profile.

Connect the HDMI TV or supported attached display, then boot. From your computer:

```sh
ssh display@wall-01.local
```

All remaining shell commands run **on the Pi as that desktop user**, unless stated.

```sh
sudo apt update
sudo apt full-upgrade -y
sudo apt install -y chromium git python3 python3-websocket wayland-utils
sudo systemctl enable --now ssh
sudo timedatectl set-ntp true
sudo raspi-config
```

Use the terminal menu opened by `sudo raspi-config`, not the desktop Control Centre.
On current Trixie, make these four selections (arrow keys, Enter, and Tab to Back):

1. **1 System Options → S5 Boot → B2 Desktop**.
2. **1 System Options → S6 Auto Login**: answer **No** for console auto login,
   then **Yes** for desktop auto login. These are separate questions.
3. **6 Advanced Options → A7 Wayland → W2 Labwc**.
4. **2 Display Options → D2 Screen Blanking**: answer **No** to enabling blanking.

Choose **Finish**. If asked to reboot, you can do so now and reconnect over SSH
before continuing. Older versions combine steps 1–2 under **System Options →
Boot / Auto Login → Desktop Autologin**. If neither layout matches, run
`dpkg-query -W raspi-config` and note the menu labels before changing anything.
These paths are verified against the [current Raspberry Pi configuration
documentation](https://www.raspberrypi.com/documentation/computers/configuration.html).

Keep normal Raspberry Pi OS graphics drivers. Do not add GPU-disable flags or force HDMI connector names.
Configure output resolution/rotation using the desktop's Screen Configuration;
start Pi 3 trials at 1920×1080 or the attached panel's native lower resolution.
An SPI/third-party panel must already function as a desktop output with its vendor
driver; a Chromium launcher cannot supply that driver. Turn the TV on for setup.

## 2. Install the launcher

First ensure the web build containing the new health signal has been deployed.
An older build will be restarted every two minutes because it lacks that signal.

```sh
git clone https://github.com/woestknap/videowall.git ~/videowall
cd ~/videowall
sh kiosk/install.sh
nano ~/.config/labwc/autostart
```

Remove the **old Chromium line and old kiosk script lines** from that file, keeping
unrelated desktop commands. The installer adds this one line; keep it exactly once:

```sh
"$HOME/.local/lib/videowall/session-start.sh" &
```

Look for other launchers before rebooting:

```sh
grep -RniE 'chromium|kiosk' ~/.config/autostart ~/.config/systemd/user /etc/xdg/labwc /etc/systemd/system 2>/dev/null
systemctl --user list-unit-files | grep -Ei 'kiosk|chromium'
systemctl list-unit-files | grep -Ei 'kiosk|chromium'
crontab -l
```

Disable only older kiosk services you recognize, using `systemctl --user disable
--now OLD.service` for user units or `sudo systemctl disable --now OLD.service` for
system units. Remove old kiosk cron entries with `crontab -e`. Do not disable the
new service or system desktop services. The new kiosk service intentionally has no
enable step: labwc starts it with the correct session environment each login.

```sh
sudo reboot
```

The PIN screen appears first. Pair this new dedicated profile once from the admin
dashboard. Its data is stored in `~/.local/share/videowall/chromium`; it survives
service restarts and normal reboots. An older default Chromium profile remains
untouched; this setup does not reuse its pairing. Never clear the kiosk profile
as a routine recovery step. `--password-store=basic` prevents keychain prompts;
this is a dedicated player profile, not a place to save personal passwords.

The URL file is `~/.config/videowall/kiosk.env`, initially:

```ini
KIOSK_URL=https://videowall-3lp.pages.dev/?player=1
```

Use a literal URL, **not Markdown link syntax**. The bracketed URL in the original
report may just be formatting; if brackets and parentheses are really in autostart,
correct them. The installer copies `kiosk/launcher.py`, `session-start.sh`, and
`videowall-kiosk.service` to the corresponding per-user locations. All source files
are in this repository for inspection.

## How readiness and recovery work

labwc imports its real `WAYLAND_DISPLAY`, runtime directory and session variables
into the user systemd manager, then starts the service. `wayland-info` must complete
and report an output. An HTTPS request to the actual player must return application
HTML; DNS, routing and certificate/clock failures are logged and retried every five
seconds. These intervals are condition polling/backoff, not fixed boot delays.

`network-online.target` in the system manager is only a boot milestone, not a
guarantee of Internet/DNS/application availability. A user service cannot order
against the system manager's target. This implementation therefore checks the
actual dependency directly. No network wait target or lingering user manager is
required, and a failed network check never blocks SSH or the desktop.

Chromium runs under one user service with a persistent separate profile. A random
loopback DevTools port lets the watchdog check the real player tab, its React mount
and animation-frame freshness every ten seconds. No healthy sample for 120 seconds
causes termination; systemd cleans up the entire process group and restarts after
ten seconds. Browser exit/crash and watchdog exit are also restarted. The launcher
notifies systemd on each loop; a launcher hang is itself restarted after 90 seconds.
Startup and
the app's existing six-hour reload get that same grace period. Backend outages do
not restart an otherwise responsive player. If already displaying a scene, it stays
visible during ordinary network loss; cold boot waits for network. This is not an
offline signage system.

The debug port is loopback only; do not expose it through a firewall or port forward.
It permits control of this browser. Keep access to the Pi's account restricted.
No sandbox or TLS protections are disabled. Logs go to journald.

An animation-frame heartbeat cannot prove physical HDMI/DSI scanout, detect every
GPU/compositor failure, or validate video motion. A full OS hang requires a separate
OS/hardware watchdog design; this service manages browser and renderer failures.
Unexpected power loss can still damage an SD card/profile. Use a suitable supply,
good SD cards and clean shutdown when possible; software cannot guarantee storage
integrity after arbitrary power cuts. Do not enable a read-only overlay without a
deliberate writable storage plan for pairing and updates.

## SSH management and failing-boot evidence

```sh
systemctl --user status videowall-kiosk --no-pager
journalctl --user -u videowall-kiosk -b --no-pager -n 200
systemctl --user restart videowall-kiosk
systemctl --user stop videowall-kiosk
systemctl --user start videowall-kiosk
```

After changing the URL file, restart the service. Diagnostic URLs are retained:
`?player=1&debug=1`, `?player=1&safe=1`, `?player=1&noVideo=1`, and
`?player=1&rawVideo=1`. Safe mode still needs the app bundle and shows its safe
message after pairing; it is not a test of a browser that never loads JavaScript.

Before manually restarting a white boot, collect:

```sh
mkdir -p ~/kiosk-evidence
journalctl --user -u videowall-kiosk -b --no-pager > ~/kiosk-evidence/kiosk.txt
journalctl -b -k --no-pager > ~/kiosk-evidence/kernel.txt
systemctl --user show-environment | grep -E 'WAYLAND_DISPLAY|DISPLAY|XDG_RUNTIME_DIR'
pgrep -af chromium
timedatectl status
nmcli general status
vcgencmd get_throttled
cat /proc/device-tree/model; echo
chromium --version
curl -I 'https://videowall-3lp.pages.dev/?player=1'
```

Add a phone photo of the screen. Readiness errors identify network/clock or Wayland
problems. Missing-tab messages indicate navigation/startup failure; `mounted: false`
suggests the app did not mount or crashed; an old frame age indicates stopped frame
callbacks. If logs say healthy while the TV is white, investigate the compositor,
DRM/HDMI, power and actual GPU rendering path before changing backend services.
Review logs before sharing them; they can contain device-specific URLs.

For persistent previous-boot journals with bounded disk use:

```sh
sudo mkdir -p /etc/systemd/journald.conf.d
printf '[Journal]\nStorage=persistent\nSystemMaxUse=100M\n' | sudo tee /etc/systemd/journald.conf.d/kiosk.conf
sudo systemctl restart systemd-journald
sudo journalctl --flush
```

Then use `journalctl --user -u videowall-kiosk -b -1` for the previous boot.

## Acceptance test before fleet rollout

1. Pair once, publish a text-only scene and perform ten normal reboots. Record time
   to display and confirm pairing remains. Repeat with TV on first and TV on later.
2. Boot with network disconnected; confirm SSH becomes available after reconnect
   and the player starts automatically. While a scene is running, disconnect and
   reconnect network and verify state updates resume.
3. Test a crash: `systemctl --user kill --signal=SIGKILL --kill-whom=all videowall-kiosk`.
   It should restart and retain pairing.
4. Test supervisor recovery with `systemctl --user kill --signal=SIGSTOP --kill-whom=main videowall-kiosk`;
   systemd should recover it after its 90-second watchdog deadline. For a renderer hang, run
   `pgrep -af 'chromium.*--type=renderer'`, identify this kiosk's renderer PID, and
   `kill -STOP PID`. Confirm the watchdog replaces Chromium within roughly three
   minutes. If the wrong process was selected, undo with `kill -CONT PID`.
5. After the reboot tests, perform a controlled power-loss trial on a spare/test SD
   card and verify pairing and recovery. Repeat tests on each hardware/display type.
6. Publish one converted H.264 clip and then the intended full scene. Check thermals,
   memory and dropped frames. Do a 24-hour run before copying the setup to the fleet.

To update installed scripts, run `git pull --ff-only` in `~/videowall`, rerun
`sh kiosk/install.sh`, then `systemctl --user restart videowall-kiosk`. To roll back,
stop the service and remove its line from labwc autostart; the installer keeps a
timestamped autostart backup. Restore the prior launch line if needed.

## Pi-safe media

Use MP4 with H.264, 8-bit yuv420p and optional AAC audio. For Pi 3 start with a single
1080p30-or-lower clip at modest bitrate. MP4 is a container: an MP4 filename does
not establish its codec. Browser hardware acceleration and multi-layer capacity
must be checked on the actual OS/hardware. Do not assume AV1 is supported.

On a computer with free FFmpeg installed:

```sh
ffmpeg -i input.mp4 -vf "scale=1920:1080:force_original_aspect_ratio=decrease:force_divisible_by=2,fps=30" -c:v libx264 -profile:v main -level:v 4.0 -pix_fmt yuv420p -crf 22 -maxrate 6M -bufsize 12M -c:a aac -b:a 128k -movflags +faststart output-pi.mp4
ffprobe -v error -select_streams v:0 -show_entries stream=codec_name,profile,pix_fmt,width,height,r_frame_rate -of default=noprint_wrappers=1 output-pi.mp4
```

## Primary references

Verification on the development machine (2026-09-10): production TypeScript/Vite
build passed; eight Python unit tests passed, including readiness retry, browser
exit and stale-renderer termination; both shell files passed Bash syntax checks.
The built player displayed its PIN form, advanced its frame marker, and reported
no browser console errors. Native systemd/labwc behavior and physical Pi startup,
power-loss, HDMI/DSI and codec tests have not been run here.

To repeat the unit checks on a Pi after installing the packages above:

```sh
cd ~/videowall
python3 -m unittest discover -s kiosk -v
systemd-analyze --user verify ~/.config/systemd/user/videowall-kiosk.service
```

* [Raspberry Pi's ordinary OS kiosk tutorial](https://www.raspberrypi.com/tutorials/how-to-use-a-raspberry-pi-in-kiosk-mode/)
* [labwc session/autostart documentation](https://labwc.github.io/getting-started.html)
* [systemd network-online semantics](https://systemd.io/NETWORK_ONLINE/)
* [Chromium separate profiles](https://www.chromium.org/developers/creating-and-using-profiles/)
* [Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/)
