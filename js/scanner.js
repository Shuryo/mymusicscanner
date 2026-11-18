// Skaner QR z aparatu: natywny BarcodeDetector (Android/Chrome), w innym wypadku jsQR (iPhone).
// Czyta też kody odwrócone (jasny kod na ciemnym tle) i ma tryb „zrób zdjęcie” jako zapas.
let stream = null, timer = null, stopped = true;

const canvas = document.createElement('canvas');
const ctx = canvas.getContext('2d', { willReadFrequently: true });

async function getDetector() {
  if (!('BarcodeDetector' in window)) return null;
  try {
    const formats = await window.BarcodeDetector.getSupportedFormats();
    return formats.includes('qr_code') ? new window.BarcodeDetector({ formats: ['qr_code'] }) : null;
  } catch { return null; }
}

// Odczyt jsQR z wycinka źródła (wideo lub obrazka). crop = część krótszego boku brana ze środka (1 = całość).
function jsqrRead(src, w, h, crop, maxSide) {
  if (!window.jsQR || !w || !h) return null;
  let sx = 0, sy = 0, sw = w, sh = h;
  if (crop < 1) {
    const side = Math.min(w, h) * crop;
    sx = (w - side) / 2; sy = (h - side) / 2; sw = sh = side;
  }
  const scale = Math.min(1, maxSide / Math.max(sw, sh));
  canvas.width = Math.round(sw * scale);
  canvas.height = Math.round(sh * scale);
  ctx.drawImage(src, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return window.jsQR(img.data, img.width, img.height, { inversionAttempts: 'attemptBoth' })?.data || null;
}

export async function start(video, onCode) {
  stop();
  stopped = false;
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('ta przeglądarka nie udostępnia aparatu');
  stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: false,
  });
  video.setAttribute('playsinline', '');
  video.setAttribute('muted', '');
  video.muted = true;
  video.srcObject = stream;
  await video.play().catch(() => {});

  const detector = await getDetector();
  let frame = 0;

  const tick = async () => {
    if (stopped) return;
    try {
      if (video.readyState >= 2 && video.videoWidth) {
        let text = null;
        if (detector) {
          const codes = await detector.detect(video);
          text = codes[0]?.rawValue || null;
        }
        if (!text) {
          // na przemian: środek kadru (ramka celownika) w dobrej rozdzielczości i cały kadr
          frame++;
          text = frame % 2
            ? jsqrRead(video, video.videoWidth, video.videoHeight, 0.75, 720)
            : jsqrRead(video, video.videoWidth, video.videoHeight, 1, 800);
        }
        if (text && !stopped) {
          stop();
          if (navigator.vibrate) navigator.vibrate(60);
          onCode(text);
          return;
        }
      }
    } catch { /* klatka nieczytelna – próbujemy dalej */ }
    timer = setTimeout(tick, 80);
  };
  tick();
}

export function stop() {
  stopped = true;
  clearTimeout(timer);
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
}

// Odczyt kodu ze zdjęcia (plik z aparatu / galerii). Zwraca tekst albo null.
export async function decodeFile(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const detector = await getDetector();
    if (detector) {
      const codes = await detector.detect(img).catch(() => []);
      if (codes[0]?.rawValue) return codes[0].rawValue;
    }
    const w = img.naturalWidth, h = img.naturalHeight;
    return jsqrRead(img, w, h, 1, 1200)
      || jsqrRead(img, w, h, 0.6, 1000)
      || jsqrRead(img, w, h, 1, 1800);
  } finally {
    URL.revokeObjectURL(url);
  }
}
