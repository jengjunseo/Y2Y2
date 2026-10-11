"""Select actual adaptive tracks, without downscaling or a premux-only fallback."""
from __future__ import annotations

import math
import re
from urllib.parse import parse_qs, urlsplit


class MediaError(Exception):
    def __init__(self, code, message, status=422):
        super().__init__(message)
        self.code, self.message, self.status = code, message, status


def video_id(value):
    value = str(value).strip()
    if re.fullmatch(r"[\w-]{11}", value, flags=re.ASCII):
        return value
    try:
        parsed = urlsplit(value)
        if (len(value) > 2048 or parsed.scheme not in {"http", "https"}
                or parsed.username or parsed.password or parsed.port):
            raise ValueError()
        host = parsed.hostname
        if host not in {"youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"}:
            raise ValueError()
        parts = parsed.path.strip("/").split("/")
        candidate = (parts[0] if host == "youtu.be" and len(parts) == 1 else
                     parse_qs(parsed.query).get("v", [""])[0] if parsed.path == "/watch" else
                     parts[1] if len(parts) == 2 and parts[0] in {"shorts", "embed", "live"} else "")
        if re.fullmatch(r"[\w-]{11}", candidate, flags=re.ASCII):
            return candidate
    except ValueError:
        pass
    raise MediaError("BAD_URL", "YouTube 영상 링크를 확인해 주세요.", 400)


def media_url(value):
    """Extractor URLs only: never turn this service into an arbitrary URL proxy."""
    try:
        parsed = urlsplit(value)
        return (parsed.scheme == "https" and parsed.hostname.endswith(".googlevideo.com")
                and not parsed.username and not parsed.password and parsed.port is None)
    except (ValueError, AttributeError):
        return False


def number(value):
    try:
        value = float(value)
        return value if math.isfinite(value) and value >= 0 else 0
    except (ValueError, TypeError):
        return 0


def track_size(fmt):
    size = number(fmt.get("filesize"))
    if not size:
        try:
            size = number(parse_qs(urlsplit(fmt.get("url", "")).query).get("clen", [0])[0])
        except ValueError:
            pass
    return int(size)


def choices(info):
    if info.get("is_live") or info.get("live_status") in {"is_live", "is_upcoming", "post_live"}:
        raise MediaError("LIVE_UNSUPPORTED", "라이브 방송은 종료 후 다시 분석해 주세요.")
    tracks = {}
    for fmt in info.get("formats", []):
        key = str(fmt.get("format_id", ""))
        if (not re.fullmatch(r"[\w.-]{1,100}", key, flags=re.ASCII)
                or fmt.get("has_drm") or fmt.get("protocol") != "https"
                or not media_url(fmt.get("url")) or not track_size(fmt)):
            continue
        tracks[key] = fmt
    audio = [f for f in tracks.values() if f.get("vcodec") == "none" and f.get("acodec") not in {None, "none"}]
    rank_audio = lambda f: (number(f.get("language_preference")), number(f.get("quality")), number(f.get("abr") or f.get("tbr")))
    aac = sorted([f for f in audio if str(f.get("acodec", "")).startswith("mp4a")], key=rank_audio, reverse=True)
    opus = sorted([f for f in audio if f.get("acodec") == "opus"], key=rank_audio, reverse=True)
    result, seen = [], set()
    videos = sorted(tracks.values(), key=lambda f: (number(f.get("width")) * number(f.get("height")),
                                                     number(f.get("fps")), number(f.get("tbr"))), reverse=True)
    for fmt in videos:
        # Separate tracks are intentional: high quality is no longer excluded.
        if fmt.get("acodec") != "none" or not number(fmt.get("width")) or not number(fmt.get("height")):
            continue
        codec = str(fmt.get("vcodec", ""))
        if codec.startswith(("avc1", "h264")) and aac:
            container, profile, sound = "mp4", "compatible", aac[0]
        elif codec.startswith(("vp9", "vp09", "av01")) and opus:
            container, profile, sound = "webm", "original", opus[0]
        else:
            continue
        width, height, fps = int(fmt["width"]), int(fmt["height"]), number(fmt.get("fps"))
        group = (profile, width, height, fps, codec.split(".")[0], fmt.get("dynamic_range"))
        if group in seen:
            continue
        seen.add(group)
        audio_key, key = str(sound["format_id"]), str(fmt["format_id"])
        result.append({"key": key + "+" + audio_key, "video": key, "audio": audio_key,
                       "container": container, "profile": profile, "width": width, "height": height,
                       "fps": fps, "vcodec": codec, "acodec": sound["acodec"],
                       "bytes": track_size(fmt) + track_size(sound),
                       "label": f"{width}×{height} · {fps:g}fps · {codec.split('.')[0]} · {container.upper()} · " +
                                ("호환성 우선" if profile == "compatible" else "원본 코덱")})
    for sound in sorted(audio, key=rank_audio, reverse=True):
        if str(sound.get("acodec", "")).startswith("mp4a") or sound.get("acodec") == "opus":
            container = "m4a" if str(sound["acodec"]).startswith("mp4a") else "webm"
            result.append({"key": "audio-" + str(sound["format_id"]), "audio": str(sound["format_id"]),
                           "container": container, "profile": "audio", "bytes": track_size(sound),
                           "label": f"오디오 원본 · {sound['acodec']} · {number(sound.get('abr') or sound.get('tbr')):g} kbps"})
            break
    if not result:
        raise MediaError("NO_TRACKS", "분할 저장 가능한 영상·음성 트랙을 가져오지 못했습니다. 화질을 낮춰 대체하지 않습니다.")
    # Offer the best compatible MP4 first; original 4K remains a separate choice.
    result.sort(key=lambda c: (c["profile"] != "compatible", -(c.get("width", 0) * c.get("height", 0)), -c.get("fps", 0)))
    return result, tracks
