import React, { useEffect, useState } from "react";

interface TimerProps {
  label?: string;
  interval?: number;
}

export function Timer({ label = "elapsed", interval = 1000 }: TimerProps) {
  const [count, setCount] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setCount((c) => c + 1), interval);
    return () => clearInterval(id);
  }, [interval]);

  return <div className="timer"><span>{label}: {count}</span></div>;
}
