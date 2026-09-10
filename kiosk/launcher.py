#!/usr/bin/env python3
"""Run inside the desktop user's systemd service; dependencies are Debian packages."""
import json
import os
import socket
from pathlib import Path
import subprocess
import time
import urllib.request
from urllib.error import HTTPError
from urllib.parse import urlsplit

import websocket

URL = os.environ.get('KIOSK_URL', 'https://videowall-3lp.pages.dev/?player=1')
PROFILE = Path.home() / '.local/share/videowall/chromium'
HEALTH = """JSON.stringify({
  url: location.href, state: document.readyState,
  mounted: document.documentElement.dataset.playerFrame !== undefined,
  frameAge: performance.now() - Number(document.documentElement.dataset.playerFrame || 0),
  bootMessage: !!document.getElementById('boot-message'),
  width: innerWidth, height: innerHeight
})"""


def log(message):
    print(message, flush=True)


def notify_watchdog():
    address = os.environ.get('NOTIFY_SOCKET')
    if address:
        if address.startswith('@'):
            address = '\0' + address[1:]
        with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as notifier:
            notifier.connect(address)
            notifier.sendall(b'WATCHDOG=1')


def json_get(url):
    # Never use a machine HTTP proxy for the local debugging endpoint.
    with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(url, timeout=5) as response:
        return json.load(response)


def ready():
    # A socket filename alone does not prove that the compositor answers.
    result = subprocess.run(['wayland-info'], capture_output=True, timeout=10, text=True)
    if result.returncode or 'wl_output' not in result.stdout:
        raise RuntimeError('Wayland is not responding with a display output')
    # Check transport readiness, not whether a Python client can render the app.
    # Pi #4 receives HTTP 403 here even though Chromium can load the player.
    # The browser heartbeat below is the authoritative application check.
    request = urllib.request.Request(URL, headers={'Cache-Control': 'no-cache'})
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            log(f'HTTPS probe responded {response.status}; checking application in Chromium')
    except HTTPError as error:
        # An HTTP error is a response, not a DNS/TLS/connectivity failure.
        # Keep certificate validation enabled; never spoof browser credentials.
        log(f'HTTPS probe responded {error.code}; checking application in Chromium')
        error.close()


def healthy(state):
    return (state.get('url') == URL and state.get('mounted') is True
            and 0 <= state.get('frameAge', -1) < 30000
            and state.get('width', 0) > 0 and state.get('height', 0) > 0)


def probe(port):
    pages = json_get(f'http://127.0.0.1:{port}/json/list')
    page = next((p for p in pages if p.get('type') == 'page' and p.get('url') == URL), None)
    if page is None:
        raise RuntimeError('Player tab missing or navigation failed')
    ws_url = page['webSocketDebuggerUrl']
    if urlsplit(ws_url).hostname not in ('127.0.0.1', 'localhost'):
        raise RuntimeError('Unexpected debugging host')
    connection = websocket.create_connection(ws_url, timeout=5, suppress_origin=True)
    try:
        connection.send(json.dumps({'id': 1, 'method': 'Runtime.evaluate',
                                    'params': {'expression': HEALTH, 'returnByValue': True}}))
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            message = json.loads(connection.recv())
            if message.get('id') == 1:
                return json.loads(message['result']['result']['value'])
        raise TimeoutError('Renderer evaluation timed out')
    finally:
        connection.close()


def main():
    if urlsplit(URL).scheme != 'https':
        raise ValueError('KIOSK_URL must use HTTPS')
    # Retry conditions, not an assumed boot duration. SSH and desktop stay usable.
    while True:
        notify_watchdog()
        try:
            ready()
            break
        except Exception as error:
            log(f'Waiting for readiness: {error}')
            time.sleep(5)
    PROFILE.mkdir(parents=True, exist_ok=True, mode=0o700)
    port_file = PROFILE / 'DevToolsActivePort'
    port_file.unlink(missing_ok=True)  # ephemeral endpoint metadata, never pairing data
    command = ['chromium', URL, '--kiosk', '--noerrdialogs', '--disable-infobars',
               '--no-first-run', '--no-default-browser-check', '--start-maximized',
               '--autoplay-policy=no-user-gesture-required', '--password-store=basic',
               f'--user-data-dir={PROFILE}', '--remote-debugging-address=127.0.0.1',
               '--remote-debugging-port=0', '--disable-session-crashed-bubble',
               '--enable-logging=stderr']
    log('Readiness passed; starting Chromium with persistent kiosk profile')
    browser = subprocess.Popen(command)
    last_healthy = time.monotonic()
    was_healthy = False
    try:
        while browser.poll() is None:
            notify_watchdog()
            try:
                port = int(port_file.read_text().splitlines()[0])
                state = probe(port)
                if healthy(state):
                    last_healthy = time.monotonic()
                    if not was_healthy:
                        log('Player renderer healthy')
                    was_healthy = True
                else:
                    log(f'Player not healthy: {state}')
            except Exception as error:
                log(f'Player probe unavailable: {error}')
            # Allows slow Pi 3 startup and the existing six-hour page reload.
            if time.monotonic() - last_healthy > 120:
                raise RuntimeError('No healthy renderer for 120s; requesting systemd restart')
            time.sleep(10)
        raise RuntimeError(f'Chromium exited: {browser.returncode}')
    finally:
        # systemd additionally kills every child in this service's cgroup,
        # including hung renderer/GPU processes, before starting a replacement.
        if browser.poll() is None:
            browser.terminate()
            try:
                browser.wait(timeout=5)
            except subprocess.TimeoutExpired:
                browser.kill()
                browser.wait(timeout=5)


if __name__ == '__main__':
    main()
