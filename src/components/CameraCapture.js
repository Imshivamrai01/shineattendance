'use client';
import { useEffect, useRef, useState } from 'react';
import { Modal } from '@/components/ui';

/**
 * Live camera capture only (getUserMedia + canvas). There is deliberately no file picker,
 * so a photo can't be chosen from the gallery/folder.
 */
export default function CameraCapture({ title, onDone, onCancel }) {
  const video = useRef(null);
  const stream = useRef(null);
  const [err, setErr] = useState('');
  const [ready, setReady] = useState(false);
  const [shot, setShot] = useState(null);

  const start = async () => {
    setErr(''); setReady(false);
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera is not available here. Open the site over HTTPS in a normal browser.');
      stream.current = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 1280 } }, audio: false });
      video.current.srcObject = stream.current;
      await video.current.play();
      setReady(true);
    } catch (e) {
      setErr(e.name === 'NotAllowedError' ? 'Camera permission was denied. Allow camera access for this site and try again.' : e.message);
    }
  };
  const stop = () => stream.current?.getTracks().forEach((t) => t.stop());
  useEffect(() => { start(); return stop; }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const capture = () => {
    const v = video.current;
    const scale = Math.min(1, 640 / (v.videoWidth || 640));
    const c = document.createElement('canvas');
    c.width = Math.round(v.videoWidth * scale); c.height = Math.round(v.videoHeight * scale);
    c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
    setShot(c.toDataURL('image/jpeg', 0.72));
  };
  const cancel = () => { stop(); onCancel(); };

  return (
    <Modal title={title} onClose={cancel}>
      {err && <div className="alert">{err}</div>}
      <div className="cam-frame">
        <video ref={video} playsInline muted style={{ width: '100%', height: '100%', objectFit: 'cover', transform: 'scaleX(-1)', display: shot ? 'none' : 'block' }} />
        {shot && <img src={shot} alt="Captured" style={{ width: '100%', height: '100%', objectFit: 'cover', transform: 'scaleX(-1)' }} />}
        {!ready && !err && !shot && <div className="skel" style={{ position: 'absolute', inset: 0, borderRadius: 0 }} />}
      </div>
      <p className="muted small" style={{ margin: '10px 0' }}>Take a clear photo of your face. Photos from the gallery are not accepted.</p>
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button className="btn" onClick={cancel}>Cancel</button>
        {err && <button className="btn" onClick={start}>Try again</button>}
        {!shot && <button className="btn primary" disabled={!ready} onClick={capture}>Capture</button>}
        {shot && <button className="btn" onClick={() => setShot(null)}>Retake</button>}
        {shot && <button className="btn primary" onClick={() => { stop(); onDone(shot); }}>Use this photo</button>}
      </div>
    </Modal>
  );
}
