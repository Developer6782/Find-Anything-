export type CameraErrorCode =
  | 'INSECURE_CONTEXT'
  | 'UNSUPPORTED'
  | 'PERMISSION_DENIED'
  | 'NOT_FOUND'
  | 'IN_USE'
  | 'CONSTRAINTS'
  | 'UNKNOWN';

export class CameraError extends Error {
  code: CameraErrorCode;
  hint: string;

  constructor(code: CameraErrorCode, message: string, hint: string) {
    super(message);
    this.name = 'CameraError';
    this.code = code;
    this.hint = hint;
  }
}

const HINTS: Record<CameraErrorCode, string> = {
  INSECURE_CONTEXT:
    'Browsers only expose the camera on HTTPS or http://localhost. Open the app via a secure URL and try again.',
  UNSUPPORTED: 'Use Chrome, Edge, or Safari 16+ — this browser does not expose MediaDevices.getUserMedia().',
  PERMISSION_DENIED:
    'Click the camera icon in the address bar → Allow, then press "Retry camera". On iOS check Settings → Safari → Camera.',
  NOT_FOUND: 'No camera was detected. Connect a webcam or open this page on a phone.',
  IN_USE: 'Another app or tab is using the camera. Close it (or any video call) and retry.',
  CONSTRAINTS: 'The requested camera settings are not supported by this device. Retrying with defaults helps.',
  UNKNOWN: 'The camera could not be started. Retry, or reload the page.',
};

function mapError(err: unknown): CameraError {
  const name = (err as DOMException)?.name ?? '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return new CameraError('PERMISSION_DENIED', 'Camera access was blocked.', HINTS.PERMISSION_DENIED);
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return new CameraError('NOT_FOUND', 'No camera device found.', HINTS.NOT_FOUND);
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return new CameraError('IN_USE', 'The camera is busy or unreadable.', HINTS.IN_USE);
    case 'OverconstrainedError':
    case 'ConstraintNotSatisfiedError':
      return new CameraError('CONSTRAINTS', 'Camera constraints are not satisfiable.', HINTS.CONSTRAINTS);
    default:
      return new CameraError('UNKNOWN', (err as Error)?.message || 'Camera error', HINTS.UNKNOWN);
  }
}

export function cameraSupport(): { ok: boolean; error?: CameraError } {
  if (typeof window !== 'undefined' && !window.isSecureContext) {
    return {
      ok: false,
      error: new CameraError('INSECURE_CONTEXT', 'Camera requires a secure context.', HINTS.INSECURE_CONTEXT),
    };
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    return { ok: false, error: new CameraError('UNSUPPORTED', 'getUserMedia is unavailable.', HINTS.UNSUPPORTED) };
  }
  return { ok: true };
}

export interface StartCameraOptions {
  /** 'environment' = rear camera (best for scanning a room). */
  facingMode?: 'user' | 'environment';
  deviceId?: string;
  /** Preferred capture size — 1280×720 keeps detection cheap and sharp enough. */
  width?: number;
  height?: number;
}

export async function startCamera(options: StartCameraOptions = {}): Promise<MediaStream> {
  const support = cameraSupport();
  if (!support.ok && support.error) throw support.error;

  const { facingMode = 'environment', deviceId, width = 1280, height = 720 } = options;
  const baseVideo: MediaTrackConstraints = {
    width: { ideal: width },
    height: { ideal: height },
    frameRate: { ideal: 30, max: 30 },
  };
  if (deviceId) baseVideo.deviceId = { exact: deviceId };
  else baseVideo.facingMode = { ideal: facingMode };

  try {
    return await navigator.mediaDevices.getUserMedia({ video: baseVideo, audio: false });
  } catch (err) {
    const mapped = mapError(err);
    // Over-constrained discrete cameras: retry with whatever the device offers.
    if (mapped.code === 'CONSTRAINTS' || mapped.code === 'UNKNOWN') {
      try {
        return await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      } catch (err2) {
        throw mapError(err2);
      }
    }
    throw mapped;
  }
}

export async function listCameras(): Promise<MediaDeviceInfo[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === 'videoinput');
  } catch {
    return [];
  }
}

/** Always stop tracks — this releases the camera LED and the device. */
export function stopStream(stream: MediaStream | null | undefined): void {
  if (!stream) return;
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      /* ignore */
    }
  }
}

export function attachStream(video: HTMLVideoElement | null, stream: MediaStream | null): void {
  if (!video) return;
  if (video.srcObject !== stream) {
    video.srcObject = stream;
  }
  if (stream) {
    void video.play().catch(() => {
      /* autoplay can be blocked until a user gesture; the UI keeps a play button */
    });
  }
}
