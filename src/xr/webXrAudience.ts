/**
 * Lazy browser-only WebXR entry helper. StageEngine owns the renderer and loop lease;
 * this chunk exists only to keep WebXR allocation and request code off first load.
 */
export const WEBXR_REFERENCE_SPACE: XRReferenceSpaceType = 'local-floor';
export { loadXrQualityProfile, saveXrQualityProfile, xrSessionQuality } from './audienceExperience';

/**
 * Deliberately not async: requestSession is the first operation after the caller's
 * synchronous safety checks, preserving the warning-confirm click's user activation.
 */
export function requestAudienceSession(): Promise<XRSession> {
  const xr = navigator.xr;
  if (!xr?.requestSession) {
    return Promise.reject(new DOMException('Immersive VR is unavailable in this browser.', 'NotSupportedError'));
  }
  return xr.requestSession('immersive-vr', {
    requiredFeatures: [WEBXR_REFERENCE_SPACE],
  });
}

export function webXrErrorMessage(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError' || error.name === 'SecurityError') {
      return 'VR permission was denied.';
    }
    if (error.name === 'AbortError') return 'VR entry was canceled.';
    if (error.name === 'NotSupportedError') return 'Immersive VR is not supported on this device.';
  }
  return error instanceof Error ? error.message : 'VR session could not start.';
}
