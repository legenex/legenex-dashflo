// Whether captures redact personal values before they are rasterised.
//
// This lived in components/progress/CaptureController.jsx, the floating
// "Capture for review" control that used to sit on every operator page. That
// control is gone: the Control Center is owner tooling on its own host, and the
// ordinary application must not carry a review affordance at all.
//
// The preference outlived it. The Control Center's own capture still honours it,
// and it is a stored user preference rather than anything the removed control
// owned, so it moves here instead of being deleted with its former host.
//
// Default is masked. A screenshot of a live operator page holds real lead names,
// emails and phone numbers, so the safe setting is the one you get without
// choosing, and turning masking off is deliberate.

const MASK_KEY = 'progress_capture_mask';

export function maskEnabled() {
  try {
    return sessionStorage.getItem(MASK_KEY) !== 'off';
  } catch {
    // Private mode, or storage disabled. Fall back to masked.
    return true;
  }
}

export function setMaskEnabled(on) {
  try {
    sessionStorage.setItem(MASK_KEY, on ? 'on' : 'off');
  } catch { /* private mode */ }
}

export default { maskEnabled, setMaskEnabled };
