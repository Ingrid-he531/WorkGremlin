#!/usr/bin/env python3
"""WorkGremlin 演示视频录制（Wayland / GNOME）。

思路：Wayland 下 ffmpeg 的 x11grab 抓不到画面，所以走
xdg-desktop-portal 的 ScreenCast 接口拿到 PipeWire 流，
gstreamer 负责抓帧 + 转成原始 I420，ffmpeg 负责编码成 mp4。

首次调用时 GNOME 会弹「共享屏幕」确认框，需要点一下确认。

用法:
  scripts/record-demo.py                      # 录 30 秒整屏
  scripts/record-demo.py -d 60 --window       # 录 60 秒，弹窗里挑某个窗口
  scripts/record-demo.py -d 0 --mic           # 不限时长（Ctrl+C 结束）+ 麦克风旁白
  scripts/record-demo.py -s 1280x720 -o /tmp/demo.mp4

依赖: gstreamer1.0(含 pipewiresrc) / pipewire / ffmpeg / python3-gi
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
    """封装 ScreenCast 会话：创建 -> 选源 -> 启动 -> 打开 PipeWire 连接。"""

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
        """调用带 handle_token 的异步方法，等 Request::Response 信号。"""
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
            raise PortalError(f'{method} 超时（等了 {timeout}s）')
        if box['code'] != 0:
            raise PortalError(f'{method} 被拒绝或取消（code={box["code"]}）')
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
            raise PortalError('portal 没有返回任何视频流')
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
            raise PortalError('拿不到 PipeWire 的 fd')
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
    # libx264 要求偶数宽高
    return width // 2 * 2, height // 2 * 2


def main():
    ap = argparse.ArgumentParser(description='录制 WorkGremlin 桌面演示视频')
    ap.add_argument('-d', '--duration', type=int, default=30, help='录制秒数，0 表示手动 Ctrl+C 停止（默认 30）')
    ap.add_argument('-o', '--out', default='', help='输出文件，默认 recordings/demo-<时间戳>.mp4')
    ap.add_argument('-s', '--size', default='', help='录制分辨率，默认跟随窗口/屏幕实际尺寸（如 1280x720）')
    ap.add_argument('-f', '--fps', type=int, default=30, help='帧率（默认 30）')
    ap.add_argument('--crf', type=int, default=23, help='x264 质量，越小越清晰（默认 23）')
    ap.add_argument('--window', action='store_true', help='只录某个窗口（弹窗里选），默认整屏')
    ap.add_argument('--mic', action='store_true', help='同时录麦克风（alsa default）')
    ap.add_argument('-c', '--countdown', type=int, default=5,
                    help='开录前的倒计时秒数，留时间切窗口（默认 5，0 表示不倒计时）')
    args = ap.parse_args()

    if args.out:
        out_path = Path(args.out).expanduser()
    else:
        out_path = ROOT / 'recordings' / time.strftime('demo-%Y%m%d-%H%M%S.mp4')
    out_path.parent.mkdir(parents=True, exist_ok=True)

    print('[1/3] 向 portal 申请录屏权限（GNOME 会弹确认框，请点「共享」）...')
    cast = Screencast(SOURCE_WINDOW if args.window else SOURCE_MONITOR)
    try:
        node_id, fd, stream_size = cast.start()
    except PortalError as exc:
        print(f'录屏申请失败：{exc}', file=sys.stderr)
        return 1
    print(f'      拿到 PipeWire 流 node={node_id}')

    if args.size:
        width, height = parse_size(args.size)
    else:
        width, height = stream_size or (1920, 1080)
        width, height = width // 2 * 2, height // 2 * 2  # libx264 要求偶数宽高
    print(f'      分辨率 {width}x{height}')

    gst_cmd = build_gst(node_id, fd, width, height, args.fps)
    ff_cmd = build_ffmpeg(out_path, width, height, args.fps, args.crf, args.mic, args.duration)

    print(f'[2/3] 开始录制 -> {out_path}')
    if args.duration > 0:
        print(f'      {args.duration} 秒后自动结束；现在可以把窗口切到要演示的画面')
    else:
        print('      不限时长，按 Ctrl+C 结束')

    if args.countdown > 0:
        print(f'      {args.countdown} 秒后开录，请把画面切到 WorkGremlin（建议先开「演示模式」）')
        for left in range(args.countdown, 0, -1):
            print(f'      {left}', flush=True)
            time.sleep(1)

    gst = subprocess.Popen(gst_cmd, stdout=subprocess.PIPE, pass_fds=(fd,))
    ff = subprocess.Popen(ff_cmd, stdin=gst.stdout)
    gst.stdout.close()  # 只有 ffmpeg 持有管道读端

    interrupted = False
    try:
        if args.duration > 0:
            ff.wait()
        else:
            while ff.poll() is None:
                time.sleep(0.3)
    except KeyboardInterrupt:
        interrupted = True
        print('\n      收到 Ctrl+C，正在收尾...')
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

    print('[3/3] 收尾')
    if not out_path.exists():
        print('没有产出视频文件，检查上面的报错。', file=sys.stderr)
        return 1

    size_mb = out_path.stat().st_size / 1024 / 1024
    seconds = ''
    if shutil.which('ffprobe'):
        probe = subprocess.run(
            ['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
             '-of', 'csv=p=0', str(out_path)],
            capture_output=True, text=True)
        if probe.stdout.strip():
            seconds = f' 时长 {float(probe.stdout.strip()):.1f}s'
    print(f'完成：{out_path}（{size_mb:.1f} MB{seconds}）')
    return 0 if not interrupted else 0


if __name__ == '__main__':
    sys.exit(main())
