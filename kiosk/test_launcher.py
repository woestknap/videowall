"""Host-side tests of failure classification and bounded CDP interaction."""
import json
import unittest
import tempfile
from pathlib import Path
from unittest.mock import Mock, patch

import launcher


class WatchdogTests(unittest.TestCase):
    def state(self, **changes):
        return dict(url=launcher.URL, mounted=True, frameAge=20, width=1920, height=1080, **changes)

    def test_pairing_or_offline_backend_is_healthy(self):
        # No media/backend state required to keep a responsive player alive.
        self.assertTrue(launcher.healthy(self.state()))

    def test_blank_frozen_wrong_page_and_no_output_are_unhealthy(self):
        for changes in ({'mounted': False}, {'frameAge': 31000}, {'frameAge': -1},
                        {'url': 'chrome-error://chromewebdata/'}, {'width': 0}):
            state = self.state()
            state.update(changes)
            with self.subTest(changes=changes):
                self.assertFalse(launcher.healthy(state))

    @patch('launcher.json_get', return_value=[])
    def test_missing_tab(self, _get):
        with self.assertRaisesRegex(RuntimeError, 'tab missing'):
            launcher.probe(1234)

    @patch('launcher.websocket.create_connection')
    @patch('launcher.json_get')
    def test_probe_skips_events_and_closes_socket(self, get, connect):
        get.return_value = [{'type': 'page', 'url': launcher.URL,
                             'webSocketDebuggerUrl': 'ws://127.0.0.1:1234/devtools/page/1'}]
        socket = connect.return_value
        socket.recv.side_effect = [json.dumps({'method': 'event'}), json.dumps(
            {'id': 1, 'result': {'result': {'value': json.dumps(self.state())}}})]
        self.assertTrue(launcher.healthy(launcher.probe(1234)))
        socket.close.assert_called_once()

    @patch('launcher.subprocess.run')
    def test_readiness_rejects_compositor_without_output(self, run):
        run.return_value = Mock(returncode=0, stdout='wl_compositor')
        with self.assertRaisesRegex(RuntimeError, 'display output'):
            launcher.ready()

    @patch('launcher.urllib.request.urlopen')
    @patch('launcher.subprocess.run')
    def test_readiness_rejects_captive_portal(self, run, urlopen):
        run.return_value = Mock(returncode=0, stdout='wl_output')
        response = urlopen.return_value.__enter__.return_value
        response.status = 200
        response.read.return_value = b'<html>Sign in to Wi-Fi</html>'
        with self.assertRaisesRegex(RuntimeError, 'application HTML'):
            launcher.ready()

    def test_unhealthy_renderer_exits_and_terminates_browser(self):
        with tempfile.TemporaryDirectory() as folder:
            profile = Path(folder)
            browser = Mock()
            browser.poll.return_value = None

            def launch(command):
                self.assertIn('--password-store=basic', command)
                self.assertIn(f'--user-data-dir={profile}', command)
                (profile / 'DevToolsActivePort').write_text('1234\n')
                return browser

            with patch('launcher.PROFILE', profile), patch('launcher.ready'), \
                    patch('launcher.notify_watchdog'), \
                    patch('launcher.subprocess.Popen', side_effect=launch), \
                    patch('launcher.probe', return_value={'mounted': False}), \
                    patch('launcher.time.monotonic', side_effect=[0, 121]):
                with self.assertRaisesRegex(RuntimeError, '120s'):
                    launcher.main()
            browser.terminate.assert_called_once()
            browser.wait.assert_called_once_with(timeout=5)

    def test_network_wait_retries_before_launch_and_browser_exit_is_failure(self):
        with tempfile.TemporaryDirectory() as folder:
            browser = Mock()
            browser.poll.return_value = 1
            browser.returncode = 1
            with patch('launcher.PROFILE', Path(folder)), \
                    patch('launcher.ready', side_effect=[OSError('offline'), None]) as ready, \
                    patch('launcher.notify_watchdog'), patch('launcher.time.sleep') as sleep, \
                    patch('launcher.subprocess.Popen', return_value=browser) as launch:
                with self.assertRaisesRegex(RuntimeError, 'Chromium exited: 1'):
                    launcher.main()
                self.assertEqual(ready.call_count, 2)
                sleep.assert_called_once_with(5)
                launch.assert_called_once()


if __name__ == '__main__':
    unittest.main()
