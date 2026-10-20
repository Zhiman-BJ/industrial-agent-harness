// Own a pending Viewer response until the mounted Viewer accepts it. Hidden
// tabs keep their owner; cancellation only discards responses with no owner yet.
export function openViewerLifecycle(host, request, { onOpened, onError }) {
  let cancelled = false;
  let committed = false;
  let response;
  let released = false;

  function release() {
    const token = response?.data?.token;
    if (released || typeof token !== 'string' || !token || !host.releaseViewerResources) return;
    released = true;
    try {
      // Disposal is best effort and must never create an unhandled rejection or
      // prevent a newer Viewer from opening if the host is already unavailable.
      void Promise.resolve(host.releaseViewerResources({ token })).catch(() => {});
    } catch {
      // A host can disappear synchronously during window shutdown as well.
    }
  }

  function fail(reason) {
    if (!cancelled) {
      try {
        onError(reason);
      } catch {
        // Error reporting must not turn a handled open failure into a rejection.
      }
    }
  }

  let pending;
  try {
    pending = host.open(request);
  } catch (reason) {
    pending = Promise.reject(reason);
  }
  const settled = Promise.resolve(pending).then(view => {
    response = view;
    if (cancelled) {
      release();
      return;
    }
    try {
      onOpened(view);
    } catch (reason) {
      release();
      fail(reason);
    }
  }, fail);

  return {
    settled,
    commit(view) {
      if (!cancelled && view === response) committed = true;
    },
    cancel() {
      cancelled = true;
      if (!committed) release();
    },
  };
}
