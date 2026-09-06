"""
Shared primitives for talking to the OpenRouter video generation API.
Used by list_models.py, generate_video.py, and generate_sequence.py so the
submit/poll/download/validate logic exists in exactly one place.
"""

import base64
import mimetypes
import os
import sys
import time

import requests

API_BASE = "https://openrouter.ai/api/v1"
DEFAULT_POLL_INTERVAL = 15
DEFAULT_TIMEOUT = 1800  # 30 minutes


def get_api_key(cli_value=None):
    key = cli_value or os.environ.get("OPENROUTER_API_KEY")
    if not key:
        print(
            "No API key found. Pass --api-key or set OPENROUTER_API_KEY.",
            file=sys.stderr,
        )
        sys.exit(1)
    return key


def auth_headers(api_key):
    return {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}


def to_image_url(path_or_url):
    """Return a value usable as image_url.url -- pass URLs through, base64-encode local files."""
    if path_or_url.startswith("http://") or path_or_url.startswith("https://"):
        return path_or_url
    if not os.path.isfile(path_or_url):
        print(f"Image path not found: {path_or_url}", file=sys.stderr)
        sys.exit(1)
    mime, _ = mimetypes.guess_type(path_or_url)
    mime = mime or "image/png"
    with open(path_or_url, "rb") as f:
        b64 = base64.b64encode(f.read()).decode("ascii")
    return f"data:{mime};base64,{b64}"


# ---------------------------------------------------------------------------
# Model catalog + validation
# ---------------------------------------------------------------------------

def fetch_models():
    """Live catalog from GET /api/v1/videos/models. Never hardcode this list --
    providers add models and change capabilities often, and a request with an
    unsupported duration/resolution/aspect_ratio is rejected with a 400."""
    resp = requests.get(f"{API_BASE}/videos/models", timeout=30)
    resp.raise_for_status()
    return resp.json().get("data", [])


def get_model_info(model_id, models=None):
    models = models if models is not None else fetch_models()
    return next((m for m in models if m.get("id") == model_id), None)


def closest_supported(value, supported):
    """Return the closest value in `supported` to `value` (both numeric)."""
    if not supported:
        return value
    return min(supported, key=lambda s: abs(s - value))


def validate_and_clamp(model_info, duration=None, resolution=None, aspect_ratio=None):
    """
    Check requested duration/resolution/aspect_ratio against a model's declared
    support. Returns (adjusted_values_dict, warnings_list). Does not raise --
    the caller decides whether to proceed with adjusted values or abort.
    If model_info is None (model not found in catalog), returns inputs unchanged
    with a warning, since we can't validate against an unknown model.
    """
    warnings = []
    result = {"duration": duration, "resolution": resolution, "aspect_ratio": aspect_ratio}

    if model_info is None:
        if duration or resolution or aspect_ratio:
            warnings.append(
                "Model not found in the live catalog -- cannot validate duration/"
                "resolution/aspect_ratio before submitting; the API will reject the "
                "request if a value is unsupported."
            )
        return result, warnings

    if duration is not None:
        supported = model_info.get("supported_durations") or []
        if supported and duration not in supported:
            adjusted = closest_supported(duration, supported)
            warnings.append(
                f"{model_info['id']} supports durations {supported}s, not {duration}s -- "
                f"using {adjusted}s instead."
            )
            result["duration"] = adjusted

    if resolution is not None:
        supported = model_info.get("supported_resolutions") or []
        if supported and resolution not in supported:
            warnings.append(
                f"{model_info['id']} supports resolutions {supported}, not '{resolution}' -- "
                f"request will likely be rejected. Falling back to '{supported[0]}'."
            )
            result["resolution"] = supported[0]

    if aspect_ratio is not None:
        supported = model_info.get("supported_aspect_ratios") or []
        if supported and aspect_ratio not in supported:
            warnings.append(
                f"{model_info['id']} supports aspect ratios {supported}, not "
                f"'{aspect_ratio}' -- request will likely be rejected. Falling back "
                f"to '{supported[0]}'."
            )
            result["aspect_ratio"] = supported[0]

    return result, warnings


