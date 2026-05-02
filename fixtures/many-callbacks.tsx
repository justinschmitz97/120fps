import React from "react";

interface CallbackProps {
  onClick: () => void;
  onChange: (v: string) => void;
  onSubmit: () => void;
  onBlur?: () => void;
  label: string;
}

export function ManyCallbacks({ onClick, onChange, onSubmit, onBlur, label }: CallbackProps) {
  return (
    <form onSubmit={(e) => { e.preventDefault(); onSubmit(); }}>
      <input onChange={(e) => onChange(e.target.value)} onBlur={onBlur} />
      <button type="button" onClick={onClick}>{label}</button>
    </form>
  );
}
