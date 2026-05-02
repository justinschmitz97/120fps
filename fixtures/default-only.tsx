import React from "react";

interface TagProps {
  text: string;
  color?: "red" | "blue" | "green";
}

export default function Tag({ text, color = "blue" }: TagProps) {
  return <span className={`tag tag-${color}`}>{text}</span>;
}
