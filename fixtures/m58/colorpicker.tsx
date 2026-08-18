import React from "react";

interface CanvasAreaProps {
  hue: number;
  saturation: number;
  lightness: number;
  dispatch: (action: string) => void;
}

// Internal helper, declared before the exported component.
function CanvasArea({ hue, saturation, lightness, dispatch }: CanvasAreaProps) {
  return (
    <canvas
      data-hue={hue}
      data-saturation={saturation}
      data-lightness={lightness}
      onClick={() => dispatch("pick")}
    />
  );
}

export interface ColorPickerProps {
  value: string;
  presets?: string[];
  onChange?: (next: string) => void;
}

export function ColorPicker({ value, presets = [], onChange }: ColorPickerProps) {
  return (
    <div>
      <CanvasArea hue={0} saturation={1} lightness={0.5} dispatch={() => onChange?.(value)} />
      <ul>
        {presets.map((preset) => (
          <li key={preset}>{preset}</li>
        ))}
      </ul>
    </div>
  );
}
