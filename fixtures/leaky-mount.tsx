import React, { useEffect } from "react";

export interface LeakyMountProps {
  label: string;
}

// Every mount appends to a global nothing ever clears, so retained heap grows
// with the mount/unmount cycle count and survives forced GC.
export function LeakyMount({ label }: LeakyMountProps) {
  useEffect(() => {
    const w = window as unknown as { __120fps_leak_sink?: number[][] };
    if (!w.__120fps_leak_sink) w.__120fps_leak_sink = [];
    w.__120fps_leak_sink.push(new Array(50000).fill(1));
  }, []);
  return <div className="leaky">{label}</div>;
}

export default LeakyMount;
