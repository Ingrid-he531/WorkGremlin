#!/usr/bin/env python3
"""WorkGremlin demo video recording (Wayland / GNOME).

Approach: under Wayland, ffmpeg's x11grab cannot capture the screen, so we go through
xdg-desktop-portal's ScreenCast interface to get a PipeWire stream; gstreamer captures frames and
converts them to raw I420, and ffmpeg encodes to mp4.

On the first call GNOME shows a "Share your screen" confirmation; click to confirm.

Usage:
  scripts/record-demo.py                      # record the whole screen for 30s
  scripts/record-demo.py -d 60 --window       # record 60s, pick a window in the dialog
  scripts/record-demo.py -d 0 --mic           # no time limit (Ctrl+C to stop) + mic narration
  scripts/record-demo.py -s 1280x720 -o /tmp/demo.mp4

Dependencies: gstreamer1.0 (with pipewiresrc) / pipewire / ffmpeg / python3-gi
"""

import argparse
import os
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path

import gi

gi.require_version('Gio', '2.0')
gi.require_version('GLib', '2.0')
from gi.repository import Gio, GLib  # noqa: E402

PORTAL = 'org.freedesktop.portal.Desktop'
PORTAL_PATH = '/org/freedesktop/portal/desktop'
SCREENCAST_IFACE = 'org.freedesktop.portal.ScreenCast'
SOURCE_MONITOR = 1
SOURCE_WINDOW = 2
CURSOR_EMBEDDED = 2

ROOT = Path(__file__).resolve().parent.parent
_seq = [0]


class PortalError(RuntimeError):
    pass


def connect_bus():
    return Gio.bus_get_sync(Gio.BusType.SESSION, None)


def next_token(prefix='wg'):
    _seq[0] += 1
    return f'{prefix}{int(time.time() * 1000)}_{_seq[0]}'


class Screencast:
    """Wraps a ScreenCast session: create -> select source -> start -> open the PipeWire connection."""

    def __init__(self, source_type):
        self.bus = connect_bus()
        self.sender = self.bus.get_unique_name().lstrip(':').replace('.', '_')
        self.proxy = Gio.DBusProxy.new_sync(
            self.bus, Gio.DBusProxyFlags.NONE, None,
            PORTAL, PORTAL_PATH, SCREENCAST_IFACE, None,
        )
        self.source_type = source_type
        self.session_handle = None

    def _request(self, method, params, timeout=120):
        """Call an async method with a handle_token and wait for the Request::Response signal."""
        token = next_token()
        req_path = f'/org/freedesktop/portal/desktop/request/{self.sender}/{token}'
        loop = GLib.MainLoop()
        box = {}

        def on_signal(_conn, _sender, _path, _iface, _sig, signal_params, *_rest):
            code, results = signal_params.unpack()
            box['code'] = code
            box['results'] = results
            loop.quit()

        def on_any(_conn, _sender, path, _iface, _sig, signal_params, *_rest):
            if path != req_path:
                return
            code, results = signal_params.unpack()
            box['code'] = code
            box['results'] = results
            loop.quit()

        sub = self.bus.signal_subscribe(
            None, 'org.freedesktop.portal.Request', 'Response',
            None, None, 0, on_any, None)
        ret = self.proxy.call_sync(method, params, Gio.DBusCallFlags.NONE, -1, None)
        if ret and ret.get_child_value(0).get_type_string() == 'o':
            req_path = ret.get_child_value(0).get_string()
        GLib.timeout_add_seconds(timeout, loop.quit)
        loop.run()
        self.bus.signal_unsubscribe(sub)

        if 'code' not in box:
            raise PortalError(f'{method} timed out (waited {timeout}s)')
        if box['code'] != 0:
            raise PortalError(f'{method} denied or cancelled (code={box["code"]})')
        return box['results']

    def start(self):
        session_token = next_token('session')
        results = self._request('CreateSession', GLib.Variant(
            '(a{sv})', ({'session_handle_token': GLib.Variant('s', session_token),
                         'handle_token': GLib.Variant('s', next_token())},)))
        self.session_handle = results['session_handle']

        self._request('SelectSources', GLib.Variant(
            '(oa{sv})', (self.session_handle, {
                'types': GLib.Variant('u', self.source_type),
                'multiple': GLib.Variant('b', False),
                'cursor_mode': GLib.Variant('u', CURSOR_EMBEDDED),
                'handle_token': GLib.Variant('s', next_token()),
            })))

        results = self._request('Start', GLib.Variant(
            '(osa{sv})', (self.session_handle, '', {
                'handle_token': GLib.Variant('s', next_token()),
            })))
        streams = results.get('streams')
        if not streams:
            raise PortalError('portal returned no video stream')
        node_id = int(streams[0][0])
        size = None
        raw = streams[0][1].get('size') if streams[0][1] else None
        if raw is not None:
            sw, sh = raw.unpack() if hasattr(raw, 'unpack') else tuple(raw)
            size = (int(sw), int(sh))

        values, fd_list = self.proxy.call_with_unix_fd_list_sync(
            'OpenPipeWireRemote',
            GLib.Variant('(oa{sv})', (self.session_handle, {})),
            Gio.DBusCallFlags.NONE, -1, None,
        )
        if fd_list is None or fd_list.get_length() < 1:
            raise PortalError('could not get the PipeWire fd')
        return node_id, fd_list.get(0), size

    def close(self):
        if not self.session_handle:
            return
        try:
            Gio.DBusProxy.new_sync(
                self.bus, Gio.DBusProxyFlags.NONE, None,
                PORTAL, self.session_handle, 'org.freedesktop.portal.Session', None,
            ).call_sync('Close', None, Gio.DBusCallFlags.NONE, -1, None)
        except Exception:
            pass



