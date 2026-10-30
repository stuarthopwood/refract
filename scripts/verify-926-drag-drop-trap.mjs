// Helper for verify-926-attach-any-file.mjs: captures the real onFileDrop callback, because CDP
// cannot synthesize an OS-level drag-drop. Bypasses only wry's native event, never app code.
export async function injectDragDropCaptureTrap(cdp) {
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(function () {
      let realRefract;
      window.__capturedFileDropHandler = null;
      Object.defineProperty(window, 'refract', {
        configurable: true,
        enumerable: true,
        get() { return realRefract; },
        set(value) {
          if (value && value.attachments && typeof value.attachments.onFileDrop === 'function') {
            const original = value.attachments.onFileDrop;
            value.attachments.onFileDrop = function (handler) {
              window.__capturedFileDropHandler = handler;
              return original(handler);
            };
          }
          realRefract = value;
        }
      });
    })();`
  });
  await cdp.send('Page.reload', {});
  // Wait on the trap marker, not readyState: complete only proves the page loaded. The caller's
  // later typeof-function check proves the trap was installed before entry.ts assigned window.refract.
  await cdp.waitFor(`'__capturedFileDropHandler' in window`, { timeoutMs: 30_000, label: 'page reloaded with the drag-drop capture trap active' });
}
