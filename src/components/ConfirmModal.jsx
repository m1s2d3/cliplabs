import React, { useEffect } from 'react';

export default function ConfirmModal({ title, message, confirmLabel = 'Delete', onConfirm, onCancel }) {
  useEffect(() => {
    const onKey = (event) => event.key === 'Escape' && onCancel();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="modal confirm-modal" role="alertdialog" aria-modal="true" aria-label={title}>
        <div className="modal-head plain"><h2>{title}</h2></div>
        <p className="confirm-message">{message}</p>
        <div className="modal-foot">
          <button className="btn" onClick={onCancel}>Cancel</button>
          <button className="btn danger" onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}
