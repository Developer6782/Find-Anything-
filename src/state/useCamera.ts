import { useCallback, useEffect, useRef, useState } from 'react';
import {
  type CameraError,
  attachStream,
  cameraSupport,
  listCameras,
  startCamera,
  stopStream,
} from '../lib/media/camera';

export type CameraStatus = 'idle' | 'starting' | 'live' | 'error';

export interface CameraApi {
  status: CameraStatus;
  error: CameraError | null;
  stream: MediaStream | null;
  facing: 'user' | 'environment';
  devices: MediaDeviceInfo[];
  videoRef: React.MutableRefObject<HTMLVideoElement | null>;
  start: (options?: { facing?: 'user' | 'environment'; deviceId?: string }) => Promise<MediaStream | null>;
  stop: () => void;
  flip: () => Promise<void>;
  retry: () => Promise<MediaStream | null>;
}

/**
 * Owns the camera lifecycle. Always stops tracks on unmount/session end so the
 * device is released (LED off) and other apps can use the camera again.
 */
export function useCamera(): CameraApi {
  const [status, setStatus] = useState<CameraStatus>('idle');
  const [error, setError] = useState<CameraError | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [facing, setFacing] = useState<'user' | 'environment'>('environment');
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const stop = useCallback(() => {
    stopStream(streamRef.current);
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setStream(null);
    setStatus('idle');
  }, []);

  const start = useCallback(
    async (options?: { facing?: 'user' | 'environment'; deviceId?: string }) => {
      setError(null);
      setStatus('starting');
      const support = cameraSupport();
      if (!support.ok && support.error) {
        setError(support.error);
        setStatus('error');
        return null;
      }
      const nextFacing = options?.facing ?? facing;
      try {
        stopStream(streamRef.current);
        const media = await startCamera({ facingMode: nextFacing, deviceId: options?.deviceId });
        streamRef.current = media;
        setStream(media);
        setFacing(nextFacing);
        setStatus('live');
        attachStream(videoRef.current, media);
        setDevices(await listCameras());
        return media;
      } catch (err) {
        const cameraError = err as CameraError;
        setError(cameraError);
        setStatus('error');
        return null;
      }
    },
    [facing],
  );

  const flip = useCallback(async () => {
    const next = facing === 'environment' ? 'user' : 'environment';
    await start({ facing: next });
  }, [facing, start]);

  const retry = useCallback(() => start(), [start]);

  // Re-attach if the video element mounts after the stream started.
  useEffect(() => {
    if (stream && videoRef.current && videoRef.current.srcObject !== stream) {
      attachStream(videoRef.current, stream);
    }
  }, [stream, status]);

  useEffect(
    () => () => {
      stopStream(streamRef.current);
      streamRef.current = null;
    },
    [],
  );

  return { status, error, stream, facing, devices, videoRef, start, stop, flip, retry };
}
