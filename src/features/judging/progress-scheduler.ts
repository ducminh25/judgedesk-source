export interface LatestFrameScheduler<T> {
  schedule: (value: T) => void;
  cancel: () => void;
}

export function createLatestFrameScheduler<T, FrameId>(
  requestFrame: (callback: () => void) => FrameId,
  cancelFrame: (frameId: FrameId) => void,
  publish: (value: T) => void,
): LatestFrameScheduler<T> {
  let pending: T | undefined;
  let frameId: FrameId | undefined;
  const flush = () => {
    frameId = undefined;
    if (pending === undefined) return;
    const value = pending;
    pending = undefined;
    publish(value);
  };
  return {
    schedule(value) {
      pending = value;
      if (frameId === undefined) frameId = requestFrame(flush);
    },
    cancel() {
      pending = undefined;
      if (frameId === undefined) return;
      cancelFrame(frameId);
      frameId = undefined;
    },
  };
}
