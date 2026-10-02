/** Image load/decode is not a paint. Hidden WebViews can suspend rAF, so bound
 * this wait; the capture stays transparent until the native show notification. */
export function waitForCapturePaint(): Promise<void> {
  return new Promise((resolve) => {
    let frame = 0;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      cancelAnimationFrame(frame);
      window.clearTimeout(timeout);
      resolve();
    };
    const timeout = window.setTimeout(finish, 120);
    frame = requestAnimationFrame(() => { frame = requestAnimationFrame(finish); });
  });
}
