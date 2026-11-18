// Skaner QR z aparatu: natywny BarcodeDetector (Android/Chrome), w innym wypadku jsQR (iPhone).
let stream = null, timer = null, stopped = true;

export async function start(video, onCode) {
  stop();
  stopped = false;
  stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: false,
  });
  video.srcObject = stream;
  video.setAttribute('playsinline', '');
  await video.play();

  let detector = null;
  if ('BarcodeDetector' in window) {
    try {
      const formats = await window.BarcodeDetector.getSupportedFormats();
      if (formats.includes('qr_code')) detector = new window.BarcodeDetector({ formats: ['qr_code'] });
    } catch { detector = null; }
  }
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  const tick = async () => {
    if (stopped) return;
    try {
      if (video.readyState >= 2) {
        let text = null;
        if (detector) {
          const codes = await detector.detect(video);
          text = codes[0]?.rawValue || null;
        } else if (window.jsQR) {
          const w = video.videoWidth, h = video.videoHeight;
          const scale = Math.min(1, 640 / Math.max(w, h));
          canvas.width = Math.round(w * scale);
          canvas.height = Math.round(h * scale);
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
          text = window.jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' })?.data || null;
        }
        if (text && !stopped) {
          stop();
          if (navigator.vibrate) navigator.vibrate(60);
          onCode(text);
          return;
        }
      }
    } catch { /* klatka nieczytelna – próbujemy dalej */ }
    timer = setTimeout(tick, 120);
  };
  tick();
}

export function stop() {
  stopped = true;
  clearTimeout(timer);
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
}