# ---------------------------------------------------------------------------
# Job lifecycle: submit / poll / download
# ---------------------------------------------------------------------------

def build_payload(model, prompt, duration=None, resolution=None, aspect_ratio=None,
                   size=None, seed=None, generate_audio=None, callback_url=None,
                   first_frame=None, last_frame=None, references=None):
    payload = {"model": model, "prompt": prompt}
    if duration is not None:
        payload["duration"] = duration
    if resolution:
        payload["resolution"] = resolution
    if aspect_ratio:
        payload["aspect_ratio"] = aspect_ratio
    if size:
        payload["size"] = size
    if seed is not None:
        payload["seed"] = seed
    if generate_audio is not None:
        payload["generate_audio"] = generate_audio
    if callback_url:
        payload["callback_url"] = callback_url

    frame_images = []
    if first_frame:
        frame_images.append({
            "type": "image_url",
            "image_url": {"url": to_image_url(first_frame)},
            "frame_type": "first_frame",
        })
    if last_frame:
        frame_images.append({
            "type": "image_url",
            "image_url": {"url": to_image_url(last_frame)},
            "frame_type": "last_frame",
        })
    if frame_images:
        payload["frame_images"] = frame_images
    elif references:
        payload["input_references"] = [
            {"type": "image_url", "image_url": {"url": to_image_url(r)}} for r in references
        ]

    return payload


def submit_job(headers, payload):
    resp = requests.post(f"{API_BASE}/videos", headers=headers, json=payload, timeout=60)
    if resp.status_code >= 400:
        return {"error": f"HTTP {resp.status_code}: {resp.text}", "status": "failed"}
    body = resp.json()
    body.setdefault("status", "pending")
    return body


def poll_job(headers, polling_url, poll_interval=DEFAULT_POLL_INTERVAL, timeout=DEFAULT_TIMEOUT,
             on_status=None):
    """Blocking poll of a single job to a terminal state."""
    start = time.time()
    last_status = None
    while True:
        elapsed = time.time() - start
        if elapsed > timeout:
            return {"status": "failed", "error": f"Timed out after {int(elapsed)}s"}

        resp = requests.get(polling_url, headers=headers, timeout=30)
        resp.raise_for_status()
        status = resp.json()

        if status["status"] != last_status:
            if on_status:
                on_status(status)
            last_status = status["status"]

        if status["status"] in ("completed", "failed", "cancelled", "expired"):
            return status

        time.sleep(poll_interval)


def poll_jobs_round_robin(headers, jobs, poll_interval=DEFAULT_POLL_INTERVAL, timeout=DEFAULT_TIMEOUT,
                           on_update=None):
    """
    Poll several jobs concurrently (round-robin GETs, no threads needed since
    each poll is a fast HTTP call). `jobs` is a dict of key -> polling_url for
    jobs still pending; already-known-failed entries (e.g. submit-time errors)
    should not be passed in. Returns dict of key -> terminal status object.
    """
    results = {}
    pending = dict(jobs)
    start = time.time()

    while pending:
        elapsed = time.time() - start
        if elapsed > timeout:
            for key, url in pending.items():
                results[key] = {"status": "failed", "error": f"Timed out after {int(elapsed)}s"}
            break

        for key in list(pending.keys()):
            resp = requests.get(pending[key], headers=headers, timeout=30)
            resp.raise_for_status()
            status = resp.json()
            if on_update:
                on_update(key, status)
            if status["status"] in ("completed", "failed", "cancelled", "expired"):
                results[key] = status
                del pending[key]

        if pending:
            time.sleep(poll_interval)

    return results


def download_video(headers, content_url, out_path):
    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    resp = requests.get(content_url, headers=headers, timeout=120)
    resp.raise_for_status()
    with open(out_path, "wb") as f:
        f.write(resp.content)