def build_gst(node_id, fd, width, height, fps):
    return [
        'gst-launch-1.0', '-q',
        'pipewiresrc', f'fd={fd}', f'path={node_id}', 'do-timestamp=true',
        '!', 'videorate',
        '!', f'video/x-raw,framerate={fps}/1',
        '!', 'videoconvert',
        '!', 'videoscale',
        '!', f'video/x-raw,format=I420,width={width},height={height}',
        '!', 'fdsink', 'fd=1', 'sync=false',
    ]


def build_ffmpeg(out_path, width, height, fps, crf, mic, duration):
    cmd = [
        'ffmpeg', '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'rawvideo', '-pix_fmt', 'yuv420p',
        '-s', f'{width}x{height}', '-r', str(fps),
        '-i', 'pipe:0',
    ]
    if mic:
        cmd += ['-f', 'alsa', '-i', 'default']
    cmd += [
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', str(crf),
        '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    ]
    if mic:
        cmd += ['-map', '0:v', '-map', '1:a', '-c:a', 'aac', '-b:a', '128k', '-shortest']
    if duration > 0:
        cmd += ['-t', str(duration)]
    cmd += [str(out_path)]
    return cmd


def parse_size(text):
    w, _, h = text.lower().replace('*', 'x').partition('x')
    width, height = int(w), int(h)
    # libx264 requires even width/height
    return width // 2 * 2, height // 2 * 2


def main():
    ap = argparse.ArgumentParser(description='Record a WorkGremlin desktop demo video')
    ap.add_argument('-d', '--duration', type=int, default=30, help='recording seconds; 0 = stop manually with Ctrl+C (default 30)')
    ap.add_argument('-o', '--out', default='', help='output file; default recordings/demo-<timestamp>.mp4')
    ap.add_argument('-s', '--size', default='', help='recording resolution; default follows the window/screen size (e.g. 1280x720)')
    ap.add_argument('-f', '--fps', type=int, default=30, help='frame rate (default 30)')
    ap.add_argument('--crf', type=int, default=23, help='x264 quality, lower is clearer (default 23)')
    ap.add_argument('--window', action='store_true', help='record a single window (pick it in the dialog); default is the whole screen')
    ap.add_argument('--mic', action='store_true', help='also record the microphone (alsa default)')
    ap.add_argument('-c', '--countdown', type=int, default=5,
                    help='countdown seconds before recording starts, time to switch windows (default 5; 0 = no countdown)')
    args = ap.parse_args()

    if args.out:
        out_path = Path(args.out).expanduser()
    else:
        out_path = ROOT / 'recordings' / time.strftime('demo-%Y%m%d-%H%M%S.mp4')
    out_path.parent.mkdir(parents=True, exist_ok=True)

    print('[1/3] requesting screen-capture permission from the portal (GNOME will show a dialog; click "Share")...')
    cast = Screencast(SOURCE_WINDOW if args.window else SOURCE_MONITOR)
    try:
        node_id, fd, stream_size = cast.start()
    except PortalError as exc:
        print(f'screen-capture request failed: {exc}', file=sys.stderr)
        return 1
    print(f'      got PipeWire stream node={node_id}')

    if args.size:
        width, height = parse_size(args.size)
    else:
        width, height = stream_size or (1920, 1080)
        width, height = width // 2 * 2, height // 2 * 2  # libx264 requires even width/height
    print(f'      resolution {width}x{height}')

    gst_cmd = build_gst(node_id, fd, width, height, args.fps)
    ff_cmd = build_ffmpeg(out_path, width, height, args.fps, args.crf, args.mic, args.duration)

    print(f'[2/3] recording -> {out_path}')
    if args.duration > 0:
        print(f'      auto-stops after {args.duration}s; now switch the window to the scene to demo')
    else:
        print('      no time limit, press Ctrl+C to stop')

    if args.countdown > 0:
        print(f'      recording starts in {args.countdown}s; switch to WorkGremlin (open "Demo mode" first)')
        for left in range(args.countdown, 0, -1):
            print(f'      {left}', flush=True)
            time.sleep(1)

    gst = subprocess.Popen(gst_cmd, stdout=subprocess.PIPE, pass_fds=(fd,))
    ff = subprocess.Popen(ff_cmd, stdin=gst.stdout)
    gst.stdout.close()  # only ffmpeg holds the read end of the pipe

    interrupted = False
    try:
        if args.duration > 0:
            ff.wait()
        else:
            while ff.poll() is None:
                time.sleep(0.3)
    except KeyboardInterrupt:
        interrupted = True
        print('\n      got Ctrl+C, wrapping up...')
        ff.send_signal(signal.SIGINT)
        try:
            ff.wait(timeout=15)
        except subprocess.TimeoutExpired:
            ff.kill()

    for _ in range(30):
        if gst.poll() is not None:
            break
        time.sleep(0.1)
    else:
        gst.terminate()
    try:
        gst.wait(timeout=5)
    except subprocess.TimeoutExpired:
        gst.kill()
    os.close(fd)
    cast.close()

    print('[3/3] wrapping up')
    if not out_path.exists():
        print('no video file was produced; check the errors above.', file=sys.stderr)
        return 1

    size_mb = out_path.stat().st_size / 1024 / 1024
    seconds = ''
    if shutil.which('ffprobe'):
        probe = subprocess.run(
            ['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
             '-of', 'csv=p=0', str(out_path)],
            capture_output=True, text=True)
        if probe.stdout.strip():
            seconds = f'  duration {float(probe.stdout.strip()):.1f}s'
    print(f'done: {out_path} ({size_mb:.1f} MB{seconds})')
    return 0 if not interrupted else 0


if __name__ == '__main__':
    sys.exit(main())
