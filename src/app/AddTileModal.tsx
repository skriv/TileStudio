import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { checkTileAspect } from '../core/tiling/material';
import type { TileRotation } from '../core/tiling/layout';
import { addMaterial, toast } from '../state/store';

type Step = 'choose' | 'camera' | 'crop' | 'details';
type Crop = { x: number; y: number; w: number; h: number };
type Shot = { url: string; w: number; h: number; name: string };

export function AddTileModal({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState<Step>('choose');
  const [shot, setShot] = useState<Shot | null>(null);
  const [crop, setCrop] = useState<Crop | null>(null);
  const [cropped, setCropped] = useState<{ url: string; blob: Blob; w: number; h: number } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const cameraFileRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const stopCamera = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  };

  useEffect(() => () => stopCamera(), []);
  useEffect(() => {
    if (step !== 'camera') return;
    const video = videoRef.current;
    const stream = streamRef.current;
    if (!video || !stream) return;
    video.srcObject = stream;
    void video.play();
  }, [step]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const takeFile = async (file: File) => {
    const bmp = await createImageBitmap(file);
    const url = URL.createObjectURL(file);
    setShot({ url, w: bmp.width, h: bmp.height, name: file.name.replace(/\.\w+$/, '') || 'Плитка' });
    setCrop(defaultCrop(bmp.width, bmp.height));
    bmp.close();
    setStep('crop');
  };

  const openCamera = async () => {
    stopCamera();
    if (!navigator.mediaDevices?.getUserMedia) {
      cameraFileRef.current?.click();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' } } });
      streamRef.current = stream;
      setStep('camera');
    } catch {
      toast('Камера недоступна — откроется снимок через приложение камеры.', 'info');
      cameraFileRef.current?.click();
    }
  };

  const shutter = async () => {
    const v = videoRef.current;
    if (!v || !v.videoWidth) return;
    const c = document.createElement('canvas');
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    c.getContext('2d')!.drawImage(v, 0, 0);
    const blob = await new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('Кадр пустой'))), 'image/jpeg', 0.92));
    stopCamera();
    const url = URL.createObjectURL(blob);
    setShot({ url, w: c.width, h: c.height, name: 'Снимок' });
    setCrop(defaultCrop(c.width, c.height));
    setStep('crop');
  };

  const confirmCrop = async () => {
    if (!shot || !crop) return;
    try {
      const img = await loadImage(shot.url);
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(crop.w));
      c.height = Math.max(1, Math.round(crop.h));
      c.getContext('2d')!.drawImage(img, crop.x, crop.y, crop.w, crop.h, 0, 0, c.width, c.height);
      const blob = await new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('Кроп пустой'))), 'image/png'));
      setCropped({ url: URL.createObjectURL(blob), blob, w: c.width, h: c.height });
      setStep('details');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Не удалось обрезать фото', 'error');
    }
  };

  return createPortal(
    <div
      className="modal-back"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal" role="dialog" aria-modal="true" aria-label="Новая плитка">
        <header>
          <b>{step === 'details' ? 'Размер плитки' : step === 'crop' ? 'Кадр плитки' : step === 'camera' ? 'Камера' : 'Новая плитка'}</b>
          <button type="button" className="small" onClick={onClose}>
            Закрыть
          </button>
        </header>

        {step === 'choose' && (
          <div className="modal-body">
            <p className="hint">Одна фотография — одна плитка. На iPad снимок открывается камерой, затем кадрируется.</p>
            <div className="modal-actions">
              <button type="button" className="primary" onClick={openCamera}>
                Сфотографировать
              </button>
              <button type="button" onClick={() => fileRef.current?.click()}>
                Выбрать файл
              </button>
            </div>
          </div>
        )}

        {step === 'camera' && (
          <div className="modal-body">
            <video ref={videoRef} className="cam-video" playsInline muted autoPlay />
            <div className="modal-actions">
              <button type="button" className="primary" onClick={shutter}>
                Снять
              </button>
              <button
                type="button"
                onClick={() => {
                  stopCamera();
                  setStep('choose');
                }}
              >
                Назад
              </button>
            </div>
          </div>
        )}

        {step === 'crop' && shot && crop && <CropStep shot={shot} crop={crop} setCrop={setCrop} onOk={confirmCrop} onBack={() => setStep('choose')} />}

        {step === 'details' && cropped && shot && (
          <DetailsStep
            cropped={cropped}
            name0={shot.name}
            onBack={() => setStep('crop')}
            onDone={() => {
              URL.revokeObjectURL(cropped.url);
              onClose();
            }}
          />
        )}

        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) void takeFile(f);
          }}
        />
        <input
          ref={cameraFileRef}
          type="file"
          accept="image/*"
          capture="environment"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) void takeFile(f);
          }}
        />
      </div>
    </div>,
    document.body,
  );
}

function defaultCrop(w: number, h: number): Crop {
  const side = Math.round(Math.min(w, h) * 0.8);
  return { x: Math.round((w - side) / 2), y: Math.round((h - side) / 2), w: side, h: side };
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => rej(new Error('Изображение не открылось'));
    img.src = url;
  });
}

function CropStep({ shot, crop, setCrop, onOk, onBack }: { shot: Shot; crop: Crop; setCrop: (c: Crop) => void; onOk: () => void; onBack: () => void }) {
  const frameRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ mode: string; x: number; y: number; crop: Crop } | null>(null);
  const [, setFit] = useState(0);
  useLayoutEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setFit((n) => n + 1));
    ro.observe(el);
    setFit((n) => n + 1);
    return () => ro.disconnect();
  }, []);

  const metrics = () => {
    const box = frameRef.current!.getBoundingClientRect();
    const scale = Math.min(box.width / shot.w, box.height / shot.h);
    const dw = shot.w * scale;
    const dh = shot.h * scale;
    return { scale, ox: (box.width - dw) / 2, oy: (box.height - dh) / 2, box };
  };

  const onDown = (e: React.PointerEvent, mode: string) => {
    e.preventDefault();
    e.stopPropagation();
    const m = metrics();
    drag.current = { mode, x: (e.clientX - m.box.left - m.ox) / m.scale, y: (e.clientY - m.box.top - m.oy) / m.scale, crop: { ...crop } };
    const move = (ev: PointerEvent) => {
      const d = drag.current;
      if (!d || !frameRef.current) return;
      const box = frameRef.current.getBoundingClientRect();
      const scale = Math.min(box.width / shot.w, box.height / shot.h);
      const ox = (box.width - shot.w * scale) / 2;
      const oy = (box.height - shot.h * scale) / 2;
      const x = (ev.clientX - box.left - ox) / scale;
      const y = (ev.clientY - box.top - oy) / scale;
      const dx = x - d.x;
      const dy = y - d.y;
      const next = { ...d.crop };
      const min = 24;
      if (d.mode === 'move') {
        next.x = Math.min(shot.w - next.w, Math.max(0, d.crop.x + dx));
        next.y = Math.min(shot.h - next.h, Math.max(0, d.crop.y + dy));
      } else {
        if (d.mode.includes('e')) next.w = Math.max(min, Math.min(shot.w - d.crop.x, d.crop.w + dx));
        if (d.mode.includes('s')) next.h = Math.max(min, Math.min(shot.h - d.crop.y, d.crop.h + dy));
        if (d.mode.includes('w')) {
          const x0 = Math.max(0, Math.min(d.crop.x + d.crop.w - min, d.crop.x + dx));
          next.x = x0;
          next.w = d.crop.x + d.crop.w - x0;
        }
        if (d.mode.includes('n')) {
          const y0 = Math.max(0, Math.min(d.crop.y + d.crop.h - min, d.crop.y + dy));
          next.y = y0;
          next.h = d.crop.y + d.crop.h - y0;
        }
      }
      setCrop(next);
    };
    const up = () => {
      drag.current = null;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const m = frameRef.current ? metrics() : null;
  const style = m
    ? { left: m.ox + crop.x * m.scale, top: m.oy + crop.y * m.scale, width: crop.w * m.scale, height: crop.h * m.scale }
    : undefined;

  return (
    <div className="modal-body">
      <div
        ref={frameRef}
        className="crop-frame"
      >
        <img src={shot.url} alt="" draggable={false} />
        <div className="crop-rect" style={style} onPointerDown={(e) => onDown(e, 'move')}>
          {['nw', 'ne', 'sw', 'se'].map((h) => (
            <i key={h} className={`handle ${h}`} onPointerDown={(e) => onDown(e, h)} />
          ))}
        </div>
      </div>
      <p className="hint">Потяните рамку, чтобы оставить одну плитку. Углы меняют размер.</p>
      <div className="modal-actions">
        <button type="button" className="primary" onClick={onOk}>
          Дальше
        </button>
        <button type="button" onClick={onBack}>
          Назад
        </button>
      </div>
    </div>
  );
}

function DetailsStep({
  cropped,
  name0,
  onBack,
  onDone,
}: {
  cropped: { url: string; blob: Blob; w: number; h: number };
  name0: string;
  onBack: () => void;
  onDone: () => void;
}) {
  const [name, setName] = useState(name0);
  const [w, setW] = useState('');
  const [h, setH] = useState('');
  const [rot, setRot] = useState<TileRotation>(0);
  const [busy, setBusy] = useState(false);
  const wn = parseFloat(w);
  const hn = parseFloat(h);
  const valid = wn > 0 && hn > 0;
  const aspect = valid ? checkTileAspect(cropped.w, cropped.h, wn, hn) : null;

  return (
    <div className="modal-body">
      <img className="crop-preview" src={cropped.url} alt="" />
      <div className="muted">
        {cropped.w}×{cropped.h} px
      </div>
      <label className="field">
        <span className="field-label">Название</span>
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <div className="row">
        <label className="field">
          <span className="field-label">Ширина, мм</span>
          <input inputMode="decimal" value={w} onChange={(e) => setW(e.target.value)} placeholder="мм" />
        </label>
        <label className="field">
          <span className="field-label">Высота, мм</span>
          <input inputMode="decimal" value={h} onChange={(e) => setH(e.target.value)} placeholder="мм" />
        </label>
      </div>
      <p className="hint">Размер одной плитки, как она лежит в кадре: ширина картинки — это ширина в миллиметрах.</p>
      {aspect && !aspect.ok && <p className="warn">Пропорции кадра и размера расходятся на {(aspect.mismatch * 100).toFixed(1)}%. Плитка будет растянута.</p>}
      <label className="field">
        <span className="field-label">Поворот</span>
        <select value={rot} onChange={(e) => setRot(Number(e.target.value) as TileRotation)}>
          {[0, 90, 180, 270].map((r) => (
            <option key={r} value={r}>
              {r}°
            </option>
          ))}
        </select>
      </label>
      <div className="modal-actions">
        <button
          type="button"
          className="primary"
          disabled={!valid || busy}
          onClick={async () => {
            if (aspect && !aspect.ok && !confirm('Пропорции не совпадают — плитка будет растянута. Добавить?')) return;
            setBusy(true);
            try {
              await addMaterial(cropped.blob, `${name || 'tile'}.png`, { name: name || 'Плитка', widthMm: wn, heightMm: hn, defaultRotationDeg: rot });
              toast('Плитка добавлена в библиотеку', 'ok');
              onDone();
            } catch (e) {
              toast(`Не удалось добавить: ${(e as Error).message}`, 'error');
              setBusy(false);
            }
          }}
        >
          Добавить в библиотеку
        </button>
        <button type="button" onClick={onBack}>
          Назад к кадру
        </button>
      </div>
    </div>
  );
}
